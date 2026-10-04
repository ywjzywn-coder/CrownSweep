use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EVENT_PTY_DATA: &str = "pty-data";
pub const EVENT_PTY_EXIT: &str = "pty-exit";

struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    killed: Arc<AtomicBool>,
    group: Arc<OwnedGroup>,
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
    #[serde(rename = "outputComplete")]
    output_complete: bool,
}

#[derive(Serialize, Clone)]
struct ErrorPayload {
    id: String,
    error: String,
}

/// A portable-pty Unix child calls setsid before exec. Check that contract
/// against the actual child before signaling any process group.
struct OwnedGroup {
    sid: i32,
    closed: AtomicBool,
}

impl OwnedGroup {
    fn verify(pid: u32) -> Result<Self, String> {
        let pid = i32::try_from(pid).map_err(|_| "非法PTY进程标识".to_string())?;
        let app_sid = unsafe { nix::libc::getsid(0) };
        let app_pgid = unsafe { nix::libc::getpgrp() };
        if pid <= 1 || pid == app_sid || pid == app_pgid {
            return Err("PTY没有独立的进程组，已拒绝运行".into());
        }
        let sid = unsafe { nix::libc::getsid(pid) };
        let pgid = unsafe { nix::libc::getpgid(pid) };
        if sid != pid || pgid != pid {
            return Err("无法确认PTY独立会话，已拒绝运行".into());
        }
        Ok(Self { sid, closed: AtomicBool::new(false) })
    }

    /// Inspect only process identifiers/state, never command arguments. Ignore
    /// zombies: they cannot execute or retain terminal/file handles.
    fn active_groups(&self) -> Result<HashSet<i32>, String> {
        if self.closed.load(Ordering::SeqCst) { return Ok(HashSet::new()); }
        let output = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid=,pgid=,stat="])
            .output().map_err(|e| format!("无法检查PTY子进程: {e}"))?;
        if !output.status.success() {
            return Err("无法检查PTY子进程状态".into());
        }
        let mut saw_app = false;
        let mut groups = HashSet::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut fields = line.split_whitespace();
            let (Some(pid), Some(pgid), Some(state)) = (fields.next(), fields.next(), fields.next()) else { continue; };
            let (Ok(pid), Ok(pgid)) = (pid.parse::<i32>(), pgid.parse::<i32>()) else { continue; };
            if pid == std::process::id() as i32 { saw_app = true; }
            if state.starts_with('Z') || pid <= 1 { continue; }
            let sid = unsafe { nix::libc::getsid(pid) };
            if sid < 0 {
                let error = std::io::Error::last_os_error();
                if pgid == self.sid && error.raw_os_error() != Some(nix::libc::ESRCH) {
                    return Err(format!("无法确认已授权子进程状态: {error}"));
                }
                continue;
            }
            if sid == self.sid && unsafe { nix::libc::getpgid(pid) } == pgid {
                let app_pgid = unsafe { nix::libc::getpgrp() };
                if pgid <= 1 || pgid == app_pgid { return Err("拒绝终止共享进程组".into()); }
                groups.insert(pgid);
            }
        }
        if !saw_app { return Err("PTY进程列表不完整，仍保留任务占用".into()); }
        Ok(groups)
    }

    fn signal(&self, signal: i32) -> Result<(), String> {
        for pgid in self.active_groups()? {
            // Revalidate at the signal boundary: the group leader must still
            // belong to the session owned by this PTY. A leader may have been
            // reaped while its group remains; inspect its surviving members.
            if !self.active_groups()?.contains(&pgid) { continue; }
            if unsafe { nix::libc::kill(-pgid, signal) } != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(nix::libc::ESRCH) {
                    return Err(format!("无法停止PTY子进程（可能已获管理员权限）: {error}"));
                }
            }
        }
        Ok(())
    }
}

trait GroupLifecycle {
    fn active_groups(&self) -> Result<HashSet<i32>, String>;
    fn signal(&self, signal: i32) -> Result<(), String>;
    fn close(&self) {}
}
impl GroupLifecycle for OwnedGroup {
    fn active_groups(&self) -> Result<HashSet<i32>, String> { OwnedGroup::active_groups(self) }
    fn signal(&self, signal: i32) -> Result<(), String> { OwnedGroup::signal(self, signal) }
    fn close(&self) { self.closed.store(true, Ordering::SeqCst); }
}
impl<T: GroupLifecycle> GroupLifecycle for Arc<T> {
    fn active_groups(&self) -> Result<HashSet<i32>, String> { self.as_ref().active_groups() }
    fn signal(&self, signal: i32) -> Result<(), String> { self.as_ref().signal(signal) }
    fn close(&self) { self.as_ref().close(); }
}

/// Own child reaping and remaining group lifetime. A failed signal never
/// releases the caller's activity permit: authorized children may still run.
fn finish_group(
    mut child: Box<dyn Child + Send + Sync>,
    group: impl GroupLifecycle,
    killed: Arc<AtomicBool>,
    reader_done: mpsc::Receiver<bool>,
    mut report_error: impl FnMut(String),
) -> (i32, bool) {
    let mut exit = None;
    let mut terminating: Option<Instant> = None;
    let mut escalated = false;
    let mut last_check = Instant::now() - Duration::from_secs(1);
    let mut last_error: Option<String> = None;
    loop {
        if exit.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => exit = Some(status.exit_code() as i32),
                Ok(None) => {},
                Err(error) => {
                    let text = format!("等待PTY进程失败: {error}");
                    if last_error.as_ref() != Some(&text) { report_error(text.clone()); last_error = Some(text); }
                    killed.store(true, Ordering::SeqCst);
                }
            }
        }
        if (exit.is_some() || killed.load(Ordering::SeqCst)) && terminating.is_none() {
            terminating = Some(Instant::now());
            if let Err(error) = group.signal(nix::libc::SIGTERM) {
                report_error(error.clone()); last_error = Some(error);
            }
        }
        if let Some(started) = terminating {
            if !escalated && started.elapsed() >= Duration::from_millis(250) {
                escalated = true;
                if let Err(error) = group.signal(nix::libc::SIGKILL) {
                    report_error(error.clone()); last_error = Some(error);
                }
            }
            if last_check.elapsed() >= Duration::from_millis(100) {
                last_check = Instant::now();
                match group.active_groups() {
                    Ok(groups) if groups.is_empty() && exit.is_some() => {
                        group.close();
                        let complete = reader_done.recv_timeout(Duration::from_secs(2)).unwrap_or(false);
                        if !complete { report_error("PTY输出未完整关闭，执行详情可能不完整".into()); }
                        return (exit.unwrap(), complete);
                    },
                    Ok(groups) if !groups.is_empty() && started.elapsed() >= Duration::from_secs(1) => {
                        let text = "PTY子进程仍在运行，可能已有管理员权限；安装更新已阻止。请等待其结束，或在系统中结束该任务后重试。".to_string();
                        if last_error.as_ref() != Some(&text) { report_error(text.clone()); last_error = Some(text); }
                    },
                    Ok(_) => {},
                    Err(error) => {
                        if last_error.as_ref() != Some(&error) { report_error(error.clone()); last_error = Some(error); }
                    },
                }
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
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
    let activity = super::activity::begin_task()?;
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

    let writer = pair.master.take_writer().map_err(|e| format!("take writer: {e}"))?;
    let reader = pair.master.try_clone_reader().map_err(|e| format!("clone reader: {e}"))?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn: {e}"))?;
    let group = match child.process_id().ok_or("PTY缺少进程标识").and_then(|pid| OwnedGroup::verify(pid).map_err(|_| "无法确认PTY独立会话")) {
        Ok(group) => group,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            // This is an unexpected OS/PTY contract failure. Keep the permit
            // until app restart rather than claim no descendants can remain.
            std::mem::forget(activity);
            return Err(format!("{error}，请重启应用后重试"));
        }
    };
    let master = pair.master;
    drop(pair.slave); // otherwise reads never see EOF

    let killed = Arc::new(AtomicBool::new(false));
    let group = Arc::new(group);
    let session = Session { writer: Mutex::new(writer), master, killed: killed.clone(), group: Arc::clone(&group) };
    with_sessions(|m| m.insert(id.clone(), session));

    // Reader thread: pty bytes -> base64 -> event.
    let (reader_done_tx, reader_done_rx) = mpsc::channel();
    let app_data = app.clone();
    let id_data = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        let complete = loop {
            match reader.read(&mut buf) {
                Ok(0) => break true,
                Ok(n) => {
                    let payload = DataPayload {
                        id: id_data.clone(),
                        data: B64.encode(&buf[..n]),
                    };
                    if app_data.emit(EVENT_PTY_DATA, payload).is_err() {
                        break false;
                    }
                }
                // A PTY reports EIO once all slave endpoints close on Unix.
                Err(error) => break error.raw_os_error() == Some(nix::libc::EIO),
            }
        };
        let _ = reader_done_tx.send(complete);
    });

    // Waiter thread: report exit, drop the session.
    let app_exit = app.clone();
    let id_exit = id.clone();
    std::thread::spawn(move || {
        let (code, output_complete) = finish_group(child, group, killed, reader_done_rx, |error| {
            let _ = app_exit.emit("pty-error", ErrorPayload { id: id_exit.clone(), error });
        });
        with_sessions(|m| { m.remove(&id_exit); });
        drop(activity);
        let _ = app_exit.emit(EVENT_PTY_EXIT, ExitPayload { id: id_exit, code, output_complete });
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

/// Request TERM then KILL for this independently verified PTY session.
/// The waiter keeps the session/activity until every owned group has stopped.
pub fn kill(id: &str) {
    with_sessions(|m| {
        if let Some(s) = m.get_mut(id) {
            s.killed.store(true, Ordering::SeqCst);
        }
    });
}

pub fn kill_all() {
    // ExitRequested is about to tear down the runtime. Deliver real signals
    // here, rather than rely on waiter threads being scheduled before exit.
    let groups = with_sessions(|sessions| sessions.values().map(|session| {
        session.killed.store(true, Ordering::SeqCst);
        Arc::clone(&session.group)
    }).collect::<Vec<_>>());
    for group in &groups { let _ = group.signal(nix::libc::SIGTERM); }
    if !groups.is_empty() { std::thread::sleep(Duration::from_millis(250)); }
    for group in &groups { let _ = group.signal(nix::libc::SIGKILL); }
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

#[cfg(test)]
#[path = "pty_lifecycle_tests.rs"]
mod lifecycle_tests;
