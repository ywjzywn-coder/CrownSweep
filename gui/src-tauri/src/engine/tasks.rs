use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, LazyLock};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::Value;

pub const SCAN_CANCELLED: &str = "SCAN_CANCELLED: 扫描已取消";

#[derive(Default)]
struct ScanRegistry {
    active: HashMap<String, Arc<ScanControl>>,
    // A cancellation can arrive before spawn_blocking starts the scan.
    pending: HashMap<String, Instant>,
}

#[derive(Default)]
struct ScanControl {
    cancelled: AtomicBool,
    pgid: Mutex<Option<u32>>,
}

static SCANS: LazyLock<Mutex<ScanRegistry>> = LazyLock::new(|| Mutex::new(ScanRegistry::default()));
static SCAN_SERIAL: AtomicUsize = AtomicUsize::new(0);

pub struct ScanGuard {
    _permit: super::activity::TaskPermit,
    id: Option<String>,
    control: Arc<ScanControl>,
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            SCANS.lock().unwrap().active.remove(id);
        }
    }
}

pub fn begin_scan(id: Option<String>) -> Result<ScanGuard, String> {
    let permit = super::activity::begin_task()?;
    let id = Some(id.unwrap_or_else(|| format!("backend-scan-{}", SCAN_SERIAL.fetch_add(1, Ordering::SeqCst))));
    let control = Arc::new(ScanControl::default());
    if let Some(id) = &id {
        validate_scan_id(id)?;
        let mut registry = SCANS.lock().unwrap();
        if registry.active.contains_key(id) {
            return Err("该扫描已经运行".into());
        }
        registry.pending.retain(|_, at| at.elapsed() < Duration::from_secs(60));
        if registry.pending.remove(id).is_some() {
            control.cancelled.store(true, Ordering::SeqCst);
        }
        registry.active.insert(id.clone(), Arc::clone(&control));
    }
    Ok(ScanGuard { _permit: permit, id, control })
}

fn validate_scan_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("非法扫描标识".into());
    }
    Ok(())
}

pub fn cancel_scan(id: &str) -> Result<(), String> {
    validate_scan_id(id)?;
    let mut registry = SCANS.lock().unwrap();
    if let Some(control) = registry.active.get(id) {
        // The runner owns reaping, so cancellation cannot race PID reuse.
        control.cancelled.store(true, Ordering::SeqCst);
    } else {
        registry.pending.retain(|_, at| at.elapsed() < Duration::from_secs(60));
        if registry.pending.len() >= 256 {
            if let Some(oldest) = registry.pending.iter().min_by_key(|(_, at)| **at).map(|(key, _)| key.clone()) {
                registry.pending.remove(&oldest);
            }
        }
        registry.pending.insert(id.to_string(), Instant::now());
    }
    Ok(())
}

pub fn kill_all_scans() {
    for control in SCANS.lock().unwrap().active.values() {
        control.cancelled.store(true, Ordering::SeqCst);
        if let Some(pgid) = *control.pgid.lock().unwrap() {
            signal_group(pgid, nix::libc::SIGKILL);
        }
    }
}

fn signal_group(pgid: u32, signal: i32) {
    // Each command owns a new process group; never signal the app's group.
    if pgid > 1 && pgid <= i32::MAX as u32 {
        unsafe { nix::libc::kill(-(pgid as i32), signal); }
    }
}

pub struct RunOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

fn read_pipe(mut pipe: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        // Keep draining after the limit so verbose children cannot deadlock.
        let mut output = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let remaining = (16 * 1024 * 1024_usize).saturating_sub(output.len());
                    output.extend_from_slice(&buffer[..n.min(remaining)]);
                }
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&output).into_owned());
    });
    rx
}

pub fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Result<RunOutput, String> {
    run_command(program, args, timeout, None)
}

fn run_command(program: &str, args: &[&str], timeout: Duration, scan: Option<&ScanGuard>) -> Result<RunOutput, String> {
    let _permit = super::activity::begin_task()?;
    if scan.is_some_and(|scan| scan.control.cancelled.load(Ordering::SeqCst)) {
        return Err(SCAN_CANCELLED.into());
    }
    let mut child = Command::new(program)
        .args(args)
        .env("PATH", super::enriched_path(None))
        .env("LANG", "en_US.UTF-8")
        // An inherited analyzer override must never replace the GUI's target.
        .env_remove("MO_ANALYZE_PATH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("无法启动 {program}: {e}"))?;
    let pgid = child.id();
    if let Some(scan) = scan {
        *scan.control.pgid.lock().unwrap() = Some(pgid);
    }
    let stdout = read_pipe(child.stdout.take().unwrap());
    let stderr = read_pipe(child.stderr.take().unwrap());
    let started = Instant::now();
    let mut cancelled;
    let mut timed_out;
    let status = loop {
        cancelled = scan.is_some_and(|scan| scan.control.cancelled.load(Ordering::SeqCst));
        timed_out = started.elapsed() >= timeout;
        if cancelled || timed_out {
            signal_group(pgid, nix::libc::SIGTERM);
            std::thread::sleep(Duration::from_millis(100));
            // Escalate before reaping the leader, retaining ownership of PGID.
            signal_group(pgid, nix::libc::SIGKILL);
            break child.wait().map_err(|e| format!("回收扫描进程失败: {e}"))?;
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                signal_group(pgid, nix::libc::SIGKILL);
                let _ = child.wait();
                return Err(format!("等待引擎失败: {error}"));
            }
        }
    };
    // Kill remaining children that inherited pipe handles even if the leader
    // exited first. Both pipe receivers are bounded; a detached helper cannot
    // turn a timeout into an infinite join.
    signal_group(pgid, nix::libc::SIGKILL);
    if let Some(scan) = scan {
        *scan.control.pgid.lock().unwrap() = None;
        cancelled |= scan.control.cancelled.load(Ordering::SeqCst);
    }
    let out = stdout.recv_timeout(Duration::from_secs(2)).map_err(|_| "引擎输出管道未关闭".to_string())?;
    let err = stderr.recv_timeout(Duration::from_secs(2)).map_err(|_| "引擎错误管道未关闭".to_string())?;
    if cancelled {
        return Err(SCAN_CANCELLED.into());
    }
    Ok(RunOutput { success: status.success(), stdout: out, stderr: err, timed_out })
}

fn parse_json_output(program: &str, out: &RunOutput) -> Result<Value, String> {
    if out.timed_out {
        return Err(format!("SCAN_TIMEOUT: {program} 已超时，子进程已停止"));
    }
    if !out.success {
        return Err(format!("{program} 执行失败: {}", truncate(&out.stderr, 400)));
    }
    let text = out.stdout.trim();
    if text.is_empty() {
        return Err(format!(
            "{program} 没有输出。stderr: {}",
            truncate(&out.stderr, 400)
        ));
    }
    serde_json::from_str::<Value>(text).map_err(|e| {
        format!(
            "JSON 解析失败({e}),引擎输出可能不兼容。原始输出: {}",
            truncate(text, 600)
        )
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

pub fn status_snapshot(engine_path: &str) -> Result<Value, String> {
    let out = run_with_timeout(engine_path, &["status", "--json"], Duration::from_secs(60))?;
    parse_json_output("mole status --json", &out)
}

pub fn analyze(engine_path: &str, path: &str, scan: &ScanGuard) -> Result<Value, String> {
    // Go's flag package stops at the first positional argument, so --json
    // must precede the path or the CLI silently falls back to TUI mode.
    let args = ["analyze", "--json", path];
    let target = Path::new(path);
    if !target.is_absolute() || !target.is_dir() {
        return Err("请选择存在的绝对目录路径".into());
    }
    let out = run_command(engine_path, &args, Duration::from_secs(300), Some(scan))?;
    let v = parse_json_output("mole analyze", &out)?;
    Ok(serde_json::json!({ "result": v, "raw_stderr": truncate(&out.stderr, 400) }))
}

pub fn history(engine_path: &str) -> Result<Value, String> {
    let out = run_with_timeout(engine_path, &["history", "--json"], Duration::from_secs(30))?;
    parse_json_output("mole history --json", &out)
}

#[derive(Serialize, Clone)]
pub struct CleanItem {
    pub path: String,
    pub size: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct CleanGroup {
    pub title: String,
    pub items: Vec<CleanItem>,
}

#[derive(Serialize)]
pub struct CleanPreview {
    pub groups: Vec<CleanGroup>,
    pub summary: Vec<String>,
    pub paths: Vec<String>,
    pub raw: String,
    pub timed_out: bool,
}

/// "11.7MB" / "1.53GB" / "49KB" / "0B" -> bytes, best effort.
fn parse_size_bytes(size: &str) -> u64 {
    let size = size.split(',').next().unwrap_or("").trim();
    let num: String = size.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    let v: f64 = num.parse().unwrap_or(0.0);
    let up = size.to_ascii_uppercase();
    if up.contains("GB") {
        (v * 1024.0 * 1024.0 * 1024.0) as u64
    } else if up.contains("MB") {
        (v * 1024.0 * 1024.0) as u64
    } else if up.contains("KB") {
        (v * 1024.0) as u64
    } else {
        v as u64
    }
}

/// Parse the machine-readable preview file the CLI writes on dry-run
/// (`~/.config/mole/clean-list.txt`): `=== Section ===` headers and
/// `path  # size` rows.
fn parse_clean_list(text: &str) -> (Vec<CleanGroup>, Vec<String>) {
    let mut groups: Vec<CleanGroup> = Vec::new();
    let mut summary: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.starts_with("===") && line.ends_with("===") && line.len() > 6 {
            groups.push(CleanGroup {
                title: line.trim_matches('=').trim().to_string(),
                items: Vec::new(),
            });
            continue;
        }
        if line.starts_with('#') {
            let note = line.trim_start_matches('#').trim();
            if !note.is_empty() && !note.starts_with("Mole Cleanup") && note.len() > 3 {
                summary.push(note.to_string());
            }
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        if let Some(pos) = line.rfind("  # ") {
            let path = line[..pos].trim().to_string();
            let size = line[pos + 4..].trim().to_string();
            if !path.starts_with('/') {
                continue;
            }
            let size_bytes = parse_size_bytes(&size);
            match groups.last_mut() {
                Some(g) => g.items.push(CleanItem { path, size, size_bytes }),
                None => groups.push(CleanGroup {
                    title: "其他".into(),
                    items: vec![CleanItem { path, size, size_bytes }],
                }),
            }
        }
    }
    groups.retain(|g| !g.items.is_empty());
    (groups, summary)
}

#[derive(PartialEq, Eq)]
struct PreviewFingerprint {
    modified: SystemTime,
    changed: (i64, i64),
    inode: u64,
    size: u64,
}

fn preview_fingerprint(path: &Path) -> Result<Option<PreviewFingerprint>, String> {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(Some(PreviewFingerprint {
            modified: meta.modified().map_err(|e| format!("检查预览时间失败: {e}"))?,
            changed: (meta.ctime(), meta.ctime_nsec()),
            inode: meta.ino(),
            size: meta.len(),
        })),
        Ok(_) => Err("清理预览路径不是普通文件".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取清理预览属性: {error}")),
    }
}

fn read_fresh_preview(path: &Path, before: Option<PreviewFingerprint>) -> Result<String, String> {
    let after = preview_fingerprint(path)?;
    if after.is_none() || after == before {
        return Err("本次扫描未生成新的清理清单，已拒绝显示旧结果。请重新扫描或更新引擎。".into());
    }
    std::fs::read_to_string(path).map_err(|e| format!("读取本次清理清单失败: {e}"))
}

pub fn clean_preview(engine_path: &str, scan: &ScanGuard) -> Result<CleanPreview, String> {
    // Never remove/truncate the user's previous preview. Require the engine
    // to publish a new file successfully before accepting it as this scan.
    let home = std::env::var("HOME").map_err(|_| "无法确定 HOME".to_string())?;
    let path = PathBuf::from(home).join(".config/mole/clean-list.txt");
    clean_preview_from(engine_path, &path, scan)
}

fn clean_preview_from(engine_path: &str, path: &Path, scan: &ScanGuard) -> Result<CleanPreview, String> {
    let before = preview_fingerprint(path)?;
    let out = run_command(engine_path, &["clean", "--dry-run"], Duration::from_secs(180), Some(scan))?;
    if out.timed_out {
        return Err("SCAN_TIMEOUT: 清理扫描已超时（180 秒），子进程已停止。请重新扫描。".into());
    }
    if !out.success {
        return Err(format!("清理扫描未成功完成: {}", truncate(&out.stderr, 400)));
    }
    let list_text = read_fresh_preview(path, before)?;
    let (groups, summary) = parse_clean_list(&list_text);
    let paths = groups.iter().flat_map(|group| group.items.iter().map(|item| item.path.clone())).collect();
    Ok(CleanPreview { groups, summary, paths, raw: out.stdout, timed_out: false })
}

// ---------- Touch ID for sudo (mole touchid manages /etc/pam.d/sudo_local) ----------

#[derive(Serialize)]
pub struct TouchIdStatus {
    /// pam_tid.so found in sudo_local (or fallback sudo) config.
    pub enabled: bool,
}

pub fn touchid_status() -> Result<TouchIdStatus, String> {
    let check = |file: &str| -> bool {
        std::fs::read_to_string(file)
            .map(|text| text.contains("pam_tid.so"))
            .unwrap_or(false)
    };
    let enabled = check("/etc/pam.d/sudo_local") || check("/etc/pam.d/sudo");
    Ok(TouchIdStatus { enabled })
}

// ---------- whitelist (~/.config/mole/whitelist, CLI-documented) ----------

fn whitelist_file() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法确定 HOME".to_string())?;
    Ok(PathBuf::from(format!("{home}/.config/mole/whitelist")))
}

fn read_whitelist(path: &Path) -> Result<Vec<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::symlink_metadata(path) {
                Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
                _ => Err(format!("保护名单读取失败: {error}。清理前请重试。")),
            }
        },
        Err(error) => Err(format!("保护名单读取失败: {error}。清理前请重试。")),
    }
}

pub fn whitelist_list() -> Result<Vec<String>, String> {
    read_whitelist(&whitelist_file()?)
}

pub fn whitelist_add(pattern: String) -> Result<Vec<String>, String> {
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() || pattern.contains('\n') || pattern.contains("..") {
        return Err("非法的白名单路径".into());
    }
    let mut items = whitelist_list()?;
    if items.iter().any(|i| i == &pattern) {
        return Ok(items);
    }
    items.push(pattern);
    let path = whitelist_file()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录: {e}"))?;
    }
    let mut text = String::from("# Mole GUI whitelist (one pattern per line)\n");
    for it in &items {
        text.push_str(it);
        text.push('\n');
    }
    std::fs::write(&path, text).map_err(|e| format!("写入白名单: {e}"))?;
    Ok(items)
}

pub fn whitelist_remove(pattern: String) -> Result<Vec<String>, String> {
    let mut items = whitelist_list()?;
    items.retain(|i| i != &pattern);
    let path = whitelist_file()?;
    let mut text = String::from("# Mole GUI whitelist (one pattern per line)\n");
    for it in &items {
        text.push_str(it);
        text.push('\n');
    }
    std::fs::write(&path, text).map_err(|e| format!("写入白名单: {e}"))?;
    Ok(items)
}

#[derive(Serialize, Clone)]
pub struct AppEntry {
    pub name: String,
    pub bundle_id: String,
    pub source: String,
    pub uninstall_name: String,
    pub path: String,
    pub size: String,
    /// Parsed from `size` for sorting ("1.60GB" -> 1536.0).
    pub size_hint_mb: f64,
}

#[derive(Serialize)]
pub struct UninstallList {
    pub apps: Vec<AppEntry>,
    pub raw: String,
    /// True when the engine emitted its piped-stdout JSON array (v1.5x+).
    pub json: bool,
}

/// "210.5MB" / "1.60GB" / "342KB" -> MB, best effort.
fn parse_size_mb(size: &str) -> f64 {
    let num: String = size.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    let v: f64 = num.parse().unwrap_or(0.0);
    let up = size.to_ascii_uppercase();
    if up.contains("GB") {
        v * 1024.0
    } else if up.contains("MB") {
        v
    } else if up.contains("KB") {
        v / 1024.0
    } else {
        v
    }
}

pub fn uninstall_list(engine_path: &str) -> Result<UninstallList, String> {
    let out = run_with_timeout(engine_path, &["uninstall", "--list"], Duration::from_secs(120))?;
    if out.timed_out {
        return Err("mole uninstall --list 超时。".into());
    }
    if !out.success && out.stdout.trim().is_empty() {
        return Err(truncate(&out.stderr, 400));
    }

    // The engine auto-switches to a JSON array when stdout is piped
    // (bin/uninstall.sh uninstall_list_apps). Fall back to text lines for
    // engines without that path.
    let text = out.stdout.trim();
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text) {
        let apps: Vec<AppEntry> = items
            .iter()
            .filter_map(|it| {
                let name = it.get("name")?.as_str()?.to_string();
                Some(AppEntry {
                    name: name.clone(),
                    bundle_id: it.get("bundle_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    source: it.get("source").and_then(|v| v.as_str()).unwrap_or("App").to_string(),
                    uninstall_name: it
                        .get("uninstall_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&name)
                        .to_string(),
                    path: it.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    size: it.get("size").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    size_hint_mb: it
                        .get("size")
                        .and_then(|v| v.as_str())
                        .map(parse_size_mb)
                        .unwrap_or(0.0),
                })
            })
            .collect();
        return Ok(UninstallList { apps, raw: text.to_string(), json: true });
    }

    let apps: Vec<AppEntry> = out
        .stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with('=') && !l.starts_with('-'))
        .map(|l| AppEntry {
            name: l.clone(),
            bundle_id: String::new(),
            source: "App".into(),
            uninstall_name: l.clone(),
            path: String::new(),
            size: String::new(),
            size_hint_mb: 0.0,
        })
        .collect();
    Ok(UninstallList { apps, raw: out.stdout, json: false })
}

#[cfg(test)]
mod gui_preview_tests {
    use super::*;
    #[test]
    fn size_does_not_include_item_counts_or_ancestor_path_digits() {
        assert_eq!(parse_size_bytes("12MB, 23 items"), 12 * 1024 * 1024);
        assert_eq!(parse_size_bytes("4KB, counted under /tmp/123"), 4096);
        assert_eq!(parse_size_bytes("size unknown, 45 items"), 0);
    }
}

#[cfg(test)]
mod scan_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    static SERIAL: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("crownsweep-scan-test-{}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::SeqCst)));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only this test's unique temporary fixture directory is removed.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn id() -> String { format!("test-scan-{}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::SeqCst)) }
    fn pid_file(path: &Path) -> u32 {
        let started = Instant::now();
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse() { return pid; }
            }
            assert!(started.elapsed() < Duration::from_secs(3), "fixture process never started");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn assert_stopped(pid: u32) {
        let started = Instant::now();
        loop {
            let output = Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "stat="]).output().unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            if state.trim().is_empty() || state.trim().starts_with('Z') { return; }
            assert!(started.elapsed() < Duration::from_secs(2), "fixture process {pid} is still running: {state}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn cancellation_before_registration_prevents_spawning() {
        let fixture = Fixture::new();
        let marker = fixture.0.join("must-not-exist");
        let id = id();
        cancel_scan(&id).unwrap();
        let scan = begin_scan(Some(id)).unwrap();
        let error = run_command("/bin/sh", &["-c", "touch \"$1\"", "fixture", marker.to_str().unwrap()], Duration::from_secs(1), Some(&scan)).err().unwrap();
        assert!(error.contains("SCAN_CANCELLED:"));
        assert!(!marker.exists());
    }

    #[test]
    fn cancellation_kills_leader_and_children_that_hold_pipes() {
        let fixture = Fixture::new();
        let child_pid_path = fixture.0.join("child.pid");
        let leader_pid_path = fixture.0.join("leader.pid");
        let id = id();
        let scan = begin_scan(Some(id.clone())).unwrap();
        let child_arg = child_pid_path.to_string_lossy().into_owned();
        let leader_arg = leader_pid_path.to_string_lossy().into_owned();
        let thread = std::thread::spawn(move || run_command("/bin/sh", &["-c", "trap '' TERM; sleep 60 & echo $! > \"$1\"; echo $$ > \"$2\"; wait", "fixture", &child_arg, &leader_arg], Duration::from_secs(10), Some(&scan)));
        let child_pid = pid_file(&child_pid_path);
        let leader_pid = pid_file(&leader_pid_path);
        let started = Instant::now();
        cancel_scan(&id).unwrap();
        let error = thread.join().unwrap().err().unwrap();
        assert!(error.contains("SCAN_CANCELLED:"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_stopped(child_pid); assert_stopped(leader_pid);
        assert!(!SCANS.lock().unwrap().active.contains_key(&id));
    }

    #[test]
    fn timeout_kills_children_and_pipe_readers_do_not_hang() {
        let fixture = Fixture::new();
        let child_pid_path = fixture.0.join("child.pid");
        let started = Instant::now();
        let output = run_command("/bin/sh", &["-c", "trap '' TERM; sleep 60 & echo $! > \"$1\"; wait", "fixture", child_pid_path.to_str().unwrap()], Duration::from_millis(200), None).unwrap();
        assert!(output.timed_out);
        assert!(!output.success);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_stopped(pid_file(&child_pid_path));
    }

    #[test]
    fn one_scan_cancellation_does_not_signal_another_process_group() {
        let other_id = id();
        let other_scan = begin_scan(Some(other_id.clone())).unwrap();
        cancel_scan(&id()).unwrap();
        let output = run_command("/bin/sh", &["-c", "printf safe"], Duration::from_secs(1), Some(&other_scan)).unwrap();
        assert_eq!(output.stdout, "safe");
        assert!(output.success);
        let duplicate = begin_scan(Some(other_id));
        assert!(duplicate.is_err());
    }

    #[test]
    fn exited_leader_does_not_leave_a_sleeping_child_holding_stdout() {
        let fixture = Fixture::new();
        let child_pid_path = fixture.0.join("child.pid");
        let started = Instant::now();
        let output = run_command("/bin/sh", &["-c", "sleep 60 & echo $! > \"$1\"; printf result", "fixture", child_pid_path.to_str().unwrap()], Duration::from_secs(1), None).unwrap();
        assert!(output.success);
        assert_eq!(output.stdout, "result");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_stopped(pid_file(&child_pid_path));
    }

    #[test]
    fn stale_or_missing_clean_preview_is_never_accepted() {
        let fixture = Fixture::new();
        let path = fixture.0.join("clean-list.txt");
        assert!(read_fresh_preview(&path, None).is_err());
        std::fs::write(&path, "=== cache ===\n/tmp/old  # 1KB\n").unwrap();
        let before = preview_fingerprint(&path).unwrap();
        assert!(read_fresh_preview(&path, before).unwrap_err().contains("旧结果"));
        let before = preview_fingerprint(&path).unwrap();
        std::fs::write(&path, "=== cache ===\n/tmp/current  # 2KB\n").unwrap();
        assert!(read_fresh_preview(&path, before).unwrap().contains("/tmp/current"));
    }

    #[test]
    fn clean_preview_requires_a_successful_command_and_a_fresh_file() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let path = fixture.0.join("clean-list.txt");
        let script = fixture.0.join("engine.sh");
        let old = "=== cache ===\n/tmp/old  # 1KB\n";
        std::fs::write(&path, old).unwrap();
        std::fs::write(&script, r#"#!/bin/sh
[ "$1" = clean ] && [ "$2" = --dry-run ] || exit 9
printf done
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let scan = begin_scan(Some(id())).unwrap();
        let error = clean_preview_from(script.to_str().unwrap(), &path, &scan).err().unwrap();
        assert!(error.contains("旧结果"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), old);
        std::fs::write(&script, r#"#!/bin/sh
printf '=== cache ===\n/tmp/new  # 2KB\n' > "$(dirname "$0")/clean-list.txt"
echo fixture-failure >&2
exit 2
"#).unwrap();
        let error = clean_preview_from(script.to_str().unwrap(), &path, &scan).err().unwrap();
        assert!(error.contains("fixture-failure"));
        std::fs::write(&script, r#"#!/bin/sh
printf '=== cache ===\n/tmp/current  # 3KB\n' > "$(dirname "$0")/clean-list.txt"
printf done
"#).unwrap();
        let preview = clean_preview_from(script.to_str().unwrap(), &path, &scan).unwrap();
        assert_eq!(preview.paths, ["/tmp/current"]);
        assert_eq!(preview.groups[0].items[0].size_bytes, 3072);
    }

    #[test]
    fn a_missing_whitelist_is_empty_but_unreadable_data_is_an_error() {
        let fixture = Fixture::new();
        let path = fixture.0.join("whitelist");
        assert!(read_whitelist(&path).unwrap().is_empty());
        std::os::unix::fs::symlink(fixture.0.join("missing-target"), &path).unwrap();
        assert!(read_whitelist(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(read_whitelist(&path).unwrap_err().contains("读取失败"));
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(read_whitelist(&path).is_err());
        std::fs::write(&path, "# comment\n/tmp/keep\n\n").unwrap();
        assert_eq!(read_whitelist(&path).unwrap(), ["/tmp/keep"]);
    }

    #[test]
    fn failed_json_commands_cannot_become_successful_results() {
        let output = RunOutput { success: false, stdout: "{\"entries\":[]}".into(), stderr: "fixture failure".into(), timed_out: false };
        assert!(parse_json_output("fixture", &output).unwrap_err().contains("fixture failure"));
    }
}
