pub mod codex_process;
pub mod database;
pub mod paths;
pub mod tauri_codex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(tauri_codex::CodexProcessState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            tauri_codex::start_codex_app_server,
            tauri_codex::send_codex_app_server_line,
            tauri_codex::stop_codex_app_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Digital Twin Workbench");
}
