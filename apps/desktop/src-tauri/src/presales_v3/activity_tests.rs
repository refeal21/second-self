use super::activity::{LegacyActivityTracker, NativeSource, Transport};
use super::V3Store;
use serde_json::{json, Value};
use std::path::PathBuf;

fn tracker() -> LegacyActivityTracker {
    LegacyActivityTracker::new(V3Store::open_in_memory().unwrap()).unwrap()
}
fn source(id: &str) -> NativeSource {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    let root = ROOT.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("activity-tests-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::canonicalize(root).unwrap()
    });
    NativeSource::new(root.join("workbench.sqlite3"), id.into(), root.join(id))
}
fn send(t: &LegacyActivityTracker, p: &super::activity::ProcessKey, v: Value) {
    t.send(p, &v.to_string(), |_| None, || Ok(())).unwrap();
}
fn child(t: &LegacyActivityTracker, p: &super::activity::ProcessKey, v: Value) {
    t.observe_line(p, v.to_string().as_bytes()).unwrap();
}
fn thread(t: &LegacyActivityTracker, p: &super::activity::ProcessKey) {
    send(
        t,
        p,
        json!({"id":1,"method":"thread/start","params":{"cwd":source("a").root}}),
    );
    child(
        t,
        p,
        json!({"id":1,"result":{"thread":{"id":"th","cwd":source("a").root}}}),
    );
}
fn start(t: &LegacyActivityTracker, p: &super::activity::ProcessKey, id: Value) {
    send(
        t,
        p,
        json!({"id":id,"method":"turn/start","params":{"threadId":"th","input":[{"type":"text","text":"中文 prompt"}]}}),
    );
}
fn terminal(t: &LegacyActivityTracker, p: &super::activity::ProcessKey, turn: &str) {
    child(
        t,
        p,
        json!({"method":"turn/completed","params":{"threadId":"th","turn":{"id":turn,"status":"completed"}}}),
    );
}

#[test]
fn ordinary_reads_and_idle_threads_do_not_poison_copy() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    for (i, m) in [
        "initialize",
        "account/read",
        "account/login/start",
        "modelProvider/capabilities/read",
    ]
    .iter()
    .enumerate()
    {
        send(&t, &p, json!({"id":i,"method":m,"params":{}}));
    }
    send(&t, &p, json!({"method":"initialized"}));
    assert!(t.try_source_guard(&source("a")).is_ok());
    thread(&t, &p);
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn ack_interrupt_and_wrong_identity_never_prove_terminal() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    child(&t, &p, json!({"id":"2","result":{"turn":{"id":"wrong"}}}));
    child(&t, &p, json!({"id":2,"result":{"turn":{"id":"turn"}}}));
    send(
        &t,
        &p,
        json!({"id":3,"method":"turn/interrupt","params":{"threadId":"th","turnId":"turn"}}),
    );
    child(&t, &p, json!({"id":3,"result":{}}));
    terminal(&t, &p, "other");
    assert!(t.try_source_guard(&source("a")).is_err());
    assert!(t.try_source_guard(&source("b")).is_ok());
    terminal(&t, &p, "turn");
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn early_terminal_only_settles_the_acknowledged_turn() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    start(&t, &p, json!(3));
    terminal(&t, &p, "first");
    child(&t, &p, json!({"id":2,"result":{"turn":{"id":"first"}}}));
    assert!(t.try_source_guard(&source("a")).is_err());
    child(&t, &p, json!({"id":3,"result":{"turn":{"id":"second"}}}));
    terminal(&t, &p, "second");
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn local_worker_response_settles_only_exact_request_and_nested_restore_scope() {
    let t = tracker();
    let p = t.process_key(Transport::Worker, 1);
    t.send(&p,&json!({"id":1,"method":"ppt.project.restore","params":{"pipeline":{"project":{"id":"a"}}}}).to_string(), |id| (id=="a").then(||source("a")),||Ok(())).unwrap();
    assert!(t.try_source_guard(&source("a")).is_err());
    assert!(t.try_source_guard(&source("b")).is_ok());
    child(&t, &p, json!({"id":"1","result":{}}));
    assert!(t.try_source_guard(&source("a")).is_err());
    child(&t, &p, json!({"id":1,"result":{}}));
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn write_attempt_failure_retains_remote_uncertainty_duplicate_is_not_written() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    let line = json!({"id":2,"method":"turn/start","params":{"threadId":"th"}}).to_string();
    assert!(t
        .send(&p, &line, |_| None, || Err("partial write".into()))
        .is_err());
    assert!(t
        .send(&p, &line, |_| None, || panic!("duplicate must not write"))
        .is_err());
    assert!(t.try_source_guard(&source("a")).is_err());
    assert!(t
        .send(&p, "{}\n{}", |_| None, || panic!("framing must not write"))
        .is_err());
}

#[test]
fn retired_generation_terminal_cannot_clear_new_generation() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    child(&t, &p, json!({"id":2,"result":{"turn":{"id":"turn"}}}));
    t.transport_lost(&p, "remote_terminal_missing").unwrap();
    let newer = t.process_key(Transport::Codex, 2);
    thread(&t, &newer);
    start(&t, &newer, json!(2));
    child(&t, &newer, json!({"id":2,"result":{"turn":{"id":"turn"}}}));
    terminal(&t, &p, "turn");
    assert!(t.try_source_guard(&source("a")).is_err());
    terminal(&t, &newer, "turn");
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn unknown_raw_requests_allow_legacy_dispatch_but_block_copy_after_success() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    send(&t, &p, json!({"id":1,"method":"command/exec","params":{}}));
    child(&t, &p, json!({"id":1,"result":{}}));
    send(&t, &p, json!({"id":2,"method":"account/read"}));
    assert!(t.try_source_guard(&source("a")).is_err());
}

#[test]
fn exact_resume_history_recovers_only_linked_unknown_turn() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    child(&t, &p, json!({"id":2,"result":{"turn":{"id":"turn"}}}));
    t.transport_lost(&p, "remote_terminal_missing").unwrap();
    let q = t.process_key(Transport::Codex, 2);
    send(
        &t,
        &q,
        json!({"id":1,"method":"thread/resume","params":{"threadId":"th"}}),
    );
    child(
        &t,
        &q,
        json!({"id":1,"result":{"thread":{"id":"th","cwd":source("a").root,"status":{"type":"idle"},"turns":[]}}}),
    );
    assert!(t.try_source_guard(&source("a")).is_err());
    send(
        &t,
        &q,
        json!({"id":2,"method":"thread/resume","params":{"threadId":"th"}}),
    );
    child(
        &t,
        &q,
        json!({"id":2,"result":{"thread":{"id":"th","cwd":source("a").root,"turns":[{"id":"turn","status":"failed"}]}}}),
    );
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn durable_intent_is_committed_before_first_write_and_survives_reopen() {
    let root = std::env::temp_dir().join(format!("activity-durable-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("v3.sqlite3");
    let t = LegacyActivityTracker::new(V3Store::open(&path).unwrap()).unwrap();
    let p = t.process_key(Transport::Codex, 1);
    t.send(
        &p,
        &json!({"id":1,"method":"command/exec"}).to_string(),
        |_| None,
        || {
            let db = rusqlite::Connection::open(&path).unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM v3_legacy_activity", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        },
    )
    .unwrap();
    drop(t);
    let reopened = LegacyActivityTracker::new(V3Store::open(&path).unwrap()).unwrap();
    let new_key = reopened.process_key(Transport::Codex, 1);
    assert_ne!(p, new_key);
    child(&reopened, &new_key, json!({"id":1,"result":{}}));
    assert!(reopened.try_source_guard(&source("a")).is_err());
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn capture_guard_fences_new_bytes_and_releases_without_frontend_save() {
    use std::{
        sync::{mpsc, Arc},
        time::Duration,
    };
    let t = Arc::new(tracker());
    let p = t.process_key(Transport::Worker, 1);
    let guard = t.try_source_guard(&source("a")).unwrap();
    let before = guard.epoch();
    let (tx, rx) = mpsc::channel();
    let other = t.clone();
    let join = std::thread::spawn(move || {
        other
            .send(
                &p,
                &json!({"id":1,"method":"ppt.project.execute","params":{"projectId":"a"}})
                    .to_string(),
                |_| Some(source("a")),
                || {
                    tx.send(()).unwrap();
                    Ok(())
                },
            )
            .unwrap();
        child(&other, &p, json!({"id":1,"result":{}}));
    });
    assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
    drop(guard);
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    join.join().unwrap();
    assert!(t.try_source_guard(&source("a")).unwrap().epoch() > before);
}

#[test]
fn split_utf8_frames_and_multiple_messages_use_exact_child_bytes() {
    let t = tracker();
    let p = t.process_key(Transport::Worker, 1);
    send(&t, &p, json!({"id":1,"method":"ppt.project.execute"}));
    let bytes = "{\"id\":1,\"result\":\"中文\"}\n{\"id\":2,\"result\":{}}\n".as_bytes();
    for byte in bytes {
        t.observe_bytes(&p, &[*byte]).unwrap();
    }
    assert!(t.try_source_guard(&source("a")).is_ok());
    let remote = t.process_key(Transport::Codex, 1);
    t.observe_bytes(&remote, b"{\"partial\":").unwrap();
    t.transport_lost(&remote, "remote_terminal_missing")
        .unwrap();
    assert!(t.try_source_guard(&source("a")).is_err());
}

#[test]
fn outgoing_spoofed_result_is_not_child_evidence() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    assert!(t
        .send(
            &p,
            &json!({"id":2,"result":{"turn":{"id":"turn","status":"completed"}}}).to_string(),
            |_| None,
            || Ok(())
        )
        .is_err());
    assert!(t.try_source_guard(&source("a")).is_err());
}

#[test]
fn native_source_write_entry_shares_capture_lock_and_uses_checked_identity() {
    use crate::workbench::{AttachSourceInput, CreateProjectInput, WorkbenchService};
    use std::{
        sync::{mpsc, Arc},
        time::Duration,
    };
    let root = std::env::temp_dir().join(format!("activity-native-{}", uuid::Uuid::new_v4()));
    let service = Arc::new(
        WorkbenchService::open(root.join("workbench.sqlite3"), root.join("workspace")).unwrap(),
    );
    let id = service
        .create_project(CreateProjectInput {
            name: "synthetic".into(),
            goal: "synthetic".into(),
        })
        .unwrap()
        .id;
    assert!(service.native_source("../outside").is_err());
    let identity = service.native_source(&id).unwrap();
    let guard = service.activity().try_source_guard(&identity).unwrap();
    let (tx, rx) = mpsc::channel();
    let other = service.clone();
    let project = id.clone();
    let join = std::thread::spawn(move || {
        let result = other.attach_source(AttachSourceInput {
            project_id: project,
            file_name: "synthetic.txt".into(),
            media_type: "text/plain".into(),
            contents_base64: "aGVsbG8=".into(),
        });
        tx.send(result).unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
    assert_eq!(
        std::fs::read_dir(identity.root.join("sources"))
            .unwrap()
            .count(),
        0
    );
    drop(guard);
    rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    join.join().unwrap();
    assert_eq!(
        service.load_pipeline(&id).unwrap()["sources"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(service);
    std::fs::remove_dir_all(root).unwrap();
}

fn visual(id: &str, kind: &str) -> crate::visual_style::VisualGenerationRecord {
    serde_json::from_value(json!({"id":id,"projectId":"a","slideId":"slide","expectedRevision":1,"styleRevision":0,"kind":kind,"prompt":"中文 prompt","feedback":"","promptVersion":"test","createdAt":"2026-09-11T00:00:00Z","promptSha256":crate::visual_style::hash("中文 prompt".as_bytes()),"specSha256":"a".repeat(64),"style":{"revision":0,"profile":null,"locked":false},"receipt":null})).unwrap()
}

#[test]
fn new_visual_coverage_distinguishes_predispatch_failure_from_historical_unknown() {
    let t = tracker();
    let record = visual("request", "imagegen");
    let guard = t.try_source_guard(&source("a")).unwrap();
    assert!(guard
        .check_visual_records(&source("a"), &[record.clone()])
        .is_err());
    assert!(guard
        .check_visual_records(&source("a"), &[visual("upload", "upload")])
        .is_ok());
    drop(guard);
    t.mutation_guard()
        .unwrap()
        .cover_visual(source("a"), &record)
        .unwrap();
    assert!(t
        .try_source_guard(&source("a"))
        .unwrap()
        .check_visual_records(&source("a"), &[record.clone()])
        .is_ok());
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    child(&t, &p, json!({"id":2,"result":{"turn":{"id":"turn"}}}));
    assert!(t.try_source_guard(&source("a")).is_err());
    terminal(&t, &p, "turn");
    let guard = t.try_source_guard(&source("a")).unwrap();
    assert!(guard.check_visual_records(&source("a"), &[record]).is_ok());
    assert!(guard
        .check_visual_records(&source("a"), &[visual("historical", "imagegen")])
        .is_err());
}

#[cfg(unix)]
#[test]
fn actual_fake_child_terminal_is_observed_and_incomplete_output_is_unknown() {
    use std::{
        os::unix::fs::PermissionsExt,
        sync::{mpsc, Arc},
        time::Duration,
    };
    let root = std::env::temp_dir().join(format!("activity-child-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("fake-child");
    std::fs::write(&path,b"#!/bin/sh\nIFS= read -r request\nprintf '%s\\n' '{\"id\":2,\"result\":{\"turn\":{\"id\":\"turn\"}}}' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"th\",\"turn\":{\"id\":\"turn\",\"status\":\"completed\"}}}'\nprintf '{\"truncated\":'\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let t = Arc::new(tracker());
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    let (tx, rx) = mpsc::channel();
    let (lost_tx, lost_rx) = mpsc::channel();
    let observed = t.clone();
    let op = p.clone();
    let lost = t.clone();
    let lp = p.clone();
    let child = crate::codex_process::CodexAppServerProcess::spawn_observed(
        &path,
        move |line| {
            observed.observe_line(&op, line.as_bytes()).unwrap();
            tx.send(()).unwrap();
        },
        move || {
            lost.evidence_lost(&lp).unwrap();
            lost_tx.send(()).unwrap();
        },
        |_| {},
        |_| {},
    )
    .unwrap();
    let request = json!({"id":2,"method":"turn/start","params":{"threadId":"th"}}).to_string();
    t.send(&p, &request, |_| None, || child.write_line(&request))
        .unwrap();
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    lost_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(t.try_source_guard(&source("a")).is_err());
    child.stop().unwrap();
    drop(child);
    drop(t);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn unobserved_resume_is_unknown_even_when_history_is_omitted_and_thread_is_idle() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    send(
        &t,
        &p,
        json!({"id":1,"method":"thread/resume","params":{"threadId":"unobserved"}}),
    );
    child(
        &t,
        &p,
        json!({"id":1,"result":{"thread":{"id":"unobserved","cwd":source("a").root,"status":{"type":"idle"}}}}),
    );
    assert!(t.try_source_guard(&source("a")).is_err());
}

#[test]
fn pending_local_work_blocks_until_confirmed_death_not_stop_intent() {
    let t = tracker();
    let p = t.process_key(Transport::Worker, 1);
    send(&t, &p, json!({"id":1,"method":"ppt.project.execute"}));
    t.transport_retiring(&p).unwrap();
    assert!(t.try_source_guard(&source("a")).is_err());
    t.transport_lost(&p, "remote_terminal_missing").unwrap();
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn large_worker_artifact_reply_settles_and_forwarding_preserves_chinese_utf8() {
    let t = tracker();
    let p = t.process_key(Transport::Worker, 1);
    send(&t, &p, json!({"id":1,"method":"ppt.project.execute"}));
    // A 64 MiB PPTX encoded as base64, within the native QA artifact limit.
    let encoded = (64 * 1024 * 1024_usize).div_ceil(3) * 4;
    let head=b"{\"id\":1,\"result\":{\"writes\":[{\"relativePath\":\"exports/synthetic.pptx\",\"contentsBase64\":\"";
    t.observe_bytes(&p, head).unwrap();
    let chunk = vec![b'A'; 8192];
    let mut left = encoded;
    while left > 0 {
        let n = left.min(chunk.len());
        t.observe_bytes(&p, &chunk[..n]).unwrap();
        left -= n;
    }
    let frames = t
        .observe_bytes(&p, "\"}],\"message\":\"中文\"}}\n".as_bytes())
        .unwrap();
    assert_eq!(frames.len(), 1);
    assert!(frames[0].ends_with("\"message\":\"中文\"}}\n"));
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn conflicting_start_reply_and_late_error_cannot_erase_acknowledged_turn() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    child(&t, &p, json!({"id":2,"result":{"turn":{"id":"turn"}}}));
    child(&t, &p, json!({"id":2,"error":{"code":-1,"message":"late"}}));
    assert!(t.try_source_guard(&source("a")).is_err());
}

#[test]
fn correlated_resume_nonterminal_history_is_active_even_without_original_send() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    let q = t.process_key(Transport::Codex, 2);
    send(
        &t,
        &q,
        json!({"id":1,"method":"thread/resume","params":{"threadId":"th"}}),
    );
    child(
        &t,
        &q,
        json!({"id":1,"result":{"thread":{"id":"th","cwd":source("a").root,"turns":[{"id":"running","status":"inProgress"}]}}}),
    );
    assert!(t.try_source_guard(&source("a")).is_err());
    terminal(&t, &q, "running");
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn server_request_reply_uses_a_separate_id_direction_from_pending_turn() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    child(
        &t,
        &p,
        json!({"id":2,"method":"item/commandExecution/requestApproval","params":{"threadId":"th"}}),
    );
    send(&t, &p, json!({"id":2,"result":{"decision":"decline"}}));
    assert!(t.try_source_guard(&source("a")).is_err());
}

#[test]
fn storage_failure_blocks_before_write_and_cannot_admit_a_copy() {
    let store = V3Store::open_in_memory().unwrap();
    store
        .connection
        .pragma_update(None, "query_only", true)
        .unwrap();
    let t = LegacyActivityTracker::new(store).unwrap();
    let p = t.process_key(Transport::Codex, 1);
    assert!(t
        .send(
            &p,
            &json!({"id":1,"method":"command/exec"}).to_string(),
            |_| None,
            || panic!("unrecorded request must not write")
        )
        .is_err());
    assert!(t.try_source_guard(&source("a")).is_err());
}

#[test]
fn early_terminal_overflow_never_becomes_idle_after_an_unrelated_ack() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    for i in 0..129 {
        terminal(&t, &p, &format!("turn-{i}"));
    }
    child(&t, &p, json!({"id":2,"result":{"turn":{"id":"turn-0"}}}));
    assert!(t.try_source_guard(&source("a")).is_err());
}

#[test]
fn worker_protocol_loss_stays_blocked_until_actual_child_termination() {
    let t = tracker();
    let p = t.process_key(Transport::Worker, 1);
    send(&t, &p, json!({"id":1,"method":"ppt.project.execute"}));
    t.evidence_lost(&p).unwrap();
    t.transport_retiring(&p).unwrap();
    assert!(t.try_source_guard(&source("a")).is_err());
    t.transport_lost(&p, "remote_terminal_missing").unwrap();
    assert!(t.try_source_guard(&source("a")).is_ok());
}

#[test]
fn actual_native_visual_begin_records_only_digest_coverage_and_survives_restart() {
    use crate::workbench::{CreateProjectInput, WorkbenchService};
    let root = std::env::temp_dir().join(format!("activity-visual-{}", uuid::Uuid::new_v4()));
    let service =
        WorkbenchService::open(root.join("workbench.sqlite3"), root.join("workspace")).unwrap();
    let id = service
        .create_project(CreateProjectInput {
            name: "synthetic".into(),
            goal: "synthetic".into(),
        })
        .unwrap()
        .id;
    let mut pipeline = service.load_pipeline(&id).unwrap();
    pipeline["revision"] = 2.into();
    pipeline["project"]["workflowStatus"] = "visual_review".into();
    pipeline["slideSpecs"] = json!({"version":{"id":format!("{id}-specs"),"projectId":id,"sequence":1,"status":"frozen","createdAt":"2026-09-11T00:00:00Z","frozenAt":"2026-09-11T00:00:00Z"},"value":[{"id":"slide","title":"Synthetic","body":["Fixture"]}]});
    service
        .commit_pipeline(
            serde_json::from_value(
                json!({"projectId":id,"expectedRevision":1,"pipeline":pipeline,"writes":[]}),
            )
            .unwrap(),
        )
        .unwrap();
    let mut request = visual("native", "imagegen").request;
    request.project_id = id.clone();
    request.expected_revision = 2;
    let record = service.begin_visual_request(request).unwrap();
    let source = service.native_source(&id).unwrap();
    service
        .activity()
        .try_source_guard(&source)
        .unwrap()
        .check_visual_records(&source, &[record.clone()])
        .unwrap();
    let db = rusqlite::Connection::open(root.join("presales-v3.sqlite3")).unwrap();
    let json: String = db
        .query_row("SELECT evidence_json FROM v3_legacy_activity", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!json.contains("中文 prompt"));
    assert!(json.contains(&record.prompt_sha256));
    drop(db);
    drop(service);
    let reopened =
        WorkbenchService::open(root.join("workbench.sqlite3"), root.join("workspace")).unwrap();
    reopened
        .activity()
        .try_source_guard(&source)
        .unwrap()
        .check_visual_records(&source, &[record])
        .unwrap();
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn stop_still_runs_when_retirement_evidence_cannot_be_persisted() {
    let root = std::env::temp_dir().join(format!("activity-stop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("v3.sqlite3");
    let t = LegacyActivityTracker::new(V3Store::open(&path).unwrap()).unwrap();
    let p = t.process_key(Transport::Codex, 1);
    send(&t, &p, json!({"id":1,"method":"command/exec"}));
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_activity_update BEFORE UPDATE ON v3_legacy_activity BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    let mut stopped = false;
    assert!(t
        .retire_and_stop(&p, || {
            stopped = true;
            Ok(())
        })
        .is_err());
    assert!(stopped);
    assert!(t.try_source_guard(&source("a")).is_err());
    drop(db);
    drop(t);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn worker_project_identity_remains_active_when_its_native_workspace_mapping_changes() {
    let t = tracker();
    let p = t.process_key(Transport::Worker, 1);
    t.send(
        &p,
        &json!({"id":1,"method":"ppt.project.execute","params":{"projectId":"a"}}).to_string(),
        |_| Some(source("a")),
        || Ok(()),
    )
    .unwrap();
    let moved = NativeSource::new(source("a").database, "a".into(), source("b").root);
    assert!(t.try_source_guard(&moved).is_err());
}

#[test]
fn durable_terminal_resolution_retains_native_witness_identity() {
    let root = std::env::temp_dir().join(format!("activity-witness-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("v3.sqlite3");
    let t = LegacyActivityTracker::new(V3Store::open(&path).unwrap()).unwrap();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    child(&t, &p, json!({"id":2,"result":{"turn":{"id":"turn"}}}));
    terminal(&t, &p, "turn");
    let db = rusqlite::Connection::open(&path).unwrap();
    let json:String=db.query_row("SELECT evidence_json FROM v3_legacy_activity WHERE json_extract(evidence_json,'$.kind')='Turn'",[],|r|r.get(0)).unwrap();
    let evidence: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(evidence["resolution"]["kind"], "turn_completed");
    assert_eq!(
        evidence["resolution"]["process"],
        serde_json::to_value(&p).unwrap()
    );
    drop(db);
    drop(t);
    let t = LegacyActivityTracker::new(V3Store::open(&path).unwrap()).unwrap();
    assert!(t.try_source_guard(&source("a")).is_ok());
    drop(t);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn slow_stdin_write_does_not_hold_the_short_admission_lock() {
    use std::{
        sync::{mpsc, Arc},
        time::Duration,
    };
    let t = Arc::new(tracker());
    let p = t.process_key(Transport::Codex, 1);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let sender = t.clone();
    let writer = std::thread::spawn(move || {
        sender
            .send(
                &p,
                &json!({"id":1,"method":"command/exec"}).to_string(),
                |_| None,
                || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                },
            )
            .unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let (checked_tx, checked_rx) = mpsc::channel();
    let checking = t.clone();
    let check = std::thread::spawn(move || {
        checked_tx
            .send(checking.try_source_guard(&source("a")).is_err())
            .unwrap()
    });
    let timely = checked_rx.recv_timeout(Duration::from_millis(80));
    release_tx.send(()).unwrap();
    writer.join().unwrap();
    check.join().unwrap();
    assert_eq!(timely, Ok(true));
}

#[test]
fn retiring_resume_response_can_only_resolve_operations_linked_before_its_send() {
    let t = tracker();
    let p = t.process_key(Transport::Codex, 1);
    thread(&t, &p);
    start(&t, &p, json!(2));
    child(&t, &p, json!({"id":2,"result":{"turn":{"id":"same-turn"}}}));
    send(
        &t,
        &p,
        json!({"id":3,"method":"thread/resume","params":{"threadId":"th"}}),
    );
    t.transport_lost(&p, "remote_terminal_missing").unwrap();
    let q = t.process_key(Transport::Codex, 2);
    thread(&t, &q);
    start(&t, &q, json!(2));
    child(&t, &q, json!({"id":2,"result":{"turn":{"id":"same-turn"}}}));
    child(
        &t,
        &p,
        json!({"id":3,"result":{"thread":{"id":"th","cwd":source("a").root,"turns":[{"id":"same-turn","status":"completed"}]}}}),
    );
    assert!(t.try_source_guard(&source("a")).is_err());
    terminal(&t, &q, "same-turn");
    assert!(t.try_source_guard(&source("a")).is_ok());
}
