#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod data;
mod dax;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(data::DataService::system())
        .invoke_handler(tauri::generate_handler![
            commands::new_project,
            commands::open_project,
            commands::save_project,
            commands::write_recovery,
            commands::read_recovery,
            commands::clear_recovery,
            dax::dax_catalog,
            dax::dax_check,
            dax::dax_query,
            data::engine_open_store,
            data::engine_import,
            data::engine_table_info,
            data::engine_drop_table,
            data::engine_fetch_page,
            data::engine_suggest_relationship,
            data::engine_excel_sheets,
            data::engine_sqlite_tables,
            data::engine_postgres_tables,
            data::engine_set_credential,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BIForge");
}
