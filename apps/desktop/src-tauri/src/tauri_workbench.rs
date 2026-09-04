use serde::Serialize;
use tauri::State;

use crate::workbench::{
    ApprovalResult, AttachSourceInput, CreateProjectInput, DesktopInitialState,
    PipelineCommitInput, ProjectSummary, RegenerateResult, SlideMutationInput, WorkbenchService,
};

#[derive(Serialize)]
pub struct StatusResult {
    pub status: String,
}

#[tauri::command]
pub fn ppt_load_pipeline(
    state: State<'_, WorkbenchService>,
    project_id: String,
) -> Result<serde_json::Value, String> {
    ppt_load_pipeline_service(&state, project_id)
}

pub fn ppt_load_pipeline_service(
    service: &WorkbenchService,
    project_id: String,
) -> Result<serde_json::Value, String> {
    service.load_pipeline(&project_id)
}

#[tauri::command]
pub fn ppt_project_directory(
    state: State<'_, WorkbenchService>,
    project_id: String,
) -> Result<String, String> {
    ppt_project_directory_service(&state, project_id)
}

pub fn ppt_project_directory_service(
    service: &WorkbenchService,
    project_id: String,
) -> Result<String, String> {
    service.project_directory(&project_id)
}

#[tauri::command]
pub fn ppt_read_artifact(
    state: State<'_, WorkbenchService>,
    project_id: String,
    relative_path: String,
) -> Result<String, String> {
    ppt_read_artifact_service(&state, project_id, relative_path)
}

pub fn ppt_read_artifact_service(
    service: &WorkbenchService,
    project_id: String,
    relative_path: String,
) -> Result<String, String> {
    service.read_artifact(&project_id, &relative_path)
}

#[tauri::command]
pub fn ppt_prepare_qa(
    state: State<'_, WorkbenchService>,
    project_id: String,
) -> Result<serde_json::Value, String> {
    ppt_prepare_qa_service(&state, project_id)
}

pub fn ppt_prepare_qa_service(
    service: &WorkbenchService,
    project_id: String,
) -> Result<serde_json::Value, String> {
    service.prepare_qa(&project_id)
}

#[tauri::command]
pub fn ppt_attach_source(
    state: State<'_, WorkbenchService>,
    input: AttachSourceInput,
) -> Result<serde_json::Value, String> {
    ppt_attach_source_service(&state, input)
}

pub fn ppt_attach_source_service(
    service: &WorkbenchService,
    input: AttachSourceInput,
) -> Result<serde_json::Value, String> {
    service.attach_source(input)
}

#[tauri::command]
pub fn ppt_commit_pipeline(
    state: State<'_, WorkbenchService>,
    input: PipelineCommitInput,
) -> Result<serde_json::Value, String> {
    ppt_commit_pipeline_service(&state, input)
}

pub fn ppt_commit_pipeline_service(
    service: &WorkbenchService,
    input: PipelineCommitInput,
) -> Result<serde_json::Value, String> {
    service.commit_pipeline(input)
}

#[derive(Serialize)]
pub struct MessageResult {
    pub message: String,
}

#[tauri::command]
pub fn load_desktop_state(
    state: State<'_, WorkbenchService>,
) -> Result<DesktopInitialState, String> {
    load_desktop_state_service(&state)
}

pub fn load_desktop_state_service(
    service: &WorkbenchService,
) -> Result<DesktopInitialState, String> {
    service.initial_state()
}

#[tauri::command]
pub fn ppt_create_project(
    state: State<'_, WorkbenchService>,
    input: CreateProjectInput,
) -> Result<ProjectSummary, String> {
    ppt_create_project_service(&state, input)
}

pub fn ppt_create_project_service(
    service: &WorkbenchService,
    input: CreateProjectInput,
) -> Result<ProjectSummary, String> {
    service.create_project(input)
}

#[tauri::command]
pub fn ppt_rename_project(
    state: State<'_, WorkbenchService>,
    project_id: String,
    name: String,
) -> Result<StatusResult, String> {
    Ok(StatusResult {
        status: state.rename_project(&project_id, name)?,
    })
}

#[tauri::command]
pub fn ppt_regenerate_slide(
    state: State<'_, WorkbenchService>,
    project_id: String,
    slide: i64,
    comment: String,
) -> Result<RegenerateResult, String> {
    state.regenerate_slide(SlideMutationInput {
        project_id,
        slide,
        comment,
    })
}

#[tauri::command]
pub fn ppt_approve_slide(
    state: State<'_, WorkbenchService>,
    project_id: String,
    slide: i64,
    comment: String,
) -> Result<ApprovalResult, String> {
    state.approve_slide(SlideMutationInput {
        project_id,
        slide,
        comment,
    })
}

#[tauri::command]
pub fn ppt_reopen_slide(
    state: State<'_, WorkbenchService>,
    project_id: String,
    slide: i64,
) -> Result<StatusResult, String> {
    Ok(StatusResult {
        status: state.reopen_slide(&project_id, slide)?,
    })
}

#[tauri::command]
pub fn ppt_export_project(
    _state: State<'_, WorkbenchService>,
    project_id: String,
    name: String,
) -> Result<MessageResult, String> {
    let _ = (project_id, name);
    Err("可编辑导出必须由本地工作流 Worker 完成；当前项目尚无已验证交付产物。".into())
}

#[tauri::command]
pub fn approval_decide(
    state: State<'_, WorkbenchService>,
    approval_id: String,
    decision: String,
) -> Result<StatusResult, String> {
    Ok(StatusResult {
        status: state.decide_approval(&approval_id, &decision)?,
    })
}

#[tauri::command]
pub fn memory_decide(
    state: State<'_, WorkbenchService>,
    proposal_id: String,
    decision: String,
) -> Result<StatusResult, String> {
    Ok(StatusResult {
        status: state.decide_memory(&proposal_id, &decision)?,
    })
}

#[tauri::command]
pub fn memory_propose(
    state: State<'_, WorkbenchService>,
    title: String,
    content: String,
) -> Result<StatusResult, String> {
    memory_propose_service(&state, title, content)
}

pub fn memory_propose_service(
    service: &WorkbenchService,
    title: String,
    content: String,
) -> Result<StatusResult, String> {
    Ok(StatusResult {
        status: service.propose_memory(title, content)?,
    })
}

#[tauri::command]
pub fn save_desktop_settings(
    state: State<'_, WorkbenchService>,
    workspace_path: String,
    codex_path: String,
) -> Result<StatusResult, String> {
    Ok(StatusResult {
        status: state.save_settings(workspace_path, codex_path)?,
    })
}

#[tauri::command]
pub fn ppt_record_source_analysis(
    state: State<'_, WorkbenchService>,
    project_id: String,
) -> Result<StatusResult, String> {
    state.record_source_analysis_completed(&project_id)?;
    Ok(StatusResult {
        status: "材料分析检查点已保存。".into(),
    })
}

#[tauri::command]
pub fn ppt_submit_outline(
    state: State<'_, WorkbenchService>,
    project_id: String,
) -> Result<StatusResult, String> {
    state.submit_outline_for_review(&project_id)?;
    Ok(StatusResult {
        status: "大纲已提交审批。".into(),
    })
}

#[tauri::command]
pub fn ppt_approve_outline(
    state: State<'_, WorkbenchService>,
    project_id: String,
) -> Result<StatusResult, String> {
    state.approve_outline(&project_id)?;
    Ok(StatusResult {
        status: "大纲审批已冻结。".into(),
    })
}

#[tauri::command]
pub fn ppt_approve_details(
    state: State<'_, WorkbenchService>,
    project_id: String,
) -> Result<StatusResult, String> {
    state.approve_details(&project_id)?;
    Ok(StatusResult {
        status: "逐页细化审批已冻结。".into(),
    })
}
