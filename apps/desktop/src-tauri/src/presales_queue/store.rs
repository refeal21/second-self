use super::{EnqueueBatch, EnqueueOutcome, JobStatus, QueueJob, QueueSettings, QueueTarget};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const APPLICATION_ID: i64 = 0x44545133;
const USER_VERSION: i64 = 1;
const MAX_CONCURRENCY: u8 = 4;
const MAX_BATCH_SIZE: usize = 100;
const MAX_REFERENCES: usize = 32;
const MAX_TARGET_BYTES: usize = 128 * 1024;
const MAX_VERSION_BYTES: usize = 128;
const MAX_PROMPT_BYTES: usize = 65_536;
const MAX_FEEDBACK_BYTES: usize = 16_384;

#[derive(Clone, Copy)]
struct SchemaObject {
    kind: &'static str,
    name: &'static str,
    sql: &'static str,
}

const SCHEMA_OBJECTS: [SchemaObject; 7] = [
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
];

pub struct QueueStore {
    pub(super) connection: Connection,
}

impl QueueStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        Self::initialize(Connection::open(path).map_err(message)?, true)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        Self::initialize(Connection::open_in_memory().map_err(message)?, false)
    }

    fn initialize(mut connection: Connection, file_backed: bool) -> Result<Self, String> {
        let application_id = pragma_i64(&connection, "application_id")?;
        let user_version = pragma_i64(&connection, "user_version")?;
        let tables = user_tables(&connection)?;
        let unowned_empty = application_id == 0 && user_version == 0 && tables.is_empty();
        if !unowned_empty && (application_id != APPLICATION_ID || user_version != USER_VERSION) {
            return Err("database is not a compatible durable queue".into());
        }
        if !unowned_empty {
            verify_schema(&connection, &tables)?;
        }

        connection
            .busy_timeout(Duration::from_millis(5_000))
            .map_err(message)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(message)?;
        if file_backed {
            let journal_mode: String = connection
                .pragma_query_value(None, "journal_mode", |row| row.get(0))
                .map_err(message)?;
            if !journal_mode.eq_ignore_ascii_case("wal") {
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
            for object in SCHEMA_OBJECTS {
                transaction.execute(object.sql, []).map_err(message)?;
            }
            transaction
                .execute(
                    "INSERT INTO queue_settings (singleton, concurrency, paused, epoch)
                     VALUES (1, 4, 0, 0)",
                    [],
                )
                .map_err(message)?;
            transaction
                .pragma_update(None, "application_id", APPLICATION_ID)
                .map_err(message)?;
            transaction
                .pragma_update(None, "user_version", USER_VERSION)
                .map_err(message)?;
            transaction.commit().map_err(message)?;
        }
        Ok(Self { connection })
    }

    pub fn settings(&self) -> Result<QueueSettings, String> {
        read_settings(&self.connection)
    }

    pub fn set_concurrency(&mut self, value: u8) -> Result<QueueSettings, String> {
        if !(1..=MAX_CONCURRENCY).contains(&value) {
            return Err(format!(
                "concurrency must be between 1 and {MAX_CONCURRENCY}"
            ));
        }
        self.connection
            .execute(
                "UPDATE queue_settings SET concurrency = ?1 WHERE singleton = 1",
                [i64::from(value)],
            )
            .map_err(message)?;
        self.settings()
    }

    pub fn set_paused(&mut self, paused: bool) -> Result<QueueSettings, String> {
        self.connection
            .execute(
                "UPDATE queue_settings SET paused = ?1 WHERE singleton = 1",
                [i64::from(paused)],
            )
            .map_err(message)?;
        self.settings()
    }

    pub fn set_batch_paused(&mut self, batch_id: &str, paused: bool) -> Result<(), String> {
        validate_identifier(batch_id, "batch_id")?;
        let changed = self
            .connection
            .execute(
                "UPDATE queue_batches SET paused = ?1 WHERE batch_id = ?2",
                params![i64::from(paused), batch_id],
            )
            .map_err(message)?;
        if changed == 0 {
            return Err(format!("unknown batch_id: {batch_id}"));
        }
        Ok(())
    }

    pub fn enqueue(&mut self, input: EnqueueBatch) -> Result<EnqueueOutcome, String> {
        validate_batch(&input)?;
        let input_json = serde_json::to_string(&input).map_err(message)?;
        let now = epoch_milliseconds()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;

        if let Some(original_json) = transaction
            .query_row(
                "SELECT input_json FROM queue_batches WHERE batch_id = ?1",
                [&input.batch_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(message)?
        {
            let original: EnqueueBatch = serde_json::from_str(&original_json).map_err(message)?;
            if original != input {
                return Err(format!(
                    "batch_id {} was already used with different input",
                    input.batch_id
                ));
            }
            let outcome = read_batch_outcome(&transaction, &input.batch_id)?;
            transaction.commit().map_err(message)?;
            return Ok(outcome);
        }

        for job in &input.jobs {
            let collision = transaction
                .query_row(
                    "SELECT 1 FROM queue_batch_entries
                     WHERE submitted_request_id = ?1 OR submitted_attempt_id = ?2 LIMIT 1",
                    params![job.request_id, job.attempt_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(message)?;
            if collision.is_some() {
                return Err("request_id and attempt_id must be globally unique".into());
            }
        }

        transaction
            .execute(
                "INSERT INTO queue_batches (batch_id, input_json, paused, created_at_ms)
                 VALUES (?1, ?2, 0, ?3)",
                params![input.batch_id, input_json, now],
            )
            .map_err(message)?;

        for (ordinal, input_job) in input.jobs.iter().enumerate() {
            let existing_request_id = transaction
                .query_row(
                    "SELECT request_id FROM queue_jobs
                     WHERE project_id = ?1 AND slide_id = ?2
                       AND status IN ('queued', 'dispatching', 'running', 'result_ready',
                                      'committing', 'cancel_requested', 'outcome_unknown')",
                    params![input_job.target.project_id, input_job.target.slide_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(message)?;

            let (resolved_request_id, reused) = if let Some(request_id) = existing_request_id {
                (request_id, true)
            } else {
                let target_json = serde_json::to_string(&input_job.target).map_err(message)?;
                transaction
                    .execute(
                        "INSERT INTO queue_jobs (
                           batch_id, request_id, attempt_id, project_id, slide_id, target_json,
                           status, created_at_ms, updated_at_ms
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?7)",
                        params![
                            input.batch_id,
                            input_job.request_id,
                            input_job.attempt_id,
                            input_job.target.project_id,
                            input_job.target.slide_id,
                            target_json,
                            now,
                        ],
                    )
                    .map_err(message)?;
                transaction
                    .execute(
                        "INSERT INTO queue_attempts (attempt_id, request_id, target_json, created_at_ms)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![input_job.attempt_id, input_job.request_id, target_json, now],
                    )
                    .map_err(message)?;
                transaction
                    .execute(
                        "INSERT INTO queue_transition_events (
                           request_id, from_status, to_status, epoch, created_at_ms
                         ) VALUES (?1, NULL, 'queued', NULL, ?2)",
                        params![input_job.request_id, now],
                    )
                    .map_err(message)?;
                (input_job.request_id.clone(), false)
            };

            transaction
                .execute(
                    "INSERT INTO queue_batch_entries (
                       batch_id, ordinal, submitted_request_id, submitted_attempt_id,
                       resolved_request_id, reused
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        input.batch_id,
                        i64::try_from(ordinal).map_err(message)?,
                        input_job.request_id,
                        input_job.attempt_id,
                        resolved_request_id,
                        i64::from(reused),
                    ],
                )
                .map_err(message)?;
        }

        let outcome = read_batch_outcome(&transaction, &input.batch_id)?;
        transaction.commit().map_err(message)?;
        Ok(outcome)
    }

    pub fn list_jobs(&self) -> Result<Vec<QueueJob>, String> {
        let mut statement = self
            .connection
            .prepare(&format!("{JOB_COLUMNS} ORDER BY sequence"))
            .map_err(message)?;
        let jobs = statement
            .query_map([], row_to_job)
            .map_err(message)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(message)?;
        Ok(jobs)
    }

    pub fn get_job(&self, request_id: &str) -> Result<Option<QueueJob>, String> {
        read_job(&self.connection, request_id)
    }

    pub fn claim_next(&mut self, epoch: i64) -> Result<Option<QueueJob>, String> {
        let now = epoch_milliseconds()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        let settings = read_settings(&transaction)?;
        if epoch != settings.epoch {
            return Err(format!(
                "queue epoch mismatch: expected {}, received {epoch}",
                settings.epoch
            ));
        }
        if settings.paused {
            transaction.commit().map_err(message)?;
            return Ok(None);
        }
        let occupied: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM queue_jobs
                 WHERE status IN ('dispatching', 'running', 'cancel_requested', 'outcome_unknown')",
                [],
                |row| row.get(0),
            )
            .map_err(message)?;
        if occupied >= i64::from(settings.concurrency) {
            transaction.commit().map_err(message)?;
            return Ok(None);
        }

        let request_id = transaction
            .query_row(
                "SELECT jobs.request_id FROM queue_jobs AS jobs
                 JOIN queue_batches AS batches ON batches.batch_id = jobs.batch_id
                 WHERE jobs.status = 'queued' AND batches.paused = 0
                 ORDER BY jobs.sequence LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(message)?;
        let Some(request_id) = request_id else {
            transaction.commit().map_err(message)?;
            return Ok(None);
        };

        transaction
            .execute(
                "UPDATE queue_jobs
                 SET status = 'dispatching', epoch = ?1, updated_at_ms = ?2, dispatched_at_ms = ?2
                 WHERE request_id = ?3 AND status = 'queued'",
                params![epoch, now, request_id],
            )
            .map_err(message)?;
        transaction
            .execute(
                "INSERT INTO queue_transition_events (
                   request_id, from_status, to_status, epoch, created_at_ms
                 ) VALUES (?1, 'queued', 'dispatching', ?2, ?3)",
                params![request_id, epoch, now],
            )
            .map_err(message)?;
        let job = read_job(&transaction, &request_id)?
            .ok_or_else(|| "claimed queue job disappeared".to_string())?;
        transaction.commit().map_err(message)?;
        Ok(Some(job))
    }
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn pragma_i64(connection: &Connection, name: &str) -> Result<i64, String> {
    connection
        .pragma_query_value(None, name, |row| row.get(0))
        .map_err(message)
}

fn user_tables(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND lower(substr(name, 1, 7)) <> 'sqlite_' ORDER BY name",
        )
        .map_err(message)?;
    let tables = statement
        .query_map([], |row| row.get(0))
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    Ok(tables)
}

fn verify_schema(connection: &Connection, tables: &[String]) -> Result<(), String> {
    let actual_tables: HashSet<&str> = tables.iter().map(String::as_str).collect();
    let expected_tables: HashSet<&str> = SCHEMA_OBJECTS
        .iter()
        .filter(|object| object.kind == "table")
        .map(|object| object.name)
        .collect();
    if actual_tables != expected_tables {
        return Err("durable queue schema does not match user_version 1".into());
    }
    for object in SCHEMA_OBJECTS {
        let actual: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = ?1 AND name = ?2",
                params![object.kind, object.name],
                |row| row.get(0),
            )
            .optional()
            .map_err(message)?;
        if actual.as_deref().map(normalized_schema_sql).as_deref()
            != Some(&normalized_schema_sql(object.sql))
        {
            return Err(format!(
                "durable queue {} {} does not match user_version 1",
                object.kind, object.name
            ));
        }
    }
    Ok(())
}

fn normalized_schema_sql(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character.is_whitespace() {
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

fn read_settings(connection: &Connection) -> Result<QueueSettings, String> {
    connection
        .query_row(
            "SELECT concurrency, paused, epoch FROM queue_settings WHERE singleton = 1",
            [],
            |row| {
                let concurrency = row.get::<_, i64>(0)?;
                Ok(QueueSettings {
                    concurrency: u8::try_from(concurrency).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Integer,
                            Box::new(error),
                        )
                    })?,
                    paused: row.get::<_, i64>(1)? != 0,
                    epoch: row.get(2)?,
                })
            },
        )
        .map_err(message)
}

const JOB_COLUMNS: &str = "SELECT sequence, batch_id, request_id, attempt_id, target_json,
 status, epoch, provider_json, result_json, error, created_at_ms, updated_at_ms, dispatched_at_ms
 FROM queue_jobs";

pub(super) fn read_job(
    connection: &Connection,
    request_id: &str,
) -> Result<Option<QueueJob>, String> {
    connection
        .query_row(
            &format!("{JOB_COLUMNS} WHERE request_id = ?1"),
            [request_id],
            row_to_job,
        )
        .optional()
        .map_err(message)
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<QueueJob> {
    let target_json: String = row.get(4)?;
    let provider_json: Option<String> = row.get(7)?;
    let result_json: Option<String> = row.get(8)?;
    Ok(QueueJob {
        sequence: row.get(0)?,
        batch_id: row.get(1)?,
        request_id: row.get(2)?,
        attempt_id: row.get(3)?,
        target: parse_json(4, &target_json)?,
        status: parse_status(5, &row.get::<_, String>(5)?)?,
        epoch: row.get(6)?,
        provider: provider_json
            .as_deref()
            .map(|value| parse_json(7, value))
            .transpose()?,
        result: result_json
            .as_deref()
            .map(|value| parse_json(8, value))
            .transpose()?,
        error: row.get(9)?,
        created_at_ms: row.get(10)?,
        updated_at_ms: row.get(11)?,
        dispatched_at_ms: row.get(12)?,
    })
}

fn parse_json<T: serde::de::DeserializeOwned>(index: usize, value: &str) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn parse_status(index: usize, value: &str) -> rusqlite::Result<JobStatus> {
    let quoted = serde_json::to_string(value).expect("string serialization cannot fail");
    parse_json(index, &quoted)
}

fn read_batch_outcome(connection: &Connection, batch_id: &str) -> Result<EnqueueOutcome, String> {
    let mut statement = connection
        .prepare(
            "SELECT resolved_request_id, reused FROM queue_batch_entries
             WHERE batch_id = ?1 ORDER BY ordinal",
        )
        .map_err(message)?;
    let entries = statement
        .query_map([batch_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
        })
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    let mut jobs = Vec::with_capacity(entries.len());
    let mut reused_request_ids = Vec::new();
    for (request_id, reused) in entries {
        let job = read_job(connection, &request_id)?
            .ok_or_else(|| format!("batch {batch_id} references a missing queue job"))?;
        if reused && !reused_request_ids.contains(&request_id) {
            reused_request_ids.push(request_id.clone());
        }
        jobs.push(job);
    }
    Ok(EnqueueOutcome {
        jobs,
        reused_request_ids,
    })
}

fn epoch_milliseconds() -> Result<i64, String> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(message)?
        .as_millis();
    i64::try_from(milliseconds).map_err(message)
}

fn validate_batch(input: &EnqueueBatch) -> Result<(), String> {
    validate_identifier(&input.batch_id, "batch_id")?;
    if input.jobs.is_empty() || input.jobs.len() > MAX_BATCH_SIZE {
        return Err(format!("batch must contain 1..={MAX_BATCH_SIZE} jobs"));
    }
    let mut pages = HashSet::new();
    let mut requests = HashSet::new();
    let mut attempts = HashSet::new();
    for job in &input.jobs {
        validate_identifier(&job.request_id, "request_id")?;
        validate_identifier(&job.attempt_id, "attempt_id")?;
        validate_target(&job.target)?;
        if !requests.insert(job.request_id.as_str()) {
            return Err("request_id values must be unique within a batch".into());
        }
        if !attempts.insert(job.attempt_id.as_str()) {
            return Err("attempt_id values must be unique within a batch".into());
        }
        if !pages.insert((job.target.project_id.as_str(), job.target.slide_id.as_str())) {
            return Err("project_id/slide_id pages must be unique within a batch".into());
        }
    }
    Ok(())
}

fn validate_target(target: &QueueTarget) -> Result<(), String> {
    validate_identifier(&target.project_id, "project_id")?;
    validate_identifier(&target.slide_id, "slide_id")?;
    for (name, value) in [
        ("spec", &target.spec),
        ("design", &target.design),
        ("skill", &target.skill),
        ("palette", &target.palette),
    ] {
        validate_bounded_text(&value.version, name, 1, MAX_VERSION_BYTES)?;
        validate_hash(&value.sha256, &format!("{name}.sha256"))?;
    }
    validate_bounded_text(
        &target.prompt_version,
        "prompt_version",
        1,
        MAX_VERSION_BYTES,
    )?;
    validate_free_text(&target.prompt, "prompt", 1, MAX_PROMPT_BYTES)?;
    validate_free_text(&target.feedback, "feedback", 0, MAX_FEEDBACK_BYTES)?;
    if target.references.len() > MAX_REFERENCES {
        return Err(format!(
            "references must contain at most {MAX_REFERENCES} items"
        ));
    }
    let mut asset_ids = HashSet::new();
    if let Some(parent) = &target.parent_visual {
        validate_identifier(&parent.asset_id, "parent_visual.asset_id")?;
        validate_hash(&parent.sha256, "parent_visual.sha256")?;
    }
    for reference in &target.references {
        validate_identifier(&reference.asset_id, "references.asset_id")?;
        validate_hash(&reference.sha256, "references.sha256")?;
        if !asset_ids.insert(reference.asset_id.as_str()) {
            return Err("reference asset_id values must be unique".into());
        }
    }
    let encoded = serde_json::to_vec(target).map_err(message)?;
    if encoded.len() > MAX_TARGET_BYTES {
        return Err(format!(
            "serialized target exceeds {MAX_TARGET_BYTES} bytes"
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
        || !bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-' || *byte == b'_'
        })
    {
        return Err(format!("{field} must be a lowercase identifier"));
    }
    Ok(())
}

fn validate_bounded_text(
    value: &str,
    field: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), String> {
    let length = value.len();
    if value.contains('\0') || length < minimum || length > maximum {
        return Err(format!(
            "{field} must contain {minimum}..={maximum} UTF-8 bytes without NUL"
        ));
    }
    if minimum > 0 && value.trim().is_empty() {
        return Err(format!("{field} must not be blank"));
    }
    Ok(())
}

fn validate_free_text(
    value: &str,
    field: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), String> {
    let length = value.len();
    if value.contains('\0') || length < minimum || length > maximum {
        return Err(format!(
            "{field} must contain {minimum}..={maximum} UTF-8 bytes without NUL"
        ));
    }
    Ok(())
}

fn validate_hash(value: &str, field: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(format!(
            "{field} must be 64 lowercase hexadecimal characters"
        ));
    }
    Ok(())
}
