//! Only the dedicated native host invokes these correlated lifecycle callbacks.
use super::{
    store::{message, write_on},
    supervisor::RuntimeWork,
    *,
};
use crate::presales_queue::{
    store::{epoch_milliseconds, read_jobs, read_settings},
    JobStatus, ProviderIdentity, ResultVault,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueSnapshot {
    pub dispatch_available: bool,
    pub settings: crate::presales_queue::QueueSettings,
    pub remote_active: usize,
    pub succeeded: usize,
    pub jobs: Vec<QueueJobSummary>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueJobSummary {
    pub kind: String,
    pub request_id: String,
    pub project_id: String,
    pub slide_id: Option<String>,
    pub status: String,
    pub sequence: i64,
}

impl V3WorkbenchService {
    pub(super) fn terminal_work(
        &self,
        epoch: i64,
        work: &RuntimeWork,
        provider: TextProviderIdentity,
        result: &Value,
    ) -> Result<(), String> {
        let cancelled = result["kind"] == "cancelled";
        let reason = if cancelled {
            "remote cancellation confirmed"
        } else if result["kind"] == "failed" {
            result["error"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.len() <= 4096 && !s.contains('\0'))
                .ok_or("invalid terminal failure")?
        } else {
            return Err("terminal evidence requires a closed outcome".into());
        };
        if provider.turn_id.as_ref().is_none_or(|s| s.is_empty()) {
            return Err("terminal turn identity missing".into());
        }
        match work {
            RuntimeWork::Image(_) => {
                let mut q = self
                    .image_lifecycle
                    .lock()
                    .map_err(|_| "image lifecycle lock poisoned")?;
                let job = q.get_job(work.id())?.ok_or("terminal image missing")?;
                if job.provider
                    != Some(ProviderIdentity {
                        thread_id: provider.thread_id,
                        turn_id: provider.turn_id,
                    })
                {
                    return Err("terminal provider mismatch".into());
                }
                if cancelled {
                    q.confirm_cancelled(epoch, work.id(), work.attempt())?;
                } else {
                    q.mark_failed(epoch, work.id(), work.attempt(), reason)?;
                }
            }
            RuntimeWork::Text(_) => {
                let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
                write_on(&mut store.connection, |tx| {
                    let op = super::text_operations::read_on(tx, work.id())?;
                    if read_settings(tx)?.epoch != epoch
                        || op.epoch != Some(epoch)
                        || op.attempt_id != work.attempt()
                        || op.provider.as_ref() != Some(&provider)
                    {
                        return Err("terminal text owner/provider mismatch".into());
                    }
                    if matches!(
                        op.status,
                        V3TextStatus::Dispatching
                            | V3TextStatus::Running
                            | V3TextStatus::CancelRequested
                            | V3TextStatus::OutcomeUnknown
                    ) {
                        tx.execute("UPDATE v3_text_operations SET status=?1,error=?2,updated_at_ms=?3 WHERE operation_id=?4",params![if cancelled||op.cancellation.is_some(){"cancelled"}else{"failed"},reason,epoch_milliseconds()?,work.id()]).map_err(message)?;
                    }
                    Ok(())
                })?;
            }
        }
        Ok(())
    }
    pub(crate) fn queue_snapshot(&self) -> Result<QueueSnapshot, String> {
        let store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        let tx = store.connection.unchecked_transaction().map_err(message)?;
        let settings = read_settings(&tx)?;
        let mut jobs = read_jobs(&tx)?
            .into_iter()
            .map(|j| {
                Ok(QueueJobSummary {
                    kind: "image".into(),
                    request_id: j.request_id,
                    project_id: j.target.project_id,
                    slide_id: Some(j.target.slide_id),
                    status: serde_json::to_value(j.status)
                        .map_err(message)?
                        .as_str()
                        .ok_or("invalid status")?
                        .into(),
                    sequence: j.sequence,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut statement = tx
            .prepare("SELECT operation_id FROM v3_text_operations ORDER BY sequence")
            .map_err(message)?;
        let ids = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(message)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(message)?;
        drop(statement);
        for id in ids {
            let j = super::text_operations::read_on(&tx, &id)?;
            jobs.push(QueueJobSummary {
                kind: "text".into(),
                request_id: id,
                project_id: j.target.project_id,
                slide_id: None,
                status: serde_json::to_value(j.status)
                    .map_err(message)?
                    .as_str()
                    .ok_or("invalid status")?
                    .into(),
                sequence: j.sequence,
            });
        }
        jobs.sort_by_key(|j| j.sequence);
        let remote_active = jobs
            .iter()
            .filter(|j| {
                matches!(
                    j.status.as_str(),
                    "dispatching" | "running" | "outcome_unknown" | "cancel_requested"
                )
            })
            .count();
        let succeeded = jobs.iter().filter(|j| j.status == "succeeded").count();
        tx.commit().map_err(message)?;
        Ok(QueueSnapshot {
            dispatch_available: false,
            settings,
            remote_active,
            succeeded,
            jobs,
        })
    }
    pub(super) fn provider_identity(
        &self,
        epoch: i64,
        work: &RuntimeWork,
        identity: TextProviderIdentity,
    ) -> Result<(), String> {
        match work {
            RuntimeWork::Text(_) => {
                self.record_text_provider(epoch, work.id(), work.attempt(), identity)?;
            }
            RuntimeWork::Image(_) => {
                self.image_lifecycle
                    .lock()
                    .map_err(|_| "image lifecycle lock poisoned")?
                    .record_provider(
                        epoch,
                        work.id(),
                        work.attempt(),
                        ProviderIdentity {
                            thread_id: identity.thread_id,
                            turn_id: identity.turn_id,
                        },
                    )?;
            }
        }
        Ok(())
    }
    pub(super) fn unknown_work(
        &self,
        epoch: i64,
        work: &RuntimeWork,
        reason: &str,
    ) -> Result<(), String> {
        match work {
            RuntimeWork::Image(_) => {
                let mut q = self
                    .image_lifecycle
                    .lock()
                    .map_err(|_| "image lifecycle lock poisoned")?;
                let job = q.get_job(work.id())?.ok_or("job missing")?;
                if matches!(
                    job.status,
                    JobStatus::Dispatching
                        | JobStatus::Running
                        | JobStatus::CancelRequested
                        | JobStatus::OutcomeUnknown
                ) {
                    q.mark_outcome_unknown(epoch, work.id(), work.attempt(), reason)?;
                }
            }
            RuntimeWork::Text(_) => {
                let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
                write_on(&mut store.connection, |tx| {
                    let op = super::text_operations::read_on(tx, work.id())?;
                    if read_settings(tx)?.epoch != epoch
                        || op.epoch != Some(epoch)
                        || op.attempt_id != work.attempt()
                    {
                        return Err("text unknown owner mismatch".into());
                    }
                    tx.execute("UPDATE v3_text_operations SET status='outcome_unknown',error=?1,updated_at_ms=?2 WHERE operation_id=?3 AND status IN ('dispatching','running','cancel_requested','outcome_unknown')",params![reason,epoch_milliseconds()?,work.id()]).map_err(message)?;
                    Ok(())
                })?;
            }
        }
        Ok(())
    }
    pub(super) fn complete_work(
        &self,
        epoch: i64,
        work: &RuntimeWork,
        provider: TextProviderIdentity,
        result: &Value,
    ) -> Result<(), String> {
        if provider.turn_id.as_ref().is_none_or(|s| s.is_empty()) {
            return Err("completion turn identity missing".into());
        }
        match work {
            RuntimeWork::Text(op) => {
                if result["kind"] != "text" {
                    return Err("result kind mismatch".into());
                }
                let staged = self.stage_text_result(TextCompletion {
                    operation_id: op.operation_id.clone(),
                    attempt_id: op.attempt_id.clone(),
                    stage: op.target.stage,
                    epoch,
                    target_sha256: op.target_sha256.clone(),
                    provider,
                    envelope: result["envelope"].clone(),
                })?;
                if staged.status == V3TextStatus::ResultReady {
                    let _ = self.commit_text_result(work.id());
                }
            }
            RuntimeWork::Image(_) => {
                if result["kind"] != "image" {
                    return Err("result kind mismatch".into());
                }
                let encoded = result["pngBase64"].as_str().ok_or("PNG result missing")?;
                if encoded.len() > 70 * 1024 * 1024 {
                    return Err("PNG result exceeds limit".into());
                }
                let bytes = STANDARD.decode(encoded).map_err(message)?;
                let vault = ResultVault::open(&self.root)?;
                let mut q = self
                    .image_lifecycle
                    .lock()
                    .map_err(|_| "image lifecycle lock poisoned")?;
                let job = q.get_job(work.id())?.ok_or("job missing")?;
                if job.epoch != Some(epoch)
                    || job.attempt_id != work.attempt()
                    || job.provider
                        != Some(ProviderIdentity {
                            thread_id: provider.thread_id,
                            turn_id: provider.turn_id,
                        })
                {
                    return Err("image result owner/provider mismatch".into());
                }
                if job.status == JobStatus::AbandonedUnresolved {
                    let verified = vault.stage(
                        &crate::presales_queue::result_staging::result_binding(&job)?,
                        &bytes,
                    )?;
                    q.record_late_result(work.id(), work.attempt(), verified.manifest().clone())?;
                } else {
                    let staged =
                        q.stage_png_result(&vault, epoch, work.id(), work.attempt(), &bytes)?;
                    drop(q);
                    if staged.status == JobStatus::ResultReady {
                        let _ = self
                            .store
                            .lock()
                            .map_err(|_| "v3 store lock poisoned")?
                            .commit_result(
                                CommitResult {
                                    epoch,
                                    request_id: work.id().into(),
                                    attempt_id: work.attempt().into(),
                                },
                                &vault,
                            );
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) fn retry_local_results(&self) -> Result<(), String> {
        let snapshot = self.queue_snapshot()?;
        for job in snapshot.jobs.iter().filter(|j| {
            j.kind == "image" && matches!(j.status.as_str(), "outcome_unknown" | "cancel_requested")
        }) {
            let vault = ResultVault::open(&self.root)?;
            let mut q = self
                .image_lifecycle
                .lock()
                .map_err(|_| "image lifecycle lock poisoned")?;
            let image = q
                .get_job(&job.request_id)?
                .ok_or("image recovery attempt missing")?;
            // A completed native vault manifest is durable result evidence even
            // if SQLite staging failed. Missing/incomplete files prove nothing.
            let _ = q.recover_png_result(
                &vault,
                snapshot.settings.epoch,
                &image.request_id,
                &image.attempt_id,
            );
        }
        let snapshot = self.queue_snapshot()?;
        for job in snapshot
            .jobs
            .into_iter()
            .filter(|j| matches!(j.status.as_str(), "result_ready" | "committing"))
        {
            if job.kind == "text" {
                let _ = self.commit_text_result(&job.request_id);
            } else {
                let vault = ResultVault::open(&self.root)?;
                let q = self
                    .image_lifecycle
                    .lock()
                    .map_err(|_| "image lifecycle lock poisoned")?;
                let image = q.get_job(&job.request_id)?.ok_or("local result missing")?;
                // Files are already verified; publishing never calls a provider.
                drop(q);
                let _ = self
                    .store
                    .lock()
                    .map_err(|_| "v3 store lock poisoned")?
                    .commit_result(
                        CommitResult {
                            epoch: snapshot.settings.epoch,
                            request_id: image.request_id,
                            attempt_id: image.attempt_id,
                        },
                        &vault,
                    );
            }
        }
        Ok(())
    }
}
