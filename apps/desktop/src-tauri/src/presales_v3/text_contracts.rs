use super::*;
use crate::presales::{PresalesApprovalBinding, SkillIdentity};
use crate::visual_style::VisualStyleState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestTextAuthoring {
    pub project_id: String,
    pub expected_revision: i64,
    pub operation_id: String,
    pub attempt_id: String,
    pub stage: V3TextStage,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum V3TextStatus {
    Queued,
    Dispatching,
    Running,
    ResultReady,
    Committing,
    CancelRequested,
    OutcomeUnknown,
    Succeeded,
    Failed,
    Cancelled,
    Abandoned,
    Conflict,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3TextAsset {
    pub asset_id: String,
    pub relative_path: String,
    pub sha256: String,
    pub byte_length: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3TextSource {
    pub original: Value,
    pub asset: V3TextAsset,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3TextTarget {
    pub schema_version: u32,
    pub project_id: String,
    pub expected_revision: i64,
    pub draft_sha256: String,
    pub stage: V3TextStage,
    pub origin: V3Origin,
    pub import_id: String,
    pub name: String,
    pub brief: String,
    pub sources: Vec<V3TextSource>,
    pub analysis: V3TextSource,
    pub context: Option<Value>,
    pub preferences: Value,
    pub palette: VisualStyleState,
    pub skill: SkillIdentity,
    pub approved_outline: Option<Value>,
    pub outline_approval: Option<PresalesApprovalBinding>,
    pub prompt_version: String,
    pub prompt: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextProviderIdentity {
    pub thread_id: String,
    pub turn_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextCompletion {
    pub operation_id: String,
    pub attempt_id: String,
    pub stage: V3TextStage,
    pub epoch: i64,
    pub target_sha256: String,
    pub provider: TextProviderIdentity,
    pub envelope: Value,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextResultEvidence {
    pub completion: TextCompletion,
    pub asset: V3TextAsset,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextCommitReceipt {
    pub operation_id: String,
    pub attempt_id: String,
    pub target_sha256: String,
    pub result_sha256: String,
    pub committed_revision: i64,
    pub at: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextCancellation {
    pub abandoned: bool,
    pub at: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3TextOperation {
    pub sequence: i64,
    pub operation_id: String,
    pub attempt_id: String,
    pub target: V3TextTarget,
    pub target_sha256: String,
    pub status: V3TextStatus,
    pub epoch: Option<i64>,
    pub provider: Option<TextProviderIdentity>,
    pub result: Option<TextResultEvidence>,
    pub commit: Option<TextCommitReceipt>,
    pub cancellation: Option<TextCancellation>,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}
