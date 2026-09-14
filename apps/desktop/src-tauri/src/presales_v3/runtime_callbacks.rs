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
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueSnapshot {
    pub dispatch_available: bool,
    pub capabilities: ImageCapabilities,
    pub settings: crate::presales_queue::QueueSettings,
    pub remote_active: usize,
    pub succeeded: usize,
    pub jobs: Vec<QueueJobSummary>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageCapabilities {
    pub generation: bool,
    pub reference_editing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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
    pub error: Option<String>,
}

impl V3WorkbenchService {
    pub(super) fn cancellation_pending(
        &self,
        epoch: i64,
        work: &RuntimeWork,
    ) -> Result<bool, String> {
        let store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        let query = match work {
            RuntimeWork::Image(_) => "SELECT EXISTS(SELECT 1 FROM queue_jobs WHERE request_id=?1 AND attempt_id=?2 AND epoch=?3 AND status='cancel_requested')",
            RuntimeWork::Text(_) => "SELECT EXISTS(SELECT 1 FROM v3_text_operations WHERE operation_id=?1 AND attempt_id=?2 AND epoch=?3 AND status='cancel_requested')",
        };
        store
            .connection
            .query_row(query, params![work.id(), work.attempt(), epoch], |row| {
                row.get(0)
            })
            .map_err(message)
    }
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
                    error: j.error,
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
                error: j.error,
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
            capabilities: ImageCapabilities::default(),
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
                    self.publish_local_result(epoch, work)?;
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
                        self.publish_local_result(epoch, work)?;
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) fn retry_local_results(&self) -> Result<(), String> {
        let mut failures = Vec::new();
        let snapshot = self.queue_snapshot()?;
        for job in snapshot.jobs.iter().filter(|j| {
            j.kind == "image" && matches!(j.status.as_str(), "outcome_unknown" | "cancel_requested")
        }) {
            let work = self.local_work(&job.kind, &job.request_id)?;
            let outcome = (|| {
                let vault = ResultVault::open(&self.root)?;
                let RuntimeWork::Image(image) = &work else {
                    unreachable!()
                };
                let binding = crate::presales_queue::result_staging::result_binding(image)?;
                // No manifest is expected after an unknown remote outcome.
                // Present but corrupt/incomplete evidence is an actionable error.
                if vault.has_manifest(&binding)? {
                    self.image_lifecycle
                        .lock()
                        .map_err(|_| "image lifecycle lock poisoned")?
                        .recover_png_result(
                            &vault,
                            snapshot.settings.epoch,
                            work.id(),
                            work.attempt(),
                        )?;
                }
                Ok(())
            })();
            if let Err(error) = outcome {
                failures.push(self.local_result_error(snapshot.settings.epoch, &work, error));
            }
        }
        let snapshot = self.queue_snapshot()?;
        for job in snapshot
            .jobs
            .into_iter()
            .filter(|j| matches!(j.status.as_str(), "result_ready" | "committing"))
        {
            let work = self.local_work(&job.kind, &job.request_id)?;
            if let Err(error) = self.publish_local_result(snapshot.settings.epoch, &work) {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn local_work(&self, kind: &str, id: &str) -> Result<RuntimeWork, String> {
        if kind == "text" {
            Ok(RuntimeWork::Text(self.text_operation(id)?))
        } else {
            Ok(RuntimeWork::Image(
                self.image_lifecycle
                    .lock()
                    .map_err(|_| "image lifecycle lock poisoned")?
                    .get_job(id)?
                    .ok_or("local image result missing")?,
            ))
        }
    }

    fn publish_local_result(&self, epoch: i64, work: &RuntimeWork) -> Result<(), String> {
        let outcome = (|| {
            match work {
                RuntimeWork::Text(_) => {
                    self.commit_text_result(work.id())?;
                }
                RuntimeWork::Image(_) => {
                    let vault = ResultVault::open(&self.root)?;
                    self.store
                        .lock()
                        .map_err(|_| "v3 store lock poisoned")?
                        .commit_result(
                            CommitResult {
                                epoch,
                                request_id: work.id().into(),
                                attempt_id: work.attempt().into(),
                            },
                            &vault,
                        )?;
                }
            }
            self.record_local_error(epoch, work, None)
        })();
        outcome.map_err(|error| self.local_result_error(epoch, work, error))
    }

    fn local_result_error(&self, epoch: i64, work: &RuntimeWork, error: String) -> String {
        let mut detail = format!(
            "Local result save/recovery failed for {}: {error}",
            work.id()
        );
        let mut end = detail.len().min(4096);
        while !detail.is_char_boundary(end) {
            end -= 1;
        }
        detail.truncate(end);
        match self.record_local_error(epoch, work, Some(&detail)) {
            Ok(()) => detail,
            Err(record_error) => format!("{detail}; could not persist error: {record_error}"),
        }
    }

    fn record_local_error(
        &self,
        epoch: i64,
        work: &RuntimeWork,
        error: Option<&str>,
    ) -> Result<(), String> {
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        write_on(&mut store.connection, |tx| {
            if read_settings(tx)?.epoch != epoch {
                return Err("local save epoch mismatch".into());
            }
            let (table, id) = match work {
                RuntimeWork::Image(_) => ("queue_jobs", "request_id"),
                RuntimeWork::Text(_) => ("v3_text_operations", "operation_id"),
            };
            // Never overwrite terminal conflict/cancellation evidence. Clearing
            // happens only after a successful publication, not merely a retry.
            let states = if error.is_some() {
                "'result_ready','committing','outcome_unknown','cancel_requested'"
            } else {
                "'succeeded'"
            };
            tx.execute(&format!("UPDATE {table} SET error=?1,updated_at_ms=?2 WHERE {id}=?3 AND attempt_id=?4 AND epoch=?5 AND status IN ({states})"),
                params![error, epoch_milliseconds()?, work.id(), work.attempt(), epoch]).map_err(message)?;
            Ok(())
        })
    }
}
