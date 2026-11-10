//! What the tests of sync share: copies of the notes that share a vault key,
//! and a stand-in for the mailbox that moves sealed items between them. It
//! has none of the server's rules (numbering aside); those are tested in `server/`.

use super::crypto::{self, base64url, VaultKeys};
use super::records::{Applied, Sent};
use super::vault::Pulled;
use crate::db::Db;
use crate::testutil::TempDb;

pub fn keys() -> VaultKeys {
    VaultKeys::from_vault_key(&[9u8; 32])
}

pub fn temp_db(name: &str) -> TempDb {
    TempDb::new(&format!("td-sync-{name}"))
}

/// A copy with sync on.
pub fn replica(name: &str) -> TempDb {
    let db = temp_db(name);
    db.sync_enable().unwrap();
    db
}

/// A copy with sync on and no welcome page, so the pages in a test are its own.
pub fn bare_replica(name: &str) -> TempDb {
    let db = temp_db(name);
    db.conn().execute("DELETE FROM pages WHERE title = 'Getting started'", []).unwrap();
    db.sync_enable().unwrap();
    db
}

pub fn mail() -> Mail {
    Mail::default()
}

/// Numbered sealed items, in the order they were pushed.
#[derive(Default)]
pub struct Mail {
    pub items: Vec<Pulled>,
}

impl Mail {
    fn add(&mut self, key: String, kind: &str, data: String) {
        let seq = self.items.len() as i64 + 1;
        self.items.push(Pulled { seq, key, kind: kind.to_string(), data });
    }

    /// Sends every record `db` has to send.
    pub fn push_records(&mut self, db: &Db) {
        let k = keys();
        loop {
            let out = db.sync_seal_records(&k, 1 << 20).unwrap();
            if out.is_empty() {
                return;
            }
            let mut sent = Vec::new();
            for item in out {
                self.add(item.key, "r", item.data);
                sent.push(Sent { entity: item.entity, id: item.id, seq: self.items.len() as i64 });
            }
            db.sync_sent(&sent).unwrap();
        }
    }

    /// Sends every text item `db` has to send.
    pub fn push_text(&mut self, db: &Db) {
        let k = keys();
        loop {
            let out = db.sync_seal_text(&k, 1 << 20).unwrap();
            if out.is_empty() {
                return;
            }
            let mut sent = Vec::new();
            for item in out {
                self.add(item.key, &item.kind, item.data);
                sent.push(super::text::TextSent { reference: item.reference, seq: self.items.len() as i64 });
            }
            db.sync_text_sent(&sent).unwrap();
        }
    }

    /// A record as another copy might have made it, sealed with the shared key.
    pub fn push_raw_record(&mut self, _from: &Db, entity: &str, id: &str, fields: serde_json::Value) {
        let k = keys();
        let key = crypto::item_key(&k, &format!("{entity}/{id}"));
        let record = serde_json::json!({ "e": entity, "id": id, "f": fields }).to_string();
        let data = base64url(&crypto::seal(&k, "r", &key, record.as_bytes()));
        self.add(key, "r", data);
    }

    /// Everything `db` hasn't read yet, then merged.
    pub fn deliver(&self, db: &Db) -> Applied {
        let after = db.sync_cursor().unwrap();
        let items: Vec<Pulled> = self.items.iter().filter(|i| i.seq > after).cloned().collect();
        let cursor = items.last().map_or(after, |i| i.seq);
        db.sync_ingest(&keys(), &items, cursor).unwrap();
        db.sync_apply().unwrap()
    }

    /// Records from `from` to `to`.
    pub fn move_records(&mut self, from: &Db, to: &Db) {
        self.push_records(from);
        let applied = self.deliver(to);
        assert_eq!(applied.skipped, 0);
    }
}
