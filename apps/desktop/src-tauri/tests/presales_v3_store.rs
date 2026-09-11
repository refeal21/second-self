use digital_twin_desktop_lib::{presales_queue::QueueStore, presales_v3::V3Store};
use rusqlite::Connection;

#[path = "support/v3_temp.rs"]
mod tempfile;

#[test]
fn temporary_directories_retry_existing_names_without_reusing_them() {
    let parent = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir_at(parent.path(), 42).unwrap();
    let second = tempfile::tempdir_at(parent.path(), 42).unwrap();
    assert_ne!(first.path(), second.path());
    drop(second);
    assert!(
        first.path().is_dir(),
        "another fixture cleanup must not delete the first directory"
    );
}

#[test]
fn temporary_directories_are_exclusive_with_identical_concurrent_timestamps() {
    let parent = tempfile::tempdir().unwrap();
    let barrier = std::sync::Barrier::new(16);
    let directories = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..16)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    tempfile::tempdir_at(parent.path(), 42).unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    let paths: std::collections::HashSet<_> = directories.iter().map(|dir| dir.path()).collect();
    assert_eq!(paths.len(), 16);
    assert!(paths.iter().all(|path| path.is_dir()));
}

#[test]
fn empty_catalog_reopens_without_losing_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v3.sqlite3");
    assert!(V3Store::open_in_memory()
        .unwrap()
        .list_projects()
        .unwrap()
        .is_empty());
    let store = V3Store::open(&path).unwrap();
    assert!(store.list_projects().unwrap().is_empty());
    assert!(store.load_project("missing").is_err());
    drop(store);
    assert!(V3Store::open(&path)
        .unwrap()
        .list_projects()
        .unwrap()
        .is_empty());
}

#[test]
fn queue_only_owner_cannot_open_v3_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v3.sqlite3");
    drop(V3Store::open(&path).unwrap());
    let before = std::fs::read(&path).unwrap();
    assert!(QueueStore::open(&path).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
}

#[test]
fn v3_rejects_queue_only_database_before_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("queue.sqlite3");
    drop(QueueStore::open(&path).unwrap());
    let before = std::fs::read(&path).unwrap();
    assert!(V3Store::open(&path).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
}

#[test]
fn foreign_identity_schema_and_version_fail_closed_before_mutation() {
    for alteration in [
        "PRAGMA application_id = 1234",
        "PRAGMA user_version = 2",
        "CREATE TABLE extra_table (id TEXT)",
        "CREATE TRIGGER extra_trigger AFTER INSERT ON v3_projects BEGIN SELECT 1; END",
        "DROP TABLE v3_feedback; CREATE TABLE v3_feedback (id TEXT)",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v3.sqlite3");
        drop(V3Store::open(&path).unwrap());
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch(alteration).unwrap();
        drop(raw);
        let before = std::fs::read(&path).unwrap();
        assert!(V3Store::open(&path).is_err(), "{alteration}");
        assert_eq!(before, std::fs::read(&path).unwrap(), "{alteration}");
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("foreign.sqlite3");
    let raw = Connection::open(&path).unwrap();
    raw.execute("CREATE TABLE foreign_data (id TEXT)", [])
        .unwrap();
    drop(raw);
    let before = std::fs::read(&path).unwrap();
    assert!(V3Store::open(&path).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
}

#[test]
fn feedback_drafts_are_keyed_by_their_base_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v3.sqlite3");
    drop(V3Store::open(&path).unwrap());
    let raw = Connection::open(&path).unwrap();
    raw.pragma_update(None, "foreign_keys", "ON").unwrap();
    raw.execute(
        "INSERT INTO v3_projects VALUES ('project', 'name', '{}', '{}', '{}', 'now', 1)",
        [],
    )
    .unwrap();
    raw.execute("INSERT INTO v3_pages (project_id, slide_id, ordinal, spec_json) VALUES ('project', 'page', 0, '{}')", []).unwrap();
    for base in ["", "visual-v1"] {
        raw.execute("INSERT INTO v3_feedback (project_id, slide_id, base_version_id, revision, draft_json) VALUES ('project', 'page', ?1, 1, '{}')", [base]).unwrap();
    }
    assert!(raw.execute("INSERT INTO v3_feedback (project_id, slide_id, base_version_id, revision, draft_json) VALUES ('project', 'page', 'visual-v1', 2, '{}')", []).is_err());
}

#[test]
fn distinct_import_copies_can_preserve_the_same_origin_digest() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v3.sqlite3");
    drop(V3Store::open(&path).unwrap());
    let raw = Connection::open(&path).unwrap();
    raw.pragma_update(None, "foreign_keys", "ON").unwrap();
    for project in ["copy-a", "copy-b"] {
        raw.execute(
            "INSERT INTO v3_projects VALUES (?1, 'name', '{}', '{}', '{}', 'now', 1)",
            [project],
        )
        .unwrap();
        raw.execute("INSERT INTO v3_import_receipts (import_id, project_id, origin_digest, receipt_json) VALUES (?1, ?1, 'same-origin', '{}')", [project]).unwrap();
    }
    assert!(raw.execute("INSERT INTO v3_import_receipts (import_id, project_id, origin_digest, receipt_json) VALUES ('another-id', 'copy-a', 'same-origin', '{}')", []).is_err());
}

#[test]
fn v3_rows_reject_missing_identity_and_orphan_page() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v3.sqlite3");
    drop(V3Store::open(&path).unwrap());
    let raw = Connection::open(&path).unwrap();
    raw.pragma_update(None, "foreign_keys", "ON").unwrap();
    assert!(raw
        .execute(
            "INSERT INTO v3_projects VALUES (NULL, 'name', '{}', '{}', '{}', 'now', 1)",
            []
        )
        .is_err());
    assert!(raw.execute("INSERT INTO v3_pages (project_id, slide_id, ordinal, spec_json) VALUES ('missing', 'page', 0, '{}')", []).is_err());
}
