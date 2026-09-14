//! Private offline process authority. Legacy WebView transports never own this child.
use super::legacy_snapshot::CapturedLegacySnapshot;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri_plugin_shell::ShellExt;

const REQUEST_BYTE_LIMIT: usize = 9 * 1024 * 1024;
const STDOUT_BYTE_LIMIT: usize = 32 * 1024;
const STDERR_BYTE_LIMIT: usize = 16 * 1024;
const VALIDATOR_VERSION: &str = "native-pipeline-checkpoint-v1";

pub(crate) struct LegacyValidatorProcess {
    command: Mutex<Command>,
    timeout: Duration,
}

/// The only public-to-crate authority returned by a successfully correlated child.
/// It cannot be deserialized, cloned or supplied by a frontend command.
pub(crate) struct ValidatedLegacySnapshot {
    snapshot: CapturedLegacySnapshot,
    replay: FullLegacyReplay,
}

struct FullLegacyReplay {
    generation: u64,
    request_id: String,
    snapshot_sha256: String,
    pipeline_sha256: String,
}

impl ValidatedLegacySnapshot {
    pub(crate) fn snapshot(&self) -> &CapturedLegacySnapshot {
        &self.snapshot
    }
    pub(crate) fn recheck(&self) -> Result<(), String> {
        if self.replay.generation == 0
            || self.replay.request_id.is_empty()
            || self.replay.snapshot_sha256 != self.snapshot.snapshot_sha256()
            || self.replay.pipeline_sha256 != sha256(self.snapshot.pipeline_json().as_bytes())
        {
            return Err("legacy replay token no longer matches its captured bytes".into());
        }
        self.snapshot.recheck()
    }
}

impl LegacyValidatorProcess {
    /// Uses Tauri's bundled sidecar resolution (including packaged executable
    /// location), never a UI path, environment-selected worker, or legacy child.
    /// Each request gets an isolated child generation and closes its input at EOF.
    pub(crate) fn bundled<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, String> {
        let command = app
            .shell()
            .sidecar("digital-twin-worker")
            .map_err(message)?
            .arg("--presales-validate")
            .env_clear();
        Ok(Self {
            command: Mutex::new(command.into()),
            timeout: Duration::from_secs(15),
        })
    }

    #[cfg(test)]
    pub(super) fn from_test_command(command: Command, timeout: Duration) -> Self {
        Self {
            command: Mutex::new(command),
            timeout,
        }
    }

    pub(crate) fn validate(
        &self,
        snapshot: CapturedLegacySnapshot,
    ) -> Result<ValidatedLegacySnapshot, String> {
        static GENERATION: AtomicU64 = AtomicU64::new(1);
        let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
        if generation == 0 || generation > 9_007_199_254_740_991 {
            return Err("validator generation exhausted".into());
        }
        let id = format!("legacy-copy-{}-{generation}", std::process::id());
        let mut request = serde_json::to_vec(&serde_json::json!({"jsonrpc":"2.0", "id":id,
            "method":"presales.legacy.validate", "params":{"generation":generation,"snapshot":snapshot.pipeline_json()}})).map_err(message)?;
        request.push(b'\n');
        if request.len() > REQUEST_BYTE_LIMIT {
            return Err("validator request exceeds byte limit".into());
        }
        let bytes = {
            let mut command = self
                .command
                .lock()
                .map_err(|_| "validator host lock poisoned")?;
            run_child(&mut command, request, self.timeout)?
        };
        if bytes.last() != Some(&b'\n') || bytes[..bytes.len() - 1].contains(&b'\n') {
            return Err("validator response must be one complete bounded line".into());
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| "validator response is not UTF-8")?;
        let response: Response = serde_json::from_str(text)
            .map_err(|e| format!("invalid legacy replay response: {e}"))?;
        let validation = &response.result.validation;
        let digest = sha256(snapshot.pipeline_json().as_bytes());
        if response.jsonrpc != "2.0"
            || response.id != id
            || response.result.generation != generation
            || validation.schema_version != 1
            || validation.validator != VALIDATOR_VERSION
            || validation.snapshot_sha256 != digest
            || validation.byte_length != snapshot.pipeline_json().len()
            || validation.project_id != snapshot.project_id()
            || validation.revision != snapshot.revision()
            || Some(validation.pipeline_schema_version)
                != snapshot.checkpoint().pipeline["schemaVersion"].as_u64()
            || !matches!(validation.pipeline_schema_version, 1 | 2)
        {
            return Err(
                "legacy replay response does not match child generation and captured bytes".into(),
            );
        }
        let replay = FullLegacyReplay {
            generation,
            request_id: id,
            snapshot_sha256: snapshot.snapshot_sha256().into(),
            pipeline_sha256: digest,
        };
        Ok(ValidatedLegacySnapshot { snapshot, replay })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    jsonrpc: String,
    id: String,
    result: ReplayResult,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplayResult {
    generation: u64,
    validation: Validation,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Validation {
    schema_version: u64,
    validator: String,
    snapshot_sha256: String,
    byte_length: usize,
    project_id: String,
    revision: i64,
    pipeline_schema_version: u64,
}

fn run_child(
    command: &mut Command,
    request: Vec<u8>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let deadline = Instant::now() + timeout;
    let mut child = OwnedChild(
        command
            .spawn()
            .map_err(|e| format!("offline validator could not start: {e}"))?,
    );
    let mut stdin = child.0.stdin.take().ok_or("validator stdin unavailable")?;
    let stdout = bounded_reader(
        child
            .0
            .stdout
            .take()
            .ok_or("validator stdout unavailable")?,
        STDOUT_BYTE_LIMIT,
    );
    let stderr = bounded_reader(
        child
            .0
            .stderr
            .take()
            .ok_or("validator stderr unavailable")?,
        STDERR_BYTE_LIMIT,
    );
    let (sent, writing) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = stdin.write_all(&request).map_err(message);
        drop(stdin);
        let _ = sent.send(result);
    });
    let status = loop {
        if let Some(status) = child.0.try_wait().map_err(message)? {
            break status;
        }
        if Instant::now() >= deadline {
            return Err("offline validator timed out".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    child.terminate_group();
    if !status.success() {
        return Err("offline validator exited unsuccessfully".into());
    }
    receive(writing, deadline)??;
    let output = receive(stdout, deadline)??;
    let errors = receive(stderr, deadline)??;
    if !errors.is_empty() {
        return Err("offline validator emitted unexpected stderr".into());
    }
    Ok(output)
}

fn bounded_reader(
    mut source: impl Read + Send + 'static,
    limit: usize,
) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = (&mut source)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(message)
            .and_then(|_| {
                if bytes.len() > limit {
                    Err("validator output exceeds byte limit".into())
                } else {
                    Ok(bytes)
                }
            });
        let _ = sender.send(result);
    });
    receiver
}
fn receive<T>(receiver: mpsc::Receiver<T>, deadline: Instant) -> Result<T, String> {
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| "offline validator stream timed out or disconnected".into())
}
struct OwnedChild(Child);
impl OwnedChild {
    fn terminate_group(&mut self) {
        #[cfg(unix)]
        {
            // SAFETY: spawn assigned the private child a new process group.
            // Kill that owned group so pipe-holding descendants cannot outlive a timeout.
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
        }
        let _ = self.0.kill();
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.terminate_group();
        let _ = self.0.wait();
    }
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "validator_process_tests.rs"]
mod validator_process_tests;
