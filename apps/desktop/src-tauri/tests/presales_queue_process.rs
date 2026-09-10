#![cfg(feature = "acceptance-harness")]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TIMEOUT: Duration = Duration::from_secs(15);
static DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "queue-process-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn database(&self) -> PathBuf {
        self.0.join("queue.sqlite3")
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// The guard owns exactly one spawned child. A watchdog also bounds blocked writes;
// Drop kills/reaps that child and joins both threads, including during unwinding.
struct Harness {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    responses: mpsc::Receiver<Value>,
    stop: Option<mpsc::Sender<()>>,
    watchdog: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    next_id: usize,
}
impl Harness {
    fn spawn(database: &Path) -> Self {
        Self::with_args(&[std::ffi::OsStr::new("--database"), database.as_os_str()])
    }
    fn with_args(args: &[&std::ffi::OsStr]) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_queue-harness"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut harness = Self {
            child: Arc::new(Mutex::new(child)),
            stdin: None,
            responses: mpsc::channel().1,
            stop: None,
            watchdog: None,
            reader: None,
            next_id: 0,
        };
        let (stop, signal) = mpsc::channel();
        harness.stop = Some(stop);
        let owned = Arc::clone(&harness.child);
        harness.watchdog = Some(thread::spawn(move || {
            if signal.recv_timeout(TIMEOUT).is_err() {
                let mut child = owned.lock().unwrap_or_else(|e| e.into_inner());
                let _ = child.kill();
                let _ = child.wait();
            }
        }));
        let stdout = {
            let mut child = harness.child.lock().unwrap();
            harness.stdin = child.stdin.take();
            child.stdout.take().unwrap()
        };
        let (sender, responses) = mpsc::sync_channel(32);
        harness.responses = responses;
        harness.reader = Some(thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                // Bound child output as well as the response wait. A broken
                // harness cannot make the test allocate an unlimited line.
                let count = reader
                    .by_ref()
                    .take(2_097_153)
                    .read_until(b'\n', &mut bytes)
                    .unwrap();
                if count == 0 {
                    break;
                }
                assert!(count <= 2_097_152 && bytes.last() == Some(&b'\n'));
                if sender
                    .try_send(serde_json::from_slice(&bytes).unwrap())
                    .is_err()
                {
                    break;
                }
            }
        }));
        harness
    }
    fn write(&mut self, bytes: &[u8]) {
        self.stdin.as_mut().unwrap().write_all(bytes).unwrap();
        self.stdin.as_mut().unwrap().flush().unwrap();
    }
    fn receive(&self) -> Value {
        self.responses
            .recv_timeout(TIMEOUT)
            .expect("bounded harness response")
    }
    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = format!("native:test-{}", self.next_id);
        self.write(
            format!(
                "{}\n",
                json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
            )
            .as_bytes(),
        );
        let response = self.receive();
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], id);
        response
    }
    fn ok(&mut self, method: &str, params: Value) -> Value {
        let response = self.call(method, params);
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }
    fn wait(&mut self) -> ExitStatus {
        self.stdin.take();
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(status) = self.child.lock().unwrap().try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "child did not exit");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn close_and_wait(&mut self) {
        self.ok("harness.close", json!({}));
        assert!(self.wait().success());
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.stdin.take();
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        {
            let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(thread) = self.watchdog.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.reader.take() {
            let _ = thread.join();
        }
    }
}

fn input(n: usize, project: &str, slide: &str) -> Value {
    let version = json!({"version":"v1", "sha256":"a".repeat(64)});
    json!({"input":{"batchId":format!("b{n}"), "jobs":[{
        "requestId":format!("r{n}"), "attemptId":format!("a{n}"), "target":{
            "projectId":project, "slideId":slide, "spec":version, "design":version,
            "skill":version, "palette":version, "parentVisual":null, "references":[],
            "promptVersion":"v1", "prompt":"Synthetic only", "feedback":"Original feedback\n保留原文"}}]}})
}
fn evidence(epoch: i64) -> Value {
    json!({"epoch":epoch,"requestId":"r1","attemptId":"a1"})
}
fn manifest() -> Value {
    json!({"relativePath":"queue-results/r1/a1.png","sha256":"d".repeat(64),"byteLength":42})
}

#[test]
fn actual_restart_retains_cancel_provider_snapshot_and_requires_resolution() {
    let dir = TestDirectory::new();
    let db = dir.database();
    let mut first = Harness::spawn(&db);
    first.ok("native.queue.enqueue", input(1, "project-1", "page"));
    first.ok("native.queue.enqueue", input(2, "project-2", "page"));
    first.ok("native.queue.setConcurrency", json!({"value":1}));
    let epoch = first.ok("native.queue.beginRuntime", json!({}))["settings"]["epoch"]
        .as_i64()
        .unwrap();
    assert_eq!(
        first.ok("native.queue.claim", json!({"epoch":epoch}))["requestId"],
        "r1"
    );
    for turn in [Value::Null, json!("turn-1")] {
        let mut params = evidence(epoch);
        params["identity"] = json!({"threadId":"thread-1", "turnId":turn});
        first.ok("native.queue.provider", params);
    }
    first.ok("native.queue.cancel", json!({"requestId":"r1"}));
    assert!(first
        .ok("native.queue.claim", json!({"epoch":epoch}))
        .is_null());
    let before = first.ok("native.queue.snapshot", json!({}));
    let mut observer = Harness::spawn(&db);
    assert_eq!(observer.ok("native.queue.snapshot", json!({})), before);
    observer.close_and_wait();
    first.close_and_wait();
    let mut second = Harness::spawn(&db);
    assert_eq!(second.ok("native.queue.snapshot", json!({})), before);
    let recovered = second.ok("native.queue.beginRuntime", json!({}));
    let epoch = recovered["settings"]["epoch"].as_i64().unwrap();
    assert_eq!(recovered["jobs"].as_array().unwrap().len(), 2);
    assert_eq!(recovered["jobs"][0]["status"], "outcome_unknown");
    assert_eq!(
        recovered["jobs"][0]["provider"],
        json!({"threadId":"thread-1","turnId":"turn-1"})
    );
    assert_eq!(recovered["jobs"][0]["target"], before["jobs"][0]["target"]);
    assert_eq!(
        recovered["jobs"][0]["target"]["feedback"],
        "Original feedback\n保留原文"
    );
    assert!(second
        .ok("native.queue.claim", json!({"epoch":epoch}))
        .is_null());
    assert_eq!(
        second.call(
            "native.queue.abandon",
            json!({"requestId":"r1","acknowledgeDuplicateRisk":false})
        )["error"]["code"],
        -32000
    );
    assert!(second
        .ok("native.queue.claim", json!({"epoch":epoch}))
        .is_null());
    second.ok("native.queue.cancelled", evidence(epoch));
    assert_eq!(
        second.ok("native.queue.claim", json!({"epoch":epoch}))["requestId"],
        "r2"
    );
    second.close_and_wait();
}

#[test]
fn result_manifest_survives_restart_without_reclaim_or_publication() {
    let dir = TestDirectory::new();
    let mut first = Harness::spawn(&dir.database());
    first.ok("native.queue.enqueue", input(1, "synthetic", "page"));
    let epoch = first.ok("native.queue.beginRuntime", json!({}))["settings"]["epoch"]
        .as_i64()
        .unwrap();
    first.ok("native.queue.claim", json!({"epoch":epoch}));
    let mut params = evidence(epoch);
    params["result"] = manifest();
    let ready = first.ok("native.queue.result", params);
    first.close_and_wait();
    let mut second = Harness::spawn(&dir.database());
    let snapshot = second.ok("native.queue.beginRuntime", json!({}));
    assert_eq!(snapshot["jobs"], json!([ready]));
    assert_eq!(snapshot["jobs"][0]["status"], "result_ready");
    assert_eq!(snapshot["jobs"][0]["result"], manifest());
    assert!(second
        .ok(
            "native.queue.claim",
            json!({"epoch":snapshot["settings"]["epoch"]})
        )
        .is_null());
    assert_eq!(
        second.ok("native.queue.enqueue", input(2, "synthetic", "page"))["reusedRequestIds"],
        json!(["r1"])
    );
    for forbidden in ["succeeded", "committing", "candidate", "approval", "sql"] {
        assert_eq!(
            second.call(&format!("native.queue.{forbidden}"), json!({}))["error"]["code"],
            -32601
        );
    }
    second.close_and_wait();
    let connection = rusqlite::Connection::open(dir.database()).unwrap();
    let fabricated: i64 = connection.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND (name LIKE '%candidate%' OR name LIKE '%approval%')", [], |row| row.get(0)).unwrap();
    assert_eq!(fabricated, 0);
    assert!(!dir.0.join("queue-results").exists());
}

#[test]
fn strict_envelopes_params_and_error_recovery() {
    let dir = TestDirectory::new();
    let mut h = Harness::spawn(&dir.database());
    h.write(b"{bad-json\n");
    assert_eq!(
        h.receive(),
        json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})
    );
    let good =
        json!({"jsonrpc":"2.0","id":"native:valid","method":"native.queue.settings","params":{}});
    for id in [
        json!(3),
        Value::Null,
        json!("ui:1"),
        json!(""),
        json!("native:"),
        json!("native:   "),
        json!(format!("native:{}", "中".repeat(41))),
    ] {
        let mut request = good.clone();
        request["id"] = id;
        h.write(format!("{request}\n").as_bytes());
        let response = h.receive();
        assert_eq!(response["error"]["code"], -32600);
        assert!(response["id"].is_null());
    }
    for (field, value) in [
        ("jsonrpc", json!("1.0")),
        ("method", json!(2)),
        ("extra", json!("secret")),
        ("params", json!([])),
        ("params", Value::Null),
    ] {
        let mut request = good.clone();
        request[field] = value;
        h.write(format!("{request}\n").as_bytes());
        assert_eq!(h.receive()["error"]["code"], -32600);
    }
    for field in ["id", "params", "method", "jsonrpc"] {
        let mut request = good.clone();
        request.as_object_mut().unwrap().remove(field);
        h.write(format!("{request}\n").as_bytes());
        assert_eq!(h.receive()["error"]["code"], -32600);
    }
    for (method, params) in [
        ("native.queue.settings", json!({"sql":"secret"})),
        ("native.queue.setConcurrency", json!({"value":256})),
        ("native.queue.setPaused", json!({"paused":"yes"})),
        ("native.queue.claim", json!({})),
        ("harness.close", json!({"extra":true})),
    ] {
        assert_eq!(h.call(method, params)["error"]["code"], -32602);
    }
    let mut nested = input(1, "synthetic", "page");
    nested["input"]["jobs"][0]["target"]["extra"] = json!(true);
    assert_eq!(
        h.call("native.queue.enqueue", nested)["error"]["code"],
        -32602
    );
    assert_eq!(h.call("queue.settings", json!({}))["error"]["code"], -32601);
    assert_eq!(
        h.call("native.queue.setConcurrency", json!({"value":0}))["error"]["code"],
        -32000
    );
    assert_eq!(
        h.ok("native.queue.settings", json!({})),
        json!({"concurrency":4,"paused":false,"epoch":0})
    );
    h.close_and_wait();
}

#[test]
fn fragmented_utf8_coalesced_lines_and_oversized_line_recover() {
    let dir = TestDirectory::new();
    let mut h = Harness::spawn(&dir.database());
    let request = format!(
        "{}\n",
        json!({"jsonrpc":"2.0","id":"native:fragment","method":"native.queue.enqueue","params":input(1,"synthetic","page")})
    );
    let split = request.find('保').unwrap() + 1;
    h.write(&request.as_bytes()[..split]);
    assert!(matches!(
        h.responses.recv_timeout(Duration::from_millis(30)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    h.write(&request.as_bytes()[split..]);
    assert_eq!(
        h.receive()["result"]["jobs"][0]["target"]["feedback"],
        "Original feedback\n保留原文"
    );
    let settings = json!({"jsonrpc":"2.0","id":"native:coalesced","method":"native.queue.settings","params":{}}).to_string();
    let mut next: Value = serde_json::from_str(&settings).unwrap();
    next["id"] = json!("native:next");
    h.write(format!("{settings}\n{next}\n").as_bytes());
    assert_eq!(h.receive()["id"], "native:coalesced");
    assert_eq!(h.receive()["id"], "native:next");
    // Exactly the maximum is accepted, the next byte crosses the boundary.
    let exact = format!("{}{}\n", settings, " ".repeat(262144 - settings.len()));
    h.write(exact.as_bytes());
    assert!(h.receive().get("result").is_some());
    h.write(&vec![b'x'; 262145]);
    h.write(format!("\n{settings}\n").as_bytes());
    let rejected = h.receive();
    assert_eq!(rejected["error"]["code"], -32600);
    assert!(rejected["id"].is_null());
    assert!(h.receive().get("result").is_some());
    h.write(b"\xff\n");
    assert_eq!(h.receive()["error"]["code"], -32700);
    assert_eq!(h.ok("native.queue.settings", json!({}))["epoch"], 0);
    h.close_and_wait();
}

#[test]
fn remaining_typed_controls_and_late_evidence_reach_the_store() {
    let dir = TestDirectory::new();
    let mut h = Harness::spawn(&dir.database());
    h.ok("native.queue.enqueue", input(1, "synthetic", "page"));
    let epoch = h.ok("native.queue.beginRuntime", json!({}))["settings"]["epoch"]
        .as_i64()
        .unwrap();
    h.ok("native.queue.setPaused", json!({"paused":true}));
    assert!(h.ok("native.queue.claim", json!({"epoch":epoch})).is_null());
    h.ok("native.queue.setPaused", json!({"paused":false}));
    h.ok(
        "native.queue.setBatchPaused",
        json!({"batchId":"b1","paused":true}),
    );
    assert!(h.ok("native.queue.claim", json!({"epoch":epoch})).is_null());
    h.ok(
        "native.queue.setBatchPaused",
        json!({"batchId":"b1","paused":false}),
    );
    h.ok("native.queue.claim", json!({"epoch":epoch}));
    let mut unknown = evidence(epoch);
    unknown["reason"] = json!("synthetic timeout");
    assert_eq!(
        h.ok("native.queue.unknown", unknown)["status"],
        "outcome_unknown"
    );
    assert_eq!(
        h.ok(
            "native.queue.abandon",
            json!({"requestId":"r1","acknowledgeDuplicateRisk":true})
        )["status"],
        "abandoned_unresolved"
    );
    h.ok(
        "native.queue.lateResult",
        json!({"requestId":"r1","attemptId":"a1","result":manifest()}),
    );
    let events = h.ok("native.queue.events", json!({"requestId":"r1"}));
    assert!(events
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["kind"] == "late_result"));
    h.ok("native.queue.enqueue", input(2, "synthetic", "page"));
    h.ok("native.queue.claim", json!({"epoch":epoch}));
    assert_eq!(
        h.ok(
            "native.queue.failed",
            json!({"epoch":epoch,"requestId":"r2","attemptId":"a2","error":"synthetic failure"})
        )["status"],
        "failed"
    );
    h.close_and_wait();
}

#[test]
fn foreign_database_and_missing_explicit_path_fail_without_mutation() {
    let dir = TestDirectory::new();
    let db = dir.database();
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection.execute_batch("CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES('synthetic only'); PRAGMA user_version=99;").unwrap();
    drop(connection);
    let before = std::fs::read(&db).unwrap();
    let mut h = Harness::spawn(&db);
    assert!(!h.wait().success());
    assert_eq!(std::fs::read(&db).unwrap(), before);
    assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
    let mut missing = Harness::with_args(&[]);
    assert!(!missing.wait().success());
}

#[test]
fn owned_child_is_reaped_when_test_unwinds() {
    let dir = TestDirectory::new();
    let harness = Harness::spawn(&dir.database());
    let owned = Arc::clone(&harness.child);
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _guard = harness;
        panic!("synthetic test failure");
    }));
    assert!(unwind.is_err());
    assert!(owned.lock().unwrap().try_wait().unwrap().is_some());
}

#[test]
fn shared_dispatcher_has_no_harness_close_or_oversized_escape() {
    use digital_twin_desktop_lib::presales_queue::{handle_queue_rpc_line, QueueStore};
    let mut store = QueueStore::open_in_memory().unwrap();
    let close = json!({"jsonrpc":"2.0","id":"native:close","method":"harness.close","params":{}});
    let response: Value =
        serde_json::from_str(&handle_queue_rpc_line(&mut store, &close.to_string())).unwrap();
    assert_eq!(response["error"]["code"], -32601);
    let huge = " ".repeat(262145);
    let response: Value = serde_json::from_str(&handle_queue_rpc_line(&mut store, &huge)).unwrap();
    assert_eq!(response["error"]["code"], -32600);
}
