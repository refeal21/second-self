use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

pub const WORKER_STDOUT_EVENT: &str = "workflow-worker://stdout";
pub const WORKER_STDERR_EVENT: &str = "workflow-worker://stderr";
pub const WORKER_EXIT_EVENT: &str = "workflow-worker://exit";

#[derive(Default)]
struct WorkerStateInner {
    current_generation: u64,
    active: Option<ActiveWorker>,
}

struct ActiveWorker {
    generation: u64,
    child: CommandChild,
}

#[derive(Default)]
pub struct WorkerSidecarState {
    inner: Mutex<WorkerStateInner>,
}

impl WorkerSidecarState {
    pub fn reserve_generation(&self) -> u64 {
        let mut inner = self.inner.lock().expect("Worker state lock poisoned");
        inner.current_generation += 1;
        inner.current_generation
    }

    pub fn is_current_generation(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.current_generation == generation)
            .unwrap_or(false)
    }

    fn clear_active_if_generation(&self, generation: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .active
                .as_ref()
                .is_some_and(|active| active.generation == generation)
            {
                inner.active.take();
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStarted {
    pub generation: u64,
    pub pid: u32,
    pub protocol_version: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkerLine {
    pub generation: u64,
    pub line: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkerExit {
    pub generation: u64,
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[tauri::command]
pub async fn start_worker_sidecar(
    app: AppHandle,
    state: State<'_, WorkerSidecarState>,
) -> Result<WorkerStarted, String> {
    let generation = state.reserve_generation();
    let command = app
        .shell()
        .sidecar("digital-twin-worker")
        .map_err(|error| format!("Bundled workflow worker is unavailable: {error}"))?;
    let (mut receiver, child) = command
        .spawn()
        .map_err(|error| format!("Bundled workflow worker could not start: {error}"))?;
    let pid = child.pid();

    let previous = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Worker state lock poisoned".to_string())?;
        if inner.current_generation != generation {
            child
                .kill()
                .map_err(|error| format!("Superseded worker could not stop: {error}"))?;
            return Err("Workflow worker start was superseded".into());
        }
        inner.active.replace(ActiveWorker { generation, child })
    };
    if let Some(previous) = previous {
        previous
            .child
            .kill()
            .map_err(|error| format!("Previous workflow worker could not stop: {error}"))?;
    }

    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let _ = event_app.emit(
                        WORKER_STDOUT_EVENT,
                        WorkerLine {
                            generation,
                            line: String::from_utf8_lossy(&bytes).into_owned(),
                        },
                    );
                }
                CommandEvent::Stderr(bytes) => {
                    let _ = event_app.emit(
                        WORKER_STDERR_EVENT,
                        WorkerLine {
                            generation,
                            line: String::from_utf8_lossy(&bytes).into_owned(),
                        },
                    );
                }
                CommandEvent::Error(line) => {
                    let _ = event_app.emit(WORKER_STDERR_EVENT, WorkerLine { generation, line });
                }
                CommandEvent::Terminated(payload) => {
                    event_app
                        .state::<WorkerSidecarState>()
                        .clear_active_if_generation(generation);
                    let _ = event_app.emit(
                        WORKER_EXIT_EVENT,
                        WorkerExit {
                            generation,
                            code: payload.code,
                            signal: payload.signal,
                        },
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(WorkerStarted {
        generation,
        pid,
        protocol_version: 1,
    })
}

#[tauri::command]
pub fn send_worker_sidecar_line(
    state: State<'_, WorkerSidecarState>,
    generation: u64,
    line: String,
) -> Result<(), String> {
    if line.contains('\n') || line.contains('\r') {
        return Err("Worker JSON-RPC request must be exactly one line".into());
    }
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Worker state lock poisoned".to_string())?;
    let active = inner
        .active
        .as_mut()
        .ok_or_else(|| "Workflow worker is not running".to_string())?;
    if active.generation != generation {
        return Err("Workflow worker generation is stale".into());
    }
    active
        .child
        .write(format!("{line}\n").as_bytes())
        .map_err(|error| format!("Workflow worker stdin write failed: {error}"))
}

#[tauri::command]
pub fn stop_worker_sidecar(
    state: State<'_, WorkerSidecarState>,
    generation: u64,
) -> Result<(), String> {
    let child = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Worker state lock poisoned".to_string())?;
        match inner.active.as_ref() {
            Some(active) if active.generation == generation => {
                inner.active.take().map(|active| active.child)
            }
            _ => None,
        }
    };
    if let Some(child) = child {
        child
            .kill()
            .map_err(|error| format!("Workflow worker could not stop: {error}"))?;
    }
    Ok(())
}
