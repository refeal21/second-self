//! Cross-check mutable projections against their immutable row and queue evidence.
use super::store::{decode, message};
use super::*;
use crate::presales_queue::{
    result_staging::result_binding, store::read_job, JobStatus, QueueTarget, StagedResult,
};
use rusqlite::{params, Connection};

pub(super) fn load_page_history(
    connection: &Connection,
    project_id: &str,
    page: &mut V3PageState,
    approved_version: Option<&str>,
) -> Result<(), String> {
    if page.revision < 1 {
        return Err("invalid page revision".into());
    }
    for (index, version) in page.versions.iter().enumerate() {
        if version.sequence != index as i64 + 1 {
            return Err("version history sequence is incomplete".into());
        }
        let row = connection.query_row("SELECT project_id,slide_id,sequence,request_id,attempt_id,status FROM v3_versions WHERE version_id=?1", [&version.version_id], |r|
            Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, i64>(2)?,r.get::<_, Option<String>>(3)?,r.get::<_, Option<String>>(4)?,r.get::<_, String>(5)?))).map_err(message)?;
        if row.0 != project_id
            || row.1 != page.slide_id
            || row.2 != version.sequence
            || row.3 != version.request_id
            || row.4 != version.attempt_id
            || row.5 != "candidate"
        {
            return Err("version row identity mismatch".into());
        }
        let (
            Some(request),
            Some(attempt),
            Some(image),
            Some(basis),
            Some(V3VisualProvenance::Presales {
                basis: provenance_basis,
                request_id,
                attempt_id,
                prompt_version,
                parent_visual,
                references,
            }),
        ) = (
            &version.request_id,
            &version.attempt_id,
            &version.image,
            &version.basis,
            &version.provenance,
        )
        else {
            return Err("native version evidence incomplete".into());
        };
        let job = read_job(connection, request)?.ok_or("version queue evidence missing")?;
        if request != request_id
            || attempt != attempt_id
            || job.attempt_id != *attempt
            || job.target.project_id != project_id
            || job.target.slide_id != page.slide_id
            || job.status != JobStatus::Succeeded
            || Some(basis) != page.visual_basis.as_ref()
            || basis != provenance_basis
            || !super::publication::target_matches_basis(&job, page)
            || job.target.prompt_version != *prompt_version
            || job.target.parent_visual != *parent_visual
            || job.target.references != *references
        {
            return Err("version provenance mismatch".into());
        }
        let (receipt_attempt, receipt_version, encoded): (String, String, String) = connection
            .query_row(
                "SELECT attempt_id,version_id,receipt_json FROM v3_receipts WHERE request_id=?1",
                [request],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(message)?;
        let receipt: V3PublicationReceipt = decode(&encoded)?;
        if receipt_attempt != *attempt
            || receipt_version != version.version_id
            || receipt.request_id != *request
            || receipt.attempt_id != *attempt
            || receipt.project_id != project_id
            || receipt.slide_id != page.slide_id
            || receipt.version_id != version.version_id
            || receipt.image != *image
            || receipt.target_sha256 != result_binding(&job)?.target_sha256
            || receipt.created_at != version.created_at
            || receipt.page_revision < 2
            || receipt.page_revision > page.revision
        {
            return Err("publication receipt identity mismatch".into());
        }
        let (intent_revision,intent_target): (i64,String) = connection.query_row("SELECT page_revision,target_json FROM v3_intents WHERE request_id=?1 AND project_id=?2 AND slide_id=?3", params![request,project_id,page.slide_id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(message)?;
        if intent_revision.checked_add(1) != Some(receipt.page_revision)
            || decode::<QueueTarget>(&intent_target)? != job.target
        {
            return Err("receipt differs from admitted page intent".into());
        }
        let published: String = connection.query_row("SELECT detail_json FROM queue_lifecycle_events WHERE request_id=?1 AND attempt_id=?2 AND kind='published'", params![request,attempt], |r| r.get(0)).map_err(message)?;
        if decode::<serde_json::Value>(&published)?
            != serde_json::json!({"versionId":version.version_id})
        {
            return Err("publication audit differs from receipt".into());
        }
        let (artifact_project, artifact_version, path, hash, metadata): (String,String,String,String,String) = connection.query_row("SELECT project_id,version_id,relative_path,sha256,metadata_json FROM v3_artifacts WHERE artifact_id=?1", [&image.asset_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(message)?;
        let manifest: StagedResult = decode(&metadata)?;
        if artifact_project != project_id
            || artifact_version != version.version_id
            || hash != image.sha256
            || manifest.relative_path != path
            || manifest.sha256 != hash
            || job.result.as_ref() != Some(&manifest)
            || path != format!("queue-results/{request}/{attempt}.png")
        {
            return Err("artifact identity mismatch".into());
        }
        let target: String = connection
            .query_row(
                "SELECT target_json FROM queue_attempts WHERE request_id=?1 AND attempt_id=?2",
                params![request, attempt],
                |r| r.get(0),
            )
            .map_err(message)?;
        if decode::<QueueTarget>(&target)? != job.target {
            return Err("immutable attempt target mismatch".into());
        }
    }
    if let Some(id) = &page.current_version_id {
        super::publication::version_on(page, id)?;
    }
    let mut approvals = connection.prepare("SELECT approval_id,version_id,approval_json FROM v3_approvals WHERE project_id=?1 AND slide_id=?2 ORDER BY rowid").map_err(message)?;
    let rows = approvals
        .query_map(params![project_id, page.slide_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    for (id, version_id, encoded) in rows {
        let approval: V3Approval = decode(&encoded)?;
        let version = super::publication::version_on(page, &version_id)?;
        if approval.approval_id != id
            || approval.version_id != version_id
            || version.basis.as_ref() != Some(&approval.basis)
            || version.image.as_ref().map(|i| &i.sha256) != Some(&approval.image_sha256)
        {
            return Err("approval identity mismatch".into());
        }
        page.approvals.push(approval);
    }
    if let Some(id) = approved_version {
        if page.current_version_id.as_deref() != Some(id)
            || super::events::active_job(connection, project_id, &page.slide_id)?.is_some()
        {
            return Err("effective approval does not name an idle active version".into());
        }
        page.approval = Some(
            page.approvals
                .iter()
                .find(|a| a.version_id == id)
                .cloned()
                .ok_or("effective approval missing")?,
        );
    }
    let mut drafts = connection.prepare("SELECT base_version_id,revision,draft_json FROM v3_feedback WHERE project_id=?1 AND slide_id=?2 ORDER BY base_version_id").map_err(message)?;
    let rows = drafts
        .query_map(params![project_id, page.slide_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    for (base, revision, encoded) in rows {
        let draft: V3FeedbackDraft = decode(&encoded)?;
        if draft.base_version_id.as_deref().unwrap_or("") != base
            || draft.revision != revision
            || revision < 1
            || draft.text.len() > 16_384
            || draft.text.contains('\0')
            || draft.base_version_id.as_deref() == Some("")
        {
            return Err("feedback draft identity mismatch".into());
        }
        if let Some(id) = &draft.base_version_id {
            super::publication::version_on(page, id)?;
        }
        if draft.base_version_id == page.current_version_id {
            page.feedback = Some(draft.clone());
        }
        page.feedback_drafts.push(draft);
    }
    if let Some(request) = &page.intent_request_id {
        let job = read_job(connection, request)?.ok_or("page intent queue evidence missing")?;
        let (project,slide,revision,target): (String,String,i64,String) = connection.query_row("SELECT project_id,slide_id,page_revision,target_json FROM v3_intents WHERE request_id=?1", [request], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(message)?;
        if project != project_id
            || slide != page.slide_id
            || revision != page.revision
            || decode::<QueueTarget>(&target)? != job.target
            || job.target.project_id != project_id
            || job.target.slide_id != page.slide_id
            || !super::publication::target_matches_basis(&job, page)
        {
            return Err("page intent identity mismatch".into());
        }
    }
    Ok(())
}

pub(super) fn load_delivery(
    connection: &Connection,
    snapshot: &mut V3ProjectSnapshot,
) -> Result<(), String> {
    let mut statement = connection.prepare("SELECT snapshot_id,revision,snapshot_json FROM v3_delivery_snapshots WHERE project_id=?1 ORDER BY revision").map_err(message)?;
    let rows = statement
        .query_map([&snapshot.summary.project_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    for (id, revision, encoded) in rows {
        let delivery: V3DeliverySnapshot = decode(&encoded)?;
        if delivery.snapshot_id != id
            || delivery.revision != revision
            || delivery.project_id != snapshot.summary.project_id
            || delivery.pages.len() != snapshot.pages.len()
            || revision > snapshot.summary.revision
        {
            return Err("delivery snapshot identity mismatch".into());
        }
        for (entry, page) in delivery.pages.iter().zip(&snapshot.pages) {
            let version = super::publication::version_on(page, &entry.version_id)?;
            if entry.slide_id != page.slide_id
                || version.image.as_ref() != Some(&entry.image)
                || !page
                    .approvals
                    .iter()
                    .any(|a| a.approval_id == entry.approval_id && a.version_id == entry.version_id)
            {
                return Err("delivery map evidence mismatch".into());
            }
            if revision == snapshot.summary.revision
                && (page.current_version_id.as_ref() != Some(&entry.version_id)
                    || page.approval.as_ref().map(|a| &a.approval_id) != Some(&entry.approval_id))
            {
                return Err("current delivery selection mismatch".into());
            }
        }
        if revision == snapshot.summary.revision {
            snapshot.delivery_snapshot = Some(delivery);
        }
    }
    Ok(())
}
