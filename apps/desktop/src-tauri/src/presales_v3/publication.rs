use super::store::{bump_project, decode, encode, load_on, message, now, page_on, write_on};
use super::*;
use crate::presales_queue::{
    lifecycle::commit_success_on, result_staging::result_binding, store::read_job, ImageReference,
    QueueJob, QueueTarget, ResultVault, StagedResult,
};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

impl V3Store {
    pub fn commit_result(
        &mut self,
        input: CommitResult,
        vault: &ResultVault,
    ) -> Result<V3PublicationReceipt, String> {
        {
            let tx = self.connection.unchecked_transaction().map_err(message)?;
            let receipt = receipt_on(&tx, &input)?;
            tx.commit().map_err(message)?;
            if let Some(receipt) = receipt {
                return Ok(receipt);
            }
        }
        let job =
            read_job(&self.connection, &input.request_id)?.ok_or("queue request not found")?;
        if job.attempt_id != input.attempt_id {
            return Err("attempt identity mismatch".into());
        }
        let verified = vault.recover(&result_binding(&job)?)?;
        let created_at = now()?;
        write_on(&mut self.connection, |tx| {
            if let Some(receipt) = receipt_on(tx, &input)? {
                return Ok(receipt);
            }
            let current = read_job(tx, &input.request_id)?.ok_or("queue request not found")?;
            if current.target != job.target || current.attempt_id != job.attempt_id {
                return Err("queue target changed".into());
            }
            let snapshot = load_on(tx, &current.target.project_id)?;
            let page = page_on(&snapshot, &current.target.slide_id)?;
            let (revision, target): (i64, String) = tx.query_row("SELECT page_revision,target_json FROM v3_intents WHERE request_id=?1 AND project_id=?2 AND slide_id=?3",
                params![input.request_id, current.target.project_id, page.slide_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(message)?;
            if page.intent_request_id.as_deref() != Some(&input.request_id)
                || page.revision != revision
                || decode::<QueueTarget>(&target)? != current.target
                || !target_matches_basis(&current, page)
            {
                return Err("stale page generation intent or visual basis".into());
            }
            let version_id = format!("visual-{}", current.attempt_id);
            let image = ImageReference {
                asset_id: format!("{:x}", Sha256::digest(current.attempt_id.as_bytes())),
                sha256: verified.manifest().sha256.clone(),
            };
            let sequence = page.versions.last().map_or(Ok(1), |v| {
                v.sequence
                    .checked_add(1)
                    .ok_or("version sequence exhausted")
            })?;
            let basis = page
                .visual_basis
                .clone()
                .ok_or("page has no approved presales basis")?;
            let version = V3VisualVersion {
                version_id: version_id.clone(),
                sequence,
                request_id: Some(current.request_id.clone()),
                attempt_id: Some(current.attempt_id.clone()),
                basis: Some(basis.clone()),
                image: Some(image.clone()),
                provenance: Some(V3VisualProvenance::Presales {
                    basis,
                    request_id: current.request_id.clone(),
                    attempt_id: current.attempt_id.clone(),
                    prompt_version: current.target.prompt_version.clone(),
                    parent_visual: current.target.parent_visual.clone(),
                    references: current.target.references.clone(),
                }),
                created_at: created_at.clone(),
            };
            let revision = revision.checked_add(1).ok_or("page revision exhausted")?;
            let receipt = V3PublicationReceipt {
                request_id: current.request_id.clone(),
                attempt_id: current.attempt_id.clone(),
                project_id: current.target.project_id.clone(),
                slide_id: page.slide_id.clone(),
                version_id: version_id.clone(),
                image: image.clone(),
                target_sha256: verified.binding().target_sha256.clone(),
                page_revision: revision,
                created_at: created_at.clone(),
            };
            tx.execute("INSERT INTO v3_versions (version_id,project_id,slide_id,sequence,request_id,attempt_id,status,version_json) VALUES (?1,?2,?3,?4,?5,?6,'candidate',?7)",
                params![version_id, current.target.project_id, page.slide_id, sequence, current.request_id, current.attempt_id, encode(&version)?]).map_err(message)?;
            tx.execute("INSERT INTO v3_artifacts (artifact_id,project_id,version_id,relative_path,sha256,metadata_json) VALUES (?1,?2,?3,?4,?5,?6)",
                params![image.asset_id, current.target.project_id, version_id, verified.manifest().relative_path, image.sha256, encode(verified.manifest())?]).map_err(message)?;
            tx.execute("INSERT INTO v3_receipts (request_id,attempt_id,version_id,receipt_json) VALUES (?1,?2,?3,?4)",
                params![current.request_id, current.attempt_id, version_id, encode(&receipt)?]).map_err(message)?;
            tx.execute("UPDATE v3_pages SET current_version_id=?1, approved_version_id=NULL, intent_request_id=NULL, revision=?2 WHERE project_id=?3 AND slide_id=?4",
                params![version_id, revision, current.target.project_id, page.slide_id]).map_err(message)?;
            bump_project(tx, &current.target.project_id)?;
            commit_success_on(
                tx,
                input.epoch,
                &input.request_id,
                &input.attempt_id,
                &verified,
                &version_id,
            )?;
            Ok(receipt)
        })
    }
}

pub(super) fn target_matches_basis(job: &QueueJob, page: &V3PageState) -> bool {
    page.visual_basis.as_ref().is_some_and(|b| {
        b.spec == job.target.spec
            && b.design == job.target.design
            && b.skill == job.target.skill
            && b.palette == job.target.palette
    })
}

pub(super) fn version_on<'a>(
    page: &'a V3PageState,
    version_id: &str,
) -> Result<&'a V3VisualVersion, String> {
    page.versions
        .iter()
        .find(|v| v.version_id == version_id)
        .ok_or_else(|| "version does not belong to page".into())
}

pub(super) fn verify_version(
    connection: &Connection,
    page: &V3PageState,
    version_id: &str,
    vault: &ResultVault,
) -> Result<ImageReference, String> {
    let version = version_on(page, version_id)?;
    if version.basis.is_none() || version.basis != page.visual_basis {
        return Err("version visual basis is not current".into());
    }
    let job = read_job(
        connection,
        version
            .request_id
            .as_deref()
            .ok_or("version lacks native request provenance")?,
    )?
    .ok_or("version queue evidence missing")?;
    let verified = vault.recover(&result_binding(&job)?)?;
    let image = version.image.as_ref().ok_or("version image missing")?;
    let manifest: String = connection
        .query_row(
            "SELECT metadata_json FROM v3_artifacts WHERE artifact_id=?1 AND version_id=?2",
            params![image.asset_id, version_id],
            |r| r.get(0),
        )
        .map_err(message)?;
    if image.sha256 != verified.manifest().sha256
        || decode::<StagedResult>(&manifest)? != *verified.manifest()
    {
        return Err("version immutable byte evidence differs".into());
    }
    Ok(image.clone())
}

pub(super) fn receipt_on(
    connection: &Connection,
    input: &CommitResult,
) -> Result<Option<V3PublicationReceipt>, String> {
    let encoded = connection
        .query_row(
            "SELECT receipt_json FROM v3_receipts WHERE request_id=?1",
            [&input.request_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(message)?;
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    let receipt: V3PublicationReceipt = decode(&encoded)?;
    if receipt.request_id != input.request_id || receipt.attempt_id != input.attempt_id {
        return Err("conflicting publication replay".into());
    }
    // Full history validation prevents returning a forged receipt even on replay.
    let snapshot = load_on(connection, &receipt.project_id)?;
    let page = page_on(&snapshot, &receipt.slide_id)?;
    let version = version_on(page, &receipt.version_id)?;
    if version.image.as_ref() != Some(&receipt.image) {
        return Err("receipt image differs from immutable version".into());
    }
    Ok(Some(receipt))
}
