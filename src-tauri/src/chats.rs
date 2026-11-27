//! The assistant's past conversations, kept on this computer in the same
//! database as the notes (so they move with the notes folder). The app writes
//! each chat's body as JSON text this module never looks into. Chats are
//! private to this computer: they are not in the sync tables
//! (sync/records.rs lists what syncs), so nothing here gets a clock or a trigger.

use crate::cowork::is_room;
use crate::db::{check_size, now, Db, Error, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

pub const SCHEMA_V14: &str = "
CREATE TABLE chats (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
";

/// A chat's saved body: far past any conversation, it only stops a runaway.
pub(crate) const MAX_CHAT_BYTES: u64 = 4 << 20;
const MAX_TITLE_CHARS: usize = 200;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    #[serde(flatten)]
    pub meta: ChatMeta,
    pub data: String,
}

fn check_id(id: &str) -> Result<()> {
    // A chat's id is a lowercase UUID, like a session's room.
    if is_room(id) {
        Ok(())
    } else {
        Err(Error("That isn't a chat".into()))
    }
}

impl Db {
    /// Every chat, the most recently saved first, without its body.
    pub fn list_chats(&self) -> Result<Vec<ChatMeta>> {
        let conn = self.reader();
        let mut stmt =
            conn.prepare("SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC, created_at DESC, id")?;
        let rows = stmt.query_map([], |r| {
            Ok(ChatMeta { id: r.get(0)?, title: r.get(1)?, created_at: r.get(2)?, updated_at: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_chat(&self, id: &str) -> Result<Option<Chat>> {
        Ok(self
            .conn()
            .query_row("SELECT id, title, created_at, updated_at, data FROM chats WHERE id = ?1", [id], |r| {
                Ok(Chat {
                    meta: ChatMeta { id: r.get(0)?, title: r.get(1)?, created_at: r.get(2)?, updated_at: r.get(3)? },
                    data: r.get(4)?,
                })
            })
            .optional()?)
    }

    /// Adds the chat, or replaces its title and body; when it was first saved
    /// is kept.
    pub fn save_chat(&self, id: &str, title: &str, data: &str) -> Result<ChatMeta> {
        check_id(id)?;
        check_size(data.len(), MAX_CHAT_BYTES, "This chat is too large to save (the limit is 4 MB)")?;
        let title: String = title.trim().chars().take(MAX_TITLE_CHARS).collect();
        let ts = now();
        let conn = self.conn();
        conn.execute(
            "INSERT INTO chats (id, title, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT (id) DO UPDATE SET title = excluded.title, data = excluded.data, updated_at = excluded.updated_at",
            params![id, title, data, ts],
        )?;
        let created_at: i64 = conn.query_row("SELECT created_at FROM chats WHERE id = ?1", [id], |r| r.get(0))?;
        Ok(ChatMeta { id: id.to_string(), title, created_at, updated_at: ts })
    }

    /// Deleting a chat that isn't there is fine.
    pub fn delete_chat(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM chats WHERE id = ?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{TempDb, TempDir};

    const A: &str = "0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
    const B: &str = "1b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

    fn temp_db() -> TempDb {
        TempDb::new("td-chats")
    }

    #[test]
    fn saves_and_gets_back() {
        let db = temp_db();
        assert!(db.get_chat(A).unwrap().is_none());
        let meta = db.save_chat(A, "  Cells  ", "{\"messages\":[]}").unwrap();
        assert_eq!(meta.title, "Cells");
        assert_eq!(meta.created_at, meta.updated_at);
        let chat = db.get_chat(A).unwrap().unwrap();
        assert_eq!(chat.meta, meta);
        assert_eq!(chat.data, "{\"messages\":[]}");
        assert_eq!(db.save_chat(B, "", "{}").unwrap().title, "", "an empty title is fine");
    }

    #[test]
    fn lists_newest_first_without_bodies() {
        let db = temp_db();
        db.save_chat(A, "first", "{}").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.save_chat(B, "second", "{}").unwrap();
        let ids: Vec<_> = db.list_chats().unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec![B, A]);
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.save_chat(A, "first", "{\"more\":1}").unwrap();
        let ids: Vec<_> = db.list_chats().unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec![A, B], "saving moves a chat to the top");
        let json = serde_json::to_string(&db.list_chats().unwrap()).unwrap();
        assert!(!json.contains("data"), "{json}");
        assert!(json.contains("createdAt") && json.contains("updatedAt"), "{json}");
    }

    #[test]
    fn saving_again_keeps_when_it_began() {
        let db = temp_db();
        let first = db.save_chat(A, "one", "{}").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = db.save_chat(A, "two", "{\"x\":1}").unwrap();
        assert_eq!(second.created_at, first.created_at);
        assert!(second.updated_at > first.updated_at);
        let chat = db.get_chat(A).unwrap().unwrap();
        assert_eq!((chat.meta.title.as_str(), chat.data.as_str()), ("two", "{\"x\":1}"));
        assert_eq!(chat.meta, second);
        assert_eq!(db.list_chats().unwrap().len(), 1);
    }

    #[test]
    fn deletes_and_ignores_missing() {
        let db = temp_db();
        db.save_chat(A, "x", "{}").unwrap();
        db.delete_chat(A).unwrap();
        assert!(db.get_chat(A).unwrap().is_none());
        assert!(db.list_chats().unwrap().is_empty());
        db.delete_chat(A).unwrap();
        db.delete_chat("not a chat").unwrap();
    }

    #[test]
    fn checks_ids_titles_and_size() {
        let db = temp_db();
        for bad in ["", "0123", "0B9A1C2D-3E4F-4A5B-8C6D-7E8F9A0B1C2D", "0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2g", "../../etc/passwd/3e4f-4a5b-8c6d-7e8f9"] {
            assert!(db.save_chat(bad, "t", "{}").is_err(), "{bad}");
        }
        let long = "é".repeat(300);
        assert_eq!(db.save_chat(A, &long, "{}").unwrap().title.chars().count(), 200);
        let limit = MAX_CHAT_BYTES as usize;
        db.save_chat(A, "t", &"a".repeat(limit)).unwrap();
        let refused = db.save_chat(A, "t", &"a".repeat(limit + 1)).unwrap_err();
        assert!(refused.0.contains("too large"), "{}", refused.0);
        assert_eq!(db.get_chat(A).unwrap().unwrap().data.len(), limit, "the saved chat is untouched");
    }

    #[test]
    fn an_older_database_gains_the_table_and_sync_ignores_it() {
        let dir = TempDir::new("td-chats");
        {
            let db = Db::open(&dir).unwrap();
            db.conn().execute_batch("DROP TABLE chats; PRAGMA user_version = 13;").unwrap();
        }
        let db = Db::open(&dir).unwrap();
        db.save_chat(A, "back", "{}").unwrap();
        assert_eq!(db.get_chat(A).unwrap().unwrap().meta.title, "back");
        let version: i64 = db.conn().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 14);
        // Chats stay on this computer: no sync record, no sync trigger.
        let conn = db.conn();
        let marked: i64 = conn.query_row("SELECT count(*) FROM sync_record WHERE entity LIKE '%chat%'", [], |r| r.get(0)).unwrap();
        assert_eq!(marked, 0);
        let triggers: i64 =
            conn.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'chats'", [], |r| r.get(0)).unwrap();
        assert_eq!(triggers, 0);
    }
}
