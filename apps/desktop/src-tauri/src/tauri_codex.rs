use std::{path::PathBuf, sync::Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::codex_process::{resolve_codex_binary, CodexAppServerProcess, SystemCodexBinaryProbe};

pub const CODEX_STDOUT_EVENT: &str = "codex-app-server://stdout";
pub const CODEX_STDERR_EVENT: &str = "codex-app-server://stderr";
pub const CODEX_EXIT_EVENT: &str = "codex-app-server://exit";

#[derive(Default)]
pub struct CodexProcessState(pub Mutex<Option<CodexAppServerProcess>>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessStarted {
    pub binary_path: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CodexAppServerLine {
    pub line: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CodexAppServerExit {
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

    let stdout_app = app.clone();
    let stderr_app = app.clone();
    let exit_app = app;
    let process = CodexAppServerProcess::spawn(
        &binary_path,
        move |line| {
            let _ = stdout_app.emit(CODEX_STDOUT_EVENT, CodexAppServerLine { line });
        },
        move |line| {
            let _ = stderr_app.emit(CODEX_STDERR_EVENT, CodexAppServerLine { line });
        },
        move |exit| {
            let _ = exit_app.emit(
                CODEX_EXIT_EVENT,
                CodexAppServerExit {
                    code: exit.code,
                    signal: exit.signal,
                },
            );
        },
    )?;

    let mut active = state
        .0
        .lock()
        .map_err(|_| "Codex process state lock poisoned".to_string())?;
    if let Some(previous) = active.replace(process) {
        previous.stop()?;
    }

    Ok(CodexProcessStarted {
        binary_path: binary_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn send_codex_app_server_line(
    state: State<'_, CodexProcessState>,
    line: String,
) -> Result<(), String> {
    let active = state
        .0
        .lock()
        .map_err(|_| "Codex process state lock poisoned".to_string())?;
    active
        .as_ref()
        .ok_or_else(|| "Codex App Server is not running".to_string())?
        .write_line(&line)
}

#[tauri::command]
pub fn stop_codex_app_server(state: State<'_, CodexProcessState>) -> Result<(), String> {
    let mut active = state
        .0
        .lock()
        .map_err(|_| "Codex process state lock poisoned".to_string())?;
    if let Some(process) = active.take() {
        process.stop()?;
    }
    Ok(())
}
