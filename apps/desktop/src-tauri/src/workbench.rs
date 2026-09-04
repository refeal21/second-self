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
    paths::{atomic_write_workspace_file, create_workspace_project_tree},
};

const ARTIFACT_DIRECTORIES: [&str; 6] = [
    "sources",
    "outline",
    "slide-specs",
    "visuals",
    "exports",
    "qa",
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
        let mut artifacts = Vec::with_capacity(input.writes.len());
        for (index, write) in input.writes.iter().enumerate() {
            let bytes = decode_base64(&write.contents_base64)?;
            if bytes.len() != write.byte_length || sha256(&bytes) != write.sha256 {
                return Err(
                    "Worker artifact length or SHA-256 does not match its write intent".into(),
                );
            }
            validate_worker_relative_path(&write.relative_path)?;
            atomic_write_workspace_file(
                &workspace,
                Path::new(&input.project_id)
                    .join(&write.relative_path)
                    .as_path(),
                &bytes,
            )?;
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
        if !database
            .replace_pipeline(
                &input.project_id,
                input.expected_revision,
                &input.pipeline,
                &artifacts,
            )
            .map_err(database_error)?
        {
            return Err("Unknown project".into());
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
        let changed = self
            .database()?
            .mutate_project(id, mutation)
            .map_err(database_error)?;
        if changed {
            Ok(())
        } else {
            Err("Unknown project".into())
        }
    }

    fn database(&self) -> Result<std::sync::MutexGuard<'_, Database>, String> {
        self.database
            .lock()
            .map_err(|_| "Database state lock poisoned".to_string())
    }

    fn workspace(&self) -> Result<PathBuf, String> {
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

fn now_string() -> String {
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
