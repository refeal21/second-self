//! Dedicated native process lifetime. It has no Tauri/legacy process handle.
use crate::codex_process::CodexAppServerProcess;
use std::{
    path::Path,
    sync::{mpsc, Arc},
    thread,
};
pub(super) enum ProviderEvent {
    Line(String),
    Lost,
}
pub(super) struct PrivateProviderProcess {
    child: Arc<CodexAppServerProcess>,
    outgoing: mpsc::SyncSender<String>,
    events: mpsc::Receiver<ProviderEvent>,
}
impl PrivateProviderProcess {
    pub(super) fn start(binary: &Path, cwd: &Path) -> Result<Self, String> {
        let (sender, events) = mpsc::sync_channel(2);
        let loss = sender.clone();
        let exit = sender.clone();
        let child = Arc::new(CodexAppServerProcess::spawn_private(
            binary,
            cwd,
            move |line| {
                let _ = sender.send(ProviderEvent::Line(line));
            },
            move || {
                let _ = loss.send(ProviderEvent::Lost);
            },
            move |_| {
                let _ = exit.send(ProviderEvent::Lost);
            },
        )?);
        let (outgoing, writer) = mpsc::sync_channel::<String>(8);
        let owned = child.clone();
        thread::spawn(move || {
            while let Ok(line) = writer.recv() {
                if owned.write_line(&line).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            outgoing,
            events,
        })
    }
    pub(super) fn send(&self, line: String) -> Result<(), String> {
        if line.len() > 9 * 1024 * 1024 || line.contains(['\n', '\r']) {
            return Err("private provider input frame rejected".into());
        }
        let value: serde_json::Value =
            serde_json::from_str(&line).map_err(|_| "invalid private provider JSON")?;
        // Even a private Worker bug cannot expose login/config write methods.
        let method = value["method"]
            .as_str()
            .ok_or("private provider method missing")?;
        if !matches!(
            method,
            "initialize"
                | "initialized"
                | "account/read"
                | "config/read"
                | "configRequirements/read"
                | "model/list"
                | "modelProvider/capabilities/read"
                | "thread/start"
                | "turn/start"
                | "turn/interrupt"
        ) {
            return Err("private provider method denied".into());
        }
        self.outgoing
            .try_send(line)
            .map_err(|_| "private provider input unavailable".into())
    }
    pub(super) fn event(&self) -> Option<ProviderEvent> {
        self.events.try_recv().ok()
    }
}
impl Drop for PrivateProviderProcess {
    fn drop(&mut self) {
        self.child.stop_and_wait();
    }
}
