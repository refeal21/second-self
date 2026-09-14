//! Destination pair lifecycle. Source pipeline identity is never projected into
//! destination v1/v2 data; only actual native actions build this evidence.
use super::{
    store::{decode, encode, message},
    *,
};
use crate::presales::{
    bundled_skill_metadata,
    paired_basis::{derive_pair_basis, validate_joint_binding},
    PresalesApprovalBinding, PresalesCheckpoint, PresalesDraftPair, SkillIdentity,
    NATIVE_VALUE_HASH_ALGORITHM,
};
use rusqlite::{params, Connection};

const LIMIT: usize = 4 * 1024 * 1024;

fn current_skill() -> Result<SkillIdentity, String> {
    serde_json::from_value(bundled_skill_metadata()).map_err(message)
}

pub(super) fn validate(draft: &V3ImportedDraft, initial: &V3ImportedDraft) -> Result<(), String> {
    if encode(draft)?.len() > LIMIT {
        return Err("authored draft exceeds 4 MiB".into());
    }
    let mut origin = draft.clone();
    origin.authored = None;
    origin.summary = initial.summary.clone();
    if &origin != initial {
        return Err("authored draft changed verified origin evidence".into());
    }
    let Some(authored) = &draft.authored else {
        return if draft == initial {
            Ok(())
        } else {
            Err("unauthed draft revision mismatch".into())
        };
    };
    if authored.schema_version != 1
        || authored.events.is_empty()
        || authored.events.len() > 1024
        || authored.skill.id.is_empty()
        || authored.skill.version.is_empty()
        || authored.skill.sha256.len() != 64
        || !authored.skill.sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("invalid authored evidence identity or bounds".into());
    }
    let mut replay = initial.clone();
    replay.authored = Some(V3AuthoredDraft {
        schema_version: 1,
        skill: authored.skill.clone(),
        events: vec![],
        checkpoint: None,
        settings: super::draft_settings::initial(initial)?,
    });
    for event in &authored.events {
        apply_event(&mut replay, event.clone())?;
    }
    if replay != *draft {
        return Err("authored draft differs from native action replay".into());
    }
    Ok(())
}

fn apply_event(draft: &mut V3ImportedDraft, event: V3DraftEvent) -> Result<(), String> {
    if draft.summary.revision.checked_add(1) != Some(event.revision)
        || chrono::DateTime::parse_from_rfc3339(&event.at).is_err()
    {
        return Err("draft action revision/time mismatch".into());
    }
    if let V3DraftAction::Settings {
        brief,
        context,
        manual_palette,
    } = &event.action
    {
        let settings = super::draft_settings::change(draft, brief, context, manual_palette)?;
        let a = draft.authored.as_mut().ok_or("authored state missing")?;
        a.settings = settings;
        a.checkpoint = None;
        a.events.push(event.clone());
        draft.summary.revision = event.revision;
        draft.summary.page_count = 0;
        return Ok(());
    }
    let authored = draft.authored.as_mut().ok_or("authored state missing")?;
    let project = &draft.summary.project_id;
    let analysis = draft
        .analysis
        .as_ref()
        .ok_or("verified analysis is required for authoring")?;
    let prior = authored.checkpoint.as_ref();
    let approvals = prior.map_or(0, |c| c.approval_bindings.len());
    let checkpoint = match &event.action {
        V3DraftAction::Settings { .. } => unreachable!("settings handled before pair action"),
        V3DraftAction::Save { stage, envelope } => {
            let (pair, outline_version, details_version) = match stage {
                V3TextStage::Outline if approvals == 0 => (
                    PresalesDraftPair {
                        schema_version: 1,
                        outline: envelope.clone(),
                        details: None,
                    },
                    format!("{project}/outline/{}", event.revision),
                    None,
                ),
                V3TextStage::Details if approvals == 1 => {
                    let prior = prior.ok_or("jointly approved outline is required")?;
                    (
                        PresalesDraftPair {
                            schema_version: 1,
                            outline: prior.draft.outline.clone(),
                            details: Some(envelope.clone()),
                        },
                        prior.basis.outline.version_id.clone(),
                        Some(format!("{project}/details/{}", event.revision)),
                    )
                }
                _ => return Err("stage is not editable; frozen pairs cannot reopen".into()),
            };
            let basis = derive_pair_basis(
                &analysis["output"],
                analysis["requestId"]
                    .as_str()
                    .ok_or("analysis request missing")?,
                analysis["sha256"]
                    .as_str()
                    .ok_or("analysis artifact identity missing")?,
                &outline_version,
                details_version.as_deref(),
                &pair,
            )?;
            PresalesCheckpoint {
                schema_version: 1,
                hash_algorithm: NATIVE_VALUE_HASH_ALGORITHM.into(),
                skill: authored.skill.clone(),
                draft: pair,
                basis,
                approval_bindings: prior.map_or_else(Vec::new, |p| p.approval_bindings.clone()),
            }
        }
        V3DraftAction::Approve { stage } => {
            let mut c = prior
                .cloned()
                .ok_or("a complete pair must be saved before approval")?;
            let (stage_name, version_id, content_hash, companion_hash) = match stage {
                V3TextStage::Outline if approvals == 0 => {
                    let palette = &authored.settings.palette;
                    if palette.revision < 1 {
                        return Err("outline approval requires saved palette revision".into());
                    }
                    let profile = palette
                        .profile
                        .as_ref()
                        .ok_or("outline approval requires saved palette")?;
                    crate::visual_style::validate_profile(profile)?;
                    (
                        "outline_review",
                        c.basis.outline.version_id.clone(),
                        c.basis.outline.content_hash.clone(),
                        c.basis.outline.plan_hash.clone(),
                    )
                }
                V3TextStage::Details if approvals == 1 => {
                    let d = c
                        .basis
                        .details
                        .as_ref()
                        .ok_or("complete details pair is required")?;
                    (
                        "detail_review",
                        d.version_id.clone(),
                        d.content_hash.clone(),
                        d.design_hash.clone(),
                    )
                }
                _ => return Err("joint approval stage/order mismatch".into()),
            };
            c.approval_bindings.push(PresalesApprovalBinding {
                approval_id: format!("{project}/approval/{}", event.revision),
                stage: stage_name.into(),
                version_id,
                content_hash,
                companion_hash,
                skill: authored.skill.clone(),
                decided_at: event.at.clone(),
            });
            c
        }
    };
    for index in 0..checkpoint.approval_bindings.len() {
        validate_joint_binding(&checkpoint, index)?;
    }
    // No separately writable half, approval record, hash or version identity.
    draft.summary.revision = event.revision;
    draft.summary.page_count = checkpoint.draft.outline["outline"]["slides"]
        .as_array()
        .ok_or("slides missing")?
        .len();
    authored.checkpoint = Some(checkpoint);
    authored.events.push(event);
    Ok(())
}

pub(super) fn load_on(
    connection: &Connection,
    project: &str,
    receipt: &super::import_evidence::ImportReceipt,
) -> Result<V3ImportedDraft, String> {
    let V3WorkbenchProject::Draft(initial) = super::import::initial_projection(receipt)? else {
        return Err("authored origin must be a content revision copy".into());
    };
    let (raw, revision): (String,i64) = connection.query_row("SELECT d.draft_json,c.revision FROM v3_draft_projects d JOIN v3_catalog c USING(project_id) WHERE project_id=?1 AND c.kind='draft'", [project], |r|Ok((r.get(0)?,r.get(1)?))).map_err(message)?;
    let draft: V3ImportedDraft = decode(&raw)?;
    validate(&draft, &initial)?;
    if draft.summary.revision != revision {
        return Err("draft catalog revision mismatch".into());
    }
    Ok(draft)
}

pub(super) fn action_on(
    tx: &Connection,
    project: &str,
    revision: i64,
    action: V3DraftAction,
    at: &str,
) -> Result<V3ImportedDraft, String> {
    let V3WorkbenchProject::Draft(mut draft) = super::import_read::load_on(tx, project)? else {
        return Err("project is not an editable draft".into());
    };
    if draft.summary.revision != revision {
        return Err("draft_revision_conflict".into());
    }
    let skill = current_skill()?;
    if draft.authored.as_ref().is_some_and(|a| a.skill != skill) {
        return Err("draft requires the current bundled skill".into());
    }
    if draft.authored.is_none() {
        draft.authored = Some(V3AuthoredDraft {
            schema_version: 1,
            skill,
            events: vec![],
            checkpoint: None,
            settings: super::draft_settings::initial(&draft)?,
        });
    }
    let event = V3DraftEvent {
        revision: revision.checked_add(1).ok_or("draft revision exhausted")?,
        at: at.into(),
        action,
    };
    apply_event(&mut draft, event)?;
    let encoded = encode(&draft)?;
    if encoded.len() > LIMIT || draft.authored.as_ref().unwrap().events.len() > 1024 {
        return Err("draft evidence capacity reached".into());
    }
    if tx.execute("UPDATE v3_catalog SET revision=?1 WHERE project_id=?2 AND kind='draft' AND revision=?3", params![draft.summary.revision,project,revision]).map_err(message)? != 1 { return Err("draft_revision_conflict".into()) }
    tx.execute(
        "UPDATE v3_draft_projects SET draft_json=?1 WHERE project_id=?2",
        params![encoded, project],
    )
    .map_err(message)?;
    super::import_read::load_on(tx, project)?;
    Ok(draft)
}

pub(super) fn load_frozen_on(
    connection: &Connection,
    project: &str,
    receipt: &super::import_evidence::ImportReceipt,
    revision: i64,
) -> Result<V3ProjectSnapshot, String> {
    let (name,raw,origin,palette,created,stored_revision): (String,String,String,String,String,i64) = connection.query_row("SELECT name,frozen_json,origin_json,palette_json,created_at,revision FROM v3_projects WHERE project_id=?1",[project],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(message)?;
    let V3FrozenEvidence::Authored(evidence) = decode(&raw)? else {
        return Err("content revision cannot claim legacy native frozen evidence".into());
    };
    let V3WorkbenchProject::Draft(initial) = super::import::initial_projection(receipt)? else {
        return Err("authored origin is not draft".into());
    };
    validate(&evidence.origin, &initial)?;
    let mut snapshot = super::basis::authored_snapshot(evidence)?;
    if snapshot.summary.name != name
        || snapshot.summary.created_at != created
        || snapshot.origin != decode::<V3Origin>(&origin)?
        || snapshot.palette != decode::<crate::visual_style::VisualStyleState>(&palette)?
        || stored_revision != revision
        || revision < snapshot.summary.revision
    {
        return Err("authored frozen metadata mismatch".into());
    }
    snapshot.summary.revision = revision;
    super::store::load_pages_on(connection, project, &mut snapshot.pages, None)?;
    super::history::load_delivery(connection, &mut snapshot)?;
    Ok(snapshot)
}

impl V3WorkbenchService {
    pub fn save_draft_pair(&self, input: SaveDraftPair) -> Result<V3ImportedDraft, String> {
        let at = super::store::now()?;
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        super::store::write_on(&mut store.connection, |tx| {
            action_on(
                tx,
                &input.project_id,
                input.expected_revision,
                V3DraftAction::Save {
                    stage: input.stage,
                    envelope: input.envelope.clone(),
                },
                &at,
            )
        })
    }
    /// Explicit human action. Model completion never invokes this method.
    pub fn approve_draft_pair(
        &self,
        project: &str,
        expected_revision: i64,
        stage: V3TextStage,
    ) -> Result<V3ImportedDraft, String> {
        let at = super::store::now()?;
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        super::store::write_on(&mut store.connection, |tx| {
            action_on(
                tx,
                project,
                expected_revision,
                V3DraftAction::Approve { stage },
                &at,
            )
        })
    }
    pub fn promote_draft(
        &self,
        project: &str,
        expected_revision: i64,
    ) -> Result<V3ProjectSnapshot, String> {
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        super::store::write_on(&mut store.connection, |tx| {
            let V3WorkbenchProject::Draft(draft) = super::import_read::load_on(tx, project)? else {
                return Err("project is not a draft".into());
            };
            if draft.summary.revision != expected_revision {
                return Err("draft_revision_conflict".into());
            }
            let receipt = super::import_read::receipt_on(tx, project)?;
            let seed = ValidatedV3ProjectSeed::from_authored(draft, &receipt)?;
            let snapshot = seed.into_snapshot();
            super::store::insert_frozen_on(tx, &snapshot)?;
            tx.execute(
                "DELETE FROM v3_draft_projects WHERE project_id=?1",
                [project],
            )
            .map_err(message)?;
            if tx.execute("UPDATE v3_catalog SET kind='frozen',revision=?1 WHERE project_id=?2 AND kind='draft' AND revision=?3", params![snapshot.summary.revision,project,expected_revision]).map_err(message)? != 1 { return Err("draft_revision_conflict".into()) }
            super::store::load_on(tx, project)
        })
    }
}
