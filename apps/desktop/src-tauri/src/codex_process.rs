use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

pub const CHATGPT_BUNDLED_CODEX_PATH: &str = "/Applications/ChatGPT.app/Contents/Resources/codex";

pub trait CodexBinaryProbe {
    fn is_executable(&self, path: &Path) -> bool;
    fn find_on_path(&self, binary_name: &str) -> Option<PathBuf>;
}

pub struct SystemCodexBinaryProbe;

impl CodexBinaryProbe for SystemCodexBinaryProbe {
    fn is_executable(&self, path: &Path) -> bool {
        let Ok(metadata) = path.metadata() else {
            return false;
        };
        if !metadata.is_file() {
            return false;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        }

        #[cfg(not(unix))]
        {
            true
        }
    }

    fn find_on_path(&self, binary_name: &str) -> Option<PathBuf> {
        env::var_os("PATH")
            .into_iter()
            .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
            .map(|directory| directory.join(binary_name))
            .find(|candidate| self.is_executable(candidate))
    }
}

pub fn resolve_codex_binary(
    configured_path: Option<&Path>,
    probe: &impl CodexBinaryProbe,
) -> Result<PathBuf, String> {
    if let Some(path) = configured_path.filter(|path| probe.is_executable(path)) {
        return Ok(path.to_path_buf());
    }

    if let Some(path) = probe.find_on_path("codex") {
        return Ok(path);
    }

    let bundled = PathBuf::from(CHATGPT_BUNDLED_CODEX_PATH);
    if probe.is_executable(&bundled) {
        return Ok(bundled);
    }

    Err("Codex binary was not found in the configured path, PATH, or ChatGPT app".to_string())
}

pub fn build_codex_app_server_command(binary_path: &Path) -> Command {
    let mut command = Command::new(binary_path);
    command.args(["app-server", "--listen", "stdio://"]);
    command
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexProcessExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

pub struct CodexAppServerProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
}

impl CodexAppServerProcess {
    pub fn spawn(
        binary_path: &Path,
        on_stdout_line: impl Fn(String) + Send + 'static,
        on_stderr_line: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce(CodexProcessExit) + Send + 'static,
    ) -> Result<Self, String> {
        Self::spawn_observed(binary_path, on_stdout_line, || {}, on_stderr_line, on_exit)
    }

    pub(crate) fn spawn_observed(
        binary_path: &Path,
        on_stdout_line: impl Fn(String) + Send + 'static,
        on_stdout_loss: impl Fn() + Send + 'static,
        on_stderr_line: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce(CodexProcessExit) + Send + 'static,
    ) -> Result<Self, String> {
        let mut command = build_codex_app_server_command(binary_path);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start Codex App Server: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex stdin was unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex stdout was unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Codex stderr was unavailable".to_string())?;
        let child = Arc::new(Mutex::new(child));

        thread::spawn(move || {
            read_bounded_lines(
                BufReader::new(stdout),
                crate::legacy_frames::CODEX_FRAME_LIMIT,
                on_stdout_line,
                on_stdout_loss,
            );
        });
        thread::spawn(move || {
            read_bounded_lines(BufReader::new(stderr), 64 * 1024, on_stderr_line, || {});
        });

        let monitored_child = Arc::clone(&child);
        thread::spawn(move || loop {
            let status = monitored_child
                .lock()
                .expect("Codex child lock poisoned")
                .try_wait();
            match status {
                Ok(Some(status)) => {
                    on_exit(process_exit(status));
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(_) => {
                    on_exit(CodexProcessExit {
                        code: None,
                        signal: None,
                    });
                    break;
                }
            }
        });

        Ok(Self {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
        })
    }

    pub fn write_line(&self, line: &str) -> Result<(), String> {
        if line.contains(['\n', '\r']) {
            return Err("Codex JSON-RPC request must be exactly one line".into());
        }
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "Codex stdin lock poisoned".to_string())?;
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("Failed to write to Codex App Server: {error}"))
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Codex child lock poisoned".to_string())?;
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            child
                .kill()
                .map_err(|error| format!("Failed to stop Codex App Server: {error}"))?;
        }
        Ok(())
    }
}

/// Bound allocation before reading more bytes. EOF without a frame delimiter,
/// invalid UTF-8 and dropped oversized frames are evidence loss, never terminal.
fn read_bounded_lines(
    mut reader: impl BufRead,
    limit: usize,
    line: impl Fn(String),
    lost: impl Fn(),
) {
    let mut decoder = crate::legacy_frames::FrameDecoder::new(limit);
    loop {
        let available = match reader.fill_buf() {
            Ok(b) if !b.is_empty() => b,
            Ok(_) => {
                if decoder.finish().is_err() {
                    lost();
                }
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                lost();
                return;
            }
        };
        let size = available.len();
        decoder.push(available, |frame| {
            match frame.ok().and_then(|b| std::str::from_utf8(b).ok()) {
                Some(value) => {
                    let value = value.strip_suffix('\n').unwrap_or(value);
                    line(value.strip_suffix('\r').unwrap_or(value).to_owned());
                }
                None => lost(),
            }
        });
        reader.consume(size);
    }
}

fn process_exit(status: std::process::ExitStatus) -> CodexProcessExit {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        CodexProcessExit {
            code: status.code(),
            signal: status.signal().map(|signal| signal.to_string()),
        }
    }

    #[cfg(not(unix))]
    {
        CodexProcessExit {
            code: status.code(),
            signal: None,
        }
    }
}
