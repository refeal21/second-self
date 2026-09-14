//! Exact additive V3 v3 -> v4 migration. Never applied to QueueOnly.
use super::*;

pub(super) const OBJECTS: [SchemaObject; 1] = [SchemaObject {
    kind: "table",
    name: "v3_admission_withdrawals",
    sql: r#"CREATE TABLE v3_admission_withdrawals (
    batch_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES v3_catalog(project_id),
    input_json TEXT NOT NULL CHECK (length(CAST(input_json AS BLOB)) <= 2097152)
)"#,
}];

pub(super) fn upgrade(connection: &mut Connection) -> Result<(), String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(message)?;
    if pragma_i64(&tx, "application_id")? != 0x44545633 || pragma_i64(&tx, "user_version")? != 3 {
        return Err("V3 v3 ownership changed before admission migration".into());
    }
    let actual = user_schema_objects(&tx)?;
    let expected = SCHEMA_OBJECTS
        .iter()
        .chain(V3_OBJECTS.iter())
        .chain(v3_text_schema::OBJECTS.iter());
    if actual.len() != expected.clone().count() {
        return Err("unrecognized V3 v3 schema".into());
    }
    for object in expected {
        let sql = actual
            .iter()
            .find(|(kind, name, _)| kind == object.kind && name == object.name)
            .and_then(|(_, _, sql)| sql.as_deref());
        if sql.map(normalized_schema_sql) != Some(normalized_schema_sql(object.sql)) {
            return Err(format!("unrecognized V3 v3 object {}", object.name));
        }
    }
    for object in OBJECTS {
        tx.execute(object.sql, []).map_err(message)?;
    }
    #[cfg(test)]
    v3_schema_upgrade::failure_point("withdrawal_after_ddl")?;
    verify_schema(&user_schema_objects(&tx)?, DatabaseProfile::PresalesV3)?;
    tx.pragma_update(None, "user_version", 4).map_err(message)?;
    tx.commit().map_err(message)
}
