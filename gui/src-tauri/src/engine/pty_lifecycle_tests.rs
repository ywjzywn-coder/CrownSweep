use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;

static SERIAL: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("crownsweep-pty-test-{}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Remove only the unique temporary fixture created by this test.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn wait_pid(path: &Path) -> i32 {
    let started = Instant::now();
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(pid) = text.trim().parse() { return pid; }
        }
        assert!(started.elapsed() < Duration::from_secs(3), "fixture process never started");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn stopped(pid: i32) -> bool {
    let output = std::process::Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "stat="]).output().unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    state.trim().is_empty() || state.trim().starts_with('Z')
}
struct Started {
    child: Box<dyn Child + Send + Sync>,
    group: OwnedGroup,
    _master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    done: mpsc::Receiver<bool>,
    text: Arc<Mutex<String>>,
}
fn spawn_fixture(directory: &Path, script: &str) -> Started {
    let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
    let writer = pair.master.take_writer().unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", script]); command.cwd(directory);
    let child = pair.slave.spawn_command(command).unwrap();
    let group = OwnedGroup::verify(child.process_id().unwrap()).unwrap();
    drop(pair.slave);
    let (tx, done) = mpsc::channel();
    let text = Arc::new(Mutex::new(String::new()));
    let capture = Arc::clone(&text);
    std::thread::spawn(move || {
        let mut bytes = [0_u8; 8192];
        let complete = loop {
            match reader.read(&mut bytes) {
                Ok(0) => break true,
                Ok(count) => capture.lock().unwrap().push_str(&String::from_utf8_lossy(&bytes[..count])),
                Err(error) => break error.raw_os_error() == Some(nix::libc::EIO),
            }
        };
        let _ = tx.send(complete);
    });
    Started { child, group, _master: pair.master, writer, done, text }
}

#[test]
fn refuses_the_application_process_group() {
    assert!(OwnedGroup::verify(std::process::id()).is_err());
}

#[test]
fn closes_int_hup_term_ignoring_pty_and_its_children() {
    let fixture = Fixture::new();
    let mut started = spawn_fixture(&fixture.0, "trap '' INT HUP TERM; /bin/sleep 60 & echo $! > child.pid; echo $$ > parent.pid; wait");
    let child_pid = wait_pid(&fixture.0.join("child.pid"));
    let parent_pid = wait_pid(&fixture.0.join("parent.pid"));
    started.writer.write_all(b"\x03").unwrap();
    assert!(!stopped(parent_pid));
    let killed = Arc::new(AtomicBool::new(true));
    let begin = Instant::now();
    let (code, complete) = finish_group(started.child, started.group, killed, started.done, |error| panic!("{error}"));
    assert_ne!(code, 0); assert!(complete);
    assert!(begin.elapsed() < Duration::from_secs(2));
    assert!(stopped(parent_pid)); assert!(stopped(child_pid));
}

#[test]
fn parent_exit_still_drains_summary_and_terminates_remaining_child() {
    let fixture = Fixture::new();
    let started = spawn_fixture(&fixture.0, "/bin/sleep 60 & echo $! > child.pid; printf 'Tracked cleanup: 123MB\\n'; exit 0");
    let child_pid = wait_pid(&fixture.0.join("child.pid"));
    let (code, complete) = finish_group(started.child, started.group, Arc::new(AtomicBool::new(false)), started.done, |error| panic!("{error}"));
    assert_eq!(code, 0); assert!(complete);
    assert!(started.text.lock().unwrap().contains("Tracked cleanup: 123MB"));
    assert!(stopped(child_pid));
}

#[test]
fn ending_one_pty_never_signals_another_session() {
    let first_dir = Fixture::new(); let second_dir = Fixture::new();
    let first = spawn_fixture(&first_dir.0, "echo $$ > parent.pid; trap '' HUP TERM; /bin/sleep 60 & wait");
    let second = spawn_fixture(&second_dir.0, "echo $$ > parent.pid; /bin/sleep 60 & wait");
    let first_pid = wait_pid(&first_dir.0.join("parent.pid"));
    let second_pid = wait_pid(&second_dir.0.join("parent.pid"));
    finish_group(first.child, first.group, Arc::new(AtomicBool::new(true)), first.done, |error| panic!("{error}"));
    assert!(stopped(first_pid)); assert!(!stopped(second_pid));
    finish_group(second.child, second.group, Arc::new(AtomicBool::new(true)), second.done, |error| panic!("{error}"));
    assert!(stopped(second_pid));
}

#[test]
fn permission_refusal_keeps_the_activity_permit_until_the_group_really_stops() {
    struct ProtectedGroup { active: Arc<AtomicBool> }
    impl GroupLifecycle for ProtectedGroup {
        fn active_groups(&self) -> Result<HashSet<i32>, String> { Ok(if self.active.load(Ordering::SeqCst) { HashSet::from([99]) } else { HashSet::new() }) }
        fn signal(&self, _: i32) -> Result<(), String> { Err("fixture permission denied".into()) }
    }
    let fixture = Fixture::new();
    let started = spawn_fixture(&fixture.0, "printf 'mock permission fixture\\n'; exit 0");
    let active = Arc::new(AtomicBool::new(true));
    let protected = ProtectedGroup { active: Arc::clone(&active) };
    let permit = super::super::activity::begin_task().unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let errors = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::clone(&errors);
    let worker = std::thread::spawn(move || {
        let result = finish_group(started.child, protected, Arc::new(AtomicBool::new(true)), started.done, |error| capture.lock().unwrap().push(error));
        drop(permit); done_tx.send(result).unwrap();
    });
    assert!(done_rx.recv_timeout(Duration::from_millis(400)).is_err());
    assert!(super::super::activity::begin_install().is_err());
    assert!(errors.lock().unwrap().iter().any(|error| error.contains("permission denied")));
    active.store(false, Ordering::SeqCst);
    assert!(done_rx.recv_timeout(Duration::from_secs(2)).unwrap().1);
    worker.join().unwrap();
}

#[test]
fn exit_kill_all_delivers_signals_before_the_application_can_terminate() {
    let fixture = Fixture::new();
    let started = spawn_fixture(&fixture.0, "trap '' INT HUP TERM; /bin/sleep 60 & echo $! > child.pid; echo $$ > parent.pid; wait");
    let child_pid = wait_pid(&fixture.0.join("child.pid"));
    let parent_pid = wait_pid(&fixture.0.join("parent.pid"));
    let group = Arc::new(started.group);
    let killed = Arc::new(AtomicBool::new(false));
    let id = format!("exit-fixture-{}", SERIAL.fetch_add(1, Ordering::SeqCst));
    with_sessions(|sessions| sessions.insert(id.clone(), Session { writer: Mutex::new(started.writer), master: started._master, killed: Arc::clone(&killed), group: Arc::clone(&group) }));
    // No waiter is running: this proves shutdown itself delivered the signals.
    kill_all();
    let began = Instant::now();
    while !stopped(parent_pid) || !stopped(child_pid) {
        assert!(began.elapsed() < Duration::from_secs(1));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(killed.load(Ordering::SeqCst));
    let (_, complete) = finish_group(started.child, group, killed, started.done, |error| panic!("{error}"));
    assert!(complete);
    with_sessions(|sessions| sessions.remove(&id));
}

#[test]
fn a_failed_output_drain_is_reported_instead_of_claiming_complete_logs() {
    let fixture = Fixture::new();
    let started = spawn_fixture(&fixture.0, "printf 'fixture\\n'; exit 0");
    let (tx, incomplete) = mpsc::channel(); drop(tx);
    let mut errors = Vec::new();
    let (code, complete) = finish_group(started.child, started.group, Arc::new(AtomicBool::new(false)), incomplete, |error| errors.push(error));
    assert_eq!(code, 0); assert!(!complete);
    assert!(errors.iter().any(|error| error.contains("不完整")));
}
