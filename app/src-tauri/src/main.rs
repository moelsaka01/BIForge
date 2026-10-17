#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod data;
mod dax;
mod pq;
mod publish;
mod syskeys;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(data::DataService::system())
        .manage(publish::PublishService::system())
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
            commands::test_pick,
            commands::read_image_data_uri,
            commands::open_url,
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
            publish::publish_adapters,
            publish::publish_targets,
            publish::publish_put_target,
            publish::publish_delete_target,
            publish::publish_validate,
            publish::publish_run,
            publish::publish_unpublish,
            publish::publish_share_link,
            publish::publish_access_key,
            publish::publish_status,
            publish::publish_audit,
            publish::package_peek,
            publish::package_open,
            publish::deep_link_parse,
            publish::startup_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BIForge");
}
