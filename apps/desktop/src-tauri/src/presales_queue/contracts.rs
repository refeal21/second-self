use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionHash {
    pub version: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageReference {
    pub asset_id: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferencePurpose {
    Style,
    Layout,
    Composition,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageReferenceContext {
    pub image: ImageReference,
    pub relative_path: String,
    pub byte_length: u64,
    pub purpose: ReferencePurpose,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueTarget {
    pub project_id: String,
    pub slide_id: String,
    pub spec: VersionHash,
    pub design: VersionHash,
    pub skill: VersionHash,
    pub palette: VersionHash,
    pub parent_visual: Option<ImageReference>,
    pub references: Vec<ImageReference>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reference_context: Vec<ImageReferenceContext>,
    pub prompt_version: String,
    pub prompt: String,
    pub feedback: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnqueueJob {
    pub request_id: String,
    pub attempt_id: String,
    pub target: QueueTarget,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnqueueBatch {
    pub batch_id: String,
    pub jobs: Vec<EnqueueJob>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Dispatching,
    Running,
    ResultReady,
    Committing,
    Succeeded,
    Failed,
    CancelRequested,
    Cancelled,
    OutcomeUnknown,
    AbandonedUnresolved,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueSettings {
    pub concurrency: u8,
    pub paused: bool,
    pub epoch: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderIdentity {
    pub thread_id: String,
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedResult {
    pub relative_path: String,
    pub sha256: String,
    pub byte_length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueJob {
    pub sequence: i64,
    pub batch_id: String,
    pub request_id: String,
    pub attempt_id: String,
    pub target: QueueTarget,
    pub status: JobStatus,
    pub epoch: Option<i64>,
    pub provider: Option<ProviderIdentity>,
    pub result: Option<StagedResult>,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub dispatched_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnqueueOutcome {
    pub jobs: Vec<QueueJob>,
    pub reused_request_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueEvent {
    pub sequence: i64,
    pub request_id: String,
    pub attempt_id: String,
    pub kind: String,
    pub detail: serde_json::Value,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoverySnapshot {
    pub settings: QueueSettings,
    pub jobs: Vec<QueueJob>,
    pub unresolved_remote_count: usize,
}
