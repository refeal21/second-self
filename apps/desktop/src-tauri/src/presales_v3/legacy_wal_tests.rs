use super::{
    legacy_snapshot_tests::{fixture, temp},
    CapturedLegacySnapshot,
};
use rusqlite::Connection;
use serde_json::json;
use std::{fs, path::Path};

fn revision_json(revision: i64) -> String {
    json!({"schemaVersion":1,"revision":revision,"project":{"id":"source","name":"Synthetic"}})
        .to_string()
}

fn committed_wal(root: &Path) -> Connection {
    let writer = fixture(root, false);
    writer
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    writer
        .execute("UPDATE projects SET pipeline_json=?1", [revision_json(2)])
        .unwrap();
    writer
}

#[test]
fn corrupt_committed_wal_cannot_silently_return_the_older_main_revision() {
    let origin = temp::tempdir().unwrap();
    let _writer = committed_wal(origin.path());
    let main = fs::read(origin.path().join("legacy.sqlite3")).unwrap();
    let wal = fs::read(origin.path().join("legacy.sqlite3-wal")).unwrap();
    let staging = temp::tempdir().unwrap();
    let good = CapturedLegacySnapshot::capture(
        origin.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path(),
    )
    .unwrap();
    assert_eq!(good.revision(), 2);
    for mutation in [
        "magic",
        "header checksum",
        "committed checksum",
        "committed content",
        "salt",
        "incomplete committed frame",
        "unaccounted complete tail",
        "incomplete uncommitted tail",
    ] {
        let root = temp::tempdir().unwrap();
        let mut bad = wal.clone();
        match mutation {
            "magic" => bad[0] ^= 1,
            "header checksum" => bad[24] ^= 1,
            "committed checksum" => bad[32 + 16] ^= 1,
            "committed content" => {
                let last = bad.len() - 1;
                bad[last] ^= 1;
            }
            "salt" => bad[32 + 8] ^= 1,
            "unaccounted complete tail" => bad.extend_from_slice(&wal[32..]),
            "incomplete uncommitted tail" => bad.extend_from_slice(&[0; 8]),
            _ => {
                bad.pop();
            }
        }
        fs::write(root.path().join("legacy.sqlite3"), &main).unwrap();
        fs::write(root.path().join("legacy.sqlite3-wal"), &bad).unwrap();
        let result = CapturedLegacySnapshot::capture(
            root.path(),
            Path::new("legacy.sqlite3"),
            "source",
            staging.path(),
        );
        assert!(
            result
                .err()
                .is_some_and(|error| error.contains("unaccounted_wal")),
            "accepted {mutation} and silently lost committed WAL evidence"
        );
        assert_eq!(fs::read(root.path().join("legacy.sqlite3")).unwrap(), main);
        assert_eq!(
            fs::read(root.path().join("legacy.sqlite3-wal")).unwrap(),
            bad
        );
        assert!(!root.path().join("legacy.sqlite3-shm").exists());
    }
}

#[test]
fn empty_header_only_and_complete_uncommitted_wal_have_explicit_snapshot_semantics() {
    let origin = temp::tempdir().unwrap();
    let writer = committed_wal(origin.path());
    let main = fs::read(origin.path().join("legacy.sqlite3")).unwrap();
    let wal = fs::read(origin.path().join("legacy.sqlite3-wal")).unwrap();
    let staging = temp::tempdir().unwrap();
    for bytes in [vec![], wal[..32].to_vec()] {
        let root = temp::tempdir().unwrap();
        fs::write(root.path().join("legacy.sqlite3"), &main).unwrap();
        fs::write(root.path().join("legacy.sqlite3-wal"), bytes).unwrap();
        assert_eq!(
            CapturedLegacySnapshot::capture(
                root.path(),
                Path::new("legacy.sqlite3"),
                "source",
                staging.path()
            )
            .unwrap()
            .revision(),
            1
        );
    }
    writer
        .execute_batch("PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN;")
        .unwrap();
    writer
        .execute("UPDATE projects SET pipeline_json=?1", [revision_json(3)])
        .unwrap();
    writer.execute_batch("CREATE TABLE uncommitted_payload(bytes BLOB); INSERT INTO uncommitted_payload VALUES(zeroblob(65536));").unwrap();
    let with_tail = fs::read(origin.path().join("legacy.sqlite3-wal")).unwrap();
    assert!(
        with_tail.len() > wal.len(),
        "real SQLite fixture must spill complete uncommitted frames"
    );
    let root = temp::tempdir().unwrap();
    fs::write(root.path().join("legacy.sqlite3"), &main).unwrap();
    fs::write(root.path().join("legacy.sqlite3-wal"), &with_tail).unwrap();
    let captured = CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path(),
    )
    .unwrap();
    assert_eq!(captured.revision(), 2);
    assert_eq!(captured.raw_database_bytes().1, Some(with_tail.as_slice()));
    writer.execute_batch("ROLLBACK").unwrap();
}

#[test]
#[cfg(unix)]
fn replacement_immediately_after_verification_cannot_redirect_sqlite_or_its_sidecars() {
    for replacement in [
        "regular database",
        "database symlink",
        "directory symlink",
        "sidecar symlinks",
    ] {
        let source = temp::tempdir().unwrap();
        let _writer = committed_wal(source.path());
        let outside = temp::tempdir().unwrap();
        let unrelated = fixture(outside.path(), false);
        unrelated
            .execute("UPDATE projects SET pipeline_json=?1", [revision_json(55)])
            .unwrap();
        drop(unrelated);
        let original: Vec<_> = ["legacy.sqlite3", "legacy.sqlite3-wal", "legacy.sqlite3-shm"]
            .iter()
            .map(|name| fs::read(source.path().join(name)).unwrap())
            .collect();
        let sentinel = fs::read(outside.path().join("legacy.sqlite3")).unwrap();
        let staging = temp::tempdir().unwrap();
        let captured = CapturedLegacySnapshot::capture_with_observers(
            source.path(),
            Path::new("legacy.sqlite3"),
            "source",
            staging.path(),
            |_| {},
            || {
                let directory = fs::read_dir(staging.path())
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path();
                match replacement {
                    "regular database" => {
                        fs::remove_file(directory.join("snapshot.sqlite3-wal")).unwrap();
                        fs::copy(
                            outside.path().join("legacy.sqlite3"),
                            directory.join("snapshot.sqlite3"),
                        )
                        .unwrap();
                    }
                    "database symlink" => {
                        fs::remove_file(directory.join("snapshot.sqlite3")).unwrap();
                        std::os::unix::fs::symlink(
                            source.path().join("legacy.sqlite3"),
                            directory.join("snapshot.sqlite3"),
                        )
                        .unwrap();
                    }
                    "directory symlink" => {
                        fs::rename(&directory, staging.path().join("moved-owned")).unwrap();
                        std::os::unix::fs::symlink(outside.path(), &directory).unwrap();
                    }
                    _ => {
                        fs::remove_file(directory.join("snapshot.sqlite3-wal")).unwrap();
                        for name in [
                            "snapshot.sqlite3-wal",
                            "snapshot.sqlite3-shm",
                            "snapshot.sqlite3-journal",
                        ] {
                            std::os::unix::fs::symlink(
                                outside.path().join("legacy.sqlite3"),
                                directory.join(name),
                            )
                            .unwrap();
                        }
                    }
                }
            },
        )
        .unwrap();
        assert_eq!(
            captured.revision(),
            2,
            "SQLite consumed a substituted {replacement}"
        );
        assert_eq!(
            fs::read(outside.path().join("legacy.sqlite3")).unwrap(),
            sentinel
        );
        assert_eq!(
            fs::read_dir(outside.path()).unwrap().count(),
            1,
            "SQLite created unrelated sidecars"
        );
        for (name, bytes) in ["legacy.sqlite3", "legacy.sqlite3-wal", "legacy.sqlite3-shm"]
            .iter()
            .zip(original)
        {
            assert_eq!(
                fs::read(source.path().join(name)).unwrap(),
                bytes,
                "source was touched after {replacement}"
            );
        }
    }
}

#[test]
fn memory_sqlite_is_readonly_even_without_query_only_and_rejects_malformed_images() {
    let root = temp::tempdir().unwrap();
    drop(fixture(root.path(), false));
    let image = fs::read(root.path().join("legacy.sqlite3")).unwrap();
    let connection = super::open_read_image(&image).unwrap();
    connection.execute_batch("PRAGMA query_only=OFF").unwrap();
    let error = connection
        .execute("UPDATE projects SET pipeline_json='{}'", [])
        .unwrap_err();
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::ReadOnly)
    );
    let paths: Vec<String> = connection
        .prepare("PRAGMA database_list")
        .unwrap()
        .query_map([], |row| row.get(2))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(paths.iter().all(String::is_empty));
    assert!(super::read_memory_checkpoint(b"not a SQLite image", "source").is_err());
    assert!(super::open_read_image(&[]).is_err());
}

#[test]
fn wal_growth_is_bounded_before_derived_image_allocation() {
    let root = temp::tempdir().unwrap();
    let _writer = committed_wal(root.path());
    let main = fs::read(root.path().join("legacy.sqlite3")).unwrap();
    let wal = fs::read(root.path().join("legacy.sqlite3-wal")).unwrap();
    for offset in [32, 36] {
        let mut excessive = wal.clone();
        excessive[offset..offset + 4].copy_from_slice(&u32::MAX.to_be_bytes());
        let error = crate::presales_v3::wal_snapshot::materialize(
            &main,
            Some(&excessive),
            super::DATABASE_FILE_LIMIT,
        )
        .unwrap_err();
        assert!(error.contains("snapshot_image_limit"));
    }
}

// Independent fixture re-encoding, verified below by SQLite's own WAL reader.
fn big_endian_wal(mut bytes: Vec<u8>) -> Vec<u8> {
    fn sum(input: &[u8], mut left: u32, mut right: u32) -> (u32, u32) {
        let values: Vec<u32> = input
            .chunks_exact(4)
            .map(|word| u32::from_be_bytes(word.try_into().unwrap()))
            .collect();
        for index in (0..values.len()).step_by(2) {
            left = left.wrapping_add(values[index]).wrapping_add(right);
            right = right.wrapping_add(values[index + 1]).wrapping_add(left);
        }
        (left, right)
    }
    bytes[0..4].copy_from_slice(&0x377f0683u32.to_be_bytes());
    let (mut left, mut right) = sum(&bytes[..24], 0, 0);
    bytes[24..28].copy_from_slice(&left.to_be_bytes());
    bytes[28..32].copy_from_slice(&right.to_be_bytes());
    let size = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
    for frame in bytes[32..].chunks_exact_mut(size + 24) {
        (left, right) = sum(&frame[..8], left, right);
        (left, right) = sum(&frame[24..], left, right);
        frame[16..20].copy_from_slice(&left.to_be_bytes());
        frame[20..24].copy_from_slice(&right.to_be_bytes());
    }
    bytes
}

#[test]
fn sqlite_verified_big_endian_wal_and_supported_page_size_extremes_recover_latest_revision() {
    for size in [512, 65536] {
        let origin = temp::tempdir().unwrap();
        let writer = Connection::open(origin.path().join("legacy.sqlite3")).unwrap();
        writer.execute_batch(&format!("PRAGMA page_size={size}; CREATE TABLE projects(id TEXT PRIMARY KEY,pipeline_json TEXT);")).unwrap();
        writer
            .execute(
                "INSERT INTO projects VALUES('source',?1)",
                [revision_json(1)],
            )
            .unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        writer
            .execute("UPDATE projects SET pipeline_json=?1", [revision_json(2)])
            .unwrap();
        let main = fs::read(origin.path().join("legacy.sqlite3")).unwrap();
        let wal = big_endian_wal(fs::read(origin.path().join("legacy.sqlite3-wal")).unwrap());
        let sqlite_probe = temp::tempdir().unwrap();
        fs::write(sqlite_probe.path().join("probe.db"), &main).unwrap();
        fs::write(sqlite_probe.path().join("probe.db-wal"), &wal).unwrap();
        let oracle = Connection::open(sqlite_probe.path().join("probe.db")).unwrap();
        let expected: String = oracle
            .query_row("SELECT pipeline_json FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            expected,
            revision_json(2),
            "SQLite must independently accept this big-endian fixture"
        );
        let root = temp::tempdir().unwrap();
        fs::write(root.path().join("legacy.sqlite3"), &main).unwrap();
        fs::write(root.path().join("legacy.sqlite3-wal"), &wal).unwrap();
        let staging = temp::tempdir().unwrap();
        assert_eq!(
            CapturedLegacySnapshot::capture(
                root.path(),
                Path::new("legacy.sqlite3"),
                "source",
                staging.path()
            )
            .unwrap()
            .revision(),
            2
        );
    }
}

#[test]
fn legitimate_old_reset_tail_is_explicitly_blocked_instead_of_skipped() {
    let root = temp::tempdir().unwrap();
    let writer = committed_wal(root.path());
    writer.execute_batch("CREATE TABLE old_payload(bytes BLOB); INSERT INTO old_payload VALUES(zeroblob(65536));").unwrap();
    let (_, _, _): (i64, i64, i64) = writer
        .query_row("PRAGMA wal_checkpoint(RESTART)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    writer
        .execute("UPDATE projects SET pipeline_json=?1", [revision_json(3)])
        .unwrap();
    let staging = temp::tempdir().unwrap();
    let error = CapturedLegacySnapshot::capture(
        root.path(),
        Path::new("legacy.sqlite3"),
        "source",
        staging.path(),
    )
    .err()
    .unwrap();
    assert!(error.contains("unaccounted_wal") && error.contains("old-reset"));
}

#[test]
fn complete_uncommitted_wal_without_any_commit_preserves_main_revision() {
    let root = temp::tempdir().unwrap();
    let writer = fixture(root.path(), false);
    writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN;").unwrap();
    writer
        .execute("UPDATE projects SET pipeline_json=?1", [revision_json(2)])
        .unwrap();
    writer
        .execute_batch("CREATE TABLE spill(bytes BLOB); INSERT INTO spill VALUES(zeroblob(65536));")
        .unwrap();
    let wal = fs::read(root.path().join("legacy.sqlite3-wal")).unwrap();
    assert!(wal.len() > 32);
    let size = u32::from_be_bytes(wal[8..12].try_into().unwrap()) as usize;
    assert!(wal[32..]
        .chunks_exact(size + 24)
        .all(|frame| frame[4..8] == [0; 4]));
    let staging = temp::tempdir().unwrap();
    assert_eq!(
        CapturedLegacySnapshot::capture(
            root.path(),
            Path::new("legacy.sqlite3"),
            "source",
            staging.path()
        )
        .unwrap()
        .revision(),
        1
    );
    writer.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn committed_growth_shrink_and_regrowth_match_the_latest_sqlite_revision() {
    let root = temp::tempdir().unwrap();
    let writer = fixture(root.path(), false);
    writer.execute_batch("PRAGMA auto_vacuum=FULL; VACUUM; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;").unwrap();
    writer.execute_batch("CREATE TABLE big(bytes BLOB); INSERT INTO big VALUES(zeroblob(65536)); DROP TABLE big; CREATE TABLE fresh(bytes BLOB); INSERT INTO fresh VALUES(zeroblob(131072));").unwrap();
    writer
        .execute("UPDATE projects SET pipeline_json=?1", [revision_json(4)])
        .unwrap();
    let wal = fs::read(root.path().join("legacy.sqlite3-wal")).unwrap();
    let size = u32::from_be_bytes(wal[8..12].try_into().unwrap()) as usize;
    let commits: Vec<_> = wal[32..]
        .chunks_exact(size + 24)
        .map(|frame| u32::from_be_bytes(frame[4..8].try_into().unwrap()))
        .filter(|size| *size > 0)
        .collect();
    assert!(commits.windows(2).any(|pair| pair[1] < pair[0]));
    assert!(commits.windows(2).any(|pair| pair[1] > pair[0]));
    let staging = temp::tempdir().unwrap();
    assert_eq!(
        CapturedLegacySnapshot::capture(
            root.path(),
            Path::new("legacy.sqlite3"),
            "source",
            staging.path()
        )
        .unwrap()
        .revision(),
        4
    );
}

#[test]
fn incremental_wal_growth_does_not_double_allocation_past_the_bound() {
    let root = temp::tempdir().unwrap();
    let writer = committed_wal(root.path());
    writer.execute_batch("CREATE TABLE payload(bytes BLOB); INSERT INTO payload VALUES(zeroblob(65536)); INSERT INTO payload VALUES(zeroblob(32768));").unwrap();
    let main = fs::read(root.path().join("legacy.sqlite3")).unwrap();
    let wal = fs::read(root.path().join("legacy.sqlite3-wal")).unwrap();
    let limit = wal.len().max(main.len());
    let image = crate::presales_v3::wal_snapshot::materialize(&main, Some(&wal), limit).unwrap();
    assert!(
        image.capacity() <= limit,
        "derived allocation capacity {} exceeded bound {limit}",
        image.capacity()
    );
}
