//! One recognized v3 owner upgrade. No legacy source database is admitted here.
use super::*;

#[cfg(test)]
thread_local! { static FAILURE: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) }; }
#[cfg(test)]
pub(crate) fn inject_failure(stage: Option<&'static str>) {
    FAILURE.with(|f| f.set(stage));
}
#[cfg(test)]
fn failure_point(stage: &'static str) -> Result<(), String> {
    if FAILURE.with(|f| f.get() == Some(stage)) {
        return Err(format!("injected v3 upgrade failure: {stage}"));
    }
    Ok(())
}

pub(super) fn verify_v1(objects: &[(String, String, Option<String>)]) -> Result<(), String> {
    let expected = SCHEMA_OBJECTS.iter().chain(v3_schema_v1::OBJECTS.iter());
    if objects.len() != expected.clone().count() {
        return Err("unrecognized v3 v1 schema".into());
    }
    for object in expected {
        let actual = objects
            .iter()
            .find(|(kind, name, _)| kind == object.kind && name == object.name)
            .and_then(|(_, _, sql)| sql.as_deref());
        if actual.map(normalized_schema_sql) != Some(normalized_schema_sql(object.sql)) {
            return Err(format!("unrecognized v3 v1 object {}", object.name));
        }
    }
    Ok(())
}

pub(super) fn upgrade(connection: &mut Connection) -> Result<(), String> {
    // This connection is still private to initialize; it is discarded on any
    // error. SQLite's table-rebuild protocol requires FK enforcement off before
    // BEGIN. The transaction is checked in full before any commit is possible.
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .map_err(message)?;
    if pragma_i64(connection, "foreign_keys")? != 0 {
        return Err("v3 upgrade could not enter private rebuild mode".into());
    }
    let result = (|| {
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        if pragma_i64(&tx, "application_id")? != 0x44545633 || pragma_i64(&tx, "user_version")? != 1
        {
            return Err("v3 ownership changed before upgrade".into());
        }
        verify_v1(&user_schema_objects(&tx)?)?;
        let projects = crate::presales_v3::validate_native_upgrade(&tx)?;
        for object in V3_OBJECTS
            .iter()
            .filter(|o| !v3_schema_v1::OBJECTS.iter().any(|old| old.name == o.name))
        {
            tx.execute(object.sql, []).map_err(message)?;
        }
        #[cfg(test)]
        failure_point("after_catalog_ddl")?;
        for (id, revision) in projects {
            tx.execute(
                "INSERT INTO v3_catalog(project_id,kind,revision) VALUES (?1,'frozen',?2)",
                rusqlite::params![id, revision],
            )
            .map_err(message)?;
        }
        for name in [
            "v3_projects",
            "v3_pages",
            "v3_import_receipts",
            "v3_delivery_snapshots",
            "v3_artifacts",
        ] {
            let target = V3_OBJECTS
                .iter()
                .find(|o| o.name == name)
                .ok_or("missing fixed upgrade target")?;
            let temporary = format!("{name}_upgrade");
            let columns = columns(&tx, name)?;
            tx.execute(
                &format!(
                    "CREATE TABLE {temporary} AS SELECT rowid AS original_rowid, * FROM {name}"
                ),
                [],
            )
            .map_err(message)?;
            // Exact v1 schema was checked under this writer lock; column order
            // and types are unchanged. Preserve every cell, including rowid.
            tx.execute(&format!("DROP TABLE {name}"), [])
                .map_err(message)?;
            tx.execute(target.sql, []).map_err(message)?;
            tx.execute(&format!("INSERT INTO {name}(rowid, {columns}) SELECT original_rowid, {columns} FROM {temporary}"), []).map_err(message)?;
            tx.execute(&format!("DROP TABLE {temporary}"), [])
                .map_err(message)?;
            #[cfg(test)]
            if name == "v3_projects" {
                failure_point("after_row_copy")?;
            }
        }
        verify_schema(&user_schema_objects(&tx)?, DatabaseProfile::PresalesV3)?;
        let violations = tx
            .prepare("PRAGMA foreign_key_check")
            .map_err(message)?
            .exists([])
            .map_err(message)?;
        let integrity: String = tx
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(message)?;
        if violations || integrity != "ok" {
            return Err("v3 upgrade integrity verification failed".into());
        }
        tx.pragma_update(None, "user_version", 2).map_err(message)?;
        #[cfg(test)]
        failure_point("before_commit")?;
        tx.commit().map_err(message)
    })();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(message)?;
    if pragma_i64(connection, "foreign_keys")? != 1 {
        return Err("v3 upgrade could not restore foreign key enforcement".into());
    }
    result
}

fn columns(connection: &Connection, table: &str) -> Result<String, String> {
    // `table` comes exclusively from the fixed five-table list above.
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(message)?;
    let names = statement
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    Ok(names.join(","))
}
