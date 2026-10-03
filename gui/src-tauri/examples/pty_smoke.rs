// Standalone smoke test for the pty layer: same portable-pty mechanics as
// engine/pty.rs (openpty -> spawn -> reader thread -> writer -> resize -> kill).
// Run: cargo run --example pty_smoke
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn main() {
    println!("[1] openpty");
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    let home = std::env::var("HOME").unwrap();
    let mut cmd = CommandBuilder::new(format!("{home}/.local/bin/mole"));
    cmd.args(["status", "--watch", "--interval", "1s"]);
    cmd.cwd(&home);
    cmd.env("TERM", "xterm-256color");
    cmd.env("PATH", format!("/usr/bin:/bin:{home}/.local/bin"));

    println!("[2] spawn");
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    let mut writer = pair.master.take_writer().expect("writer");
    let mut reader = pair.master.try_clone_reader().expect("reader");
    drop(pair.slave);

    // Reader on a thread; main loop polls with timeout so nothing blocks forever.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut seen = Vec::new();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(8) {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(chunk) => seen.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if seen.iter().filter(|&&b| b == b'{').count() >= 2 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&seen);
    println!(
        "[3] collected_bytes={} json_lines={}",
        seen.len(),
        text.lines().filter(|l| l.trim_start().starts_with('{')).count()
    );

    println!("[4] write ctrl-c");
    writer.write_all(&[0x03]).expect("write ctrl-c");
    let _ = writer.flush();

    println!("[5] resize");
    let res = pair
        .master
        .resize(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 });
    println!("[5] resize result: {:?}", res.is_ok());

    println!("[6] kill+wait");
    let mut killer = child.clone_killer();
    let _ = killer.kill();
    let status = child.wait();
    let json_ok = text.contains("health_score") || text.lines().filter(|l| l.trim_start().starts_with('{')).count() > 0;
    println!("exit_status_ok={}", status.map(|s| s.success()).unwrap_or(false));
    println!("pty_tty_detected={}", json_ok);
    assert!(json_ok, "expected at least one NDJSON snapshot via pty");
    println!("PTY SMOKE TEST PASSED");
}
