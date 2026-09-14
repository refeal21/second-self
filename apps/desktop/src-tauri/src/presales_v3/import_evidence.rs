//! Original SQL cells, hash domains and origin approvals remain separate from
//! destination identity. None of these deserializable records is replay authority.
use super::{
    import_assets::{hash, ImportedAsset},
    legacy_envelope::{SelectedRows, SelectedTable},
    store::{decode, encode, message},
    *,
};
use crate::{
    presales::PresalesCheckpoint,
    visual_style::{VisualGenerationRecord, VisualStyleProfile, VisualStyleState},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportReceipt {
    pub schema_version: u32,
    pub import_id: String,
    pub mode: LegacyCopyMode,
    pub kind: V3CatalogKind,
    pub destination: V3ProjectSummary,
    pub origin: V3Origin,
    pub source_file_evidence_json: String,
    pub raw_pipeline_sha256: String,
    pub replay_validator: String,
    pub pipeline: Value,
    pub presales: Option<PresalesCheckpoint>,
    pub palette: VisualStyleState,
    pub evidence: ImportedAsset,
    pub assets: Vec<ImportedAsset>,
    pub pages: Vec<V3PageState>,
    pub reasons: Vec<String>,
}

pub(super) fn cell<'a>(
    table: &'a SelectedTable,
    row: &'a [Value],
    column: &str,
) -> Result<&'a Value, String> {
    let i = table
        .columns
        .iter()
        .position(|c| c == column)
        .ok_or_else(|| format!("selected evidence lacks column {column}"))?;
    row.get(i)
        .ok_or_else(|| "selected row width mismatch".into())
}
pub(super) fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value.as_str().ok_or_else(|| format!("invalid {name}"))
}

pub(super) fn style_and_records(
    rows: &SelectedRows,
    pipeline: &Value,
) -> Result<(VisualStyleState, Vec<VisualGenerationRecord>), String> {
    let project = text(&pipeline["project"]["id"], "source project")?;
    let mut styles = std::collections::BTreeMap::new();
    if let Some(table) = rows.get("visual_style_versions") {
        for row in &table.rows {
            let revision = cell(table, row, "revision")?
                .as_i64()
                .filter(|n| *n > 0)
                .ok_or("invalid saved palette revision")?;
            let profile: VisualStyleProfile =
                decode(text(cell(table, row, "profile_json")?, "profile JSON")?)?;
            crate::visual_style::validate_profile(&profile)?;
            if styles.insert(revision, profile).is_some() {
                return Err("duplicate saved palette revision".into());
            }
        }
    }
    let (revision, profile) = styles
        .last_key_value()
        .map(|(r, p)| (*r, Some(p.clone())))
        .unwrap_or((0, None));
    let locked = rows
        .get("visual_style_locks")
        .is_some_and(|t| !t.rows.is_empty())
        || pipeline["approvals"].as_array().is_some_and(|a| {
            a.iter()
                .any(|a| a["stage"] == "visual_review" && a["status"] == "approved")
        });
    let mut records = vec![];
    if let Some(table) = rows.get("visual_generation_records") {
        for row in &table.rows {
            let r: VisualGenerationRecord =
                decode(text(cell(table, row, "record_json")?, "visual record")?)?;
            if r.request.project_id != project
                || cell(table, row, "id")? != &Value::String(r.request.id.clone())
                || r.prompt_sha256 != hash(r.request.prompt.as_bytes())
                || r.request.style_revision != r.style.revision
                || (r.style.revision > 0
                    && styles.get(&r.style.revision) != r.style.profile.as_ref())
                || (r.style.revision == 0 && r.style.profile.is_some())
                || r.request.expected_revision < 1
                || r.request.expected_revision
                    > pipeline["revision"].as_i64().ok_or("source revision")?
                || !matches!(r.request.kind.as_str(), "imagegen" | "upload")
            {
                return Err("source visual record identity/style mismatch".into());
            }
            if let Some(receipt) = &r.receipt {
                if r.request.expected_revision.checked_add(1) != Some(receipt.committed_revision)
                    || receipt.committed_revision
                        > pipeline["revision"].as_i64().ok_or("source revision")?
                    || (r.request.kind == "upload"
                        && receipt.provider != crate::visual_style::VisualProvider::default())
                {
                    return Err("source visual receipt revision/provider mismatch".into());
                }
            }
            records.push(r);
        }
    }
    Ok((
        VisualStyleState {
            revision,
            profile,
            locked,
        },
        records,
    ))
}

/// Returns an original reference only when the exact source decision and all
/// content/palette/image receipt links exist. No acknowledgement is inferred.
pub(super) fn origin_reference(
    receipt: &ImportReceipt,
    rows: &SelectedRows,
    records: &[VisualGenerationRecord],
    page: &V3PageState,
    version: &V3VisualVersion,
    original: &Value,
) -> Result<Option<V3OriginApprovalRef>, String> {
    if receipt.mode != LegacyCopyMode::FormatCopy || original["version"]["status"] != "frozen" {
        return Ok(None);
    }
    let Some(image) = &version.image else {
        return Ok(None);
    };
    let source_version = text(&original["version"]["id"], "original version")?;
    let Some(approval) = receipt.pipeline["approvals"].as_array().and_then(|a| {
        a.iter().find(|a| {
            a["versionId"] == source_version
                && a["slideId"] == page.slide_id
                && a["stage"] == "visual_review"
                && a["status"] == "approved"
        })
    }) else {
        return Ok(None);
    };
    let Some(profile) = receipt.palette.profile.as_ref() else {
        return Ok(None);
    };
    let spec_sha = hash(&serde_json::to_vec(&page.spec).map_err(message)?);
    let matches = records
        .iter()
        .filter(|r| {
            r.request.slide_id == page.slide_id
                && r.request.style_revision == receipt.palette.revision
                && r.style.profile.as_ref() == Some(profile)
                && r.spec_sha256 == spec_sha
                && r.receipt.as_ref().is_some_and(|v| {
                    v.relative_path == original["relativePath"] && v.sha256 == image.sha256
                })
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Ok(None);
    }
    let record = matches[0];
    let committed = record.receipt.as_ref().ok_or("matched receipt missing")?;
    let checkpoints = rows
        .get("checkpoints")
        .map(|t| {
            t.rows
                .iter()
                .filter_map(|row| {
                    cell(t, row, "pipeline_json")
                        .ok()
                        .and_then(Value::as_str)
                        .and_then(|raw| decode::<Value>(raw).ok())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let prior = checkpoints.iter().find(|p| {
        p["project"]["id"] == receipt.origin.source_project_id
            && p["revision"] == record.request.expected_revision
    });
    let candidate = checkpoints.iter().find(|p| {
        p["project"]["id"] == receipt.origin.source_project_id
            && p["revision"] == committed.committed_revision
    });
    let exact_spec = |p: &&Value| {
        p["slideSpecs"]["version"]["status"] == "frozen"
            && p["slideSpecs"]["value"]
                .as_array()
                .is_some_and(|specs| specs.iter().any(|s| s == &page.spec))
    };
    if !prior.as_ref().is_some_and(exact_spec)
        || !candidate.as_ref().is_some_and(exact_spec)
        || !candidate.is_some_and(|p| {
            p["visuals"][&page.slide_id]
                .as_array()
                .and_then(|v| v.last())
                .is_some_and(|v| {
                    v["version"]["id"] == source_version
                        && v["version"]["status"] == "draft"
                        && v["relativePath"] == original["relativePath"]
                        && v["sha256"] == original["sha256"]
                        && v["byteLength"] == original["byteLength"]
                })
        })
    {
        return Ok(None);
    }
    let artifact = rows.get("artifacts").is_some_and(|t| {
        t.rows.iter().any(|r| {
            cell(t, r, "version_id").ok() == Some(&Value::String(source_version.into()))
                && cell(t, r, "path").ok() == Some(&original["relativePath"])
                && cell(t, r, "kind").ok()
                    == Some(&Value::String("approved-visual-candidate".into()))
        })
    });
    let decision = rows.get("approvals").is_some_and(|t| {
        t.rows.iter().any(|r| {
            cell(t, r, "id").ok() == Some(&approval["id"])
                && cell(t, r, "version_id").ok() == Some(&approval["versionId"])
                && cell(t, r, "slide_id").ok() == Some(&approval["slideId"])
                && cell(t, r, "stage").ok() == Some(&approval["stage"])
                && cell(t, r, "status").ok() == Some(&approval["status"])
                && cell(t, r, "decided_at").ok() == Some(&approval["decidedAt"])
        })
    });
    if !artifact || !decision || receipt.pipeline["slideSpecs"]["version"]["status"] != "frozen" {
        return Ok(None);
    }
    Ok(Some(V3OriginApprovalRef {
        reference_id: format!("origin-approval-{}", version.version_id),
        import_id: receipt.import_id.clone(),
        source_project_id: receipt.origin.source_project_id.clone(),
        source_revision: receipt.origin.source_revision,
        source_slide_id: page.slide_id.clone(),
        source_version_id: source_version.into(),
        source_approval: approval.clone(),
        version_id: version.version_id.clone(),
        image: image.clone(),
        spec_hash_algorithm: "sha256-legacy-serde-json-v1".into(),
        spec_sha256: spec_sha,
        details_version_id: text(
            &receipt.pipeline["slideSpecs"]["version"]["id"],
            "details version",
        )?
        .into(),
        palette_revision: receipt.palette.revision,
        palette_hash_algorithm: crate::presales::NATIVE_VALUE_HASH_ALGORITHM.into(),
        palette_sha256: crate::presales::native_value_hash(
            &serde_json::to_value(profile).map_err(message)?,
        )?,
        visual_request_id: matches[0].request.id.clone(),
    }))
}

pub(super) fn read_envelope(receipt: &ImportReceipt, bytes: &[u8]) -> Result<SelectedRows, String> {
    let envelope: Value = serde_json::from_slice(bytes).map_err(message)?;
    let body = &envelope["evidence"];
    let rows: SelectedRows = serde_json::from_value(body["rows"].clone()).map_err(message)?;
    let projects = rows
        .get("projects")
        .ok_or("selected project evidence missing")?;
    if projects.rows.len() != 1 {
        return Err("selected project evidence is not unique".into());
    }
    let raw = text(
        cell(projects, &projects.rows[0], "pipeline_json")?,
        "raw pipeline",
    )?;
    let reconstructed = super::legacy_envelope::SelectedEnvelope::bind(
        &receipt.origin.source_project_id,
        receipt.origin.source_revision,
        &receipt.origin.snapshot_digest,
        raw,
        rows.clone(),
    )?;
    if encode(&reconstructed)?.as_bytes() != bytes
        || decode::<Value>(raw)? != receipt.pipeline
        || hash(raw.as_bytes()) != receipt.raw_pipeline_sha256
        || receipt.pipeline["project"]["id"] != receipt.origin.source_project_id
        || receipt.pipeline["revision"] != receipt.origin.source_revision
    {
        return Err("selected envelope/replay identity mismatch".into());
    }
    for (name, table) in &rows {
        let owner = if name == "projects" {
            "id"
        } else {
            "project_id"
        };
        for row in &table.rows {
            if row.len() != table.columns.len()
                || cell(table, row, owner)?
                    != &Value::String(receipt.origin.source_project_id.clone())
            {
                return Err("selected row owner mismatch".into());
            }
        }
    }
    let source_digest_bytes = format!(
        "[1,{},{},{}]",
        encode(&receipt.origin.source_project_id)?,
        receipt.origin.source_revision,
        receipt.source_file_evidence_json
    );
    if hash(source_digest_bytes.as_bytes()) != receipt.origin.snapshot_digest
        || receipt.origin.hash_algorithm != "legacy-source-snapshot-sha256-v1"
    {
        return Err("source file identity digest mismatch".into());
    }
    if let Some(presales) = &receipt.presales {
        crate::presales::storage::validate_loaded(&receipt.pipeline, presales).map_err(message)?;
        let table = rows
            .get("presales_checkpoints")
            .ok_or("paired checkpoint row missing")?;
        if !table.rows.iter().any(|r| {
            cell(table, r, "pipeline_revision").ok()
                == Some(&Value::from(receipt.origin.source_revision))
                && cell(table, r, "snapshot_json")
                    .ok()
                    .and_then(Value::as_str)
                    .and_then(|s| decode::<PresalesCheckpoint>(s).ok())
                    .as_ref()
                    == Some(presales)
        }) {
            return Err("paired checkpoint differs from selected rows".into());
        }
    }
    Ok(rows)
}
