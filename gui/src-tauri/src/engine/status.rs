use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::engine;

struct WatchState {
    stop_flag: std::sync::Arc<AtomicBool>,
    pid: u32,
}

static WATCH: Mutex<Option<WatchState>> = Mutex::new(None);

pub const EVENT_STATUS: &str = "engine-status";
pub const EVENT_WATCH_STATE: &str = "engine-watch-state";

/// Start `mole status --watch` and stream NDJSON snapshots as Tauri events.
/// The CLI exits cleanly when stdout dies, but we kill it anyway on stop.
pub fn start(app: AppHandle) -> Result<(), String> {
    let engine = engine()?;
    let mut guard = WATCH.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let stop = std::sync::Arc::new(AtomicBool::new(false));

    // Spawn the loop thread; it owns the actual child. Track the pid here so
    // stop() can kill promptly even while the loop is between spawns.
    let state_holder: std::sync::Arc<Mutex<Option<u32>>> = Default::default();
    let holder = state_holder.clone();
    let stop_for_loop = stop.clone();
    let app_for_loop = app.clone();
    let engine_path = engine.path.clone();
    thread::spawn(move || watch_loop(app_for_loop, engine_path, stop_for_loop, holder));

    // Give the loop a moment to spawn the CLI, then record its pid for stop().
    for _ in 0..20 {
        if let Some(pid) = *state_holder.lock().unwrap() {
            *guard = Some(WatchState { stop_flag: stop, pid });
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    *guard = Some(WatchState { stop_flag: stop, pid: 0 });
    Ok(())
}

pub fn stop() {
    let guard = &mut WATCH.lock().unwrap();
    if let Some(state) = guard.take() {
        state.stop_flag.store(true, Ordering::SeqCst);
        if state.pid != 0 {
            super::kill_pid(state.pid);
        }
    }
}

fn watch_loop(
    app: AppHandle,
    engine_path: String,
    stop: std::sync::Arc<AtomicBool>,
    pid_holder: std::sync::Arc<Mutex<Option<u32>>>,
) {
    let interval: &[&str] = &["status", "--watch", "--interval", "2s"];
    while !stop.load(Ordering::SeqCst) {
        let _ = app.emit(EVENT_WATCH_STATE, "connecting");
        let spawned = Command::new(&engine_path)
            .args(interval)
            .env("PATH", super::enriched_path(None))
            .env("MO_NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("engine-error", format!("无法启动 mole status: {e}"));
                break;
            }
        };
        *pid_holder.lock().unwrap() = Some(child.id());

        if let Some(stdout) = child.stdout.take() {
            let app_reader = app.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(l) if l.trim().is_empty() => continue,
                        Ok(l) => match serde_json::from_str::<Value>(&l) {
                            Ok(v) => {
                                let _ = app_reader.emit(EVENT_STATUS, v);
                            }
                            Err(_) => {
                                let _ = app_reader.emit(
                                    "engine-error",
                                    "status 输出不是合法 JSON(引擎版本可能过旧)".to_string(),
                                );
                            }
                        },
                        Err(_) => break,
                    }
                }
            });
        }

        // Wait for exit or stop request.
        loop {
            if stop.load(Ordering::SeqCst) {
                super::kill_pid(child.id());
                let _ = child.wait();
                break;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !stop.load(Ordering::SeqCst) {
                        let _ = app.emit(EVENT_WATCH_STATE, "reconnecting");
                        // Surface nonzero exits once so the UI can hint.
                        if !status.success() {
                            let _ = app.emit(
                                "engine-error",
                                format!("mole status 退出(code {}),2 秒后重试", status.code().unwrap_or(-1)),
                            );
                        }
                    }
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(200)),
                Err(_) => break,
            }
        }
        *pid_holder.lock().unwrap() = None;
        if stop.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(Duration::from_secs(2));
    }
    let _ = app.emit(EVENT_WATCH_STATE, "stopped");
}
