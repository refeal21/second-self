use super::*;
use crate::presales_queue::ImageReference;
use crate::visual_style::VisualStyleState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyCopyMode {
    FormatCopy,
    PresalesContentRevision,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareLegacyCopy {
    pub source_project_id: String,
    pub mode: LegacyCopyMode,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedLegacyCopySummary {
    pub preparation_id: String,
    pub source_project_id: String,
    pub source_revision: i64,
    pub kind: V3CatalogKind,
    pub destination: V3ProjectSummary,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3OriginApprovalRef {
    pub reference_id: String,
    pub import_id: String,
    pub source_project_id: String,
    pub source_revision: i64,
    pub source_slide_id: String,
    pub source_version_id: String,
    pub source_approval: Value,
    pub version_id: String,
    pub image: ImageReference,
    pub spec_hash_algorithm: String,
    pub spec_sha256: String,
    pub details_version_id: String,
    pub palette_revision: i64,
    pub palette_hash_algorithm: String,
    pub palette_sha256: String,
    pub visual_request_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3HistoryProject {
    pub summary: V3ProjectSummary,
    pub origin: V3Origin,
    pub import_id: String,
    pub palette: VisualStyleState,
    pub pages: Vec<V3PageState>,
    pub reasons: Vec<String>,
    pub delivery_snapshot: Option<V3DeliverySnapshot>,
}

/// Initial content-revision state. Original images are comparison evidence;
/// Task 3d authors a new page set without rebinding or deleting this history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V3ImportedDraft {
    pub schema_version: u32,
    pub summary: V3ProjectSummary,
    pub origin: V3Origin,
    pub import_id: String,
    pub sources: Vec<Value>,
    pub brief: String,
    pub analysis: Option<Value>,
    pub context: Option<Value>,
    pub preferences: Value,
    pub original_outline: Option<Value>,
    pub palette: VisualStyleState,
    pub comparison_pages: Vec<V3PageState>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "project",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum V3WorkbenchProject {
    Frozen(V3ProjectSnapshot),
    HistoryOnly(V3HistoryProject),
    Draft(V3ImportedDraft),
}
impl V3WorkbenchProject {
    pub fn summary(&self) -> &V3ProjectSummary {
        match self {
            Self::Frozen(p) => &p.summary,
            Self::HistoryOnly(p) => &p.summary,
            Self::Draft(p) => &p.summary,
        }
    }
    pub fn kind(&self) -> V3CatalogKind {
        match self {
            Self::Frozen(_) => V3CatalogKind::Frozen,
            Self::HistoryOnly(_) => V3CatalogKind::HistoryOnly,
            Self::Draft(_) => V3CatalogKind::Draft,
        }
    }
    pub fn pages(&self) -> &[V3PageState] {
        match self {
            Self::Frozen(p) => &p.pages,
            Self::HistoryOnly(p) => &p.pages,
            Self::Draft(_) => &[],
        }
    }
}
