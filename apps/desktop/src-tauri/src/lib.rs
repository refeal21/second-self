pub mod codex_process;
pub mod database;
mod legacy_frames;
#[cfg(test)]
mod legacy_frames_tests;
mod native_revision_validation;
pub mod paths;
pub mod presales;
pub mod presales_queue;
pub mod presales_v3;
pub mod tauri_codex;
pub mod tauri_workbench;
pub mod tauri_worker;
pub mod visual_style;
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
            let v3 = std::sync::Arc::new(presales_v3::V3WorkbenchService::bundled(
                app.handle(),
                &service,
                &app_data.join("presales-v3.sqlite3"),
            )?);
            let supervisor =
                presales_v3::runtime_host::QueueSupervisor::bundled(app.handle(), v3.clone())?;
            app.manage(v3);
            app.manage(std::sync::Arc::new(supervisor));
            app.manage(service);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            presales_v3::commands::presales_v3_list,
            presales_v3::commands::presales_v3_load,
            presales_v3::commands::presales_v3_queue,
            presales_v3::commands::presales_v3_read_image,
            presales_v3::commands::presales_v3_enqueue,
            presales_v3::commands::presales_v3_settings,
            presales_v3::commands::presales_v3_save_pair,
            presales_v3::commands::presales_v3_approve_pair,
            presales_v3::commands::presales_v3_draft_settings,
            presales_v3::commands::presales_v3_promote,
            presales_v3::commands::presales_v3_author,
            presales_v3::commands::presales_v3_text_history,
            presales_v3::commands::presales_v3_save_feedback,
            presales_v3::commands::presales_v3_approve_version,
            presales_v3::commands::presales_v3_adopt_version,
            presales_v3::commands::presales_v3_cancel,
            presales_v3::commands::presales_v3_abandon,
            presales_v3::commands::presales_v3_retry_save,
            presales_v3::commands::presales_v3_delivery,
            presales_v3::commands::presales_v3_prepare_copy,
            presales_v3::commands::presales_v3_publish_copy,
            presales_v3::commands::presales_v3_discard_copy,
            presales_v3::commands::presales_v3_restore_approval,
            presales_v3::commands::presales_v3_set_references,
            presales_v3::picker::presales_v3_pick_reference,
            tauri_codex::start_codex_app_server,
            tauri_codex::send_codex_app_server_line,
            tauri_codex::stop_codex_app_server,
            tauri_worker::start_worker_sidecar,
            tauri_worker::send_worker_sidecar_line,
            tauri_worker::stop_worker_sidecar,
            tauri_workbench::load_desktop_state,
            tauri_workbench::ppt_create_project,
            tauri_workbench::ppt_load_pipeline,
            tauri_workbench::ppt_load_checkpoint,
            tauri_workbench::ppt_load_visual_style,
            tauri_workbench::ppt_save_visual_style,
            tauri_workbench::ppt_begin_visual_request,
            tauri_workbench::ppt_visual_records,
            tauri_workbench::ppt_project_directory,
            tauri_workbench::workspace_directory,
            tauri_workbench::ppt_read_artifact,
            tauri_workbench::ppt_prepare_qa,
            tauri_workbench::ppt_attach_source,
            tauri_workbench::ppt_commit_pipeline,
            tauri_workbench::ppt_commit_checkpoint,
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
        .build(tauri::generate_context!())
        .expect("error while building Digital Twin Workbench")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<std::sync::Arc<presales_v3::runtime_host::QueueSupervisor>>()
                    .shutdown();
            }
        });
}
