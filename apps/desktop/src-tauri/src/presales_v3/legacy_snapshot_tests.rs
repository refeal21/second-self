use super::CapturedLegacySnapshot;
use rusqlite::{params, Connection};
use serde_json::json;
use std::{fs, path::Path};

#[path = "../../tests/support/v3_temp.rs"]
mod temp;

fn fixture(root: &Path, wal: bool) -> Connection {
    let db = Connection::open(root.join("legacy.sqlite3")).unwrap();
    db.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY, pipeline_json TEXT NOT NULL)")
        .unwrap();
    if wal {
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
    }
    db.execute(
        "INSERT INTO projects VALUES (?1, ?2)",
        params![
            "source",
            json!({"schemaVersion":1,
        "revision":1,"project":{"id":"source","name":"Synthetic"}})
            .to_string()
        ],
    )
    .unwrap();
    db
}

#[test]
fn private_snapshot_recovers_live_wal_without_touching_any_source_file() {
    let root = temp::tempdir().unwrap();
    let staging = temp::tempdir().unwrap();
    let writer = fixture(root.path(), true);
    let before: Vec<_> = ["legacy.sqlite3", "legacy.sqlite3-wal", "legacy.sqlite3-shm"]
        .iter()
        .map(|name| fs::read(root.path().join(name)).unwrap())
        .collect();
    let snapshot = CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path(),
    )
    .unwrap();
    assert_eq!(snapshot.project_id(), "source");
    assert_eq!(snapshot.revision(), 1);
    assert!(snapshot.pipeline_json().contains("Synthetic"));
    assert_eq!(
        snapshot.raw_database_bytes(),
        (before[0].as_slice(), Some(before[1].as_slice()))
    );
    let evidence = serde_json::to_value(snapshot.source_evidence()).unwrap();
    assert_eq!(evidence["main"]["byteLength"], before[0].len());
    assert_eq!(evidence["wal"]["byteLength"], before[1].len());
    snapshot.recheck().unwrap();
    for (name, bytes) in ["legacy.sqlite3", "legacy.sqlite3-wal", "legacy.sqlite3-shm"]
        .iter()
        .zip(before)
    {
        assert_eq!(fs::read(root.path().join(name)).unwrap(), bytes);
    }
    drop(writer);
}

#[test]
fn source_revision_change_after_capture_invalidates_snapshot() {
    let root = temp::tempdir().unwrap();
    let staging = temp::tempdir().unwrap();
    let writer = fixture(root.path(), true);
    let snapshot = CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path(),
    )
    .unwrap();
    writer
        .execute(
            "UPDATE projects SET pipeline_json=?1",
            [json!({"schemaVersion":1,"revision":2,
        "project":{"id":"source","name":"Changed"}})
            .to_string()],
        )
        .unwrap();
    assert!(snapshot.recheck().unwrap_err().contains("source_changed"));
}

#[test]
fn unsafe_database_paths_and_partial_companion_schema_are_rejected() {
    let root = temp::tempdir().unwrap();
    let staging = temp::tempdir().unwrap();
    let db = fixture(root.path(), false);
    for path in ["../legacy.sqlite3", "/tmp/legacy.sqlite3"] {
        assert!(CapturedLegacySnapshot::capture(
            root.path(),
            Path::new(path),
            "source",
            staging.path()
        )
        .is_err());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            root.path().join("legacy.sqlite3"),
            root.path().join("link.sqlite3"),
        )
        .unwrap();
        assert!(CapturedLegacySnapshot::capture(
            root.path(),
            Path::new("link.sqlite3"),
            "source",
            staging.path()
        )
        .is_err());
    }
    db.execute_batch("CREATE TABLE presales_projects(project_id TEXT)")
        .unwrap();
    assert!(CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path()
    )
    .err()
    .unwrap()
    .contains("partial"));
}

#[test]
fn changed_inode_with_identical_database_bytes_is_not_same_source() {
    let root = temp::tempdir().unwrap();
    let staging = temp::tempdir().unwrap();
    drop(fixture(root.path(), false));
    let snapshot = CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path(),
    )
    .unwrap();
    fs::copy(
        root.path().join("legacy.sqlite3"),
        root.path().join("replacement.sqlite3"),
    )
    .unwrap();
    fs::rename(
        root.path().join("replacement.sqlite3"),
        root.path().join("legacy.sqlite3"),
    )
    .unwrap();
    assert!(snapshot.recheck().is_err());
}

#[test]
fn continuous_source_writes_exhaust_bounded_retries_and_cleanup_private_copies() {
    let root = temp::tempdir().unwrap();
    let staging = temp::tempdir().unwrap();
    let writer = fixture(root.path(), true);
    let mut calls = 0;
    let result = CapturedLegacySnapshot::capture_with_observer(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path(),
        |attempt| {
            calls += 1;
            writer
                .execute(
                    "UPDATE projects SET pipeline_json=?1",
                    [json!({"schemaVersion":1,
                "revision":attempt + 2,"project":{"id":"source","name":"Concurrent"}})
                    .to_string()],
                )
                .unwrap();
        },
    );
    assert!(result.err().unwrap().contains("source_changed"));
    assert_eq!(calls, 3);
    assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 0);
}

#[test]
fn oversize_database_pipeline_wal_and_special_files_fail_with_explicit_bounds() {
    let root = temp::tempdir().unwrap();
    let staging = temp::tempdir().unwrap();
    let large = fs::File::create(root.path().join("large.sqlite3")).unwrap();
    large
        .set_len(super::DATABASE_FILE_LIMIT as u64 + 1)
        .unwrap();
    assert!(CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("large.sqlite3"),
        "source",
        staging.path()
    )
    .err()
    .unwrap()
    .contains("byte limit"));
    let db = fixture(root.path(), false);
    db.execute(
        "UPDATE projects SET pipeline_json=?1",
        [" ".repeat(super::PIPELINE_BYTE_LIMIT + 1)],
    )
    .unwrap();
    assert!(CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path()
    )
    .err()
    .unwrap()
    .contains("pipeline exceeds"));
    let wal = fs::File::create(root.path().join("legacy.sqlite3-wal")).unwrap();
    wal.set_len(super::DATABASE_FILE_LIMIT as u64 + 1).unwrap();
    assert!(CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path()
    )
    .err()
    .unwrap()
    .contains("byte limit"));
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let path = CString::new(root.path().join("pipe.sqlite3").as_os_str().as_bytes()).unwrap();
        // SAFETY: path is a valid terminated synthetic fixture path.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert!(CapturedLegacySnapshot::capture(
            root.path(),
            Path::new("pipe.sqlite3"),
            "source",
            staging.path()
        )
        .err()
        .unwrap()
        .contains("regular file"));
    }
    assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 0);
}

#[test]
fn malformed_companion_marker_is_not_absent_optional_evidence() {
    let root = temp::tempdir().unwrap();
    let staging = temp::tempdir().unwrap();
    let db = fixture(root.path(), false);
    crate::presales::storage::initialize_schema(&db).unwrap();
    db.execute("INSERT INTO presales_projects VALUES ('source')", [])
        .unwrap();
    assert!(CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path()
    )
    .err()
    .unwrap()
    .contains("exact pipeline revision"));
    db.execute(
        "INSERT INTO presales_checkpoints VALUES ('source', 1, '{}')",
        [],
    )
    .unwrap();
    assert!(CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path()
    )
    .is_err());
}

#[test]
#[cfg(unix)]
fn private_cleanup_never_follows_a_replaced_directory_to_other_files() {
    let staging = temp::tempdir().unwrap();
    let outside = temp::tempdir().unwrap();
    let directory = super::PrivateSnapshotDirectory::create(staging.path()).unwrap();
    directory
        .write("snapshot.sqlite3", b"owned synthetic bytes")
        .unwrap();
    fs::write(
        outside.path().join("snapshot.sqlite3"),
        b"unrelated synthetic sentinel",
    )
    .unwrap();
    let original_path = directory.0.clone();
    fs::rename(&original_path, staging.path().join("moved-owned")).unwrap();
    std::os::unix::fs::symlink(outside.path(), &original_path).unwrap();
    drop(directory);
    assert_eq!(
        fs::read(outside.path().join("snapshot.sqlite3")).unwrap(),
        b"unrelated synthetic sentinel"
    );
}

#[test]
fn staged_database_corruption_cannot_be_bound_to_unchanged_source_evidence() {
    let root = temp::tempdir().unwrap();
    let staging = temp::tempdir().unwrap();
    drop(fixture(root.path(), false));
    let result = CapturedLegacySnapshot::capture_with_observer(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path(),
        |_| {
            let directory = fs::read_dir(staging.path())
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            let db = Connection::open(directory.join("snapshot.sqlite3")).unwrap();
            db.execute(
                "UPDATE projects SET pipeline_json=?1",
                [json!({"schemaVersion":1,"revision":55,
                "project":{"id":"source","name":"Tampered private copy"}})
                .to_string()],
            )
            .unwrap();
        },
    );
    assert!(result.is_err());
}
