//! The application-owned mixed queue authority. No renderer can submit a target
//! or invoke a provider callback. QueueOnly's scheduler is never used here.
use super::{
    store::{encode, message, write_on},
    *,
};
use crate::presales_queue::{
    lifecycle::persist_change,
    store::{epoch_milliseconds, read_job, read_jobs, read_settings},
    JobStatus, QueueJob, QueueSettings,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::json;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", content = "job", rename_all = "snake_case")]
pub(crate) enum RuntimeWork {
    Image(QueueJob),
    Text(V3TextOperation),
}

impl RuntimeWork {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::Image(j) => &j.request_id,
            Self::Text(j) => &j.operation_id,
        }
    }
    pub(super) fn attempt(&self) -> &str {
        match self {
            Self::Image(j) => &j.attempt_id,
            Self::Text(j) => &j.attempt_id,
        }
    }
    pub(super) fn wire(&self) -> Result<serde_json::Value, String> {
        let mut value = serde_json::to_value(self).map_err(message)?;
        if let Self::Text(j) = self {
            value["job"]["requestId"] = json!(j.operation_id);
        }
        Ok(value)
    }
}

impl V3WorkbenchService {
    pub(crate) fn begin_queue_runtime(&self) -> Result<i64, String> {
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        write_on(&mut store.connection, |tx| {
            let epoch = read_settings(tx)?
                .epoch
                .checked_add(1)
                .ok_or("queue epoch exhausted")?;
            tx.execute(
                "UPDATE queue_settings SET epoch=?1 WHERE singleton=1",
                [epoch],
            )
            .map_err(message)?;
            for mut job in read_jobs(tx)? {
                if matches!(
                    job.status,
                    JobStatus::Dispatching
                        | JobStatus::Running
                        | JobStatus::CancelRequested
                        | JobStatus::OutcomeUnknown
                ) {
                    let from = job.status.clone();
                    let previous = job.epoch;
                    job.status = JobStatus::OutcomeUnknown;
                    job.epoch = Some(epoch);
                    persist_change(
                        tx,
                        &mut job,
                        from,
                        "runtime_recovered",
                        json!({"previousEpoch":previous,"epoch":epoch}),
                    )?;
                } else if matches!(job.status, JobStatus::ResultReady | JobStatus::Committing) {
                    // Local save recovery never dispatches another provider turn.
                    tx.execute(
                        "UPDATE queue_jobs SET epoch=?1 WHERE request_id=?2",
                        params![epoch, job.request_id],
                    )
                    .map_err(message)?;
                }
            }
            tx.execute("UPDATE v3_text_operations SET status='outcome_unknown',epoch=?1,updated_at_ms=?2 WHERE status IN ('dispatching','running','cancel_requested','outcome_unknown')", params![epoch,epoch_milliseconds()?]).map_err(message)?;
            tx.execute("UPDATE v3_text_operations SET epoch=?1 WHERE status IN ('result_ready','committing')", [epoch]).map_err(message)?;
            Ok(epoch)
        })
    }

    pub(crate) fn set_queue_settings(
        &self,
        concurrency: u8,
        paused: bool,
    ) -> Result<QueueSettings, String> {
        if !(1..=4).contains(&concurrency) {
            return Err("concurrency must be between 1 and 4".into());
        }
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        write_on(&mut store.connection, |tx| {
            tx.execute(
                "UPDATE queue_settings SET concurrency=?1,paused=?2 WHERE singleton=1",
                params![concurrency, paused],
            )
            .map_err(message)?;
            read_settings(tx)
        })
    }

    pub(crate) fn claim_queue_work(&self, epoch: i64) -> Result<Option<RuntimeWork>, String> {
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        write_on(&mut store.connection, |tx| {
            let settings = read_settings(tx)?;
            if epoch != settings.epoch {
                return Err("queue epoch mismatch".into());
            }
            if settings.paused {
                return Ok(None);
            }
            let occupied: i64 = tx.query_row("SELECT (SELECT COUNT(*) FROM queue_jobs WHERE status IN ('dispatching','running','cancel_requested','outcome_unknown')) + (SELECT COUNT(*) FROM v3_text_operations WHERE status IN ('dispatching','running','cancel_requested','outcome_unknown'))", [], |r| r.get(0)).map_err(message)?;
            if occupied >= i64::from(settings.concurrency) {
                return Ok(None);
            }
            loop {
                let next: Option<(String,String)> = tx.query_row("SELECT kind,id FROM (SELECT 'image' AS kind,j.request_id AS id,j.sequence AS sequence FROM queue_jobs j JOIN queue_batches b ON b.batch_id=j.batch_id WHERE j.status='queued' AND b.paused=0 UNION ALL SELECT 'text',operation_id,sequence FROM v3_text_operations WHERE status='queued') ORDER BY sequence LIMIT 1", [], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(message)?;
                let Some((kind, id)) = next else {
                    return Ok(None);
                };
                if kind == "text" {
                    let op = super::text_operations::read_on(tx, &id)?;
                    let current = super::text_context::CheckedTextRequest::capture(
                        tx,
                        &op.target.project_id,
                        op.target.expected_revision,
                        op.target.stage,
                    )
                    .map(|r| r.target());
                    if !current.as_ref().is_ok_and(|target| target == &op.target) {
                        tx.execute("UPDATE v3_text_operations SET status='failed',error='queued draft basis is no longer current',updated_at_ms=?1 WHERE operation_id=?2", params![epoch_milliseconds()?,id]).map_err(message)?;
                        continue;
                    }
                    tx.execute("UPDATE v3_text_operations SET status='dispatching',epoch=?1,updated_at_ms=?2 WHERE operation_id=?3 AND status='queued'", params![epoch,epoch_milliseconds()?,id]).map_err(message)?;
                    return super::text_operations::read_on(tx, &id)
                        .map(RuntimeWork::Text)
                        .map(Some);
                }
                let mut job = read_job(tx, &id)?.ok_or("selected queue job missing")?;
                let snapshot = super::store::load_on(tx, &job.target.project_id)?;
                let page = super::store::page_on(&snapshot, &job.target.slide_id)?;
                if !super::publication::target_matches_basis(&job, page) {
                    let from = job.status.clone();
                    job.status = JobStatus::Failed;
                    job.error = Some("queued page basis is no longer current".into());
                    persist_change(tx, &mut job, from, "stale_before_dispatch", json!({}))?;
                    continue;
                }
                job.status = JobStatus::Dispatching;
                job.epoch = Some(epoch);
                tx.execute(
                    "UPDATE queue_jobs SET dispatched_at_ms=?1 WHERE request_id=?2",
                    params![epoch_milliseconds()?, id],
                )
                .map_err(message)?;
                persist_change(
                    tx,
                    &mut job,
                    JobStatus::Queued,
                    "dispatch_claimed",
                    json!({"epoch":epoch}),
                )?;
                return read_job(tx, &id).map(|j| j.map(RuntimeWork::Image));
            }
        })
    }

    pub(crate) fn record_text_provider(
        &self,
        epoch: i64,
        id: &str,
        attempt: &str,
        identity: TextProviderIdentity,
    ) -> Result<V3TextOperation, String> {
        for value in std::iter::once(&identity.thread_id).chain(identity.turn_id.iter()) {
            if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err("invalid provider identity".into());
            }
        }
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        write_on(&mut store.connection, |tx| {
            let op = super::text_operations::read_on(tx, id)?;
            if read_settings(tx)?.epoch != epoch
                || op.epoch != Some(epoch)
                || op.attempt_id != attempt
                || !matches!(
                    op.status,
                    V3TextStatus::Dispatching
                        | V3TextStatus::Running
                        | V3TextStatus::OutcomeUnknown
                        | V3TextStatus::CancelRequested
                )
            {
                return Err("text provider owner mismatch".into());
            }
            if let Some(known) = &op.provider {
                if known.thread_id != identity.thread_id
                    || matches!((&known.turn_id,&identity.turn_id),(Some(a),Some(b)) if a!=b)
                {
                    return Err("provider identity is immutable".into());
                }
                if known.turn_id.is_some() || known == &identity {
                    return Ok(op);
                }
            }
            tx.execute("UPDATE v3_text_operations SET provider_json=?1,status=CASE WHEN status='dispatching' THEN 'running' ELSE status END,updated_at_ms=?2 WHERE operation_id=?3",params![encode(&identity)?,epoch_milliseconds()?,id]).map_err(message)?;
            super::text_operations::read_on(tx, id)
        })
    }
}
