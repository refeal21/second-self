//! Explicit receipt-backed readers; native validation failures never fall back.
use super::{
    import_assets::{check_index, root_on, verify_asset, FILE_LIMIT},
    import_evidence::{origin_reference, read_envelope, style_and_records, ImportReceipt},
    store::{decode, encode, message},
    *,
};
use rusqlite::{params, Connection};
use std::{collections::HashSet, path::Path};

pub(super) fn has_receipt(connection: &Connection, project: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM v3_import_receipts WHERE project_id=?1)",
            [project],
            |r| r.get(0),
        )
        .map_err(message)
}

pub(super) fn receipt_on(connection: &Connection, project: &str) -> Result<ImportReceipt, String> {
    let (id,digest,raw): (String,String,String) = connection.query_row("SELECT import_id,origin_digest,receipt_json FROM v3_import_receipts WHERE project_id=?1", [project], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(message)?;
    let r: ImportReceipt = decode(&raw)?;
    let root = root_on(connection)?;
    if r.destination.project_id != project
        || !project.starts_with("copy-")
        || uuid::Uuid::parse_str(&project[5..]).is_err()
        || project == r.origin.source_project_id
        || id != r.import_id
        || digest != r.origin.snapshot_digest
        || r.schema_version != 1
        || r.destination.revision != 1
        || r.replay_validator != "native-pipeline-checkpoint-v1"
        || !matches!(r.pipeline["schemaVersion"].as_i64(), Some(1 | 2))
        || (r.mode == LegacyCopyMode::PresalesContentRevision) != (r.kind == V3CatalogKind::Draft)
    {
        return Err("import receipt identity mismatch".into());
    }
    let disk = crate::paths::read_bounded_workspace_file(
        &root,
        Path::new(&format!("{project}/receipt.json")),
        FILE_LIMIT,
    )?
    .ok_or("immutable import receipt missing")?;
    if disk.bytes != raw.as_bytes() || encode(&r)? != raw {
        return Err("immutable import receipt differs".into());
    }
    let rows = read_envelope(&r, &verify_asset(&root, &r.evidence)?)?;
    let (palette, records) = style_and_records(&rows, &r.pipeline)?;
    if palette != r.palette || !r.assets.contains(&r.evidence) {
        return Err("import palette/evidence mismatch".into());
    }
    let mut asset_ids = HashSet::new();
    let mut paths = HashSet::new();
    let mut version_ids = HashSet::new();
    for asset in &r.assets {
        if !asset_ids.insert(&asset.asset_id)
            || !paths.insert(&asset.relative_path)
            || !asset.relative_path.starts_with(&format!("{project}/"))
        {
            return Err("import asset mapping is not exclusive".into());
        }
        check_index(connection, project, asset)?;
        verify_asset(&root, asset)?;
    }
    let specs = r.pipeline["slideSpecs"]["value"].as_array();
    if r.pages.len() != specs.map_or(0, Vec::len)
        || r.destination.page_count
            != if r.kind == V3CatalogKind::Draft {
                0
            } else {
                r.pages.len()
            }
    {
        return Err("import page set mismatch".into());
    }
    for (i, page) in r.pages.iter().enumerate() {
        if page.ordinal != i
            || page.spec != specs.unwrap()[i]
            || page.spec["id"] != page.slide_id
            || page.revision != 1
            || page.intent_request_id.is_some()
            || page.approval.is_some()
            || !page.approvals.is_empty()
            || page.feedback.is_some()
            || !page.feedback_drafts.is_empty()
        {
            return Err("import initial page evidence mismatch".into());
        }
        let originals = r.pipeline["visuals"][&page.slide_id].as_array();
        if page.versions.len() != originals.map_or(0, Vec::len) {
            return Err("import history count mismatch".into());
        }
        let mut origins = vec![];
        for (index, (v, o)) in page
            .versions
            .iter()
            .zip(originals.into_iter().flatten())
            .enumerate()
        {
            if !version_ids.insert(&v.version_id)
                || !v.version_id.starts_with("import-version-")
                || uuid::Uuid::parse_str(&v.version_id[15..]).is_err()
                || v.sequence != index as i64 + 1
                || v.request_id.is_some()
                || v.attempt_id.is_some()
                || v.basis.is_some()
                || v.created_at != o["version"]["createdAt"]
                || v.provenance
                    != Some(V3VisualProvenance::LegacyImported {
                        origin_digest: r.origin.snapshot_digest.clone(),
                        source_version_id: o["version"]["id"]
                            .as_str()
                            .ok_or("original visual id missing")?
                            .into(),
                        original_visual: o.clone(),
                        original_approval: r.pipeline["approvals"]
                            .as_array()
                            .and_then(|a| {
                                a.iter().find(|a| {
                                    a["versionId"] == o["version"]["id"]
                                        && a["slideId"] == page.slide_id
                                })
                            })
                            .cloned(),
                    })
            {
                return Err("import visual identity/provenance mismatch".into());
            }
            let asset = r
                .assets
                .iter()
                .find(|a| a.kind == "visual" && a.original_path == o["relativePath"]);
            match (asset, &v.image, &v.missing_image) {
                (Some(a), Some(image), None)
                    if a.asset_id == image.asset_id
                        && a.sha256 == image.sha256
                        && a.sha256 == o["sha256"]
                        && Some(a.byte_length) == o["byteLength"].as_u64() => {}
                (None, None, Some(reason))
                    if (o["relativePath"] == "" && reason == "source_placeholder")
                        || (index + 1 < page.versions.len()
                            && reason == "source_history_image_missing") => {}
                _ => return Err("import image availability/map mismatch".into()),
            }
            if let Some(reference) = origin_reference(&r, &rows, &records, page, v, o)? {
                origins.push(reference);
            }
        }
        let current = if r.kind == V3CatalogKind::Draft {
            None
        } else {
            page.versions.last().map(|v| v.version_id.clone())
        };
        if page.origin_approvals != origins
            || page.current_version_id != current
            || page.origin_approval
                != origins
                    .iter()
                    .find(|a| Some(&a.version_id) == current.as_ref())
                    .cloned()
        {
            return Err("import original approval/selection mismatch".into());
        }
    }
    if r.kind == V3CatalogKind::Frozen {
        let derived = super::basis::frozen_snapshot(
            V3FrozenCheckpoint {
                pipeline: r.pipeline.clone(),
                presales: r.presales.clone().ok_or("frozen companion missing")?,
            },
            r.palette.clone(),
        )?;
        for (a, b) in derived.pages.iter().zip(&r.pages) {
            if a.spec != b.spec || a.design != b.design || a.visual_basis != b.visual_basis {
                return Err("import frozen page basis mismatch".into());
            }
        }
    } else if r
        .pages
        .iter()
        .any(|p| p.visual_basis.is_some() || p.design.is_some())
    {
        return Err("nonfrozen import cannot invent page basis".into());
    }
    Ok(r)
}

pub(super) fn load_on(
    connection: &Connection,
    project: &str,
) -> Result<V3WorkbenchProject, String> {
    if !has_receipt(connection, project)? {
        return super::store::load_on(connection, project).map(V3WorkbenchProject::Frozen);
    }
    let receipt = receipt_on(connection, project)?;
    let (kind, revision): (String, i64) = connection
        .query_row(
            "SELECT kind,revision FROM v3_catalog WHERE project_id=?1",
            [project],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(message)?;
    let counts: (i64,i64,i64) = connection.query_row("SELECT (SELECT count(*) FROM v3_projects WHERE project_id=?1),(SELECT count(*) FROM v3_draft_projects WHERE project_id=?1),(SELECT count(*) FROM v3_history_projects WHERE project_id=?1)",[project],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(message)?;
    let mut result = super::import::initial_projection(&receipt)?;
    if receipt.kind == V3CatalogKind::Draft && kind == "frozen" {
        if counts != (1, 0, 0) {
            return Err("authored frozen catalog mismatch".into());
        }
        return super::draft::load_frozen_on(connection, project, &receipt, revision)
            .map(V3WorkbenchProject::Frozen);
    }
    match &mut result {
        V3WorkbenchProject::Frozen(p) => {
            if kind != "frozen" || counts != (1, 0, 0) {
                return Err("import frozen catalog mismatch".into());
            }
            let (name,frozen,origin,palette,created,stored_revision): (String,String,String,String,String,i64) = connection.query_row("SELECT name,frozen_json,origin_json,palette_json,created_at,revision FROM v3_projects WHERE project_id=?1",[project],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(message)?;
            if name != p.summary.name
                || decode::<V3FrozenEvidence>(&frozen)? != p.frozen_checkpoint
                || decode::<V3Origin>(&origin)? != p.origin
                || decode::<crate::visual_style::VisualStyleState>(&palette)? != p.palette
                || created != p.summary.created_at
                || stored_revision != revision
            {
                return Err("import frozen storage mismatch".into());
            }
            p.summary.revision = revision;
            super::store::load_pages_on(connection, project, &mut p.pages, Some(&receipt))?;
            super::history::load_delivery(connection, p)?;
        }
        V3WorkbenchProject::HistoryOnly(p) => {
            if kind != "history_only" || counts != (0, 0, 1) {
                return Err("import history catalog mismatch".into());
            }
            let raw: String = connection
                .query_row(
                    "SELECT history_json FROM v3_history_projects WHERE project_id=?1",
                    [project],
                    |r| r.get(0),
                )
                .map_err(message)?;
            if decode::<V3HistoryProject>(&raw)? != *p {
                return Err("import history evidence mismatch".into());
            }
            p.summary.revision = revision;
            super::store::load_pages_on(connection, project, &mut p.pages, Some(&receipt))?;
            p.delivery_snapshot =
                super::history::load_delivery_pages(connection, &p.summary, &p.pages)?;
        }
        V3WorkbenchProject::Draft(p) => {
            if kind != "draft" || counts != (0, 1, 0) {
                return Err("import draft catalog mismatch".into());
            }
            let live: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM v3_pages WHERE project_id=?1) OR EXISTS(SELECT 1 FROM v3_delivery_snapshots WHERE project_id=?1)",[project],|r|r.get(0)).map_err(message)?;
            if live {
                return Err("import draft has modified origin or live visual selection".into());
            }
            *p = super::draft::load_on(connection, project, &receipt)?;
        }
    }
    Ok(result)
}

pub(super) fn verify_version(
    connection: &Connection,
    project: &str,
    page: &V3PageState,
    version: &V3VisualVersion,
) -> Result<(), String> {
    let receipt = receipt_on(connection, project)?;
    verify_version_against(connection, &receipt, page, version)
}
pub(super) fn verify_version_against(
    connection: &Connection,
    receipt: &ImportReceipt,
    page: &V3PageState,
    version: &V3VisualVersion,
) -> Result<(), String> {
    if receipt.kind == V3CatalogKind::Draft
        || !receipt
            .pages
            .iter()
            .any(|p| p.slide_id == page.slide_id && p.versions.contains(version))
    {
        return Err("import version does not belong to receipt".into());
    }
    if let Some(image) = &version.image {
        let asset = receipt
            .assets
            .iter()
            .find(|a| a.asset_id == image.asset_id)
            .ok_or("import image mapping missing")?;
        let owner: Option<String> = connection
            .query_row(
                "SELECT version_id FROM v3_artifacts WHERE artifact_id=?1",
                [&asset.asset_id],
                |r| r.get(0),
            )
            .map_err(message)?;
        if owner.as_deref() != Some(&version.version_id) {
            return Err("import asset version mismatch".into());
        }
    }
    Ok(())
}

pub(super) fn load_origins(
    connection: &Connection,
    project: &str,
    page: &mut V3PageState,
    imported: Option<&ImportReceipt>,
) -> Result<(), String> {
    // The exact previous native schema has no origin-reference table. Its
    // upgrade reader remains native-only and must still validate old evidence.
    if imported.is_none()
        && !super::legacy_snapshot::table_exists(connection, "v3_origin_approvals")?
    {
        return Ok(());
    }
    let mut query = connection.prepare("SELECT reference_id,version_id,proof_json FROM v3_origin_approvals WHERE project_id=?1 AND slide_id=?2 ORDER BY rowid").map_err(message)?;
    let rows = query
        .query_map(params![project, page.slide_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    if rows.is_empty() && imported.is_none() {
        page.origin_approvals.clear();
        return Ok(());
    }
    let receipt = imported.ok_or("native project cannot contain origin approvals")?;
    let source = receipt
        .pages
        .iter()
        .find(|p| p.slide_id == page.slide_id)
        .ok_or("origin approval page missing")?;
    let mut loaded = vec![];
    for (id, version, raw) in rows {
        let a: V3OriginApprovalRef = decode(&raw)?;
        if a.reference_id != id || a.version_id != version || !source.origin_approvals.contains(&a)
        {
            return Err("origin approval reference mismatch".into());
        }
        loaded.push(a);
    }
    if loaded != source.origin_approvals {
        return Err("origin approval history incomplete".into());
    }
    page.origin_approvals = loaded;
    Ok(())
}
