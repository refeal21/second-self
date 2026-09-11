use std::{path::PathBuf, sync::Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::codex_process::{resolve_codex_binary, CodexAppServerProcess, SystemCodexBinaryProbe};
use crate::{presales_v3::activity::Transport, workbench::WorkbenchService};

pub const CODEX_STDOUT_EVENT: &str = "codex-app-server://stdout";
pub const CODEX_STDERR_EVENT: &str = "codex-app-server://stderr";
pub const CODEX_EXIT_EVENT: &str = "codex-app-server://exit";

#[derive(Default)]
struct CodexProcessStateInner {
    current_generation: u64,
    active: Option<ActiveCodexProcess>,
}

struct ActiveCodexProcess {
    generation: u64,
    process: CodexAppServerProcess,
}

#[derive(Default)]
pub struct CodexProcessState {
    inner: Mutex<CodexProcessStateInner>,
}

impl CodexProcessState {
    pub fn reserve_generation(&self) -> u64 {
        let mut inner = self
            .inner
            .lock()
            .expect("Codex process state lock poisoned");
        inner.current_generation += 1;
        inner.current_generation
    }

    pub fn is_current_generation(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.current_generation == generation)
            .unwrap_or(false)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessStarted {
    pub binary_path: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct CodexAppServerLine {
    pub generation: u64,
    pub line: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CodexAppServerExit {
    pub generation: u64,
    pub code: Option<i32>,
    pub signal: Option<String>,
}

#[tauri::command]
pub fn start_codex_app_server(
    app: AppHandle,
    state: State<'_, CodexProcessState>,
    configured_path: Option<String>,
) -> Result<CodexProcessStarted, String> {
    let configured_path = configured_path.map(PathBuf::from);
    let binary_path = resolve_codex_binary(configured_path.as_deref(), &SystemCodexBinaryProbe)?;
    let generation = state.reserve_generation();
    let activity = app.state::<WorkbenchService>().activity().clone();
    let key = activity.process_key(Transport::Codex, generation);

    let stdout_app = app.clone();
    let stderr_app = app.clone();
    let exit_app = app;
    let stdout_activity = activity.clone();
    let stdout_key = key.clone();
    let loss_activity = activity.clone();
    let loss_key = key.clone();
    let loss_app = stderr_app.clone();
    let exit_activity = activity.clone();
    let exit_key = key.clone();
    let process = CodexAppServerProcess::spawn_observed(
        &binary_path,
        move |line| {
            let _ = stdout_activity.observe_line(&stdout_key, line.as_bytes());
            let _ = stdout_app.emit(CODEX_STDOUT_EVENT, CodexAppServerLine { generation, line });
        },
        move || {
            let _ = loss_activity.evidence_lost(&loss_key);
            let _ = loss_app.emit(CODEX_STDERR_EVENT, CodexAppServerLine {
                generation,
                line: "protocol_evidence_lost: Codex output was oversized, truncated, unreadable or invalid UTF-8".into(),
            });
        },
        move |line| {
            let _ = stderr_app.emit(CODEX_STDERR_EVENT, CodexAppServerLine { generation, line });
        },
        move |exit| {
            let _ = exit_activity.transport_lost(&exit_key, "remote_terminal_missing");
            let _ = exit_app.emit(
                CODEX_EXIT_EVENT,
                CodexAppServerExit {
                    generation,
                    code: exit.code,
                    signal: exit.signal,
                },
            );
        },
    )?;

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Codex process state lock poisoned".to_string())?;
    if inner.current_generation != generation {
        drop(inner);
        process.stop()?;
        return Err("Codex App Server start was superseded".to_string());
    }
    let previous = inner.active.replace(ActiveCodexProcess {
        generation,
        process,
    });
    drop(inner);
    if let Some(previous) = previous {
        activity.retire_and_stop(
            &activity.process_key(Transport::Codex, previous.generation),
            || previous.process.stop(),
        )?;
    }

    Ok(CodexProcessStarted {
        binary_path: binary_path.to_string_lossy().into_owned(),
        generation,
    })
}

#[tauri::command]
pub fn send_codex_app_server_line(
    state: State<'_, CodexProcessState>,
    service: State<'_, WorkbenchService>,
    generation: u64,
    line: String,
) -> Result<(), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Codex process state lock poisoned".to_string())?;
    let active = inner
        .active
        .as_ref()
        .ok_or_else(|| "Codex App Server is not running".to_string())?;
    if active.generation != generation {
        return Err("Codex App Server generation is stale".to_string());
    }
    let activity = service.activity();
    activity.send(
        &activity.process_key(Transport::Codex, generation),
        &line,
        |_| None,
        || active.process.write_line(&line),
    )
}

#[tauri::command]
pub fn stop_codex_app_server(
    state: State<'_, CodexProcessState>,
    service: State<'_, WorkbenchService>,
    generation: u64,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Codex process state lock poisoned".to_string())?;
    let process = match inner.active.as_ref() {
        Some(active) if active.generation == generation => inner.active.take(),
        _ => None,
    };
    drop(inner);
    if let Some(process) = process {
        let activity = service.activity();
        activity.retire_and_stop(&activity.process_key(Transport::Codex, generation), || {
            process.process.stop()
        })?;
    }
    Ok(())
}
