use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::database::{Database, NewProject, ProjectMutation, StoredProject};

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
            database
                .save_setting("codex_path", "")
                .map_err(database_error)?;
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
            },
        })
    }

    pub fn create_project(&self, input: CreateProjectInput) -> Result<ProjectSummary, String> {
        let name = non_empty(input.name, "Project name")?;
        let goal = non_empty(input.goal, "Project goal")?;
        let id = next_identifier("project");
        let now = now_string();
        let project_root = self.workspace()?.join(&id);
        create_project_directories(&project_root)?;
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

    pub fn save_settings(
        &self,
        workspace_path: String,
        codex_path: String,
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
        let database = self.database()?;
        database
            .save_setting("workspace_path", &workspace.to_string_lossy())
            .map_err(database_error)?;
        database
            .save_setting("codex_path", codex_path.trim())
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

fn create_project_directories(project_root: &Path) -> Result<(), String> {
    if project_root.exists() {
        return Err("Project directory already exists".into());
    }
    fs::create_dir(project_root)
        .map_err(|error| format!("Project directory cannot be created: {error}"))?;
    for directory in ARTIFACT_DIRECTORIES {
        fs::create_dir(project_root.join(directory))
            .map_err(|error| format!("Project artifact directory cannot be created: {error}"))?;
    }
    Ok(())
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
