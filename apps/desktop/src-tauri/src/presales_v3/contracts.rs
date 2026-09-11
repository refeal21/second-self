use crate::presales::PresalesCheckpoint;
use crate::presales_queue::{ImageReference, VersionHash};
use crate::visual_style::VisualStyleState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3VisualBasis {
    pub hash_algorithm: String,
    pub spec: VersionHash,
    pub design: VersionHash,
    pub skill: VersionHash,
    pub palette: VersionHash,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3ProjectSummary {
    pub project_id: String,
    pub name: String,
    pub page_count: usize,
    pub revision: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3FrozenCheckpoint {
    pub pipeline: Value,
    pub presales: PresalesCheckpoint,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3ProjectSnapshot {
    pub summary: V3ProjectSummary,
    pub origin: V3Origin,
    pub frozen_checkpoint: V3FrozenCheckpoint,
    pub palette: VisualStyleState,
    pub pages: Vec<V3PageState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3Origin {
    pub source_project_id: String,
    pub source_revision: i64,
    pub hash_algorithm: String,
    pub snapshot_digest: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3PageState {
    pub slide_id: String,
    pub ordinal: usize,
    pub spec: Value,
    pub design: Option<Value>,
    pub visual_basis: Option<V3VisualBasis>,
    pub current_version_id: Option<String>,
    pub versions: Vec<V3VisualVersion>,
    pub approval: Option<V3Approval>,
    pub feedback: Option<V3FeedbackDraft>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3VisualVersion {
    pub version_id: String,
    pub sequence: i64,
    pub request_id: Option<String>,
    pub attempt_id: Option<String>,
    pub basis: Option<V3VisualBasis>,
    pub image: Option<ImageReference>,
    pub provenance: Option<V3VisualProvenance>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum V3VisualProvenance {
    Presales {
        basis: V3VisualBasis,
        request_id: String,
        attempt_id: String,
        prompt_version: String,
        parent_visual: Option<ImageReference>,
        references: Vec<ImageReference>,
    },
    LegacyImported {
        origin_digest: String,
        source_version_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3Approval {
    pub approval_id: String,
    pub version_id: String,
    pub image_sha256: String,
    pub basis: V3VisualBasis,
    pub decided_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3FeedbackDraft {
    pub base_version_id: Option<String>,
    pub revision: i64,
    pub text: String,
    pub updated_at: String,
}
