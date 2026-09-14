use super::*;
use crate::presales::{PresalesCheckpoint, SkillIdentity};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum V3TextStage {
    Outline,
    Details,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDraftPair {
    pub project_id: String,
    pub expected_revision: i64,
    pub stage: V3TextStage,
    pub envelope: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum V3DraftAction {
    Save {
        stage: V3TextStage,
        envelope: Value,
    },
    Approve {
        stage: V3TextStage,
    },
    Settings {
        brief: String,
        context: DraftPromptContext,
        manual_palette: Option<crate::visual_style::VisualStyleProfile>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3DraftEvent {
    pub revision: i64,
    pub at: String,
    pub action: V3DraftAction,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3AuthoredDraft {
    pub schema_version: u32,
    pub skill: SkillIdentity,
    pub events: Vec<V3DraftEvent>,
    pub checkpoint: Option<PresalesCheckpoint>,
    pub settings: V3DraftSettings,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftPromptContext {
    pub task_brief: String,
    pub source_instructions: std::collections::BTreeMap<String, String>,
    pub outline_requirements: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftPaletteOrigin {
    Imported,
    Manual,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3DraftSettings {
    pub brief: String,
    pub context: DraftPromptContext,
    pub palette: crate::visual_style::VisualStyleState,
    pub palette_origin: DraftPaletteOrigin,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDraftSettings {
    pub project_id: String,
    pub expected_revision: i64,
    pub brief: String,
    pub context: DraftPromptContext,
    pub manual_palette: Option<crate::visual_style::VisualStyleProfile>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum V3AuthoredKind {
    AuthoredV3,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3AuthoredFrozen {
    pub kind: V3AuthoredKind,
    pub origin: V3ImportedDraft,
    pub promoted_revision: i64,
}

/// The legacy shape stays readable verbatim. The authored shape has an explicit
/// discriminator and contains no destination-shaped legacy pipeline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum V3FrozenEvidence {
    Native(V3FrozenCheckpoint),
    Authored(V3AuthoredFrozen),
}
