//! Preparation consumes native replay authority; publication owns one transaction.
use super::{
    activity::NativeSource,
    import_assets::{AssetStaging, ImportedAsset},
    import_evidence::{origin_reference, text, ImportReceipt},
    store::{encode, message},
    validator_process::ValidatedLegacySnapshot,
    *,
};
use crate::presales_queue::ImageReference;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::Path;

pub(super) struct PreparedCopy {
    pub token: ValidatedLegacySnapshot,
    pub source: NativeSource,
    pub epoch: u64,
    pub receipt: ImportReceipt,
    pub staging: AssetStaging,
}

pub(super) fn prepare(
    token: ValidatedLegacySnapshot,
    source: NativeSource,
    epoch: u64,
    mode: LegacyCopyMode,
    root: &Path,
) -> Result<PreparedCopy, String> {
    let snapshot = token.snapshot();
    let pipeline = &snapshot.checkpoint().pipeline;
    let (palette, records) =
        super::import_evidence::style_and_records(snapshot.selected_rows(), pipeline)?;
    let seed = snapshot.checkpoint().presales.as_ref().filter(|p| {
        p.skill
            == serde_json::from_value(crate::presales::bundled_skill_metadata())
                .expect("compiled skill identity")
            && p.approval_bindings.len() == 2
    });
    let frozen = if mode == LegacyCopyMode::FormatCopy && seed.is_some() {
        Some(
            ValidatedV3ProjectSeed::from_checkpoint(
                snapshot.checkpoint().clone(),
                palette.clone(),
            )?
            .into_snapshot(),
        )
    } else {
        None
    };
    let kind = if mode == LegacyCopyMode::PresalesContentRevision {
        V3CatalogKind::Draft
    } else if frozen.is_some() {
        V3CatalogKind::Frozen
    } else {
        V3CatalogKind::HistoryOnly
    };
    let project = format!("copy-{}", uuid::Uuid::new_v4());
    let mut staging = AssetStaging::new(root, &source.root, &project)?;
    for item in pipeline["sources"]
        .as_array()
        .ok_or("source list missing")?
    {
        staging.copy(
            text(&item["relativePath"], "source file path")?,
            text(&item["sha256"], "source file hash")?,
            item["byteLength"].as_u64(),
            "source",
            true,
        )?;
    }
    if !pipeline["analysis"].is_null() {
        staging.copy(
            text(
                &pipeline["analysis"]["artifactRelativePath"],
                "analysis artifact path",
            )?,
            text(&pipeline["analysis"]["sha256"], "analysis hash")?,
            None,
            "analysis",
            true,
        )?;
    }
    // Original template paths remain inside saved profiles; copied locators are
    // separate immutable mappings, never a rehashed/relabelled palette.
    if let Some(template) = palette.profile.as_ref().and_then(|p| p.template.as_ref()) {
        staging.copy(
            &template.relative_path,
            &template.sha256,
            None,
            "template",
            true,
        )?;
    }
    let evidence = staging.stage_evidence(encode(snapshot.selected_envelope())?.as_bytes())?;
    let mut pages = if let Some(frozen) = &frozen {
        frozen.pages.clone()
    } else {
        pipeline["slideSpecs"]["value"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, spec)| {
                Ok(V3PageState {
                    slide_id: text(&spec["id"], "source slide id")?.into(),
                    ordinal: i,
                    spec: spec.clone(),
                    design: None,
                    visual_basis: None,
                    current_version_id: None,
                    versions: vec![],
                    approval: None,
                    feedback: None,
                    revision: 1,
                    intent_request_id: None,
                    approvals: vec![],
                    feedback_drafts: vec![],
                    origin_approvals: vec![],
                    origin_approval: None,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    for page in &mut pages {
        let originals = pipeline["visuals"][&page.slide_id].as_array();
        for (i, original) in originals.into_iter().flatten().enumerate() {
            let source_version_id =
                text(&original["version"]["id"], "source visual version")?.to_string();
            let path = text(&original["relativePath"], "visual path")?;
            let asset = if path.is_empty() {
                None
            } else {
                staging.copy(
                    path,
                    text(&original["sha256"], "visual hash")?,
                    original["byteLength"].as_u64(),
                    "visual",
                    Some(i + 1) == originals.map(Vec::len),
                )?
            };
            let missing = asset.is_none().then(|| {
                if path.is_empty() {
                    "source_placeholder".into()
                } else {
                    "source_history_image_missing".into()
                }
            });
            page.versions.push(V3VisualVersion {
                version_id: format!("import-version-{}", uuid::Uuid::new_v4()),
                sequence: i as i64 + 1,
                request_id: None,
                attempt_id: None,
                basis: None,
                image: asset.map(|a| ImageReference {
                    asset_id: a.asset_id,
                    sha256: a.sha256,
                }),
                provenance: Some(V3VisualProvenance::LegacyImported {
                    origin_digest: snapshot.snapshot_sha256().into(),
                    original_approval: pipeline["approvals"]
                        .as_array()
                        .and_then(|a| {
                            a.iter().find(|a| {
                                a["versionId"] == source_version_id && a["slideId"] == page.slide_id
                            })
                        })
                        .cloned(),
                    source_version_id,
                    original_visual: original.clone(),
                }),
                created_at: text(&original["version"]["createdAt"], "visual creation time")?.into(),
                missing_image: missing,
            });
        }
        page.current_version_id = page.versions.last().map(|v| v.version_id.clone());
    }
    let mut receipt = ImportReceipt {
        schema_version: 1,
        import_id: format!("import-{}", uuid::Uuid::new_v4()),
        mode,
        kind,
        destination: V3ProjectSummary {
            project_id: project,
            name: format!(
                "{}（V3 副本）",
                text(&pipeline["project"]["name"], "source name")?
            ),
            page_count: if kind == V3CatalogKind::Draft {
                0
            } else {
                pages.len()
            },
            revision: 1,
            created_at: super::store::now()?,
        },
        origin: V3Origin {
            source_project_id: snapshot.project_id().into(),
            source_revision: snapshot.revision(),
            hash_algorithm: "legacy-source-snapshot-sha256-v1".into(),
            snapshot_digest: snapshot.snapshot_sha256().into(),
        },
        source_file_evidence_json: encode(snapshot.source_evidence())?,
        raw_pipeline_sha256: super::import_assets::hash(snapshot.pipeline_json().as_bytes()),
        replay_validator: "native-pipeline-checkpoint-v1".into(),
        pipeline: pipeline.clone(),
        presales: snapshot.checkpoint().presales.clone(),
        palette,
        evidence,
        assets: staging.assets.clone(),
        pages: vec![],
        reasons: if kind == V3CatalogKind::HistoryOnly {
            vec!["no_current_frozen_presales_pair".into()]
        } else {
            vec![]
        },
    };
    for page in &mut pages {
        for (version, original) in page.versions.iter().zip(
            pipeline["visuals"][&page.slide_id]
                .as_array()
                .into_iter()
                .flatten(),
        ) {
            if let Some(reference) = origin_reference(
                &receipt,
                snapshot.selected_rows(),
                &records,
                page,
                version,
                original,
            )? {
                page.origin_approvals.push(reference);
            }
        }
        page.origin_approval = page
            .origin_approvals
            .iter()
            .find(|r| Some(&r.version_id) == page.current_version_id.as_ref())
            .cloned();
        if mode == LegacyCopyMode::PresalesContentRevision {
            page.current_version_id = None;
        }
        if page.current_version_id.is_some() && page.origin_approval.is_none() {
            receipt
                .reasons
                .push(format!("{}: no_effective_origin_approval", page.slide_id));
        }
    }
    receipt.pages = pages;
    Ok(PreparedCopy {
        token,
        source,
        epoch,
        receipt,
        staging,
    })
}

pub(super) fn initial_projection(receipt: &ImportReceipt) -> Result<V3WorkbenchProject, String> {
    match receipt.kind {
        V3CatalogKind::Frozen => {
            let mut frozen = super::basis::frozen_snapshot(
                V3FrozenCheckpoint {
                    pipeline: receipt.pipeline.clone(),
                    presales: receipt
                        .presales
                        .clone()
                        .ok_or("frozen copy lacks companion")?,
                },
                receipt.palette.clone(),
            )?;
            frozen.summary = receipt.destination.clone();
            frozen.pages = receipt.pages.clone();
            // Imported origin binds the exact captured source files, while
            // each newly authored basis keeps its separate native hash domain.
            frozen.origin = receipt.origin.clone();
            Ok(V3WorkbenchProject::Frozen(frozen))
        }
        V3CatalogKind::HistoryOnly => Ok(V3WorkbenchProject::HistoryOnly(V3HistoryProject {
            summary: receipt.destination.clone(),
            origin: receipt.origin.clone(),
            import_id: receipt.import_id.clone(),
            palette: receipt.palette.clone(),
            pages: receipt.pages.clone(),
            reasons: receipt.reasons.clone(),
            delivery_snapshot: None,
        })),
        V3CatalogKind::Draft => {
            let optional = |v: &Value| (!v.is_null()).then(|| v.clone());
            Ok(V3WorkbenchProject::Draft(V3ImportedDraft {
                schema_version: 1,
                summary: receipt.destination.clone(),
                origin: receipt.origin.clone(),
                import_id: receipt.import_id.clone(),
                sources: receipt.pipeline["sources"]
                    .as_array()
                    .ok_or("sources missing")?
                    .clone(),
                brief: text(&receipt.pipeline["project"]["goal"], "source brief")?.into(),
                analysis: optional(&receipt.pipeline["analysis"]),
                context: optional(&receipt.pipeline["promptContext"]),
                preferences: receipt.pipeline["preferenceSnapshot"].clone(),
                original_outline: optional(&receipt.pipeline["outline"]),
                palette: receipt.palette.clone(),
                comparison_pages: receipt.pages.clone(),
            }))
        }
    }
}

pub(super) fn publish_on(tx: &Connection, receipt: &ImportReceipt) -> Result<(), String> {
    let project = &receipt.destination.project_id;
    let kind = match receipt.kind {
        V3CatalogKind::Frozen => "frozen",
        V3CatalogKind::Draft => "draft",
        V3CatalogKind::HistoryOnly => "history_only",
    };
    tx.execute(
        "INSERT INTO v3_catalog(project_id,kind,revision) VALUES(?1,?2,1)",
        params![project, kind],
    )
    .map_err(message)?;
    match initial_projection(receipt)? {
        V3WorkbenchProject::Frozen(p) => {
            tx.execute("INSERT INTO v3_projects(project_id,name,frozen_json,origin_json,palette_json,created_at,revision) VALUES(?1,?2,?3,?4,?5,?6,1)", params![project,p.summary.name,encode(&p.frozen_checkpoint)?,encode(&p.origin)?,encode(&p.palette)?,p.summary.created_at]).map_err(message)?;
        }
        V3WorkbenchProject::HistoryOnly(p) => {
            tx.execute(
                "INSERT INTO v3_history_projects VALUES(?1,?2)",
                params![project, encode(&p)?],
            )
            .map_err(message)?;
        }
        V3WorkbenchProject::Draft(p) => {
            tx.execute(
                "INSERT INTO v3_draft_projects VALUES(?1,?2)",
                params![project, encode(&p)?],
            )
            .map_err(message)?;
        }
    }
    tx.execute(
        "INSERT INTO v3_import_receipts VALUES(?1,?2,?3,?4)",
        params![
            receipt.import_id,
            project,
            receipt.origin.snapshot_digest,
            encode(receipt)?
        ],
    )
    .map_err(message)?;
    if receipt.kind != V3CatalogKind::Draft {
        for page in &receipt.pages {
            tx.execute("INSERT INTO v3_pages(project_id,slide_id,ordinal,spec_json,design_json,basis_json) VALUES(?1,?2,?3,?4,?5,?6)", params![project,page.slide_id,page.ordinal as i64,encode(&page.spec)?,page.design.as_ref().map(encode).transpose()?,page.visual_basis.as_ref().map(encode).transpose()?]).map_err(message)?;
            for version in &page.versions {
                tx.execute("INSERT INTO v3_versions(version_id,project_id,slide_id,sequence,status,version_json) VALUES(?1,?2,?3,?4,'legacy_imported',?5)", params![version.version_id,project,page.slide_id,version.sequence,encode(version)?]).map_err(message)?;
            }
            for approval in &page.origin_approvals {
                tx.execute(
                    "INSERT INTO v3_origin_approvals VALUES(?1,?2,?3,?4,?5)",
                    params![
                        approval.reference_id,
                        project,
                        page.slide_id,
                        approval.version_id,
                        encode(approval)?
                    ],
                )
                .map_err(message)?;
            }
            tx.execute("UPDATE v3_pages SET current_version_id=?1,approved_version_id=?2 WHERE project_id=?3 AND slide_id=?4", params![page.current_version_id,page.origin_approval.as_ref().map(|a| &a.version_id),project,page.slide_id]).map_err(message)?;
        }
    }
    for asset in &receipt.assets {
        insert_asset(tx, receipt, asset)?;
    }
    Ok(())
}

fn insert_asset(
    tx: &Connection,
    receipt: &ImportReceipt,
    asset: &ImportedAsset,
) -> Result<(), String> {
    let version = (receipt.kind != V3CatalogKind::Draft)
        .then(|| {
            receipt.pages.iter().flat_map(|p| &p.versions).find(|v| {
                v.image
                    .as_ref()
                    .is_some_and(|i| i.asset_id == asset.asset_id)
            })
        })
        .flatten();
    tx.execute("INSERT INTO v3_artifacts(artifact_id,project_id,version_id,relative_path,sha256,metadata_json) VALUES(?1,?2,?3,?4,?5,?6)", params![asset.asset_id,receipt.destination.project_id,version.map(|v| &v.version_id),asset.relative_path,asset.sha256,encode(asset)?]).map_err(message)?;
    Ok(())
}
