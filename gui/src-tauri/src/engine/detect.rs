use std::env;
use std::path::PathBuf;

use super::EngineInfo;

fn candidate_dirs() -> Vec<PathBuf> {
    let home = env::var("HOME").unwrap_or_default();
    let mut dirs = vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from(format!("{home}/.local/bin")),
        PathBuf::from(format!("{home}/bin")),
    ];
    if let Ok(path) = env::var("PATH") {
        dirs.extend(env::split_paths(&path));
    }
    dirs
}

/// Pull `1.2.3` out of arbitrary `mole version` output.
fn extract_version(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut start: Option<usize> = None;
    for (i, b) in bytes.iter().enumerate() {
        let is_part = b.is_ascii_digit() || *b == b'.';
        if is_part {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start {
            // A version token has at least one dot between digits.
            let token = &text[s..i];
            if token.contains('.') && token.len() >= 5 {
                return token.to_string();
            }
            start = None;
        }
    }
    String::new()
}

pub fn detect() -> Option<EngineInfo> {
    for dir in candidate_dirs() {
        let path = dir.join("mole");
        if !path.is_file() {
            continue;
        }
        let path_str = path.to_string_lossy().to_string();
        let out = std::process::Command::new(&path_str)
            .arg("version")
            .env("PATH", super::enriched_path(Some(dir.to_string_lossy().as_ref())))
            .stdin(std::process::Stdio::null())
            .output();
        let version = match out {
            Ok(o) => extract_version(&String::from_utf8_lossy(&o.stdout)),
            Err(_) => String::new(),
        };
        // A stale binary that cannot even report a version is still usable,
        // but something that fails to execute is not the engine.
        return Some(EngineInfo {
            path: path_str,
            version: if version.is_empty() { "未知".into() } else { version },
            config_dir: env::var("HOME")
                .map(|h| format!("{h}/.config/mole"))
                .unwrap_or_default(),
        });
    }
    None
}
