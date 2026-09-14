//! Verified native source locators and exact saved basis, not caller prompts.
use super::{
    store::{encode, message},
    *,
};
use crate::presales::{bundled_skill_metadata, native_value_hash, PresalesDraftPair};
use rusqlite::Connection;

/// The only admission constructor. Its fields cannot be supplied by WebView.
pub(super) struct CheckedTextRequest {
    target: V3TextTarget,
}
impl CheckedTextRequest {
    pub(super) fn capture(
        tx: &Connection,
        project: &str,
        revision: i64,
        stage: V3TextStage,
    ) -> Result<Self, String> {
        let V3WorkbenchProject::Draft(d) = super::import_read::load_on(tx, project)? else {
            return Err("text authoring requires draft".into());
        };
        if d.summary.revision != revision {
            return Err("draft_revision_conflict".into());
        }
        let skill = serde_json::from_value(bundled_skill_metadata()).map_err(message)?;
        let checkpoint = d.authored.as_ref().and_then(|a| a.checkpoint.as_ref());
        let settings = super::draft_settings::current(&d)?;
        if d.authored.as_ref().is_some_and(|a| a.skill != skill) {
            return Err("text authoring requires current skill".into());
        }
        let bindings = checkpoint.map_or(0, |c| c.approval_bindings.len());
        if (stage == V3TextStage::Outline && bindings != 0)
            || (stage == V3TextStage::Details && bindings != 1)
        {
            return Err("text stage is not editable".into());
        }
        if stage == V3TextStage::Details
            && (settings.palette.revision < 1 || settings.palette.profile.is_none())
        {
            return Err("details authoring requires saved palette".into());
        }
        let receipt = super::import_read::receipt_on(tx, project)?;
        let locate = |original: &serde_json::Value,
                      kind: &str,
                      path_field: &str|
         -> Result<V3TextSource, String> {
            let path = original[path_field]
                .as_str()
                .ok_or("origin asset path missing")?;
            let a = receipt
                .assets
                .iter()
                .find(|a| a.kind == kind && a.original_path == path)
                .ok_or("verified origin asset mapping missing")?;
            if original["sha256"] != a.sha256 {
                return Err("origin asset hash mismatch".into());
            }
            Ok(V3TextSource {
                original: original.clone(),
                asset: V3TextAsset {
                    asset_id: a.asset_id.clone(),
                    relative_path: a.relative_path.clone(),
                    sha256: a.sha256.clone(),
                    byte_length: a.byte_length,
                },
            })
        };
        let mut target = V3TextTarget {
            schema_version: 1,
            project_id: project.into(),
            expected_revision: revision,
            draft_sha256: native_value_hash(&serde_json::to_value(&d).map_err(message)?)?,
            stage,
            origin: d.origin.clone(),
            import_id: d.import_id.clone(),
            name: d.summary.name.clone(),
            brief: settings.brief.clone(),
            sources: d
                .sources
                .iter()
                .map(|s| locate(s, "source", "relativePath"))
                .collect::<Result<_, _>>()?,
            analysis: locate(
                d.analysis.as_ref().ok_or("verified analysis required")?,
                "analysis",
                "artifactRelativePath",
            )?,
            context: Some(serde_json::to_value(&settings.context).map_err(message)?),
            preferences: d.preferences.clone(),
            palette: settings.palette.clone(),
            skill,
            approved_outline: if stage == V3TextStage::Details {
                checkpoint.map(|c| c.draft.outline.clone())
            } else {
                None
            },
            outline_approval: if stage == V3TextStage::Details {
                checkpoint.and_then(|c| c.approval_bindings.first().cloned())
            } else {
                None
            },
            prompt_version: "presales-paired-authoring-v1".into(),
            prompt: String::new(),
        };
        target.prompt = super::text_prompt::render(&target)?;
        if encode(&target)?.len() > 4 * 1024 * 1024 {
            return Err("text target exceeds bound".into());
        }
        Ok(Self { target })
    }
    pub(super) fn target(self) -> V3TextTarget {
        self.target
    }
}

pub(super) fn validate_envelope(
    target: &V3TextTarget,
    envelope: &serde_json::Value,
) -> Result<(), String> {
    if encode(envelope)?.len() > 2 * 1024 * 1024 {
        return Err("text response exceeds 2 MiB".into());
    }
    let pair = match target.stage {
        V3TextStage::Outline => PresalesDraftPair {
            schema_version: 1,
            outline: envelope.clone(),
            details: None,
        },
        V3TextStage::Details => PresalesDraftPair {
            schema_version: 1,
            outline: target
                .approved_outline
                .clone()
                .ok_or("approved outline missing")?,
            details: Some(envelope.clone()),
        },
    };
    crate::presales::validate_pair(&pair, &target.analysis.original["output"])
}
