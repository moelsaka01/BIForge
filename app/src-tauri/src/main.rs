#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod data;
mod dax;
mod host;
mod p2p;
mod pq;
mod publish;
mod syskeys;

/// The real-window test (app/e2e) drives the app over the DevTools protocol. WebView2 reads the port from an environment
/// variable on most runtime versions, but not on all (the 154 runtime of the CI image ignores it), so the test asks the app
/// itself: when BIFORGE_TEST_DEBUG_PORT is set, the windows are created with that debugging port. Inert when unset.
fn apply_test_debug_port(context: &mut tauri::Context) {
    if let Ok(port) = std::env::var("BIFORGE_TEST_DEBUG_PORT") {
        if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() {
            for w in context.config_mut().app.windows.iter_mut() {
                w.additional_browser_args = Some(format!("--remote-debugging-port={port}"));
            }
        }
    }
}

fn main() {
    let mut context = tauri::generate_context!();
    apply_test_debug_port(&mut context);
    let p2p_service = std::sync::Arc::new(p2p::P2pService::system());
    let bridge: std::sync::Arc<dyn biforge_publish::p2p::P2pBridge> = p2p_service.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(data::DataService::system())
        .manage(publish::PublishService::system().with_p2p(bridge))
        .manage(p2p_service)
        .manage(host::HostService::system())
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
            data::engine_set_header_secret,
            data::engine_source_choices,
            data::engine_odbc_drivers,
            data::engine_credential_exists,
            data::engine_clear_credential,
            data::engine_source_preview,
            publish::publish_adapters,
            publish::publish_targets,
            publish::publish_put_target,
            publish::publish_delete_target,
            publish::publish_validate,
            publish::publish_run,
            publish::publish_unpublish,
            publish::publish_enable_refresh,
            publish::publish_disable_refresh,
            publish::publish_refresh_now,
            publish::publish_share_link,
            publish::publish_access_key,
            publish::storage_connect_start,
            publish::storage_connect_status,
            publish::publish_versions,
            publish::publish_share_with,
            publish::publish_allow_overwrite,
            publish::publish_status,
            publish::publish_audit,
            publish::package_peek,
            publish::package_open,
            publish::deep_link_parse,
            publish::startup_open,
            publish::account_connected,
            publish::account_connect,
            publish::account_disconnect,
            publish::publish_authenticate,
            publish::linked_fetch,
            publish::subscription_accept,
            publish::subscriptions,
            publish::subscription_remove,
            publish::subscription_check,
            publish::subscription_opened,
            publish::viewer_key,
            host::host_status,
            host::host_start,
            host::host_stop,
            host::server_join,
            host::server_connections,
            host::server_forget,
            host::server_op,
            host::server_open_report,
            p2p::p2p_host_state,
            p2p::p2p_approve,
            p2p::p2p_deny,
            p2p::p2p_revoke,
            p2p::p2p_take_push,
            p2p::p2p_join,
            p2p::p2p_guest_state,
            p2p::p2p_push,
            p2p::p2p_leave,
        ])
        .run(context)
        .expect("error while running BIForge");
}
