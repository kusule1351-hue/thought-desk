//! SQLite storage for pages.
//!
//! Pages form a tree (`parent_id`), are ordered among their siblings by an
//! integer `position`, and are soft-deleted into the trash via `deleted_at`.
//! Page bodies are stored as editor JSON; a plain-text copy lives in an FTS5
//! index (`pages_fts`, rowid = `pages.rid`) for full-text search.
//!
//! Courses, assignments and events live in `planner.rs`, the file library in
//! `library.rs`; both extend `Db` with their own `impl` blocks.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Error surfaced to the frontend as a plain string.
#[derive(Debug)]
pub struct Error(pub String);

impl<E: std::fmt::Display> From<E> for Error {
    fn from(e: E) -> Self {
        Error(e.to_string())
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

fn err<T>(msg: &str) -> Result<T> {
    Err(Error(msg.to_string()))
}

/// Tables whose rows go to the trash. Table names never come from the
/// frontend as text, so they can't be used to inject SQL.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Table {
    Pages,
    Assignments,
    Events,
    Files,
}

impl Table {
    pub fn name(self) -> &'static str {
        match self {
            Table::Pages => "pages",
            Table::Assignments => "assignments",
            Table::Events => "events",
            Table::Files => "files",
        }
    }
}

/// Builds a "not found"-style error for the other storage modules.
pub(crate) fn fail<T>(msg: &str) -> Result<T> {
    err(msg)
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub icon: String,
    pub position: i64,
    /// 0 when not a favorite, otherwise the time it was favorited.
    pub favorite: i64,
    pub full_width: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub tags: Vec<String>,
    /// "database" for a database page (its sub-pages are its rows), else "".
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    #[serde(flatten)]
    pub meta: PageMeta,
    pub content: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PagePatch {
    pub title: Option<String>,
    pub icon: Option<String>,
    pub content: Option<String>,
    /// Plain text of the page body, used for search.
    pub text: Option<String>,
    pub favorite: Option<bool>,
    pub full_width: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub icon: String,
    /// Body excerpt; matches are wrapped in \u{1} ... \u{2}.
    pub snippet: String,
    pub updated_at: i64,
}

const META_COLS: &str =
    "id, parent_id, title, icon, position, favorite, full_width, created_at, updated_at, deleted_at, tags, kind";

fn meta_from_row(r: &rusqlite::Row) -> rusqlite::Result<PageMeta> {
    Ok(PageMeta {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        title: r.get(2)?,
        icon: r.get(3)?,
        position: r.get(4)?,
        favorite: r.get(5)?,
        full_width: r.get::<_, i64>(6)? != 0,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        deleted_at: r.get(9)?,
        tags: crate::organize::parse_tags(&r.get::<_, String>(10)?),
        kind: r.get(11)?,
    })
}

const SCHEMA_V1: &str = "
CREATE TABLE pages (
  rid        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  parent_id  TEXT REFERENCES pages(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  icon       TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  favorite   INTEGER NOT NULL DEFAULT 0,
  full_width INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX pages_parent ON pages(parent_id, position);
CREATE VIRTUAL TABLE pages_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER pages_fts_delete AFTER DELETE ON pages BEGIN
  DELETE FROM pages_fts WHERE rowid = old.rid;
END;
";

/// Courses, assignments (with file attachments), calendar events and the file
/// library. Dates are local calendar dates ("YYYY-MM-DD") and times are local
/// wall-clock times ("HH:MM"), so a due date never shifts with the time zone.
const SCHEMA_V2: &str = "
CREATE TABLE courses (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT 'blue',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE assignments (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  course_id    TEXT REFERENCES courses(id) ON DELETE SET NULL,
  due_date     TEXT,
  due_time     TEXT,
  status       TEXT NOT NULL DEFAULT 'todo',
  priority     INTEGER NOT NULL DEFAULT 0,
  notes        TEXT NOT NULL DEFAULT '',
  page_id      TEXT REFERENCES pages(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at   INTEGER
);
CREATE INDEX assignments_due ON assignments(due_date);
CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  start_date   TEXT NOT NULL,
  start_time   TEXT,
  end_date     TEXT NOT NULL,
  end_time     TEXT,
  color        TEXT NOT NULL DEFAULT '',
  course_id    TEXT REFERENCES courses(id) ON DELETE SET NULL,
  location     TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  repeat       TEXT NOT NULL DEFAULT 'none',
  repeat_until TEXT,
  page_id      TEXT REFERENCES pages(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX events_start ON events(start_date);
CREATE TABLE files (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  stored     TEXT NOT NULL UNIQUE,
  mime       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE attachments (
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (assignment_id, file_id)
);
";

/// Tags on every kind of item (a JSON array of names), and tag colours.
const SCHEMA_V3: &str = "
ALTER TABLE pages ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE assignments ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE files ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
CREATE TABLE tags (
  name       TEXT PRIMARY KEY,
  color      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
";

/// Course details and notes folder, single-date exceptions for repeating
/// events, ids from imported calendars (so re-importing updates instead of
/// duplicating), and notes pages for single class sessions.
const SCHEMA_V4: &str = "
ALTER TABLE courses ADD COLUMN teacher TEXT NOT NULL DEFAULT '';
ALTER TABLE courses ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE courses ADD COLUMN office_hours TEXT NOT NULL DEFAULT '';
ALTER TABLE courses ADD COLUMN room TEXT NOT NULL DEFAULT '';
ALTER TABLE courses ADD COLUMN page_id TEXT REFERENCES pages(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN exdates TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN source_uid TEXT;
ALTER TABLE assignments ADD COLUMN source_uid TEXT;
CREATE TABLE occurrence_pages (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  date     TEXT NOT NULL,
  page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, date)
);
";

/// Grades (score, points possible and category on assignments; category
/// weights on courses) and spaced-repetition progress for flashcards.
const SCHEMA_V5: &str = "
ALTER TABLE assignments ADD COLUMN score REAL;
ALTER TABLE assignments ADD COLUMN max_score REAL;
ALTER TABLE assignments ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE courses ADD COLUMN weights TEXT NOT NULL DEFAULT '{}';
CREATE TABLE card_reviews (
  page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  card_id     TEXT NOT NULL,
  due         TEXT NOT NULL,
  interval    INTEGER NOT NULL,
  ease        REAL NOT NULL,
  reps        INTEGER NOT NULL,
  lapses      INTEGER NOT NULL,
  reviewed_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, card_id)
);
";

/// Page bodies move out of `pages` into their own table, so listing pages
/// (sidebar, search, counts) never reads through megabytes of text. Links,
/// to-dos and flashcards found in each body are kept alongside, refreshed on
/// every save, so backlinks, file usage, Home and Flashcards are lookups
/// instead of a parse of every page.
const SCHEMA_V6: &str = "
CREATE TABLE page_content (
  rid     INTEGER PRIMARY KEY,
  content TEXT NOT NULL DEFAULT ''
);
INSERT INTO page_content (rid, content) SELECT rid, content FROM pages;
ALTER TABLE pages DROP COLUMN content;
CREATE TABLE page_links (
  target   TEXT NOT NULL,
  page_rid INTEGER NOT NULL,
  PRIMARY KEY (target, page_rid)
) WITHOUT ROWID;
CREATE INDEX page_links_page ON page_links(page_rid);
CREATE TABLE page_derived (
  rid   INTEGER PRIMARY KEY,
  todos    TEXT NOT NULL DEFAULT '[]',
  cards    TEXT NOT NULL DEFAULT '[]',
  card_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE TRIGGER pages_side_delete AFTER DELETE ON pages BEGIN
  DELETE FROM page_content WHERE rid = old.rid;
  DELETE FROM page_links WHERE page_rid = old.rid;
  DELETE FROM page_derived WHERE rid = old.rid;
END;
";

/// Databases: a page of kind "database" whose sub-pages are its rows. The
/// schema (typed properties and saved views) and each row's values live in
/// their own tables (see databases.rs). Every record is shaped to merge
/// between devices later: stable ids, fractional order keys, a clock stamp
/// on each field, tombstones for deletes, and an outbox of what changed
/// (see sync.rs).
const SCHEMA_V7: &str = "
ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT '';
CREATE TABLE databases (
  page_id     TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  next_number INTEGER NOT NULL DEFAULT 1,
  clock       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE db_properties (
  db_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  id       TEXT NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  type     TEXT NOT NULL,
  config   TEXT NOT NULL DEFAULT '{}',
  sort_key TEXT NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0,
  clock    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (db_id, id)
) WITHOUT ROWID;
CREATE TABLE db_views (
  db_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  id       TEXT NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  type     TEXT NOT NULL,
  config   TEXT NOT NULL DEFAULT '{}',
  sort_key TEXT NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0,
  clock    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (db_id, id)
) WITHOUT ROWID;
CREATE TABLE db_rows (
  page_id  TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL,
  number   INTEGER NOT NULL DEFAULT 0,
  cells    TEXT NOT NULL DEFAULT '{}',
  clocks   TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE sync_outbox (
  entity TEXT NOT NULL,
  id     TEXT NOT NULL,
  clock  TEXT NOT NULL,
  PRIMARY KEY (entity, id)
) WITHOUT ROWID;
";

/// Row templates (pages a database's new rows can start from) and
/// automations (rules that run when rows change).
const SCHEMA_V8: &str = "
ALTER TABLE db_rows ADD COLUMN template INTEGER NOT NULL DEFAULT 0;
CREATE TABLE db_automations (
  db_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  id       TEXT NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  type     TEXT NOT NULL,
  config   TEXT NOT NULL DEFAULT '{}',
  sort_key TEXT NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0,
  clock    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (db_id, id)
) WITHOUT ROWID;
";

/// Faster trash bookkeeping, and each row's gallery picture kept with it so
/// listing rows never reads their pages.
const SCHEMA_V9: &str = "
CREATE INDEX pages_trashed ON pages(deleted_at) WHERE deleted_at IS NOT NULL;
ALTER TABLE db_rows ADD COLUMN cover TEXT;
";

const WELCOME_HTML: &str = r#"<p>Thought Desk is a quiet place to write. Everything stays on this computer, in a single local database.</p>
<h2>The basics</h2>
<ul data-type="taskList">
<li data-type="taskItem" data-checked="true"><p>Open this page</p></li>
<li data-type="taskItem" data-checked="false"><p>Type <code>/</code> on an empty line to insert any block</p></li>
<li data-type="taskItem" data-checked="false"><p>Select text to format it, or press <code>Ctrl+B</code>, <code>Ctrl+I</code>, <code>Ctrl+U</code></p></li>
<li data-type="taskItem" data-checked="false"><p>Hover a block and drag the <code>⋮⋮</code> handle to move it</p></li>
<li data-type="taskItem" data-checked="false"><p>Type <code>@</code> to link to another page</p></li>
</ul>
<h2>Markdown shortcuts</h2>
<p>Start a line with <code>#</code>, <code>##</code> or <code>###</code> for headings, <code>-</code> for bullets, <code>1.</code> for numbers, <code>[]</code> for a to-do, <code>&gt;</code> for a quote, <code>```</code> for code and <code>---</code> for a divider.</p>
<h2>Math</h2>
<p>Type <code>$E = mc^2$</code> for a formula in a sentence, like <span data-math-inline="" data-latex="E = mc^2">E = mc^2</span>, or <code>$$</code> then Space for one on its own line. Click a formula to change it: type <code>\</code> for suggestions, Tab moves between the gaps, and Symbols has the Greek letters and operators. Pasted math from ChatGPT comes in typeset.</p>
<div data-math-block="" data-latex="\int_a^b f(x)\,dx = F(b) - F(a)">\int_a^b f(x)\,dx = F(b) - F(a)</div>
<h2>Keyboard</h2>
<table><tbody>
<tr><th><p>Shortcut</p></th><th><p>Action</p></th></tr>
<tr><td><p>Ctrl+K / Ctrl+P</p></td><td><p>Search and jump to any page</p></td></tr>
<tr><td><p>Ctrl+N</p></td><td><p>New page</p></td></tr>
<tr><td><p>Ctrl+\</p></td><td><p>Show or hide the sidebar</p></td></tr>
<tr><td><p>Alt+← / Alt+→</p></td><td><p>Go back / forward</p></td></tr>
<tr><td><p>Ctrl+Shift+L</p></td><td><p>Switch between light and dark</p></td></tr>
</tbody></table>
<div data-callout="" data-icon="icon:lightbulb:yellow"><p>Pages can be nested as deep as you like. Drag pages in the sidebar to reorder them or drop one onto another to nest it.</p></div>
<h2>Plan your work</h2>
<ul>
<li><p><strong>Home</strong> (<code>Ctrl+1</code>) shows your day: classes, what's due and open to-dos from every page.</p></li>
<li><p><strong>Quick Capture</strong> (<code>Ctrl+Shift+Space</code>) saves a thought from anywhere, even with the app in the background.</p></li>
<li><p><strong>Assignments</strong> (<code>Ctrl+2</code>) keep track of due dates by course. Give one a notes page and it links back.</p></li>
<li><p><strong>Calendar</strong> (<code>Ctrl+3</code>) shows events and everything that's due. Drag to reschedule.</p></li>
<li><p><strong>Files</strong> (<code>Ctrl+4</code>) holds every file you attach, drop into a page or import.</p></li>
<li><p>Type <code>@</code> to link a page, assignment, event or file, or <code>/assignment</code>, <code>/event</code> and <code>/file</code> to add one right here.</p></li>
</ul>
<p></p>"#;

pub struct Db {
    conn: Mutex<Connection>,
    /// A second, read-only connection for the long reads (search, listing):
    /// WAL lets it read while the main one writes, so a search never holds
    /// up a save.
    reader: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub files_dir: PathBuf,
}

impl Db {
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let files_dir = data_dir.join("files");
        std::fs::create_dir_all(&files_dir)?;

        let conn = Connection::open(data_dir.join("thoughtdesk.db"))?;
        // auto_vacuum only takes effect on a new database (or after VACUUM):
        // deleted pages then give their space back instead of leaving holes.
        // The WAL is trimmed back to 16 MB after big writes.
        conn.execute_batch(
            "PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -4000;
             PRAGMA journal_size_limit = 16777216;",
        )?;
        // Opened before migrating (so the file exists); it only reads, and
        // sees the schema the migrations leave once they've committed.
        let reader = Connection::open_with_flags(
            data_dir.join("thoughtdesk.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // Every save resets this connection's page cache, so it reads through
        // a memory map instead (file-backed, so the OS can drop it any time).
        reader.execute_batch(
            "PRAGMA query_only = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -4000;
             PRAGMA mmap_size = 268435456;",
        )?;
        let db = Db {
            conn: Mutex::new(conn),
            reader: Mutex::new(reader),
            data_dir: data_dir.to_path_buf(),
            files_dir,
        };
        db.migrate()?;
        Ok(db)
    }

    pub(crate) fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic while holding the lock cannot leave SQLite half-written
        // (statements are atomic), so a poisoned lock is safe to reuse.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The read-only connection, for reads that can take a while.
    pub(crate) fn reader(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.reader.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn migrate(&self) -> Result<()> {
        let mut conn = self.conn();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V1)?;
            // Bodies still live in `pages` at this version (see SCHEMA_V6).
            let ts = now();
            tx.execute(
                "INSERT INTO pages (id, title, icon, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![new_id(), "Getting started", "icon:compass:blue", WELCOME_HTML, ts],
            )?;
            tx.execute(
                "INSERT INTO pages_fts (rowid, title, body) VALUES (?1, ?2, ?3)",
                params![tx.last_insert_rowid(), "Getting started", strip_tags(WELCOME_HTML)],
            )?;
            tx.execute_batch("PRAGMA user_version = 1;")?;
            tx.commit()?;
        }
        if version < 2 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V2)?;
            // Images added before the library existed become library files.
            crate::library::register_existing(&tx, &self.files_dir)?;
            tx.execute_batch("PRAGMA user_version = 2;")?;
            tx.commit()?;
        }
        if version < 3 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V3)?;
            tx.execute_batch("PRAGMA user_version = 3;")?;
            tx.commit()?;
        }
        if version < 4 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V4)?;
            tx.execute_batch("PRAGMA user_version = 4;")?;
            tx.commit()?;
        }
        if version < 5 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V5)?;
            tx.execute_batch("PRAGMA user_version = 5;")?;
            tx.commit()?;
        }
        if version < 6 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V6)?;
            let rows: Vec<(i64, String)> = {
                let mut stmt = tx.prepare("SELECT rid, content FROM page_content")?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for (rid, content) in rows {
                index_content(&tx, rid, &content)?;
            }
            tx.execute_batch("PRAGMA user_version = 6;")?;
            tx.commit()?;
            // Moving the bodies out left the old space unused; hand it back
            // once, and from now on the file shrinks as things are deleted.
            if version >= 1 {
                compact(&conn, true)?;
            }
        }
        if version < 7 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V7)?;
            // This copy's name in the clocks of everything it writes.
            tx.execute("INSERT INTO sync_meta (key, value) VALUES ('device', ?1)", [new_id()])?;
            tx.execute_batch("PRAGMA user_version = 7;")?;
            tx.commit()?;
        }
        if version < 8 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V8)?;
            tx.execute_batch("PRAGMA user_version = 8;")?;
            tx.commit()?;
        }
        if version < 9 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V9)?;
            crate::databases::fill_covers(&tx)?;
            tx.execute_batch("PRAGMA user_version = 9;")?;
            tx.commit()?;
        }
        Ok(())
    }

    pub fn list_pages(&self) -> Result<Vec<PageMeta>> {
        let conn = self.reader();
        let mut stmt = conn.prepare(&format!(
            "SELECT {META_COLS} FROM pages ORDER BY parent_id, position, created_at"
        ))?;
        let rows = stmt.query_map([], meta_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_page(&self, id: &str) -> Result<Page> {
        let conn = self.conn();
        let page = conn
            .query_row(
                &format!("SELECT {META_COLS}, content FROM pages JOIN page_content USING (rid) WHERE id = ?1"),
                [id],
                |r| {
                    Ok(Page {
                        meta: meta_from_row(r)?,
                        content: r.get(12)?,
                    })
                },
            )
            .optional()?;
        match page {
            Some(p) => Ok(p),
            None => err("Page not found"),
        }
    }

    pub fn create_page(
        &self,
        parent_id: Option<&str>,
        index: Option<usize>,
        title: &str,
        icon: &str,
    ) -> Result<PageMeta> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if let Some(pid) = parent_id {
            let alive: Option<Option<i64>> = tx
                .query_row("SELECT deleted_at FROM pages WHERE id = ?1", [pid], |r| r.get(0))
                .optional()?;
            if !matches!(alive, Some(None)) {
                return err("Parent page no longer exists");
            }
            if is_database(&tx, pid)? {
                return err("Add rows to a database with its New button");
            }
        }
        let id = insert_page(&tx, parent_id, title, icon, "", "")?;
        place(&tx, &id, parent_id, index)?;
        let meta = meta_by_id(&tx, &id)?;
        tx.commit()?;
        Ok(meta)
    }

    /// Applies a partial update. Returns the page's new `updated_at`.
    pub fn update_page(&self, id: &str, patch: PagePatch) -> Result<i64> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let rid: Option<i64> = tx
            .query_row("SELECT rid FROM pages WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        let Some(rid) = rid else {
            return err("Page not found");
        };
        let ts = now();
        let mut touched = false;

        if let Some(title) = &patch.title {
            tx.execute("UPDATE pages SET title = ?1 WHERE rid = ?2", params![title, rid])?;
            tx.execute("UPDATE pages_fts SET title = ?1 WHERE rowid = ?2", params![title, rid])?;
            touched = true;
        }
        if let Some(icon) = &patch.icon {
            tx.execute("UPDATE pages SET icon = ?1 WHERE rid = ?2", params![icon, rid])?;
            touched = true;
        }
        if let Some(content) = &patch.content {
            tx.execute("UPDATE page_content SET content = ?1 WHERE rid = ?2", params![content, rid])?;
            index_content(&tx, rid, content)?;
            crate::databases::cover_changed(&tx, id, content)?;
            touched = true;
        }
        if let Some(text) = &patch.text {
            tx.execute("UPDATE pages_fts SET body = ?1 WHERE rowid = ?2", params![text, rid])?;
        }
        if let Some(fav) = patch.favorite {
            let v = if fav { ts } else { 0 };
            tx.execute("UPDATE pages SET favorite = ?1 WHERE rid = ?2", params![v, rid])?;
        }
        if let Some(fw) = patch.full_width {
            tx.execute("UPDATE pages SET full_width = ?1 WHERE rid = ?2", params![fw as i64, rid])?;
        }
        if touched {
            tx.execute("UPDATE pages SET updated_at = ?1 WHERE rid = ?2", params![ts, rid])?;
        }
        crate::databases::page_edited(&tx, id, patch.title.is_some(), patch.icon.is_some())?;
        let updated: i64 =
            tx.query_row("SELECT updated_at FROM pages WHERE rid = ?1", [rid], |r| r.get(0))?;
        tx.commit()?;
        Ok(updated)
    }

    /// Moves a page under `parent_id` (None = top level) at sibling `index`.
    pub fn move_page(&self, id: &str, parent_id: Option<&str>, index: usize) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        // Rows stay in their database, and only rows go in one.
        let old_parent: Option<String> = tx
            .query_row("SELECT parent_id FROM pages WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .flatten();
        let into_db = match parent_id {
            Some(pid) => is_database(&tx, pid)?,
            None => false,
        };
        let is_row = match &old_parent {
            Some(pid) => is_database(&tx, pid)?,
            None => false,
        };
        if (into_db || is_row) && old_parent.as_deref() != parent_id {
            return err("Rows can only be moved within their database");
        }
        // Refuse to move a page into itself or one of its descendants.
        let mut cursor = parent_id.map(str::to_string);
        while let Some(cur) = cursor {
            if cur == id {
                return err("A page can't be moved inside itself");
            }
            cursor = tx
                .query_row("SELECT parent_id FROM pages WHERE id = ?1", [&cur], |r| r.get(0))
                .optional()?
                .flatten();
        }
        tx.execute("UPDATE pages SET parent_id = ?1 WHERE id = ?2", params![parent_id, id])?;
        place(&tx, id, parent_id, Some(index))?;
        if old_parent.as_deref() != parent_id {
            renumber(&tx, old_parent.as_deref())?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Duplicates a page and its live sub-pages. Returns the new root.
    pub fn duplicate_page(&self, id: &str) -> Result<PageMeta> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;

        struct Row {
            rid: i64,
            id: String,
            parent: Option<String>,
            title: String,
            icon: String,
            content: String,
            full_width: i64,
        }
        let mut stmt = tx.prepare(
            "WITH RECURSIVE sub(id, depth) AS (
               SELECT id, 0 FROM pages WHERE id = ?1
               UNION ALL
               SELECT p.id, sub.depth + 1 FROM pages p JOIN sub ON p.parent_id = sub.id
               WHERE p.deleted_at IS NULL
             )
             SELECT p.rid, p.id, p.parent_id, p.title, p.icon, c.content, p.full_width
             FROM pages p JOIN sub ON p.id = sub.id JOIN page_content c ON c.rid = p.rid
             ORDER BY sub.depth, p.position",
        )?;
        let rows: Vec<Row> = stmt
            .query_map([id], |r| {
                Ok(Row {
                    rid: r.get(0)?,
                    id: r.get(1)?,
                    parent: r.get(2)?,
                    title: r.get(3)?,
                    icon: r.get(4)?,
                    content: r.get(5)?,
                    full_width: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        if rows.is_empty() {
            return err("Page not found");
        }

        let map: HashMap<String, String> = rows.iter().map(|r| (r.id.clone(), new_id())).collect();
        let ts = now();
        for (i, row) in rows.iter().enumerate() {
            let new_id = &map[&row.id];
            let parent = if i == 0 {
                row.parent.clone()
            } else {
                row.parent.as_ref().and_then(|p| map.get(p).cloned())
            };
            // Links to duplicated sub-pages should point at the copies.
            let content = replace_ids(&row.content, &map);
            let title = if i == 0 && !row.title.is_empty() {
                format!("{} (copy)", row.title)
            } else {
                row.title.clone()
            };
            tx.execute(
                "INSERT INTO pages (id, parent_id, title, icon, position, full_width, tags, kind, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, (SELECT position FROM pages WHERE id = ?5), ?6,
                         (SELECT tags FROM pages WHERE id = ?5), (SELECT kind FROM pages WHERE id = ?5), ?7, ?7)",
                params![new_id, parent, title, row.icon, row.id, row.full_width, ts],
            )?;
            let new_rid = tx.last_insert_rowid();
            tx.execute("INSERT INTO page_content (rid, content) VALUES (?1, ?2)", params![new_rid, content])?;
            index_content(&tx, new_rid, &content)?;
            tx.execute(
                "INSERT INTO pages_fts (rowid, title, body)
                 SELECT ?1, ?2, body FROM pages_fts WHERE rowid = ?3",
                params![new_rid, title, row.rid],
            )?;
        }

        // A copied database brings its schema; copied rows their values.
        crate::databases::duplicated(&tx, &map)?;

        // Put the copy right after the original.
        let root = &rows[0];
        let index: i64 =
            tx.query_row("SELECT position FROM pages WHERE id = ?1", [&root.id], |r| r.get(0))?;
        let new_root = map[&root.id].clone();
        place(&tx, &new_root, root.parent.as_deref(), Some(index as usize + 1))?;
        let meta = meta_by_id(&tx, &new_root)?;
        tx.commit()?;
        Ok(meta)
    }

    /// Moves a page and its live descendants to the trash.
    pub fn trash_page(&self, id: &str) -> Result<i64> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let ts = now();
        tx.execute(
            "WITH RECURSIVE sub(id) AS (
               SELECT id FROM pages WHERE id = ?1
               UNION ALL
               SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL
             )
             UPDATE pages SET deleted_at = ?2 WHERE id IN sub AND deleted_at IS NULL",
            params![id, ts],
        )?;
        crate::databases::trashed(&tx, ts)?;
        let parent: Option<String> = tx
            .query_row("SELECT parent_id FROM pages WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .flatten();
        renumber(&tx, parent.as_deref())?;
        tx.commit()?;
        Ok(ts)
    }

    /// Restores a trashed page together with the sub-pages trashed with it.
    pub fn restore_page(&self, id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        restore_in(&tx, id)?;
        tx.commit()?;
        Ok(())
    }

    /// Permanently deletes a page and everything below it.
    pub fn delete_page(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        crate::databases::forget_subtree(&conn, id)?;
        conn.execute("DELETE FROM pages WHERE id = ?1", [id])?;
        compact(&conn, false)
    }

    /// Moves an assignment, event or file to the trash. Returns the time.
    pub fn trash_item(&self, table: Table, id: &str) -> Result<i64> {
        if table == Table::Pages {
            return self.trash_page(id);
        }
        let ts = now();
        let sql = format!("UPDATE {} SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL", table.name());
        self.conn().execute(&sql, params![ts, id])?;
        Ok(ts)
    }

    pub fn restore_item(&self, table: Table, id: &str) -> Result<()> {
        if table == Table::Pages {
            return self.restore_page(id);
        }
        let sql = format!("UPDATE {} SET deleted_at = NULL WHERE id = ?1", table.name());
        self.conn().execute(&sql, [id])?;
        Ok(())
    }

    /// Permanently deletes one item; a file's bytes go with it.
    pub fn delete_item(&self, table: Table, id: &str) -> Result<()> {
        match table {
            Table::Pages => self.delete_page(id),
            Table::Files => {
                let stored: Option<String> = {
                    let conn = self.conn();
                    let stored = conn
                        .query_row("SELECT stored FROM files WHERE id = ?1", [id], |r| r.get(0))
                        .optional()?;
                    conn.execute("DELETE FROM files WHERE id = ?1", [id])?;
                    stored
                };
                if let Some(name) = stored {
                    let _ = std::fs::remove_file(self.files_dir.join(name));
                }
                Ok(())
            }
            _ => {
                let sql = format!("DELETE FROM {} WHERE id = ?1", table.name());
                self.conn().execute(&sql, [id])?;
                Ok(())
            }
        }
    }

    /// Permanently deletes everything in the trash: pages, assignments,
    /// events and files (including the files on disk).
    pub fn empty_trash(&self) -> Result<()> {
        let stored = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            crate::databases::forget_trashed(&tx)?;
            tx.execute("DELETE FROM pages WHERE deleted_at IS NOT NULL", [])?;
            tx.execute("DELETE FROM assignments WHERE deleted_at IS NOT NULL", [])?;
            tx.execute("DELETE FROM events WHERE deleted_at IS NOT NULL", [])?;
            let stored: Vec<String> = {
                let mut stmt = tx.prepare("SELECT stored FROM files WHERE deleted_at IS NOT NULL")?;
                let rows = stmt.query_map([], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            tx.execute("DELETE FROM files WHERE deleted_at IS NOT NULL", [])?;
            tx.commit()?;
            compact(&conn, false)?;
            stored
        };
        for name in stored {
            let _ = std::fs::remove_file(self.files_dir.join(name));
        }
        Ok(())
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let conn = self.reader();
        let limit = limit.clamp(1, 100) as i64;
        let tokens: Vec<String> = query
            .split_whitespace()
            .map(|t| t.replace('"', ""))
            .filter(|t| !t.is_empty())
            .collect();

        if tokens.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT id, title, icon, updated_at FROM pages
                 WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map([limit], |r| {
                Ok(SearchHit {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    icon: r.get(2)?,
                    snippet: String::new(),
                    updated_at: r.get(3)?,
                })
            })?;
            return Ok(rows.collect::<rusqlite::Result<_>>()?);
        }

        // Prefix match on every term; title matches weigh much more than body.
        let fts_query = tokens
            .iter()
            .map(|t| format!("\"{t}\"*"))
            .collect::<Vec<_>>()
            .join(" ");
        let mut hits: Vec<SearchHit> = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT p.id, p.title, p.icon,
                    snippet(pages_fts, 1, char(1), char(2), '…', 12), p.updated_at
             FROM pages_fts JOIN pages p ON p.rid = pages_fts.rowid
             WHERE pages_fts MATCH ?1 AND p.deleted_at IS NULL
             ORDER BY bm25(pages_fts, 10.0, 1.0) LIMIT ?2",
        ) {
            if let Ok(rows) = stmt.query_map(params![fts_query, limit], |r| {
                Ok(SearchHit {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    icon: r.get(2)?,
                    snippet: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            }) {
                hits = rows.filter_map(|r| r.ok()).collect();
            }
        }

        // Substring fallback catches what the tokenizer can't (e.g. CJK text,
        // or a fragment in the middle of a word). LIKE already ignores ASCII
        // case, which is all SQLite's lower() would fold, so the columns are
        // compared as they are (no copy of every body per query).
        if (hits.len() as i64) < limit {
            let needle = query.trim().to_lowercase();
            let like = format!(
                "%{}%",
                needle.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
            );
            let mut stmt = conn.prepare(
                "SELECT p.id, p.title, p.icon, pages_fts.body, p.updated_at
                 FROM pages_fts JOIN pages p ON p.rid = pages_fts.rowid
                 WHERE p.deleted_at IS NULL
                   AND (pages_fts.title LIKE ?1 ESCAPE '\\' OR pages_fts.body LIKE ?1 ESCAPE '\\')
                 ORDER BY p.updated_at DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![like, limit], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?;
            for row in rows.flatten() {
                if hits.len() as i64 >= limit {
                    break;
                }
                if hits.iter().any(|h| h.id == row.0) {
                    continue;
                }
                hits.push(SearchHit {
                    id: row.0,
                    title: row.1,
                    icon: row.2,
                    snippet: excerpt(&row.3, &needle),
                    updated_at: row.4,
                });
            }
        }
        Ok(hits)
    }

    /// Whether any page body (trashed ones too) contains `needle`. Used to
    /// keep stray files a page still points at; reads one body at a time.
    pub fn content_mentions(&self, needle: &str) -> Result<bool> {
        Ok(self
            .conn()
            .query_row("SELECT 1 FROM page_content WHERE instr(content, ?1) > 0 LIMIT 1", [needle], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// Number of live (not trashed) rows in one of the item tables.
    pub fn live_count(&self, table: Table) -> Result<i64> {
        let sql = format!("SELECT count(*) FROM {} WHERE deleted_at IS NULL", table.name());
        Ok(self.conn().query_row(&sql, [], |r| r.get(0))?)
    }
}

/// Restores a trashed page and the sub-pages trashed with it. A row whose
/// database is in the trash brings its database back too (a row can't live
/// anywhere else); any other page whose parent is trashed goes to the top.
fn restore_in(tx: &Transaction, id: &str) -> Result<()> {
    let row: Option<(Option<String>, Option<i64>)> = tx
        .query_row("SELECT parent_id, deleted_at FROM pages WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let Some((parent, Some(deleted_at))) = row else {
        return Ok(());
    };
    if let Some(pid) = &parent {
        if is_database(tx, pid)? {
            restore_in(tx, pid)?;
        }
    }
    let ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "WITH RECURSIVE sub(id) AS (
               SELECT id FROM pages WHERE id = ?1
               UNION ALL
               -- `+` keeps SQLite on the parent index: the trashed-pages index
               -- would scan every page trashed at that moment for each child.
               SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE +p.deleted_at = ?2
             )
             SELECT id FROM sub",
        )?;
        let rows = stmt.query_map(params![id, deleted_at], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    {
        let mut stmt = tx.prepare("UPDATE pages SET deleted_at = NULL WHERE id = ?1")?;
        for sid in &ids {
            stmt.execute([sid])?;
        }
    }
    crate::databases::restored(tx, &ids)?;
    // If the old parent is itself in the trash, restore to the top level.
    let parent_alive = match &parent {
        Some(pid) => tx
            .query_row("SELECT deleted_at IS NULL FROM pages WHERE id = ?1", [pid], |r| {
                r.get::<_, bool>(0)
            })
            .optional()?
            .unwrap_or(false),
        None => true,
    };
    let parent = if parent_alive { parent } else { None };
    tx.execute("UPDATE pages SET parent_id = ?1 WHERE id = ?2", params![parent, id])?;
    place(tx, id, parent.as_deref(), None)?;
    Ok(())
}

/// Whether a page is a database (its sub-pages are rows).
pub(crate) fn is_database(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .query_row("SELECT kind = 'database' FROM pages WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .unwrap_or(false))
}

pub(crate) fn insert_page(
    tx: &Transaction,
    parent_id: Option<&str>,
    title: &str,
    icon: &str,
    content: &str,
    text: &str,
) -> Result<String> {
    let id = new_id();
    insert_page_as(tx, &id, parent_id, title, icon, content, text)?;
    Ok(id)
}

/// Inserts a page with a known id (a new one, or one made on another copy).
pub(crate) fn insert_page_as(
    tx: &Transaction,
    id: &str,
    parent_id: Option<&str>,
    title: &str,
    icon: &str,
    content: &str,
    text: &str,
) -> Result<()> {
    let ts = now();
    tx.execute(
        "INSERT INTO pages (id, parent_id, title, icon, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
        params![id, parent_id, title, icon, ts],
    )?;
    let rid = tx.last_insert_rowid();
    tx.execute("INSERT INTO page_content (rid, content) VALUES (?1, ?2)", params![rid, content])?;
    index_content(tx, rid, content)?;
    tx.execute(
        "INSERT INTO pages_fts (rowid, title, body) VALUES (?1, ?2, ?3)",
        params![rid, title, text],
    )?;
    Ok(())
}

/// Refreshes what's known about a page body: the items it links to (for
/// backlinks and file usage) and its open to-dos and flashcards.
pub(crate) fn index_content(conn: &Connection, rid: i64, content: &str) -> Result<()> {
    conn.execute("DELETE FROM page_links WHERE page_rid = ?1", [rid])?;
    {
        let mut stmt = conn.prepare_cached("INSERT OR IGNORE INTO page_links (target, page_rid) VALUES (?1, ?2)")?;
        for target in link_targets(content) {
            stmt.execute(params![target, rid])?;
        }
    }
    let d = crate::organize::derive(content);
    conn.execute(
        "INSERT INTO page_derived (rid, todos, cards, card_ids) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (rid) DO UPDATE SET todos = excluded.todos, cards = excluded.cards, card_ids = excluded.card_ids",
        params![rid, d.todos, d.cards, d.card_ids],
    )?;
    Ok(())
}

/// Byte offsets of every id in `s` (a lower-case UUID, as `new_id` makes).
fn id_spans(s: &str) -> impl Iterator<Item = usize> + '_ {
    const LEN: usize = 36;
    let b = s.as_bytes();
    let hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
    let mut i = 0;
    std::iter::from_fn(move || {
        while i + LEN <= b.len() {
            let at = i;
            let w = &b[at..at + LEN];
            let is_id = w[8] == b'-'
                && w[13] == b'-'
                && w[18] == b'-'
                && w[23] == b'-'
                && w.iter().enumerate().all(|(k, &c)| matches!(k, 8 | 13 | 18 | 23) || hex(c));
            if is_id {
                i = at + LEN;
                return Some(at);
            }
            i += 1;
        }
        None
    })
}

/// Everything a body can point at: ids of pages, assignments, events and
/// files, and stored file names in image URLs.
fn link_targets(content: &str) -> std::collections::HashSet<&str> {
    let mut out: std::collections::HashSet<&str> = id_spans(content).map(|at| &content[at..at + 36]).collect();
    for prefix in ["tdfile.localhost/", "tdfile://localhost/"] {
        for (at, _) in content.match_indices(prefix) {
            let rest = &content[at + prefix.len()..];
            let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '.')).unwrap_or(rest.len());
            if end > 0 {
                out.insert(&rest[..end]);
            }
        }
    }
    out
}

/// `content` with every id found in `map` swapped for its new one.
pub(crate) fn replace_ids(content: &str, map: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(content.len());
    let mut last = 0;
    for at in id_spans(content) {
        if let Some(new) = map.get(&content[at..at + 36]) {
            out.push_str(&content[last..at]);
            out.push_str(new);
            last = at + 36;
        }
    }
    out.push_str(&content[last..]);
    out
}

/// Returns unused space to the file system. Databases made before
/// incremental vacuuming was turned on get one full VACUUM (which turns it
/// on), when there's space worth winning or right after an upgrade.
fn compact(conn: &Connection, upgrading: bool) -> Result<()> {
    let mode: i64 = conn.query_row("PRAGMA auto_vacuum", [], |r| r.get(0))?;
    let free: i64 = conn.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
    if mode == 2 {
        if free > 0 {
            conn.execute_batch("PRAGMA incremental_vacuum;")?;
        }
        return Ok(());
    }
    let page: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
    if upgrading || free * page >= 4 << 20 {
        conn.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;")?;
    }
    Ok(())
}

pub(crate) fn meta_by_id(tx: &Transaction, id: &str) -> Result<PageMeta> {
    Ok(tx.query_row(
        &format!("SELECT {META_COLS} FROM pages WHERE id = ?1"),
        [id],
        meta_from_row,
    )?)
}

/// Puts `id` at `index` among the live children of `parent` (end if None)
/// and rewrites sibling positions as 0..n.
pub(crate) fn place(tx: &Transaction, id: &str, parent: Option<&str>, index: Option<usize>) -> Result<()> {
    // A database's rows keep their own order (sort keys), not positions:
    // renumbering 50,000 of them for one row would take seconds.
    if let Some(pid) = parent {
        if is_database(tx, pid)? {
            return Ok(());
        }
    }
    let mut ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT id FROM pages WHERE parent_id IS ?1 AND id != ?2 AND deleted_at IS NULL
             ORDER BY position, created_at",
        )?;
        let rows = stmt.query_map(params![parent, id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let at = index.unwrap_or(ids.len()).min(ids.len());
    ids.insert(at, id.to_string());
    write_positions(tx, &ids)
}

fn renumber(tx: &Transaction, parent: Option<&str>) -> Result<()> {
    // A database's rows keep their own order (sort keys), not positions.
    if let Some(pid) = parent {
        if is_database(tx, pid)? {
            return Ok(());
        }
    }
    let ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT id FROM pages WHERE parent_id IS ?1 AND deleted_at IS NULL
             ORDER BY position, created_at",
        )?;
        let rows = stmt.query_map(params![parent], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    write_positions(tx, &ids)
}

fn write_positions(tx: &Transaction, ids: &[String]) -> Result<()> {
    let mut stmt = tx.prepare("UPDATE pages SET position = ?1 WHERE id = ?2 AND position != ?1")?;
    for (i, sid) in ids.iter().enumerate() {
        stmt.execute(params![i as i64, sid])?;
    }
    Ok(())
}

/// Rough HTML-to-text for the bundled welcome page's search index entry.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out.replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A short window of `body` around the first occurrence of `needle`, with
/// the match wrapped in the same markers FTS5's snippet() uses.
fn excerpt(body: &str, needle: &str) -> String {
    let lower = body.to_lowercase();
    // Lowercasing can change byte lengths, so only use the match position
    // when it maps cleanly back onto the original string.
    let Some(byte_at) = lower.find(needle).filter(|_| lower.len() == body.len()) else {
        return body.chars().take(90).collect();
    };
    let start_chars = body[..byte_at].chars().count();
    let needle_chars = needle.chars().count();
    let from = start_chars.saturating_sub(30);
    let chars: Vec<char> = body.chars().collect();
    let to = (start_chars + needle_chars + 60).min(chars.len());
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    out.extend(&chars[from..start_chars]);
    out.push('\u{1}');
    out.extend(&chars[start_chars..start_chars + needle_chars]);
    out.push('\u{2}');
    out.extend(&chars[start_chars + needle_chars..to]);
    if to < chars.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (Db, PathBuf) {
        let dir = std::env::temp_dir().join(format!("td-test-{}", uuid::Uuid::new_v4().simple()));
        (Db::open(&dir).expect("open db"), dir)
    }

    fn children(db: &Db, parent: Option<&str>) -> Vec<String> {
        let mut pages: Vec<_> = db
            .list_pages()
            .unwrap()
            .into_iter()
            .filter(|p| p.parent_id.as_deref() == parent && p.deleted_at.is_none())
            .collect();
        pages.sort_by_key(|p| p.position);
        pages.into_iter().map(|p| p.title).collect()
    }

    #[test]
    fn seeds_welcome_page_once() {
        let (db, dir) = temp_db();
        assert_eq!(children(&db, None), vec!["Getting started"]);
        drop(db);
        let db = Db::open(&dir).unwrap();
        assert_eq!(children(&db, None).len(), 1, "reopening must not seed again");
    }

    #[test]
    fn create_orders_and_moves() {
        let (db, _) = temp_db();
        let a = db.create_page(None, None, "A", "").unwrap();
        let b = db.create_page(None, Some(0), "B", "").unwrap();
        assert_eq!(children(&db, None), vec!["B", "Getting started", "A"]);

        // Nest A under B, then move it back to the top.
        db.move_page(&a.id, Some(&b.id), 0).unwrap();
        assert_eq!(children(&db, Some(&b.id)), vec!["A"]);
        assert_eq!(children(&db, None), vec!["B", "Getting started"]);
        db.move_page(&a.id, None, 1).unwrap();
        assert_eq!(children(&db, None), vec!["B", "A", "Getting started"]);
    }

    #[test]
    fn refuses_cycles() {
        let (db, _) = temp_db();
        let a = db.create_page(None, None, "A", "").unwrap();
        let b = db.create_page(Some(&a.id), None, "B", "").unwrap();
        assert!(db.move_page(&a.id, Some(&b.id), 0).is_err());
        assert!(db.move_page(&a.id, Some(&a.id), 0).is_err());
    }

    #[test]
    fn trash_restore_and_delete_subtree() {
        let (db, _) = temp_db();
        let a = db.create_page(None, None, "A", "").unwrap();
        let b = db.create_page(Some(&a.id), None, "B", "").unwrap();
        let c = db.create_page(Some(&b.id), None, "C", "").unwrap();

        db.trash_page(&a.id).unwrap();
        let trashed: Vec<_> = db.list_pages().unwrap().into_iter().filter(|p| p.deleted_at.is_some()).collect();
        assert_eq!(trashed.len(), 3);
        assert!(db.create_page(Some(&a.id), None, "X", "").is_err(), "can't add under a trashed page");

        db.restore_page(&a.id).unwrap();
        assert_eq!(children(&db, Some(&b.id)), vec!["C"]);

        // Restoring a child whose parent is still trashed lifts it to the top level.
        db.trash_page(&a.id).unwrap();
        db.restore_page(&c.id).unwrap();
        let c_meta = db.get_page(&c.id).unwrap().meta;
        assert_eq!(c_meta.parent_id, None);
        assert!(c_meta.deleted_at.is_none());

        db.delete_page(&a.id).unwrap();
        assert!(db.get_page(&b.id).is_err(), "children are deleted with the parent");
        assert!(db.get_page(&c.id).is_ok());
    }

    #[test]
    fn update_and_search() {
        let (db, _) = temp_db();
        let p = db.create_page(None, None, "Quarterly planning", "").unwrap();
        db.update_page(
            &p.id,
            PagePatch {
                content: Some("{}".into()),
                text: Some("Budget for the offsite in Lisbon".into()),
                ..Default::default()
            },
        )
        .unwrap();

        let by_title = db.search("quart", 10).unwrap();
        assert_eq!(by_title.first().map(|h| h.id.as_str()), Some(p.id.as_str()));

        let by_body = db.search("lisb", 10).unwrap();
        assert_eq!(by_body.len(), 1);
        assert!(by_body[0].snippet.contains('\u{1}'), "snippet marks the match");

        // Mid-word fragments fall back to substring search.
        assert_eq!(db.search("isbo", 10).unwrap().len(), 1);
        // Quotes and FTS syntax in queries must not error.
        assert!(db.search("\"budget\" AND (", 10).is_ok());

        db.trash_page(&p.id).unwrap();
        assert!(db.search("lisbon", 10).unwrap().is_empty(), "trashed pages are hidden");
    }

    #[test]
    fn side_tables_follow_pages() {
        let (db, _) = temp_db();
        let target = db.create_page(None, None, "Target", "").unwrap();
        let a = db.create_page(None, None, "A", "").unwrap();
        let b = db.create_page(Some(&a.id), None, "B", "").unwrap();
        let body = format!(
            r#"{{"type":"doc","content":[{{"type":"mention","attrs":{{"id":"{}"}}}},{{"type":"image","attrs":{{"src":"http://tdfile.localhost/abc.png"}}}}]}}"#,
            target.id
        );
        db.update_page(&b.id, PagePatch { content: Some(body), ..Default::default() }).unwrap();
        assert_eq!(db.backlinks(&target.id).unwrap(), vec![b.id.clone()]);
        assert!(db.content_mentions("abc.png").unwrap());

        // Deleting a parent takes its sub-pages' bodies and links with it.
        db.delete_page(&a.id).unwrap();
        let conn = db.conn();
        let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        let pages = count("SELECT count(*) FROM pages");
        assert_eq!(count("SELECT count(*) FROM page_content"), pages);
        assert_eq!(count("SELECT count(*) FROM page_derived"), pages);
        assert_eq!(count("SELECT count(*) FROM page_links"), 0);
    }

    #[test]
    fn finds_and_swaps_ids() {
        let (a, b) = (new_id(), new_id());
        let s = format!(r#"{{"id":"{a}","src":"http://tdfile.localhost/0123abcd.png","x":"{b}-tail","n":"not-an-id"}}"#);
        let found = link_targets(&s);
        assert_eq!(found.len(), 3);
        assert!(found.contains(a.as_str()) && found.contains(b.as_str()) && found.contains("0123abcd.png"));
        let map = HashMap::from([(a.clone(), "NEW".to_string())]);
        assert_eq!(replace_ids(&s, &map), s.replace(&a, "NEW"));
    }

    #[test]
    fn duplicate_copies_subtree_and_relinks() {
        let (db, _) = temp_db();
        let a = db.create_page(None, None, "A", "").unwrap();
        let b = db.create_page(Some(&a.id), None, "B", "").unwrap();
        let link = format!("{{\"type\":\"pageLink\",\"attrs\":{{\"id\":\"{}\"}}}}", b.id);
        db.update_page(&a.id, PagePatch { content: Some(link), ..Default::default() }).unwrap();

        let copy = db.duplicate_page(&a.id).unwrap();
        assert_eq!(copy.title, "A (copy)");
        let kids = children(&db, Some(&copy.id));
        assert_eq!(kids, vec!["B"]);
        let copied_child = db
            .list_pages()
            .unwrap()
            .into_iter()
            .find(|p| p.parent_id.as_deref() == Some(copy.id.as_str()))
            .unwrap();
        let content = db.get_page(&copy.id).unwrap().content;
        assert!(content.contains(&copied_child.id), "links point at the copied child");
        assert!(!content.contains(&b.id));
    }
}
