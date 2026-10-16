#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod data;
mod dax;
mod pq;
mod syskeys;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(data::DataService::system())
        .setup(|app| {
            // an Alt tap must not start Windows' menu mode, which swallows the next key (Print Screen)
            #[cfg(windows)]
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                if let Ok(h) = w.hwnd() {
                    syskeys::install(h.0 as isize);
                }
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::new_project,
            commands::open_project,
            commands::save_project,
            commands::write_recovery,
            commands::read_recovery,
            commands::clear_recovery,
            commands::tmdl_print,
            commands::tmdl_parse,
            commands::write_sample_data,
            dax::dax_catalog,
            dax::dax_check,
            dax::dax_query,
            pq::m_parse_query,
            pq::m_check,
            pq::m_apply_transform,
            pq::m_edit_step,
            pq::m_dependencies,
            pq::m_folder_query,
            pq::m_analyze,
            pq::m_preview,
            pq::m_load,
            pq::m_query_kinds,
            data::engine_open_store,
            data::engine_sqlserver_tables,
            data::engine_copy_store,
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
