//! Live sessions: a page written together with a friend. While a session
//! runs, the page has its room (the session's id in the cloud) and, next to
//! its usual body, the Yjs state the editor merges both people's edits in.
//! That state is kept here, so reconnecting (or restarting) mid-session
//! loses and repeats nothing; it's dropped when the session ends.

use crate::db::{check_size, Db, Error, Result, MAX_PAGE_BYTES};
use rusqlite::{params, OptionalExtension};

pub const SCHEMA_V11: &str = "
ALTER TABLE pages ADD COLUMN shared_room TEXT;
CREATE TABLE page_yjs (
  rid   INTEGER PRIMARY KEY,
  state BLOB NOT NULL
);
CREATE TRIGGER pages_yjs_delete AFTER DELETE ON pages BEGIN
  DELETE FROM page_yjs WHERE rid = old.rid;
END;
";

/// A room: a session's id, a lowercase UUID.
pub fn is_room(room: &str) -> bool {
    room.len() == 36
        && room.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

impl Db {
    /// Shares a page in `room`, or (None) stops sharing it here: the page
    /// stays as it is, and its merge state is dropped.
    pub fn set_shared_room(&self, id: &str, room: Option<&str>) -> Result<()> {
        if let Some(room) = room {
            if !is_room(room) {
                return Err(Error("That isn't a session".into()));
            }
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let rid: Option<i64> = tx.query_row("SELECT rid FROM pages WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        let Some(rid) = rid else {
            return Err(Error("Page not found".into()));
        };
        tx.execute("UPDATE pages SET shared_room = ?1 WHERE rid = ?2", params![room, rid])?;
        if room.is_none() {
            tx.execute("DELETE FROM page_yjs WHERE rid = ?1", [rid])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// A shared page's Yjs state (empty when none is kept yet).
    pub fn page_yjs(&self, id: &str) -> Result<Vec<u8>> {
        let state: Option<Vec<u8>> = self
            .reader()
            .query_row("SELECT y.state FROM page_yjs y JOIN pages p ON p.rid = y.rid WHERE p.id = ?1", [id], |r| r.get(0))
            .optional()?;
        Ok(state.unwrap_or_default())
    }

    pub fn save_page_yjs(&self, id: &str, state: &[u8]) -> Result<()> {
        check_size(state.len(), MAX_PAGE_BYTES, "This session's page is too large to keep (the limit is 64 MB)")?;
        let changed = self.conn().execute(
            "INSERT INTO page_yjs (rid, state) SELECT rid, ?2 FROM pages WHERE id = ?1 AND shared_room IS NOT NULL
             ON CONFLICT (rid) DO UPDATE SET state = excluded.state",
            params![id, state],
        )?;
        if changed == 0 {
            return Err(Error("That page isn't shared".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

    fn temp_db() -> Db {
        let dir = std::env::temp_dir().join(format!("td-cowork-{}", uuid::Uuid::new_v4().simple()));
        Db::open(&dir).expect("open db")
    }

    #[test]
    fn checks_rooms() {
        assert!(is_room(ROOM));
        for bad in ["", "0123", "0123456789abcdef0123456789abcdef", "0B9A1C2D-3E4F-4A5B-8C6D-7E8F9A0B1C2D", "0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2g", "../../etc/passwd/3e4f-4a5b-8c6d-7e8f9"] {
            assert!(!is_room(bad), "{bad}");
        }
    }

    #[test]
    fn shares_keeps_state_and_stops() {
        let db = temp_db();
        let page = db.create_page(None, None, "Group notes", "").unwrap();
        assert!(db.save_page_yjs(&page.id, b"state").is_err(), "only a shared page keeps state");
        assert!(db.set_shared_room(&page.id, Some("not a code")).is_err());

        db.set_shared_room(&page.id, Some(ROOM)).unwrap();
        assert_eq!(db.get_page(&page.id).unwrap().meta.shared_room.as_deref(), Some(ROOM));
        assert_eq!(db.page_yjs(&page.id).unwrap(), b"");
        db.save_page_yjs(&page.id, b"one").unwrap();
        db.save_page_yjs(&page.id, b"two").unwrap();
        assert_eq!(db.page_yjs(&page.id).unwrap(), b"two");

        // A copy isn't shared: it's a page of its own.
        let copy = db.duplicate_page(&page.id).unwrap();
        assert_eq!(copy.shared_room, None);

        db.set_shared_room(&page.id, None).unwrap();
        assert_eq!(db.get_page(&page.id).unwrap().meta.shared_room, None);
        assert_eq!(db.page_yjs(&page.id).unwrap(), b"", "stopping drops the merge state");
    }

    #[test]
    fn refuses_state_over_the_limit() {
        let db = temp_db();
        let page = db.create_page(None, None, "Big", "").unwrap();
        db.set_shared_room(&page.id, Some(ROOM)).unwrap();
        db.save_page_yjs(&page.id, b"small").unwrap();
        let limit = MAX_PAGE_BYTES as usize;
        assert!(db.save_page_yjs(&page.id, &vec![0u8; limit + 1]).is_err());
        assert_eq!(db.page_yjs(&page.id).unwrap(), b"small", "a refused save changes nothing");
        assert!(db.save_page_yjs(&page.id, &vec![0u8; limit]).is_ok());
    }

    #[test]
    fn deleting_a_page_drops_its_state() {
        let db = temp_db();
        let page = db.create_page(None, None, "Gone", "").unwrap();
        db.set_shared_room(&page.id, Some(ROOM)).unwrap();
        db.save_page_yjs(&page.id, b"state").unwrap();
        db.trash_page(&page.id).unwrap();
        db.delete_page(&page.id).unwrap();
        let left: i64 = db.conn().query_row("SELECT COUNT(*) FROM page_yjs", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }
}
