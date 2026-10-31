//! Commands invoked from the frontend.
//!
//! Anything that touches the database or the disk is `async`: it runs on a
//! worker thread, so a slow query never stalls the window (dragging,
//! resizing, painting). The few left synchronous are instant or must run on
//! the main thread.

use crate::cards::{Card, Deck, Review};
use crate::databases::{Change, CreatedDatabase, CreatedRow, Database, DatabaseInput, ListedRow, NewRow, RowChange, SchemaItem};
use crate::db::{Db, Error, Page, PageContent, PageMeta, PagePatch, Result, SearchHit, Table};
use crate::export::{Export, ExportEntry};
use crate::library::{FileMeta, FilePatch, FileUsage};
use crate::location::{FolderState, Location};
use crate::organize::{Tag, Todo};
use crate::planner::{Assignment, AssignmentPatch, Course, CoursePatch, Event, EventPatch, OccurrencePage};
use crate::reminders::{Reminder, Reminders};
use crate::secrets::Secrets;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{ipc::InvokeBody, AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command(async)]
pub fn list_pages(db: State<Db>) -> Result<Vec<PageMeta>> {
    db.list_pages()
}

#[tauri::command(async)]
pub fn get_page(db: State<Db>, id: String) -> Result<Page> {
    db.get_page(&id)
}

#[tauri::command(async)]
pub fn create_page(
    db: State<Db>,
    parent_id: Option<String>,
    index: Option<usize>,
    title: Option<String>,
    icon: Option<String>,
) -> Result<PageMeta> {
    db.create_page(
        parent_id.as_deref(),
        index,
        title.as_deref().unwrap_or(""),
        icon.as_deref().unwrap_or(""),
    )
}

#[tauri::command(async)]
pub fn update_page(db: State<Db>, id: String, patch: PagePatch) -> Result<i64> {
    db.update_page(&id, patch)
}

#[tauri::command(async)]
pub fn move_page(db: State<Db>, id: String, parent_id: Option<String>, index: usize) -> Result<()> {
    db.move_page(&id, parent_id.as_deref(), index)
}

#[tauri::command(async)]
pub fn duplicate_page(db: State<Db>, id: String) -> Result<PageMeta> {
    db.duplicate_page(&id)
}

#[tauri::command(async)]
pub fn trash_page(db: State<Db>, id: String) -> Result<i64> {
    db.trash_page(&id)
}

#[tauri::command(async)]
pub fn restore_page(db: State<Db>, id: String) -> Result<()> {
    db.restore_page(&id)
}

#[tauri::command(async)]
pub fn delete_page(db: State<Db>, id: String) -> Result<()> {
    db.delete_page(&id)
}

#[tauri::command(async)]
pub fn empty_trash(db: State<Db>) -> Result<()> {
    db.empty_trash()
}

#[tauri::command(async)]
pub fn search(db: State<Db>, query: String, limit: Option<usize>) -> Result<Vec<SearchHit>> {
    db.search(&query, limit.unwrap_or(30))
}

/// Decodes the percent-encoding the frontend uses for header values (HTTP
/// headers can't carry arbitrary Unicode file names).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Adds an uploaded file (raw request body) to the library. Its name and
/// type come in the percent-encoded `x-name` and `x-mime` headers.
#[tauri::command(async)]
pub fn save_file(db: State<Db>, request: tauri::ipc::Request<'_>) -> Result<FileMeta> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error("Expected raw file bytes".into()));
    };
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
            .unwrap_or_default()
    };
    db.import_file(bytes, &header("x-name"), &header("x-mime"))
}

#[tauri::command(async)]
pub fn list_files(db: State<Db>) -> Result<Vec<FileMeta>> {
    db.list_files()
}

#[tauri::command(async)]
pub fn update_file(db: State<Db>, id: String, patch: FilePatch) -> Result<FileMeta> {
    db.update_file(&id, patch)
}

#[tauri::command(async)]
pub fn file_usage(db: State<Db>) -> Result<Vec<FileUsage>> {
    db.file_usage()
}

/// Opens a library file in its default app.
#[tauri::command(async)]
pub fn open_file(app: AppHandle, db: State<Db>, id: String) -> Result<()> {
    let (path, _) = db.file_path(&id)?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| Error(e.to_string()))
}

/// Shows a library file in Explorer / Finder.
#[tauri::command(async)]
pub fn reveal_file(app: AppHandle, db: State<Db>, id: String) -> Result<()> {
    let (path, _) = db.file_path(&id)?;
    app.opener().reveal_item_in_dir(path).map_err(|e| Error(e.to_string()))
}

/// Copies a library file into Downloads under its display name.
#[tauri::command(async)]
pub fn export_file(app: AppHandle, db: State<Db>, id: String) -> Result<String> {
    let (path, name) = db.file_path(&id)?;
    let target = unique_path(&app.path().download_dir()?, &safe_file_name(&name), "");
    std::fs::copy(&path, &target)?;
    Ok(target.to_string_lossy().into_owned())
}

/// A name that's valid on every OS: reserved characters become spaces.
fn safe_file_name(name: &str) -> String {
    let base: String = name
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect();
    if base.is_empty() || base.chars().all(|c| c == '.') {
        "Untitled".to_string()
    } else {
        base
    }
}

/// `dir/name` (+ `ext`), adding " (2)", " (3)"… until nothing is overwritten.
fn unique_path(dir: &Path, name: &str, ext: &str) -> PathBuf {
    let (stem, dot_ext) = if ext.is_empty() {
        match name.rsplit_once('.') {
            Some((stem, e)) if !stem.is_empty() => (stem.to_string(), format!(".{e}")),
            _ => (name.to_string(), String::new()),
        }
    } else {
        (name.to_string(), format!(".{ext}"))
    };
    let mut path = dir.join(format!("{stem}{dot_ext}"));
    let mut n = 1;
    while path.exists() {
        n += 1;
        path = dir.join(format!("{stem} ({n}){dot_ext}"));
    }
    path
}

// ---------------------------------------------------------- planner commands

#[tauri::command(async)]
pub fn list_courses(db: State<Db>) -> Result<Vec<Course>> {
    db.list_courses()
}

#[tauri::command(async)]
pub fn create_course(db: State<Db>, name: String, color: String) -> Result<Course> {
    db.create_course(&name, &color)
}

#[tauri::command(async)]
pub fn reorder_courses(db: State<Db>, ids: Vec<String>) -> Result<()> {
    db.reorder_courses(&ids)
}

#[tauri::command(async)]
pub fn update_course(db: State<Db>, id: String, patch: CoursePatch) -> Result<Course> {
    db.update_course(&id, patch)
}

#[tauri::command(async)]
pub fn delete_course(db: State<Db>, id: String) -> Result<()> {
    db.delete_course(&id)
}

#[tauri::command(async)]
pub fn list_assignments(db: State<Db>) -> Result<Vec<Assignment>> {
    db.list_assignments()
}

#[tauri::command(async)]
pub fn create_assignment(db: State<Db>, input: AssignmentPatch) -> Result<Assignment> {
    db.create_assignment(input)
}

#[tauri::command(async)]
pub fn update_assignment(db: State<Db>, id: String, patch: AssignmentPatch) -> Result<Assignment> {
    db.update_assignment(&id, patch)
}

#[tauri::command(async)]
pub fn list_events(db: State<Db>) -> Result<Vec<Event>> {
    db.list_events()
}

#[tauri::command(async)]
pub fn create_event(db: State<Db>, input: EventPatch) -> Result<Event> {
    db.create_event(input)
}

#[tauri::command(async)]
pub fn update_event(db: State<Db>, id: String, patch: EventPatch) -> Result<Event> {
    db.update_event(&id, patch)
}

// ---------------------------------------------------- tags, links, to-dos

#[tauri::command(async)]
pub fn list_tags(db: State<Db>) -> Result<Vec<Tag>> {
    db.list_tags()
}

#[tauri::command(async)]
pub fn set_item_tags(db: State<Db>, table: Table, id: String, tags: Vec<String>) -> Result<Vec<String>> {
    db.set_item_tags(table, &id, &tags)
}

#[tauri::command(async)]
pub fn set_tag_color(db: State<Db>, name: String, color: String) -> Result<()> {
    db.set_tag_color(&name, &color)
}

/// Renames a tag everywhere, or deletes it when `to` is null.
#[tauri::command(async)]
pub fn rename_tag(db: State<Db>, from: String, to: Option<String>) -> Result<()> {
    db.rename_tag(&from, to.as_deref())
}

#[tauri::command(async)]
pub fn backlinks(db: State<Db>, id: String) -> Result<Vec<String>> {
    db.backlinks(&id)
}

#[tauri::command(async)]
pub fn link_graph(db: State<Db>) -> Result<Vec<(String, String)>> {
    db.link_graph()
}

#[tauri::command(async)]
pub fn page_words(db: State<Db>) -> Result<Vec<(String, u32)>> {
    db.page_words()
}

#[tauri::command(async)]
pub fn galaxy_seed(db: State<Db>) -> Result<u32> {
    db.galaxy_seed()
}

#[tauri::command(async)]
pub fn list_todos(db: State<Db>) -> Result<Vec<Todo>> {
    db.list_todos()
}

#[tauri::command(async)]
pub fn set_todo(db: State<Db>, page_id: String, index: usize, key: String, checked: bool) -> Result<i64> {
    db.set_todo(&page_id, index, &key, checked)
}

/// Sets the system-wide Quick Capture shortcut ("CmdOrCtrl+Shift+Space"),
/// or turns it off.
#[tauri::command]
pub fn set_capture_shortcut(app: AppHandle, enabled: bool, accelerator: String) -> Result<()> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let gs = app.global_shortcut();
    let shortcut: Option<Shortcut> = if enabled {
        Some(accelerator.parse().map_err(|_| Error(format!("“{accelerator}” isn't a shortcut Windows can use")))?)
    } else {
        None
    };
    if let Some(s) = shortcut {
        if gs.is_registered(s) {
            return Ok(());
        }
    }
    gs.unregister_all().map_err(|e| Error(e.to_string()))?;
    if let Some(s) = shortcut {
        gs.register(s).map_err(|_| Error("That shortcut is already used by another app".into()))?;
    }
    Ok(())
}

/// Has the web view drop its graphics caches now (after closing Settings).
#[tauri::command]
pub fn trim_memory(webview: tauri::WebviewWindow) {
    crate::memory::trim(webview);
}

#[tauri::command(async)]
pub fn list_occurrence_pages(db: State<Db>) -> Result<Vec<OccurrencePage>> {
    db.list_occurrence_pages()
}

#[tauri::command(async)]
pub fn set_occurrence_page(db: State<Db>, event_id: String, date: String, page_id: String) -> Result<()> {
    db.set_occurrence_page(&event_id, &date, &page_id)
}

/// Replaces the upcoming reminders (the UI resends them whenever things change).
#[tauri::command]
pub fn set_reminders(reminders: State<Reminders>, list: Vec<Reminder>) {
    reminders.set(list);
}

// ------------------------------------------------------------ trash (items)

#[tauri::command(async)]
pub fn trash_item(db: State<Db>, table: Table, id: String) -> Result<i64> {
    db.trash_item(table, &id)
}

#[tauri::command(async)]
pub fn restore_item(db: State<Db>, table: Table, id: String) -> Result<()> {
    db.restore_item(table, &id)
}

#[tauri::command(async)]
pub fn delete_item(db: State<Db>, table: Table, id: String) -> Result<()> {
    db.delete_item(table, &id)
}

/// Writes a Markdown export into the user's Downloads folder.
#[tauri::command(async)]
pub fn export_markdown(app: AppHandle, title: String, markdown: String) -> Result<String> {
    let dir = app.path().download_dir()?;
    let path = unique_path(&dir, &safe_file_name(&title), "md");
    std::fs::write(&path, markdown)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Saves an exported document (raw request body) to Downloads. The title
/// and extension come in the percent-encoded `x-name` and `x-ext` headers.
#[tauri::command(async)]
pub fn export_document(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error("Expected raw file bytes".into()));
    };
    let header = |key: &str| {
        request.headers().get(key).and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default()
    };
    let ext = header("x-ext");
    if !matches!(ext.as_str(), "docx" | "md" | "html" | "csv") {
        return Err(Error("Unsupported export format".into()));
    }
    let dir = app.path().download_dir()?;
    let path = unique_path(&dir, &safe_file_name(&header("x-name")), &ext);
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Saves the open page (already in its print styles) as a PDF in Downloads.
#[tauri::command(async)]
pub fn export_pdf(app: AppHandle, title: String) -> Result<String> {
    let window = app.get_webview_window("main").ok_or_else(|| Error("No window to print".into()))?;
    let path = unique_path(&app.path().download_dir()?, &safe_file_name(&title), "pdf");
    crate::pdf::print_to_pdf(&window, &path)?;
    Ok(path.to_string_lossy().into_owned())
}

/// The bodies of many pages at once, for exporting the workspace.
#[tauri::command(async)]
pub fn page_contents(db: State<Db>, ids: Vec<String>) -> Result<Vec<PageContent>> {
    db.page_contents(&ids)
}

/// Starts exporting the workspace: makes a new folder in Downloads (named
/// `name`, made unique) for `export_write` to fill, and returns its path.
#[tauri::command(async)]
pub fn export_begin(app: AppHandle, export: State<Export>, name: String) -> Result<String> {
    let dir = unique_path(&app.path().download_dir()?, &safe_file_name(&name), "");
    export.begin(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Writes files into the folder `export_begin` made.
#[tauri::command(async)]
pub fn export_write(db: State<Db>, export: State<Export>, entries: Vec<ExportEntry>) -> Result<()> {
    export.write(&db.files_dir, &entries)
}

/// Shows the last export's folder in Explorer.
#[tauri::command(async)]
pub fn export_reveal(app: AppHandle, export: State<Export>) -> Result<()> {
    app.opener().reveal_item_in_dir(export.dir()?).map_err(|e| Error(e.to_string()))
}

// ---------------------------------------------------------------- account

/// Starts the one-time listener the browser comes back to after signing in
/// with Google or GitHub (see auth.rs); returns its port.
#[tauri::command(async)]
pub fn auth_listen(app: AppHandle) -> Result<u16> {
    Ok(crate::auth::listen(app)?)
}

/// The sign-in, kept encrypted on this computer (see secrets.rs).
#[tauri::command(async)]
pub fn secret_get(secrets: State<Secrets>, name: String) -> Result<Option<String>> {
    secrets.get(&name)
}

#[tauri::command(async)]
pub fn secret_set(secrets: State<Secrets>, name: String, value: String) -> Result<()> {
    secrets.set(&name, &value)
}

#[tauri::command(async)]
pub fn secret_remove(secrets: State<Secrets>, name: String) -> Result<()> {
    secrets.remove(&name)
}

/// A system notification (news from friends while the window is in the background).
/// An empty body leaves out the second line.
#[tauri::command(async)]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<()> {
    use tauri_plugin_notification::NotificationExt;
    let mut note = app.notification().builder().title(title);
    if !body.is_empty() {
        note = note.body(body);
    }
    note.show().map_err(|e| Error(e.to_string()))
}

// ---------------------------------------------------------------- cowork

/// Shares a page live in `room` (its invite code), or stops sharing it here.
#[tauri::command(async)]
pub fn set_page_shared(db: State<Db>, id: String, room: Option<String>) -> Result<()> {
    db.set_shared_room(&id, room.as_deref())
}

/// A shared page's Yjs state, as raw bytes (empty when none is kept yet).
#[tauri::command(async)]
pub fn get_page_yjs(db: State<Db>, id: String) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(db.page_yjs(&id)?))
}

/// Keeps a shared page's Yjs state (raw request body; the page id comes in
/// the `x-id` header).
#[tauri::command(async)]
pub fn save_page_yjs(db: State<Db>, request: tauri::ipc::Request<'_>) -> Result<()> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error("Expected raw bytes".into()));
    };
    let id = request.headers().get("x-id").and_then(|v| v.to_str().ok()).unwrap_or_default();
    db.save_page_yjs(id, bytes)
}

// ---------------------------------------------------------------- flashcards

#[tauri::command(async)]
pub fn list_cards(db: State<Db>) -> Result<Vec<Card>> {
    db.list_cards()
}

/// Each page's cards, counted for `today` ("YYYY-MM-DD").
#[tauri::command(async)]
pub fn list_decks(db: State<Db>, today: String) -> Result<Vec<Deck>> {
    db.list_decks(&today)
}

#[tauri::command(async)]
pub fn save_review(db: State<Db>, page_id: String, card_id: String, review: Review) -> Result<()> {
    db.save_review(&page_id, &card_id, &review)
}

/// Undoes a card's only review: it's new again.
#[tauri::command(async)]
pub fn forget_review(db: State<Db>, page_id: String, card_id: String) -> Result<()> {
    db.forget_review(&page_id, &card_id)
}

#[tauri::command(async)]
pub fn reset_reviews(db: State<Db>, page_id: String) -> Result<()> {
    db.reset_reviews(&page_id)
}

// ----------------------------------------------------------------- databases

#[tauri::command(async)]
pub fn list_databases(db: State<Db>) -> Result<Vec<Database>> {
    db.list_databases()
}

#[tauri::command(async)]
pub fn list_rows(db: State<Db>, db_ids: Option<Vec<String>>) -> Result<Vec<ListedRow>> {
    db.list_rows_raw(db_ids.as_deref())
}

#[tauri::command(async)]
pub fn list_rows_head(db: State<Db>, db_id: String, limit: usize) -> Result<Vec<ListedRow>> {
    db.list_rows_head(&db_id, limit)
}

#[tauri::command(async)]
pub fn row_counts(db: State<Db>) -> Result<std::collections::HashMap<String, usize>> {
    db.row_counts()
}

#[tauri::command(async)]
pub fn create_database(
    db: State<Db>,
    parent_id: Option<String>,
    title: String,
    icon: String,
    input: DatabaseInput,
) -> Result<CreatedDatabase> {
    db.create_database(parent_id.as_deref(), &title, &icon, input)
}

#[tauri::command(async)]
pub fn update_database(db: State<Db>, id: String, description: String) -> Result<()> {
    db.update_database(&id, &description)
}

#[tauri::command(async)]
pub fn save_property(db: State<Db>, db_id: String, property: SchemaItem) -> Result<()> {
    db.save_property(&db_id, property)
}

#[tauri::command(async)]
pub fn delete_property(db: State<Db>, db_id: String, id: String) -> Result<()> {
    db.delete_property(&db_id, &id)
}

#[tauri::command(async)]
pub fn save_view(db: State<Db>, db_id: String, view: SchemaItem) -> Result<()> {
    db.save_view(&db_id, view)
}

#[tauri::command(async)]
pub fn delete_view(db: State<Db>, db_id: String, id: String) -> Result<()> {
    db.delete_view(&db_id, &id)
}

#[tauri::command(async)]
pub fn save_automation(db: State<Db>, db_id: String, automation: SchemaItem) -> Result<()> {
    db.save_automation(&db_id, automation)
}

#[tauri::command(async)]
pub fn delete_automation(db: State<Db>, db_id: String, id: String) -> Result<()> {
    db.delete_automation(&db_id, &id)
}

#[tauri::command(async)]
pub fn create_rows(db: State<Db>, db_id: String, rows: Vec<NewRow>) -> Result<Vec<CreatedRow>> {
    db.create_rows(&db_id, rows)
}

/// Sets row values and order; returns the rows' new "last edited" time.
#[tauri::command(async)]
pub fn update_rows(db: State<Db>, changes: Vec<RowChange>) -> Result<i64> {
    db.update_rows(changes)
}

/// What changed since the last sync (for the sync service, when there is one).
#[tauri::command(async)]
pub fn sync_pending(db: State<Db>) -> Result<Vec<Change>> {
    db.sync_pending()
}

#[tauri::command(async)]
pub fn sync_sent(db: State<Db>, clock: String) -> Result<()> {
    db.sync_sent(&clock)
}

#[tauri::command(async)]
pub fn sync_apply(db: State<Db>, changes: Vec<Change>) -> Result<()> {
    db.sync_apply(changes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    data_dir: String,
    /// The app's own folder, where notes are kept unless another is chosen.
    default_dir: String,
    /// The notes are in a folder the user chose.
    chosen_dir: bool,
    /// THOUGHTDESK_DATA_DIR set the folder, so it can't be changed here.
    env_dir: bool,
    /// A chosen folder that wasn't there at start-up.
    missing_dir: Option<String>,
    db_bytes: u64,
    file_bytes: u64,
    /// Live files in the library.
    file_count: i64,
    page_count: i64,
    assignment_count: i64,
    event_count: i64,
    version: String,
}

#[tauri::command(async)]
pub fn data_info(app: AppHandle, db: State<Db>, place: State<Location>) -> Result<DataInfo> {
    let size = |name: &str| {
        std::fs::metadata(db.data_dir.join(name))
            .map(|m| m.len())
            .unwrap_or(0)
    };
    let db_bytes = size("thoughtdesk.db") + size("thoughtdesk.db-wal");
    let mut file_bytes = 0;
    if let Ok(entries) = std::fs::read_dir(&db.files_dir) {
        for e in entries.flatten() {
            if let Ok(m) = e.metadata() {
                file_bytes += m.len();
            }
        }
    }
    Ok(DataInfo {
        data_dir: db.data_dir.to_string_lossy().into_owned(),
        default_dir: place.default_dir.to_string_lossy().into_owned(),
        chosen_dir: place.chosen,
        env_dir: place.from_env,
        missing_dir: place.missing.as_ref().map(|d| d.to_string_lossy().into_owned()),
        db_bytes,
        file_bytes,
        file_count: db.live_count(Table::Files)?,
        page_count: db.live_count(Table::Pages)?,
        assignment_count: db.live_count(Table::Assignments)?,
        event_count: db.live_count(Table::Events)?,
        version: app.package_info().version.to_string(),
    })
}

/// What a folder holds, before keeping notes there.
#[tauri::command(async)]
pub fn data_folder_check(db: State<Db>, dir: String) -> Result<FolderState> {
    let dir = PathBuf::from(dir);
    if crate::location::same_folder(&dir, &db.data_dir) {
        return Err(Error("Your notes are already in that folder".into()));
    }
    Ok(crate::location::inspect(&dir))
}

/// Keeps notes in `dir` from the next start: a copy of these notes, or
/// (`open_existing`) the notes the folder already has. The app restarts after.
#[tauri::command(async)]
pub fn data_folder_move(db: State<Db>, place: State<Location>, dir: String, open_existing: bool) -> Result<()> {
    if place.from_env {
        return Err(Error("THOUGHTDESK_DATA_DIR sets where notes are kept".into()));
    }
    let dir = PathBuf::from(dir);
    if open_existing {
        if !crate::location::inspect(&dir).has_notes {
            return Err(Error("That folder has no notes to open".into()));
        }
    } else {
        db.copy_to(&dir, false)?;
    }
    crate::location::remember(&place.default_dir, Some(&dir))
}

/// Keeps notes in the app's own folder again, from the next start: a copy
/// of these notes (older ones there are set aside, not deleted).
#[tauri::command(async)]
pub fn data_folder_reset(db: State<Db>, place: State<Location>) -> Result<()> {
    if place.from_env {
        return Err(Error("THOUGHTDESK_DATA_DIR sets where notes are kept".into()));
    }
    if !crate::location::same_folder(&place.default_dir, &db.data_dir) {
        db.copy_to(&place.default_dir, true)?;
    }
    crate::location::remember(&place.default_dir, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_header_names() {
        assert_eq!(percent_decode("Lab%20report%20%E2%80%94%20v2.pdf"), "Lab report — v2.pdf");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz.txt"), "%zz.txt");
    }

    #[test]
    fn safe_unique_names() {
        assert_eq!(safe_file_name("a/b:c?.pdf"), "a b c .pdf");
        assert_eq!(safe_file_name("..."), "Untitled");
        let dir = std::env::temp_dir().join(format!("td-names-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Essay.docx"), b"").unwrap();
        assert_eq!(unique_path(&dir, "Essay.docx", ""), dir.join("Essay (2).docx"));
        assert_eq!(unique_path(&dir, "Notes", "md"), dir.join("Notes.md"));
    }
}
