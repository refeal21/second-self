//! A single durable order for V3 image and text admissions; no dispatcher.
use super::store::message;
use rusqlite::{params, Connection};

pub(crate) fn next_sequence(tx: &Connection) -> Result<i64, String> {
    if tx.is_autocommit() {
        return Err("V3 admission requires writer transaction".into());
    }
    let high: i64 = tx.query_row("SELECT COALESCE(MAX(seq),0) FROM sqlite_sequence WHERE name IN ('queue_jobs','v3_text_operations')",[],|r|r.get(0)).map_err(message)?;
    high.checked_add(1)
        .filter(|n| *n > 0)
        .ok_or_else(|| "V3 admission sequence exhausted".into())
}

pub(crate) fn check_image_identities(
    tx: &Connection,
    request: &str,
    attempt: &str,
) -> Result<(), String> {
    let collision: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM v3_text_operations WHERE operation_id IN (?1,?2) OR attempt_id IN (?1,?2))",params![request,attempt],|r|r.get(0)).map_err(message)?;
    if collision {
        Err("image/text request or attempt identity collision".into())
    } else {
        Ok(())
    }
}

pub(super) fn check_text_identities(
    tx: &Connection,
    operation: &str,
    attempt: &str,
) -> Result<(), String> {
    let collision: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM queue_batch_entries WHERE submitted_request_id IN (?1,?2) OR submitted_attempt_id IN (?1,?2)) OR EXISTS(SELECT 1 FROM queue_jobs WHERE request_id IN (?1,?2) OR attempt_id IN (?1,?2)) OR EXISTS(SELECT 1 FROM v3_text_operations WHERE operation_id IN (?1,?2) OR attempt_id IN (?1,?2))",params![operation,attempt],|r|r.get(0)).map_err(message)?;
    if collision || operation == attempt {
        Err("image/text request or attempt identity collision".into())
    } else {
        Ok(())
    }
}
