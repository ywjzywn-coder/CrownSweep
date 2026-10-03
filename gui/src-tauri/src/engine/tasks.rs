use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

pub struct RunOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Run a command to completion with a hard timeout. On timeout the process is
/// killed via pid (we hand the child to a waiter thread, so no handle remains).
pub fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Result<RunOutput, String> {
    let mut child = Command::new(program)
        .args(args)
        .env("PATH", super::enriched_path(None))
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 {program}: {e}"))?;
    let pid = child.id();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let t_out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let t_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = tx.send(status);
    });

    let timed_out;
    let success;
    match rx.recv_timeout(timeout) {
        Ok(status) => {
            success = status.map(|s| s.success()).unwrap_or(false);
            timed_out = false;
        }
        Err(_) => {
            super::kill_pid(pid);
            let _ = rx.recv_timeout(Duration::from_secs(5));
            success = false;
            timed_out = true;
        }
    }
    let out = t_out.join().unwrap_or_default();
    let err = t_err.join().unwrap_or_default();
    Ok(RunOutput { success, stdout: out, stderr: err, timed_out })
}

fn parse_json_output(program: &str, out: &RunOutput) -> Result<Value, String> {
    if out.timed_out {
        return Err(format!("{program} 超时未返回"));
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

pub fn analyze(engine_path: &str, path: &str) -> Result<Value, String> {
    // Go's flag package stops at the first positional argument, so --json
    // must precede the path or the CLI silently falls back to TUI mode.
    let args = ["analyze", "--json", path];
    let out = run_with_timeout(engine_path, &args, Duration::from_secs(300))?;
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

pub fn clean_preview(engine_path: &str) -> Result<CleanPreview, String> {
    let out = run_with_timeout(engine_path, &["clean", "--dry-run"], Duration::from_secs(180))?;
    if out.timed_out {
        return Err("mole clean --dry-run 超时(180s)。可能在等待输入,请重试。".into());
    }
    let list_text = std::env::var("HOME")
        .ok()
        .and_then(|home| std::fs::read_to_string(format!("{home}/.config/mole/clean-list.txt")).ok())
        .unwrap_or_default();
    let (mut groups, summary) = parse_clean_list(&list_text);
    let paths: Vec<String> = groups
        .iter()
        .flat_map(|g| g.items.iter().map(|it| it.path.clone()).collect::<Vec<_>>())
        .collect();
    if groups.is_empty() {
        // No structured file: surface the raw wizard output so the view is
        // never empty.
        groups.push(CleanGroup { title: "原始输出".into(), items: Vec::new() });
    }
    Ok(CleanPreview { groups, summary, paths, raw: out.stdout, timed_out: out.timed_out })
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

pub fn whitelist_list() -> Result<Vec<String>, String> {
    let path = whitelist_file()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect()),
        Err(_) => Ok(Vec::new()),
    }
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
