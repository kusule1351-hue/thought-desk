//! The file library: every file the user adds (imported in Files, attached to
//! an assignment, dropped into a page) gets a row here. The bytes live in the
//! `files/` folder under a random name; `name` is what the user sees.

use crate::db::{check_size, fail, new_id, now, Db, Result, MAX_FILE_BYTES};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub id: String,
    /// Display name, including the extension.
    pub name: String,
    /// File name inside the `files/` folder (also its `tdfile://` URL path).
    pub stored: String,
    pub mime: String,
    pub size: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    /// The bytes are gone from disk (e.g. deleted by hand).
    pub missing: bool,
    pub tags: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FilePatch {
    pub name: Option<String>,
}

/// Pages that show or link to a file.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileUsage {
    pub file_id: String,
    pub page_ids: Vec<String>,
}

const FILE_COLS: &str = "id, name, stored, mime, size, created_at, updated_at, deleted_at, tags";

fn file_from_row(r: &rusqlite::Row) -> rusqlite::Result<FileMeta> {
    Ok(FileMeta {
        id: r.get(0)?,
        name: r.get(1)?,
        stored: r.get(2)?,
        mime: r.get(3)?,
        size: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        deleted_at: r.get(7)?,
        missing: false,
        tags: crate::organize::parse_tags(&r.get::<_, String>(8)?),
    })
}

/// Content type for a stored file, by extension. Anything that could run
/// script when rendered (HTML, XML) is served as plain text or bytes.
pub fn mime_for(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" | "md" | "csv" | "tsv" | "log" | "json" | "html" | "htm" | "xml" | "css" | "js" | "ts" | "py"
        | "rs" | "c" | "cpp" | "h" | "java" | "tex" | "yml" | "yaml" | "toml" | "ini" => "text/plain; charset=utf-8",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

/// Cleans a user-supplied file name: no path parts or control characters.
fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(200).collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "Untitled".to_string()
    } else {
        cleaned
    }
}

/// Lower-case alphanumeric extension of a display name, at most 8 chars.
fn extension(name: &str) -> String {
    let ext = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext,
        _ => "",
    };
    let ext: String = ext.chars().filter(char::is_ascii_alphanumeric).take(8).collect::<String>().to_ascii_lowercase();
    if ext.is_empty() {
        "bin".to_string()
    } else {
        ext
    }
}

/// Registers files already in the folder (images added before the library
/// existed). Their names come from the alt text of the images that use them.
pub fn register_existing(tx: &Transaction, dir: &Path) -> Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    let mut alts: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = tx.prepare("SELECT content FROM pages")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for content in rows.flatten() {
            if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&content) {
                collect_alts(&doc, &mut alts);
            }
        }
    }
    for entry in entries.flatten() {
        let stored = entry.file_name().to_string_lossy().into_owned();
        if !crate::files::is_valid_name(&stored) {
            continue;
        }
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
        let ts = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(now);
        let ext = extension(&stored);
        let name = match alts.get(&stored).map(|a| a.trim()).filter(|a| !a.is_empty()) {
            Some(alt) => format!("{}.{ext}", clean_name(alt)),
            None => format!("Image.{ext}"),
        };
        tx.execute(
            "INSERT OR IGNORE INTO files (id, name, stored, mime, size, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![new_id(), name, stored, mime_for(&stored), size, ts],
        )?;
    }
    Ok(())
}

fn collect_alts(node: &serde_json::Value, out: &mut HashMap<String, String>) {
    if node.get("type").and_then(|t| t.as_str()) == Some("image") {
        let attrs = node.get("attrs");
        let src = attrs.and_then(|a| a.get("src")).and_then(|s| s.as_str()).unwrap_or("");
        let alt = attrs.and_then(|a| a.get("alt")).and_then(|s| s.as_str()).unwrap_or("");
        if let Some(stored) = src.rsplit('/').next() {
            out.entry(stored.to_string()).or_insert_with(|| alt.to_string());
        }
    }
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            collect_alts(child, out);
        }
    }
}

impl Db {
    /// Writes `bytes` into the library under a new name and records it.
    pub fn import_file(&self, bytes: &[u8], name: &str, mime: &str) -> Result<FileMeta> {
        check_size(bytes.len(), MAX_FILE_BYTES, "That file is too large to add (the limit is 2 GB)")?;
        let name = clean_name(name);
        let stored = format!("{}.{}", uuid::Uuid::new_v4().simple(), extension(&name));
        let mime = if mime.is_empty() || mime.len() > 100 { mime_for(&stored).to_string() } else { mime.to_string() };
        std::fs::write(self.files_dir.join(&stored), bytes)?;
        let id = new_id();
        let ts = now();
        let conn = self.conn();
        let inserted = conn.execute(
            "INSERT INTO files (id, name, stored, mime, size, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, name, stored, mime, bytes.len() as i64, ts],
        );
        if let Err(e) = inserted {
            let _ = std::fs::remove_file(self.files_dir.join(&stored));
            return Err(e.into());
        }
        Ok(conn.query_row(&format!("SELECT {FILE_COLS} FROM files WHERE id = ?1"), [&id], file_from_row)?)
    }

    /// All library files, trashed ones included. Sizes come from disk, since
    /// a file opened in another app may have been edited there.
    pub fn list_files(&self) -> Result<Vec<FileMeta>> {
        let mut files: Vec<FileMeta> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(&format!("SELECT {FILE_COLS} FROM files ORDER BY created_at DESC"))?;
            let rows = stmt.query_map([], file_from_row)?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for f in &mut files {
            match std::fs::metadata(self.files_dir.join(&f.stored)) {
                Ok(m) => f.size = m.len() as i64,
                Err(_) => f.missing = true,
            }
        }
        Ok(files)
    }

    pub fn update_file(&self, id: &str, patch: FilePatch) -> Result<FileMeta> {
        let conn = self.conn();
        if let Some(name) = &patch.name {
            conn.execute(
                "UPDATE files SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![clean_name(name), now(), id],
            )?;
        }
        match conn
            .query_row(&format!("SELECT {FILE_COLS} FROM files WHERE id = ?1"), [id], file_from_row)
            .optional()?
        {
            Some(f) => Ok(f),
            None => fail("File not found"),
        }
    }

    /// Absolute path of a live file's bytes on disk.
    pub fn file_path(&self, id: &str) -> Result<(PathBuf, String)> {
        let row: Option<(String, String)> = self
            .conn()
            .query_row("SELECT stored, name FROM files WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let Some((stored, name)) = row else {
            return fail("File not found");
        };
        let path = self.files_dir.join(stored);
        if !path.exists() {
            return fail("The file is missing from the Thought Desk folder");
        }
        Ok((path, name))
    }

    /// For every live file, the live pages whose content shows or links to
    /// it (images by stored name, file blocks and mentions by id).
    pub fn file_usage(&self) -> Result<Vec<FileUsage>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT f.id, p.id FROM files f
             JOIN page_links l ON l.target IN (f.id, f.stored)
             JOIN pages p ON p.rid = l.page_rid
             WHERE f.deleted_at IS NULL AND p.deleted_at IS NULL
             ORDER BY f.rowid, p.rid",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out: Vec<FileUsage> = Vec::new();
        for (file_id, page_id) in rows.flatten() {
            match out.last_mut() {
                Some(last) if last.file_id == file_id => last.page_ids.push(page_id),
                _ => out.push(FileUsage { file_id, page_ids: vec![page_id] }),
            }
        }
        Ok(out)
    }

    /// Stored names of every file the library knows about (any state).
    pub fn known_files(&self) -> Result<HashSet<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT stored FROM files")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{PagePatch, Table};

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("td-test-{}", uuid::Uuid::new_v4().simple()))
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("C:\\Users\\me\\Essay draft.docx"), "Essay draft.docx");
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name("  "), "Untitled");
        assert_eq!(extension("Report.Final.PDF"), "pdf");
        assert_eq!(extension(".bashrc"), "bin");
        assert_eq!(extension("README"), "bin");
        assert_eq!(mime_for("x.HTML"), "text/plain; charset=utf-8", "never served as HTML");
    }

    #[test]
    fn refuses_files_over_the_limit() {
        // The check runs on the length, so no 2 GB buffer is needed.
        assert!(check_size(MAX_FILE_BYTES as usize, MAX_FILE_BYTES, "x").is_ok());
        assert!(check_size(MAX_FILE_BYTES as usize + 1, MAX_FILE_BYTES, "x").is_err());
        assert_eq!(MAX_FILE_BYTES, 2 * 1024 * 1024 * 1024);
        let db = Db::open(&temp_dir()).unwrap();
        assert!(db.import_file(b"small", "ok.txt", "").is_ok());
    }

    #[test]
    fn import_rename_and_usage() {
        let db = Db::open(&temp_dir()).unwrap();
        let f = db.import_file(b"%PDF-1.7", "Syllabus.pdf", "").unwrap();
        assert_eq!(f.mime, "application/pdf");
        assert_eq!(f.size, 8);
        assert!(f.stored.ends_with(".pdf"));

        let renamed = db.update_file(&f.id, FilePatch { name: Some("Course syllabus.pdf".into()) }).unwrap();
        assert_eq!(renamed.name, "Course syllabus.pdf");
        assert_eq!(renamed.stored, f.stored, "renaming never moves the bytes");

        let page = db.create_page(None, None, "Week 1", "").unwrap();
        assert!(db.file_usage().unwrap().is_empty());
        let content = format!(r#"{{"type":"fileBlock","attrs":{{"id":"{}"}}}}"#, f.id);
        db.update_page(&page.id, PagePatch { content: Some(content), ..Default::default() }).unwrap();
        let usage = db.file_usage().unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].page_ids, vec![page.id.clone()]);

        // Trashed pages don't count as using a file.
        db.trash_page(&page.id).unwrap();
        assert!(db.file_usage().unwrap().is_empty());

        let (path, name) = db.file_path(&f.id).unwrap();
        assert!(path.exists());
        assert_eq!(name, "Course syllabus.pdf");

        db.delete_item(Table::Files, &f.id).unwrap();
        assert!(!path.exists(), "deleting a file removes its bytes");
    }

    #[test]
    fn existing_images_are_registered_on_upgrade() {
        let dir = temp_dir();
        std::fs::create_dir_all(dir.join("files")).unwrap();
        std::fs::write(dir.join("files").join("abc123.png"), b"png").unwrap();
        std::fs::write(dir.join("files").join("def456.jpg"), b"jpg").unwrap();
        // A version-1 database with a page showing one of the images.
        {
            let conn = rusqlite::Connection::open(dir.join("thoughtdesk.db")).unwrap();
            conn.execute_batch(
                r#"CREATE TABLE pages (
                     rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
                     parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
                     title TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '',
                     content TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
                     favorite INTEGER NOT NULL DEFAULT 0, full_width INTEGER NOT NULL DEFAULT 0,
                     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
                   CREATE VIRTUAL TABLE pages_fts USING fts5(title, body);
                   INSERT INTO pages (id, title, content, created_at, updated_at) VALUES ('p1', 'Trip',
                     '{"type":"doc","content":[{"type":"image","attrs":{"src":"http://tdfile.localhost/abc123.png","alt":"Beach"}}]}', 1, 1);
                   PRAGMA user_version = 1;"#,
            )
            .unwrap();
        }
        let db = Db::open(&dir).unwrap();
        let mut names: Vec<String> = db.list_files().unwrap().into_iter().map(|f| f.name).collect();
        names.sort();
        assert_eq!(names, vec!["Beach.png", "Image.jpg"]);
        assert_eq!(db.list_pages().unwrap().len(), 1, "no welcome page is added on upgrade");
        // Bodies moved to their own table on the way up, and were indexed.
        assert!(db.get_page("p1").unwrap().content.contains("abc123.png"));
        assert_eq!(db.file_usage().unwrap()[0].page_ids, vec!["p1"]);
    }
}
