use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EVENT_PTY_DATA: &str = "pty-data";
pub const EVENT_PTY_EXIT: &str = "pty-exit";

struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    killed: Arc<AtomicBool>,
}

static SESSIONS: Mutex<Option<HashMap<String, Session>>> = Mutex::new(None);

fn with_sessions<T>(f: impl FnOnce(&mut HashMap<String, Session>) -> T) -> T {
    let mut guard = SESSIONS.lock().unwrap();
    let mut map = guard.take().unwrap_or_default();
    let result = f(&mut map);
    *guard = Some(map);
    result
}

#[derive(Serialize, Clone)]
struct DataPayload {
    id: String,
    data: String, // base64
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    id: String,
    code: i32,
}

/// Spawn an interactive command in a fresh pty. Output streams to
/// `pty-data` events (base64), exit lands on `pty-exit`. Sudo password
/// prompts, Touch ID and wizard keypresses all happen inside the terminal.
pub fn start(
    app: AppHandle,
    id: String,
    program: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    {
        let exists = with_sessions(|m| m.contains_key(&id));
        if exists {
            return Err("终端会话已在运行".into());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    cmd.cwd(&home);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PATH", super::enriched_path(None));

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let master = pair.master;
    drop(pair.slave); // otherwise reads never see EOF
    let killer = child.clone_killer();

    let killed = Arc::new(AtomicBool::new(false));
    let session = Session { writer: Mutex::new(writer), master, killer, killed: killed.clone() };
    with_sessions(|m| m.insert(id.clone(), session));

    // Reader thread: pty bytes -> base64 -> event.
    let app_data = app.clone();
    let id_data = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = DataPayload {
                        id: id_data.clone(),
                        data: B64.encode(&buf[..n]),
                    };
                    if app_data.emit(EVENT_PTY_DATA, payload).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Waiter thread: report exit, drop the session.
    let app_exit = app.clone();
    let id_exit = id.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let code = status
            .ok()
            .map(|s| s.exit_code() as i32)
            .unwrap_or(-1);
        with_sessions(|m| {
            m.remove(&id_exit);
        });
        let _ = app_exit.emit(EVENT_PTY_EXIT, ExitPayload { id: id_exit, code });
    });

    Ok(())
}

pub fn write(id: &str, data_b64: &str) -> Result<(), String> {
    let bytes = B64.decode(data_b64).map_err(|e| format!("base64: {e}"))?;
    with_sessions(|m| match m.get_mut(id) {
        Some(s) => s
            .writer
            .lock()
            .unwrap()
            .write_all(&bytes)
            .map_err(|e| format!("write: {e}")),
        None => Err("会话不存在".into()),
    })
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    with_sessions(|m| match m.get_mut(id) {
        Some(s) => s
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize: {e}")),
        None => Err("会话不存在".into()),
    })
}

/// Kill is best-effort; the waiter thread will emit pty-exit afterwards.
pub fn kill(id: &str) {
    with_sessions(|m| {
        if let Some(s) = m.get_mut(id) {
            s.killed.store(true, Ordering::SeqCst);
            let _ = s.killer.kill();
        }
    });
}

pub fn kill_all() {
    with_sessions(|m| {
        for (_, s) in m.iter_mut() {
            s.killed.store(true, Ordering::SeqCst);
            let _ = s.killer.kill();
        }
    });
}

/// Passwords never enter command arguments or logs. Refuse an echoing terminal.
pub fn write_secret(id: &str, mut password: String) -> Result<(), String> {
    let result = with_sessions(|m| {
        let s = m.get_mut(id).ok_or("授权会话已结束")?;
        let attrs = s.master.get_termios().ok_or("无法确认安全输入状态，请重试")?;
        if attrs.local_flags.contains(nix::sys::termios::LocalFlags::ECHO) {
            return Err("引擎尚未进入密码输入状态，请稍后重试".into());
        }
        if password.chars().any(char::is_control) {
            return Err("密码不能包含控制字符".into());
        }
        let mut writer = s.writer.lock().unwrap();
        writer.write_all(password.as_bytes()).map_err(|e| format!("授权输入失败: {e}"))?;
        writer.write_all(b"\r").map_err(|e| format!("授权输入失败: {e}"))
    });
    password.clear();
    result
}
