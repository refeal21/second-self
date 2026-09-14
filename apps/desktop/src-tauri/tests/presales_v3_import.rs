use digital_twin_desktop_lib::presales_v3::V3Store;
use rusqlite::Connection;

#[path = "support/v3_temp.rs"]
mod temp;

// A fixed immediate-pre-import schema fixture, not the current schema builder.
const V1: &str = include_str!("support/presales_v3_v1.sql");

#[test]
fn exact_v1_owner_upgrades_without_changing_durable_activity_bytes() {
    let dir = temp::tempdir().unwrap();
    let path = dir.path().join("v3.sqlite3");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(V1).unwrap();
    let evidence = " { \"syntheticUnresolvedEvidence\" : true } ";
    db.execute(
        "INSERT INTO v3_legacy_activity VALUES ('observation',?1)",
        [evidence],
    )
    .unwrap();
    drop(db);
    drop(V3Store::open(&path).unwrap());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        db.query_row(
            "SELECT evidence_json FROM v3_legacy_activity WHERE evidence_id='observation'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        evidence
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM v3_catalog", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(db);
    assert!(V3Store::open(&path)
        .unwrap()
        .list_projects()
        .unwrap()
        .is_empty());
}

#[test]
fn unknown_or_partial_v1_schema_is_rejected_without_mutating_source() {
    for alter in [
        "DROP TABLE v3_legacy_activity",
        "CREATE TABLE unrelated (data TEXT)",
        "PRAGMA application_id=42",
        "PRAGMA user_version=999",
    ] {
        let dir = temp::tempdir().unwrap();
        let path = dir.path().join("v3.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(V1).unwrap();
        db.execute_batch(alter).unwrap();
        drop(db);
        let before = std::fs::read(&path).unwrap();
        assert!(V3Store::open(&path).is_err(), "{alter}");
        assert_eq!(std::fs::read(&path).unwrap(), before, "{alter}");
    }
}

#[test]
fn failed_final_foreign_key_check_rolls_back_every_upgrade_ddl_and_version() {
    let dir = temp::tempdir().unwrap();
    let path = dir.path().join("v3.sqlite3");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(V1).unwrap();
    db.pragma_update(None, "foreign_keys", "OFF").unwrap();
    db.execute("INSERT INTO v3_artifacts VALUES ('orphan','missing',NULL,'x','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',' { \"unchanged\" : true } ')", []).unwrap();
    let before_schema: String = db
        .query_row(
            "SELECT group_concat(sql,';') FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(db);
    assert!(V3Store::open(&path)
        .err()
        .unwrap()
        .contains("integrity verification"));
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT group_concat(sql,';') FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        before_schema
    );
    assert_eq!(
        db.query_row(
            "SELECT metadata_json FROM v3_artifacts WHERE artifact_id='orphan'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        " { \"unchanged\" : true } "
    );
}

#[test]
fn tagged_nonfrozen_catalog_uses_separate_storage_and_cannot_enter_native_seed_reader() {
    let dir = temp::tempdir().unwrap();
    let path = dir.path().join("v3.sqlite3");
    let store = V3Store::open(&path).unwrap();
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "foreign_keys", "ON").unwrap();
    db.execute("INSERT INTO v3_catalog VALUES ('draft','draft',1)", [])
        .unwrap();
    db.execute("INSERT INTO v3_draft_projects VALUES ('draft','{}')", [])
        .unwrap();
    db.execute(
        "INSERT INTO v3_catalog VALUES ('history','history_only',1)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO v3_history_projects VALUES ('history','{}')",
        [],
    )
    .unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM v3_projects", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(store.load_project("draft").is_err());
    assert!(store.load_project("history").is_err());
    assert!(db
        .execute("INSERT INTO v3_catalog VALUES ('unknown','invented',1)", [])
        .is_err());
    assert!(db
        .execute("INSERT INTO v3_draft_projects VALUES ('missing','{}')", [])
        .is_err());
}
