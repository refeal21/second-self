//! Exact additive V3 v2 -> v3 migration. QueueOnly retains its own schema.
use super::*;

pub(super) const OBJECTS: [SchemaObject; 2] = [
    SchemaObject {
        kind: "table",
        name: "v3_text_operations",
        sql: r#"CREATE TABLE v3_text_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    attempt_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES v3_catalog(project_id),
    stage TEXT NOT NULL CHECK (stage IN ('outline','details')),
    expected_draft_revision INTEGER NOT NULL CHECK (expected_draft_revision >= 1),
    target_json TEXT NOT NULL CHECK (length(CAST(target_json AS BLOB)) <= 4194304),
    target_sha256 TEXT NOT NULL CHECK (length(target_sha256) = 64),
    status TEXT NOT NULL CHECK (status IN ('queued','dispatching','running','result_ready','committing','cancel_requested','outcome_unknown','succeeded','failed','cancelled','abandoned','conflict')),
    epoch INTEGER,
    provider_json TEXT,
    result_json TEXT,
    commit_json TEXT,
    cancellation_json TEXT,
    error TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
)"#,
    },
    SchemaObject {
        kind: "index",
        name: "v3_text_active_project",
        sql: r#"CREATE UNIQUE INDEX v3_text_active_project
ON v3_text_operations(project_id)
WHERE status IN ('queued','dispatching','running','result_ready','committing','cancel_requested','outcome_unknown')"#,
    },
];

pub(super) fn upgrade(connection: &mut Connection) -> Result<(), String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(message)?;
    if pragma_i64(&tx, "application_id")? != 0x44545633 || pragma_i64(&tx, "user_version")? != 2 {
        return Err("V3 v2 ownership changed before additive migration".into());
    }
    let actual = user_schema_objects(&tx)?;
    let expected = SCHEMA_OBJECTS.iter().chain(V3_OBJECTS.iter());
    if actual.len() != expected.clone().count() {
        return Err("unrecognized V3 v2 schema".into());
    }
    for o in expected {
        let sql = actual
            .iter()
            .find(|(kind, name, _)| kind == o.kind && name == o.name)
            .and_then(|(_, _, s)| s.as_deref());
        if sql.map(normalized_schema_sql) != Some(normalized_schema_sql(o.sql)) {
            return Err(format!("unrecognized V3 v2 object {}", o.name));
        }
    }
    for object in OBJECTS {
        tx.execute(object.sql, []).map_err(message)?;
    }
    for object in v3_withdrawal_schema::OBJECTS {
        tx.execute(object.sql, []).map_err(message)?;
    }
    #[cfg(test)]
    v3_schema_upgrade::failure_point("text_after_ddl")?;
    verify_schema(&user_schema_objects(&tx)?, DatabaseProfile::PresalesV3)?;
    tx.pragma_update(None, "user_version", 4).map_err(message)?;
    tx.commit().map_err(message)
}
