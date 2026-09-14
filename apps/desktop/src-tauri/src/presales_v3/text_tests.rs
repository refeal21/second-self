use super::*;

#[test]
fn text_capture_is_durable_complete_and_late_pair_cannot_overwrite_manual_save() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    let id = d.summary.project_id.clone();
    let input = RequestTextAuthoring {
        project_id: id.clone(),
        expected_revision: 1,
        operation_id: "text-one".into(),
        attempt_id: "text-attempt-one".into(),
        stage: V3TextStage::Outline,
    };
    let op = s.request_text_authoring(input.clone()).unwrap();
    assert_eq!(op.status, V3TextStatus::Queued);
    assert_eq!(op.sequence, 1);
    assert_eq!(op.target.analysis.original, d.analysis.clone().unwrap());
    assert!(op.target.sources[0].asset.relative_path.starts_with(&id));
    assert_eq!(s.request_text_authoring(input).unwrap(), op);
    drop(s);
    let s = f.service();
    assert_eq!(s.text_operation("text-one").unwrap(), op);
    assert_eq!(s.list_text_operations(&id).unwrap(), vec![op.clone()]);
    // Synthetic private-host dispatch evidence: no transport/provider starts.
    let c = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    c.execute("UPDATE v3_text_operations SET status='running',epoch=0,provider_json=?1 WHERE operation_id='text-one'",[json!({"threadId":"thread-one","turnId":"turn-one"}).to_string()]).unwrap();
    let result = TextCompletion {
        operation_id: "text-one".into(),
        attempt_id: "text-attempt-one".into(),
        stage: V3TextStage::Outline,
        epoch: 0,
        target_sha256: op.target_sha256.clone(),
        provider: TextProviderIdentity {
            thread_id: "thread-one".into(),
            turn_id: Some("turn-one".into()),
        },
        envelope: f.pair["outline"].clone(),
    };
    let ready = s.stage_text_result(result.clone()).unwrap();
    assert_eq!(ready.status, V3TextStatus::ResultReady);
    assert_eq!(s.stage_text_result(result).unwrap(), ready);
    s.save_draft_pair(SaveDraftPair {
        project_id: id.clone(),
        expected_revision: 1,
        stage: V3TextStage::Outline,
        envelope: f.pair["outline"].clone(),
    })
    .unwrap();
    assert_eq!(
        s.commit_text_result("text-one").unwrap().status,
        V3TextStatus::Conflict
    );
    assert_eq!(s.load_v3_project(&id).unwrap().summary().revision, 2);
    assert_eq!(
        s.commit_text_result("text-one").unwrap().status,
        V3TextStatus::Conflict
    );
    assert!(s.text_operation("text-one").unwrap().result.is_some());
}

#[test]
fn current_schema_has_closed_text_operations_and_exact_v2_upgrade_preserves_rows() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    drop(s);
    let path = f.root.path().join("presales-v3.sqlite3");
    let c = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    c.execute_batch("DROP TABLE v3_text_operations; PRAGMA user_version=2")
        .unwrap();
    let before: String = c
        .query_row("SELECT draft_json FROM v3_draft_projects", [], |r| r.get(0))
        .unwrap();
    drop(c);
    let s = f.service();
    assert_eq!(
        s.load_v3_project(&d.summary.project_id).unwrap(),
        V3WorkbenchProject::Draft(d)
    );
    let c = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        c.query_row("SELECT draft_json FROM v3_draft_projects", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        before
    );
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert!(c.execute("INSERT INTO v3_text_operations(sequence,operation_id,attempt_id,project_id,stage,expected_draft_revision,target_json,target_sha256,status,created_at_ms,updated_at_ms) VALUES(1,'x','y','missing','made-up',1,'{}',?1,'queued',1,1)",["a".repeat(64)]).is_err());
}

fn requested(
    f: &Fixture,
    s: &V3WorkbenchService,
    id: &str,
    revision: i64,
    stage: V3TextStage,
    n: &str,
) -> (V3TextOperation, TextCompletion) {
    let op = s
        .request_text_authoring(RequestTextAuthoring {
            project_id: id.into(),
            expected_revision: revision,
            operation_id: format!("text-{n}"),
            attempt_id: format!("attempt-{n}"),
            stage,
        })
        .unwrap();
    let provider = TextProviderIdentity {
        thread_id: format!("thread-{n}"),
        turn_id: Some(format!("turn-{n}")),
    };
    let c = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    c.execute("UPDATE v3_text_operations SET status='running',epoch=0,provider_json=?1 WHERE operation_id=?2",rusqlite::params![serde_json::to_string(&provider).unwrap(),op.operation_id]).unwrap();
    let completion = TextCompletion {
        operation_id: op.operation_id.clone(),
        attempt_id: op.attempt_id.clone(),
        stage,
        epoch: 0,
        target_sha256: op.target_sha256.clone(),
        provider,
        envelope: f.pair[match stage {
            V3TextStage::Outline => "outline",
            V3TextStage::Details => "details",
        }]
        .clone(),
    };
    (op, completion)
}

#[test]
fn ai_pairs_commit_once_remain_unapproved_and_cancelled_late_result_never_publishes() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    let id = &d.summary.project_id;
    let (_, result) = requested(&f, &s, id, 1, V3TextStage::Outline, "outline");
    let mut wrong = result.clone();
    wrong.attempt_id = "different".into();
    assert!(s.stage_text_result(wrong).is_err());
    s.stage_text_result(result).unwrap();
    let committed = s.commit_text_result("text-outline").unwrap();
    assert_eq!(committed.status, V3TextStatus::Succeeded);
    assert_eq!(committed.commit.as_ref().unwrap().committed_revision, 2);
    assert_eq!(s.commit_text_result("text-outline").unwrap(), committed);
    let evidence_db =
        rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    evidence_db.execute("UPDATE v3_text_operations SET commit_json=json_set(commit_json,'$.at','2026-01-01T00:00:00Z') WHERE operation_id='text-outline'",[]).unwrap();
    assert!(s.text_operation("text-outline").is_err());
    evidence_db
        .execute(
            "UPDATE v3_text_operations SET commit_json=?1 WHERE operation_id='text-outline'",
            [serde_json::to_string(committed.commit.as_ref().unwrap()).unwrap()],
        )
        .unwrap();
    let V3WorkbenchProject::Draft(saved) = s.load_v3_project(id).unwrap() else {
        panic!()
    };
    assert!(saved
        .authored
        .unwrap()
        .checkpoint
        .unwrap()
        .approval_bindings
        .is_empty());
    s.approve_draft_pair(id, 2, V3TextStage::Outline).unwrap();
    let (op, result) = requested(&f, &s, id, 3, V3TextStage::Details, "details");
    assert!(op.target.outline_approval.is_some());
    assert_eq!(op.target.approved_outline, Some(f.pair["outline"].clone()));
    s.stage_text_result(result).unwrap();
    s.commit_text_result("text-details").unwrap();
    let V3WorkbenchProject::Draft(saved) = s.load_v3_project(id).unwrap() else {
        panic!()
    };
    assert_eq!(
        saved
            .authored
            .unwrap()
            .checkpoint
            .unwrap()
            .approval_bindings
            .len(),
        1
    );
    let (_, result) = requested(&f, &s, id, 4, V3TextStage::Details, "late");
    assert_eq!(
        s.cancel_text_authoring("text-late", false).unwrap().status,
        V3TextStatus::CancelRequested
    );
    let cancelled = s.stage_text_result(result).unwrap();
    assert_eq!(cancelled.status, V3TextStatus::Cancelled);
    assert!(cancelled.result.is_some());
    assert_eq!(s.commit_text_result("text-late").unwrap(), cancelled);
    assert_eq!(s.load_v3_project(id).unwrap().summary().revision, 4);
}

#[test]
fn shared_admission_orders_image_text_and_idempotent_reuse_and_rejects_cross_collisions() {
    let f = Fixture::paired(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    let format = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let image_id = s
        .publish_legacy_copy(&format.preparation_id)
        .unwrap()
        .summary()
        .project_id
        .clone();
    let input = RequestTextAuthoring {
        project_id: d.summary.project_id.clone(),
        expected_revision: 1,
        operation_id: "text-first".into(),
        attempt_id: "text-first-attempt".into(),
        stage: V3TextStage::Outline,
    };
    let first = s.request_text_authoring(input.clone()).unwrap();
    assert_eq!(first.sequence, 1);
    let mut store = V3Store::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    let images = EnqueuePages {
        project_id: image_id,
        batch_id: "mixed".into(),
        pages: vec![PageRequest {
            slide_id: "scenario-1".into(),
            request_id: "image-second".into(),
            attempt_id: "image-second-attempt".into(),
            expected_revision: 1,
            parent_version_id: None,
            feedback: String::new(),
        }],
    };
    let second = store.enqueue_pages(images.clone(), None).unwrap();
    assert_eq!(second.jobs[0].sequence, 2);
    assert_eq!(s.request_text_authoring(input.clone()).unwrap(), first);
    assert_eq!(store.enqueue_pages(images.clone(), None).unwrap(), second);
    s.cancel_text_authoring("text-first", false).unwrap();
    let mut third = input.clone();
    third.operation_id = "text-third".into();
    third.attempt_id = "text-third-attempt".into();
    assert_eq!(s.request_text_authoring(third).unwrap().sequence, 3);
    let mut collision = input;
    collision.operation_id = "image-second-attempt".into();
    collision.attempt_id = "new-attempt".into();
    assert!(s
        .request_text_authoring(collision)
        .unwrap_err()
        .contains("collision"));
    let mut collision = images;
    collision.batch_id = "collision-batch".into();
    collision.pages[0].request_id = "text-third-attempt".into();
    collision.pages[0].attempt_id = "new-image-attempt".into();
    assert!(store
        .enqueue_pages(collision, None)
        .unwrap_err()
        .contains("collision"));
}

#[test]
fn failed_pair_and_stale_approval_leave_reviewed_work_and_result_commit_is_atomic() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    let id = &d.summary.project_id;
    let (_, mut result) = requested(&f, &s, id, 1, V3TextStage::Outline, "bad");
    result.envelope["plan"]["pages"][0]["slideId"] = json!("not-mapped");
    assert_eq!(
        s.stage_text_result(result).unwrap().status,
        V3TextStatus::Failed
    );
    assert_eq!(s.load_v3_project(id).unwrap().summary().revision, 1);
    let (_, result) = requested(&f, &s, id, 1, V3TextStage::Outline, "atomic");
    s.stage_text_result(result).unwrap();
    let c = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    c.execute_batch("CREATE TRIGGER reject_text_commit BEFORE UPDATE OF commit_json ON v3_text_operations WHEN NEW.commit_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END").unwrap();
    assert!(s.commit_text_result("text-atomic").is_err());
    assert_eq!(s.load_v3_project(id).unwrap().summary().revision, 1);
    assert_eq!(
        s.text_operation("text-atomic").unwrap().status,
        V3TextStatus::ResultReady
    );
    c.execute_batch("DROP TRIGGER reject_text_commit").unwrap();
    s.commit_text_result("text-atomic").unwrap();
    let (_, result) = requested(&f, &s, id, 2, V3TextStage::Outline, "approval-race");
    s.approve_draft_pair(id, 2, V3TextStage::Outline).unwrap();
    s.stage_text_result(result).unwrap();
    assert_eq!(
        s.commit_text_result("text-approval-race").unwrap().status,
        V3TextStatus::Conflict
    );
    assert_eq!(s.load_v3_project(id).unwrap().summary().revision, 3);
}

#[test]
fn native_and_shared_worker_prompt_are_identical_for_captured_copied_context() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    let (op, _) = requested(
        &f,
        &s,
        &d.summary.project_id,
        1,
        V3TextStage::Outline,
        "prompt",
    );
    let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
    let script="import {buildPairedAuthoringPrompt} from './src/presales/authoring.ts'; let raw=''; for await (const chunk of process.stdin) raw+=chunk; const t=JSON.parse(raw); process.stdout.write(buildPairedAuthoringPrompt(t.stage,t));";
    let mut child = Command::new("node")
        .current_dir(&worker)
        .arg("--import")
        .arg(worker.join("node_modules/tsx/dist/loader.mjs"))
        .args(["--input-type=module", "-e", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&op.target).unwrap().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8(out.stdout).unwrap(), op.target.prompt);
}

#[test]
fn additive_migration_rolls_back_all_new_objects_and_preserves_unresolved_activity() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    drop(s);
    let path = f.root.path().join("presales-v3.sqlite3");
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch("DROP TABLE v3_text_operations; PRAGMA user_version=2")
        .unwrap();
    c.execute(
        "INSERT INTO v3_legacy_activity VALUES('opaque-unresolved','original unchanged evidence')",
        [],
    )
    .unwrap();
    drop(c);
    crate::presales_queue::schema::inject_v3_upgrade_failure(Some("text_after_ddl"));
    let result = V3Store::open(&path);
    crate::presales_queue::schema::inject_v3_upgrade_failure(None);
    assert!(result.is_err());
    let c = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='v3_text_operations'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT evidence_json FROM v3_legacy_activity WHERE evidence_id='opaque-unresolved'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "original unchanged evidence"
    );
    drop(c);
    let reopened = V3Store::open(&path).unwrap();
    assert_eq!(
        reopened.list_project_catalog().unwrap()[0].summary,
        d.summary
    );
}

#[test]
fn staged_result_survives_owner_epoch_change_for_local_only_commit_but_old_callback_cannot_write() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    let (_, result) = requested(
        &f,
        &s,
        &d.summary.project_id,
        1,
        V3TextStage::Outline,
        "recovery",
    );
    s.stage_text_result(result.clone()).unwrap();
    let c = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    c.execute_batch("UPDATE queue_settings SET epoch=1; UPDATE v3_text_operations SET epoch=1 WHERE operation_id='text-recovery'").unwrap();
    drop(s);
    let s = f.service();
    assert_eq!(
        s.text_operation("text-recovery").unwrap().status,
        V3TextStatus::ResultReady
    );
    assert!(s.stage_text_result(result).is_err());
    assert_eq!(
        s.commit_text_result("text-recovery").unwrap().status,
        V3TextStatus::Succeeded
    );
}
