use digital_twin_desktop_lib::presales_queue::{
    EnqueueBatch, EnqueueJob, ImageReference, JobStatus, ProviderIdentity, QueueJob, QueueStore,
    QueueTarget, StagedResult, VersionHash,
};
use rusqlite::Connection;
use std::sync::{Arc, Barrier};
use std::time::{SystemTime, UNIX_EPOCH};

fn path(label: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("queue-lifecycle-{label}-{nonce}.sqlite3"))
}

fn input(n: usize, slide: &str) -> EnqueueBatch {
    let version = VersionHash {
        version: "v1".into(),
        sha256: "a".repeat(64),
    };
    EnqueueBatch {
        batch_id: format!("b{n}"),
        jobs: vec![EnqueueJob {
            request_id: format!("r{n}"),
            attempt_id: format!("a{n}"),
            target: QueueTarget {
                project_id: "synthetic".into(),
                slide_id: slide.into(),
                spec: version.clone(),
                design: version.clone(),
                skill: version.clone(),
                palette: version,
                parent_visual: Some(ImageReference {
                    asset_id: "parent".into(),
                    sha256: "b".repeat(64),
                }),
                references: vec![ImageReference {
                    asset_id: "reference".into(),
                    sha256: "c".repeat(64),
                }],
                prompt_version: "v1".into(),
                reference_context: vec![],
                prompt: "Synthetic manifest test only".into(),
                feedback: "Original feedback\n保留原文".into(),
            },
        }],
    }
}

fn manifest(job: &QueueJob) -> StagedResult {
    StagedResult {
        relative_path: format!("queue-results/{}/{}.png", job.request_id, job.attempt_id),
        sha256: "d".repeat(64),
        byte_length: 42,
    }
}

fn identity(turn: Option<&str>) -> ProviderIdentity {
    ProviderIdentity {
        thread_id: "thread-1".into(),
        turn_id: turn.map(str::to_owned),
    }
}

fn fixture() -> (QueueStore, i64, QueueJob) {
    let mut store = QueueStore::open_in_memory().unwrap();
    store.set_concurrency(1).unwrap();
    store.enqueue(input(1, "s1")).unwrap();
    store.enqueue(input(2, "s2")).unwrap();
    let epoch = store.begin_runtime().unwrap().settings.epoch;
    let job = store.claim_next(epoch).unwrap().unwrap();
    (store, epoch, job)
}

#[test]
fn pending_cancel_and_unknown_hold_slots_until_proven_terminal() {
    let (mut store, epoch, job) = fixture();
    let unknown = store
        .mark_outcome_unknown(epoch, &job.request_id, &job.attempt_id, "connection lost")
        .unwrap();
    assert_eq!(unknown.status, JobStatus::OutcomeUnknown);
    assert!(store.claim_next(epoch).unwrap().is_none());
    let cancel = store.request_cancel(&job.request_id).unwrap();
    assert_eq!(cancel.status, JobStatus::CancelRequested);
    assert!(store.claim_next(epoch).unwrap().is_none());
    let terminal = store
        .confirm_cancelled(epoch, &job.request_id, &job.attempt_id)
        .unwrap();
    assert_eq!(terminal.status, JobStatus::Cancelled);
    assert_eq!(terminal.target, job.target);
    assert_eq!(terminal.dispatched_at_ms, job.dispatched_at_ms);
    assert_eq!(store.claim_next(epoch).unwrap().unwrap().request_id, "r2");
    assert_eq!(
        store.recovery_snapshot().unwrap().unresolved_remote_count,
        0
    );
}

#[test]
fn result_ready_releases_provider_slot_but_preserves_page_lock_and_snapshot() {
    let (mut store, epoch, job) = fixture();
    let ready = store
        .record_result_ready(epoch, "r1", "a1", manifest(&job))
        .unwrap();
    assert_eq!(ready.status, JobStatus::ResultReady);
    assert_eq!(ready.result, Some(manifest(&job)));
    assert_eq!(ready.target, job.target);
    assert_eq!(store.claim_next(epoch).unwrap().unwrap().request_id, "r2");
    let reused = store.enqueue(input(3, "s1")).unwrap();
    assert_eq!(reused.jobs, vec![ready]);
    assert_eq!(reused.reused_request_ids, vec!["r1"]);
}

#[test]
fn queued_cancel_never_dispatches_and_failed_page_does_not_block_next_page() {
    let (mut store, epoch, _) = fixture();
    assert_eq!(
        store.request_cancel("r2").unwrap().status,
        JobStatus::Cancelled
    );
    store.enqueue(input(3, "s3")).unwrap();
    let failed = store
        .mark_failed(epoch, "r1", "a1", "remote failed")
        .unwrap();
    assert_eq!(failed.status, JobStatus::Failed);
    assert_eq!(failed.error.as_deref(), Some("remote failed"));
    assert_eq!(store.claim_next(epoch).unwrap().unwrap().request_id, "r3");
}

#[test]
fn provider_identity_persists_incrementally_and_replay_returns_current_job() {
    let db = path("identity");
    let mut store = QueueStore::open(&db).unwrap();
    store.enqueue(input(1, "s1")).unwrap();
    let epoch = store.begin_runtime().unwrap().settings.epoch;
    store.claim_next(epoch).unwrap();
    let running = store
        .record_provider(epoch, "r1", "a1", identity(None))
        .unwrap();
    assert_eq!(running.status, JobStatus::Running);
    assert_eq!(
        QueueStore::open(&db).unwrap().get_job("r1").unwrap(),
        Some(running)
    );
    let enriched = store
        .record_provider(epoch, "r1", "a1", identity(Some("turn-1")))
        .unwrap();
    let history = store.events("r1").unwrap();
    assert_eq!(
        store
            .record_provider(epoch, "r1", "a1", identity(None))
            .unwrap(),
        enriched
    );
    assert_eq!(store.events("r1").unwrap(), history);
    assert!(store
        .record_provider(epoch, "r1", "a1", identity(Some("turn-2")))
        .is_err());
    let terminal = store
        .mark_failed(epoch, "r1", "a1", "remote failed")
        .unwrap();
    assert_eq!(
        store
            .record_provider(epoch, "r1", "a1", identity(None))
            .unwrap(),
        terminal
    );
    assert!(store
        .record_provider(
            epoch,
            "r1",
            "a1",
            ProviderIdentity {
                thread_id: "other".into(),
                turn_id: None
            }
        )
        .is_err());
    let history = store.events("r1").unwrap();
    assert_eq!(
        store
            .mark_failed(epoch, "r1", "a1", "remote failed")
            .unwrap(),
        terminal
    );
    assert!(store
        .mark_failed(epoch, "r1", "a1", "different error")
        .is_err());
    assert_eq!(store.events("r1").unwrap(), history);
    assert_eq!(store.get_job("r1").unwrap(), Some(terminal));
}

#[test]
fn reopen_does_not_restart_but_supervisor_recovery_fences_all_old_callbacks() {
    let db = path("restart");
    let mut store = QueueStore::open(&db).unwrap();
    store.enqueue(input(1, "s1")).unwrap();
    let first = store.begin_runtime().unwrap().settings.epoch;
    let claimed = store.claim_next(first).unwrap().unwrap();
    store
        .record_provider(first, "r1", "a1", identity(None))
        .unwrap();
    let pending = store.request_cancel("r1").unwrap();
    drop(store);
    let mut store = QueueStore::open(&db).unwrap();
    assert_eq!(store.get_job("r1").unwrap(), Some(pending.clone()));
    assert_eq!(store.settings().unwrap().epoch, first);
    let recovered = store.begin_runtime().unwrap();
    let second = recovered.settings.epoch;
    assert_eq!(second, first + 1);
    assert_eq!(recovered.unresolved_remote_count, 1);
    let job = &recovered.jobs[0];
    assert_eq!(job.status, JobStatus::OutcomeUnknown);
    assert_eq!(job.epoch, Some(second));
    assert_eq!(job.target, claimed.target);
    assert_eq!(job.provider, pending.provider);
    assert_eq!(job.created_at_ms, claimed.created_at_ms);
    assert_eq!(job.dispatched_at_ms, claimed.dispatched_at_ms);
    let before = store.events("r1").unwrap();
    assert!(store.claim_next(first).is_err());
    assert!(store
        .record_provider(first, "r1", "a1", identity(None))
        .is_err());
    assert!(store.confirm_cancelled(first, "r1", "a1").is_err());
    assert!(store.mark_failed(first, "r1", "a1", "failure").is_err());
    assert!(store
        .mark_outcome_unknown(first, "r1", "a1", "timeout")
        .is_err());
    assert!(store
        .record_result_ready(first, "r1", "a1", manifest(job))
        .is_err());
    assert_eq!(store.events("r1").unwrap(), before);
    let again = store.begin_runtime().unwrap();
    assert_eq!(again.jobs[0].epoch, Some(second + 1));
    assert_eq!(again.jobs[0].status, JobStatus::OutcomeUnknown);
    assert!(store.claim_next(second + 1).unwrap().is_none());
    assert_eq!(
        store
            .record_provider(second + 1, "r1", "a1", identity(Some("turn-1")))
            .unwrap()
            .status,
        JobStatus::OutcomeUnknown
    );
    let cancelled_again = store.request_cancel("r1").unwrap();
    assert_eq!(cancelled_again.status, JobStatus::CancelRequested);
    assert_eq!(cancelled_again.epoch, Some(second + 1));
    assert_eq!(cancelled_again.target, claimed.target);
    let history = store.events("r1").unwrap();
    assert_eq!(store.request_cancel("r1").unwrap(), cancelled_again);
    assert_eq!(store.events("r1").unwrap(), history);
    assert_eq!(
        store.recovery_snapshot().unwrap().unresolved_remote_count,
        1
    );
    assert_eq!(
        store
            .confirm_cancelled(second + 1, "r1", "a1")
            .unwrap()
            .status,
        JobStatus::Cancelled
    );
}

#[test]
fn recovered_result_preserves_durable_cancel_intent() {
    let (mut store, first_epoch, job) = fixture();
    store.request_cancel(&job.request_id).unwrap();

    let second_epoch = store.begin_runtime().unwrap().settings.epoch;
    assert_eq!(second_epoch, first_epoch + 1);
    assert_eq!(
        store.get_job(&job.request_id).unwrap().unwrap().status,
        JobStatus::OutcomeUnknown
    );

    let cancelled = store
        .record_result_ready(
            second_epoch,
            &job.request_id,
            &job.attempt_id,
            manifest(&job),
        )
        .unwrap();
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    assert_eq!(cancelled.result, None);
}

#[test]
fn recovery_leaves_queued_ready_and_terminal_rows_untouched_and_overflow_is_atomic() {
    let db = path("epoch");
    let mut store = QueueStore::open(&db).unwrap();
    store.enqueue(input(1, "s1")).unwrap();
    store.enqueue(input(2, "s2")).unwrap();
    store.enqueue(input(3, "s3")).unwrap();
    let epoch = store.begin_runtime().unwrap().settings.epoch;
    let one = store.claim_next(epoch).unwrap().unwrap();
    store
        .record_result_ready(epoch, "r1", "a1", manifest(&one))
        .unwrap();
    store.request_cancel("r2").unwrap();
    let before = store.list_jobs().unwrap();
    assert_eq!(store.begin_runtime().unwrap().jobs, before);
    Connection::open(&db)
        .unwrap()
        .execute("UPDATE queue_settings SET epoch = ?1", [i64::MAX])
        .unwrap();
    let snapshot = store.recovery_snapshot().unwrap();
    assert!(store.begin_runtime().is_err());
    assert_eq!(store.recovery_snapshot().unwrap(), snapshot);
}

#[test]
fn abandonment_requires_acknowledgement_and_stale_results_only_audit_old_attempt() {
    let (mut store, epoch, job) = fixture();
    store
        .mark_outcome_unknown(epoch, "r1", "a1", "timeout")
        .unwrap();
    let before = store.recovery_snapshot().unwrap();
    assert!(store.abandon_unresolved("r1", false).is_err());
    assert_eq!(store.recovery_snapshot().unwrap(), before);
    let abandoned = store.abandon_unresolved("r1", true).unwrap();
    assert_eq!(abandoned.status, JobStatus::AbandonedUnresolved);
    let fresh = store.enqueue(input(3, "s1")).unwrap().jobs.remove(0);
    assert_eq!(fresh.request_id, "r3");
    assert!(store
        .record_late_result("r1", "a3", manifest(&job))
        .is_err());
    store
        .record_late_result("r1", "a1", manifest(&job))
        .unwrap();
    let history = store.events("r1").unwrap();
    store
        .record_late_result("r1", "a1", manifest(&job))
        .unwrap();
    assert_eq!(store.events("r1").unwrap(), history);
    let mut different = manifest(&job);
    different.byte_length += 1;
    assert!(store.record_late_result("r1", "a1", different).is_err());
    let current = store.get_job("r1").unwrap().unwrap();
    assert_eq!(current.status, JobStatus::AbandonedUnresolved);
    assert_eq!(current.result, None);
    assert_eq!(current.target, abandoned.target);
    assert_eq!(store.get_job("r3").unwrap(), Some(fresh));
    assert_eq!(
        store.recovery_snapshot().unwrap().unresolved_remote_count,
        1
    );
    assert_eq!(store.begin_runtime().unwrap().unresolved_remote_count, 1);
    assert_eq!(
        store.claim_next(epoch + 1).unwrap().unwrap().request_id,
        "r2"
    );
    assert!(store
        .record_result_ready(epoch + 1, "r1", "a1", manifest(&job))
        .is_err());
}

#[test]
fn same_page_allows_six_manual_requests_after_confirmed_terminal_with_fresh_ids() {
    let mut store = QueueStore::open_in_memory().unwrap();
    let epoch = store.begin_runtime().unwrap().settings.epoch;
    for n in 1..=6 {
        let enqueue = input(n, "s1");
        let job = store.enqueue(enqueue.clone()).unwrap().jobs.remove(0);
        store.claim_next(epoch).unwrap().unwrap();
        let terminal = store
            .mark_failed(epoch, &job.request_id, &job.attempt_id, "proven failure")
            .unwrap();
        assert_eq!(store.enqueue(enqueue).unwrap().jobs, vec![terminal]);
        assert_eq!(store.list_jobs().unwrap().len(), n);
    }
}

#[test]
fn invalid_evidence_never_mutates_durable_job_or_history() {
    let (mut store, epoch, job) = fixture();
    let before = store.events("r1").unwrap();
    for thread in [
        "".to_string(),
        " ".into(),
        "x\ny".into(),
        "x\u{7f}".into(),
        "x".repeat(257),
    ] {
        assert!(store
            .record_provider(
                epoch,
                "r1",
                "a1",
                ProviderIdentity {
                    thread_id: thread,
                    turn_id: None
                }
            )
            .is_err());
    }
    for turn in ["".to_string(), " ".into(), "x\ty".into(), "x".repeat(257)] {
        assert!(store
            .record_provider(epoch, "r1", "a1", identity(Some(&turn)))
            .is_err());
    }
    for error in ["".to_string(), " ".into(), "x".repeat(4097)] {
        assert!(store.mark_failed(epoch, "r1", "a1", &error).is_err());
        assert!(store
            .mark_outcome_unknown(epoch, "r1", "a1", &error)
            .is_err());
    }
    for relative_path in [
        "https://example.invalid/a.png",
        "/queue-results/r1/a1.png",
        "queue-results/r1/../a1.png",
        "queue-results\\r1\\a1.png",
        "data:image/png;base64,AAAA",
        "queue-results/r2/a1.png",
    ] {
        let mut bad = manifest(&job);
        bad.relative_path = relative_path.into();
        assert!(store.record_result_ready(epoch, "r1", "a1", bad).is_err());
    }
    for bytes in [0, 52_428_801, u64::MAX] {
        let mut bad = manifest(&job);
        bad.byte_length = bytes;
        assert!(store.record_result_ready(epoch, "r1", "a1", bad).is_err());
    }
    for hash in ["a".repeat(63), "g".repeat(64), "D".repeat(64)] {
        let mut bad = manifest(&job);
        bad.sha256 = hash;
        assert!(store.record_result_ready(epoch, "r1", "a1", bad).is_err());
    }
    assert!(store.confirm_cancelled(epoch, "r1", "a2").is_err());
    assert_eq!(store.get_job("r1").unwrap(), Some(job));
    assert_eq!(store.events("r1").unwrap(), before);
}

#[test]
fn cancellation_winning_result_order_records_only_audit_and_replays_exact_manifest() {
    let (mut store, epoch, job) = fixture();
    store.request_cancel("r1").unwrap();
    assert_eq!(
        store
            .record_provider(epoch, "r1", "a1", identity(None))
            .unwrap()
            .status,
        JobStatus::CancelRequested
    );
    let cancelled = store
        .record_result_ready(epoch, "r1", "a1", manifest(&job))
        .unwrap();
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    assert!(cancelled.result.is_none());
    let history = store.events("r1").unwrap();
    assert!(history
        .iter()
        .any(|event| event.detail.to_string().contains("queue-results/r1/a1.png")));
    assert_eq!(
        store
            .record_result_ready(epoch, "r1", "a1", manifest(&job))
            .unwrap(),
        cancelled
    );
    let mut changed = manifest(&job);
    changed.sha256 = "e".repeat(64);
    assert!(store
        .record_result_ready(epoch, "r1", "a1", changed)
        .is_err());
    assert_eq!(store.events("r1").unwrap(), history);
    assert_eq!(store.claim_next(epoch).unwrap().unwrap().request_id, "r2");
}

#[test]
fn real_connection_cancel_result_races_are_linearizable_in_both_orders() {
    for result_first in [false, true] {
        let db = path("ordered-race");
        let mut store = QueueStore::open(&db).unwrap();
        store.enqueue(input(1, "s1")).unwrap();
        let epoch = store.begin_runtime().unwrap().settings.epoch;
        let job = store.claim_next(epoch).unwrap().unwrap();
        let mut peer = QueueStore::open(&db).unwrap();
        if result_first {
            let ready = peer
                .record_result_ready(epoch, "r1", "a1", manifest(&job))
                .unwrap();
            assert!(store.request_cancel("r1").is_err());
            assert_eq!(store.get_job("r1").unwrap(), Some(ready));
        } else {
            store.request_cancel("r1").unwrap();
            let cancelled = peer
                .record_result_ready(epoch, "r1", "a1", manifest(&job))
                .unwrap();
            assert_eq!(cancelled.status, JobStatus::Cancelled);
            assert!(cancelled.result.is_none());
        }
    }
    for _ in 0..8 {
        let db = path("concurrent-race");
        let mut store = QueueStore::open(&db).unwrap();
        store.enqueue(input(1, "s1")).unwrap();
        let epoch = store.begin_runtime().unwrap().settings.epoch;
        let job = store.claim_next(epoch).unwrap().unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let peer_barrier = barrier.clone();
        let mut peer = QueueStore::open(&db).unwrap();
        let handle = std::thread::spawn(move || {
            peer_barrier.wait();
            peer.record_result_ready(epoch, "r1", "a1", manifest(&job))
        });
        barrier.wait();
        let cancel = store.request_cancel("r1");
        handle.join().unwrap().unwrap();
        let current = store.get_job("r1").unwrap().unwrap();
        if cancel.is_ok() {
            assert_eq!(current.status, JobStatus::Cancelled);
            assert!(current.result.is_none());
        } else {
            assert_eq!(current.status, JobStatus::ResultReady);
            assert!(current.result.is_some());
        }
    }
}

#[test]
fn illegal_transitions_cannot_overwrite_terminal_or_queued_rows() {
    for end in ["queued", "cancelled", "failed", "ready", "abandoned"] {
        let (mut store, epoch, job) = fixture();
        let (request, attempt) = if end == "queued" {
            ("r2", "a2")
        } else {
            ("r1", "a1")
        };
        match end {
            "cancelled" => {
                store.confirm_cancelled(epoch, request, attempt).unwrap();
            }
            "failed" => {
                store
                    .mark_failed(epoch, request, attempt, "failure")
                    .unwrap();
            }
            "ready" => {
                store
                    .record_result_ready(epoch, request, attempt, manifest(&job))
                    .unwrap();
            }
            "abandoned" => {
                store.request_cancel(request).unwrap();
                store.abandon_unresolved(request, true).unwrap();
            }
            _ => {}
        }
        let before = store.get_job(request).unwrap();
        let valid_manifest = manifest(before.as_ref().unwrap());
        let history = store.events(request).unwrap();
        assert!(store
            .record_provider(epoch, request, attempt, identity(None))
            .is_err());
        assert!(store
            .mark_failed(epoch, request, attempt, "different failure")
            .is_err());
        assert!(store
            .mark_outcome_unknown(epoch, request, attempt, "timeout")
            .is_err());
        if end != "cancelled" {
            assert!(store.confirm_cancelled(epoch, request, attempt).is_err());
        }
        if end != "ready" {
            assert!(store
                .record_result_ready(epoch, request, attempt, valid_manifest.clone())
                .is_err());
        }
        if end != "abandoned" {
            assert!(store.abandon_unresolved(request, true).is_err());
        }
        if end != "abandoned" {
            assert!(store
                .record_late_result(request, attempt, valid_manifest)
                .is_err());
        }
        if matches!(end, "failed" | "ready" | "abandoned") {
            assert!(store.request_cancel(request).is_err());
        }
        assert_eq!(store.get_job(request).unwrap(), before);
        assert_eq!(store.events(request).unwrap(), history);
    }
}

#[test]
fn lifecycle_events_are_native_ordered_atomic_and_exact_replay_has_no_history() {
    let db = path("atomic");
    let mut store = QueueStore::open(&db).unwrap();
    store.enqueue(input(1, "s1")).unwrap();
    let epoch = store.begin_runtime().unwrap().settings.epoch;
    let job = store.claim_next(epoch).unwrap().unwrap();
    let sql = Connection::open(&db).unwrap();
    // Reject all lifecycle event INSERTs to prove state+audit are one transaction.
    sql.execute_batch("CREATE TRIGGER reject_lifecycle_event BEFORE INSERT ON queue_lifecycle_events BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;").unwrap();
    assert!(store.request_cancel("r1").is_err());
    assert_eq!(store.get_job("r1").unwrap(), Some(job.clone()));
    sql.execute_batch("DROP TRIGGER reject_lifecycle_event;")
        .unwrap();
    let cancelled = store.request_cancel("r1").unwrap();
    let history = store.events("r1").unwrap();
    assert!(!history.is_empty());
    assert!(history
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
    assert!(history.iter().all(|event| event.request_id == "r1"
        && event.attempt_id == "a1"
        && event.created_at_ms >= job.created_at_ms));
    assert_eq!(
        history.last().unwrap().created_at_ms,
        cancelled.updated_at_ms
    );
    assert_eq!(store.request_cancel("r1").unwrap(), cancelled);
    assert_eq!(store.events("r1").unwrap(), history);
}

#[test]
fn unreleased_v1_queue_is_rejected_without_migration_or_mutation() {
    let db = path("v1");
    let mut store = QueueStore::open(&db).unwrap();
    store.enqueue(input(1, "s1")).unwrap();
    drop(store);
    let sql = Connection::open(&db).unwrap();
    // Reconstruct the Task 1 schema, preserving its original immutable data.
    sql.execute_batch("DROP TABLE IF EXISTS queue_lifecycle_events; PRAGMA user_version = 1; PRAGMA journal_mode = DELETE;").unwrap();
    drop(sql);
    let before = std::fs::read(&db).unwrap();
    assert!(QueueStore::open(&db).is_err());
    assert_eq!(std::fs::read(&db).unwrap(), before);
}

#[test]
fn all_active_source_transitions_preserve_immutable_request_and_timing() {
    for source in [
        "dispatching",
        "running",
        "cancel_requested",
        "outcome_unknown",
    ] {
        for operation in ["cancel", "confirm", "fail", "unknown", "result", "abandon"] {
            let (mut store, epoch, original) = fixture();
            match source {
                "running" => {
                    store
                        .record_provider(epoch, "r1", "a1", identity(None))
                        .unwrap();
                }
                "cancel_requested" => {
                    store.request_cancel("r1").unwrap();
                }
                "outcome_unknown" => {
                    store
                        .mark_outcome_unknown(epoch, "r1", "a1", "prior timeout")
                        .unwrap();
                }
                _ => {}
            }
            let before = store.get_job("r1").unwrap().unwrap();
            let history = store.events("r1").unwrap();
            let (outcome, expected) = match operation {
                "cancel" => (store.request_cancel("r1"), Some(JobStatus::CancelRequested)),
                "confirm" => (
                    store.confirm_cancelled(epoch, "r1", "a1"),
                    Some(JobStatus::Cancelled),
                ),
                "fail" => (
                    store.mark_failed(epoch, "r1", "a1", "proven failure"),
                    Some(JobStatus::Failed),
                ),
                "unknown" => (
                    store.mark_outcome_unknown(epoch, "r1", "a1", "new timeout"),
                    if source == "outcome_unknown" {
                        None
                    } else {
                        Some(JobStatus::OutcomeUnknown)
                    },
                ),
                "result" => (
                    store.record_result_ready(epoch, "r1", "a1", manifest(&original)),
                    Some(if source == "cancel_requested" {
                        JobStatus::Cancelled
                    } else {
                        JobStatus::ResultReady
                    }),
                ),
                "abandon" => (
                    store.abandon_unresolved("r1", true),
                    if matches!(source, "cancel_requested" | "outcome_unknown") {
                        Some(JobStatus::AbandonedUnresolved)
                    } else {
                        None
                    },
                ),
                _ => unreachable!(),
            };
            if let Some(expected) = expected {
                let after = outcome.unwrap();
                assert_eq!(after.status, expected, "{source} {operation}");
                assert_eq!(after.target, original.target);
                assert_eq!(after.request_id, original.request_id);
                assert_eq!(after.attempt_id, original.attempt_id);
                assert_eq!(after.created_at_ms, original.created_at_ms);
                assert_eq!(after.dispatched_at_ms, original.dispatched_at_ms);
                assert_eq!(after.provider, before.provider);
                if expected != JobStatus::ResultReady {
                    assert!(after.result.is_none());
                }
            } else {
                assert!(outcome.is_err(), "{source} {operation}");
                assert_eq!(store.get_job("r1").unwrap(), Some(before));
                assert_eq!(store.events("r1").unwrap(), history);
            }
        }
    }
}

#[test]
fn old_evidence_replay_returns_current_state_after_terminal_and_fresh_page_retry() {
    let (mut store, epoch, _) = fixture();
    store
        .mark_outcome_unknown(epoch, "r1", "a1", "timeout")
        .unwrap();
    let failed = store
        .mark_failed(epoch, "r1", "a1", "proven failure")
        .unwrap();
    let fresh = store.enqueue(input(3, "s1")).unwrap().jobs.remove(0);
    let history = store.events("r1").unwrap();
    assert_eq!(
        store
            .mark_outcome_unknown(epoch, "r1", "a1", "timeout")
            .unwrap(),
        failed
    );
    assert_eq!(
        store
            .mark_failed(epoch, "r1", "a1", "proven failure")
            .unwrap(),
        failed
    );
    assert_eq!(store.events("r1").unwrap(), history);
    assert_eq!(store.get_job("r3").unwrap(), Some(fresh));
}

#[test]
fn evidence_byte_limits_accept_boundaries_without_claiming_file_existence() {
    for bytes in [1, 52_428_800] {
        let (mut store, epoch, job) = fixture();
        let provider = ProviderIdentity {
            thread_id: "é".repeat(128),
            turn_id: Some("t".repeat(256)),
        };
        store
            .record_provider(epoch, "r1", "a1", provider.clone())
            .unwrap();
        let mut too_long = provider;
        too_long.thread_id.push('x');
        assert!(store.record_provider(epoch, "r1", "a1", too_long).is_err());
        store
            .mark_outcome_unknown(epoch, "r1", "a1", &"x".repeat(4096))
            .unwrap();
        let mut declaration = manifest(&job);
        declaration.byte_length = bytes;
        let ready = store
            .record_result_ready(epoch, "r1", "a1", declaration.clone())
            .unwrap();
        assert_eq!(ready.result, Some(declaration.clone()));
        let history = store.events("r1").unwrap();
        assert_eq!(
            store
                .record_result_ready(epoch, "r1", "a1", declaration)
                .unwrap(),
            ready
        );
        assert_eq!(store.events("r1").unwrap(), history);
    }
    let (mut store, epoch, _) = fixture();
    assert_eq!(
        store
            .mark_failed(epoch, "r1", "a1", &"é".repeat(2048))
            .unwrap()
            .status,
        JobStatus::Failed
    );
}

#[test]
fn recovery_rolls_back_epoch_and_all_jobs_if_one_audit_insert_fails() {
    let db = path("recovery-rollback");
    let mut store = QueueStore::open(&db).unwrap();
    for n in 1..=3 {
        store.enqueue(input(n, &format!("s{n}"))).unwrap();
    }
    let epoch = store.begin_runtime().unwrap().settings.epoch;
    for _ in 1..=3 {
        store.claim_next(epoch).unwrap().unwrap();
    }
    store
        .record_provider(epoch, "r2", "a2", identity(None))
        .unwrap();
    store.request_cancel("r3").unwrap();
    let before = store.recovery_snapshot().unwrap();
    let sql = Connection::open(&db).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_recovery BEFORE INSERT ON queue_lifecycle_events WHEN NEW.request_id = 'r2' BEGIN SELECT RAISE(ABORT, 'synthetic second recovery failure'); END;").unwrap();
    assert!(store.begin_runtime().is_err());
    assert_eq!(store.recovery_snapshot().unwrap(), before);
    assert!(store.events("r1").unwrap().is_empty());
    sql.execute_batch("DROP TRIGGER reject_recovery;").unwrap();
    let recovered = store.begin_runtime().unwrap();
    assert_eq!(recovered.settings.epoch, epoch + 1);
    assert_eq!(recovered.unresolved_remote_count, 3);
    for job in recovered.jobs {
        assert_eq!(job.status, JobStatus::OutcomeUnknown);
        assert_eq!(job.epoch, Some(epoch + 1));
    }
}

#[test]
fn concurrent_restart_fences_result_callback_or_preserves_completed_result() {
    for _ in 0..8 {
        let db = path("restart-race");
        let mut store = QueueStore::open(&db).unwrap();
        store.enqueue(input(1, "s1")).unwrap();
        let epoch = store.begin_runtime().unwrap().settings.epoch;
        let job = store.claim_next(epoch).unwrap().unwrap();
        let mut peer = QueueStore::open(&db).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let peer_barrier = barrier.clone();
        let handle = std::thread::spawn(move || {
            peer_barrier.wait();
            peer.record_result_ready(epoch, "r1", "a1", manifest(&job))
        });
        barrier.wait();
        let recovered = store.begin_runtime().unwrap();
        let result = handle.join().unwrap();
        let current = store.get_job("r1").unwrap().unwrap();
        assert_eq!(recovered.settings.epoch, epoch + 1);
        if let Ok(ready) = result {
            assert_eq!(current, ready);
            assert_eq!(current.status, JobStatus::ResultReady);
            assert_eq!(current.epoch, Some(epoch));
        } else {
            assert_eq!(current.status, JobStatus::OutcomeUnknown);
            assert_eq!(current.epoch, Some(epoch + 1));
            assert!(current.result.is_none());
        }
    }
}
