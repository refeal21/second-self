use super::PresalesDraftPair;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillIdentity {
    pub id: String,
    pub version: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisBasis {
    pub request_id: String,
    pub artifact_sha256: String,
    pub output_hash: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutlineBasis {
    pub version_id: String,
    pub content_hash: String,
    pub plan_hash: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetailsBasis {
    pub version_id: String,
    pub content_hash: String,
    pub design_hash: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibleBindingBasis {
    pub slide_id: String,
    pub id: String,
    pub path: String,
    pub visible_value_hash: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresalesBasis {
    pub analysis: AnalysisBasis,
    pub outline: OutlineBasis,
    pub details: Option<DetailsBasis>,
    pub bindings: Vec<VisibleBindingBasis>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresalesApprovalBinding {
    pub approval_id: String,
    pub stage: String,
    pub version_id: String,
    pub content_hash: String,
    pub companion_hash: String,
    pub skill: SkillIdentity,
    pub decided_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresalesCheckpoint {
    pub schema_version: u32,
    pub hash_algorithm: String,
    pub skill: SkillIdentity,
    pub draft: PresalesDraftPair,
    pub basis: PresalesBasis,
    pub approval_bindings: Vec<PresalesApprovalBinding>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCheckpoint {
    pub pipeline: Value,
    pub presales: Option<PresalesCheckpoint>,
}
