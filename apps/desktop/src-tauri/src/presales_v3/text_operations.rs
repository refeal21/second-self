use super::{
    store::{decode, encode, message},
    *,
};
use crate::presales::native_value_hash;
use crate::presales_queue::store::epoch_milliseconds;
use rusqlite::{params, Connection, OptionalExtension};

pub(super) fn read_on(tx: &Connection, id: &str) -> Result<V3TextOperation, String> {
    let (sequence,attempt,project,stage,revision,target,digest,status,epoch,provider,result,commit,cancel,error,created,updated): (i64,String,String,String,i64,String,String,String,Option<i64>,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>,i64,i64) = tx.query_row("SELECT sequence,attempt_id,project_id,stage,expected_draft_revision,target_json,target_sha256,status,epoch,provider_json,result_json,commit_json,cancellation_json,error,created_at_ms,updated_at_ms FROM v3_text_operations WHERE operation_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?,r.get(14)?,r.get(15)?))).map_err(message)?;
    let target: V3TextTarget = decode(&target)?;
    if target.schema_version != 1
        || target.project_id != project
        || target.expected_revision != revision
        || encode(&target.stage)? != format!("\"{stage}\"")
        || native_value_hash(&serde_json::to_value(&target).map_err(message)?)? != digest
    {
        return Err("text target identity/digest mismatch".into());
    }
    let op = V3TextOperation {
        sequence,
        operation_id: id.into(),
        attempt_id: attempt,
        target,
        target_sha256: digest,
        status: decode(&format!("\"{status}\""))?,
        epoch,
        provider: provider.as_deref().map(decode).transpose()?,
        result: result.as_deref().map(decode).transpose()?,
        commit: commit.as_deref().map(decode).transpose()?,
        cancellation: cancel.as_deref().map(decode).transpose()?,
        error,
        created_at_ms: created,
        updated_at_ms: updated,
    };
    if op.sequence < 1 || op.target.expected_revision < 1 || op.updated_at_ms < op.created_at_ms {
        return Err("invalid text operation counters".into());
    }
    if let Some(result) = &op.result {
        correlate_identity(&op, &result.completion)?;
        super::text_context::validate_envelope(&op.target, &result.completion.envelope)?;
        super::text_result::verify_result(tx, &op, result)?;
    }
    if matches!(
        op.status,
        V3TextStatus::ResultReady
            | V3TextStatus::Committing
            | V3TextStatus::Succeeded
            | V3TextStatus::Conflict
    ) && op.result.is_none()
    {
        return Err("text status requires saved result evidence".into());
    }
    if (op.status == V3TextStatus::Succeeded) != op.commit.is_some() {
        return Err("text commit/status mismatch".into());
    }
    if let Some(c) = &op.commit {
        if c.operation_id != id
            || c.attempt_id != op.attempt_id
            || c.target_sha256 != op.target_sha256
            || Some(c.committed_revision) != op.target.expected_revision.checked_add(1)
            || c.result_sha256
                != op
                    .result
                    .as_ref()
                    .ok_or("text commit result missing")?
                    .asset
                    .sha256
        {
            return Err("text commit receipt identity mismatch".into());
        }
        let draft = match super::import_read::load_on(tx, &op.target.project_id)? {
            V3WorkbenchProject::Draft(draft) => draft,
            V3WorkbenchProject::Frozen(V3ProjectSnapshot {
                frozen_checkpoint: V3FrozenEvidence::Authored(evidence),
                ..
            }) => evidence.origin,
            _ => return Err("text commit has no authored destination evidence".into()),
        };
        let action = draft
            .authored
            .as_ref()
            .and_then(|a| a.events.iter().find(|e| e.revision == c.committed_revision))
            .ok_or("committed text action missing")?;
        if action.at != c.at
            || action.action
                != (V3DraftAction::Save {
                    stage: op.target.stage,
                    envelope: op
                        .result
                        .as_ref()
                        .ok_or("committed text result missing")?
                        .completion
                        .envelope
                        .clone(),
                })
        {
            return Err("text commit differs from actual authored action".into());
        }
    }
    Ok(op)
}

pub(super) fn correlate(op: &V3TextOperation, result: &TextCompletion) -> Result<(), String> {
    correlate_identity(op, result)?;
    if Some(result.epoch) != op.epoch {
        return Err("text response owner epoch mismatch".into());
    }
    Ok(())
}

pub(super) fn recheck_completion(
    tx: &Connection,
    op: &V3TextOperation,
    result: &TextCompletion,
) -> Result<(), String> {
    correlate(op, result)?;
    let epoch: i64 = tx
        .query_row(
            "SELECT epoch FROM queue_settings WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(message)?;
    if epoch != result.epoch
        || !matches!(
            op.status,
            V3TextStatus::Dispatching
                | V3TextStatus::Running
                | V3TextStatus::CancelRequested
                | V3TextStatus::OutcomeUnknown
                | V3TextStatus::Cancelled
                | V3TextStatus::Abandoned
        )
    {
        return Err("text completion no longer belongs to the active owner/attempt".into());
    }
    Ok(())
}

// Once staged, the callback epoch is immutable result evidence. Restart may
// transfer local ownership without rewriting that historical callback/file.
fn correlate_identity(op: &V3TextOperation, result: &TextCompletion) -> Result<(), String> {
    if result.operation_id != op.operation_id
        || result.attempt_id != op.attempt_id
        || result.stage != op.target.stage
        || result.target_sha256 != op.target_sha256
        || result.epoch < 0
        || op.provider.as_ref() != Some(&result.provider)
        || result.provider.thread_id.is_empty()
        || !result
            .provider
            .turn_id
            .as_ref()
            .is_some_and(|s| !s.is_empty())
    {
        return Err("text response correlation mismatch".into());
    }
    Ok(())
}

impl V3WorkbenchService {
    pub fn request_text_authoring(
        &self,
        input: RequestTextAuthoring,
    ) -> Result<V3TextOperation, String> {
        for id in [&input.operation_id, &input.attempt_id] {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b))
            {
                return Err("invalid text operation identity".into());
            }
        }
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        super::store::write_on(&mut store.connection, |tx| {
            if tx
                .query_row(
                    "SELECT 1 FROM v3_text_operations WHERE operation_id=?1",
                    [&input.operation_id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()
                .map_err(message)?
                .is_some()
            {
                let op = read_on(tx, &input.operation_id)?;
                if op.attempt_id != input.attempt_id
                    || op.target.project_id != input.project_id
                    || op.target.expected_revision != input.expected_revision
                    || op.target.stage != input.stage
                {
                    return Err("operation identity was already used for different input".into());
                }
                return Ok(op);
            }
            super::admission::check_text_identities(tx, &input.operation_id, &input.attempt_id)?;
            let target = super::text_context::CheckedTextRequest::capture(
                tx,
                &input.project_id,
                input.expected_revision,
                input.stage,
            )?
            .target();
            let digest = native_value_hash(&serde_json::to_value(&target).map_err(message)?)?;
            let active:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM v3_text_operations WHERE project_id=?1 AND status IN ('queued','dispatching','running','result_ready','committing','cancel_requested','outcome_unknown'))",[&input.project_id],|r|r.get(0)).map_err(message)?;
            if active {
                return Err("project already has unfinished text authoring".into());
            }
            let sequence = super::admission::next_sequence(tx)?;
            let now = epoch_milliseconds()?;
            let stage = match input.stage {
                V3TextStage::Outline => "outline",
                V3TextStage::Details => "details",
            };
            tx.execute("INSERT INTO v3_text_operations(sequence,operation_id,attempt_id,project_id,stage,expected_draft_revision,target_json,target_sha256,status,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'queued',?9,?9)",params![sequence,input.operation_id,input.attempt_id,input.project_id,stage,input.expected_revision,encode(&target)?,digest,now]).map_err(message)?;
            read_on(tx, &input.operation_id)
        })
    }
    pub fn text_operation(&self, id: &str) -> Result<V3TextOperation, String> {
        let store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        let tx = store.connection.unchecked_transaction().map_err(message)?;
        let result = read_on(&tx, id)?;
        tx.commit().map_err(message)?;
        Ok(result)
    }
    pub fn list_text_operations(&self, project: &str) -> Result<Vec<V3TextOperation>, String> {
        let store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        let tx = store.connection.unchecked_transaction().map_err(message)?;
        super::import_read::load_on(&tx, project)?;
        let ids = {
            let mut statement=tx.prepare("SELECT operation_id FROM v3_text_operations WHERE project_id=?1 ORDER BY sequence").map_err(message)?;
            let ids = statement
                .query_map([project], |r| r.get::<_, String>(0))
                .map_err(message)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(message)?;
            ids
        };
        let operations = ids
            .iter()
            .map(|id| read_on(&tx, id))
            .collect::<Result<Vec<_>, _>>()?;
        tx.commit().map_err(message)?;
        Ok(operations)
    }
    pub fn cancel_text_authoring(
        &self,
        id: &str,
        abandon: bool,
    ) -> Result<V3TextOperation, String> {
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        super::store::write_on(&mut store.connection, |tx| {
            let op = read_on(tx, id)?;
            if matches!(
                op.status,
                V3TextStatus::Succeeded
                    | V3TextStatus::Failed
                    | V3TextStatus::Conflict
                    | V3TextStatus::Cancelled
                    | V3TextStatus::Abandoned
            ) {
                return Ok(op);
            }
            let status = if abandon {
                "abandoned"
            } else if matches!(
                op.status,
                V3TextStatus::Queued | V3TextStatus::ResultReady | V3TextStatus::Committing
            ) {
                "cancelled"
            } else {
                "cancel_requested"
            };
            tx.execute("UPDATE v3_text_operations SET status=?1,cancellation_json=?2,updated_at_ms=?3 WHERE operation_id=?4",params![status,encode(&TextCancellation{abandoned:abandon,at:super::store::now()?})?,epoch_milliseconds()?,id]).map_err(message)?;
            read_on(tx, id)
        })
    }
}
