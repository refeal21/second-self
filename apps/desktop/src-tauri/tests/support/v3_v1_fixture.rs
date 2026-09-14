//! Synthetic downgrade fixture only; production has no downgrade operation.
use rusqlite::Connection;
use std::path::Path;

pub fn copy_existing_rows_into_v1(source: &Path, destination: &Path) {
    let db = Connection::open(destination).unwrap();
    db.execute_batch(include_str!("presales_v3_v1.sql"))
        .unwrap();
    db.pragma_update(None, "foreign_keys", "OFF").unwrap();
    db.execute("ATTACH DATABASE ?1 AS saved", [source.to_str().unwrap()])
        .unwrap();
    let tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
        .query_map([],|r| r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    db.execute("DELETE FROM queue_settings", []).unwrap();
    for table in tables {
        db.execute(
            &format!("INSERT INTO {table} SELECT * FROM saved.{table}"),
            [],
        )
        .unwrap();
    }
    db.execute("DETACH DATABASE saved", []).unwrap();
}
