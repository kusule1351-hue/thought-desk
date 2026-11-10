// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod cards;
mod commands;
mod cowork;
mod databases;
mod db;
mod export;
mod files;
mod library;
mod location;
mod memory;
mod organize;
mod pdf;
mod planner;
mod reminders;
mod secrets;
mod sync;
#[cfg(test)]
mod stress;
#[cfg(test)]
mod testutil;

use std::path::PathBuf;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_window_state::StateFlags;

/// THOUGHTDESK_DATA_DIR points the app at another notes folder (portable
/// installs, or a scratch copy for testing).
fn custom_data_dir() -> Option<PathBuf> {
    std::env::var_os("THOUGHTDESK_DATA_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
}

/// A name for this install that lives in the app's own folder, never the notes
/// folder (which may be copied or synced): made on first use.
fn install_id(dir: &std::path::Path) -> Option<String> {
    let file = dir.join("install-id");
    if let Ok(text) = std::fs::read_to_string(&file) {
        let id = text.trim().to_string();
        if uuid::Uuid::parse_str(&id).is_ok() {
            return Some(id);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(&file, &id).ok()?;
    Some(id)
}

fn main() {
    let mut builder = tauri::Builder::default();

    // A second launch focuses the running window instead of opening another
    // view onto the same database. A custom data folder is a separate
    // workspace, so it may run alongside.
    //
    // This is also all a thoughtdesk:// link does on Windows and Linux: the
    // system starts the app again with the link as its argument, and that
    // launch lands here. Any website can open such a link, so the arguments
    // stay unread: whatever the link says, the window comes forward and
    // nothing else happens.
    if custom_data_dir().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        // The thoughtdesk:// scheme (tauri.conf.json), which the installers
        // register so the page after signing in can link back to the app
        // (auth.rs). On macOS the system brings the app forward by itself.
        // Nothing listens for the link and the interface has no permission to
        // read it. Keep it so: any website can open one, so a handler for it
        // would be taking orders from strangers (auth.rs has a test for this).
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(reminders::Reminders::default())
        .manage(export::Export::default())
        .plugin(
            // Quick Capture from anywhere: bring the window up and ask the UI
            // to open the capture box. Registered on demand (Settings).
            tauri_plugin_global_shortcut::Builder::new()
                // Quick Capture is the only shortcut registered.
                .with_handler(|app, _shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("td-quick-capture", ());
                })
                .build(),
        )
        .plugin(
            // Remember size, position and maximized state. Visibility is left
            // alone: the frontend shows the window once it has painted, which
            // avoids a white flash on startup.
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("tdfile", files::protocol)
        .setup(|app| {
            let default_dir = app.path().app_data_dir()?;
            let place = match custom_data_dir() {
                Some(dir) => location::Location { dir, default_dir, from_env: true, chosen: false, missing: None },
                None => location::resolve(&default_dir),
            };
            let db = db::Db::open(&place.dir).map_err(|e| e.0)?;
            // This install's name in sync stamps; without one sync falls back to the notes folder's.
            if let Some(id) = app.path().app_config_dir().ok().and_then(|dir| install_id(&dir)) {
                let _ = db.sync_set_install(&id);
            }
            app.manage(db);
            app.manage(place);
            // The sign-in: in the app's own folder, never the notes folder.
            app.manage(secrets::Secrets::new(app.path().app_local_data_dir()?.join("secrets")));
            app.manage(sync::vault::SyncVault::default());

            reminders::start(app.handle().clone());

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(20));
                files::collect_garbage(&handle.state::<db::Db>());
            });
            Ok(())
        })
        .on_window_event(memory::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::list_pages,
            commands::get_page,
            commands::create_page,
            commands::update_page,
            commands::move_page,
            commands::duplicate_page,
            commands::trash_page,
            commands::restore_page,
            commands::delete_page,
            commands::empty_trash,
            commands::search,
            commands::save_file,
            commands::list_files,
            commands::update_file,
            commands::file_usage,
            commands::open_file,
            commands::reveal_file,
            commands::export_file,
            commands::list_courses,
            commands::create_course,
            commands::reorder_courses,
            commands::update_course,
            commands::delete_course,
            commands::list_assignments,
            commands::create_assignment,
            commands::update_assignment,
            commands::list_events,
            commands::create_event,
            commands::update_event,
            commands::list_tags,
            commands::set_item_tags,
            commands::set_tag_color,
            commands::rename_tag,
            commands::backlinks,
            commands::link_graph,
            commands::page_words,
            commands::galaxy_seed,
            commands::list_todos,
            commands::set_todo,
            commands::set_capture_shortcut,
            commands::list_occurrence_pages,
            commands::set_occurrence_page,
            commands::set_reminders,
            commands::export_document,
            commands::export_pdf,
            commands::trim_memory,
            commands::list_cards,
            commands::list_decks,
            commands::save_review,
            commands::forget_review,
            commands::reset_reviews,
            commands::list_databases,
            commands::list_rows,
            commands::row_counts,
            commands::list_rows_head,
            commands::create_database,
            commands::update_database,
            commands::save_property,
            commands::delete_property,
            commands::save_view,
            commands::delete_view,
            commands::save_automation,
            commands::delete_automation,
            commands::create_rows,
            commands::update_rows,
            commands::trash_item,
            commands::restore_item,
            commands::delete_item,
            commands::export_markdown,
            commands::page_contents,
            commands::set_page_shared,
            commands::get_page_yjs,
            commands::save_page_yjs,
            commands::export_begin,
            commands::export_write,
            commands::export_reveal,
            commands::data_info,
            commands::auth_listen,
            commands::secret_get,
            commands::secret_set,
            commands::secret_remove,
            commands::notify,
            commands::data_folder_check,
            commands::data_folder_move,
            commands::data_folder_reset,
            commands::sync_vault_create,
            commands::sync_vault_join,
            commands::sync_vault_open,
            commands::sync_vault_forget,
            commands::sync_vault_proof,
            commands::sync_status,
            commands::sync_turn_on,
            commands::sync_mark_ready,
            commands::sync_turn_off,
            commands::sync_ingest,
            commands::sync_apply,
            commands::sync_seal_records,
            commands::sync_records_sent,
            commands::sync_text_todo,
            commands::sync_text_read,
            commands::sync_text_commit,
            commands::sync_seal_text,
            commands::sync_text_sent,
            commands::sync_text_refused,
            commands::sync_has_changes,
            commands::sync_audit,
            commands::sync_backup_delete,
            commands::sync_records_rebase,
            commands::sync_files_todo,
            commands::sync_file_names,
            commands::sync_file_seal,
            commands::sync_file_open,
            commands::sync_file_done,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Thought Desk");
}
