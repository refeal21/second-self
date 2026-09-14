//! Dedicated child and actor; its handles are absent from legacy WebView state.
use super::{
    runtime_callbacks::{ImageCapabilities, QueueSnapshot},
    store::message,
    supervisor::RuntimeWork,
    *,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri_plugin_shell::ShellExt;

pub(crate) struct QueueSupervisor {
    service: Arc<V3WorkbenchService>,
    available: Arc<AtomicBool>,
    capabilities: Arc<std::sync::Mutex<ImageCapabilities>>,
    stop: Arc<AtomicBool>,
    wake: mpsc::SyncSender<Control>,
    thread: std::sync::Mutex<Option<thread::JoinHandle<()>>>,
}
enum Control {
    Wake,
}
enum ChildEvent {
    Line(String),
    Lost,
}

impl QueueSupervisor {
    pub(crate) fn bundled<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        service: Arc<V3WorkbenchService>,
    ) -> Result<Self, String> {
        use tauri::Emitter;
        let command = app
            .shell()
            .sidecar("digital-twin-worker")
            .map_err(message)?
            .arg("--presales-runtime")
            .env_clear();
        let handle = app.clone();
        let binary = crate::codex_process::resolve_codex_binary(
            None,
            &crate::codex_process::SystemCodexBinaryProbe,
        )
        .ok();
        Self::start_with_provider(service, command.into(), binary, move |revision| {
            let _ = handle.emit("presales-queue-changed", json!({"revision":revision}));
        })
    }
    #[cfg(test)]
    pub(crate) fn start(
        service: Arc<V3WorkbenchService>,
        command: Command,
        changed: impl Fn(u64) + Send + 'static,
    ) -> Result<Self, String> {
        Self::start_with_provider(service, command, None, changed)
    }
    pub(super) fn start_with_provider(
        service: Arc<V3WorkbenchService>,
        mut command: Command,
        provider_binary: Option<std::path::PathBuf>,
        changed: impl Fn(u64) + Send + 'static,
    ) -> Result<Self, String> {
        let epoch = service.begin_queue_runtime()?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = OwnedChild(command.spawn().map_err(message)?);
        let stdin = child.0.stdin.take().ok_or("private stdin missing")?;
        let stdout = child.0.stdout.take().ok_or("private stdout missing")?;
        let stderr = child.0.stderr.take().ok_or("private stderr missing")?;
        let (events, reader) = mpsc::sync_channel(2);
        let loss = events.clone();
        thread::spawn(move || {
            crate::codex_process::read_bounded_lines(
                BufReader::new(stdout),
                72 * 1024 * 1024,
                move |line| {
                    let _ = events.send(ChildEvent::Line(line));
                },
                move || {
                    let _ = loss.send(ChildEvent::Lost);
                },
            );
        });
        thread::spawn(move || {
            crate::codex_process::read_bounded_lines(
                BufReader::new(stderr),
                16 * 1024,
                |_| {},
                || {},
            );
        });
        let (outgoing, writer) = mpsc::sync_channel::<Vec<u8>>(8);
        thread::spawn(move || {
            let mut stdin = stdin;
            while let Ok(bytes) = writer.recv() {
                if stdin.write_all(&bytes).is_err() {
                    break;
                }
            }
        });
        let (wake, controls) = mpsc::sync_channel(8);
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let available = Arc::new(AtomicBool::new(false));
        let availability = available.clone();
        let capabilities = Arc::new(std::sync::Mutex::new(ImageCapabilities::default()));
        let image_capabilities = capabilities.clone();
        let owned = service.clone();
        let thread = thread::spawn(move || {
            let mut actor = Actor {
                service: owned,
                epoch,
                generation: epoch,
                active: HashMap::new(),
                outgoing,
                available: availability,
                capabilities: image_capabilities,
                provider_binary,
                provider: None,
                sequence: 0,
                pending: HashMap::new(),
                interrupted: HashSet::new(),
                revision: AtomicU64::new(0),
                changed,
            };
            let _ = actor.send(
                json!({"id":"status","method":"presales/status","params":{"generation":epoch}}),
            );
            let _ = actor.service.retry_local_results();
            let mut stop_reason =
                "private process stopped without remote terminal evidence".to_string();
            let mut last_refresh = Instant::now();
            while !stopping.load(Ordering::Acquire) {
                if let Err(error) = actor.flush_provider() {
                    stop_reason = error;
                    break;
                }
                if actor.provider_binary.is_some()
                    && !actor.available.load(Ordering::Acquire)
                    && !actor.pending.contains_key("status")
                    && last_refresh.elapsed() > Duration::from_secs(5)
                {
                    last_refresh = Instant::now();
                    if let Err(error)=actor.send(json!({"id":"status","method":"presales/status","params":{"generation":epoch}})){stop_reason=error;break;}
                }
                while let Ok(control) = controls.try_recv() {
                    match control {
                        Control::Wake => {
                            actor.notify();
                        }
                    }
                }
                if let Err(error) = actor.flush_cancellations() {
                    stop_reason = error;
                    break;
                }
                let result = match reader.recv_timeout(Duration::from_millis(25)) {
                    Ok(ChildEvent::Line(line)) => actor.handle(&line),
                    Ok(ChildEvent::Lost) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        Err("private child evidence lost".into())
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if child.0.try_wait().map_err(message).ok().flatten().is_some() {
                            Err("private child exited without more complete frames".into())
                        } else {
                            Ok(())
                        }
                    }
                };
                if let Err(error) = result {
                    stop_reason = error;
                    break;
                }
                if actor
                    .pending
                    .values()
                    .any(|request| request.sent.elapsed() > Duration::from_secs(15))
                {
                    stop_reason =
                        "private control acknowledgement timed out; remote outcome unknown".into();
                    break;
                }
                // Reader frames already emitted by an exited child still carry
                // evidence. Drain them before disconnect; do not dispatch more.
                if child.0.try_wait().ok().flatten().is_none()
                    && actor.available.load(Ordering::Acquire)
                {
                    loop {
                        let capabilities = match actor.capabilities.lock() {
                            Ok(c) => c.clone(),
                            Err(_) => break,
                        };
                        match actor.service.claim_capable_queue_work(epoch, &capabilities) {
                            Ok(Some(work)) => {
                                actor.sequence += 1;
                                let request = json!({"id":format!("start:{}",actor.sequence),"method":"presales/start","params":{"generation":epoch,"work":match work.wire(){Ok(w)=>w,Err(_)=>break}}});
                                actor.active.insert(work.id().into(), work);
                                if actor.send(request).is_err() {
                                    stopping.store(true, Ordering::Release);
                                    break;
                                }
                                actor.notify();
                            }
                            _ => break,
                        }
                    }
                }
            }
            for work in actor.active.values() {
                let _ = actor.service.unknown_work(epoch, work, &stop_reason);
            }
            actor.available.store(false, Ordering::Release);
            if let Ok(mut capabilities) = actor.capabilities.lock() {
                *capabilities = ImageCapabilities::default();
            }
            actor.notify();
            drop(child);
        });
        Ok(Self {
            service,
            available,
            capabilities,
            stop,
            wake,
            thread: std::sync::Mutex::new(Some(thread)),
        })
    }
    pub(crate) fn snapshot(&self) -> Result<QueueSnapshot, String> {
        let mut snapshot = self.service.queue_snapshot()?;
        snapshot.dispatch_available = self.available.load(Ordering::Acquire);
        snapshot.capabilities = self
            .capabilities
            .lock()
            .map_err(|_| "capabilities lock poisoned")?
            .clone();
        Ok(snapshot)
    }
    pub(crate) fn wake(&self) {
        let _ = self.wake.try_send(Control::Wake);
    }
    pub(crate) fn interrupt(&self, _id: String) {
        // Intent is already committed by the command. Wakes may coalesce: the
        // actor polls durable intent even when this bounded channel is full.
        self.wake();
    }
    pub(crate) fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        self.wake();
        if let Ok(mut join) = self.thread.lock() {
            if let Some(thread) = join.take() {
                let _ = thread.join();
            }
        }
    }
}
impl Drop for QueueSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Actor<F: Fn(u64)> {
    service: Arc<V3WorkbenchService>,
    epoch: i64,
    generation: i64,
    active: HashMap<String, RuntimeWork>,
    outgoing: mpsc::SyncSender<Vec<u8>>,
    available: Arc<AtomicBool>,
    capabilities: Arc<std::sync::Mutex<ImageCapabilities>>,
    provider_binary: Option<std::path::PathBuf>,
    provider: Option<super::provider_process::PrivateProviderProcess>,
    sequence: u64,
    pending: HashMap<String, PendingControl>,
    interrupted: HashSet<String>,
    revision: AtomicU64,
    changed: F,
}
struct PendingControl {
    sent: Instant,
    method: String,
    work: Option<RuntimeWork>,
}
impl<F: Fn(u64)> Actor<F> {
    fn flush_provider(&mut self) -> Result<(), String> {
        for _ in 0..8 {
            let Some(event) = self.provider.as_ref().and_then(|p| p.event()) else {
                break;
            };
            match event {
                super::provider_process::ProviderEvent::Line(line)=>self.send(json!({"method":"presales/provider/line","params":{"generation":self.generation,"line":line}}))?,
                super::provider_process::ProviderEvent::Lost=>{
                    self.available.store(false,Ordering::Release);
                    *self.capabilities.lock().map_err(|_|"capabilities lock poisoned")?=ImageCapabilities::default();
                    self.send(json!({"method":"presales/provider/lost","params":{"generation":self.generation}}))?;
                    self.provider=None;self.notify();break;
                }
            }
        }
        Ok(())
    }
    fn notify(&self) {
        (self.changed)(self.revision.fetch_add(1, Ordering::Relaxed) + 1);
    }
    fn send(&mut self, message: Value) -> Result<(), String> {
        if self.try_send(message)? {
            Ok(())
        } else {
            Err("private stdin backpressured".into())
        }
    }
    fn flush_cancellations(&mut self) -> Result<(), String> {
        self.interrupted.retain(|id| self.active.contains_key(id));
        let candidates: Vec<_> = self
            .active
            .values()
            .filter(|work| !self.interrupted.contains(work.id()))
            .cloned()
            .collect();
        for work in candidates {
            if self.service.cancellation_pending(self.epoch, &work)? {
                let id = work.id();
                if self.try_send(json!({"id":format!("interrupt:{id}"),"method":"presales/interrupt","params":{"generation":self.generation,"requestId":id}}))? {
                    self.interrupted.insert(id.into());
                }
                // Full stdin is retried from durable intent on the next actor
                // tick; disconnect is an explicit transport failure, not loss.
            }
        }
        Ok(())
    }
    fn try_send(&mut self, message: Value) -> Result<bool, String> {
        let pending_id = message["method"]
            .as_str()
            .and_then(|_| message["id"].as_str())
            .map(str::to_owned);
        if pending_id
            .as_ref()
            .is_some_and(|id| self.pending.contains_key(id) || self.pending.len() >= 32)
        {
            return Err("private control request capacity exceeded".into());
        }
        let mut bytes = serde_json::to_vec(&message).map_err(message_error)?;
        let limit = if message["method"] == "presales/provider/line" {
            72
        } else {
            9
        } * 1024
            * 1024;
        if bytes.len() > limit {
            return Err("private native frame exceeds limit".into());
        }
        bytes.push(b'\n');
        match self.outgoing.try_send(bytes) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => return Ok(false),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                return Err("private stdin disconnected; cancellation delivery is uncertain".into())
            }
        }
        if let Some(id) = pending_id {
            let work_id = message["params"]["requestId"]
                .as_str()
                .or_else(|| message["params"]["work"]["job"]["requestId"].as_str());
            self.pending.insert(
                id,
                PendingControl {
                    sent: Instant::now(),
                    method: message["method"].as_str().unwrap().into(),
                    work: work_id.and_then(|id| self.active.get(id).cloned()),
                },
            );
        }
        Ok(true)
    }
    fn handle(&mut self, line: &str) -> Result<(), String> {
        let message: Value = serde_json::from_str(line).map_err(message_error)?;
        if message["method"].is_null() {
            let id = message["id"]
                .as_str()
                .ok_or("private reply identity missing")?;
            let pending = self
                .pending
                .remove(id)
                .ok_or("unknown private control reply")?;
            if pending.method == "presales/interrupt" {
                // Completion may already have been buffered before this control
                // reached the Worker. A negative ACK is local to this attempt,
                // never a reason to stop the shared child or release its slot.
                if message["error"].is_object() || message["result"]["acknowledged"] != true {
                    if let Some(work) = pending.work {
                        self.interrupted.remove(work.id());
                        self.service.unknown_work(
                            self.epoch,
                            &work,
                            "cancellation was not acknowledged; remote outcome remains unknown",
                        )?;
                    }
                    self.notify();
                }
                return Ok(());
            }
        }
        if message["id"] == "status" {
            if message["result"]["generation"] != self.generation {
                return Err("status generation mismatch".into());
            }
            self.available
                .store(message["result"]["available"] == true, Ordering::Release);
            if !message["result"]["capabilities"].is_null() {
                *self
                    .capabilities
                    .lock()
                    .map_err(|_| "capabilities lock poisoned")? =
                    serde_json::from_value(message["result"]["capabilities"].clone())
                        .map_err(message_error)?;
            } else if self.provider_binary.is_none() {
                *self
                    .capabilities
                    .lock()
                    .map_err(|_| "capabilities lock poisoned")? = ImageCapabilities {
                    generation: true,
                    reference_editing: true,
                    reason: None,
                };
            }
            self.notify();
            return Ok(());
        }
        let Some(method) = message["method"].as_str() else {
            // Start acknowledgement and interrupt acknowledgement are transport
            // evidence only. Neither can release a remote uncertainty slot.
            if message["error"].is_object() {
                return Err("private request was rejected".into());
            }
            return Ok(());
        };
        let params = &message["params"];
        if params["generation"] != self.generation {
            return Err("old private process generation".into());
        }
        if method == "presales/capabilities" {
            self.available
                .store(params["available"] == true, Ordering::Release);
            *self
                .capabilities
                .lock()
                .map_err(|_| "capabilities lock poisoned")? =
                serde_json::from_value(params["capabilities"].clone()).map_err(message_error)?;
            self.notify();
            return Ok(());
        }
        if method == "native/provider/start" || method == "native/provider/send" {
            if !message["id"]
                .as_str()
                .is_some_and(|s| s.starts_with("native:"))
            {
                return Err("invalid private provider request identity".into());
            }
            let result = (|| -> Result<Value, String> {
                if method == "native/provider/start" {
                    if self.provider.is_none() {
                        self.provider =
                            Some(super::provider_process::PrivateProviderProcess::start(
                                self.provider_binary
                                    .as_deref()
                                    .ok_or("dedicated Codex binary unavailable")?,
                                &self.service.root,
                            )?);
                    }
                    Ok(json!({"cwd":self.service.root}))
                } else {
                    self.provider
                        .as_ref()
                        .ok_or("dedicated Codex child unavailable")?
                        .send(
                            params["line"]
                                .as_str()
                                .ok_or("provider line missing")?
                                .into(),
                        )?;
                    Ok(json!({"sent":true}))
                }
            })();
            self.send(match result{Ok(value)=>json!({"id":message["id"],"result":value}),Err(_)=>json!({"id":message["id"],"error":{"message":"Private Codex transport unavailable"}})})?;
            return Ok(());
        }
        if method == "presales/progress" {
            self.notify();
            return Ok(());
        }
        let id = params["work"]["job"]["requestId"]
            .as_str()
            .ok_or("private attempt missing")?;
        let work = self
            .active
            .get(id)
            .ok_or("unknown private attempt")?
            .clone();
        if work.wire()? != params["work"] {
            return Err("private attempt target mismatch".into());
        }
        match method {
            "native/provider/inputs" => {
                if !message["id"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("native:"))
                {
                    return Err("invalid provider input request identity".into());
                }
                let result = self
                    .service
                    .resolve_provider_inputs(&work)
                    .and_then(|v| serde_json::to_value(v).map_err(message_error));
                self.send(match result{Ok(value)=>json!({"id":message["id"],"result":value}),Err(_)=>json!({"id":message["id"],"error":{"message":"Native input verification failed"}})})?;
            }
            "presales/terminal" => {
                let provider =
                    serde_json::from_value(params["provider"].clone()).map_err(message_error)?;
                self.service
                    .terminal_work(self.epoch, &work, provider, &params["result"])?;
                self.active.remove(id);
                self.notify();
            }
            "native/identity" => {
                if !message["id"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("native:"))
                {
                    return Err("invalid native callback identity".into());
                }
                let result = serde_json::from_value(params["identity"].clone())
                    .map_err(message_error)
                    .and_then(|identity| {
                        self.service.provider_identity(self.epoch, &work, identity)
                    });
                let reply = match result {
                    Ok(()) => json!({"id":message["id"],"result":{"persisted":true}}),
                    Err(error) => json!({"id":message["id"],"error":{"message":error}}),
                };
                self.send(reply)?;
                self.notify();
            }
            "presales/result" => {
                let provider =
                    serde_json::from_value(params["provider"].clone()).map_err(message_error)?;
                if let Err(error) =
                    self.service
                        .complete_work(self.epoch, &work, provider, &params["result"])
                {
                    self.service.unknown_work(self.epoch, &work, &error)?;
                }
                self.active.remove(id);
                self.notify();
            }
            "presales/unknown" => {
                let reason = params["reason"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 4096)
                    .ok_or("invalid outcome evidence")?;
                self.service.unknown_work(self.epoch, &work, reason)?;
                self.active.remove(id);
                self.notify();
            }
            _ => return Err("unknown private event".into()),
        }
        Ok(())
    }
}
fn message_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(test)]
#[path = "runtime_control_tests.rs"]
mod control_tests;

#[cfg(test)]
mod frame_tests {
    use std::{
        cell::{Cell, RefCell},
        io::{BufReader, Cursor},
    };
    #[test]
    fn native_private_frames_preserve_fragmented_utf8_and_bound_oversized_lines() {
        let lines = RefCell::new(Vec::new());
        let lost = Cell::new(0);
        crate::codex_process::read_bounded_lines(
            BufReader::with_capacity(1, Cursor::new("中文\n123456789\nok\n")),
            8,
            |s| lines.borrow_mut().push(s),
            || lost.set(lost.get() + 1),
        );
        assert_eq!(*lines.borrow(), vec!["中文", "ok"]);
        assert_eq!(lost.get(), 1);
    }
}
