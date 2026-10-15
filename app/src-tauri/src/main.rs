#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::new_project,
            commands::open_project,
            commands::save_project,
            commands::write_recovery,
            commands::read_recovery,
            commands::clear_recovery,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BIForge");
}
