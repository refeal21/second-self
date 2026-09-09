//! Companion persistence: never alters the strict v1/v2 pipeline document.
use crate::{
    database::StoredProject,
    paths::write_new_workspace_artifact,
    workbench::{now_string, WorkbenchService},
};
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

const TEMPLATE_LIMIT: usize = 50 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualTemplate {
    pub file_name: String,
    pub sha256: String,
    pub relative_path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualStyleProfile {
    pub primary_color: String,
    pub background_color: String,
    pub text_color: String,
    pub accent_colors: Vec<String>,
    pub instructions: String,
    pub template: Option<VisualTemplate>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualStyleState {
    pub revision: i64,
    pub profile: Option<VisualStyleProfile>,
    pub locked: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveVisualStyleInput {
    pub project_id: String,
    pub expected_revision: i64,
    pub expected_style_revision: i64,
    pub profile: VisualStyleProfile,
    pub template_base64: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualGenerationRequest {
    pub id: String,
    pub project_id: String,
    pub expected_revision: i64,
    pub style_revision: i64,
    pub slide_id: String,
    pub kind: String,
    pub prompt: String,
    pub feedback: String,
    pub prompt_version: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualProvider {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualReceipt {
    pub relative_path: String,
    pub sha256: String,
    pub committed_revision: i64,
    pub created_at: String,
    pub provider: VisualProvider,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VisualGenerationRecord {
    #[serde(flatten)]
    pub request: VisualGenerationRequest,
    pub created_at: String,
    pub prompt_sha256: String,
    pub spec_sha256: String,
    pub style: VisualStyleState,
    pub receipt: Option<VisualReceipt>,
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn identifier(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid project, slide or request id".into());
    }
    Ok(())
}
fn validate_profile(profile: &VisualStyleProfile) -> Result<(), String> {
    for color in [
        &profile.primary_color,
        &profile.background_color,
        &profile.text_color,
    ]
    .into_iter()
    .chain(profile.accent_colors.iter())
    {
        if color.len() != 7
            || !color.starts_with('#')
            || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        {
            return Err("Style colors must use exact #RRGGBB role colors".into());
        }
    }
    if profile.accent_colors.len() > 8 || profile.instructions.chars().count() > 4000 {
        return Err("Style palette or instructions exceed limit".into());
    }
    if let Some(t) = &profile.template {
        if t.file_name.is_empty()
            || t.file_name.len() > 255
            || t.file_name.contains(['/', '\\'])
            || t.file_name.chars().any(char::is_control)
            || !t.file_name.to_ascii_lowercase().ends_with(".pptx")
            || t.sha256.len() != 64
            || !t
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || t.relative_path != format!("visuals/style-templates/{}.pptx", t.sha256)
        {
            return Err("Invalid immutable template path, hash or file name".into());
        }
    }
    Ok(())
}

/// Read through held directory descriptors, rejecting symlinks and special files.
/// The cap is enforced before allocation and again while reading a growing file.
fn read_template(workspace: &Path, relative: &Path) -> Result<Vec<u8>, String> {
    #[cfg(unix)]
    {
        use std::os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::ffi::OsStrExt,
        };
        let root = std::ffi::CString::new(workspace.as_os_str().as_bytes()).map_err(err)?;
        // SAFETY: root is nul-terminated; the returned fd is uniquely owned below.
        let fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err("Cannot open template workspace directory".into());
        }
        // SAFETY: successful open transferred a new descriptor to us.
        let mut directory = unsafe { OwnedFd::from_raw_fd(fd) };
        let components: Vec<_> = relative.components().collect();
        for (index, component) in components.iter().enumerate() {
            let std::path::Component::Normal(name) = component else {
                return Err("Invalid template path component".into());
            };
            let name = std::ffi::CString::new(name.as_bytes()).map_err(err)?;
            let final_component = index + 1 == components.len();
            let flags = libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | if final_component {
                    libc::O_NONBLOCK
                } else {
                    libc::O_DIRECTORY
                };
            // SAFETY: directory is held open and name is a single validated component.
            let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return Err(
                    "Template path must reference an existing project file without symlinks".into(),
                );
            }
            // SAFETY: successful openat returned a new descriptor owned exclusively here.
            let owned = unsafe { OwnedFd::from_raw_fd(fd) };
            if final_component {
                let file = std::fs::File::from(owned);
                let metadata = file.metadata().map_err(err)?;
                if !metadata.is_file() {
                    return Err("Template must be a regular PPTX file".into());
                }
                if metadata.len() > TEMPLATE_LIMIT as u64 {
                    return Err("Template exceeds 50 MiB limit".into());
                }
                let mut bytes = Vec::new();
                file.take(TEMPLATE_LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(err)?;
                return Ok(bytes);
            }
            directory = owned;
        }
        Err("Missing template file".into())
    }
    #[cfg(not(unix))]
    {
        let _ = (workspace, relative);
        Err("Template file reuse requires fd-relative filesystem support".into())
    }
}
pub(crate) fn has_visual_approval(pipeline: &Value) -> bool {
    pipeline["approvals"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|a| a["stage"] == "visual_review" && a["status"] == "approved")
    }) || pipeline["visuals"].as_object().is_some_and(|slides| {
        slides.values().any(|v| {
            v.as_array()
                .is_some_and(|items| items.iter().any(|v| v["version"]["status"] == "frozen"))
        })
    })
}
pub(crate) fn load_style(
    connection: &Connection,
    project: &StoredProject,
) -> Result<VisualStyleState, String> {
    let latest: Option<(i64,String)> = connection.query_row("SELECT revision, profile_json FROM visual_style_versions WHERE project_id=?1 ORDER BY revision DESC LIMIT 1", [&project.id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
    let locked: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM visual_style_locks WHERE project_id=?1)",
            [&project.id],
            |r| r.get(0),
        )
        .map_err(err)?;
    let historical: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM approvals WHERE project_id=?1 AND stage='visual_review' AND status='approved')
         OR EXISTS(SELECT 1 FROM checkpoints c WHERE c.project_id=?1 AND (
             EXISTS(SELECT 1 FROM json_each(c.slide_statuses_json) WHERE value='approved')
             OR EXISTS(SELECT 1 FROM json_each(c.pipeline_json,'$.approvals') a WHERE json_extract(a.value,'$.stage')='visual_review' AND json_extract(a.value,'$.status')='approved')))",
        [&project.id], |r| r.get(0)).map_err(err)?;
    let (revision, profile) = match latest {
        Some((r, p)) => (r, Some(serde_json::from_str(&p).map_err(err)?)),
        None => (0, None),
    };
    Ok(VisualStyleState {
        revision,
        profile,
        locked: locked
            || historical
            || has_visual_approval(&project.pipeline)
            || project.slide_statuses.iter().any(|s| s == "approved"),
    })
}
pub(crate) fn lock_style(connection: &Connection, id: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR IGNORE INTO visual_style_locks(project_id,created_at) VALUES (?1,?2)",
            params![id, now_string()],
        )
        .map_err(err)?;
    Ok(())
}
fn check_revision(project: &StoredProject, expected: i64) -> Result<(), String> {
    if expected < 1 || project.pipeline["revision"].as_i64() != Some(expected) {
        return Err("stale pipeline revision".into());
    }
    Ok(())
}

#[derive(Default)]
pub struct VisualCommitContext<'a> {
    pub request_id: Option<&'a str>,
    pub provider: Option<&'a VisualProvider>,
    pub expected_style_revision: Option<i64>,
}
/// Native v1/v2 checkpoints always map slide IDs to nonempty visual-history
/// arrays. Validate this at the command boundary, even without a saved style or
/// artifact writes, so malformed values cannot disappear from approval checks.
pub(crate) fn validate_native_visual_shape(pipeline: &Value) -> Result<(), String> {
    let slides = pipeline["visuals"]
        .as_object()
        .ok_or("Native visuals must be a slide-to-history object")?;
    for history in slides.values() {
        let history = history
            .as_array()
            .filter(|history| !history.is_empty())
            .ok_or("Native visual histories must be nonempty arrays")?;
        for visual in history {
            if !visual.is_object() || !visual["version"].is_object() {
                return Err(
                    "Native visual history entries must be objects with a version object".into(),
                );
            }
        }
    }
    Ok(())
}

// Generic persisted projects may contain the older single-object shape. Keep
// those entries visible to the shared guards; new native inputs are checked
// above and cannot introduce this legacy representation.
fn candidates(pipeline: &Value) -> Vec<&Value> {
    pipeline["visuals"]
        .as_object()
        .map(|slides| {
            slides
                .values()
                .flat_map(|v| match v {
                    Value::Array(history) => history.as_slice(),
                    Value::Object(_) => std::slice::from_ref(v),
                    _ => &[],
                })
                .collect()
        })
        .unwrap_or_default()
}
pub(crate) fn validate_visual_writes(
    pipeline: &Value,
    writes: &[crate::workbench::ArtifactWriteInput],
) -> Result<(), String> {
    validate_native_visual_shape(pipeline)?;
    for write in writes
        .iter()
        .filter(|w| w.kind == "approved-visual-candidate")
    {
        let candidate = candidates(pipeline)
            .into_iter()
            .find(|v| {
                v["relativePath"] == write.relative_path && v["version"]["id"] == write.version_id
            })
            .ok_or("Visual artifact does not match a candidate")?;
        if candidate["sha256"] != write.sha256
            || candidate["byteLength"].as_u64() != Some(write.byte_length as u64)
            || candidate["slideId"].as_str() != write.slide_id.as_deref()
        {
            return Err("Visual candidate SHA-256, size or slide does not match its write".into());
        }
    }
    Ok(())
}
/// Runs on the same SQLite transaction as the checkpoint, projections and artifact writes.
pub(crate) fn guard_visual_commit(
    connection: &Connection,
    project: &StoredProject,
    next: &Value,
    artifacts: &[crate::database::PersistedArtifact],
    context: VisualCommitContext<'_>,
) -> Result<(), String> {
    let style = load_style(connection, project)?;
    if context
        .expected_style_revision
        .is_some_and(|r| r != style.revision)
    {
        return Err("stale style revision".into());
    }
    let old = candidates(&project.pipeline);
    let upcoming = candidates(next);
    let changed: Vec<_> = upcoming
        .iter()
        .copied()
        .filter(|v| {
            v["relativePath"].as_str().is_some_and(|p| !p.is_empty())
                && !old.iter().any(|o| {
                    o["version"]["id"] == v["version"]["id"]
                        && o["relativePath"] == v["relativePath"]
                        && o["sha256"] == v["sha256"]
                })
        })
        .collect();
    let mut all_records = records(connection, &project.id)?;
    if style.profile.is_some() && !changed.is_empty() && context.request_id.is_none() {
        return Err("New styled visual candidates require a saved generation request".into());
    }
    if let Some(request_id) = context.request_id {
        identifier(request_id)?;
        if changed.len() != 1 {
            return Err("A visual request must commit exactly one new candidate".into());
        }
        let record = all_records
            .iter_mut()
            .find(|r| r.request.id == request_id)
            .ok_or("Unknown visual request for this project")?;
        if record.receipt.is_some() {
            return Err("Visual request already has a committed receipt".into());
        }
        check_revision(project, record.request.expected_revision)?;
        if record.request.style_revision != style.revision || record.style.profile != style.profile
        {
            return Err("stale style revision for visual completion".into());
        }
        let v = changed[0];
        if v["slideId"] != record.request.slide_id
            || v["version"]["projectId"] != project.id
            || v["version"]["status"] != "draft"
        {
            return Err("Visual candidate does not match requested slide or draft status".into());
        }
        let spec = approved_spec(&project.pipeline, &record.request.slide_id)?;
        if record.spec_sha256 != hash(&serde_json::to_vec(&spec).map_err(err)?)
            || approved_spec(next, &record.request.slide_id)? != spec
        {
            return Err("Visual request approved spec mismatch".into());
        }
        let path = v["relativePath"].as_str().ok_or("Missing visual path")?;
        let sha = v["sha256"].as_str().ok_or("Missing visual SHA-256")?;
        if !artifacts.iter().any(|a| {
            a.path == path
                && a.kind == "approved-visual-candidate"
                && v["version"]["id"] == a.version_id
        }) {
            return Err("Visual receipt requires a matching artifact write".into());
        }
        let provider = context.provider.cloned().unwrap_or_default();
        if [&provider.thread_id, &provider.turn_id, &provider.item_id]
            .into_iter()
            .flatten()
            .any(|s| s.is_empty() || s.len() > 256 || s.chars().any(char::is_control))
        {
            return Err("Invalid visual provider identifier".into());
        }
        if record.request.kind == "upload" && provider != VisualProvider::default() {
            return Err("Uploaded visual cannot claim image provider provenance".into());
        }
        record.receipt = Some(VisualReceipt {
            relative_path: path.into(),
            sha256: sha.into(),
            committed_revision: next["revision"].as_i64().ok_or("Missing revision")?,
            created_at: now_string(),
            provider,
        });
        connection
            .execute(
                "UPDATE visual_generation_records SET record_json=?2 WHERE id=?1 AND project_id=?3",
                params![
                    request_id,
                    serde_json::to_string(record).map_err(err)?,
                    project.id
                ],
            )
            .map_err(err)?;
    }
    for v in &upcoming {
        let newly_approved = v["version"]["status"] == "frozen"
            && !old.iter().any(|o| {
                o["version"]["id"] == v["version"]["id"]
                    && o["version"]["status"] == "frozen"
                    && o["relativePath"] == v["relativePath"]
                    && o["sha256"] == v["sha256"]
            });
        if newly_approved && style.profile.is_some() {
            let spec = approved_spec(next, v["slideId"].as_str().ok_or("Missing visual slide")?)?;
            let spec_hash = hash(&serde_json::to_vec(&spec).map_err(err)?);
            if !all_records.iter().any(|r| {
                r.request.style_revision == style.revision
                    && r.style.profile == style.profile
                    && r.spec_sha256 == spec_hash
                    && r.request.slide_id == v["slideId"].as_str().unwrap_or("")
                    && r.receipt.as_ref().is_some_and(|receipt| {
                        v["relativePath"] == receipt.relative_path && v["sha256"] == receipt.sha256
                    })
            }) {
                return Err("Visual approval requires a candidate matching the current style and approved spec; historical provenance is missing or stale".into());
            }
        }
    }
    if style.profile.is_some() {
        // Legacy approval records must not bypass the candidate-level guard.
        let old_approvals = project.pipeline["approvals"].as_array();
        for a in next["approvals"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["stage"] == "visual_review" && a["status"] == "approved")
        {
            if !old_approvals.is_some_and(|items| items.contains(a))
                && !upcoming.iter().any(|v| {
                    v["version"]["id"] == a["versionId"] && v["version"]["status"] == "frozen"
                })
            {
                return Err("Style approval requires a frozen visual candidate".into());
            }
        }
    }
    if style.locked || has_visual_approval(next) {
        lock_style(connection, &project.id)?;
    }
    Ok(())
}
fn approved_spec(pipeline: &Value, slide_id: &str) -> Result<Value, String> {
    if pipeline["slideSpecs"]["version"]["status"] != "frozen"
        || !pipeline["outlineRevisionDraft"].is_null()
    {
        return Err("Visual generation requires approved slide specs".into());
    }
    pipeline["slideSpecs"]["value"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["id"] == slide_id))
        .cloned()
        .ok_or_else(|| "Unknown approved slide".into())
}
pub(crate) fn records(
    connection: &Connection,
    id: &str,
) -> Result<Vec<VisualGenerationRecord>, String> {
    let mut stmt = connection
        .prepare(
            "SELECT record_json FROM visual_generation_records WHERE project_id=?1 ORDER BY rowid",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(err)?;
    rows.map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
        .collect()
}
impl WorkbenchService {
    pub fn load_visual_style(&self, id: &str) -> Result<VisualStyleState, String> {
        identifier(id)?;
        let db = self.database()?;
        let p = db.get_project(id).map_err(err)?.ok_or("Unknown project")?;
        load_style(&db.connection, &p)
    }
    pub fn save_visual_style(
        &self,
        input: SaveVisualStyleInput,
    ) -> Result<VisualStyleState, String> {
        identifier(&input.project_id)?;
        validate_profile(&input.profile)?;
        let workspace = self.workspace()?;
        let db = self.database()?;
        // Reserve the SQLite writer before creating an immutable asset. Another app
        // instance cannot commit a reused file while this transaction rolls it back.
        let tx = rusqlite::Transaction::new_unchecked(
            &db.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(err)?;
        let p = db
            .get_project(&input.project_id)
            .map_err(err)?
            .ok_or("Unknown project")?;
        check_revision(&p, input.expected_revision)?;
        let state = load_style(&tx, &p)?;
        if state.locked {
            return Err("Project visual style is permanently locked after visual approval".into());
        }
        if state.revision != input.expected_style_revision {
            return Err("stale style revision".into());
        }
        let mut asset = None;
        if let Some(t) = &input.profile.template {
            let relative = Path::new(&input.project_id).join(&t.relative_path);
            let bytes = if let Some(encoded) = &input.template_base64 {
                if encoded.len() > (TEMPLATE_LIMIT + 2) / 3 * 4 {
                    return Err("Template exceeds 50 MiB limit".into());
                }
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(err)?
            } else {
                read_template(&workspace, &relative)?
            };
            if bytes.len() > TEMPLATE_LIMIT
                || !bytes.starts_with(b"PK\x03\x04")
                || hash(&bytes) != t.sha256
            {
                return Err("Template size, PPTX signature or SHA-256 mismatch".into());
            }
            asset = Some(write_new_workspace_artifact(&workspace, &relative, &bytes)?);
        } else if input.template_base64.is_some() {
            return Err("Template bytes require a template profile".into());
        }
        tx.execute("INSERT INTO visual_style_versions(project_id,revision,profile_json,created_at) VALUES (?1,?2,?3,?4)", params![input.project_id,state.revision+1,serde_json::to_string(&input.profile).map_err(err)?,now_string()]).map_err(err)?;
        tx.commit().map_err(err)?;
        if let Some(asset) = asset {
            asset.commit();
        }
        Ok(VisualStyleState {
            revision: state.revision + 1,
            profile: Some(input.profile),
            locked: false,
        })
    }
    pub fn begin_visual_request(
        &self,
        input: VisualGenerationRequest,
    ) -> Result<VisualGenerationRecord, String> {
        identifier(&input.id)?;
        identifier(&input.project_id)?;
        identifier(&input.slide_id)?;
        if !["imagegen", "upload"].contains(&input.kind.as_str())
            || (input.kind == "imagegen" && input.prompt.trim().is_empty())
            || input.prompt.len() > 196608
            || input.feedback.len() > 16384
            || input.prompt_version.is_empty()
            || input.prompt_version.len() > 128
        {
            return Err("Invalid or oversized visual generation request".into());
        }
        let db = self.database()?;
        let tx = db.connection.unchecked_transaction().map_err(err)?;
        let p = db
            .get_project(&input.project_id)
            .map_err(err)?
            .ok_or("Unknown project")?;
        check_revision(&p, input.expected_revision)?;
        let style = load_style(&tx, &p)?;
        if style.revision != input.style_revision {
            return Err("stale style revision".into());
        }
        let spec = approved_spec(&p.pipeline, &input.slide_id)?;
        let record = VisualGenerationRecord {
            prompt_sha256: hash(input.prompt.as_bytes()),
            spec_sha256: hash(&serde_json::to_vec(&spec).map_err(err)?),
            request: input,
            created_at: now_string(),
            style,
            receipt: None,
        };
        tx.execute(
            "INSERT INTO visual_generation_records(id,project_id,record_json) VALUES (?1,?2,?3)",
            params![
                record.request.id,
                record.request.project_id,
                serde_json::to_string(&record).map_err(err)?
            ],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(record)
    }
    pub fn visual_records(&self, id: &str) -> Result<Vec<VisualGenerationRecord>, String> {
        identifier(id)?;
        let db = self.database()?;
        db.get_project(id).map_err(err)?.ok_or("Unknown project")?;
        records(&db.connection, id)
    }
}
