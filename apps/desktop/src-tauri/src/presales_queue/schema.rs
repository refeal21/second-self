use rusqlite::{Connection, TransactionBehavior};
use std::time::Duration;

#[path = "v3_schema_upgrade.rs"]
mod v3_schema_upgrade;
#[path = "v3_schema_v1.rs"]
mod v3_schema_v1;
#[path = "v3_text_schema.rs"]
mod v3_text_schema;

#[cfg(test)]
pub(crate) use v3_schema_upgrade::inject_failure as inject_v3_upgrade_failure;

#[derive(Clone, Copy)]
struct SchemaObject {
    kind: &'static str,
    name: &'static str,
    sql: &'static str,
}

const SCHEMA_OBJECTS: [SchemaObject; 8] = [
    SchemaObject {
        kind: "table",
        name: "queue_settings",
        sql: r#"CREATE TABLE queue_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 4),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    epoch INTEGER NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "queue_batches",
        sql: r#"CREATE TABLE queue_batches (
    batch_id TEXT PRIMARY KEY,
    input_json TEXT NOT NULL,
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    created_at_ms INTEGER NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "queue_jobs",
        sql: r#"CREATE TABLE queue_jobs (
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
)"#,
    },
    SchemaObject {
        kind: "index",
        name: "queue_jobs_active_page",
        sql: r#"CREATE UNIQUE INDEX queue_jobs_active_page
ON queue_jobs(project_id, slide_id)
WHERE status IN (
    'queued', 'dispatching', 'running', 'result_ready', 'committing',
    'cancel_requested', 'outcome_unknown'
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "queue_attempts",
        sql: r#"CREATE TABLE queue_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE REFERENCES queue_jobs(request_id),
    target_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "queue_batch_entries",
        sql: r#"CREATE TABLE queue_batch_entries (
    batch_id TEXT NOT NULL REFERENCES queue_batches(batch_id),
    ordinal INTEGER NOT NULL,
    submitted_request_id TEXT NOT NULL UNIQUE,
    submitted_attempt_id TEXT NOT NULL UNIQUE,
    resolved_request_id TEXT NOT NULL REFERENCES queue_jobs(request_id),
    reused INTEGER NOT NULL CHECK (reused IN (0, 1)),
    PRIMARY KEY (batch_id, ordinal)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "queue_transition_events",
        sql: r#"CREATE TABLE queue_transition_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES queue_jobs(request_id),
    from_status TEXT,
    to_status TEXT NOT NULL,
    epoch INTEGER,
    created_at_ms INTEGER NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "queue_lifecycle_events",
        sql: r#"CREATE TABLE queue_lifecycle_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES queue_jobs(request_id),
    attempt_id TEXT NOT NULL REFERENCES queue_attempts(attempt_id),
    kind TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
)"#,
    },
];

const V3_OBJECTS: [SchemaObject; 16] = [
    SchemaObject {
        kind: "table",
        name: "v3_catalog",
        sql: r#"CREATE TABLE v3_catalog (
    project_id TEXT NOT NULL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('frozen', 'draft', 'history_only')),
    revision INTEGER NOT NULL CHECK (revision >= 1)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_draft_projects",
        sql: r#"CREATE TABLE v3_draft_projects (
    project_id TEXT NOT NULL PRIMARY KEY REFERENCES v3_catalog(project_id),
    draft_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_history_projects",
        sql: r#"CREATE TABLE v3_history_projects (
    project_id TEXT NOT NULL PRIMARY KEY REFERENCES v3_catalog(project_id),
    history_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_origin_approvals",
        sql: r#"CREATE TABLE v3_origin_approvals (
    reference_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    proof_json TEXT NOT NULL,
    FOREIGN KEY (project_id, slide_id, version_id) REFERENCES v3_versions(project_id, slide_id, version_id),
    UNIQUE (project_id, slide_id, version_id)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_legacy_activity",
        sql: r#"CREATE TABLE v3_legacy_activity (
    evidence_id TEXT NOT NULL PRIMARY KEY,
    evidence_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_projects",
        sql: r#"CREATE TABLE v3_projects (
    project_id TEXT NOT NULL PRIMARY KEY REFERENCES v3_catalog(project_id),
    name TEXT NOT NULL,
    frozen_json TEXT NOT NULL,
    origin_json TEXT NOT NULL,
    palette_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_pages",
        sql: r#"CREATE TABLE v3_pages (
    project_id TEXT NOT NULL REFERENCES v3_catalog(project_id),
    slide_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    spec_json TEXT NOT NULL,
    design_json TEXT,
    basis_json TEXT,
    current_version_id TEXT,
    approved_version_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    intent_request_id TEXT REFERENCES queue_jobs(request_id),
    PRIMARY KEY (project_id, slide_id),
    UNIQUE (project_id, ordinal),
    FOREIGN KEY (project_id, slide_id, current_version_id) REFERENCES v3_versions(project_id, slide_id, version_id),
    FOREIGN KEY (project_id, slide_id, approved_version_id) REFERENCES v3_versions(project_id, slide_id, version_id)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_admissions",
        sql: r#"CREATE TABLE v3_admissions (
    batch_id TEXT NOT NULL PRIMARY KEY REFERENCES queue_batches(batch_id),
    input_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_intents",
        sql: r#"CREATE TABLE v3_intents (
    request_id TEXT NOT NULL PRIMARY KEY REFERENCES queue_jobs(request_id),
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    page_revision INTEGER NOT NULL CHECK (page_revision >= 1),
    target_json TEXT NOT NULL,
    FOREIGN KEY (project_id, slide_id) REFERENCES v3_pages(project_id, slide_id)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_versions",
        sql: r#"CREATE TABLE v3_versions (
    version_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    request_id TEXT UNIQUE REFERENCES queue_jobs(request_id),
    attempt_id TEXT UNIQUE REFERENCES queue_attempts(attempt_id),
    status TEXT NOT NULL,
    version_json TEXT NOT NULL,
    FOREIGN KEY (project_id, slide_id) REFERENCES v3_pages(project_id, slide_id),
    UNIQUE (project_id, slide_id, sequence),
    UNIQUE (project_id, slide_id, version_id),
    CHECK ((request_id IS NULL) = (attempt_id IS NULL))
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_receipts",
        sql: r#"CREATE TABLE v3_receipts (
    request_id TEXT NOT NULL PRIMARY KEY REFERENCES queue_jobs(request_id),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES queue_attempts(attempt_id),
    version_id TEXT NOT NULL UNIQUE REFERENCES v3_versions(version_id),
    receipt_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_approvals",
        sql: r#"CREATE TABLE v3_approvals (
    approval_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    approval_json TEXT NOT NULL,
    FOREIGN KEY (project_id, slide_id, version_id) REFERENCES v3_versions(project_id, slide_id, version_id),
    UNIQUE (project_id, slide_id, version_id)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_feedback",
        sql: r#"CREATE TABLE v3_feedback (
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    base_version_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    draft_json TEXT NOT NULL,
    PRIMARY KEY (project_id, slide_id, base_version_id),
    FOREIGN KEY (project_id, slide_id) REFERENCES v3_pages(project_id, slide_id)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_import_receipts",
        sql: r#"CREATE TABLE v3_import_receipts (
    import_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES v3_catalog(project_id),
    origin_digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_delivery_snapshots",
        sql: r#"CREATE TABLE v3_delivery_snapshots (
    snapshot_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES v3_catalog(project_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    snapshot_json TEXT NOT NULL,
    UNIQUE (project_id, revision)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_artifacts",
        sql: r#"CREATE TABLE v3_artifacts (
    artifact_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES v3_catalog(project_id),
    version_id TEXT REFERENCES v3_versions(version_id),
    relative_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    metadata_json TEXT NOT NULL
)"#,
    },
];

/// Ownership profiles are closed: callers cannot append arbitrary schema SQL.
#[derive(Clone, Copy)]
pub(crate) enum DatabaseProfile {
    QueueOnly,
    PresalesV3,
}

impl DatabaseProfile {
    fn identity(self) -> (i64, i64) {
        match self {
            Self::QueueOnly => (0x44545133, 2),
            Self::PresalesV3 => (0x44545633, 3),
        }
    }

    fn objects(self) -> impl Iterator<Item = &'static SchemaObject> {
        SCHEMA_OBJECTS
            .iter()
            .chain(match self {
                Self::QueueOnly => [].iter(),
                Self::PresalesV3 => V3_OBJECTS.iter(),
            })
            .chain(match self {
                Self::QueueOnly => [].iter(),
                Self::PresalesV3 => v3_text_schema::OBJECTS.iter(),
            })
    }
}

pub(crate) fn initialize(
    mut connection: Connection,
    file_backed: bool,
    profile: DatabaseProfile,
) -> Result<Connection, String> {
    let (expected_id, expected_version) = profile.identity();
    let application_id = pragma_i64(&connection, "application_id")?;
    let user_version = pragma_i64(&connection, "user_version")?;
    let objects = user_schema_objects(&connection)?;
    let unowned_empty = application_id == 0 && user_version == 0 && objects.is_empty();
    let upgrade_v1 = matches!(profile, DatabaseProfile::PresalesV3)
        && application_id == 0x44545633
        && user_version == 1;
    let upgrade_v2 = matches!(profile, DatabaseProfile::PresalesV3)
        && application_id == 0x44545633
        && user_version == 2;
    let upgrade = upgrade_v1 || upgrade_v2;
    if upgrade_v1 {
        v3_schema_upgrade::verify_v1(&objects)?;
        v3_schema_upgrade::upgrade(&mut connection)?;
    }
    if upgrade_v2 {
        v3_text_schema::upgrade(&mut connection)?;
    }
    if !unowned_empty
        && !upgrade
        && (application_id != expected_id || user_version != expected_version)
    {
        return Err("database is not a compatible durable queue/profile owner".into());
    }
    if !unowned_empty && !upgrade {
        verify_schema(&objects, profile)?;
    }
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(message)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(message)?;
    if file_backed {
        let mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(message)?;
        if !mode.eq_ignore_ascii_case("wal") {
            connection
                .pragma_update(None, "journal_mode", "WAL")
                .map_err(message)?;
        }
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(message)?;
    if unowned_empty {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        // Recheck after acquiring the writer lock, so concurrent initialization
        // cannot silently adopt or extend a database claimed by another owner.
        if pragma_i64(&transaction, "application_id")? != 0
            || pragma_i64(&transaction, "user_version")? != 0
            || !user_schema_objects(&transaction)?.is_empty()
        {
            return Err("database ownership changed during initialization".into());
        }
        for object in profile.objects() {
            transaction.execute(object.sql, []).map_err(message)?;
        }
        transaction.execute("INSERT INTO queue_settings (singleton, concurrency, paused, epoch) VALUES (1, 4, 0, 0)", []).map_err(message)?;
        transaction
            .pragma_update(None, "application_id", expected_id)
            .map_err(message)?;
        transaction
            .pragma_update(None, "user_version", expected_version)
            .map_err(message)?;
        transaction.commit().map_err(message)?;
    }
    Ok(connection)
}
fn pragma_i64(connection: &Connection, name: &str) -> Result<i64, String> {
    connection
        .pragma_query_value(None, name, |row| row.get(0))
        .map_err(message)
}

fn user_schema_objects(
    connection: &Connection,
) -> Result<Vec<(String, String, Option<String>)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT type, name, sql FROM sqlite_schema
             WHERE lower(substr(name, 1, 7)) <> 'sqlite_' ORDER BY type, name",
        )
        .map_err(message)?;
    let objects = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    Ok(objects)
}

fn verify_schema(
    objects: &[(String, String, Option<String>)],
    profile: DatabaseProfile,
) -> Result<(), String> {
    if objects.len() != profile.objects().count() {
        return Err(format!(
            "durable queue schema does not match user_version {}",
            profile.identity().1
        ));
    }
    for object in profile.objects() {
        let actual = objects
            .iter()
            .find(|(kind, name, _)| kind == object.kind && name == object.name)
            .and_then(|(_, _, sql)| sql.as_deref());
        if actual.map(normalized_schema_sql).as_deref() != Some(&normalized_schema_sql(object.sql))
        {
            return Err(format!(
                "durable queue {} {} does not match user_version {}",
                object.kind,
                object.name,
                profile.identity().1
            ));
        }
    }
    Ok(())
}

fn normalized_schema_sql(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if is_sqlite_sql_whitespace(character) {
            continue;
        }
        if character.is_ascii_alphanumeric() || character == '_' {
            let mut word = String::from(character.to_ascii_lowercase());
            while characters
                .peek()
                .is_some_and(|next| next.is_ascii_alphanumeric() || *next == '_')
            {
                word.push(
                    characters
                        .next()
                        .expect("peeked schema character exists")
                        .to_ascii_lowercase(),
                );
            }
            tokens.push(word);
            continue;
        }
        if character == '\'' {
            let mut literal = String::from(character);
            while let Some(next) = characters.next() {
                literal.push(next);
                if next == '\'' {
                    if characters.peek() == Some(&'\'') {
                        literal.push(characters.next().expect("peeked quote exists"));
                    } else {
                        break;
                    }
                }
            }
            tokens.push(literal);
            continue;
        }
        tokens.push(character.to_string());
    }
    tokens
}

fn is_sqlite_sql_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}' | '\u{000a}' | '\u{000c}' | '\u{000d}' | '\u{0020}'
    )
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
