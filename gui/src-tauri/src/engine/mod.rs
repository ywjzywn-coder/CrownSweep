// Engine adapter: every piece of cleaning logic lives in the mole CLI.
// This GUI only discovers the engine, parses its stable JSON interfaces,
// and drives its interactive wizards through a pty terminal.

pub mod detect;
pub mod icons;
pub mod pty;
pub mod smc;
pub mod status;
pub mod tasks;

use std::env;
use std::process::Command;
use std::sync::Mutex;

#[derive(Clone, serde::Serialize)]
pub struct EngineInfo {
    pub path: String,
    pub version: String,
    pub config_dir: String,
}

/// Cached engine discovery so every command does not re-spawn `mole version`.
static ENGINE: Mutex<Option<EngineInfo>> = Mutex::new(None);

/// PATH for spawned engine processes. GUI apps launched from Finder inherit a
/// minimal PATH, so rebuild one that covers the usual install locations.
pub fn enriched_path(engine_dir: Option<&str>) -> String {
    let home = env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = vec![
        "/usr/local/bin".into(),
        "/opt/homebrew/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
        "/usr/sbin".into(),
        "/sbin".into(),
        format!("{home}/.local/bin"),
    ];
    if let Some(dir) = engine_dir {
        parts.insert(0, dir.to_string());
    }
    if let Ok(existing) = env::var("PATH") {
        parts.push(existing);
    }
    parts.join(":")
}

pub fn engine() -> Result<EngineInfo, String> {
    if let Some(info) = ENGINE.lock().unwrap().as_ref() {
        return Ok(info.clone());
    }
    let info = detect::detect().ok_or_else(|| {
        "未找到 mole 引擎。请先安装 tw93/Mole CLI(设置页可一键安装),或手动安装后重启应用。".to_string()
    })?;
    *ENGINE.lock().unwrap() = Some(info.clone());
    Ok(info)
}

/// Forget cached detection (Settings page calls this after install/update).
pub fn invalidate() {
    *ENGINE.lock().unwrap() = None;
}

/// Best-effort `kill -9` for a detached child we lost the handle to.
pub fn kill_pid(pid: u32) {
    let _ = Command::new("/bin/kill").arg("-9").arg(pid.to_string()).output();
}
