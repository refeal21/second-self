pub mod codex_process;
pub mod database;
mod native_revision_validation;
pub mod paths;
pub mod tauri_codex;
pub mod tauri_workbench;
pub mod tauri_worker;
pub mod workbench;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(tauri_codex::CodexProcessState::default())
        .manage(tauri_worker::WorkerSidecarState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("App data directory is unavailable: {error}"))?;
            let home = app
                .path()
                .home_dir()
                .map_err(|error| format!("Home directory is unavailable: {error}"))?;
            let workspace = paths::default_workspace(&home);
            let service =
                workbench::WorkbenchService::open(app_data.join("workbench.sqlite3"), workspace)?;
            app.manage(service);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tauri_codex::start_codex_app_server,
            tauri_codex::send_codex_app_server_line,
            tauri_codex::stop_codex_app_server,
            tauri_worker::start_worker_sidecar,
            tauri_worker::send_worker_sidecar_line,
            tauri_worker::stop_worker_sidecar,
            tauri_workbench::load_desktop_state,
            tauri_workbench::ppt_create_project,
            tauri_workbench::ppt_load_pipeline,
            tauri_workbench::ppt_project_directory,
            tauri_workbench::workspace_directory,
            tauri_workbench::ppt_read_artifact,
            tauri_workbench::ppt_prepare_qa,
            tauri_workbench::ppt_attach_source,
            tauri_workbench::ppt_commit_pipeline,
            tauri_workbench::ppt_rename_project,
            tauri_workbench::ppt_regenerate_slide,
            tauri_workbench::ppt_approve_slide,
            tauri_workbench::ppt_reopen_slide,
            tauri_workbench::ppt_export_project,
            tauri_workbench::approval_decide,
            tauri_workbench::memory_decide,
            tauri_workbench::memory_propose,
            tauri_workbench::save_desktop_settings,
            tauri_workbench::ppt_record_source_analysis,
            tauri_workbench::ppt_submit_outline,
            tauri_workbench::ppt_approve_outline,
            tauri_workbench::ppt_approve_details,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Digital Twin Workbench");
}
