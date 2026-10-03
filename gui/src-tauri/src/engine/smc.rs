// Direct SMC access for Apple Silicon temperature/fan sensors. The mole
// engine only reads legacy sp78 keys, which return zero on Apple Silicon;
// this adapter drives a bundled GPL helper (smcFanControl's smc-command,
// compiled by build.rs) that reads ioft/fpe2 keys natively. Read-only.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct TempReading {
    pub key: String,
    pub label: String,
    pub value: f64,
}

#[derive(Serialize, Clone)]
pub struct FanReading {
    pub index: u32,
    pub current: f64,
    pub min: f64,
    pub max: f64,
    pub target: f64,
    pub mode: String,
}

#[derive(Serialize, Clone)]
pub struct SmcData {
    pub temps: Vec<TempReading>,
    pub fans: Vec<FanReading>,
}

fn helper_path() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("mole-smc");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // Dev fallback: src-tauri/binaries/mole-smc-<triple> written by build.rs.
    let triple = format!("{}-apple-darwin", std::env::consts::ARCH);
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("mole-smc-{triple}"));
    if p.is_file() {
        return Some(p);
    }
    None
}

fn run_helper(args: &[&str]) -> Result<String, String> {
    let path = helper_path().ok_or_else(|| {
        "SMC 助手未随应用打包".to_string()
    })?;
    let out = Command::new(&path)
        .args(args)
        .output()
        .map_err(|e| format!("运行 SMC 助手失败: {e}"))?;
    if !out.status.success() {
        return Err(format!("SMC 读取失败: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Discover temperature keys once: ioft keys (Apple Silicon) plus legacy
/// sp78 keys starting with T (Intel).
fn temp_keys() -> Result<&'static Vec<String>, String> {
    static KEYS: OnceLock<Vec<String>> = OnceLock::new();
    if let Some(v) = KEYS.get() {
        return Ok(v);
    }
    let text = run_helper(&["-l"])?;
    let mut keys = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let mut parts = t.split_whitespace();
        let key = parts.next().unwrap_or("");
        let ty = parts.next().unwrap_or("").trim_matches(['[', ']']);
        let is_temp = ty == "ioft" && (key.starts_with('T') || key == "bet0")
            || ty == "sp78" && key.starts_with('T');
        if is_temp && key.len() == 4 {
            keys.push(key.to_string());
        }
    }
    Ok(KEYS.get_or_init(|| keys))
}

/// ioft: first 4 bytes are little-endian 16.16 fixed point (°C).
/// sp78: signed 8.8 fixed point (°C). fpe2: unsigned 14.2 fixed point.
fn convert(ty: &str, bytes: &[u8]) -> f64 {
    let b = |i: usize| *bytes.get(i).unwrap_or(&0);
    match ty {
        "ioft" => (u32::from_le_bytes([b(0), b(1), b(2), b(3)]) as f64) / 65536.0,
        "sp78" => (i16::from_be_bytes([b(0), b(1)]) as f64) / 256.0,
        "fpe2" => (u16::from_be_bytes([b(0), b(1)]) as f64) / 4.0,
        _ => 0.0,
    }
}

/// Parse "  KEY  [type]  value (bytes aa bb ..)" lines from `-r -k KEY`
/// output. Note: `-k` alone never triggers a read in the upstream tool —
/// it must be paired with `-r`.
fn read_key(key: &str) -> Result<(String, f64), String> {
    let text = run_helper(&["-r", "-k", key])?;
    for line in text.lines() {
        let t = line.trim();
        if !t.starts_with(key) {
            continue;
        }
        let ty = t
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .trim_matches(['[', ']'])
            .to_string();
        let start = t.find("(bytes ").map(|i| i + 7).unwrap_or(0);
        let end = t[start..].find(')').map(|i| start + i).unwrap_or(t.len());
        let bytes: Vec<u8> = t[start..end]
            .split_whitespace()
            .filter_map(|h| u8::from_str_radix(h, 16).ok())
            .collect();
        return Ok((ty.clone(), convert(&ty, &bytes)));
    }
    Err(format!("键 {key} 无输出"))
}

fn label_for(key: &str) -> String {
    let prefix = &key[..2.min(key.len())];
    match prefix {
        "TG" => format!("GPU ({key})"),
        "TR" => format!("SoC ({key})"),
        "TC" | "Tp" => format!("CPU ({key})"),
        "be" => format!("电池 ({key})"),
        _ => key.to_string(),
    }
}

/// Full read: temperature keys + fans. Costs ~10 helper spawns (~100ms).
pub fn read() -> Result<SmcData, String> {
    let keys = temp_keys()?;
    let mut temps = Vec::new();
    for key in keys.iter() {
        if let Ok((_, value)) = read_key(key) {
            temps.push(TempReading { key: key.clone(), label: label_for(key), value });
        }
    }

    let text = run_helper(&["-f"])?;
    let mut fans = Vec::new();
    let mut current: Option<FanReading> = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Fan #") {
            if let Some(f) = current.take() {
                fans.push(f);
            }
            current = Some(FanReading {
                index: rest.trim_end_matches(':').parse().unwrap_or(0),
                current: 0.0,
                min: 0.0,
                max: 0.0,
                target: 0.0,
                mode: "auto".into(),
            });
        } else if let Some(v) = t.strip_prefix("Current speed :") {
            if let Some(f) = current.as_mut() {
                f.current = v.trim().parse().unwrap_or(0.0);
            }
        } else if let Some(v) = t.strip_prefix("Minimum speed:") {
            if let Some(f) = current.as_mut() {
                f.min = v.trim().parse().unwrap_or(0.0);
            }
        } else if let Some(v) = t.strip_prefix("Maximum speed:") {
            if let Some(f) = current.as_mut() {
                f.max = v.trim().parse().unwrap_or(0.0);
            }
        } else if let Some(v) = t.strip_prefix("Target speed :") {
            if let Some(f) = current.as_mut() {
                f.target = v.trim().parse().unwrap_or(0.0);
            }
        } else if let Some(v) = t.strip_prefix("Mode") {
            if let Some(f) = current.as_mut() {
                f.mode = v.trim().trim_start_matches(':').trim().to_string();
            }
        }
    }
    if let Some(f) = current.take() {
        fans.push(f);
    }

    Ok(SmcData { temps, fans })
}

#[cfg(test)]
mod tests {
    use super::convert;
    #[test]
    fn decodes_known_sensor_samples() {
        assert_eq!(convert("sp78", &[0x32, 0x00]), 50.0);
        assert_eq!(convert("sp78", &[0xfe, 0x80]), -1.5);
        assert_eq!(convert("fpe2", &[0x1f, 0x40]), 2000.0);
        assert_eq!(convert("ioft", &[0x00, 0x80, 0x32, 0x00]), 50.5);
    }
}
