//! Page text between computers. The Yjs documents themselves live in the
//! webview; this keeps what they need in between: each page's last whole state
//! (`sync_y`), updates waiting to be sent (`sync_y_out`), updates received and
//! not merged yet (`sync_y_in`), and the pages deleted here whose text the
//! mailbox may still hold (`sync_y_gone`). "Page text" in docs/sync.md has the design.

use super::crypto::{self, base64url, unbase64url, VaultKeys};
use crate::db::{write_body, write_search_text, Db, Error, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

/// A page's log of updates is folded into a snapshot once it outgrows this,
/// or twice the state, whichever is more.
const SNAPSHOT_FLOOR: i64 = 65536;
/// The most the mailbox takes in one push.
const MAX_ITEMS: usize = 1000;
/// The most updates kept waiting for a page that isn't here (yet, or ever).
const MAX_WAITING: i64 = 2000;

/// Pages deleted for good, in every copy: text that arrives for one has nowhere to go.
const TOMBSTONED: &str = "SELECT id FROM sync_record WHERE entity = 'page' AND gone IS NOT NULL";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextTodo {
    pub bodies: Vec<String>,
    pub incoming: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRead {
    pub state: String,
    pub content: String,
    pub updates: Vec<TextUpdate>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextUpdate {
    pub seq: i64,
    pub kind: String,
    pub data: String,
}

/// What `sync_text_commit` takes; see "Inside the app" in docs/sync.md.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextCommit {
    pub page_id: String,
    /// The body this was worked out from. None for a page open in an editor,
    /// whose document is the truth whatever the body says.
    pub base: Option<String>,
    pub state: String,
    pub update: Option<String>,
    pub first: Option<bool>,
    pub content: Option<String>,
    pub text: Option<String>,
    pub consumed: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedText {
    #[serde(rename = "ref")]
    pub reference: String,
    pub page_id: String,
    pub key: String,
    pub kind: &'static str,
    pub data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upto: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct TextSent {
    #[serde(rename = "ref")]
    pub reference: String,
    // The mailbox's number for it; nothing here needs it.
    #[allow(dead_code)]
    pub seq: i64,
}

fn decode(text: &str) -> Result<Vec<u8>> {
    unbase64url(text).ok_or_else(|| Error("Page text that isn't base64".into()))
}

fn strings(tx: &Transaction, sql: &str) -> Result<Vec<String>> {
    let mut stmt = tx.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Keeps text received from the mailbox. A page that was deleted elsewhere
/// arrives as an empty update: if an edit here beat the delete, the mailbox
/// dropped our text and gets all of it again; otherwise there's nothing to do.
/// Text for a page known to be deleted isn't kept (and what was is dropped), and
/// a page that isn't here keeps only its latest `MAX_WAITING` updates.
pub(crate) fn receive_text(tx: &Transaction, seq: i64, kind: &str, page_id: &str, update: &[u8]) -> Result<()> {
    if update.is_empty() {
        let queued = tx.execute(
            "INSERT INTO sync_y_out (page_id, data) SELECT y.page_id, y.state FROM sync_y y JOIN pages p ON p.id = y.page_id WHERE y.page_id = ?1",
            [page_id],
        )?;
        if queued > 0 {
            tx.execute("UPDATE sync_y SET log_bytes = log_bytes + length(state) WHERE page_id = ?1", [page_id])?;
        }
        return Ok(());
    }
    let deleted: bool = tx.query_row(&format!("SELECT EXISTS ({TOMBSTONED} AND id = ?1)"), [page_id], |r| r.get(0))?;
    if deleted {
        tx.execute("DELETE FROM sync_y_in WHERE page_id = ?1", [page_id])?;
        return Ok(());
    }
    tx.execute(
        "INSERT OR REPLACE INTO sync_y_in (seq, page_id, kind, data) VALUES (?1, ?2, ?3, ?4)",
        params![seq, page_id, kind, update],
    )?;
    let dropped = tx.execute(
        "DELETE FROM sync_y_in WHERE page_id = ?1 AND NOT EXISTS (SELECT 1 FROM pages WHERE id = ?1)
           AND seq NOT IN (SELECT seq FROM sync_y_in WHERE page_id = ?1 ORDER BY seq DESC LIMIT ?2)",
        params![page_id, MAX_WAITING],
    )?;
    if dropped > 0 {
        eprintln!("Sync: dropped {dropped} old text updates waiting for a page that isn't here");
    }
    Ok(())
}

impl Db {
    /// Pages whose text needs the engine's attention. A page in a live session
    /// waits: its marks stay until the session ends.
    pub fn sync_text_todo(&self) -> Result<TextTodo> {
        if !self.sync_enabled()? {
            return Ok(TextTodo::default());
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM sync_changed WHERE entity = 'body' AND id NOT IN (SELECT id FROM pages)", [])?;
        tx.execute(&format!("DELETE FROM sync_y_in WHERE page_id IN ({TOMBSTONED})"), [])?;
        // Noted, or never seeded and with something to seed.
        let bodies = strings(
            &tx,
            "SELECT p.id FROM pages p WHERE p.shared_room IS NULL AND (
               p.id IN (SELECT id FROM sync_changed WHERE entity = 'body')
               OR (NOT EXISTS (SELECT 1 FROM sync_y y WHERE y.page_id = p.id)
                   AND EXISTS (SELECT 1 FROM page_content c WHERE c.rid = p.rid AND c.content != '')))
             ORDER BY p.rid",
        )?;
        let incoming = strings(
            &tx,
            "SELECT p.id FROM pages p WHERE p.shared_room IS NULL AND p.id IN (SELECT page_id FROM sync_y_in) ORDER BY p.rid",
        )?;
        tx.commit()?;
        Ok(TextTodo { bodies, incoming })
    }

    pub fn sync_text_read(&self, page_id: &str) -> Result<TextRead> {
        let conn = self.conn();
        let content: Option<String> = conn
            .query_row(
                "SELECT c.content FROM pages p JOIN page_content c ON c.rid = p.rid WHERE p.id = ?1",
                [page_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(content) = content else {
            return Err(Error("Page not found".into()));
        };
        let state: Option<Vec<u8>> =
            conn.query_row("SELECT state FROM sync_y WHERE page_id = ?1", [page_id], |r| r.get(0)).optional()?;
        let mut stmt = conn.prepare("SELECT seq, kind, data FROM sync_y_in WHERE page_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map([page_id], |r| {
            Ok(TextUpdate { seq: r.get(0)?, kind: r.get(1)?, data: base64url(&r.get::<_, Vec<u8>>(2)?) })
        })?;
        Ok(TextRead {
            state: base64url(&state.unwrap_or_default()),
            content,
            updates: rows.collect::<rusqlite::Result<_>>()?,
        })
    }

    /// Stores what the engine made of a page, if its body is still the one it
    /// started from. If it isn't, nothing changes and whoever wrote the body
    /// has noted the page, so it comes round again.
    pub fn sync_text_commit(&self, commit: &TextCommit) -> Result<bool> {
        let state = decode(&commit.state)?;
        let update = commit.update.as_deref().map(decode).transpose()?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let id = commit.page_id.as_str();
        let found: Option<(i64, String)> = tx
            .query_row("SELECT p.rid, c.content FROM pages p JOIN page_content c ON c.rid = p.rid WHERE p.id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((rid, current)) = found else {
            return Ok(false);
        };
        if commit.base.as_ref().is_some_and(|base| *base != current) {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO sync_y (page_id, state) VALUES (?1, ?2) ON CONFLICT (page_id) DO UPDATE SET state = excluded.state",
            params![id, state],
        )?;
        if let Some(update) = &update {
            tx.execute(
                "INSERT INTO sync_y_out (page_id, data, first) VALUES (?1, ?2, ?3)",
                params![id, update, commit.first.unwrap_or(false)],
            )?;
            tx.execute("UPDATE sync_y SET log_bytes = log_bytes + ?2 WHERE page_id = ?1", params![id, update.len() as i64])?;
        }
        if let Some(consumed) = commit.consumed {
            tx.execute(
                "UPDATE sync_y SET log_bytes = log_bytes + (SELECT coalesce(sum(length(data)), 0) FROM sync_y_in WHERE page_id = ?1 AND seq <= ?2)
                 WHERE page_id = ?1",
                params![id, consumed],
            )?;
            tx.execute("DELETE FROM sync_y_in WHERE page_id = ?1 AND seq <= ?2", params![id, consumed])?;
        }
        if let Some(content) = &commit.content {
            // Not an edit: `updated_at` is a record field and arrives by itself.
            write_body(&tx, rid, id, content)?;
        }
        if let Some(text) = &commit.text {
            write_search_text(&tx, rid, text)?;
        }
        // Last, because writing the body noted it again. Without a base this says
        // nothing about the body, so a note of it stays for the engine to look at.
        if commit.base.is_some() {
            tx.execute("DELETE FROM sync_changed WHERE entity = 'body' AND id = ?1", [id])?;
            // The body this text now matches, so the audit can tell a write made without sync.
            let body = commit.content.as_deref().unwrap_or(&current);
            tx.execute(
                "UPDATE sync_y SET body_hash = ?2 WHERE page_id = ?1",
                params![id, super::records::hash_text(body)],
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    /// Text to push, up to about `max_bytes`: updates in the order they were
    /// made, then snapshots of long logs, then markers for deleted pages.
    pub fn sync_seal_text(&self, keys: &VaultKeys, max_bytes: usize) -> Result<Vec<SealedText>> {
        let cursor = self.sync_cursor()?;
        let conn = self.conn();
        let mut out: Vec<SealedText> = Vec::new();
        let mut bytes = 0;
        let mut push = |out: &mut Vec<SealedText>, reference: String, page_id: String, kind, update: &[u8], first, upto| {
            let key = crypto::item_key(keys, &format!("body/{page_id}"));
            let mut plain = format!("{page_id}\n").into_bytes();
            plain.extend_from_slice(update);
            let data = base64url(&crypto::seal(keys, kind, &key, &plain));
            bytes += data.len();
            out.push(SealedText { reference, page_id, key, kind, data, first, upto });
            bytes >= max_bytes || out.len() >= MAX_ITEMS
        };

        let mut stmt = conn.prepare("SELECT id, page_id, data, first FROM sync_y_out ORDER BY id")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let (id, page_id, data, first): (i64, String, Vec<u8>, bool) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
            if push(&mut out, format!("out:{id}"), page_id, "y", &data, first.then_some(true), None) {
                return Ok(out);
            }
        }
        // A snapshot says "everything up to here is in this", so it waits for
        // text received and not merged yet, and for a live session to end.
        let mut stmt = conn.prepare(
            "SELECT y.page_id, y.state FROM sync_y y JOIN pages p ON p.id = y.page_id
             WHERE p.shared_room IS NULL AND y.log_bytes > max(?1, 2 * length(y.state))
               AND NOT EXISTS (SELECT 1 FROM sync_y_out o WHERE o.page_id = y.page_id)
               AND NOT EXISTS (SELECT 1 FROM sync_y_in i WHERE i.page_id = y.page_id)
             ORDER BY y.page_id",
        )?;
        let mut rows = stmt.query([SNAPSHOT_FLOOR])?;
        while let Some(r) = rows.next()? {
            let (page_id, state): (String, Vec<u8>) = (r.get(0)?, r.get(1)?);
            if push(&mut out, format!("snap:{page_id}"), page_id, "s", &state, None, Some(cursor)) {
                return Ok(out);
            }
        }
        let mut stmt = conn.prepare("SELECT page_id FROM sync_y_gone ORDER BY page_id")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let page_id: String = r.get(0)?;
            if push(&mut out, format!("gone:{page_id}"), page_id, "s", &[], None, Some(cursor)) {
                return Ok(out);
            }
        }
        Ok(out)
    }

    /// The mailbox stored these.
    pub fn sync_text_sent(&self, sent: &[TextSent]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for item in sent {
            let reference = item.reference.as_str();
            if let Some(id) = reference.strip_prefix("out:").and_then(|n| n.parse::<i64>().ok()) {
                tx.execute("DELETE FROM sync_y_out WHERE id = ?1", [id])?;
            } else if let Some(page_id) = reference.strip_prefix("snap:") {
                tx.execute("UPDATE sync_y SET log_bytes = 0 WHERE page_id = ?1", [page_id])?;
            } else if let Some(page_id) = reference.strip_prefix("gone:") {
                tx.execute("DELETE FROM sync_y_gone WHERE page_id = ?1", [page_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// A `first` push was refused: someone else seeded the page. What this
    /// copy made of it is dropped, and what comes from the mailbox is adopted.
    pub fn sync_text_refused(&self, page_id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM sync_y WHERE page_id = ?1", [page_id])?;
        tx.execute("DELETE FROM sync_y_out WHERE page_id = ?1", [page_id])?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::PagePatch;
    use crate::sync::testkit::{bare_replica as replica, keys};

    const ROOM: &str = "0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

    fn write(db: &Db, id: &str, content: &str) {
        db.update_page(id, PagePatch { content: Some(content.into()), text: Some("words".into()), ..Default::default() }).unwrap();
    }

    fn commit(db: &Db, id: &str, update: Option<&[u8]>, first: bool) -> bool {
        let read = db.sync_text_read(id).unwrap();
        db.sync_text_commit(&TextCommit {
            page_id: id.into(),
            base: Some(read.content),
            state: base64url(b"state"),
            update: update.map(base64url),
            first: first.then_some(true),
            ..Default::default()
        })
        .unwrap()
    }

    fn count(db: &Db, table: &str) -> i64 {
        db.conn().query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    fn strings_of(db: &Db, sql: &str) -> Vec<String> {
        let conn = db.conn();
        let mut stmt = conn.prepare(sql).unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    fn tombstone(db: &Db, id: &str) {
        db.conn().execute("INSERT INTO sync_record (entity, id, gone) VALUES ('page', ?1, '0000000000001-0000-aaaaaaaa')", [id]).unwrap();
    }

    fn receive(db: &Db, seq: i64, page_id: &str) {
        let mut conn = db.conn();
        let tx = conn.transaction().unwrap();
        receive_text(&tx, seq, "y", page_id, b"update").unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn text_for_a_deleted_page_is_not_kept() {
        let db = replica("tomb");
        let live = db.create_page(None, None, "Live", "").unwrap();
        let k = keys();
        // Text that arrives for a page already known to be gone is dropped at the door.
        tombstone(&db, "page-gone");
        let item = |page: &str, seq: i64| {
            let key = crypto::item_key(&k, &format!("body/{page}"));
            let data = base64url(&crypto::seal(&k, "y", &key, format!("{page}
bytes").as_bytes()));
            crate::sync::vault::Pulled { seq, key, kind: "y".into(), data }
        };
        let ingested = db.sync_ingest(&k, &[item("page-gone", 1), item(&live.id, 2)], 2).unwrap();
        assert_eq!(ingested.skipped, 0);
        assert_eq!(strings_of(&db, "SELECT page_id FROM sync_y_in"), vec![live.id.clone()]);

        // Text that came first, and then the page's deletion: the todo clears it.
        receive(&db, 3, "page-late");
        receive(&db, 4, "page-late");
        assert_eq!(count(&db, "sync_y_in"), 3);
        tombstone(&db, "page-late");
        db.sync_text_todo().unwrap();
        assert_eq!(strings_of(&db, "SELECT page_id FROM sync_y_in"), vec![live.id.clone()]);
        // A page that is only trashed (no tombstone) keeps its text.
        db.conn().execute("INSERT INTO sync_record (entity, id) VALUES ('page', 'page-trashed')", []).unwrap();
        receive(&db, 5, "page-trashed");
        db.sync_text_todo().unwrap();
        assert_eq!(count(&db, "sync_y_in"), 2);
    }

    #[test]
    fn updates_waiting_for_a_page_that_never_comes_are_capped() {
        let db = replica("cap");
        for seq in 1..=(MAX_WAITING + 100) {
            receive(&db, seq, "never");
        }
        assert_eq!(count(&db, "sync_y_in"), MAX_WAITING);
        let oldest: i64 = db.conn().query_row("SELECT min(seq) FROM sync_y_in", [], |r| r.get(0)).unwrap();
        assert_eq!(oldest, 101, "the oldest went");
        // Another page has its own allowance, and a page that is here is never trimmed.
        let here = db.create_page(None, None, "Here", "").unwrap();
        for seq in 0..(MAX_WAITING + 5) {
            receive(&db, 10_000 + seq, &here.id);
        }
        receive(&db, 20_000, "other");
        assert_eq!(count(&db, "sync_y_in"), MAX_WAITING + MAX_WAITING + 5 + 1);
    }

    #[test]
    fn a_page_in_a_live_session_waits() {
        let db = replica("todo");
        let page = db.create_page(None, None, "Group", "").unwrap();
        let other = db.create_page(None, None, "Other", "").unwrap();
        write(&db, &page.id, "{\"a\":1}");
        write(&db, &other.id, "{\"b\":1}");
        db.conn().execute("INSERT INTO sync_y_in (seq, page_id, kind, data) VALUES (5, 'not-here', 'y', x'01')", []).unwrap();
        db.conn().execute("INSERT INTO sync_y_in (seq, page_id, kind, data) VALUES (6, ?1, 'y', x'01')", [&page.id]).unwrap();

        db.set_shared_room(&page.id, Some(ROOM)).unwrap();
        let todo = db.sync_text_todo().unwrap();
        assert_eq!(todo.bodies, vec![other.id.clone()]);
        assert!(todo.incoming.is_empty());

        db.set_shared_room(&page.id, None).unwrap();
        let todo = db.sync_text_todo().unwrap();
        assert!(todo.bodies.contains(&page.id), "it appears once the session ends");
        assert_eq!(todo.incoming, vec![page.id.clone()]);

        assert!(commit(&db, &page.id, None, false) && commit(&db, &other.id, None, false));
        assert!(db.sync_text_todo().unwrap().bodies.is_empty());
        write(&db, &other.id, "{\"b\":2}");
        assert_eq!(db.sync_text_todo().unwrap().bodies, vec![other.id.clone()]);
        db.create_page(None, None, "Empty", "").unwrap();
        assert_eq!(db.sync_text_todo().unwrap().bodies, vec![other.id.clone()]);

        db.trash_page(&other.id).unwrap();
        db.delete_page(&other.id).unwrap();
        assert!(db.sync_text_todo().unwrap().bodies.is_empty());
        assert_eq!(count(&db, "sync_changed WHERE entity = 'body'"), 0);
    }

    #[test]
    fn a_changed_body_refuses_the_commit() {
        let db = replica("cas");
        let page = db.create_page(None, None, "Race", "").unwrap();
        write(&db, &page.id, "{\"v\":1}");
        let read = db.sync_text_read(&page.id).unwrap();
        write(&db, &page.id, "{\"v\":2}");
        let stale = TextCommit {
            page_id: page.id.clone(),
            base: Some(read.content),
            state: base64url(b"state"),
            update: Some(base64url(b"update")),
            content: Some("{\"v\":3}".into()),
            text: Some("three".into()),
            ..Default::default()
        };
        assert!(!db.sync_text_commit(&stale).unwrap());
        assert_eq!((count(&db, "sync_y"), count(&db, "sync_y_out")), (0, 0), "nothing stored");
        assert_eq!(db.get_page(&page.id).unwrap().content, "{\"v\":2}");
        assert_eq!(db.sync_text_todo().unwrap().bodies, vec![page.id.clone()], "it comes round again");
        let missing = TextCommit { page_id: "nope".into(), ..Default::default() };
        assert!(!db.sync_text_commit(&missing).unwrap());
    }

    #[test]
    fn a_commit_writes_the_body_and_what_comes_of_it() {
        let db = replica("write");
        let page = db.create_page(None, None, "Target", "").unwrap();
        let linked = db.create_page(None, None, "Linked", "").unwrap();
        let before = db.get_page(&page.id).unwrap().meta.updated_at;
        std::thread::sleep(std::time::Duration::from_millis(5));
        let body = format!(
            "{{\"type\":\"doc\",\"content\":[{{\"type\":\"taskItem\",\"attrs\":{{\"checked\":false}},\"content\":[]}},{{\"type\":\"link\",\"attrs\":{{\"id\":\"{}\"}}}}]}}",
            linked.id
        );
        let ok = db
            .sync_text_commit(&TextCommit {
                page_id: page.id.clone(),
                base: Some(String::new()),
                state: base64url(b"state"),
                update: Some(base64url(b"abcd")),
                first: Some(true),
                content: Some(body.clone()),
                text: Some("zebra words".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(ok);
        let got = db.get_page(&page.id).unwrap();
        assert_eq!(got.content, body);
        assert_eq!(got.meta.updated_at, before, "updated_at left alone");
        assert_eq!(db.search("zebra", 5).unwrap().len(), 1);
        let links: i64 = db.conn().query_row("SELECT count(*) FROM page_links WHERE target = ?1", [&linked.id], |r| r.get(0)).unwrap();
        assert_eq!(links, 1);
        let todos: String = db
            .conn()
            .query_row("SELECT todos FROM page_derived d JOIN pages p ON p.rid = d.rid WHERE p.id = ?1", [&page.id], |r| r.get(0))
            .unwrap();
        assert_ne!(todos, "[]");
        assert!(!db.sync_text_todo().unwrap().bodies.contains(&page.id), "the mark is cleared");
        let (state, log): (Vec<u8>, i64) = db
            .conn()
            .query_row("SELECT state, log_bytes FROM sync_y WHERE page_id = ?1", [&page.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((state, log), (b"state".to_vec(), 4));
        let first: bool = db.conn().query_row("SELECT first FROM sync_y_out", [], |r| r.get(0)).unwrap();
        assert!(first);
    }

    #[test]
    fn a_deleted_page_takes_its_text_and_leaves_a_marker() {
        let db = replica("gone");
        let seen = db.create_page(None, None, "Seen", "").unwrap();
        let never = db.create_page(None, None, "Never", "").unwrap();
        write(&db, &seen.id, "{\"a\":1}");
        assert!(commit(&db, &seen.id, Some(b"u1"), true));
        db.conn().execute("INSERT INTO sync_y_in (seq, page_id, kind, data) VALUES (9, ?1, 'y', x'01')", [&seen.id]).unwrap();

        for id in [&seen.id, &never.id] {
            db.trash_page(id).unwrap();
            db.delete_page(id).unwrap();
        }
        assert_eq!((count(&db, "sync_y"), count(&db, "sync_y_out"), count(&db, "sync_y_in")), (0, 0, 0));
        assert_eq!(strings_of(&db, "SELECT page_id FROM sync_y_gone"), vec![seen.id.clone()], "none for a page that never had text");

        let sealed = db.sync_seal_text(&keys(), 1 << 20).unwrap();
        assert_eq!(sealed.len(), 1);
        assert_eq!(sealed[0].kind, "s");
        assert_eq!(sealed[0].reference, format!("gone:{}", seen.id));
        assert_eq!(sealed[0].upto, Some(0));
        let plain = crypto::open(&keys(), "s", &sealed[0].key, &unbase64url(&sealed[0].data).unwrap()).unwrap();
        assert_eq!(plain, format!("{}\n", seen.id).into_bytes());
        db.sync_text_sent(&[TextSent { reference: sealed[0].reference.clone(), seq: 3 }]).unwrap();
        assert_eq!(count(&db, "sync_y_gone"), 0);
    }

    #[test]
    fn a_marker_for_a_page_that_is_still_here_sends_its_text_again() {
        let db = replica("beat");
        let page = db.create_page(None, None, "Edited", "").unwrap();
        let plain = db.create_page(None, None, "Plain", "").unwrap();
        write(&db, &page.id, "{\"a\":1}");
        assert!(commit(&db, &page.id, Some(b"u1"), true));
        db.sync_text_sent(&[TextSent { reference: "out:1".into(), seq: 1 }]).unwrap();
        assert_eq!(count(&db, "sync_y_out"), 0);

        {
            let mut conn = db.conn();
            let tx = conn.transaction().unwrap();
            receive_text(&tx, 20, "s", &page.id, &[]).unwrap();
            receive_text(&tx, 21, "s", &plain.id, &[]).unwrap();
            receive_text(&tx, 22, "s", "not-here", &[]).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(count(&db, "sync_y_in"), 0, "a marker is not text to merge");
        let (id, data, first): (String, Vec<u8>, bool) =
            db.conn().query_row("SELECT page_id, data, first FROM sync_y_out", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((id, data, first), (page.id.clone(), b"state".to_vec(), false));
        assert_eq!(count(&db, "sync_y_out"), 1, "only the page that has text");
    }

    #[test]
    fn long_logs_are_folded_into_a_snapshot() {
        let db = replica("snap");
        let page = db.create_page(None, None, "Long", "").unwrap();
        write(&db, &page.id, "{\"a\":1}");
        let big = vec![7u8; 70_000];
        assert!(commit(&db, &page.id, Some(&big), true));
        let k = keys();

        let sealed = db.sync_seal_text(&k, 1 << 30).unwrap();
        assert_eq!(sealed.len(), 1);
        assert_eq!((sealed[0].kind, sealed[0].first, sealed[0].upto), ("y", Some(true), None));
        db.sync_text_sent(&[TextSent { reference: sealed[0].reference.clone(), seq: 1 }]).unwrap();

        db.conn().execute("INSERT INTO sync_y_in (seq, page_id, kind, data) VALUES (4, ?1, 'y', x'01')", [&page.id]).unwrap();
        assert!(db.sync_seal_text(&k, 1 << 30).unwrap().is_empty(), "unmerged text isn't in the state");
        db.conn().execute("DELETE FROM sync_y_in", []).unwrap();
        db.conn().execute("INSERT INTO sync_meta (key, value) VALUES ('cursor', '12') ON CONFLICT (key) DO UPDATE SET value = '12'", []).unwrap();

        let sealed = db.sync_seal_text(&k, 1 << 30).unwrap();
        assert_eq!(sealed.len(), 1);
        assert_eq!((sealed[0].kind, sealed[0].upto), ("s", Some(12)));
        assert_eq!(sealed[0].reference, format!("snap:{}", page.id));
        let plain = crypto::open(&k, "s", &sealed[0].key, &unbase64url(&sealed[0].data).unwrap()).unwrap();
        assert_eq!(plain, [format!("{}\n", page.id).as_bytes(), b"state"].concat());
        db.sync_text_sent(&[TextSent { reference: sealed[0].reference.clone(), seq: 2 }]).unwrap();
        assert!(db.sync_seal_text(&k, 1 << 30).unwrap().is_empty(), "the log starts again");

        let small = db.create_page(None, None, "Small", "").unwrap();
        write(&db, &small.id, "{\"a\":1}");
        assert!(commit(&db, &small.id, Some(&[1u8; 1000]), true));
        let sealed = db.sync_seal_text(&k, 1 << 30).unwrap();
        db.sync_text_sent(&[TextSent { reference: sealed[0].reference.clone(), seq: 3 }]).unwrap();
        assert!(db.sync_seal_text(&k, 1 << 30).unwrap().is_empty());
    }

    #[test]
    fn updates_go_oldest_first_and_stop_near_the_limit() {
        let db = replica("order");
        let page = db.create_page(None, None, "Busy", "").unwrap();
        write(&db, &page.id, "{\"a\":1}");
        assert!(commit(&db, &page.id, Some(b"first"), true));
        assert!(commit(&db, &page.id, Some(b"second"), false));
        assert!(commit(&db, &page.id, Some(b"third"), false));
        let k = keys();
        let all = db.sync_seal_text(&k, 1 << 20).unwrap();
        let refs: Vec<&str> = all.iter().map(|i| i.reference.as_str()).collect();
        assert_eq!(refs, ["out:1", "out:2", "out:3"]);
        assert_eq!(all.iter().map(|i| i.first).collect::<Vec<_>>(), [Some(true), None, None]);
        assert_eq!(db.sync_seal_text(&k, 1).unwrap().len(), 1);
    }

    #[test]
    fn a_refused_first_push_is_forgotten() {
        let db = replica("refused");
        let page = db.create_page(None, None, "Seed", "").unwrap();
        write(&db, &page.id, "{\"a\":1}");
        assert!(commit(&db, &page.id, Some(b"seed"), true));
        assert!(db.sync_text_todo().unwrap().bodies.is_empty());
        db.sync_text_refused(&page.id).unwrap();
        assert_eq!((count(&db, "sync_y"), count(&db, "sync_y_out")), (0, 0));
        assert_eq!(db.sync_text_todo().unwrap().bodies, vec![page.id.clone()], "to be diffed into what the mailbox has");
    }
}
