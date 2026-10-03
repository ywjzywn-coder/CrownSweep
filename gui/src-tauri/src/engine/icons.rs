// App icon extraction for the uninstall grid. Reads only from the .app paths
// the mole CLI reported, converts the bundle icns to PNG with `sips`, and
// caches results for the session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

static ICON_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn with_cache<T>(f: impl FnOnce(&mut HashMap<String, String>) -> T) -> T {
    let mut guard = ICON_CACHE.lock().unwrap();
    let mut map = guard.take().unwrap_or_default();
    let out = f(&mut map);
    *guard = Some(map);
    out
}

/// Read `CFBundleIconFile` (or fall back to any .icns) from an .app bundle.
fn find_icns(app_path: &str) -> Result<PathBuf, String> {
    if !app_path.ends_with(".app") {
        return Err("不是 .app 路径".into());
    }
    let root = Path::new(app_path);
    if !root.is_dir() {
        return Err("应用路径不存在".into());
    }
    let plist = root.join("Contents/Info.plist");
    let resources = root.join("Contents/Resources");

    if plist.is_file() {
        let out = std::process::Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print :CFBundleIconFile"])
            .arg(&plist)
            .output();
        if let Ok(o) = out {
            let name = String::from_utf8_lossy(&o.stdout).trim().to_string();
            // The value must be a bare filename inside Resources.
            if o.status.success() && !name.is_empty() && !name.contains('/') && !name.contains("..") {
                let file = if name.ends_with(".icns") {
                    name
                } else {
                    format!("{name}.icns")
                };
                let candidate = resources.join(&file);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    // Fallback: first .icns in Resources.
    if let Ok(entries) = std::fs::read_dir(&resources) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("icns") {
                return Ok(p);
            }
        }
    }
    Err("未找到 icns 图标".into())
}

/// Return a `data:image/png;base64,...` URL for the app's icon.
pub fn app_icon(app_path: &str) -> Result<String, String> {
    let cached = with_cache(|m| m.get(app_path).cloned());
    if let Some(data) = cached {
        return Ok(data);
    }

    let icns = find_icns(app_path)?;
    let key = format!(
        "mole-gui-icon-{}",
        B64.encode(app_path.as_bytes()).replace(['/', '+'], "-")
    );
    let out_png = std::env::temp_dir().join(key);

    let converted = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", "-Z", "128"])
        .arg(&icns)
        .arg("--out")
        .arg(&out_png)
        .output()
        .map_err(|e| format!("sips: {e}"))?;
    if !converted.status.success() {
        return Err("sips 转换失败".into());
    }
    let bytes = std::fs::read(&out_png).map_err(|e| format!("read png: {e}"))?;
    let _ = std::fs::remove_file(&out_png);
    if bytes.is_empty() {
        return Err("空图标".into());
    }
    let data = format!("data:image/png;base64,{}", B64.encode(&bytes));
    with_cache(|m| m.insert(app_path.to_string(), data.clone()));
    Ok(data)
}
