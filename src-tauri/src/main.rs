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

fn main() {
    let mut builder = tauri::Builder::default();

    // A second launch focuses the running window instead of opening another
    // view onto the same database. A custom data folder is a separate
    // workspace, so it may run alongside.
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
            app.manage(db);
            app.manage(place);
            // The sign-in: in the app's own folder, never the notes folder.
            app.manage(secrets::Secrets::new(app.path().app_local_data_dir()?.join("secrets")));

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
            commands::sync_pending,
            commands::sync_sent,
            commands::sync_apply,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Thought Desk");
}
