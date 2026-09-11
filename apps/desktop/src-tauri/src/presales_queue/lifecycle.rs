//! Durable attempt lifecycle. `record_result_ready` remains a metadata declaration,
//! not proof of a file or permission to publish a candidate; the native staging
//! bridge uses a separate verified, transaction-fenced path below.

use super::store::{
    epoch_milliseconds, message, read_job, read_jobs, read_settings, validate_hash,
};
use super::{
    JobStatus, ProviderIdentity, QueueEvent, QueueJob, QueueStore, RecoverySnapshot, StagedResult,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};

impl QueueStore {
    /// Supervisor-only startup boundary. Opening a connection does not invoke it.
    /// Ambiguous attempts retain their slot and acquire the new owner's epoch.
    pub fn begin_runtime(&mut self) -> Result<RecoverySnapshot, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        let epoch = read_settings(&tx)?
            .epoch
            .checked_add(1)
            .ok_or("queue epoch exhausted")?;
        tx.execute(
            "UPDATE queue_settings SET epoch = ?1 WHERE singleton = 1",
            [epoch],
        )
        .map_err(message)?;
        for mut job in read_jobs(&tx)? {
            if remote_active(&job.status) {
                let from = job.status.clone();
                let old_epoch = job.epoch;
                job.status = JobStatus::OutcomeUnknown;
                job.epoch = Some(epoch);
                persist_change(
                    &tx,
                    &mut job,
                    from,
                    "runtime_recovered",
                    json!({"previousEpoch": old_epoch, "epoch": epoch}),
                )?;
            }
        }
        let snapshot = snapshot(&tx)?;
        tx.commit().map_err(message)?;
        Ok(snapshot)
    }

    pub fn recovery_snapshot(&self) -> Result<RecoverySnapshot, String> {
        // One SQLite read snapshot: never combine settings and jobs from different runtimes.
        let tx = self.connection.unchecked_transaction().map_err(message)?;
        let snapshot = snapshot(&tx)?;
        tx.commit().map_err(message)?;
        Ok(snapshot)
    }

    pub fn record_provider(
        &mut self,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
        identity: ProviderIdentity,
    ) -> Result<QueueJob, String> {
        validate_identity(&identity.thread_id)?;
        if let Some(turn) = &identity.turn_id {
            validate_identity(turn)?;
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        let mut job = owned_job(&tx, epoch, request_id, attempt_id)?;
        if let Some(known) = &job.provider {
            if known.thread_id != identity.thread_id
                || matches!((&known.turn_id, &identity.turn_id), (Some(old), Some(new)) if old != new)
            {
                return Err("provider identity is immutable".into());
            }
        }
        let detail = serde_json::to_value(&identity).map_err(message)?;
        if exact_event(&tx, &job, "provider_recorded", &detail)? {
            return Ok(job);
        }
        require(remote_active(&job.status))?;
        let from = job.status.clone();
        let provider = match &job.provider {
            Some(known) if known.turn_id.is_some() => known.clone(),
            _ => identity,
        };
        // A less complete repeat is not new evidence and must never clear a known turn.
        if job.provider.as_ref() == Some(&provider) {
            return Ok(job);
        }
        job.provider = Some(provider);
        if job.status == JobStatus::Dispatching {
            job.status = JobStatus::Running;
        }
        persist_change(&tx, &mut job, from, "provider_recorded", detail)?;
        tx.commit().map_err(message)?;
        Ok(job)
    }

    /// A current control intent, not replayed provider evidence: after recovery
    /// it may request cancellation again without releasing the logical slot.
    pub fn request_cancel(&mut self, request_id: &str) -> Result<QueueJob, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        let mut job = required_job(&tx, request_id)?;
        let from = job.status.clone();
        job.status = match job.status {
            JobStatus::Queued => JobStatus::Cancelled,
            JobStatus::Dispatching | JobStatus::Running | JobStatus::OutcomeUnknown => {
                JobStatus::CancelRequested
            }
            JobStatus::CancelRequested | JobStatus::Cancelled => return Ok(job),
            _ => return Err("cancellation is not allowed from this state".into()),
        };
        persist_change(&tx, &mut job, from, "cancel_requested", json!({}))?;
        tx.commit().map_err(message)?;
        Ok(job)
    }

    /// Call only with proof that the remote attempt has stopped.
    pub fn confirm_cancelled(
        &mut self,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
    ) -> Result<QueueJob, String> {
        self.apply_evidence(epoch, request_id, attempt_id, Evidence::Cancelled)
    }

    /// A proven remote terminal failure, never a connection timeout.
    pub fn mark_failed(
        &mut self,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
        error: &str,
    ) -> Result<QueueJob, String> {
        validate_reason(error)?;
        self.apply_evidence(
            epoch,
            request_id,
            attempt_id,
            Evidence::Failed(error.to_owned()),
        )
    }

    pub fn mark_outcome_unknown(
        &mut self,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
        reason: &str,
    ) -> Result<QueueJob, String> {
        validate_reason(reason)?;
        self.apply_evidence(
            epoch,
            request_id,
            attempt_id,
            Evidence::Unknown(reason.to_owned()),
        )
    }

    /// Metadata-only manifest boundary retained for the existing native queue RPC.
    /// This method does not read, create, validate, or publish a PNG. Cancellation
    /// wins if durably recorded first, including across runtime recovery.
    pub fn record_result_ready(
        &mut self,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
        result: StagedResult,
    ) -> Result<QueueJob, String> {
        validate_result(request_id, attempt_id, &result)?;
        self.apply_evidence(epoch, request_id, attempt_id, Evidence::Result(result))
    }

    pub fn abandon_unresolved(
        &mut self,
        request_id: &str,
        acknowledge_duplicate_risk: bool,
    ) -> Result<QueueJob, String> {
        if !acknowledge_duplicate_risk {
            return Err("explicit duplicate-risk acknowledgement required".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        let mut job = required_job(&tx, request_id)?;
        let detail = json!({"acknowledgeDuplicateRisk": true});
        if replay(&tx, &job, "abandoned_unresolved", &detail)? {
            return Ok(job);
        }
        require(matches!(
            job.status,
            JobStatus::OutcomeUnknown | JobStatus::CancelRequested
        ))?;
        let from = job.status.clone();
        job.status = JobStatus::AbandonedUnresolved;
        persist_change(&tx, &mut job, from, "abandoned_unresolved", detail)?;
        tx.commit().map_err(message)?;
        Ok(job)
    }

    /// Audit-only metadata on the exact abandoned attempt, without resolving its
    /// duplicate risk, setting a candidate-ready result, or touching a new job.
    pub fn record_late_result(
        &mut self,
        request_id: &str,
        attempt_id: &str,
        result: StagedResult,
    ) -> Result<(), String> {
        validate_result(request_id, attempt_id, &result)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        let mut job = required_job(&tx, request_id)?;
        require(job.attempt_id == attempt_id && job.status == JobStatus::AbandonedUnresolved)?;
        let detail = serde_json::to_value(result).map_err(message)?;
        if replay(&tx, &job, "late_result", &detail)? {
            return Ok(());
        }
        let from = job.status.clone();
        persist_change(&tx, &mut job, from, "late_result", detail)?;
        tx.commit().map_err(message)?;
        Ok(())
    }

    /// Detailed lifecycle evidence. Admission/dispatch also retain their original
    /// status audit in queue_transition_events.
    pub fn events(&self, request_id: &str) -> Result<Vec<QueueEvent>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT sequence, request_id, attempt_id, kind, detail_json, created_at_ms
             FROM queue_lifecycle_events WHERE request_id = ?1 ORDER BY sequence",
            )
            .map_err(message)?;
        let rows = statement
            .query_map([request_id], |row| {
                let detail: String = row.get(4)?;
                Ok(QueueEvent {
                    sequence: row.get(0)?,
                    request_id: row.get(1)?,
                    attempt_id: row.get(2)?,
                    kind: row.get(3)?,
                    detail: serde_json::from_str(&detail).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    created_at_ms: row.get(5)?,
                })
            })
            .map_err(message)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(message)?;
        Ok(rows)
    }

    // Closed evidence types prevent a generic public status setter/publication path.
    fn apply_evidence(
        &mut self,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
        evidence: Evidence,
    ) -> Result<QueueJob, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        let mut job = owned_job(&tx, epoch, request_id, attempt_id)?;
        let evidence = match evidence {
            Evidence::Result(result) => {
                let job = record_result_evidence(&tx, job, result)?;
                tx.commit().map_err(message)?;
                return Ok(job);
            }
            other => other,
        };
        let (kind, detail) = evidence.event()?;
        // Fence before replay; then return the CURRENT immutable request's job,
        // never an old response snapshot and never a same-page replacement.
        if replay(&tx, &job, kind, &detail)? {
            return Ok(job);
        }
        require(remote_active(&job.status))?;
        let from = job.status.clone();
        match evidence {
            Evidence::Cancelled => {
                job.status = JobStatus::Cancelled;
            }
            Evidence::Failed(error) => {
                job.status = JobStatus::Failed;
                job.error = Some(error);
            }
            Evidence::Unknown(reason) => {
                require(job.status != JobStatus::OutcomeUnknown)?;
                job.status = JobStatus::OutcomeUnknown;
                job.error = Some(reason);
            }
            Evidence::Result(_) => unreachable!("result evidence is handled above"),
        }
        persist_change(&tx, &mut job, from, kind, detail)?;
        tx.commit().map_err(message)?;
        Ok(job)
    }
}

pub(crate) fn record_result_evidence(
    tx: &Transaction<'_>,
    mut job: QueueJob,
    result: StagedResult,
) -> Result<QueueJob, String> {
    let detail = serde_json::to_value(&result).map_err(message)?;
    if replay(tx, &job, "result_ready", &detail)? {
        return Ok(job);
    }
    require(remote_active(&job.status))?;
    let from = job.status.clone();
    let cancel_was_requested = job.status == JobStatus::CancelRequested
        || exact_event(tx, &job, "cancel_requested", &json!({}))?;
    if cancel_was_requested {
        job.status = JobStatus::Cancelled;
    } else {
        job.status = JobStatus::ResultReady;
        job.result = Some(result);
    }
    persist_change(tx, &mut job, from, "result_ready", detail)?;
    Ok(job)
}

enum Evidence {
    Cancelled,
    Failed(String),
    Unknown(String),
    Result(StagedResult),
}

impl Evidence {
    fn event(&self) -> Result<(&'static str, Value), String> {
        Ok(match self {
            Self::Cancelled => ("cancel_confirmed", json!({})),
            Self::Failed(error) => ("failed", json!({"error": error})),
            Self::Unknown(reason) => ("outcome_unknown", json!({"reason": reason})),
            Self::Result(result) => (
                "result_ready",
                serde_json::to_value(result).map_err(message)?,
            ),
        })
    }
}

fn snapshot(connection: &Connection) -> Result<RecoverySnapshot, String> {
    let settings = read_settings(connection)?;
    let jobs = read_jobs(connection)?;
    let unresolved_remote_count = jobs
        .iter()
        .filter(|job| {
            matches!(
                job.status,
                JobStatus::OutcomeUnknown
                    | JobStatus::CancelRequested
                    | JobStatus::AbandonedUnresolved
            )
        })
        .count();
    Ok(RecoverySnapshot {
        settings,
        jobs,
        unresolved_remote_count,
    })
}

fn required_job(connection: &Connection, request_id: &str) -> Result<QueueJob, String> {
    read_job(connection, request_id)?.ok_or_else(|| "queue request not found".into())
}

fn owned_job(
    connection: &Connection,
    epoch: i64,
    request_id: &str,
    attempt_id: &str,
) -> Result<QueueJob, String> {
    if read_settings(connection)?.epoch != epoch {
        return Err("queue epoch mismatch".into());
    }
    let job = required_job(connection, request_id)?;
    if job.epoch != Some(epoch) || job.attempt_id != attempt_id {
        return Err("attempt identity or owning epoch mismatch".into());
    }
    Ok(job)
}

/// Only the native V3 publisher calls this inside its version/receipt transaction.
pub(crate) fn commit_success_on(
    tx: &Transaction<'_>,
    epoch: i64,
    request_id: &str,
    attempt_id: &str,
    verified: &super::VerifiedPngResult,
    version_id: &str,
) -> Result<QueueJob, String> {
    if read_settings(tx)?.epoch != epoch {
        return Err("queue epoch mismatch".into());
    }
    let mut job = required_job(tx, request_id)?;
    // ResultReady survives supervisor recovery without changing its owning epoch.
    require(job.attempt_id == attempt_id && job.status == JobStatus::ResultReady)?;
    if job.result.as_ref() != Some(verified.manifest())
        || super::result_staging::result_binding(&job)? != *verified.binding()
        || exact_event(tx, &job, "cancel_requested", &json!({}))?
    {
        return Err("result evidence or durable cancellation prevents publication".into());
    }
    let from = job.status.clone();
    job.status = JobStatus::Succeeded;
    persist_change(
        tx,
        &mut job,
        from,
        "published",
        json!({"versionId": version_id}),
    )?;
    Ok(job)
}

fn remote_active(status: &JobStatus) -> bool {
    matches!(
        status,
        JobStatus::Dispatching
            | JobStatus::Running
            | JobStatus::CancelRequested
            | JobStatus::OutcomeUnknown
    )
}

fn require(allowed: bool) -> Result<(), String> {
    if allowed {
        Ok(())
    } else {
        Err("lifecycle transition is not allowed from this state".into())
    }
}

fn exact_event(
    connection: &Connection,
    job: &QueueJob,
    kind: &str,
    detail: &Value,
) -> Result<bool, String> {
    let encoded = serde_json::to_string(detail).map_err(message)?;
    let exists = connection.query_row(
        "SELECT 1 FROM queue_lifecycle_events WHERE request_id = ?1 AND attempt_id = ?2 AND kind = ?3 AND detail_json = ?4 LIMIT 1",
        params![job.request_id, job.attempt_id, kind, encoded], |_| Ok(())
    ).optional().map_err(message)?.is_some();
    Ok(exists)
}

fn replay(
    connection: &Connection,
    job: &QueueJob,
    kind: &str,
    detail: &Value,
) -> Result<bool, String> {
    if exact_event(connection, job, kind, detail)? {
        return Ok(true);
    }
    let exists = connection.query_row(
        "SELECT 1 FROM queue_lifecycle_events WHERE request_id = ?1 AND attempt_id = ?2 AND kind = ?3 LIMIT 1",
        params![job.request_id, job.attempt_id, kind], |_| Ok(())
    ).optional().map_err(message)?.is_some();
    if exists {
        Err("conflicting duplicate lifecycle evidence".into())
    } else {
        Ok(false)
    }
}

fn persist_change(
    tx: &Transaction<'_>,
    job: &mut QueueJob,
    from: JobStatus,
    kind: &str,
    detail: Value,
) -> Result<(), String> {
    let now = epoch_milliseconds()?;
    let status = serde_json::to_value(&job.status).map_err(message)?;
    let from_status = serde_json::to_value(&from).map_err(message)?;
    tx.execute(
        "UPDATE queue_jobs SET status = ?1, epoch = ?2, provider_json = ?3, result_json = ?4, error = ?5, updated_at_ms = ?6 WHERE request_id = ?7 AND attempt_id = ?8",
        params![status.as_str(), job.epoch, job.provider.as_ref().map(serde_json::to_string).transpose().map_err(message)?,
            job.result.as_ref().map(serde_json::to_string).transpose().map_err(message)?, job.error, now, job.request_id, job.attempt_id]
    ).map_err(message)?;
    if from != job.status {
        tx.execute("INSERT INTO queue_transition_events (request_id, from_status, to_status, epoch, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![job.request_id, from_status.as_str(), status.as_str(), job.epoch, now]).map_err(message)?;
    }
    tx.execute("INSERT INTO queue_lifecycle_events (request_id, attempt_id, kind, detail_json, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![job.request_id, job.attempt_id, kind, serde_json::to_string(&detail).map_err(message)?, now]).map_err(message)?;
    job.updated_at_ms = now;
    Ok(())
}

fn validate_identity(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        Err(
            "provider identity must be nonblank, at most 256 bytes, without control characters"
                .into(),
        )
    } else {
        Ok(())
    }
}

fn validate_reason(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 4096 || value.contains('\0') {
        Err("error/reason must be nonblank and at most 4096 bytes without NUL".into())
    } else {
        Ok(())
    }
}

fn validate_result(
    request_id: &str,
    attempt_id: &str,
    result: &StagedResult,
) -> Result<(), String> {
    if result.relative_path != format!("queue-results/{request_id}/{attempt_id}.png")
        || !(1..=52_428_800).contains(&result.byte_length)
    {
        return Err(
            "result must declare the exact attempt-relative PNG path and 1..=52428800 bytes".into(),
        );
    }
    validate_hash(&result.sha256, "result.sha256")
}
