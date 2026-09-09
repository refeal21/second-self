use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    database::{
        Database, NewMemoryProposal, NewProject, PersistedArtifact, PersistenceCounts,
        ProjectMutation, StoredProject,
    },
    paths::{
        atomic_write_workspace_file, create_workspace_project_tree, write_new_workspace_artifact,
    },
};

const ARTIFACT_DIRECTORIES: [&str; 7] = [
    "sources",
    "outline",
    "slide-specs",
    "visuals",
    "exports",
    "qa",
    "history",
];

static ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub struct WorkbenchService {
    database: Mutex<Database>,
    workspace_root: Mutex<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    pub goal: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideMutationInput {
    pub project_id: String,
    pub slide: i64,
    pub comment: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachSourceInput {
    pub project_id: String,
    pub file_name: String,
    pub media_type: String,
    pub contents_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactWriteInput {
    pub relative_path: String,
    pub contents_base64: String,
    pub sha256: String,
    pub byte_length: usize,
    pub kind: String,
    pub version_id: String,
    pub slide_id: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineCommitInput {
    pub project_id: String,
    pub expected_revision: i64,
    pub pipeline: Value,
    pub writes: Vec<ArtifactWriteInput>,
    pub visual_request_id: Option<String>,
    pub visual_provider: Option<crate::visual_style::VisualProvider>,
    pub expected_style_revision: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideSummary {
    pub page: i64,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub stage: String,
    pub workflow_status: String,
    pub progress: i64,
    pub selected_slide: i64,
    pub slides: Vec<SlideSummary>,
    pub export_ready: bool,
    pub slide_notice: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AccountSummary {
    pub email: Option<String>,
    pub plan: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RuntimeSummary {
    pub status: String,
    pub detail: String,
    pub model: Option<String>,
    pub address: Option<String>,
    pub uptime: Option<String>,
    pub queue: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CollectionSummary {
    pub projects: String,
    pub approvals: String,
    pub memories: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSummary {
    pub workspace_path: String,
    pub codex_path: String,
    pub pdf_renderer_path: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ApprovalSummary {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub author: String,
    pub time: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct MemorySummary {
    pub id: String,
    pub title: String,
    pub content: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DesktopInitialState {
    pub account: AccountSummary,
    pub projects: Vec<ProjectSummary>,
    pub approvals: Vec<ApprovalSummary>,
    pub memories: Vec<MemorySummary>,
    pub runtime: RuntimeSummary,
    pub collections: CollectionSummary,
    pub settings: SettingsSummary,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegenerateResult {
    pub status: String,
    pub selected_slide: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResult {
    pub status: String,
    pub next_slide: i64,
    pub stage: Option<String>,
    pub export_ready: Option<bool>,
}

impl WorkbenchService {
    pub fn open(
        database_path: impl AsRef<Path>,
        default_workspace: impl AsRef<Path>,
    ) -> Result<Self, String> {
        if let Some(parent) = database_path.as_ref().parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("App data directory cannot be created: {error}"))?;
        }
        let requested_workspace = default_workspace.as_ref();
        fs::create_dir_all(requested_workspace)
            .map_err(|error| format!("Workspace cannot be created: {error}"))?;
        let workspace_root = fs::canonicalize(requested_workspace)
            .map_err(|error| format!("Workspace cannot be resolved: {error}"))?;
        let database = Database::open(database_path)
            .map_err(|error| format!("Local database cannot be opened: {error}"))?;
        if database
            .setting("workspace_path")
            .map_err(database_error)?
            .is_none()
        {
            database
                .save_setting("workspace_path", &workspace_root.to_string_lossy())
                .map_err(database_error)?;
        }
        for key in ["codex_path", "pdf_renderer_path"] {
            if database.setting(key).map_err(database_error)?.is_none() {
                database.save_setting(key, "").map_err(database_error)?;
            }
        }
        let stored_workspace = database
            .setting("workspace_path")
            .map_err(database_error)?
            .map(PathBuf::from)
            .unwrap_or(workspace_root);
        fs::create_dir_all(&stored_workspace)
            .map_err(|error| format!("Stored workspace cannot be created: {error}"))?;
        let stored_workspace = fs::canonicalize(stored_workspace)
            .map_err(|error| format!("Stored workspace cannot be resolved: {error}"))?;
        Ok(Self {
            database: Mutex::new(database),
            workspace_root: Mutex::new(stored_workspace),
        })
    }

    pub fn initial_state(&self) -> Result<DesktopInitialState, String> {
        let database = self.database()?;
        let projects = database
            .list_projects()
            .map_err(database_error)?
            .into_iter()
            .map(project_summary)
            .collect();
        let approvals = database
            .list_pending_approvals()
            .map_err(database_error)?
            .into_iter()
            .map(|approval| ApprovalSummary {
                id: approval.id,
                title: approval.title,
                detail: approval.detail,
                author: approval.author,
                time: approval.created_at,
            })
            .collect();
        let memories = database
            .list_memory_proposals()
            .map_err(database_error)?
            .into_iter()
            .map(|memory| MemorySummary {
                id: memory.id,
                title: memory.title,
                content: memory.content,
                status: memory_status(&memory.status).into(),
            })
            .collect();
        let workspace_path = database
            .setting("workspace_path")
            .map_err(database_error)?
            .unwrap_or_default();
        let codex_path = database
            .setting("codex_path")
            .map_err(database_error)?
            .unwrap_or_default();
        let pdf_renderer_path = database
            .setting("pdf_renderer_path")
            .map_err(database_error)?
            .unwrap_or_default();
        Ok(DesktopInitialState {
            account: AccountSummary {
                email: None,
                plan: None,
                status: "unavailable".into(),
            },
            projects,
            approvals,
            memories,
            runtime: RuntimeSummary {
                status: "unavailable".into(),
                detail: "等待连接本机 Codex App Server".into(),
                model: None,
                address: None,
                uptime: None,
                queue: None,
            },
            collections: CollectionSummary {
                projects: "loaded".into(),
                approvals: "loaded".into(),
                memories: "loaded".into(),
            },
            settings: SettingsSummary {
                workspace_path,
                codex_path,
                pdf_renderer_path,
            },
        })
    }

    pub fn create_project(&self, input: CreateProjectInput) -> Result<ProjectSummary, String> {
        let name = non_empty(input.name, "Project name")?;
        let goal = non_empty(input.goal, "Project goal")?;
        let id = next_identifier("project");
        let now = now_string();
        let workspace = self.workspace()?;
        let project_root = create_workspace_project_tree(&workspace, &id, &ARTIFACT_DIRECTORIES)?;
        let database = self.database()?;
        if let Err(error) = database.insert_project(&NewProject {
            id: id.clone(),
            name,
            goal,
            created_at: now,
        }) {
            let _ = fs::remove_dir_all(&project_root);
            return Err(database_error(error));
        }
        let stored = database
            .get_project(&id)
            .map_err(database_error)?
            .ok_or_else(|| "Created project could not be reloaded".to_string())?;
        Ok(project_summary(stored))
    }

    pub fn load_pipeline(&self, project_id: &str) -> Result<Value, String> {
        self.database()?
            .get_project(project_id)
            .map_err(database_error)?
            .map(|project| project.pipeline)
            .ok_or_else(|| "Unknown project".to_string())
    }

    pub fn project_directory(&self, project_id: &str) -> Result<String, String> {
        self.load_pipeline(project_id)?;
        let path = self.workspace()?.join(project_id);
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("Project directory cannot be resolved: {error}"))?;
        if !canonical.starts_with(self.workspace()?) {
            return Err("Project directory is outside the workspace".into());
        }
        Ok(canonical.to_string_lossy().into_owned())
    }

    pub fn workspace_directory(&self) -> Result<String, String> {
        let workspace = self.workspace()?;
        let canonical = fs::canonicalize(&workspace)
            .map_err(|error| format!("Workspace cannot be resolved: {error}"))?;
        if !canonical.is_dir() || canonical != workspace {
            return Err("Configured workspace is not a canonical directory".into());
        }
        Ok(canonical.to_string_lossy().into_owned())
    }

    pub fn read_artifact(&self, project_id: &str, relative_path: &str) -> Result<String, String> {
        use base64::Engine;
        let bytes = self.read_artifact_bytes(project_id, relative_path)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn prepare_qa(&self, project_id: &str) -> Result<Value, String> {
        let pipeline = self.load_pipeline(project_id)?;
        let workflow_status = pipeline
            .pointer("/project/workflowStatus")
            .and_then(Value::as_str);
        let retrying_qa = workflow_status == Some("blocked")
            && pipeline
                .pointer("/blockedCondition/resumeStage")
                .and_then(Value::as_str)
                == Some("qa");
        if workflow_status != Some("qa") && !retrying_qa {
            return Err("Project is not at the QA checkpoint".into());
        }
        let soffice_candidates = soffice_candidates();
        let Some(soffice) =
            find_soffice_with_candidates(&soffice_candidates, env::var_os("PATH").as_deref())
        else {
            return Ok(serde_json::json!({
                "status": "blocked",
                "capability": "libreoffice",
                "issue": "LibreOffice soffice executable is unavailable. Install LibreOffice and retry QA; the app checked its bundle, /Applications, Homebrew locations, the Codex bundled runtime, and PATH."
            }));
        };
        let configured_renderer = self
            .database()?
            .setting("pdf_renderer_path")
            .map_err(database_error)?
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let candidates = pdf_renderer_candidates();
        let Some(renderer) = find_pdf_renderer_with_candidates(
            configured_renderer.as_deref(),
            &candidates,
            env::var_os("PATH").as_deref(),
        ) else {
            return Ok(serde_json::json!({
                "status": "blocked",
                "capability": "pdf-renderer",
                "issue": "PDF renderer pdftoppm is unavailable. Install Poppler or set an executable absolute pdftoppm path in Settings; the app also checked its bundle, /opt/homebrew/bin, /usr/local/bin, and the Codex bundled runtime."
            }));
        };
        self.prepare_qa_with_tools(project_id, &pipeline, &soffice, &renderer)
    }

    fn prepare_qa_with_tools(
        &self,
        project_id: &str,
        pipeline: &Value,
        soffice: &Path,
        renderer: &Path,
    ) -> Result<Value, String> {
        use base64::Engine;
        let receipt = pipeline
            .get("exportReceipt")
            .and_then(Value::as_object)
            .ok_or_else(|| "QA checkpoint has no committed export receipt".to_string())?;
        let export_path = receipt
            .get("relativePath")
            .and_then(Value::as_str)
            .ok_or_else(|| "Export receipt path is invalid".to_string())?;
        let pptx = self.read_artifact_bytes(project_id, export_path)?;
        let expected_hash = receipt
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| "Export receipt hash is invalid".to_string())?;
        if sha256(&pptx) != expected_hash {
            return Err("Persisted PPTX does not match its export receipt".into());
        }
        let specs = pipeline
            .pointer("/slideSpecs/value")
            .and_then(Value::as_array)
            .ok_or_else(|| "QA checkpoint has no approved slide specs".to_string())?;
        let mut approved_visuals = Vec::with_capacity(specs.len());
        for spec in specs {
            let slide_id = spec
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Approved slide spec id is invalid".to_string())?;
            let visual = pipeline
                .get("visuals")
                .and_then(|value| value.get(slide_id))
                .and_then(Value::as_array)
                .and_then(|versions| versions.last())
                .ok_or_else(|| format!("Approved visual is missing for {slide_id}"))?;
            if visual.pointer("/version/status").and_then(Value::as_str) != Some("frozen") {
                return Err(format!("Current visual is not approved for {slide_id}"));
            }
            let relative_path = visual
                .get("relativePath")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Approved visual path is invalid for {slide_id}"))?;
            let contents = self.read_artifact_bytes(project_id, relative_path)?;
            let expected_visual_hash = visual
                .get("sha256")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Approved visual hash is invalid for {slide_id}"))?;
            if sha256(&contents) != expected_visual_hash {
                return Err(format!(
                    "Persisted visual does not match its hash for {slide_id}"
                ));
            }
            approved_visuals.push(serde_json::json!({
                "slideId": slide_id,
                "relativePath": relative_path,
                "contentsBase64": base64::engine::general_purpose::STANDARD.encode(contents),
            }));
        }

        const MAX_PPTX_BYTES: usize = 64 * 1024 * 1024;
        const MAX_VISUAL_BYTES: usize = 32 * 1024 * 1024;
        const MAX_PDF_BYTES: usize = 128 * 1024 * 1024;
        const MAX_PAGE_BYTES: usize = 32 * 1024 * 1024;
        if pptx.len() > MAX_PPTX_BYTES {
            return Err("QA PPTX exceeds the 64 MiB preparation limit".into());
        }
        if approved_visuals.iter().any(|visual| {
            visual
                .get("contentsBase64")
                .and_then(Value::as_str)
                .is_some_and(|value| value.len() > MAX_VISUAL_BYTES * 2)
        }) {
            return Err("An approved visual exceeds the QA preparation limit".into());
        }

        let temp = QaTempDirectory::create()?;
        let fontconfig = create_qa_fontconfig(&temp.path)?;
        let input_path = temp.path.join("input.pptx");
        fs::write(&input_path, &pptx)
            .map_err(|error| format!("QA temporary PPTX cannot be written: {error}"))?;
        let profile = temp.path.join("profile");
        fs::create_dir(&profile)
            .map_err(|error| format!("QA LibreOffice profile cannot be created: {error}"))?;
        let command_temp = temp.path.join("temp");
        fs::create_dir(&command_temp)
            .map_err(|error| format!("QA process temp directory cannot be created: {error}"))?;
        let profile_uri = format!("file://{}", profile.to_string_lossy());
        let mut conversion_command = Command::new(soffice);
        conversion_command
            .arg(format!("-env:UserInstallation={profile_uri}"))
            .args(["--headless", "--convert-to", "pdf", "--outdir"])
            .arg(&temp.path)
            .arg(&input_path)
            .current_dir(&temp.path);
        apply_qa_environment(&mut conversion_command, &command_temp, &fontconfig);
        let conversion = run_bounded_command(conversion_command, Duration::from_secs(30), 16_384)
            .map_err(|error| format!("LibreOffice QA cannot start: {error}"))?;
        if conversion.timed_out || !conversion.status.success() {
            return Ok(qa_preparation_failure(
                "LibreOffice conversion",
                &conversion,
            ));
        }
        let pdf_path = temp.path.join("input.pdf");
        if !pdf_path.is_file() {
            return Ok(serde_json::json!({
                "status": "failed",
                "capability": "qa-rendering",
                "issue": "LibreOffice reported success but did not create a PDF."
            }));
        }
        let render_prefix = temp.path.join("rendered");
        let mut render_command = Command::new(renderer);
        render_command
            .args(["-png", "-r", "144"])
            .arg(&pdf_path)
            .arg(&render_prefix)
            .current_dir(&temp.path);
        apply_qa_environment(&mut render_command, &command_temp, &fontconfig);
        let rendering = run_bounded_command(render_command, Duration::from_secs(30), 16_384)
            .map_err(|error| format!("PDF renderer cannot start: {error}"))?;
        if rendering.timed_out || !rendering.status.success() {
            return Ok(qa_preparation_failure("PDF rendering", &rendering));
        }
        let mut page_paths = fs::read_dir(&temp.path)
            .map_err(|error| format!("QA render directory cannot be listed: {error}"))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("rendered-") && name.ends_with(".png"))
            })
            .collect::<Vec<_>>();
        page_paths.sort_by_key(|path| rendered_page_number(path).unwrap_or(usize::MAX));
        let rendered_pages = page_paths
            .into_iter()
            .map(|path| {
                let file_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| "Rendered page file name is invalid".to_string())?;
                let contents = read_bounded_file(&path, MAX_PAGE_BYTES, "Rendered page")?;
                Ok(serde_json::json!({
                    "fileName": file_name,
                    "contentsBase64": base64::engine::general_purpose::STANDARD.encode(contents),
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let pdf = read_bounded_file(&pdf_path, MAX_PDF_BYTES, "Rendered QA PDF")?;
        let hiragino_available = fontconfig.is_file() && system_chinese_font().is_some();
        Ok(serde_json::json!({
            "status": "ready",
            "sofficePath": soffice.to_string_lossy(),
            "rendererPath": renderer.to_string_lossy(),
            "pptxBase64": base64::engine::general_purpose::STANDARD.encode(pptx),
            "pdfBase64": base64::engine::general_purpose::STANDARD.encode(pdf),
            "renderedPages": rendered_pages,
            "approvedVisuals": approved_visuals,
            "fontAvailability": {
                "Hiragino Sans GB": hiragino_available,
            }
        }))
    }

    fn read_artifact_bytes(
        &self,
        project_id: &str,
        relative_path: &str,
    ) -> Result<Vec<u8>, String> {
        validate_worker_relative_path(relative_path)?;
        let workspace = self.workspace()?;
        let project = fs::canonicalize(workspace.join(project_id))
            .map_err(|error| format!("Project directory cannot be resolved: {error}"))?;
        if !project.starts_with(&workspace) {
            return Err("Project directory is outside the workspace".into());
        }
        let path = fs::canonicalize(project.join(relative_path))
            .map_err(|error| format!("Artifact cannot be resolved: {error}"))?;
        if !path.starts_with(&project) {
            return Err("Artifact is outside the project".into());
        }
        fs::read(path).map_err(|error| format!("Artifact cannot be read: {error}"))
    }

    pub fn attach_source(&self, input: AttachSourceInput) -> Result<Value, String> {
        let file_name = non_empty(input.file_name, "Source file name")?;
        if Path::new(&file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(&file_name)
        {
            return Err("Source file name must not contain a path".into());
        }
        let media_type = non_empty(input.media_type, "Source media type")?;
        let bytes = decode_base64(&input.contents_base64)?;
        let database = self.database()?;
        let mut pipeline = database
            .get_project(&input.project_id)
            .map_err(database_error)?
            .map(|project| project.pipeline)
            .ok_or_else(|| "Unknown project".to_string())?;
        if pipeline
            .pointer("/project/workflowStatus")
            .and_then(Value::as_str)
            != Some("intake")
        {
            return Err("Sources can only be attached during intake".into());
        }
        let expected_revision = pipeline
            .get("revision")
            .and_then(Value::as_i64)
            .ok_or_else(|| "Persisted pipeline revision is invalid".to_string())?;
        let source_id = next_identifier("source");
        let relative_path = format!("sources/{source_id}.bin");
        let sha256 = sha256(&bytes);
        atomic_write_workspace_file(
            &self.workspace()?,
            Path::new(&input.project_id).join(&relative_path).as_path(),
            &bytes,
        )?;
        let sources = pipeline
            .get_mut("sources")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "Persisted pipeline sources are invalid".to_string())?;
        sources.push(serde_json::json!({
            "id": source_id, "fileName": file_name, "mediaType": media_type,
            "relativePath": relative_path, "sha256": sha256, "byteLength": bytes.len(),
        }));
        pipeline["revision"] = (expected_revision + 1).into();
        pipeline["project"]["updatedAt"] = now_string().into();
        let artifact = PersistedArtifact {
            id: format!("{}-artifact", source_id),
            version_id: source_id,
            path: relative_path,
            kind: "source".into(),
            created_at: now_string(),
        };
        if !database
            .replace_pipeline(&input.project_id, expected_revision, &pipeline, &[artifact])
            .map_err(database_error)?
        {
            return Err("Unknown project".into());
        }
        Ok(pipeline)
    }

    pub fn commit_pipeline(&self, input: PipelineCommitInput) -> Result<Value, String> {
        let workspace = self.workspace()?;
        let database = self.database()?;
        let current = database
            .get_project(&input.project_id)
            .map_err(database_error)?
            .ok_or_else(|| "Unknown project".to_string())?;
        let current_revision = current
            .pipeline
            .get("revision")
            .and_then(Value::as_i64)
            .ok_or_else(|| "Persisted pipeline revision is invalid".to_string())?;
        if current_revision != input.expected_revision {
            return Err("stale pipeline revision".into());
        }
        validate_revision_commit(
            &current.pipeline,
            &input.pipeline,
            &input.project_id,
            input.expected_revision,
        )?;
        validate_revision_artifacts(&current.pipeline, &input.pipeline, &input.writes)?;
        validate_prompt_context_commit(
            &current.pipeline,
            &input.pipeline,
            &input.project_id,
            input.expected_revision,
            !input.writes.is_empty(),
        )?;
        crate::visual_style::validate_visual_writes(&input.pipeline, &input.writes)?;
        let mut artifacts = Vec::with_capacity(input.writes.len());
        let mut validated_writes = Vec::with_capacity(input.writes.len());
        let mut write_paths = std::collections::HashSet::new();
        for (index, write) in input.writes.iter().enumerate() {
            let bytes = decode_base64(&write.contents_base64)?;
            if bytes.len() != write.byte_length || sha256(&bytes) != write.sha256 {
                return Err(
                    "Worker artifact length or SHA-256 does not match its write intent".into(),
                );
            }
            validate_worker_relative_path(&write.relative_path)?;
            if write.relative_path.starts_with("visuals/style-templates/") {
                return Err(
                    "Template assets can only be saved through visual style confirmation".into(),
                );
            }
            if !write_paths.insert(write.relative_path.clone()) {
                return Err("Duplicate artifact write path".into());
            }
            if frozen_artifact_paths(&current.pipeline).contains(&write.relative_path) {
                return Err("Frozen or historical artifacts are immutable".into());
            }
            validated_writes.push((
                Path::new(&input.project_id).join(&write.relative_path),
                bytes,
            ));
            artifacts.push(PersistedArtifact {
                id: format!(
                    "{}-artifact-{}-{}",
                    input.project_id,
                    input.expected_revision + 1,
                    index + 1
                ),
                version_id: write.version_id.clone(),
                path: write.relative_path.clone(),
                kind: write.kind.clone(),
                created_at: input
                    .pipeline
                    .pointer("/project/updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .into(),
            });
        }
        let mut new_artifacts = Vec::new();
        if !database
            .replace_pipeline_with_visual_artifacts(
                &input.project_id,
                input.expected_revision,
                &input.pipeline,
                &artifacts,
                crate::visual_style::VisualCommitContext {
                    request_id: input.visual_request_id.as_deref(),
                    provider: input.visual_provider.as_ref(),
                    expected_style_revision: input.expected_style_revision,
                },
                || {
                    for (path, bytes) in &validated_writes {
                        if input.pipeline["schemaVersion"] == 2
                            || input.visual_request_id.is_some()
                            || path.starts_with(Path::new(&input.project_id).join("visuals"))
                        {
                            new_artifacts
                                .push(write_new_workspace_artifact(&workspace, path, bytes)?);
                        } else {
                            atomic_write_workspace_file(&workspace, path, bytes)?;
                        }
                    }
                    Ok(())
                },
            )
            .map_err(database_error)?
        {
            return Err("Unknown project".into());
        }
        for artifact in new_artifacts {
            artifact.commit();
        }
        Ok(input.pipeline)
    }

    pub fn persistence_counts(&self, project_id: &str) -> Result<PersistenceCounts, String> {
        self.database()?
            .persistence_counts(project_id)
            .map_err(database_error)
    }

    pub fn rename_project(&self, id: &str, name: String) -> Result<String, String> {
        let name = non_empty(name, "Project name")?;
        let changed = self
            .database()?
            .rename_project(id, &name, &now_string())
            .map_err(database_error)?;
        if !changed {
            return Err("Unknown project".into());
        }
        Ok(format!("项目已重命名为“{name}”。"))
    }

    pub fn record_source_analysis_completed(&self, id: &str) -> Result<(), String> {
        self.transition(id, "intake", "source_analysis", 25, "材料分析已完成")
    }

    pub fn submit_outline_for_review(&self, id: &str) -> Result<(), String> {
        self.transition(id, "source_analysis", "outline_review", 35, "大纲等待审批")
    }

    pub fn approve_outline(&self, id: &str) -> Result<(), String> {
        self.transition(
            id,
            "outline_review",
            "detail_review",
            45,
            "大纲已批准，等待逐页细化",
        )
    }

    pub fn approve_details(&self, id: &str) -> Result<(), String> {
        self.transition(
            id,
            "detail_review",
            "visual_review",
            60,
            "逐页细化已批准，等待第 1 页视觉审批",
        )
    }

    pub fn regenerate_slide(&self, input: SlideMutationInput) -> Result<RegenerateResult, String> {
        let project = self.require_visual_slide(&input.project_id, input.slide)?;
        if input.comment.trim().is_empty() {
            return Err("请填写修改意见后再重新生成".into());
        }
        let mut mutation = mutation_from(&project);
        mutation.slide_notice = "ImageGen 尚未连接；没有切换到收费 API。".into();
        mutation.updated_at = now_string();
        self.persist_mutation(&input.project_id, &mutation)?;
        Err(
            "Codex ImageGen 能力当前不可用；项目已保留在视觉审批检查点，且不会自动切换到收费 API。"
                .into(),
        )
    }

    pub fn approve_slide(&self, input: SlideMutationInput) -> Result<ApprovalResult, String> {
        let project = self.require_visual_slide(&input.project_id, input.slide)?;
        let index = (input.slide - 1) as usize;
        if project.selected_slide != input.slide || project.slide_statuses[index] != "waiting" {
            return Err("Only the current waiting slide can be approved".into());
        }
        if project.slide_statuses[..index]
            .iter()
            .any(|status| status != "approved")
        {
            return Err("Earlier slides must be approved first".into());
        }
        let mut slides = project.slide_statuses.clone();
        slides[index] = "approved".into();
        let is_last = input.slide == 5;
        if !is_last {
            slides[index + 1] = "waiting".into();
        }
        let mutation = ProjectMutation {
            workflow_status: if is_last {
                "conversion"
            } else {
                "visual_review"
            }
            .into(),
            progress: if is_last { 78 } else { project.progress },
            selected_slide: if is_last { 5 } else { input.slide + 1 },
            slide_statuses: slides,
            export_ready: is_last,
            slide_notice: if is_last {
                "第 5 页已批准，进入可编辑转换。".into()
            } else {
                format!("已批准，进入第 {} 页", input.slide + 1)
            },
            updated_at: now_string(),
        };
        self.persist_mutation(&input.project_id, &mutation)?;
        Ok(ApprovalResult {
            status: mutation.slide_notice,
            next_slide: mutation.selected_slide,
            stage: is_last.then(|| "conversion".into()),
            export_ready: is_last.then_some(true),
        })
    }

    pub fn reopen_slide(&self, project_id: &str, slide: i64) -> Result<String, String> {
        let project = self
            .database()?
            .get_project(project_id)
            .map_err(database_error)?
            .ok_or_else(|| "Unknown project".to_string())?;
        if !(1..=5).contains(&slide) || project.slide_statuses[(slide - 1) as usize] != "approved" {
            return Err("Only an approved slide can be reopened".into());
        }
        let statuses = project
            .slide_statuses
            .iter()
            .enumerate()
            .map(|(index, status)| {
                if index + 1 < slide as usize {
                    status.clone()
                } else if index + 1 == slide as usize {
                    "waiting".into()
                } else {
                    "pending".into()
                }
            })
            .collect();
        let status = format!("第 {slide} 页已重新打开，等待修改。");
        self.persist_mutation(
            project_id,
            &ProjectMutation {
                workflow_status: "visual_review".into(),
                progress: project.progress.min(70),
                selected_slide: slide,
                slide_statuses: statuses,
                export_ready: false,
                slide_notice: status.clone(),
                updated_at: now_string(),
            },
        )?;
        Ok(status)
    }

    pub fn decide_approval(&self, id: &str, decision: &str) -> Result<String, String> {
        let changed = self
            .database()?
            .decide_approval(id, decision, &now_string())
            .map_err(database_error)?;
        if !changed {
            return Err("Approval is not pending".into());
        }
        Ok(if decision == "approved" {
            "已批准"
        } else {
            "已驳回"
        }
        .into())
    }

    pub fn decide_memory(&self, id: &str, decision: &str) -> Result<String, String> {
        let changed = self
            .database()?
            .decide_memory(id, decision, &now_string())
            .map_err(database_error)?;
        if !changed {
            return Err("Memory proposal is not pending".into());
        }
        Ok(if decision == "approved" {
            "已批准"
        } else {
            "已拒绝"
        }
        .into())
    }

    pub fn propose_memory(&self, title: String, content: String) -> Result<String, String> {
        let title = non_empty(title, "Memory proposal title")?;
        let content = non_empty(content, "Memory proposal content")?;
        self.database()?
            .insert_memory_proposal(&NewMemoryProposal {
                id: next_identifier("memory"),
                title: title.clone(),
                content,
                created_at: now_string(),
            })
            .map_err(database_error)?;
        Ok(format!(
            "偏好建议“{title}”已提交，只有你在偏好记忆中批准后才会生效。"
        ))
    }

    pub fn save_settings(
        &self,
        workspace_path: String,
        codex_path: String,
        pdf_renderer_path: String,
    ) -> Result<String, String> {
        let workspace = PathBuf::from(non_empty(workspace_path, "Workspace path")?);
        if !workspace.is_absolute() {
            return Err("Workspace path must be absolute".into());
        }
        fs::create_dir_all(&workspace)
            .map_err(|error| format!("Workspace cannot be created: {error}"))?;
        let workspace = fs::canonicalize(&workspace)
            .map_err(|error| format!("Workspace cannot be resolved: {error}"))?;
        if !codex_path.trim().is_empty() {
            let codex = PathBuf::from(codex_path.trim());
            if !codex.is_absolute() || !codex.is_file() {
                return Err("Codex path must be an existing absolute file".into());
            }
        }
        if !pdf_renderer_path.trim().is_empty() {
            let renderer = PathBuf::from(pdf_renderer_path.trim());
            if !renderer.is_absolute() || !is_executable_file(&renderer) {
                return Err(
                    "PDF renderer path must be an existing executable absolute file".into(),
                );
            }
        }
        let database = self.database()?;
        database
            .save_setting("workspace_path", &workspace.to_string_lossy())
            .map_err(database_error)?;
        database
            .save_setting("codex_path", codex_path.trim())
            .map_err(database_error)?;
        database
            .save_setting("pdf_renderer_path", pdf_renderer_path.trim())
            .map_err(database_error)?;
        *self
            .workspace_root
            .lock()
            .map_err(|_| "Workspace state lock poisoned".to_string())? = workspace;
        Ok("设置已保存到本机。".into())
    }

    fn transition(
        &self,
        id: &str,
        expected: &str,
        target: &str,
        progress: i64,
        notice: &str,
    ) -> Result<(), String> {
        let project = self
            .database()?
            .get_project(id)
            .map_err(database_error)?
            .ok_or_else(|| "Unknown project".to_string())?;
        if project.workflow_status != expected {
            return Err(format!(
                "Project is not at the required {expected} checkpoint"
            ));
        }
        let mut mutation = mutation_from(&project);
        mutation.workflow_status = target.into();
        mutation.progress = progress;
        mutation.slide_notice = notice.into();
        mutation.updated_at = now_string();
        self.persist_mutation(id, &mutation)
    }

    fn require_visual_slide(&self, id: &str, slide: i64) -> Result<StoredProject, String> {
        if !(1..=5).contains(&slide) {
            return Err("Slide number must be between 1 and 5".into());
        }
        let project = self
            .database()?
            .get_project(id)
            .map_err(database_error)?
            .ok_or_else(|| "Unknown project".to_string())?;
        if project.workflow_status != "visual_review" {
            return Err("Project is not at visual review".into());
        }
        Ok(project)
    }

    fn persist_mutation(&self, id: &str, mutation: &ProjectMutation) -> Result<(), String> {
        let database = self.database()?;
        if database
            .get_project(id)
            .map_err(database_error)?
            .is_some_and(|project| project.pipeline["schemaVersion"] == 2)
        {
            return Err("Versioned projects require a validated native pipeline action".into());
        }
        let changed = database
            .mutate_project(id, mutation)
            .map_err(database_error)?;
        if changed {
            Ok(())
        } else {
            Err("Unknown project".into())
        }
    }

    pub(crate) fn database(&self) -> Result<std::sync::MutexGuard<'_, Database>, String> {
        self.database
            .lock()
            .map_err(|_| "Database state lock poisoned".to_string())
    }

    pub(crate) fn workspace(&self) -> Result<PathBuf, String> {
        self.workspace_root
            .lock()
            .map(|path| path.clone())
            .map_err(|_| "Workspace state lock poisoned".to_string())
    }
}

fn project_summary(project: StoredProject) -> ProjectSummary {
    ProjectSummary {
        id: project.id,
        name: project.name,
        goal: project.goal,
        stage: stage_label(&project.workflow_status).into(),
        workflow_status: project.workflow_status,
        progress: project.progress,
        selected_slide: project.selected_slide,
        slides: project
            .slide_statuses
            .into_iter()
            .enumerate()
            .map(|(index, status)| SlideSummary {
                page: index as i64 + 1,
                status,
            })
            .collect(),
        export_ready: project.export_ready,
        slide_notice: project.slide_notice,
        updated_at: project.updated_at,
    }
}

fn mutation_from(project: &StoredProject) -> ProjectMutation {
    ProjectMutation {
        workflow_status: project.workflow_status.clone(),
        progress: project.progress,
        selected_slide: project.selected_slide,
        slide_statuses: project.slide_statuses.clone(),
        export_ready: project.export_ready,
        slide_notice: project.slide_notice.clone(),
        updated_at: project.updated_at.clone(),
    }
}

fn stage_label(stage: &str) -> &'static str {
    match stage {
        "intake" => "材料",
        "source_analysis" => "材料分析",
        "outline_review" => "大纲审批",
        "detail_review" => "逐页细化",
        "visual_review" => "视觉审批",
        "conversion" => "可编辑转换",
        "qa" => "质量检查",
        "completed" => "已完成",
        "blocked" => "已阻塞",
        _ => "未知状态",
    }
}

fn memory_status(status: &str) -> &'static str {
    match status {
        "approved" => "已批准",
        "rejected" => "已拒绝",
        _ => "待决定",
    }
}

fn non_empty(value: String, field: &str) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        Err(format!("{field} is required"))
    } else {
        Ok(value)
    }
}

fn next_identifier(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) fn now_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| format!("unix:{}", duration.as_millis()))
        .unwrap_or_else(|_| "unix:0".into())
}

fn database_error(error: rusqlite::Error) -> String {
    format!("Local database operation failed: {error}")
}

fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| "Artifact contents are not valid base64".to_string())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn frozen_artifact_paths(pipeline: &Value) -> std::collections::HashSet<String> {
    let mut paths = std::collections::HashSet::new();
    for (field, directory, stem) in [
        ("outline", "outline", "outline"),
        ("slideSpecs", "slide-specs", "slide-specs"),
    ] {
        let mut snapshots = vec![&pipeline[field]];
        if let Some(history) = pipeline["revisionHistory"].as_array() {
            let historical_field = if field == "outline" {
                "baseOutline"
            } else {
                "baseSlideSpecs"
            };
            snapshots.extend(history.iter().map(|entry| &entry[historical_field]));
        }
        for snapshot in snapshots {
            if snapshot["version"]["status"] == "frozen" {
                if let Some(sequence) = snapshot["version"]["sequence"].as_i64() {
                    paths.insert(format!("{directory}/{stem}-v{sequence}.json"));
                }
            }
        }
    }
    paths
}

fn validate_revision_artifacts(
    current: &Value,
    next: &Value,
    writes: &[ArtifactWriteInput],
) -> Result<(), String> {
    if next["schemaVersion"] != 2 {
        return Ok(());
    }
    let events = next["revisionEvents"]
        .as_array()
        .ok_or("Missing revision events")?;
    let previous_count = current["revisionEvents"].as_array().map_or(0, Vec::len);
    if events.len() == previous_count {
        if current["slideSpecs"]["version"]["status"] == "draft" && !writes.is_empty() {
            return Err("Detail approval cannot write artifacts".into());
        }
        return Ok(());
    }
    let event = events.last().ok_or("Missing revision event")?;
    let kind = event["kind"]
        .as_str()
        .ok_or("Missing revision event kind")?;
    let mut expected: Vec<(String, &str, String, Value)> = Vec::new();
    if current["schemaVersion"] == 1 {
        let revision = current["revision"]
            .as_i64()
            .ok_or("Missing origin revision")?;
        expected.push((
            format!("history/checkpoint-v1-r{revision}.json"),
            "pipeline-origin",
            format!("checkpoint-r{revision}"),
            current.clone(),
        ));
    }
    if kind == "outline.revision.approve" {
        let sequence = next["outline"]["version"]["sequence"]
            .as_i64()
            .ok_or("Missing outline sequence")?;
        expected.push((
            format!("outline/outline-v{sequence}.json"),
            "outline",
            next["outline"]["version"]["id"]
                .as_str()
                .ok_or("Missing outline id")?
                .into(),
            next["outline"]["value"].clone(),
        ));
    }
    if kind == "outline.revision.approve" || kind == "details.submit" {
        let sequence = next["slideSpecs"]["version"]["sequence"]
            .as_i64()
            .ok_or("Missing detail sequence")?;
        expected.push((format!("slide-specs/slide-specs-v{sequence}.json"), "slide-specs", next["slideSpecs"]["version"]["id"].as_str().ok_or("Missing detail id")?.into(),
            serde_json::json!({"outlineVersionId": next["outline"]["version"]["id"], "specs": next["slideSpecs"]["value"]})));
    }
    if kind == "outline.revision.approve" || kind == "outline.revision.cancel" {
        let id = event["revisionId"].as_str().ok_or("Missing revision id")?;
        expected.push((
            format!("history/{id}.json"),
            "outline-revision-history",
            id.into(),
            next["revisionHistory"]
                .as_array()
                .and_then(|history| history.last())
                .ok_or("Missing revision history")?
                .clone(),
        ));
    }
    if writes.len() != expected.len() {
        return Err("Revision commit must include its exact artifact set".into());
    }
    for (path, kind, version_id, value) in expected {
        let write = writes
            .iter()
            .find(|write| write.relative_path == path)
            .ok_or("Missing revision artifact")?;
        let contents: Value = serde_json::from_slice(&decode_base64(&write.contents_base64)?)
            .map_err(|_| "Revision artifact must be valid JSON")?;
        if write.kind != kind
            || write.version_id != version_id
            || contents != value
            || write.slide_id.is_some()
            || write.metadata.is_some()
        {
            return Err("Revision artifact does not match its checkpoint".into());
        }
    }
    Ok(())
}

fn validate_revision_commit(
    current: &Value,
    next: &Value,
    project_id: &str,
    expected_revision: i64,
) -> Result<(), String> {
    if next["revision"].as_i64() != Some(expected_revision + 1)
        || next["project"]["id"] != project_id
    {
        return Err("Pipeline revision must advance once for the same project".into());
    }
    let old_schema = current["schemaVersion"].as_i64();
    let new_schema = next["schemaVersion"].as_i64();
    if !matches!(old_schema, Some(1 | 2))
        || !matches!(new_schema, Some(1 | 2))
        || (old_schema == Some(2) && new_schema != Some(2))
    {
        return Err("Unsupported pipeline schema or downgrade".into());
    }
    if new_schema == Some(1) {
        for field in ["outline", "slideSpecs"] {
            if current[field]["version"]["status"] == "frozen" && next[field] != current[field] {
                return Err("Frozen versions are immutable".into());
            }
        }
        return Ok(());
    }
    let old_events = current["revisionEvents"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let events = next["revisionEvents"]
        .as_array()
        .ok_or("Missing revision events")?;
    let old_history = current["revisionHistory"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let history = next["revisionHistory"]
        .as_array()
        .ok_or("Missing revision history")?;
    if !events.starts_with(&old_events)
        || !history.starts_with(&old_history)
        || events.len() > old_events.len() + 1
    {
        return Err("Prior revision events and history are immutable".into());
    }
    if old_schema == Some(1) {
        if next["revisionOrigin"] != *current
            || events.len() != 1
            || events[0]["kind"] != "outline.revision.save"
        {
            return Err("First revision must preserve the exact v1 origin".into());
        }
    } else if next["revisionOrigin"] != current["revisionOrigin"] {
        return Err("Revision origin is immutable".into());
    }
    if next["revisionOrigin"]["schemaVersion"] != 1 {
        return Err("Revision origin must be v1".into());
    }
    for field in ["sources", "analysis", "preferenceSnapshot", "promptContext"] {
        if current[field] != next[field] {
            return Err(format!("Revision must preserve {field}"));
        }
    }
    let old_approvals = current["approvals"].as_array().ok_or("Missing approvals")?;
    let approvals = next["approvals"].as_array().ok_or("Missing approvals")?;
    let old_tasks = current["tasks"].as_array().ok_or("Missing tasks")?;
    let tasks = next["tasks"].as_array().ok_or("Missing tasks")?;
    if !approvals.starts_with(old_approvals) || !tasks.starts_with(old_tasks) {
        return Err("Historical approval and task evidence is immutable".into());
    }
    if events.len() == old_events.len() {
        if !current["outlineRevisionDraft"].is_null() {
            return Err("Pending revision blocks downstream actions".into());
        }
        if next["outline"] != current["outline"]
            || next["revisionHistory"] != current["revisionHistory"]
            || next["outlineRevisionDraft"] != current["outlineRevisionDraft"]
        {
            return Err("Unjournaled structure mutation".into());
        }
        if current["slideSpecs"]["version"]["status"] == "frozen"
            && current["slideSpecs"] != next["slideSpecs"]
        {
            return Err("Frozen details are immutable".into());
        }
        if current["slideSpecs"]["version"]["status"] == "draft" {
            crate::native_revision_validation::time(
                &next["project"]["updatedAt"],
                &current["project"]["updatedAt"],
            )?;
            if current["project"]["workflowStatus"] != "detail_review"
                || current["visuals"] != serde_json::json!({})
                || [
                    "currentSlideId",
                    "blockedCondition",
                    "exportReceipt",
                    "qaReport",
                ]
                .iter()
                .any(|field| !current[field].is_null())
            {
                return Err("Detail approval requires an unblocked draft detail checkpoint".into());
            }
            let mut approved = current.clone();
            approved["revision"] = (expected_revision + 1).into();
            approved["project"]["updatedAt"] = next["project"]["updatedAt"].clone();
            approved["project"]["workflowStatus"] = "visual_review".into();
            approved["slideSpecs"]["version"]["status"] = "frozen".into();
            approved["slideSpecs"]["version"]["frozenAt"] = next["project"]["updatedAt"].clone();
            approved["currentSlideId"] = current["slideSpecs"]["value"][0]["id"].clone();
            approved["approvals"].as_array_mut().unwrap().push(serde_json::json!({
                "id": format!("{project_id}-detail_review-{}", old_approvals.len() + 1), "projectId": project_id,
                "versionId": current["slideSpecs"]["version"]["id"], "stage": "detail_review", "status": "approved", "decidedAt": next["project"]["updatedAt"]
            }));
            if *next != approved {
                return Err(
                    "Detail approval requires its exact approval and transition evidence".into(),
                );
            }
        }
        return Ok(());
    }
    if current["project"]["workflowStatus"] != "detail_review"
        || next["project"]["workflowStatus"] != "detail_review"
        || current["outline"]["version"]["status"] != "frozen"
        || current["slideSpecs"]["version"]["status"] != "draft"
    {
        return Err("Revision edits require unfrozen detail review".into());
    }
    for field in [
        "visuals",
        "currentSlideId",
        "blockedCondition",
        "exportReceipt",
        "qaReport",
    ] {
        if current[field] != next[field] {
            return Err("Revision edits cannot change downstream artifacts".into());
        }
    }
    let event = events.last().unwrap();
    crate::native_revision_validation::event(event, &current["project"]["updatedAt"])?;
    if event["expectedRevision"].as_i64() != Some(expected_revision)
        || event["at"] != next["project"]["updatedAt"]
    {
        return Err("Revision event baseline or time does not match the commit".into());
    }
    let kind = event["kind"].as_str().ok_or("Missing revision kind")?;
    let mut expected = current.clone();
    if old_schema == Some(1) {
        expected["outlineRevisionDraft"] = Value::Null;
        expected["revisionHistory"] = serde_json::json!([]);
    }
    let pending = current["outlineRevisionDraft"].clone();
    if kind == "details.submit" {
        if !pending.is_null() {
            return Err("Pending revision blocks details save".into());
        }
        crate::native_revision_validation::document(
            &current["outline"]["value"],
            &event["specs"],
            current,
            true,
        )?;
        expected["slideSpecs"]["value"] = event["specs"].clone();
        expected["slideSpecs"]["version"] = revision_version(
            project_id,
            "slide-specs",
            current["slideSpecs"]["version"]["sequence"]
                .as_i64()
                .ok_or("Missing detail sequence")?
                + 1,
            &event["at"],
            false,
        );
        expected["tasks"].as_array_mut().unwrap().push(serde_json::json!({
            "id": format!("{project_id}-task-{}-detail_generation", expected_revision + 1),
            "kind": "detail_generation", "status": "completed", "createdAt": event["at"], "updatedAt": event["at"], "error": null
        }));
    } else {
        let id = event["revisionId"].as_str().ok_or("Missing revision id")?;
        if id.is_empty()
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || event["baseOutlineVersionId"] != current["outline"]["version"]["id"]
            || old_history.iter().any(|entry| entry["id"] == id)
            || (!pending.is_null() && pending["id"] != id)
        {
            return Err("Stale or reused revision identity".into());
        }
        match kind {
            "outline.revision.save" => {
                crate::native_revision_validation::document(
                    &event["outline"],
                    &event["specs"],
                    current,
                    false,
                )?;
                expected["outlineRevisionDraft"] = serde_json::json!({"id": id, "baseOutlineVersionId": event["baseOutlineVersionId"],
                    "outline": event["outline"], "specs": event["specs"], "createdAt": if pending.is_null() { &event["at"] } else { &pending["createdAt"] }, "updatedAt": event["at"]});
            }
            "outline.revision.approve" | "outline.revision.cancel" => {
                if pending.is_null() {
                    return Err("No pending revision to decide".into());
                }
                crate::native_revision_validation::document(
                    &pending["outline"],
                    &pending["specs"],
                    current,
                    false,
                )?;
                let confirmed = kind == "outline.revision.approve";
                if confirmed {
                    expected["outline"] = serde_json::json!({"version": revision_version(project_id, "outline", current["outline"]["version"]["sequence"].as_i64().ok_or("Missing outline sequence")? + 1, &event["at"], true), "value": pending["outline"]});
                    expected["slideSpecs"] = serde_json::json!({"version": revision_version(project_id, "slide-specs", current["slideSpecs"]["version"]["sequence"].as_i64().ok_or("Missing detail sequence")? + 1, &event["at"], false), "value": pending["specs"]});
                    let proof = serde_json::json!({"id": format!("{project_id}-outline_review-{}", old_approvals.len() + 1), "projectId": project_id,
                        "versionId": expected["outline"]["version"]["id"], "stage": "outline_review", "status": "approved", "decidedAt": event["at"]});
                    expected["approvals"].as_array_mut().unwrap().push(proof);
                }
                let entry = serde_json::json!({"id": id, "status": if confirmed { "confirmed" } else { "cancelled" },
                    "baseOutline": current["outline"], "baseSlideSpecs": current["slideSpecs"], "draft": pending, "decidedAt": event["at"],
                    "newOutlineVersionId": if confirmed { expected["outline"]["version"]["id"].clone() } else { Value::Null }});
                expected["revisionHistory"]
                    .as_array_mut()
                    .unwrap()
                    .push(entry);
                expected["outlineRevisionDraft"] = Value::Null;
            }
            _ => return Err("Unknown revision event kind".into()),
        }
    }
    expected["schemaVersion"] = 2.into();
    expected["revision"] = (expected_revision + 1).into();
    expected["project"]["updatedAt"] = event["at"].clone();
    expected["revisionOrigin"] = if old_schema == Some(1) {
        current.clone()
    } else {
        current["revisionOrigin"].clone()
    };
    expected["revisionEvents"] = next["revisionEvents"].clone();
    if expected != *next {
        return Err("Revision event does not justify the complete checkpoint".into());
    }
    Ok(())
}

fn revision_version(
    project_id: &str,
    kind: &str,
    sequence: i64,
    at: &Value,
    frozen: bool,
) -> Value {
    serde_json::json!({"id": format!("{project_id}-{kind}-v{sequence}"), "projectId": project_id, "sequence": sequence,
        "status": if frozen { "frozen" } else { "draft" }, "createdAt": at, "frozenAt": if frozen { at.clone() } else { Value::Null }})
}

fn validate_worker_relative_path(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    let first = path
        .components()
        .next()
        .and_then(|component| match component {
            std::path::Component::Normal(name) => name.to_str(),
            _ => None,
        });
    if path.is_absolute()
        || !ARTIFACT_DIRECTORIES
            .iter()
            .any(|directory| Some(*directory) == first)
    {
        return Err("Worker artifact path is outside the project artifact directories".into());
    }
    if path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Worker artifact path is outside the project artifact directories".into());
    }
    Ok(())
}

fn validate_prompt_context_commit(
    current: &Value,
    next: &Value,
    project_id: &str,
    expected_revision: i64,
    has_writes: bool,
) -> Result<(), String> {
    let next_context = next.get("promptContext");
    if let Some(context) = next_context {
        validate_prompt_context_value(context, next)?;
    }
    if current.get("promptContext").is_some() && next_context.is_none() {
        return Err("Prompt context cannot be removed".into());
    }

    let next_tasks = next
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| "Prompt context transition tasks are invalid".to_string())?;
    let current_task_count = current
        .get("tasks")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| "Persisted pipeline tasks are invalid".to_string())?;
    let appended_context_task = next_tasks.get(current_task_count).is_some_and(|task| {
        task.get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.starts_with("prompt_context_"))
    });
    let context_field_changed = current.get("promptContext") != next_context;
    if !context_field_changed && !appended_context_task {
        return Ok(());
    }
    if has_writes {
        return Err("Prompt context transition cannot include artifact writes".into());
    }
    let current_stage = current
        .pointer("/project/workflowStatus")
        .and_then(Value::as_str)
        .ok_or_else(|| "Persisted pipeline workflow status is invalid".to_string())?;
    if !matches!(
        current_stage,
        "intake" | "source_analysis" | "outline_review"
    ) || (current_stage == "outline_review"
        && current
            .pointer("/outline/version/status")
            .and_then(Value::as_str)
            != Some("draft"))
    {
        return Err("Prompt context can only be updated before outline approval".into());
    }
    let context = next_context
        .ok_or_else(|| "Prompt context transition must persist its context".to_string())?;
    let previous = current.get("promptContext").cloned().unwrap_or_else(|| {
        serde_json::json!({"taskBrief": "", "sourceInstructions": {}, "outlineRequirements": ""})
    });
    let analysis_changed = previous.get("taskBrief") != context.get("taskBrief")
        || previous.get("sourceInstructions") != context.get("sourceInstructions");
    let outline_changed = previous.get("outlineRequirements") != context.get("outlineRequirements");
    let analysis_exists = current
        .get("analysis")
        .is_some_and(|value| !value.is_null());
    let outline_exists = current.get("outline").is_some_and(|value| !value.is_null());
    let task_kind = if analysis_changed && analysis_exists {
        "prompt_context_analysis_reset"
    } else if outline_changed && outline_exists {
        "prompt_context_outline_reset"
    } else {
        "prompt_context_update"
    };
    let updated_at = next
        .pointer("/project/updatedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| "Prompt context transition timestamp is invalid".to_string())?;
    let mut expected = current.clone();
    expected["revision"] = (expected_revision + 1).into();
    expected["project"]["updatedAt"] = updated_at.into();
    expected["promptContext"] = context.clone();
    if task_kind == "prompt_context_analysis_reset" {
        expected["analysis"] = Value::Null;
        expected["outline"] = Value::Null;
        clear_prompt_dependent_state(&mut expected);
        expected["project"]["workflowStatus"] = "intake".into();
    } else if task_kind == "prompt_context_outline_reset" {
        expected["outline"] = Value::Null;
        clear_prompt_dependent_state(&mut expected);
        expected["project"]["workflowStatus"] = if analysis_exists {
            "source_analysis".into()
        } else {
            "intake".into()
        };
    }
    expected["tasks"]
        .as_array_mut()
        .ok_or_else(|| "Persisted pipeline tasks are invalid".to_string())?
        .push(serde_json::json!({
            "id": format!("{project_id}-task-{}-{task_kind}", expected_revision + 1),
            "kind": task_kind,
            "status": "completed",
            "createdAt": updated_at,
            "updatedAt": updated_at,
            "error": null
        }));
    if expected != *next {
        return Err("Pipeline does not match the conservative prompt context transition".into());
    }
    Ok(())
}

fn clear_prompt_dependent_state(pipeline: &mut Value) {
    pipeline["slideSpecs"] = Value::Null;
    pipeline["visuals"] = serde_json::json!({});
    pipeline["currentSlideId"] = Value::Null;
    pipeline["approvals"] = serde_json::json!([]);
    pipeline["blockedCondition"] = Value::Null;
    pipeline["exportReceipt"] = Value::Null;
    pipeline["qaReport"] = Value::Null;
}

fn validate_prompt_context_value(context: &Value, pipeline: &Value) -> Result<(), String> {
    let object = context
        .as_object()
        .ok_or_else(|| "Prompt context must be an object".to_string())?;
    if object.len() != 3
        || !object.contains_key("taskBrief")
        || !object.contains_key("sourceInstructions")
        || !object.contains_key("outlineRequirements")
    {
        return Err("Prompt context contains missing or unknown fields".into());
    }
    let task_brief = object
        .get("taskBrief")
        .and_then(Value::as_str)
        .ok_or_else(|| "Prompt context taskBrief must be a string".to_string())?;
    let outline = object
        .get("outlineRequirements")
        .and_then(Value::as_str)
        .ok_or_else(|| "Prompt context outlineRequirements must be a string".to_string())?;
    if task_brief.len() > 20_000 || outline.len() > 20_000 {
        return Err("Prompt context exceeds its 20,000 byte limit".into());
    }
    let instructions = object
        .get("sourceInstructions")
        .and_then(Value::as_object)
        .ok_or_else(|| "Prompt context sourceInstructions must be an object".to_string())?;
    let source_ids = pipeline
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| "Pipeline sources are invalid".to_string())?;
    if instructions.len() > source_ids.len() {
        return Err("Prompt context has too many source instructions".into());
    }
    for (source_id, instruction) in instructions {
        let instruction = instruction
            .as_str()
            .ok_or_else(|| "Prompt context source instruction must be a string".to_string())?;
        if instruction.len() > 10_000 {
            return Err("Prompt context source instruction exceeds its 10,000 byte limit".into());
        }
        if !source_ids
            .iter()
            .any(|source| source.get("id").and_then(Value::as_str) == Some(source_id))
        {
            return Err("Prompt context references an unknown source".into());
        }
    }
    Ok(())
}

fn find_pdf_renderer_with_candidates(
    configured: Option<&Path>,
    fixed_candidates: &[PathBuf],
    path_value: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    find_named_executable_with_candidates("pdftoppm", configured, fixed_candidates, path_value)
}

fn find_soffice_with_candidates(
    fixed_candidates: &[PathBuf],
    path_value: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    find_named_executable_with_candidates("soffice", None, fixed_candidates, path_value)
}

fn find_named_executable_with_candidates(
    executable_name: &str,
    configured: Option<&Path>,
    fixed_candidates: &[PathBuf],
    path_value: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    configured
        .filter(|path| path.is_absolute() && is_executable_file(path))
        .map(Path::to_path_buf)
        .or_else(|| {
            fixed_candidates
                .iter()
                .find(|path| path.is_absolute() && is_executable_file(path))
                .cloned()
        })
        .or_else(|| {
            path_value.and_then(|value| {
                env::split_paths(value)
                    .map(|directory| directory.join(executable_name))
                    .find(|path| is_executable_file(path))
            })
        })
}

fn soffice_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = env::current_exe() {
        if let Some(contents) = executable.parent().and_then(Path::parent) {
            candidates.push(contents.join("Resources/bin/soffice"));
            candidates.push(contents.join("Resources/soffice"));
        }
    }
    candidates.extend([
        PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        PathBuf::from("/Applications/LibreOfficeDev.app/Contents/MacOS/soffice"),
        PathBuf::from("/opt/homebrew/bin/soffice"),
        PathBuf::from("/usr/local/bin/soffice"),
    ]);
    if let Some(override_path) = env::var_os("DIGITAL_TWIN_SOFFICE") {
        candidates.push(PathBuf::from(override_path));
    }
    if let Some(home) = env::var_os("HOME") {
        let dependencies =
            PathBuf::from(home).join(".cache/codex-runtimes/codex-primary-runtime/dependencies");
        // Prefer the native executable: the runtime's convenience wrapper uses
        // `/usr/bin/env bash`, which is intentionally unavailable when QA is
        // launched with a constrained PATH (for example from Finder).
        candidates.push(dependencies.join(
            "native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice",
        ));
        candidates.push(dependencies.join("bin/override/soffice"));
        candidates.push(dependencies.join("bin/fallback/soffice"));
    }
    candidates
}

fn pdf_renderer_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = env::current_exe() {
        if let Some(contents) = executable.parent().and_then(Path::parent) {
            candidates.push(contents.join("Resources/bin/pdftoppm"));
            candidates.push(contents.join("Resources/pdftoppm"));
        }
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/pdftoppm"),
        PathBuf::from("/usr/local/bin/pdftoppm"),
    ]);
    if let Some(override_path) = env::var_os("DIGITAL_TWIN_PDF_RENDERER") {
        candidates.push(PathBuf::from(override_path));
    }
    if let Some(home) = env::var_os("HOME") {
        let dependencies =
            PathBuf::from(home).join(".cache/codex-runtimes/codex-primary-runtime/dependencies");
        // Prefer native binaries over the runtime's `env bash` wrappers so
        // Finder/constrained-PATH launches do not depend on shell discovery.
        candidates.push(dependencies.join("native/poppler/poppler/bin/pdftoppm"));
        candidates.push(dependencies.join("native/poppler/bin/pdftoppm"));
        candidates.push(dependencies.join("bin/override/pdftoppm"));
        candidates.push(dependencies.join("bin/fallback/pdftoppm"));
    }
    candidates
}

fn create_qa_fontconfig(root: &Path) -> Result<PathBuf, String> {
    let cache = root.join("font-cache");
    fs::create_dir_all(&cache)
        .map_err(|error| format!("QA Fontconfig cache cannot be created: {error}"))?;
    let xdg_cache = root.join("xdg-cache");
    fs::create_dir_all(&xdg_cache)
        .map_err(|error| format!("QA XDG cache cannot be created: {error}"))?;
    let path = root.join("fontconfig.xml");
    let cache = xml_escape(&cache.to_string_lossy());
    let contents = format!(
        "<?xml version=\"1.0\"?>\n\
         <!DOCTYPE fontconfig SYSTEM \"fonts.dtd\">\n\
         <fontconfig>\n\
           <dir>/System/Library/Fonts</dir>\n\
           <dir>/System/Library/Fonts/Supplemental</dir>\n\
           <dir>/Library/Fonts</dir>\n\
           <cachedir>{cache}</cachedir>\n\
         </fontconfig>\n"
    );
    fs::write(&path, contents)
        .map_err(|error| format!("QA Fontconfig file cannot be written: {error}"))?;
    Ok(path)
}

fn apply_qa_environment(command: &mut Command, temp: &Path, fontconfig: &Path) {
    command
        .env("TMPDIR", temp)
        .env("FONTCONFIG_FILE", fontconfig)
        .env("FONTCONFIG_PATH", fontconfig.parent().unwrap_or(temp))
        .env(
            "XDG_CACHE_HOME",
            fontconfig.parent().unwrap_or(temp).join("xdg-cache"),
        );
}

fn system_chinese_font() -> Option<PathBuf> {
    [
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/Supplemental/Hiragino Sans GB.ttc",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn rendered_page_number(path: &Path) -> Option<usize> {
    path.file_name()?
        .to_str()?
        .strip_prefix("rendered-")?
        .strip_suffix(".png")?
        .parse()
        .ok()
}

fn qa_preparation_failure(label: &str, output: &BoundedCommandOutput) -> Value {
    let detail = if output.stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout)
    } else {
        String::from_utf8_lossy(&output.stderr)
    };
    let detail = detail.chars().take(2_000).collect::<String>();
    serde_json::json!({
        "status": "failed",
        "capability": "qa-rendering",
        "issue": if output.timed_out {
            format!("{label} timed out: {detail}")
        } else {
            format!("{label} failed ({}): {detail}", output.status)
        },
    })
}

struct BoundedCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
}

fn run_bounded_command(
    mut command: Command,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<BoundedCommandOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("QA command cannot be spawned: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "QA command stdout pipe is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "QA command stderr pipe is unavailable".to_string())?;
    let (stdout_sender, stdout_receiver) = mpsc::sync_channel(1);
    let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = stdout_sender.send(read_capped(stdout, max_output_bytes));
    });
    thread::spawn(move || {
        let _ = stderr_sender.send(read_capped(stderr, max_output_bytes));
    });
    let process_group_id = child.id();
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("QA command wait failed: {error}"))?
        {
            break status;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            terminate_command_group(&mut child, libc::SIGTERM);
            thread::sleep(Duration::from_millis(250));
            if child.try_wait().ok().flatten().is_none() {
                terminate_command_group(&mut child, libc::SIGKILL);
            }
            break child
                .wait()
                .map_err(|error| format!("Timed-out QA command cannot be reaped: {error}"))?;
        }
        thread::sleep(Duration::from_millis(20));
    };
    // The root may exit while descendants retain inherited pipe handles. Kill
    // the isolated group on every terminal path, then drain for a bounded
    // interval so an escaped descendant can never hang QA indefinitely.
    terminate_process_group_id(process_group_id, libc::SIGKILL);
    let stdout = receive_bounded_output(stdout_receiver, "stdout")?;
    let stderr = receive_bounded_output(stderr_receiver, "stderr")?;
    Ok(BoundedCommandOutput {
        status,
        stdout,
        stderr,
        timed_out,
    })
}

fn receive_bounded_output(
    receiver: mpsc::Receiver<Result<Vec<u8>, String>>,
    label: &str,
) -> Result<Vec<u8>, String> {
    match receiver.recv_timeout(Duration::from_secs(1)) {
        Ok(output) => output,
        Err(mpsc::RecvTimeoutError::Timeout) => Ok(Vec::new()),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(format!("QA {label} reader stopped unexpectedly"))
        }
    }
}

fn terminate_command_group(child: &mut std::process::Child, signal: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), signal);
    }
    #[cfg(not(unix))]
    {
        let _ = signal;
        let _ = child.kill();
    }
}

fn terminate_process_group_id(process_group_id: u32, signal: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(process_group_id as i32), signal);
    }
    #[cfg(not(unix))]
    {
        let _ = (process_group_id, signal);
    }
}

fn read_capped(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut captured = Vec::with_capacity(limit.min(16_384));
    let mut buffer = [0_u8; 8_192];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("QA command output cannot be read: {error}"))?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        captured.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    Ok(captured)
}

fn read_bounded_file(path: &Path, max_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    let length = fs::metadata(path)
        .map_err(|error| format!("{label} cannot be inspected: {error}"))?
        .len();
    if length > max_bytes as u64 {
        return Err(format!("{label} exceeds the byte limit"));
    }
    fs::read(path).map_err(|error| format!("{label} cannot be read: {error}"))
}

struct QaTempDirectory {
    path: PathBuf,
}

impl QaTempDirectory {
    fn create() -> Result<Self, String> {
        let path = env::temp_dir().join(next_identifier("digital-twin-qa"));
        fs::create_dir(&path)
            .map_err(|error| format!("QA temporary directory cannot be created: {error}"))?;
        Ok(Self { path })
    }
}

impl Drop for QaTempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(all(test, unix))]
mod qa_command_tests {
    use super::*;

    fn executable(path: &Path) {
        fs::write(path, b"#!/bin/sh\nexit 0\n").expect("fixture written");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("fixture executable");
    }

    #[test]
    fn qa_command_output_is_capped_by_bytes() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "yes x | head -c 50000"]);
        let output = run_bounded_command(command, Duration::from_secs(2), 1_024)
            .expect("bounded command runs");
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 1_024);
        assert!(output.stderr.len() <= 1_024);
        assert!(!output.timed_out);
    }

    #[test]
    fn qa_command_times_out_and_reaps_its_process_group() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 5"]);
        let started = Instant::now();
        let output = run_bounded_command(command, Duration::from_millis(50), 1_024)
            .expect("timed-out command is reaped");
        assert!(output.timed_out);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn qa_command_returns_when_root_exits_but_a_descendant_inherits_stdout() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "(trap '' TERM; sleep 30) & exit 0"]);
        let started = Instant::now();
        let output = run_bounded_command(command, Duration::from_secs(5), 1_024)
            .expect("root exit is observed without an unbounded pipe join");
        assert!(output.status.success());
        assert!(!output.timed_out);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn production_fontconfig_points_to_system_chinese_fonts_and_is_passed_to_children() {
        let temp = QaTempDirectory::create().expect("temporary QA directory");
        let fontconfig = create_qa_fontconfig(&temp.path).expect("fontconfig created");
        let contents = fs::read_to_string(&fontconfig).expect("fontconfig readable");
        assert!(contents.contains("/System/Library/Fonts"));
        assert!(contents.contains("/System/Library/Fonts/Supplemental"));
        assert!(temp.path.join("font-cache").is_dir());

        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "test -f \"$FONTCONFIG_FILE\" && grep -q System/Library/Fonts \"$FONTCONFIG_FILE\"",
        ]);
        apply_qa_environment(&mut command, &temp.path, &fontconfig);
        let output = run_bounded_command(command, Duration::from_secs(2), 1_024)
            .expect("environment probe runs");
        assert!(output.status.success());
    }

    #[test]
    fn pdf_renderer_discovery_works_with_an_empty_path_and_validates_executable_candidates() {
        let temp = QaTempDirectory::create().expect("temporary directory");
        let configured = temp.path.join("configured-pdftoppm");
        let bundled = temp.path.join("bundled-pdftoppm");
        fs::write(&configured, b"not executable").expect("configured fixture written");
        executable(&bundled);

        let found = find_pdf_renderer_with_candidates(
            Some(&configured),
            &[bundled.clone()],
            Some(std::ffi::OsStr::new("")),
        );
        assert_eq!(found, Some(bundled));
    }

    #[test]
    fn soffice_discovery_works_with_an_empty_path_and_validates_executable_candidates() {
        let temp = QaTempDirectory::create().expect("temporary directory");
        let invalid = temp.path.join("invalid-soffice");
        let bundled = temp.path.join("bundled-soffice");
        fs::write(&invalid, b"not executable").expect("invalid fixture written");
        executable(&bundled);

        let found = find_soffice_with_candidates(
            &[invalid, bundled.clone()],
            Some(std::ffi::OsStr::new("")),
        );
        assert_eq!(found, Some(bundled));
    }
}
