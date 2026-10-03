mod engine;

use serde_json::Value;
use tauri::AppHandle;

use engine::pty;
use engine::tasks;

#[tauri::command]
fn engine_detect() -> Option<engine::EngineInfo> {
    engine::invalidate();
    engine::detect::detect()
}

#[tauri::command]
fn status_start(app: AppHandle) -> Result<(), String> {
    engine::status::start(app)
}

#[tauri::command]
fn status_stop() {
    engine::status::stop()
}

#[tauri::command]
fn status_snapshot() -> Result<Value, String> {
    let engine = engine::engine()?;
    tasks::status_snapshot(&engine.path)
}

// Long-running engine calls must not run on the main thread: Tauri executes
// sync commands there, and a 40s clean scan would freeze the whole window.
// spawn_blocking keeps the UI event loop free.
async fn engine_job<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("后台任务异常: {e}"))?
}

#[tauri::command]
async fn analyze_run(path: String) -> Result<Value, String> {
    engine_job(move || {
        let engine = engine::engine()?;
        tasks::analyze(&engine.path, &path)
    })
    .await
}

#[tauri::command]
async fn history_run() -> Result<Value, String> {
    engine_job(move || {
        let engine = engine::engine()?;
        tasks::history(&engine.path)
    })
    .await
}

#[tauri::command]
async fn clean_preview() -> Result<tasks::CleanPreview, String> {
    engine_job(move || {
        let engine = engine::engine()?;
        tasks::clean_preview(&engine.path)
    })
    .await
}

#[tauri::command]
async fn uninstall_list() -> Result<tasks::UninstallList, String> {
    engine_job(move || {
        let engine = engine::engine()?;
        tasks::uninstall_list(&engine.path)
    })
    .await
}

#[tauri::command]
async fn app_icon(path: String) -> Result<String, String> {
    engine_job(move || engine::icons::app_icon(&path)).await
}

#[tauri::command]
fn whitelist_list() -> Result<Vec<String>, String> {
    tasks::whitelist_list()
}

#[tauri::command]
fn whitelist_add(pattern: String) -> Result<Vec<String>, String> {
    tasks::whitelist_add(pattern)
}

#[tauri::command]
fn whitelist_remove(pattern: String) -> Result<Vec<String>, String> {
    tasks::whitelist_remove(pattern)
}

#[tauri::command]
fn touchid_status() -> Result<tasks::TouchIdStatus, String> {
    tasks::touchid_status()
}

#[tauri::command]
async fn smc_read() -> Result<engine::smc::SmcData, String> {
    tauri::async_runtime::spawn_blocking(engine::smc::read)
        .await
        .map_err(|e| format!("后台任务异常: {e}"))?
}

#[tauri::command]
fn pty_start(
    app: AppHandle,
    id: String,
    program: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty::start(app, id, program, args, cols, rows)
}

#[tauri::command]
fn pty_write(id: String, data: String) -> Result<(), String> {
    pty::write(&id, &data)
}

#[tauri::command]
fn pty_write_secret(id: String, password: String) -> Result<(), String> {
    engine::pty::write_secret(&id, password)
}

#[tauri::command]
fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    pty::resize(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(id: String) {
    pty::kill(&id)
}

#[tauri::command]
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&path)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = window;
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine_detect,
            status_start,
            status_stop,
            status_snapshot,
            analyze_run,
            history_run,
            clean_preview,
            uninstall_list,
            app_icon,
            whitelist_list,
            whitelist_add,
            whitelist_remove,
            touchid_status,
            smc_read,
            pty_start,
            pty_write,
            pty_write_secret,
            pty_resize,
            pty_kill,
            home_dir,
            reveal_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } => {
                engine::status::stop();
                pty::kill_all();
            }
            tauri::RunEvent::Exit => {
                let _ = app_handle;
            }
            _ => {}
        });
}
