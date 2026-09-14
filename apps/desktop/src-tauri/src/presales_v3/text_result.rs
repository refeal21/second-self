//! Bounded immutable completion evidence precedes the atomic pair/result CAS.
use super::{
    store::{decode, encode, message},
    *,
};
use crate::presales_queue::store::epoch_milliseconds;
use rusqlite::{params, Connection};
use std::path::Path;

pub(super) fn verify_result(
    tx: &Connection,
    op: &V3TextOperation,
    result: &TextResultEvidence,
) -> Result<(), String> {
    let root = super::import_assets::root_on(tx)?;
    let a = &result.asset;
    if !a
        .relative_path
        .starts_with(&format!("{}/assets/", op.target.project_id))
        || a.byte_length > 3 * 1024 * 1024
    {
        return Err("invalid text result locator/bound".into());
    }
    let file = crate::paths::read_bounded_workspace_file(
        &root,
        Path::new(&a.relative_path),
        3 * 1024 * 1024,
    )?
    .ok_or("text result file missing")?;
    if file.evidence.sha256 != a.sha256
        || file.evidence.byte_length != a.byte_length
        || decode::<TextCompletion>(std::str::from_utf8(&file.bytes).map_err(message)?)?
            != result.completion
    {
        return Err("immutable text result bytes mismatch".into());
    }
    let (project,version,path,sha,metadata):(String,Option<String>,String,String,String) = tx.query_row("SELECT project_id,version_id,relative_path,sha256,metadata_json FROM v3_artifacts WHERE artifact_id=?1",[&a.asset_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(message)?;
    if project != op.target.project_id
        || version.is_some()
        || path != a.relative_path
        || sha != a.sha256
        || metadata != encode(result)?
    {
        return Err("text result artifact index mismatch".into());
    }
    Ok(())
}

impl V3WorkbenchService {
    /// Private host integration seam. This does not start or retry transport.
    /// Caller correlation is checked against durable native dispatch evidence.
    pub fn stage_text_result(&self, completion: TextCompletion) -> Result<V3TextOperation, String> {
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        let op = super::text_operations::read_on(&store.connection, &completion.operation_id)?;
        super::text_operations::correlate(&op, &completion)?;
        let epoch: i64 = store
            .connection
            .query_row(
                "SELECT epoch FROM queue_settings WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .map_err(message)?;
        if epoch != completion.epoch {
            return Err("text result belongs to old host epoch".into());
        }
        if let Some(existing) = &op.result {
            return if existing.completion == completion {
                Ok(op)
            } else {
                Err("immutable text result already differs".into())
            };
        }
        if !matches!(
            op.status,
            V3TextStatus::Dispatching
                | V3TextStatus::Running
                | V3TextStatus::CancelRequested
                | V3TextStatus::OutcomeUnknown
                | V3TextStatus::Cancelled
                | V3TextStatus::Abandoned
        ) {
            return Err("text result has no dispatched operation".into());
        }
        if let Err(error) = super::text_context::validate_envelope(&op.target, &completion.envelope)
        {
            return super::store::write_on(&mut store.connection, |tx| {
                let current = super::text_operations::read_on(tx, &completion.operation_id)?;
                super::text_operations::recheck_completion(tx, &current, &completion)?;
                let status = if current.status == V3TextStatus::Abandoned {
                    "abandoned"
                } else if current.cancellation.is_some() {
                    "cancelled"
                } else {
                    "failed"
                };
                tx.execute("UPDATE v3_text_operations SET status=?1,error=?2,updated_at_ms=?3 WHERE operation_id=?4",params![status,format!("invalid_complete_pair: {}",error.chars().take(1024).collect::<String>()),epoch_milliseconds()?,completion.operation_id]).map_err(message)?;
                super::text_operations::read_on(tx, &completion.operation_id)
            });
        }
        let bytes = encode(&completion)?;
        let root = super::import_assets::root_on(&store.connection)?;
        let asset = V3TextAsset {
            asset_id: format!("text-result-{}", uuid::Uuid::new_v4()),
            relative_path: format!(
                "{}/assets/text-{}.json",
                op.target.project_id,
                uuid::Uuid::new_v4()
            ),
            sha256: super::import_assets::hash(bytes.as_bytes()),
            byte_length: bytes.len() as u64,
        };
        let owned = crate::paths::write_new_workspace_artifact(
            &root,
            Path::new(&asset.relative_path),
            bytes.as_bytes(),
        )?;
        let evidence = TextResultEvidence {
            completion: completion.clone(),
            asset: asset.clone(),
        };
        let result = super::store::write_on(&mut store.connection, |tx| {
            let current = super::text_operations::read_on(tx, &completion.operation_id)?;
            super::text_operations::recheck_completion(tx, &current, &completion)?;
            if current.result.is_some() {
                return Err("text result changed while staging".into());
            }
            tx.execute("INSERT INTO v3_artifacts(artifact_id,project_id,version_id,relative_path,sha256,metadata_json) VALUES(?1,?2,NULL,?3,?4,?5)",params![asset.asset_id,op.target.project_id,asset.relative_path,asset.sha256,encode(&evidence)?]).map_err(message)?;
            let status = if current.status == V3TextStatus::Abandoned {
                "abandoned"
            } else if current.cancellation.is_some() {
                "cancelled"
            } else {
                "result_ready"
            };
            tx.execute("UPDATE v3_text_operations SET status=?1,result_json=?2,updated_at_ms=?3 WHERE operation_id=?4",params![status,encode(&evidence)?,epoch_milliseconds()?,completion.operation_id]).map_err(message)?;
            super::text_operations::read_on(tx, &completion.operation_id)
        })?;
        owned.commit();
        Ok(result)
    }

    pub fn commit_text_result(&self, id: &str) -> Result<V3TextOperation, String> {
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        super::store::write_on(&mut store.connection, |tx| {
            let op = super::text_operations::read_on(tx, id)?;
            if matches!(
                op.status,
                V3TextStatus::Succeeded
                    | V3TextStatus::Conflict
                    | V3TextStatus::Cancelled
                    | V3TextStatus::Abandoned
            ) {
                return Ok(op);
            }
            if !matches!(
                op.status,
                V3TextStatus::ResultReady | V3TextStatus::Committing
            ) || op.cancellation.is_some()
            {
                return Err("text operation has no publishable staged result".into());
            }
            let result = op.result.as_ref().ok_or("text staged result missing")?;
            let current = super::text_context::CheckedTextRequest::capture(
                tx,
                &op.target.project_id,
                op.target.expected_revision,
                op.target.stage,
            );
            match current.map(|checked| checked.target()) {
                Ok(target) if target == op.target => {}
                _ => {
                    tx.execute("UPDATE v3_text_operations SET status='conflict',error='draft_basis_conflict',updated_at_ms=?1 WHERE operation_id=?2",params![epoch_milliseconds()?,id]).map_err(message)?;
                    return super::text_operations::read_on(tx, id);
                }
            }
            super::text_context::validate_envelope(&op.target, &result.completion.envelope)?;
            let at = super::store::now()?;
            let d = super::draft::action_on(
                tx,
                &op.target.project_id,
                op.target.expected_revision,
                V3DraftAction::Save {
                    stage: op.target.stage,
                    envelope: result.completion.envelope.clone(),
                },
                &at,
            )?;
            let receipt = TextCommitReceipt {
                operation_id: id.into(),
                attempt_id: op.attempt_id.clone(),
                target_sha256: op.target_sha256.clone(),
                result_sha256: result.asset.sha256.clone(),
                committed_revision: d.summary.revision,
                at,
            };
            tx.execute("UPDATE v3_text_operations SET status='succeeded',commit_json=?1,updated_at_ms=?2 WHERE operation_id=?3",params![encode(&receipt)?,epoch_milliseconds()?,id]).map_err(message)?;
            super::text_operations::read_on(tx, id)
        })
    }
}
