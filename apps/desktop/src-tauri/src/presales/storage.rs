use super::{
    bundled_skill_metadata, native_value_hash, validate_pair, AnalysisBasis, DetailsBasis,
    OutlineBasis, PresalesApprovalBinding, PresalesBasis, PresalesCheckpoint, PresalesDraftPair,
    ProjectCheckpoint, SkillIdentity, VisibleBindingBasis, NATIVE_VALUE_HASH_ALGORITHM,
};
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde_json::Value;
use std::collections::BTreeSet;

const SNAPSHOT_LIMIT: usize = 4 * 1024 * 1024;

fn invalid(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(message.into())
}

fn required<'a>(value: &'a Value, pointer: &str) -> Result<&'a Value> {
    value
        .pointer(pointer)
        .ok_or_else(|| invalid(format!("pipeline field {pointer} is required")))
}

fn string(value: &Value, pointer: &str) -> Result<String> {
    required(value, pointer)?
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| invalid(format!("pipeline field {pointer} must be a string")))
}

fn skill_identity() -> Result<SkillIdentity> {
    serde_json::from_value(bundled_skill_metadata()).map_err(|error| invalid(error.to_string()))
}

fn details_parts(pair: &PresalesDraftPair) -> Result<Option<(&Value, &Value)>> {
    let Some(details) = &pair.details else {
        return Ok(None);
    };
    Ok(Some((
        details
            .get("specs")
            .ok_or_else(|| invalid("details specs are required"))?,
        details
            .get("designs")
            .ok_or_else(|| invalid("details designs are required"))?,
    )))
}

fn derive_basis(pipeline: &Value, pair: &PresalesDraftPair) -> Result<PresalesBasis> {
    let analysis = required(pipeline, "/analysis/output")?;
    validate_pair(pair, analysis).map_err(invalid)?;
    if required(&pair.outline, "/outline")? != required(pipeline, "/outline/value")? {
        return Err(invalid(
            "presales outline must exactly match pipeline outline",
        ));
    }

    let details = details_parts(pair)?;
    match (details, pipeline.pointer("/slideSpecs/value")) {
        (None, None) => {}
        (Some((specs, _)), Some(pipeline_specs)) if specs == pipeline_specs => {}
        _ => {
            return Err(invalid(
                "presales details must exactly match pipeline slide specs",
            ))
        }
    }

    let outline = OutlineBasis {
        version_id: string(pipeline, "/outline/version/id")?,
        content_hash: native_value_hash(required(pipeline, "/outline/value")?).map_err(invalid)?,
        plan_hash: native_value_hash(required(&pair.outline, "/plan")?).map_err(invalid)?,
    };
    let mut bindings = Vec::new();
    let details = if let Some((specs_value, designs_value)) = details {
        let specs = specs_value
            .as_array()
            .ok_or_else(|| invalid("details specs must be an array"))?;
        let designs = designs_value
            .as_array()
            .ok_or_else(|| invalid("details designs must be an array"))?;
        for (spec, design) in specs.iter().zip(designs) {
            let slide_id = string(spec, "/id")?;
            for binding in required(design, "/textBindings")?
                .as_array()
                .ok_or_else(|| invalid("textBindings must be an array"))?
            {
                let path = string(binding, "/path")?;
                let visible = spec.pointer(&path).ok_or_else(|| {
                    invalid(format!(
                        "binding path {path} is absent from slide {slide_id}"
                    ))
                })?;
                bindings.push(VisibleBindingBasis {
                    slide_id: slide_id.clone(),
                    id: string(binding, "/id")?,
                    path,
                    visible_value_hash: native_value_hash(visible).map_err(invalid)?,
                });
            }
        }
        Some(DetailsBasis {
            version_id: string(pipeline, "/slideSpecs/version/id")?,
            content_hash: native_value_hash(required(pipeline, "/slideSpecs/value")?)
                .map_err(invalid)?,
            design_hash: native_value_hash(designs_value).map_err(invalid)?,
        })
    } else {
        None
    };
    Ok(PresalesBasis {
        analysis: AnalysisBasis {
            request_id: string(pipeline, "/analysis/requestId")?,
            artifact_sha256: string(pipeline, "/analysis/sha256")?,
            output_hash: native_value_hash(analysis).map_err(invalid)?,
        },
        outline,
        details,
        bindings,
    })
}

fn structural_revision_is_pending(pipeline: &Value) -> bool {
    pipeline
        .get("outlineRevisionDraft")
        .is_some_and(|value| !value.is_null())
        || pipeline
            .get("revisionEvents")
            .and_then(Value::as_array)
            .is_some_and(|events| !events.is_empty())
}

fn exact_approval(
    approval: &Value,
    project_id: &str,
    stage: &str,
    version_id: &str,
    decided_at: &str,
) -> Result<String> {
    let object = approval
        .as_object()
        .ok_or_else(|| invalid("approval proof must be an object"))?;
    let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    let expected = BTreeSet::from([
        "decidedAt",
        "id",
        "projectId",
        "stage",
        "status",
        "versionId",
    ]);
    if actual != expected
        || approval["projectId"] != project_id
        || approval["stage"] != stage
        || approval["versionId"] != version_id
        || approval["status"] != "approved"
        || approval["decidedAt"] != decided_at
        || chrono::DateTime::parse_from_rfc3339(decided_at).is_err()
    {
        return Err(invalid(
            "approval proof does not match the exact freeze transition",
        ));
    }
    let id = approval["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("approval proof id is required"))?;
    Ok(id.to_owned())
}

fn approval_transition(
    current: &Value,
    next: &Value,
    prior: &PresalesCheckpoint,
    pair: &PresalesDraftPair,
    basis: &PresalesBasis,
) -> Result<Option<PresalesApprovalBinding>> {
    let current_approvals = required(current, "/approvals")?
        .as_array()
        .ok_or_else(|| invalid("pipeline approvals must be an array"))?;
    let next_approvals = required(next, "/approvals")?
        .as_array()
        .ok_or_else(|| invalid("pipeline approvals must be an array"))?;
    if next_approvals.len() != current_approvals.len() + 1
        || next_approvals[..current_approvals.len()] != current_approvals[..]
        || pair != &prior.draft
        || basis != &prior.basis
    {
        return Err(invalid(
            "approval-only checkpoint must preserve the exact prior pair and approval history",
        ));
    }

    let project_id = string(current, "/project/id")?;
    let decided_at = string(next, "/project/updatedAt")?;
    let workflow = string(current, "/project/workflowStatus")?;
    let (stage, version_pointer, next_workflow, content_hash, companion_hash) =
        match workflow.as_str() {
            "outline_review"
                if current
                    .pointer("/outline/version/status")
                    .and_then(Value::as_str)
                    == Some("draft") =>
            {
                (
                    "outline_review",
                    "/outline/version",
                    "detail_review",
                    basis.outline.content_hash.clone(),
                    basis.outline.plan_hash.clone(),
                )
            }
            "detail_review"
                if current
                    .pointer("/slideSpecs/version/status")
                    .and_then(Value::as_str)
                    == Some("draft") =>
            {
                if !prior
                    .approval_bindings
                    .iter()
                    .any(|binding| binding.stage == "outline_review")
                {
                    return Err(invalid(
                        "detail approval requires saved joint outline proof",
                    ));
                }
                let details = basis
                    .details
                    .as_ref()
                    .ok_or_else(|| invalid("detail approval requires paired details"))?;
                (
                    "detail_review",
                    "/slideSpecs/version",
                    "visual_review",
                    details.content_hash.clone(),
                    details.design_hash.clone(),
                )
            }
            _ => return Err(invalid("unsupported presales approval transition")),
        };
    let version_id = string(current, &format!("{version_pointer}/id"))?;
    let approval = next_approvals
        .last()
        .ok_or_else(|| invalid("approval proof is missing"))?;
    let approval_id = exact_approval(approval, &project_id, stage, &version_id, &decided_at)?;
    if prior
        .approval_bindings
        .iter()
        .any(|binding| binding.approval_id == approval_id)
    {
        return Err(invalid("approval proof id was already used"));
    }

    let mut expected = current.clone();
    expected["revision"] = next["revision"].clone();
    expected["project"]["updatedAt"] = next["project"]["updatedAt"].clone();
    expected["project"]["workflowStatus"] = Value::String(next_workflow.into());
    let expected_status = expected
        .pointer_mut(&format!("{version_pointer}/status"))
        .ok_or_else(|| invalid("approval version status is missing"))?;
    *expected_status = Value::String("frozen".into());
    let expected_frozen_at = expected
        .pointer_mut(&format!("{version_pointer}/frozenAt"))
        .ok_or_else(|| invalid("approval version frozenAt is missing"))?;
    *expected_frozen_at = Value::String(decided_at.clone());
    expected["approvals"] = next["approvals"].clone();
    if stage == "detail_review" {
        expected["currentSlideId"] = next
            .pointer("/slideSpecs/value/0/id")
            .cloned()
            .ok_or_else(|| invalid("detail approval requires a first slide"))?;
    }
    if expected != *next {
        return Err(invalid(
            "approval-only checkpoint contains changes outside the exact transition",
        ));
    }

    Ok(Some(PresalesApprovalBinding {
        approval_id,
        stage: stage.into(),
        version_id,
        content_hash,
        companion_hash,
        skill: prior.skill.clone(),
        decided_at,
    }))
}

fn draft_checkpoint_is_exact(current: &Value, next: &Value, pair: &PresalesDraftPair) -> bool {
    let mut expected = current.clone();
    expected["revision"] = next["revision"].clone();
    expected["project"]["updatedAt"] = next["project"]["updatedAt"].clone();
    expected["outline"]["value"] = pair.outline["outline"].clone();
    match (
        &pair.details,
        current.get("slideSpecs").filter(|value| !value.is_null()),
    ) {
        (Some(details), Some(_)) => expected["slideSpecs"]["value"] = details["specs"].clone(),
        (Some(_), None) => expected["slideSpecs"] = next["slideSpecs"].clone(),
        (None, _) => {}
    }
    expected == *next
}

fn version_state<'a>(pipeline: &'a Value, pointer: &str) -> Result<(&'a str, Option<&'a str>)> {
    let version = required(pipeline, pointer)?
        .as_object()
        .ok_or_else(|| invalid(format!("pipeline field {pointer} must be an object")))?;
    let status = version
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("pipeline field {pointer}/status must be a string")))?;
    let frozen_at = match version.get("frozenAt") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => {
            return Err(invalid(format!(
                "pipeline field {pointer}/frozenAt must be null or a string"
            )))
        }
    };
    Ok((status, frozen_at))
}

fn validate_lifecycle(pipeline: &Value, checkpoint: &PresalesCheckpoint) -> Result<()> {
    let object = pipeline
        .as_object()
        .ok_or_else(|| invalid("paired pipeline must be an object"))?;
    if !object.contains_key("outline") || !object.contains_key("slideSpecs") {
        return Err(invalid(
            "paired pipeline requires explicit outline and slideSpecs slots",
        ));
    }
    let approvals = required(pipeline, "/approvals")?
        .as_array()
        .ok_or_else(|| invalid("pipeline approvals must be an array"))?;
    let bindings = &checkpoint.approval_bindings;
    if approvals.len() != bindings.len() || bindings.len() > 2 {
        return Err(invalid("paired approval proof set is incomplete"));
    }
    let project_id = string(pipeline, "/project/id")?;
    let workflow = string(pipeline, "/project/workflowStatus")?;
    let current_slide = pipeline.get("currentSlideId").ok_or_else(|| {
        invalid("paired pipeline requires an explicit currentSlideId lifecycle slot")
    })?;
    let (outline_status, outline_frozen_at) = version_state(pipeline, "/outline/version")?;
    let details_present = !pipeline["slideSpecs"].is_null();
    if details_present != checkpoint.draft.details.is_some()
        || details_present != checkpoint.basis.details.is_some()
    {
        return Err(invalid("paired details slot and companion must agree"));
    }
    let details_state = if details_present {
        Some(version_state(pipeline, "/slideSpecs/version")?)
    } else {
        None
    };

    for (index, binding) in bindings.iter().enumerate() {
        let expected_stage = if index == 0 {
            "outline_review"
        } else {
            "detail_review"
        };
        if binding.stage != expected_stage || binding.skill != checkpoint.skill {
            return Err(invalid(
                "paired approval proof order or skill identity is invalid",
            ));
        }
        let pipeline_approval_id = exact_approval(
            &approvals[index],
            &project_id,
            expected_stage,
            &binding.version_id,
            &binding.decided_at,
        )?;
        if pipeline_approval_id != binding.approval_id {
            return Err(invalid(
                "pipeline approval id does not match its saved joint proof",
            ));
        }
        let hashes_match = if index == 0 {
            binding.version_id == checkpoint.basis.outline.version_id
                && binding.content_hash == checkpoint.basis.outline.content_hash
                && binding.companion_hash == checkpoint.basis.outline.plan_hash
        } else {
            checkpoint.basis.details.as_ref().is_some_and(|details| {
                binding.version_id == details.version_id
                    && binding.content_hash == details.content_hash
                    && binding.companion_hash == details.design_hash
            })
        };
        if !hashes_match {
            return Err(invalid("paired approval proof hashes are invalid"));
        }
    }

    match bindings.as_slice() {
        [] => {
            if workflow != "outline_review"
                || outline_status != "draft"
                || outline_frozen_at.is_some()
                || details_present
                || !current_slide.is_null()
            {
                return Err(invalid(
                    "unapproved paired state requires only an unfrozen outline draft",
                ));
            }
        }
        [outline] => {
            if workflow != "detail_review"
                || outline_status != "frozen"
                || outline_frozen_at != Some(outline.decided_at.as_str())
                || !current_slide.is_null()
                || details_state
                    .is_some_and(|(status, frozen_at)| status != "draft" || frozen_at.is_some())
            {
                return Err(invalid(
                    "outline-approved paired state is inconsistent with its proof",
                ));
            }
        }
        [outline, details] => {
            let Some((details_status, details_frozen_at)) = details_state else {
                return Err(invalid("detail approval requires paired details"));
            };
            if workflow != "visual_review"
                || outline_status != "frozen"
                || outline_frozen_at != Some(outline.decided_at.as_str())
                || details_status != "frozen"
                || details_frozen_at != Some(details.decided_at.as_str())
                || pipeline.pointer("/slideSpecs/value/0/id") != Some(current_slide)
            {
                return Err(invalid(
                    "detail-approved paired state is inconsistent with its proofs",
                ));
            }
        }
        _ => return Err(invalid("unsupported paired approval proof set")),
    }
    Ok(())
}

fn first_enable(
    connection: &Connection,
    project_id: &str,
    current: &Value,
    next: &Value,
    pair: &PresalesDraftPair,
) -> Result<PresalesCheckpoint> {
    let current_object = current
        .as_object()
        .ok_or_else(|| invalid("current pipeline must be an object"))?;
    if !current_object.contains_key("outline") || !current_object.contains_key("slideSpecs") {
        return Err(invalid(
            "presales opt-in requires explicit outline and slideSpecs slots",
        ));
    }
    if !current["slideSpecs"].is_null() {
        return Err(invalid(
            "presales opt-in cannot adopt details before joint outline approval",
        ));
    }
    if !current["outline"].is_null() {
        let (status, frozen_at) = version_state(current, "/outline/version")?;
        if status != "draft" || frozen_at.is_some() {
            return Err(invalid("presales opt-in cannot replace a frozen outline"));
        }
        if current["outline"] != next["outline"] {
            return Err(invalid(
                "presales opt-in must preserve an existing unfrozen outline",
            ));
        }
    }
    if current["analysis"] != next["analysis"]
        || current["sources"] != next["sources"]
        || current["promptContext"] != next["promptContext"]
        || current["preferenceSnapshot"] != next["preferenceSnapshot"]
    {
        return Err(invalid(
            "presales opt-in cannot replace analysis, sources, prompt context or preferences",
        ));
    }
    if next
        .pointer("/project/workflowStatus")
        .and_then(Value::as_str)
        != Some("outline_review")
        || next
            .pointer("/outline/version/status")
            .and_then(Value::as_str)
            != Some("draft")
        || !next["approvals"].as_array().is_some_and(Vec::is_empty)
        || !next["visuals"]
            .as_object()
            .is_some_and(serde_json::Map::is_empty)
        || !next["exportReceipt"].is_null()
        || !next["qaReport"].is_null()
        || !next["blockedCondition"].is_null()
        || !next["currentSlideId"].is_null()
        || structural_revision_is_pending(next)
    {
        return Err(invalid(
            "presales opt-in requires an unfrozen outline draft without approvals or downstream state",
        ));
    }
    if pair.details.is_some() || !next["slideSpecs"].is_null() {
        return Err(invalid(
            "presales opt-in cannot contain details before joint outline approval",
        ));
    }
    let (submitted_status, submitted_frozen_at) = version_state(next, "/outline/version")?;
    if submitted_status != "draft" || submitted_frozen_at.is_some() {
        return Err(invalid("presales opt-in outline must be an unfrozen draft"));
    }
    if !current["approvals"].as_array().is_some_and(Vec::is_empty)
        || !current["visuals"]
            .as_object()
            .is_some_and(serde_json::Map::is_empty)
        || !current["exportReceipt"].is_null()
    {
        return Err(invalid(
            "presales opt-in cannot adopt approved or visual history",
        ));
    }
    let generation_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM visual_generation_records WHERE project_id=?1)",
        [project_id],
        |row| row.get(0),
    )?;
    if generation_exists {
        return Err(invalid(
            "presales opt-in cannot adopt visual generation history",
        ));
    }
    let content_approval_exists: bool = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM approvals
            WHERE project_id=?1 AND stage IN ('outline_review','detail_review')
        )",
        [project_id],
        |row| row.get(0),
    )?;
    if content_approval_exists {
        return Err(invalid(
            "presales opt-in cannot adopt relational content approval history",
        ));
    }
    let mut expected = current.clone();
    expected["revision"] = next["revision"].clone();
    expected["project"]["updatedAt"] = next["project"]["updatedAt"].clone();
    expected["project"]["workflowStatus"] = Value::String("outline_review".into());
    expected["outline"] = next["outline"].clone();
    if pair.details.is_some() {
        expected["slideSpecs"] = next["slideSpecs"].clone();
    }
    if expected != *next {
        return Err(invalid(
            "presales opt-in contains changes outside the paired draft checkpoint",
        ));
    }
    let basis = derive_basis(next, pair)?;
    let checkpoint = PresalesCheckpoint {
        schema_version: 1,
        hash_algorithm: NATIVE_VALUE_HASH_ALGORITHM.into(),
        skill: skill_identity()?,
        draft: pair.clone(),
        basis,
        approval_bindings: Vec::new(),
    };
    validate_lifecycle(next, &checkpoint)?;
    Ok(checkpoint)
}

pub(crate) fn initialize_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(&format!(
        "
        CREATE TABLE IF NOT EXISTS presales_projects (
            project_id TEXT PRIMARY KEY REFERENCES projects(id)
        );
        CREATE TABLE IF NOT EXISTS presales_checkpoints (
            project_id TEXT NOT NULL REFERENCES presales_projects(project_id),
            pipeline_revision INTEGER NOT NULL CHECK(pipeline_revision > 0),
            snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) <= {SNAPSHOT_LIMIT}),
            PRIMARY KEY(project_id, pipeline_revision)
        );
        CREATE TABLE IF NOT EXISTS presales_approval_bindings (
            approval_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES presales_projects(project_id),
            sequence INTEGER NOT NULL CHECK(sequence > 0),
            pipeline_revision INTEGER NOT NULL CHECK(pipeline_revision > 0),
            binding_json TEXT NOT NULL CHECK(length(binding_json) <= 16384),
            UNIQUE(project_id, sequence)
        );
        "
    ))
}

pub(crate) fn enabled(connection: &Connection, project_id: &str) -> Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM presales_projects WHERE project_id=?1)",
        [project_id],
        |row| row.get(0),
    )
}

pub(crate) fn guard_bare(connection: &Connection, project_id: &str) -> Result<()> {
    if enabled(connection, project_id)? {
        return Err(invalid(
            "Presales projects require a validated paired checkpoint action",
        ));
    }
    Ok(())
}

fn approval_rows(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<PresalesApprovalBinding>> {
    let mut statement = connection.prepare(
        "SELECT binding_json FROM presales_approval_bindings
         WHERE project_id=?1 ORDER BY sequence",
    )?;
    let rows = statement
        .query_map([project_id], |row| row.get::<_, String>(0))?
        .map(|value| {
            serde_json::from_str(&value?).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .collect();
    rows
}

pub(crate) fn validate_loaded(pipeline: &Value, checkpoint: &PresalesCheckpoint) -> Result<()> {
    let valid_skill = !checkpoint.skill.id.trim().is_empty()
        && !checkpoint.skill.version.trim().is_empty()
        && checkpoint.skill.sha256.len() == 64
        && checkpoint
            .skill
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    if checkpoint.schema_version != 1
        || checkpoint.hash_algorithm != NATIVE_VALUE_HASH_ALGORITHM
        || !valid_skill
        || checkpoint.basis != derive_basis(pipeline, &checkpoint.draft)?
    {
        return Err(invalid("stored presales checkpoint identity is invalid"));
    }
    validate_lifecycle(pipeline, checkpoint)
}

pub(crate) fn load_on(connection: &Connection, project_id: &str) -> Result<ProjectCheckpoint> {
    let pipeline_json: String = connection.query_row(
        "SELECT pipeline_json FROM projects WHERE id=?1",
        [project_id],
        |row| row.get(0),
    )?;
    let pipeline: Value = serde_json::from_str(&pipeline_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    if !enabled(connection, project_id)? {
        return Ok(ProjectCheckpoint {
            pipeline,
            presales: None,
        });
    }
    let revision = pipeline["revision"]
        .as_i64()
        .ok_or_else(|| invalid("persisted pipeline revision is invalid"))?;
    let encoded: Option<String> = connection
        .query_row(
            "SELECT snapshot_json FROM presales_checkpoints
             WHERE project_id=?1 AND pipeline_revision=?2",
            params![project_id, revision],
            |row| row.get(0),
        )
        .optional()?;
    let encoded = encoded.ok_or_else(|| {
        invalid("presales marker has no checkpoint for the exact pipeline revision")
    })?;
    let checkpoint: PresalesCheckpoint = serde_json::from_str(&encoded).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    validate_loaded(&pipeline, &checkpoint)?;
    if checkpoint.approval_bindings != approval_rows(connection, project_id)? {
        return Err(invalid("stored presales approval evidence is invalid"));
    }
    Ok(ProjectCheckpoint {
        pipeline,
        presales: Some(checkpoint),
    })
}

pub(crate) fn prepare(
    connection: &Connection,
    project_id: &str,
    current: &Value,
    next: &Value,
    pair: Option<&PresalesDraftPair>,
) -> Result<Option<PresalesCheckpoint>> {
    match (enabled(connection, project_id)?, pair) {
        (false, None) => Ok(None),
        (false, Some(pair)) => first_enable(connection, project_id, current, next, pair).map(Some),
        (true, None) => Err(invalid(
            "Presales projects require a validated paired checkpoint action",
        )),
        (true, Some(pair)) => {
            let prior = load_on(connection, project_id)?
                .presales
                .ok_or_else(|| invalid("presales checkpoint is missing"))?;
            if current["analysis"] != next["analysis"]
                || current["sources"] != next["sources"]
                || current["promptContext"] != next["promptContext"]
                || current["preferenceSnapshot"] != next["preferenceSnapshot"]
                || structural_revision_is_pending(next)
                || current["visuals"] != next["visuals"]
                || current["exportReceipt"] != next["exportReceipt"]
                || current["qaReport"] != next["qaReport"]
                || current["blockedCondition"] != next["blockedCondition"]
            {
                return Err(invalid(
                    "Presales checkpoint cannot change sources, structural revisions or downstream state",
                ));
            }
            let basis = derive_basis(next, pair)?;
            if current
                .pointer("/outline/version/status")
                .and_then(Value::as_str)
                == Some("frozen")
                && (basis.outline != prior.basis.outline || pair.outline != prior.draft.outline)
            {
                return Err(invalid("approved presales outline and plan are immutable"));
            }
            if current
                .pointer("/slideSpecs/version/status")
                .and_then(Value::as_str)
                == Some("frozen")
                && (basis.details != prior.basis.details || pair.details != prior.draft.details)
            {
                return Err(invalid(
                    "approved presales details and designs are immutable",
                ));
            }
            let current_approvals = required(current, "/approvals")?
                .as_array()
                .ok_or_else(|| invalid("pipeline approvals must be an array"))?;
            let next_approvals = required(next, "/approvals")?
                .as_array()
                .ok_or_else(|| invalid("pipeline approvals must be an array"))?;
            if next_approvals.len() < current_approvals.len()
                || next_approvals[..current_approvals.len()] != current_approvals[..]
            {
                return Err(invalid("historical approval proof is immutable"));
            }
            let appended = next_approvals.len() - current_approvals.len();
            if appended > 1 {
                return Err(invalid("exactly one approval proof may be appended"));
            }
            let mut approval_bindings = prior.approval_bindings.clone();
            if appended == 1 {
                if let Some(binding) = approval_transition(current, next, &prior, pair, &basis)? {
                    approval_bindings.push(binding);
                }
            } else {
                if current.pointer("/outline/version/status")
                    != next.pointer("/outline/version/status")
                    || current.pointer("/outline/version/frozenAt")
                        != next.pointer("/outline/version/frozenAt")
                    || (current
                        .get("slideSpecs")
                        .is_some_and(|value| !value.is_null())
                        && (current.pointer("/slideSpecs/version/status")
                            != next.pointer("/slideSpecs/version/status")
                            || current.pointer("/slideSpecs/version/frozenAt")
                                != next.pointer("/slideSpecs/version/frozenAt")))
                {
                    return Err(invalid("freeze requires an exact joint approval proof"));
                }
                if current
                    .get("slideSpecs")
                    .is_some_and(|value| value.is_null())
                    && pair.details.is_some()
                {
                    if !prior
                        .approval_bindings
                        .iter()
                        .any(|binding| binding.stage == "outline_review")
                    {
                        return Err(invalid("paired details require saved joint outline proof"));
                    }
                    if next
                        .pointer("/slideSpecs/version/status")
                        .and_then(Value::as_str)
                        != Some("draft")
                        || next
                            .pointer("/slideSpecs/version/frozenAt")
                            .is_some_and(|value| !value.is_null())
                    {
                        return Err(invalid(
                            "new paired details must begin as an unfrozen draft",
                        ));
                    }
                }
                if !draft_checkpoint_is_exact(current, next, pair) {
                    return Err(invalid(
                        "draft checkpoint contains changes outside paired content",
                    ));
                }
            }
            let checkpoint = PresalesCheckpoint {
                schema_version: 1,
                hash_algorithm: NATIVE_VALUE_HASH_ALGORITHM.into(),
                skill: prior.skill,
                draft: pair.clone(),
                basis,
                approval_bindings,
            };
            validate_lifecycle(next, &checkpoint)?;
            Ok(Some(checkpoint))
        }
    }
}

pub(crate) fn persist(
    connection: &Connection,
    project_id: &str,
    revision: i64,
    checkpoint: &PresalesCheckpoint,
    was_enabled: bool,
) -> Result<()> {
    if !was_enabled {
        connection.execute(
            "INSERT INTO presales_projects(project_id) VALUES (?1)",
            [project_id],
        )?;
    }
    let encoded = serde_json::to_string(checkpoint)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    connection.execute(
        "INSERT INTO presales_checkpoints(project_id,pipeline_revision,snapshot_json)
         VALUES (?1,?2,?3)",
        params![project_id, revision, encoded],
    )?;
    let existing: i64 = connection.query_row(
        "SELECT COUNT(*) FROM presales_approval_bindings WHERE project_id=?1",
        [project_id],
        |row| row.get(0),
    )?;
    if existing as usize > checkpoint.approval_bindings.len() {
        return Err(invalid("stored approval binding sequence is invalid"));
    }
    for (index, binding) in checkpoint
        .approval_bindings
        .iter()
        .enumerate()
        .skip(existing as usize)
    {
        let encoded = serde_json::to_string(binding)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        connection.execute(
            "INSERT INTO presales_approval_bindings
             (approval_id,project_id,sequence,pipeline_revision,binding_json)
             VALUES (?1,?2,?3,?4,?5)",
            params![
                binding.approval_id,
                project_id,
                index as i64 + 1,
                revision,
                encoded
            ],
        )?;
    }
    Ok(())
}
