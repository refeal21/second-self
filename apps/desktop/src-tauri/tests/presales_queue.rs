use digital_twin_desktop_lib::presales_queue::{
    EnqueueBatch, EnqueueJob, ImageReference, JobStatus, QueueStore, QueueTarget, VersionHash,
};
use rusqlite::Connection;
use serde_json::json;
use std::sync::{Arc, Barrier};
use std::time::{SystemTime, UNIX_EPOCH};

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const QUEUE_APPLICATION_ID: i64 = 0x44545133;

#[path = "support/v3_temp.rs"]
mod tempfile;

#[test]
fn invalid_queue_only_batch_keeps_validation_precedence_under_writer_contention() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("queue.sqlite3");
    let mut store = QueueStore::open(&path).unwrap();
    let other = Connection::open(&path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let error = store.enqueue(batch("invalid", vec![])).unwrap_err();
    assert!(
        error.contains("jobs"),
        "original validation must run before acquiring writer lock: {error}"
    );
    other.execute_batch("ROLLBACK").unwrap();
}

fn temporary_database(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("presales-queue-{name}-{nonce}.sqlite3"))
}

fn target(project_id: &str, slide_id: &str) -> QueueTarget {
    QueueTarget {
        project_id: project_id.into(),
        slide_id: slide_id.into(),
        spec: VersionHash {
            version: "spec-v1".into(),
            sha256: HASH_A.into(),
        },
        design: VersionHash {
            version: "design-v1".into(),
            sha256: HASH_B.into(),
        },
        skill: VersionHash {
            version: "skill-v1".into(),
            sha256: HASH_C.into(),
        },
        palette: VersionHash {
            version: "palette-v1".into(),
            sha256: HASH_A.into(),
        },
        parent_visual: Some(ImageReference {
            asset_id: "parent-1".into(),
            sha256: HASH_B.into(),
        }),
        references: vec![ImageReference {
            asset_id: "reference-1".into(),
            sha256: HASH_C.into(),
        }],
        prompt_version: "prompt-v1".into(),
        reference_context: vec![],
        prompt: format!("Generate synthetic slide {slide_id}"),
        feedback: "Synthetic feedback only".into(),
    }
}

fn job(request_id: &str, attempt_id: &str, project_id: &str, slide_id: &str) -> EnqueueJob {
    EnqueueJob {
        request_id: request_id.into(),
        attempt_id: attempt_id.into(),
        target: target(project_id, slide_id),
    }
}

fn batch(batch_id: &str, jobs: Vec<EnqueueJob>) -> EnqueueBatch {
    EnqueueBatch {
        batch_id: batch_id.into(),
        jobs,
    }
}

fn five_jobs() -> EnqueueBatch {
    batch(
        "b1",
        vec![
            job("r1", "a1", "p1", "s1"),
            job("r2", "a2", "p2", "s1"),
            job("r3", "a3", "p1", "s2"),
            job("r4", "a4", "p2", "s2"),
            job("r5", "a5", "p1", "s3"),
        ],
    )
}

#[test]
fn contracts_use_camel_case_and_reject_unknown_fields() {
    let encoded = serde_json::to_value(job("r1", "a1", "p1", "s1")).unwrap();
    assert_eq!(encoded["requestId"], "r1");
    assert_eq!(encoded["target"]["parentVisual"]["assetId"], "parent-1");
    assert!(encoded.get("request_id").is_none());
    assert_eq!(
        serde_json::to_value(JobStatus::ResultReady).unwrap(),
        "result_ready"
    );

    let mut unknown = encoded;
    unknown["unexpected"] = json!(true);
    assert!(serde_json::from_value::<EnqueueJob>(unknown).is_err());
}

#[test]
fn empty_store_starts_at_epoch_zero_and_claims_fifo_up_to_default_limit() {
    let mut store = QueueStore::open_in_memory().unwrap();
    assert_eq!(store.settings().unwrap().epoch, 0);
    let input = five_jobs();
    store.enqueue(input.clone()).unwrap();

    for (wanted, original) in ["r1", "r2", "r3", "r4"].into_iter().zip(input.jobs) {
        let claimed = store.claim_next(0).unwrap().unwrap();
        assert_eq!(claimed.request_id, wanted);
        assert_eq!(claimed.status, JobStatus::Dispatching);
        assert_eq!(claimed.epoch, Some(0));
        assert_eq!(claimed.target, original.target);
        assert_eq!(store.get_job(wanted).unwrap(), Some(claimed));
    }
    assert!(store.claim_next(0).unwrap().is_none());
}

#[test]
fn configured_limits_one_two_and_four_bound_claims() {
    for limit in [1_u8, 2, 4] {
        let mut store = QueueStore::open_in_memory().unwrap();
        assert_eq!(store.set_concurrency(limit).unwrap().concurrency, limit);
        store.enqueue(five_jobs()).unwrap();

        for _ in 0..limit {
            assert!(store.claim_next(0).unwrap().is_some());
        }
        assert!(store.claim_next(0).unwrap().is_none(), "limit {limit}");
    }
}

#[test]
fn lowering_limit_holds_existing_slots_and_raising_it_admits_fifo_work() {
    let mut store = QueueStore::open_in_memory().unwrap();
    store.set_concurrency(2).unwrap();
    store.enqueue(five_jobs()).unwrap();
    for wanted in ["r1", "r2"] {
        assert_eq!(store.claim_next(0).unwrap().unwrap().request_id, wanted);
    }

    store.set_concurrency(1).unwrap();
    assert!(store.claim_next(0).unwrap().is_none());
    store.set_concurrency(4).unwrap();
    assert_eq!(store.claim_next(0).unwrap().unwrap().request_id, "r3");
    assert_eq!(store.claim_next(0).unwrap().unwrap().request_id, "r4");
    assert!(store.claim_next(0).unwrap().is_none());
}

#[test]
fn settings_batch_pause_and_dispatching_survive_reopen() {
    let path = temporary_database("reopen");
    {
        let mut store = QueueStore::open(&path).unwrap();
        store.set_concurrency(2).unwrap();
        store.set_paused(true).unwrap();
        store.enqueue(five_jobs()).unwrap();
    }
    {
        let mut reopened = QueueStore::open(&path).unwrap();
        assert_eq!(reopened.settings().unwrap().concurrency, 2);
        assert!(reopened.settings().unwrap().paused);
        assert!(reopened.claim_next(0).unwrap().is_none());
        reopened.set_paused(false).unwrap();
        reopened.set_batch_paused("b1", true).unwrap();
    }
    {
        let mut reopened = QueueStore::open(&path).unwrap();
        assert!(reopened.claim_next(0).unwrap().is_none());
        reopened.set_batch_paused("b1", false).unwrap();
        assert_eq!(reopened.claim_next(0).unwrap().unwrap().request_id, "r1");
    }
    {
        let mut reopened = QueueStore::open(&path).unwrap();
        assert_eq!(reopened.settings().unwrap().concurrency, 2);
        let first = reopened.get_job("r1").unwrap().unwrap();
        assert_eq!(first.status, JobStatus::Dispatching);
        assert_eq!(first.target, target("p1", "s1"));
        assert_eq!(reopened.claim_next(0).unwrap().unwrap().request_id, "r2");
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn native_timestamps_persist_and_dispatch_time_appears_only_after_claim() {
    let path = temporary_database("timestamps");
    let input = batch("b1", vec![job("r1", "a1", "p1", "s1")]);
    let queued = {
        let mut store = QueueStore::open(&path).unwrap();
        store.enqueue(input.clone()).unwrap().jobs.remove(0)
    };
    assert!(queued.created_at_ms > 0);
    assert_eq!(queued.updated_at_ms, queued.created_at_ms);
    assert_eq!(queued.dispatched_at_ms, None);

    let mut reopened = QueueStore::open(&path).unwrap();
    assert_eq!(reopened.get_job("r1").unwrap(), Some(queued.clone()));
    let claimed = reopened.claim_next(0).unwrap().unwrap();
    assert_eq!(claimed.created_at_ms, queued.created_at_ms);
    assert!(claimed.updated_at_ms >= queued.updated_at_ms);
    assert_eq!(claimed.dispatched_at_ms, Some(claimed.updated_at_ms));

    let replay = reopened.enqueue(input).unwrap();
    assert_eq!(replay.jobs, vec![claimed]);
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn exact_batch_replay_returns_original_outcome_without_new_jobs() {
    let mut store = QueueStore::open_in_memory().unwrap();
    let input = batch("b1", vec![job("r1", "a1", "p1", "s1")]);
    let first = store.enqueue(input.clone()).unwrap();
    let replay = store.enqueue(input).unwrap();

    assert_eq!(replay, first);
    assert_eq!(store.list_jobs().unwrap().len(), 1);
}

#[test]
fn busy_page_is_reused_while_other_pages_in_the_batch_progress() {
    let mut store = QueueStore::open_in_memory().unwrap();
    let original = store
        .enqueue(batch("b1", vec![job("r1", "a1", "p1", "s1")]))
        .unwrap()
        .jobs[0]
        .clone();

    let outcome = store
        .enqueue(batch(
            "b2",
            vec![job("r2", "a2", "p1", "s1"), job("r3", "a3", "p1", "s2")],
        ))
        .unwrap();

    assert_eq!(outcome.reused_request_ids, vec!["r1"]);
    assert_eq!(outcome.jobs[0], original);
    assert_eq!(outcome.jobs[1].request_id, "r3");
    assert_eq!(store.list_jobs().unwrap().len(), 2);
    assert_eq!(
        store.get_job("r1").unwrap().unwrap().target,
        target("p1", "s1")
    );
}

#[test]
fn invalid_second_job_rolls_back_the_entire_batch() {
    let mut store = QueueStore::open_in_memory().unwrap();
    let mut invalid = job("r2", "a2", "p1", "s2");
    invalid.target.prompt.clear();
    assert!(store
        .enqueue(batch("b1", vec![job("r1", "a1", "p1", "s1"), invalid]))
        .is_err());
    assert!(store.list_jobs().unwrap().is_empty());
}

#[test]
fn identity_collisions_and_changed_batch_replays_are_rejected_before_page_dedup() {
    let mut store = QueueStore::open_in_memory().unwrap();
    let original = batch("b1", vec![job("r1", "a1", "p1", "s1")]);
    store.enqueue(original.clone()).unwrap();

    assert!(store
        .enqueue(batch("b2", vec![job("r1", "a2", "p1", "s1")]))
        .is_err());
    assert!(store
        .enqueue(batch("b3", vec![job("r2", "a1", "p1", "s1")]))
        .is_err());

    let mut changed = original;
    changed.jobs[0].target.feedback = "Changed feedback".into();
    assert!(store.enqueue(changed).is_err());
    assert_eq!(store.list_jobs().unwrap().len(), 1);
}

#[test]
fn rejects_invalid_bounds_duplicates_and_nul_text() {
    let mut store = QueueStore::open_in_memory().unwrap();
    assert!(store.enqueue(batch("b1", vec![])).is_err());
    assert!(store.set_concurrency(0).is_err());
    assert!(store.set_concurrency(5).is_err());

    let duplicate_page = batch(
        "b2",
        vec![job("r1", "a1", "p1", "s1"), job("r2", "a2", "p1", "s1")],
    );
    assert!(store.enqueue(duplicate_page).is_err());

    let mut duplicate_reference = job("r3", "a3", "p1", "s1");
    duplicate_reference
        .target
        .references
        .push(duplicate_reference.target.references[0].clone());
    assert!(store
        .enqueue(batch("b3", vec![duplicate_reference]))
        .is_err());

    let mut nul = job("r4", "a4", "p1", "s1");
    nul.target.feedback = "bad\0feedback".into();
    assert!(store.enqueue(batch("b4", vec![nul])).is_err());

    let mut uppercase_hash = job("r5", "a5", "p1", "s1");
    uppercase_hash.target.spec.sha256 = "A".repeat(64);
    assert!(store.enqueue(batch("b5", vec![uppercase_hash])).is_err());
}

#[test]
fn wrong_epoch_and_pauses_never_claim() {
    let mut store = QueueStore::open_in_memory().unwrap();
    store
        .enqueue(batch("b1", vec![job("r1", "a1", "p1", "s1")]))
        .unwrap();
    assert!(store.claim_next(1).is_err());
    assert_eq!(
        store.get_job("r1").unwrap().unwrap().status,
        JobStatus::Queued
    );
    store.set_paused(true).unwrap();
    assert!(store.claim_next(0).unwrap().is_none());
}

#[test]
fn separate_connections_racing_claims_never_exceed_the_global_limit() {
    let path = temporary_database("claim-race");
    let mut setup = QueueStore::open(&path).unwrap();
    setup.set_concurrency(2).unwrap();
    setup.enqueue(five_jobs()).unwrap();
    drop(setup);

    let barrier = Arc::new(Barrier::new(5));
    let mut handles = Vec::new();
    let stores: Vec<QueueStore> = (0..4).map(|_| QueueStore::open(&path).unwrap()).collect();
    for mut store in stores {
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            store.claim_next(0).unwrap().map(|job| job.request_id)
        }));
    }
    barrier.wait();
    let mut claimed: Vec<String> = handles
        .into_iter()
        .filter_map(|handle| handle.join().unwrap())
        .collect();
    claimed.sort();
    assert_eq!(claimed, vec!["r1", "r2"]);

    let reopened = QueueStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .list_jobs()
            .unwrap()
            .into_iter()
            .filter(|job| job.status == JobStatus::Dispatching)
            .count(),
        2
    );
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn queue_markers_are_persisted_and_foreign_databases_are_not_mutated() {
    let queue_path = temporary_database("markers");
    drop(QueueStore::open(&queue_path).unwrap());
    let queue = Connection::open(&queue_path).unwrap();
    assert_eq!(
        queue
            .query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        QUEUE_APPLICATION_ID
    );
    assert_eq!(
        queue
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        queue
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    drop(queue);
    std::fs::remove_file(queue_path).unwrap();

    let foreign_path = temporary_database("foreign");
    let foreign = Connection::open(&foreign_path).unwrap();
    foreign
        .execute("CREATE TABLE legacy (value TEXT NOT NULL)", [])
        .unwrap();
    foreign
        .execute("INSERT INTO legacy VALUES ('keep-me')", [])
        .unwrap();
    foreign.pragma_update(None, "application_id", 42).unwrap();
    foreign.pragma_update(None, "user_version", 7).unwrap();
    drop(foreign);

    assert!(QueueStore::open(&foreign_path).is_err());
    let foreign = Connection::open(&foreign_path).unwrap();
    assert_eq!(
        foreign
            .query_row("SELECT value FROM legacy", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "keep-me"
    );
    assert_eq!(
        foreign
            .query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        42
    );
    assert_eq!(
        foreign
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        7
    );
    drop(foreign);
    std::fs::remove_file(foreign_path).unwrap();
}

#[test]
fn identified_database_missing_the_admission_index_is_rejected() {
    let path = temporary_database("missing-index");
    drop(QueueStore::open(&path).unwrap());
    let connection = Connection::open(&path).unwrap();
    connection
        .execute("DROP INDEX queue_jobs_active_page", [])
        .unwrap();
    drop(connection);

    assert!(QueueStore::open(&path).is_err());
    std::fs::remove_file(path).unwrap();
}

fn schema_snapshot(connection: &Connection) -> (i64, i64, String, Vec<(String, String, String)>) {
    let application_id = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .unwrap();
    let user_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    let journal_mode = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    let mut statement = connection
        .prepare(
            "SELECT type, name, coalesce(sql, '') FROM sqlite_master
             WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
        )
        .unwrap();
    let objects = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    (application_id, user_version, journal_mode, objects)
}

#[test]
fn sqlite_prefix_lookalike_table_is_preserved_as_foreign() {
    let path = temporary_database("sqlite-prefix-lookalike");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute("CREATE TABLE sqliteXlegacy (value TEXT NOT NULL)", [])
        .unwrap();
    connection
        .execute("INSERT INTO sqliteXlegacy VALUES ('keep-me')", [])
        .unwrap();
    let before = schema_snapshot(&connection);
    drop(connection);

    assert!(QueueStore::open(&path).is_err());
    let connection = Connection::open(&path).unwrap();
    assert_eq!(schema_snapshot(&connection), before);
    assert_eq!(
        connection
            .query_row("SELECT value FROM sqliteXlegacy", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "keep-me"
    );
    drop(connection);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn view_only_foreign_databases_are_rejected_without_mutation() {
    for name in ["existing_view", "sqliteXlegacy"] {
        let path = temporary_database(name);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(&format!("CREATE VIEW {name} AS SELECT 42 AS value"), [])
            .unwrap();
        let before = schema_snapshot(&connection);
        assert_eq!((before.0, before.1, before.2.as_str()), (0, 0, "delete"));
        drop(connection);
        let bytes_before = std::fs::read(&path).unwrap();

        assert!(QueueStore::open(&path).is_err(), "view {name} was adopted");
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before);
        assert!(!path.with_extension("sqlite3-wal").exists());
        assert!(!path.with_extension("sqlite3-shm").exists());
        let connection = Connection::open(&path).unwrap();
        assert_eq!(schema_snapshot(&connection), before);
        assert_eq!(
            connection
                .query_row(&format!("SELECT value FROM {name}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            42
        );
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }
}

const TEST_QUEUE_SCHEMA: &str = r#"
CREATE TABLE queue_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 4),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    epoch INTEGER NOT NULL
);
CREATE TABLE queue_batches (
    batch_id TEXT PRIMARY KEY,
    input_json TEXT NOT NULL,
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE queue_jobs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES queue_batches(batch_id),
    request_id TEXT NOT NULL UNIQUE,
    attempt_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    target_json TEXT NOT NULL,
    status TEXT NOT NULL,
    epoch INTEGER,
    provider_json TEXT,
    result_json TEXT,
    error TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    dispatched_at_ms INTEGER
);
CREATE UNIQUE INDEX queue_jobs_active_page
ON queue_jobs(project_id, slide_id)
WHERE status IN (
    'queued', 'dispatching', 'running', 'result_ready', 'committing',
    'cancel_requested', 'outcome_unknown'
);
CREATE TABLE queue_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE REFERENCES queue_jobs(request_id),
    target_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE queue_batch_entries (
    batch_id TEXT NOT NULL REFERENCES queue_batches(batch_id),
    ordinal INTEGER NOT NULL,
    submitted_request_id TEXT NOT NULL UNIQUE,
    submitted_attempt_id TEXT NOT NULL UNIQUE,
    resolved_request_id TEXT NOT NULL REFERENCES queue_jobs(request_id),
    reused INTEGER NOT NULL CHECK (reused IN (0, 1)),
    PRIMARY KEY (batch_id, ordinal)
);
CREATE TABLE queue_transition_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES queue_jobs(request_id),
    from_status TEXT,
    to_status TEXT NOT NULL,
    epoch INTEGER,
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE queue_lifecycle_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES queue_jobs(request_id),
    attempt_id TEXT NOT NULL REFERENCES queue_attempts(attempt_id),
    kind TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
"#;

fn create_marked_schema(
    path: &std::path::Path,
    schema: &str,
) -> (i64, i64, String, Vec<(String, String, String)>) {
    let connection = Connection::open(path).unwrap();
    connection.execute_batch(schema).unwrap();
    connection
        .execute(
            "INSERT INTO queue_settings (singleton, concurrency, paused, epoch)
             VALUES (1, 4, 0, 0)",
            [],
        )
        .unwrap();
    connection
        .pragma_update(None, "application_id", QUEUE_APPLICATION_ID)
        .unwrap();
    connection.pragma_update(None, "user_version", 2).unwrap();
    let snapshot = schema_snapshot(&connection);
    drop(connection);
    snapshot
}

fn assert_marked_schema_rejected_without_mutation(name: &str, schema: &str) {
    let path = temporary_database(name);
    let before = create_marked_schema(&path, schema);
    assert_eq!(
        (before.0, before.1, before.2.as_str()),
        (QUEUE_APPLICATION_ID, 2, "delete")
    );
    let bytes_before = std::fs::read(&path).unwrap();
    assert!(
        QueueStore::open(&path).is_err(),
        "mutation {name} was accepted"
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        bytes_before,
        "mutation {name}"
    );
    assert!(!path.with_extension("sqlite3-wal").exists());
    assert!(!path.with_extension("sqlite3-shm").exists());
    let connection = Connection::open(&path).unwrap();
    assert_eq!(schema_snapshot(&connection), before, "mutation {name}");
    assert_eq!(
        connection
            .query_row(
                "SELECT concurrency, paused, epoch FROM queue_settings WHERE singleton = 1",
                [],
                |row| Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?
                )),
            )
            .unwrap(),
        (4, 0, 0)
    );
    drop(connection);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn marked_database_with_unexpected_trigger_is_rejected_without_mutation() {
    let schema = format!(
        "{TEST_QUEUE_SCHEMA}
         CREATE TRIGGER reset_dispatch AFTER UPDATE OF status ON queue_jobs
         WHEN NEW.status = 'dispatching'
         BEGIN UPDATE queue_jobs SET status = 'queued' WHERE request_id = NEW.request_id; END;"
    );
    assert_marked_schema_rejected_without_mutation("unexpected-trigger", &schema);
}

#[test]
fn marked_database_with_unexpected_view_is_rejected_without_mutation() {
    let schema = format!("{TEST_QUEUE_SCHEMA} CREATE VIEW sqliteXlegacy AS SELECT 42 AS value;");
    assert_marked_schema_rejected_without_mutation("unexpected-view", &schema);
}

#[test]
fn marked_database_with_unexpected_index_is_rejected_without_mutation() {
    let schema = format!("{TEST_QUEUE_SCHEMA} CREATE INDEX sqliteXlegacy ON queue_jobs(status);");
    assert_marked_schema_rejected_without_mutation("unexpected-index", &schema);
}

#[test]
fn marked_databases_missing_required_constraints_are_rejected_without_mutation() {
    let cases = [
        (
            "missing-primary-key",
            "singleton INTEGER PRIMARY KEY CHECK (singleton = 1)",
            "singleton INTEGER",
        ),
        (
            "missing-unique",
            "attempt_id TEXT NOT NULL UNIQUE,",
            "attempt_id TEXT NOT NULL,",
        ),
        (
            "missing-foreign-key",
            "batch_id TEXT NOT NULL REFERENCES queue_batches(batch_id),",
            "batch_id TEXT NOT NULL,",
        ),
        (
            "missing-check",
            "paused INTEGER NOT NULL CHECK (paused IN (0, 1)),",
            "paused INTEGER NOT NULL,",
        ),
    ];
    for (name, expected, malformed) in cases {
        let schema = TEST_QUEUE_SCHEMA.replacen(expected, malformed, 1);
        assert_ne!(schema, TEST_QUEUE_SCHEMA, "test mutation {name} must apply");
        assert_marked_schema_rejected_without_mutation(name, &schema);
    }
}

#[test]
fn marked_database_with_uppercase_status_predicate_is_rejected_without_mutation() {
    let schema = TEST_QUEUE_SCHEMA.replacen("'queued'", "'QUEUED'", 1);
    assert_marked_schema_rejected_without_mutation("uppercase-status-literal", &schema);
}

#[test]
fn marked_database_with_merged_primary_key_tokens_is_rejected_without_mutation() {
    let schema = TEST_QUEUE_SCHEMA.replacen("PRIMARY KEY", "PRIMARYKEY", 1);
    assert_marked_schema_rejected_without_mutation("merged-primary-key-tokens", &schema);
}

#[test]
fn marked_database_with_non_sqlite_unicode_whitespace_is_rejected_without_mutation() {
    let schema = TEST_QUEUE_SCHEMA.replacen("PRIMARY KEY", "PRIMARY\u{00a0}KEY", 1);
    assert_marked_schema_rejected_without_mutation("unicode-primary-key-separator", &schema);
}
