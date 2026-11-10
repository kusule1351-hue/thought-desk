//! Turning sync on, and what the app asks to show it.

use super::records::{meta, set_meta};
use crate::db::{Db, Error, Result};
use serde::Serialize;
use std::path::Path;

/// The copy of the notes made before sync first changes them. It's kept in the
/// app's own folder on this computer, never in the notes folder, which may be
/// on a cloud drive.
pub const BACKUP: &str = "thoughtdesk-before-sync.db";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub account: Option<String>,
    /// The first whole cycle has finished.
    pub ready: bool,
    pub cursor: i64,
    /// The wrapped key of the synced copy this computer belongs to. Another one
    /// in the mailbox means that copy was deleted, and maybe replaced.
    pub wrapped_key: Option<String>,
    /// Items from the mailbox that couldn't be opened here (kept, see `sync_quarantine`).
    pub unreadable: i64,
    /// A copy of the notes from before sync was first turned on is on this computer.
    /// Filled in by the command, which knows where it's kept.
    pub backup: bool,
}

impl Db {
    pub fn sync_status(&self) -> Result<SyncStatus> {
        let (account, ready, wrapped_key, unreadable) = {
            let conn = self.conn();
            let unreadable: i64 = conn.query_row("SELECT COUNT(*) FROM sync_quarantine", [], |r| r.get(0))?;
            (meta(&conn, "account")?, meta(&conn, "ready")?.is_some(), meta(&conn, "wrapped")?, unreadable)
        };
        Ok(SyncStatus { enabled: self.sync_enabled()?, account, ready, cursor: self.sync_cursor()?, wrapped_key, unreadable, backup: false })
    }

    pub fn sync_mark_ready(&self) -> Result<()> {
        set_meta(&self.conn(), "ready", "1")
    }

    /// This install's name in stamps (see `sync::device`). The notes folder
    /// may be copied or on a cloud drive; the install can't be.
    pub fn sync_set_install(&self, id: &str) -> Result<()> {
        if id.is_empty() {
            return Err(Error("An install needs a name".into()));
        }
        set_meta(&self.conn(), "install", id)
    }

    /// Starts syncing with an account's synced copy (`wrapped_key` names it).
    /// A computer that synced with this account before goes on from what it kept
    /// (see "Turning sync on" in docs/sync.md); otherwise the notes are backed up
    /// to `backup`, the untouched welcome page goes if `joining` a copy that has
    /// notes, and everything is stamped.
    pub fn sync_turn_on(&self, account: &str, joining: bool, wrapped_key: &str, backup: &Path) -> Result<()> {
        if account.is_empty() {
            return Err(Error("Sign in to use sync".into()));
        }
        let was = self.sync_status()?;
        if was.enabled {
            return match was.account.as_deref() {
                Some(a) if a == account => Ok(()),
                _ => Err(Error("Sync is already on for another account. Turn it off first".into())),
            };
        }
        if was.account.as_deref() == Some(account) {
            if was.wrapped_key.as_deref() != Some(wrapped_key) {
                // Another synced copy: what this computer knows of the old one is no use there.
                self.sync_new_copy()?;
            }
            self.sync_enable()?;
        } else {
            // Another account's notes, or none: nothing kept carries over.
            self.sync_forget_all()?;
            self.back_up(backup)?;
            if joining {
                self.remove_untouched_welcome()?;
            }
            self.sync_enable()?;
        }
        let conn = self.conn();
        set_meta(&conn, "wrapped", wrapped_key)?;
        set_meta(&conn, "account", account)
    }

    fn back_up(&self, target: &Path) -> Result<()> {
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        match std::fs::remove_file(target) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        // Outside any transaction, and it can't write over a file.
        self.conn().execute("VACUUM INTO ?1", [target.to_string_lossy()])?;
        Ok(())
    }

    /// Removes the backup made when sync was first turned on (it's fine if there's none).
    pub fn sync_backup_delete(backup: &Path) -> Result<()> {
        match std::fs::remove_file(backup) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    /// "Getting started" as the app made it (its body is still HTML, as the
    /// editor only saves JSON), with nothing under it. Joining brings the
    /// real notes, and the other copy has its own. No record exists yet, so
    /// there's nothing to tell the mailbox.
    fn remove_untouched_welcome(&self) -> Result<()> {
        self.conn().execute(
            "DELETE FROM pages WHERE title = 'Getting started' AND icon = 'icon:compass:blue' AND deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = pages.id)
               AND EXISTS (SELECT 1 FROM page_content c WHERE c.rid = pages.rid AND c.content LIKE '<%')",
            [],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::PagePatch;
    use crate::sync::testkit::temp_db;

    fn titles(db: &Db) -> Vec<String> {
        db.list_pages().unwrap().into_iter().map(|p| p.title).collect()
    }

    fn backup_of(db: &Db) -> std::path::PathBuf {
        db.data_dir.join("app").join(BACKUP)
    }

    #[test]
    fn turning_on_backs_up_and_sets_the_account() {
        let db = temp_db("on");
        let backup = backup_of(&db);
        std::fs::create_dir_all(backup.parent().unwrap()).unwrap();
        std::fs::write(&backup, b"an older backup").unwrap();
        db.create_page(None, None, "Mine", "").unwrap();
        assert!(!db.sync_status().unwrap().enabled);

        db.sync_turn_on("user_1", false, "wrapped", &backup).unwrap();
        assert!(!db.data_dir.join(BACKUP).exists(), "never in the notes folder");
        let status = db.sync_status().unwrap();
        assert!(status.enabled && !status.ready);
        assert_eq!(status.account.as_deref(), Some("user_1"));
        assert!(titles(&db).contains(&"Getting started".to_string()), "not joining keeps it");

        // The backup is the notes from before, and replaced the older one.
        {
            let backup = rusqlite::Connection::open_with_flags(&backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let pages: i64 = backup.query_row("SELECT count(*) FROM pages", [], |r| r.get(0)).unwrap();
            assert_eq!(pages, 2);
            let stamped: i64 = backup.query_row("SELECT count(*) FROM sync_record", [], |r| r.get(0)).unwrap();
            assert_eq!(stamped, 0, "taken before stamping");
        }

        db.sync_mark_ready().unwrap();
        assert!(db.sync_status().unwrap().ready);
        // Again, for the same account: nothing happens.
        db.sync_turn_on("user_1", true, "wrapped", &backup).unwrap();
        assert!(titles(&db).contains(&"Getting started".to_string()));
        assert!(db.sync_status().unwrap().ready);
        // Another account's notes don't mix in.
        assert!(db.sync_turn_on("user_2", false, "wrapped", &backup).is_err());
        assert_eq!(db.sync_status().unwrap().account.as_deref(), Some("user_1"));

        // Off: what it knows stays, for turning on again.
        db.sync_disable().unwrap();
        let status = db.sync_status().unwrap();
        assert!(!status.enabled && status.account.as_deref() == Some("user_1"));
        // Another account after all: it starts from nothing.
        db.sync_turn_on("user_2", false, "wrapped 2", &backup).unwrap();
        let status = db.sync_status().unwrap();
        assert!(status.enabled && !status.ready && status.account.as_deref() == Some("user_2"));
    }

    fn seqs(db: &Db) -> Vec<(i64, bool)> {
        let conn = db.conn();
        let mut stmt = conn.prepare("SELECT seq, unsent FROM sync_record ORDER BY entity, id").unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    #[test]
    fn turning_on_again_goes_on_from_what_it_kept() {
        let db = temp_db("again");
        let backup = backup_of(&db);
        db.sync_turn_on("user_1", false, "copy 1", &backup).unwrap();
        db.conn().execute("UPDATE sync_record SET seq = 7, unsent = 0", []).unwrap();
        db.sync_mark_ready().unwrap();
        std::fs::remove_file(&backup).unwrap();

        db.sync_disable().unwrap();
        db.sync_turn_on("user_1", true, "copy 1", &backup).unwrap();
        assert!(seqs(&db).iter().all(|(seq, unsent)| *seq == 7 && !unsent), "the same copy: nothing to send again");
        assert!(!backup.exists(), "and no new backup");
        assert!(titles(&db).contains(&"Getting started".to_string()), "nor anything removed");

        // Its synced copy was deleted and another made: everything goes up again.
        db.sync_disable().unwrap();
        db.sync_turn_on("user_1", true, "copy 2", &backup).unwrap();
        assert!(seqs(&db).iter().all(|(seq, unsent)| *seq == 0 && *unsent));
        let status = db.sync_status().unwrap();
        assert!(status.enabled && !status.ready && status.wrapped_key.as_deref() == Some("copy 2"));
    }

    #[test]
    fn the_backup_can_be_deleted() {
        let db = temp_db("backup");
        let backup = backup_of(&db);
        db.sync_turn_on("user_1", false, "copy", &backup).unwrap();
        assert!(backup.exists());
        Db::sync_backup_delete(&backup).unwrap();
        assert!(!backup.exists());
        Db::sync_backup_delete(&backup).unwrap();
    }

    #[test]
    fn joining_removes_only_an_untouched_welcome_page() {
        let db = temp_db("join");
        let welcome = db.list_pages().unwrap().into_iter().find(|p| p.title == "Getting started").unwrap();
        db.sync_turn_on("user_1", true, "wrapped", &backup_of(&db)).unwrap();
        assert!(!titles(&db).contains(&"Getting started".to_string()));
        assert!(db.get_page(&welcome.id).is_err());
        let tombstones: i64 = db.conn().query_row("SELECT count(*) FROM sync_record WHERE gone IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(tombstones, 0, "it was never known to anyone");
        assert!(db.sync_outgoing(1 << 20).unwrap().is_empty());

        let kept = |what: &str, edit: &dyn Fn(&Db, &str)| {
            let db = temp_db(what);
            let id = db.list_pages().unwrap().into_iter().find(|p| p.title == "Getting started").unwrap().id;
            edit(&db, &id);
            db.sync_turn_on("user_1", true, "wrapped", &backup_of(&db)).unwrap();
            assert!(db.get_page(&id).is_ok(), "{what}: stays");
        };
        kept("edited", &|db, id| {
            db.update_page(id, PagePatch { content: Some("{\"type\":\"doc\"}".into()), ..Default::default() }).unwrap();
        });
        kept("renamed", &|db, id| {
            db.update_page(id, PagePatch { title: Some("Hello".into()), ..Default::default() }).unwrap();
            db.update_page(id, PagePatch { title: Some("Getting started".into()), ..Default::default() }).unwrap();
            db.update_page(id, PagePatch { icon: Some("icon:star:blue".into()), ..Default::default() }).unwrap();
        });
        kept("has a child", &|db, id| {
            db.create_page(Some(id), None, "Child", "").unwrap();
        });
        kept("trashed", &|db, id| {
            db.trash_page(id).unwrap();
        });
    }

    #[test]
    fn the_install_names_the_stamps() {
        let db = temp_db("install");
        db.sync_set_install("0123abcd-0000-4000-8000-000000000000").unwrap();
        db.sync_enable().unwrap();
        db.create_page(None, None, "Stamped", "").unwrap();
        let out = db.sync_outgoing(1 << 20).unwrap();
        assert!(out.iter().any(|o| o.record.contains("0123abcd")));
        assert!(db.sync_set_install("").is_err());
        let device: String = db.conn().query_row("SELECT value FROM sync_meta WHERE key = 'device'", [], |r| r.get(0)).unwrap();
        assert!(!device.is_empty(), "the notes folder keeps its own name for Galaxy");
    }
}
