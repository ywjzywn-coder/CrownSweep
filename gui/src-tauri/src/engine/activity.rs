//! Coordinate maintenance processes with an application replacement.
//! A permit is acquired before spawn/registration, so checking an empty task
//! list and starting an installation cannot race with a new engine command.
use std::sync::{Mutex, MutexGuard};

#[derive(Default)]
struct State {
    tasks: usize,
    installing: bool,
}

static STATE: Mutex<State> = Mutex::new(State { tasks: 0, installing: false });

fn state(gate: &'static Mutex<State>) -> Result<MutexGuard<'static, State>, String> {
    gate.lock().map_err(|_| "任务状态不可用，请重启应用".to_string())
}

pub struct TaskPermit { gate: &'static Mutex<State> }
pub fn begin_task() -> Result<TaskPermit, String> { begin_task_on(&STATE) }
fn begin_task_on(gate: &'static Mutex<State>) -> Result<TaskPermit, String> {
    let mut state = state(gate)?;
    if state.installing {
        return Err("应用更新正在安装，请完成重启后再开始任务".into());
    }
    state.tasks += 1;
    Ok(TaskPermit { gate })
}
impl Drop for TaskPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.lock() {
            state.tasks = state.tasks.saturating_sub(1);
        }
    }
}

pub struct InstallPermit { committed: bool, gate: &'static Mutex<State> }
pub fn begin_install() -> Result<InstallPermit, String> { begin_install_on(&STATE) }
fn begin_install_on(gate: &'static Mutex<State>) -> Result<InstallPermit, String> {
    let mut state = state(gate)?;
    if state.installing {
        return Err("应用更新已开始安装，请完成重启".into());
    }
    if state.tasks != 0 {
        return Err("仍有任务在运行，请等待任务结束后再安装更新".into());
    }
    state.installing = true;
    Ok(InstallPermit { committed: false, gate })
}
impl InstallPermit {
    pub fn commit(&mut self) { self.committed = true; }
}
impl Drop for InstallPermit {
    fn drop(&mut self) {
        if !self.committed {
            if let Ok(mut state) = self.gate.lock() { state.installing = false; }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_excludes_active_commands_and_releases_on_failure() {
        // Isolate the same permit implementation from concurrent process tests.
        let gate = Box::leak(Box::new(Mutex::new(State::default())));
        let task = begin_task_on(gate).unwrap();
        assert!(begin_install_on(gate).is_err());
        drop(task);
        let install = begin_install_on(gate).unwrap();
        assert!(begin_task_on(gate).is_err());
        assert!(gate.lock().unwrap().installing);
        drop(install);
        assert!(begin_task_on(gate).is_ok());
        let mut install = begin_install_on(gate).unwrap();
        install.commit(); drop(install);
        assert!(begin_task_on(gate).is_err());
    }
}
