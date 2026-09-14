//! Native-only bridge between immutable verified PNG files and durable queue evidence.
//!
//! These methods stop at `result_ready`: they do not publish a visual candidate,
//! grant approval eligibility, or mark a queue job succeeded.

use super::lifecycle::record_result_evidence;
use super::store::{message, read_job, read_settings};
use super::{JobStatus, QueueJob, QueueStore, ResultBinding, ResultVault, VerifiedPngResult};
use rusqlite::TransactionBehavior;
use sha2::{Digest, Sha256};

impl QueueStore {
    pub fn stage_png_result(
        &mut self,
        vault: &ResultVault,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
        png: &[u8],
    ) -> Result<QueueJob, String> {
        let binding = self.preflight_png_result(epoch, request_id, attempt_id)?;
        let verified = vault.stage(&binding, png)?;
        self.record_verified_png_result(epoch, request_id, attempt_id, &verified)
    }

    pub fn recover_png_result(
        &mut self,
        vault: &ResultVault,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
    ) -> Result<QueueJob, String> {
        let binding = self.preflight_png_result(epoch, request_id, attempt_id)?;
        let verified = vault.recover(&binding)?;
        self.record_verified_png_result(epoch, request_id, attempt_id, &verified)
    }

    fn preflight_png_result(
        &self,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
    ) -> Result<ResultBinding, String> {
        let tx = self.connection.unchecked_transaction().map_err(message)?;
        require_current_runtime(&tx, epoch)?;
        let job = exact_attempt(&tx, request_id, attempt_id)?;
        require_result_eligible(&job, epoch)?;
        let binding = result_binding(&job)?;
        tx.commit().map_err(message)?;
        Ok(binding)
    }

    fn record_verified_png_result(
        &mut self,
        epoch: i64,
        request_id: &str,
        attempt_id: &str,
        verified: &VerifiedPngResult,
    ) -> Result<QueueJob, String> {
        // Acquire a fresh write snapshot after byte verification to fence runtime
        // changes and request replacement at the recording boundary.
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        require_current_runtime(&tx, epoch)?;
        let job = exact_attempt(&tx, request_id, attempt_id)?;
        if result_binding(&job)? != *verified.binding() {
            return Err("verified PNG binding no longer matches the queue target".into());
        }

        if job.status == JobStatus::ResultReady {
            if job.result.as_ref() != Some(verified.manifest()) {
                return Err("verified PNG does not match the persisted ready result".into());
            }
            tx.commit().map_err(message)?;
            return Ok(job);
        }

        require_active_owner(&job, epoch)?;
        let job = record_result_evidence(&tx, job, verified.manifest().clone())?;
        tx.commit().map_err(message)?;
        Ok(job)
    }
}

fn require_current_runtime(connection: &rusqlite::Connection, epoch: i64) -> Result<(), String> {
    if read_settings(connection)?.epoch == epoch {
        Ok(())
    } else {
        Err("queue epoch mismatch".into())
    }
}

fn exact_attempt(
    connection: &rusqlite::Connection,
    request_id: &str,
    attempt_id: &str,
) -> Result<QueueJob, String> {
    let job =
        read_job(connection, request_id)?.ok_or_else(|| "queue request not found".to_string())?;
    if job.attempt_id != attempt_id {
        return Err("attempt identity mismatch".into());
    }
    Ok(job)
}

fn require_result_eligible(job: &QueueJob, epoch: i64) -> Result<(), String> {
    if job.status == JobStatus::ResultReady {
        if job.result.is_some() {
            return Ok(());
        }
        return Err("result-ready job has no persisted result".into());
    }
    require_active_owner(job, epoch)
}

fn require_active_owner(job: &QueueJob, epoch: i64) -> Result<(), String> {
    if job.epoch == Some(epoch)
        && matches!(
            job.status,
            JobStatus::Dispatching
                | JobStatus::Running
                | JobStatus::OutcomeUnknown
                | JobStatus::CancelRequested
        )
    {
        Ok(())
    } else {
        Err("queue result is not eligible for this attempt and runtime".into())
    }
}

pub(crate) fn result_binding(job: &QueueJob) -> Result<ResultBinding, String> {
    let target = serde_json::to_vec(&job.target).map_err(message)?;
    Ok(ResultBinding {
        request_id: job.request_id.clone(),
        attempt_id: job.attempt_id.clone(),
        target_sha256: format!("{:x}", Sha256::digest(target)),
    })
}
