use super::*;
use crate::presales_v3::supervisor::RuntimeWork;

fn enqueue_test_images(s: &V3WorkbenchService, count: usize) {
    let (checkpoint, palette) = crate::presales_v3::basis::tests::frozen_fixture_pages(count);
    let mut store = s.store.lock().unwrap();
    store
        .insert_project(ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette).unwrap())
        .unwrap();
    let pages = store.load_project("frozen-project").unwrap().pages;
    store
        .enqueue_pages(
            EnqueuePages {
                project_id: "frozen-project".into(),
                batch_id: "review-batch".into(),
                pages: pages
                    .into_iter()
                    .enumerate()
                    .map(|(i, p)| PageRequest {
                        slide_id: p.slide_id,
                        expected_revision: p.revision,
                        request_id: format!("review-image-{i}"),
                        attempt_id: format!("review-attempt-{i}"),
                        parent_version_id: None,
                        feedback: String::new(),
                    })
                    .collect(),
            },
            None,
        )
        .unwrap();
}

fn synthetic_child(f: &Fixture, options: Value) -> Command {
    let mut fixture = json!({"png":STANDARD.encode(png(65)),"outline":f.pair["outline"],"details":f.pair["details"]});
    fixture
        .as_object_mut()
        .unwrap()
        .extend(options.as_object().unwrap().clone());
    let path = f.root.path().join("review-child.json");
    std::fs::write(&path, fixture.to_string()).unwrap();
    let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
    let mut command = Command::new("node");
    command
        .arg("--import")
        .arg(worker.join("node_modules/tsx/dist/loader.mjs"))
        .arg(worker.join("src/presales/runtime-child.test-support.ts"))
        .arg(path);
    command
}

fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    while !condition() {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

#[test]
fn completed_interrupt_race_does_not_stop_unrelated_private_child_work() {
    let f = Fixture::new(5);
    let s = std::sync::Arc::new(f.service());
    enqueue_test_images(&s, 2);
    s.set_queue_settings(2, false).unwrap();
    let marker = f.root.path().join("emitted");
    let command = synthetic_child(
        &f,
        json!({"resultMarker":marker,"heldRequest":"review-image-1"}),
    );
    let (blocked_tx, blocked_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let blocked = std::sync::atomic::AtomicBool::new(false);
    let observed = s.clone();
    let host =
        crate::presales_v3::runtime_host::QueueSupervisor::start(s.clone(), command, move |_| {
            let ready = observed
                .image_lifecycle
                .lock()
                .unwrap()
                .get_job("review-image-0")
                .unwrap()
                .unwrap()
                .provider
                .is_some_and(|p| p.turn_id.is_some());
            if ready && !blocked.swap(true, std::sync::atomic::Ordering::SeqCst) {
                blocked_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(6)).unwrap();
            }
        })
        .unwrap();
    blocked_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    let emitted = wait_until(|| marker.exists());
    s.image_lifecycle
        .lock()
        .unwrap()
        .request_cancel("review-image-0")
        .unwrap();
    host.interrupt("review-image-0".into());
    release_tx.send(()).unwrap();
    assert!(
        emitted,
        "completion must already be in child stdout before cancellation delivery"
    );
    assert!(wait_until(
        || s.queue_snapshot().unwrap().jobs[0].status == "cancelled"
    ));
    std::thread::sleep(Duration::from_millis(150));
    assert!(
        host.snapshot().unwrap().dispatch_available,
        "negative interrupt reply killed the shared private child"
    );
    assert_eq!(s.queue_snapshot().unwrap().jobs[1].status, "running");
    host.shutdown();
}

#[test]
fn saturated_wakes_do_not_drop_durable_cancellation_or_release_its_slot() {
    let f = Fixture::new(5);
    let s = std::sync::Arc::new(f.service());
    enqueue_test_images(&s, 1);
    let marker = f.root.path().join("interrupted");
    let command = synthetic_child(&f, json!({"interruptMarker":marker,"delayMs":10000}));
    let (blocked_tx, blocked_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let blocked = std::sync::atomic::AtomicBool::new(false);
    let observed = s.clone();
    let host =
        crate::presales_v3::runtime_host::QueueSupervisor::start(s.clone(), command, move |_| {
            let ready = observed
                .image_lifecycle
                .lock()
                .unwrap()
                .get_job("review-image-0")
                .unwrap()
                .unwrap()
                .provider
                .is_some();
            if ready && !blocked.swap(true, std::sync::atomic::Ordering::SeqCst) {
                blocked_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(6)).unwrap();
            }
        })
        .unwrap();
    blocked_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    for _ in 0..32 {
        host.wake();
    }
    s.image_lifecycle
        .lock()
        .unwrap()
        .request_cancel("review-image-0")
        .unwrap();
    host.interrupt("review-image-0".into());
    release_tx.send(()).unwrap();
    assert!(
        wait_until(|| marker.exists()),
        "persisted cancellation was lost behind wake backpressure"
    );
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "review-image-0");
    assert_eq!(host.snapshot().unwrap().remote_active, 1);
    assert_eq!(
        s.queue_snapshot().unwrap().jobs[0].status,
        "cancel_requested"
    );
    host.shutdown();
}

#[test]
fn failed_image_and_text_publication_is_visible_and_retries_only_local_results() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    s.request_text_authoring(RequestTextAuthoring {
        project_id: d.summary.project_id,
        expected_revision: 1,
        operation_id: "review-text".into(),
        attempt_id: "review-text-attempt".into(),
        stage: V3TextStage::Outline,
    })
    .unwrap();
    enqueue_test_images(&s, 1);
    s.set_queue_settings(2, false).unwrap();
    let epoch = s.begin_queue_runtime().unwrap();
    let works = [
        s.claim_queue_work(epoch).unwrap().unwrap(),
        s.claim_queue_work(epoch).unwrap().unwrap(),
    ];
    let c = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    c.execute_batch("CREATE TRIGGER fail_text_publish BEFORE UPDATE OF status ON v3_text_operations WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic text disk failure'); END; CREATE TRIGGER fail_image_publish BEFORE UPDATE OF status ON queue_jobs WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic image disk failure'); END;").unwrap();
    for work in &works {
        let provider = TextProviderIdentity {
            thread_id: format!("thread-{}", work.id()),
            turn_id: Some("turn".into()),
        };
        s.provider_identity(epoch, work, provider.clone()).unwrap();
        let result = match work {
            RuntimeWork::Text(_) => json!({"kind":"text","envelope":f.pair["outline"]}),
            RuntimeWork::Image(_) => json!({"kind":"image","pngBase64":STANDARD.encode(png(44))}),
        };
        assert!(
            s.complete_work(epoch, work, provider, &result).is_err(),
            "publication failure must not report success"
        );
    }
    let snapshot = serde_json::to_value(s.queue_snapshot().unwrap()).unwrap();
    for job in snapshot["jobs"].as_array().unwrap() {
        assert_eq!(job["status"], "result_ready");
        assert!(job["error"].as_str().unwrap().contains("disk failure"));
    }
    let text_result = s.text_operation("review-text").unwrap().result.unwrap();
    let image_result = s
        .image_lifecycle
        .lock()
        .unwrap()
        .get_job("review-image-0")
        .unwrap()
        .unwrap()
        .result
        .unwrap();
    let image_bytes = std::fs::read(s.root.join(&image_result.relative_path)).unwrap();
    let error = s
        .retry_local_results()
        .expect_err("retry command must report remaining failures");
    assert!(
        error.contains("review-text") && error.contains("review-image-0"),
        "{error}"
    );
    assert_eq!(
        s.text_operation("review-text").unwrap().result,
        Some(text_result)
    );
    assert_eq!(
        std::fs::read(s.root.join(image_result.relative_path)).unwrap(),
        image_bytes
    );
    c.execute_batch("DROP TRIGGER fail_text_publish; DROP TRIGGER fail_image_publish;")
        .unwrap();
    s.retry_local_results().unwrap();
    assert_eq!(s.queue_snapshot().unwrap().succeeded, 2);
    for job in serde_json::to_value(s.queue_snapshot().unwrap()).unwrap()["jobs"]
        .as_array()
        .unwrap()
    {
        assert!(job["error"].is_null());
    }
    assert!(
        s.claim_queue_work(epoch).unwrap().is_none(),
        "local recovery must never enqueue or dispatch generation"
    );
}

#[test]
fn absent_manifest_is_expected_but_corrupt_or_unreadable_recovery_is_visible() {
    let f = Fixture::new(5);
    let s = f.service();
    enqueue_test_images(&s, 1);
    let epoch = s.begin_queue_runtime().unwrap();
    let work = s.claim_queue_work(epoch).unwrap().unwrap();
    s.unknown_work(epoch, &work, "child gone").unwrap();
    s.retry_local_results().unwrap(); // No manifest is expected for unknown remote work.
    let RuntimeWork::Image(job) = &work else {
        panic!("expected image")
    };
    let vault = crate::presales_queue::ResultVault::open(&s.root).unwrap();
    let binding = crate::presales_queue::result_staging::result_binding(job).unwrap();
    vault.stage(&binding, &png(33)).unwrap();
    let manifest = s
        .root
        .join("queue-results/review-image-0/review-attempt-0.json");
    let bytes = std::fs::read(&manifest).unwrap();
    std::fs::write(&manifest, b"not JSON").unwrap();
    let error = s
        .retry_local_results()
        .expect_err("corrupt manifest must not be treated as absent");
    assert!(error.contains("manifest"), "{error}");
    let snapshot = serde_json::to_value(s.queue_snapshot().unwrap()).unwrap();
    assert!(snapshot["jobs"][0]["error"]
        .as_str()
        .unwrap()
        .contains("manifest"));
    assert_eq!(snapshot["remoteActive"], 1);
    std::fs::write(&manifest, bytes).unwrap();
    let png_path = s
        .root
        .join("queue-results/review-image-0/review-attempt-0.png");
    let bytes = std::fs::read(&png_path).unwrap();
    std::fs::remove_file(&png_path).unwrap();
    assert!(
        s.retry_local_results().is_err(),
        "manifest without its PNG is incomplete evidence, not absence"
    );
    std::fs::write(&png_path, bytes).unwrap();
    s.retry_local_results().unwrap();
    assert_eq!(s.queue_snapshot().unwrap().succeeded, 1);
    assert!(s.claim_queue_work(epoch).unwrap().is_none());
}

#[test]
fn stalled_private_start_acknowledgement_becomes_named_unknown_without_releasing_slot() {
    let f = Fixture::new(5);
    let s = std::sync::Arc::new(f.service());
    let d = super::draft_tests::imported(&f, &s);
    s.request_text_authoring(RequestTextAuthoring {
        project_id: d.summary.project_id,
        expected_revision: 1,
        operation_id: "stalled".into(),
        attempt_id: "stalled-attempt".into(),
        stage: V3TextStage::Outline,
    })
    .unwrap();
    let mut command = Command::new("node");
    command.arg("-e").arg("require('readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.method==='presales/status')process.stdout.write(JSON.stringify({id:m.id,result:{available:true,generation:m.params.generation}})+'\\n');});");
    let host = crate::presales_v3::runtime_host::QueueSupervisor::start(s.clone(), command, |_| {})
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(17);
    loop {
        let op = s.text_operation("stalled").unwrap();
        if op.status == V3TextStatus::OutcomeUnknown {
            assert!(op.error.unwrap().contains("acknowledgement timed out"));
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "missing bounded control acknowledgement deadline"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(host.snapshot().unwrap().remote_active, 1);
    drop(host);
}

#[test]
fn mixed_runtime_claims_share_fifo_slots_and_recover_unknown_text_once() {
    for limit in [1, 2, 4] {
        let f = Fixture::new(5);
        let s = f.service();
        let d = super::draft_tests::imported(&f, &s);
        s.request_text_authoring(RequestTextAuthoring {
            project_id: d.summary.project_id.clone(),
            expected_revision: 1,
            operation_id: "text-first".into(),
            attempt_id: "text-attempt".into(),
            stage: V3TextStage::Outline,
        })
        .unwrap();
        let (checkpoint, palette) = crate::presales_v3::basis::tests::frozen_fixture_pages(5);
        {
            let mut store = s.store.lock().unwrap();
            store
                .insert_project(
                    ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette).unwrap(),
                )
                .unwrap();
            let pages = store.load_project("frozen-project").unwrap().pages;
            store
                .enqueue_pages(
                    EnqueuePages {
                        project_id: "frozen-project".into(),
                        batch_id: "mixed-batch".into(),
                        pages: pages
                            .into_iter()
                            .enumerate()
                            .map(|(i, p)| PageRequest {
                                slide_id: p.slide_id,
                                expected_revision: p.revision,
                                request_id: format!("mixed-image-{i}"),
                                attempt_id: format!("mixed-attempt-{i}"),
                                parent_version_id: None,
                                feedback: String::new(),
                            })
                            .collect(),
                    },
                    None,
                )
                .unwrap();
        }
        let epoch = s.begin_queue_runtime().unwrap();
        s.set_queue_settings(limit, true).unwrap();
        assert!(s.claim_queue_work(epoch).unwrap().is_none());
        s.set_queue_settings(limit, false).unwrap();
        let Some(RuntimeWork::Text(op)) = s.claim_queue_work(epoch).unwrap() else {
            panic!("text must be claimed");
        };
        assert_eq!(op.operation_id, "text-first");
        assert_eq!(op.status, V3TextStatus::Dispatching);
        for n in 0..limit - 1 {
            let Some(RuntimeWork::Image(image)) = s.claim_queue_work(epoch).unwrap() else {
                panic!("next mixed FIFO job must be an image");
            };
            assert_eq!(image.request_id, format!("mixed-image-{n}"));
        }
        assert!(s.claim_queue_work(epoch).unwrap().is_none());
        s.set_queue_settings(1, false).unwrap();
        assert_eq!(
            s.queue_snapshot().unwrap().remote_active,
            usize::from(limit)
        );
        s.record_text_provider(
            epoch,
            "text-first",
            "text-attempt",
            TextProviderIdentity {
                thread_id: "thread".into(),
                turn_id: None,
            },
        )
        .unwrap();
        let next = s.begin_queue_runtime().unwrap();
        assert_eq!(next, epoch + 1);
        let recovered = s.text_operation("text-first").unwrap();
        assert_eq!(recovered.status, V3TextStatus::OutcomeUnknown);
        assert_eq!(recovered.epoch, Some(next));
        assert_eq!(recovered.provider.unwrap().thread_id, "thread");
        assert!(s.claim_queue_work(next).unwrap().is_none());
        assert!(s.claim_queue_work(epoch).is_err());
    }
}

#[test]
fn stale_queued_text_terminates_before_dispatch() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    s.request_text_authoring(RequestTextAuthoring {
        project_id: d.summary.project_id.clone(),
        expected_revision: 1,
        operation_id: "stale".into(),
        attempt_id: "stale-attempt".into(),
        stage: V3TextStage::Outline,
    })
    .unwrap();
    s.save_draft_pair(SaveDraftPair {
        project_id: d.summary.project_id,
        expected_revision: 1,
        stage: V3TextStage::Outline,
        envelope: f.pair["outline"].clone(),
    })
    .unwrap();
    let epoch = s.begin_queue_runtime().unwrap();
    assert!(s.claim_queue_work(epoch).unwrap().is_none());
    assert_eq!(
        s.text_operation("stale").unwrap().status,
        V3TextStatus::Failed
    );
}

#[test]
fn v3_lifecycle_connection_cannot_be_a_second_image_scheduler() {
    let f = Fixture::new(5);
    let s = f.service();
    let mut q = crate::presales_queue::QueueStore::open_v3_lifecycle(
        f.root.path().join("presales-v3.sqlite3"),
    )
    .unwrap();
    assert!(q.begin_runtime().is_err());
    assert!(q.claim_next(0).is_err());
    assert_eq!(s.begin_queue_runtime().unwrap(), 1);
}

#[test]
fn actual_private_child_publishes_five_pages_and_text_with_shared_capacity() {
    for limit in [1, 2, 4] {
        let f = Fixture::new(5);
        let s = std::sync::Arc::new(f.service());
        let d = super::draft_tests::imported(&f, &s);
        s.request_text_authoring(RequestTextAuthoring {
            project_id: d.summary.project_id.clone(),
            expected_revision: 1,
            operation_id: "text-0".into(),
            attempt_id: "attempt-text".into(),
            stage: V3TextStage::Outline,
        })
        .unwrap();
        let (checkpoint, palette) = crate::presales_v3::basis::tests::frozen_fixture_pages(5);
        {
            let mut store = s.store.lock().unwrap();
            store
                .insert_project(
                    ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette).unwrap(),
                )
                .unwrap();
            let snapshot = store.load_project("frozen-project").unwrap();
            store
                .enqueue_pages(
                    EnqueuePages {
                        project_id: "frozen-project".into(),
                        batch_id: "batch".into(),
                        pages: snapshot
                            .pages
                            .iter()
                            .enumerate()
                            .map(|(i, p)| PageRequest {
                                slide_id: p.slide_id.clone(),
                                request_id: format!("image-{i}"),
                                attempt_id: format!("attempt-{i}"),
                                expected_revision: p.revision,
                                parent_version_id: None,
                                feedback: String::new(),
                            })
                            .collect(),
                    },
                    None,
                )
                .unwrap();
        }
        s.set_queue_settings(limit, false).unwrap();
        let fixture = f.root.path().join("provider-fixture.json");
        std::fs::write(&fixture,json!({"png":STANDARD.encode(png(50)),"outline":f.pair["outline"],"details":f.pair["details"]}).to_string()).unwrap();
        let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
        let mut command = Command::new("node");
        command
            .arg("--import")
            .arg(worker.join("node_modules/tsx/dist/loader.mjs"))
            .arg(worker.join("src/presales/runtime-child.test-support.ts"))
            .arg(fixture);
        let changed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = changed.clone();
        let host = crate::presales_v3::runtime_host::QueueSupervisor::start(
            s.clone(),
            command,
            move |_| {
                observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            },
        )
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            let snapshot = host.snapshot().unwrap();
            assert!(snapshot.remote_active <= usize::from(limit));
            if snapshot.succeeded == 6 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "runtime timed out: {snapshot:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(changed.load(std::sync::atomic::Ordering::Relaxed) > 6);
        assert_eq!(
            s.load_v3_project(&d.summary.project_id)
                .unwrap()
                .summary()
                .revision,
            2
        );
        assert_eq!(
            s.text_operation("text-0").unwrap().status,
            V3TextStatus::Succeeded
        );
        assert_eq!(
            s.store
                .lock()
                .unwrap()
                .load_project("frozen-project")
                .unwrap()
                .pages
                .iter()
                .filter(|p| p.current_version_id.is_some())
                .count(),
            5
        );
        // AI details authoring is a distinct claim after an explicit exact-pair
        // approval; saving either AI result never grants that approval itself.
        s.approve_draft_pair(&d.summary.project_id, 2, V3TextStage::Outline)
            .unwrap();
        s.request_text_authoring(RequestTextAuthoring {
            project_id: d.summary.project_id.clone(),
            expected_revision: 3,
            operation_id: "details-6".into(),
            attempt_id: "details-attempt".into(),
            stage: V3TextStage::Details,
        })
        .unwrap();
        host.wake();
        while host.snapshot().unwrap().succeeded != 7 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let V3WorkbenchProject::Draft(saved) = s.load_v3_project(&d.summary.project_id).unwrap()
        else {
            panic!("authoring cannot promote");
        };
        assert_eq!(saved.summary.revision, 4);
        let checkpoint = saved.authored.unwrap().checkpoint.unwrap();
        assert_eq!(checkpoint.approval_bindings.len(), 1);
        assert_eq!(
            checkpoint.draft.details.as_ref().unwrap(),
            &f.pair["details"]
        );
        drop(host);
    }
}

#[test]
fn picker_cancellation_has_no_mutation_and_renderer_cannot_supply_selection_authority() {
    use crate::presales_v3::picker::{complete_selection, PickPageReference};
    let f = Fixture::paired(5);
    let s = f.service();
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let project = s.publish_legacy_copy(&p.preparation_id).unwrap();
    let input = PickPageReference {
        project_id: project.summary().project_id.clone(),
        slide_id: "scenario-1".into(),
        expected_revision: 1,
        purpose: crate::presales_queue::ReferencePurpose::Style,
    };
    assert!(serde_json::from_value::<PickPageReference>(json!({"projectId":input.project_id,"slideId":"scenario-1","expectedRevision":1,"purpose":"style","path":"/untrusted.png"})).is_err());
    assert!(complete_selection(&s, input.clone(), None)
        .unwrap()
        .is_none());
    assert_eq!(s.load_v3_project(&input.project_id).unwrap(), project);
    let path = f.root.path().join("explicitly-selected.png");
    std::fs::write(&path, png(40)).unwrap();
    let result = complete_selection(&s, input, Some(std::fs::canonicalize(path).unwrap()))
        .unwrap()
        .unwrap();
    assert_eq!(result.revision, 2);
    assert_eq!(result.references.len(), 1);
}

#[test]
fn cancel_ack_and_child_exit_keep_text_slot_across_restart_without_resending() {
    let f = Fixture::new(5);
    let s = std::sync::Arc::new(f.service());
    let d = super::draft_tests::imported(&f, &s);
    s.request_text_authoring(RequestTextAuthoring {
        project_id: d.summary.project_id,
        expected_revision: 1,
        operation_id: "held-text".into(),
        attempt_id: "held-attempt".into(),
        stage: V3TextStage::Outline,
    })
    .unwrap();
    s.set_queue_settings(1, false).unwrap();
    let fixture = f.root.path().join("held-fixture.json");
    std::fs::write(&fixture,json!({"png":STANDARD.encode(png(50)),"outline":f.pair["outline"],"details":f.pair["details"],"delayMs":10000}).to_string()).unwrap();
    let command = || {
        let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
        let mut c = Command::new("node");
        c.arg("--import")
            .arg(worker.join("node_modules/tsx/dist/loader.mjs"))
            .arg(worker.join("src/presales/runtime-child.test-support.ts"))
            .arg(&fixture);
        c
    };
    let host =
        crate::presales_v3::runtime_host::QueueSupervisor::start(s.clone(), command(), |_| {})
            .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while s.text_operation("held-text").unwrap().provider.is_none() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    s.cancel_text_authoring("held-text", false).unwrap();
    host.interrupt("held-text".into());
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(host.snapshot().unwrap().remote_active, 1);
    assert_eq!(
        s.text_operation("held-text").unwrap().status,
        V3TextStatus::CancelRequested
    );
    host.shutdown();
    host.shutdown();
    drop(host);
    assert_eq!(
        s.text_operation("held-text").unwrap().status,
        V3TextStatus::OutcomeUnknown
    );
    let old_epoch = s.text_operation("held-text").unwrap().epoch;
    let host =
        crate::presales_v3::runtime_host::QueueSupervisor::start(s.clone(), command(), |_| {})
            .unwrap();
    std::thread::sleep(Duration::from_millis(150));
    let op = s.text_operation("held-text").unwrap();
    assert_eq!(op.epoch, old_epoch.map(|e| e + 1));
    assert_eq!(op.status, V3TextStatus::OutcomeUnknown);
    assert_eq!(host.snapshot().unwrap().remote_active, 1);
    assert!(op.cancellation.is_some());
    assert!(op.result.is_none());
    drop(host);
}

#[test]
fn completed_result_frames_are_drained_before_child_exit_becomes_unknown() {
    let f = Fixture::new(5);
    let s = std::sync::Arc::new(f.service());
    let d = super::draft_tests::imported(&f, &s);
    s.request_text_authoring(RequestTextAuthoring {
        project_id: d.summary.project_id,
        expected_revision: 1,
        operation_id: "exiting-text".into(),
        attempt_id: "exiting-attempt".into(),
        stage: V3TextStage::Outline,
    })
    .unwrap();
    let fixture = f.root.path().join("exiting-fixture.json");
    std::fs::write(&fixture,json!({"png":STANDARD.encode(png(50)),"outline":f.pair["outline"],"details":f.pair["details"],"exitAfterResult":true}).to_string()).unwrap();
    let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
    let mut command = Command::new("node");
    command
        .arg("--import")
        .arg(worker.join("node_modules/tsx/dist/loader.mjs"))
        .arg(worker.join("src/presales/runtime-child.test-support.ts"))
        .arg(fixture);
    let host = crate::presales_v3::runtime_host::QueueSupervisor::start(s.clone(), command, |_| {
        std::thread::sleep(Duration::from_millis(30))
    })
    .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let status = s.text_operation("exiting-text").unwrap().status;
        if matches!(
            status,
            V3TextStatus::Succeeded | V3TextStatus::OutcomeUnknown
        ) {
            assert_eq!(status, V3TextStatus::Succeeded);
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(host);
}

#[test]
fn staged_text_recovers_by_local_save_only_and_does_not_approve_outline() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    let original = s
        .request_text_authoring(RequestTextAuthoring {
            project_id: d.summary.project_id.clone(),
            expected_revision: 1,
            operation_id: "saved".into(),
            attempt_id: "save-attempt".into(),
            stage: V3TextStage::Outline,
        })
        .unwrap();
    let epoch = s.begin_queue_runtime().unwrap();
    s.claim_queue_work(epoch).unwrap().unwrap();
    let provider = TextProviderIdentity {
        thread_id: "thread".into(),
        turn_id: Some("turn".into()),
    };
    s.record_text_provider(epoch, "saved", "save-attempt", provider.clone())
        .unwrap();
    s.stage_text_result(TextCompletion {
        operation_id: "saved".into(),
        attempt_id: "save-attempt".into(),
        stage: V3TextStage::Outline,
        epoch,
        target_sha256: original.target_sha256,
        provider,
        envelope: f.pair["outline"].clone(),
    })
    .unwrap();
    let next = s.begin_queue_runtime().unwrap();
    assert!(s.claim_queue_work(next).unwrap().is_none());
    s.retry_local_results().unwrap();
    assert_eq!(
        s.text_operation("saved").unwrap().status,
        V3TextStatus::Succeeded
    );
    assert!(s
        .request_text_authoring(RequestTextAuthoring {
            project_id: d.summary.project_id.clone(),
            expected_revision: 2,
            operation_id: "details-too-early".into(),
            attempt_id: "attempt-details".into(),
            stage: V3TextStage::Details
        })
        .is_err());
    s.approve_draft_pair(&d.summary.project_id, 2, V3TextStage::Outline)
        .unwrap();
    assert!(s
        .request_text_authoring(RequestTextAuthoring {
            project_id: d.summary.project_id,
            expected_revision: 3,
            operation_id: "details".into(),
            attempt_id: "attempt-details".into(),
            stage: V3TextStage::Details
        })
        .is_ok());
}

#[test]
fn verified_png_survives_staging_database_failure_and_saves_without_a_new_claim() {
    let f = Fixture::new(5);
    let s = f.service();
    let (checkpoint, palette) = crate::presales_v3::basis::tests::frozen_fixture_pages(1);
    {
        let mut store = s.store.lock().unwrap();
        store
            .insert_project(ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette).unwrap())
            .unwrap();
        let p = store
            .load_project("frozen-project")
            .unwrap()
            .pages
            .remove(0);
        store
            .enqueue_pages(
                EnqueuePages {
                    project_id: "frozen-project".into(),
                    batch_id: "save-batch".into(),
                    pages: vec![PageRequest {
                        slide_id: p.slide_id,
                        expected_revision: p.revision,
                        request_id: "image-save".into(),
                        attempt_id: "image-save-attempt".into(),
                        parent_version_id: None,
                        feedback: String::new(),
                    }],
                },
                None,
            )
            .unwrap();
    }
    let epoch = s.begin_queue_runtime().unwrap();
    let work = s.claim_queue_work(epoch).unwrap().unwrap();
    let provider = TextProviderIdentity {
        thread_id: "thread".into(),
        turn_id: Some("turn".into()),
    };
    s.provider_identity(epoch, &work, provider.clone()).unwrap();
    let c = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    c.execute_batch("CREATE TRIGGER temporary_stage_failure BEFORE UPDATE OF status ON queue_jobs WHEN NEW.status='result_ready' BEGIN SELECT RAISE(ABORT,'synthetic local save failure'); END").unwrap();
    assert!(s
        .complete_work(
            epoch,
            &work,
            provider,
            &json!({"kind":"image","pngBase64":STANDARD.encode(png(90))})
        )
        .is_err());
    s.unknown_work(epoch, &work, "local evidence publication failed")
        .unwrap();
    c.execute_batch("DROP TRIGGER temporary_stage_failure")
        .unwrap();
    s.retry_local_results().unwrap();
    assert_eq!(s.queue_snapshot().unwrap().succeeded, 1);
    assert!(s.claim_queue_work(epoch).unwrap().is_none());
}

#[test]
fn only_correlated_terminal_provider_evidence_releases_uncertain_text_slot() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = super::draft_tests::imported(&f, &s);
    s.request_text_authoring(RequestTextAuthoring {
        project_id: d.summary.project_id,
        expected_revision: 1,
        operation_id: "terminal".into(),
        attempt_id: "terminal-attempt".into(),
        stage: V3TextStage::Outline,
    })
    .unwrap();
    let epoch = s.begin_queue_runtime().unwrap();
    let work = s.claim_queue_work(epoch).unwrap().unwrap();
    let provider = TextProviderIdentity {
        thread_id: "t".into(),
        turn_id: Some("turn".into()),
    };
    s.provider_identity(epoch, &work, provider.clone()).unwrap();
    s.cancel_text_authoring("terminal", false).unwrap();
    s.unknown_work(epoch, &work, "connection lost").unwrap();
    assert!(s
        .terminal_work(
            epoch,
            &work,
            TextProviderIdentity {
                thread_id: "wrong".into(),
                turn_id: Some("turn".into())
            },
            &json!({"kind":"cancelled"})
        )
        .is_err());
    assert_eq!(s.queue_snapshot().unwrap().remote_active, 1);
    s.terminal_work(epoch, &work, provider, &json!({"kind":"cancelled"}))
        .unwrap();
    assert_eq!(s.queue_snapshot().unwrap().remote_active, 0);
    assert_eq!(
        s.text_operation("terminal").unwrap().status,
        V3TextStatus::Cancelled
    );
}

#[test]
fn host_late_text_callbacks_retain_result_without_overwriting_stale_cancelled_or_abandoned_drafts()
{
    for mode in ["stale", "cancelled", "abandoned"] {
        let f = Fixture::new(5);
        let s = f.service();
        let d = super::draft_tests::imported(&f, &s);
        s.request_text_authoring(RequestTextAuthoring {
            project_id: d.summary.project_id.clone(),
            expected_revision: 1,
            operation_id: "late".into(),
            attempt_id: "late-attempt".into(),
            stage: V3TextStage::Outline,
        })
        .unwrap();
        let epoch = s.begin_queue_runtime().unwrap();
        let work = s.claim_queue_work(epoch).unwrap().unwrap();
        let provider = TextProviderIdentity {
            thread_id: "t".into(),
            turn_id: Some("turn".into()),
        };
        s.provider_identity(epoch, &work, provider.clone()).unwrap();
        if mode == "stale" {
            s.save_draft_pair(SaveDraftPair {
                project_id: d.summary.project_id.clone(),
                expected_revision: 1,
                stage: V3TextStage::Outline,
                envelope: f.pair["outline"].clone(),
            })
            .unwrap();
        } else {
            s.cancel_text_authoring("late", mode == "abandoned")
                .unwrap();
        }
        let before = s.load_v3_project(&d.summary.project_id).unwrap();
        s.complete_work(
            epoch,
            &work,
            provider,
            &json!({"kind":"text","envelope":f.pair["outline"]}),
        )
        .unwrap();
        assert_eq!(s.load_v3_project(&d.summary.project_id).unwrap(), before);
        let op = s.text_operation("late").unwrap();
        assert!(op.result.is_some());
        assert!(op.commit.is_none());
        assert_eq!(
            op.status,
            match mode {
                "stale" => V3TextStatus::Conflict,
                "cancelled" => V3TextStatus::Cancelled,
                _ => V3TextStatus::Abandoned,
            }
        );
    }
}
