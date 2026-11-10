//! The vault key in memory, and the commands that seal and open what goes to
//! and from the mailbox. The key itself is kept by `Secrets`; here it's only
//! held while the app runs, and never printed (`VaultKeys` has no `Debug`).

use super::crypto::{self, base64url, unbase64url, CryptoError, VaultKeys};
use super::records::Incoming;
use super::text::receive_text;
use crate::db::{Db, Error, Result};
use crate::secrets::Secrets;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use zeroize::Zeroize;

/// Managed by Tauri: the working keys of the signed-in account, once unlocked.
#[derive(Default)]
pub struct SyncVault {
    keys: Mutex<Option<VaultKeys>>,
}

impl SyncVault {
    fn set(&self, vault_key: &[u8; 32]) {
        *self.keys.lock().unwrap_or_else(|p| p.into_inner()) = Some(VaultKeys::from_vault_key(vault_key));
    }

    /// Drops the keys, which wipes them from memory.
    fn clear(&self) {
        *self.keys.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Runs `f` with the keys, or fails if the vault isn't unlocked.
    pub fn with<T>(&self, f: impl FnOnce(&VaultKeys) -> Result<T>) -> Result<T> {
        match self.keys.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            Some(keys) => f(keys),
            None => Err(Error("Sync is locked".into())),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewVault {
    pub recovery_key: String,
    pub wrapped_key: String,
}

fn account_name(account: &str) -> Result<&str> {
    if account.is_empty() {
        return Err(Error("Sign in to use sync".into()));
    }
    Ok(account)
}

/// The account to work on, once checked against the one sync is on for: a
/// different one is refused while sync is on. The flag says sync is on for this account.
fn for_account<'a>(db: &Db, account: &'a str) -> Result<(&'a str, bool)> {
    let account = account_name(account)?;
    let status = db.sync_status()?;
    match status.account {
        Some(on) if status.enabled && on != account => Err(Error("Sync is on for another account. Turn it off first".into())),
        Some(_) if status.enabled => Ok((account, true)),
        _ => Ok((account, false)),
    }
}

/// Makes the vault key for a new account. The recovery key is only returned.
/// Where sync is already on for the account and a key is kept, that key stays.
pub fn create(db: &Db, secrets: &Secrets, vault: &SyncVault, account: &str) -> Result<NewVault> {
    let (account, syncing) = for_account(db, account)?;
    if syncing && secrets.load_vault_key(account).is_some() {
        return Err(Error("This computer already has the key for this account's synced notes".into()));
    }
    let mut vault_key = crypto::new_vault_key();
    let (mut recovery, shown) = crypto::new_recovery_key();
    let wrapped_key = crypto::wrap_vault_key(&recovery, &vault_key);
    let stored = secrets.store_vault_key(account, &vault_key);
    if stored.is_ok() {
        vault.set(&vault_key);
    }
    vault_key.zeroize();
    recovery.zeroize();
    stored?;
    Ok(NewVault { recovery_key: shown, wrapped_key })
}

/// Opens the account's vault key with the typed recovery key, on a computer that hasn't got it.
pub fn join(db: &Db, secrets: &Secrets, vault: &SyncVault, account: &str, recovery_key: &str, wrapped_key: &str) -> Result<()> {
    let (account, _) = for_account(db, account)?;
    let mut recovery = crypto::parse_recovery_key(recovery_key)?;
    let opened = crypto::unwrap_vault_key(&recovery, wrapped_key);
    recovery.zeroize();
    let mut vault_key = opened?;
    let stored = secrets.store_vault_key(account, &vault_key);
    if stored.is_ok() {
        vault.set(&vault_key);
    }
    vault_key.zeroize();
    stored
}

/// Whether the key was in the key store (and is now in memory).
pub fn open(db: &Db, secrets: &Secrets, vault: &SyncVault, account: &str) -> Result<bool> {
    let (account, _) = for_account(db, account)?;
    let Some(mut vault_key) = secrets.load_vault_key(account) else {
        return Ok(false);
    };
    vault.set(&vault_key);
    vault_key.zeroize();
    Ok(true)
}

pub fn forget(db: &Db, secrets: &Secrets, vault: &SyncVault, account: &str) -> Result<()> {
    let (account, _) = for_account(db, account)?;
    secrets.delete_vault_key(account);
    vault.clear();
    Ok(())
}

/// What the mailbox is shown with every change (`X-Vault-Proof`), as base64url.
pub fn proof(vault: &SyncVault) -> Result<String> {
    vault.with(|keys| Ok(base64url(&crypto::vault_proof(keys))))
}

/// A record, ready to push.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedRecord {
    pub entity: String,
    pub id: String,
    pub key: String,
    pub kind: &'static str,
    pub base: i64,
    pub data: String,
}

/// An item as the mailbox gave it (`blob`s have been fetched and put in `data`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pulled {
    pub seq: i64,
    pub key: String,
    pub kind: String,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ingested {
    pub skipped: usize,
}

enum Opened {
    Record(String),
    Text { page_id: String, update: Vec<u8> },
}

/// Why an item didn't open: one that's damaged is passed over (and kept, with
/// the reason, in `sync_quarantine`), one from a newer app stops everything.
enum Unopened {
    Skip(&'static str),
    Newer(String),
}

impl From<CryptoError> for Unopened {
    fn from(e: CryptoError) -> Self {
        match e {
            CryptoError::NewerFormat => Unopened::Newer(e.to_string()),
            _ => Unopened::Skip("damaged, changed, or sealed with another key"),
        }
    }
}

/// What a record says about itself, to check against the key it came under.
#[derive(Deserialize)]
struct Head {
    e: String,
    id: String,
}

fn open_item(keys: &VaultKeys, item: &Pulled) -> std::result::Result<Opened, Unopened> {
    let sealed = unbase64url(&item.data).ok_or(Unopened::Skip("not base64"))?;
    match item.kind.as_str() {
        "r" => {
            let plain = crypto::open(keys, "r", &item.key, &sealed)?;
            let text = String::from_utf8(plain).map_err(|_| Unopened::Skip("not text"))?;
            let head: Head = serde_json::from_str(&text)
                .map_err(|e| Unopened::Skip(if e.is_syntax() || e.is_eof() { "not JSON" } else { "not a record" }))?;
            // The key says which record it is for; the record must agree, or it would
            // set the bookkeeping of another one.
            if crypto::item_key(keys, &format!("{}/{}", head.e, head.id)) != item.key {
                return Err(Unopened::Skip("sealed under another record's key"));
            }
            Ok(Opened::Record(text))
        }
        "y" | "s" => {
            let plain = crypto::open(keys, &item.kind, &item.key, &sealed)?;
            let split = plain.iter().position(|&b| b == b'\n').ok_or(Unopened::Skip("page text without a page"))?;
            let page_id = std::str::from_utf8(&plain[..split]).map_err(|_| Unopened::Skip("page text without a page"))?;
            // The key says which page it is for; the frame must agree.
            if page_id.is_empty() || crypto::item_key(keys, &format!("body/{page_id}")) != item.key {
                return Err(Unopened::Skip("sealed under another page's key"));
            }
            Ok(Opened::Text { page_id: page_id.to_string(), update: plain[split + 1..].to_vec() })
        }
        _ => Err(Unopened::Skip("not a kind this version knows")),
    }
}

impl Db {
    /// Records to push, sealed. The item key says nothing about what it is.
    pub fn sync_seal_records(&self, keys: &VaultKeys, max_bytes: usize) -> Result<Vec<SealedRecord>> {
        Ok(self
            .sync_outgoing(max_bytes)?
            .into_iter()
            .map(|o| {
                let key = crypto::item_key(keys, &format!("{}/{}", o.entity, o.id));
                let data = base64url(&crypto::seal(keys, "r", &key, o.record.as_bytes()));
                SealedRecord { entity: o.entity, id: o.id, key, kind: "r", base: o.base, data }
            })
            .collect())
    }

    /// Opens what was pulled and keeps it, with the cursor, in one transaction.
    /// Everything is opened first: an item from a newer app fails the call with
    /// nothing stored and the cursor where it was. One that doesn't open is
    /// counted in `skipped` and kept, with why, in `sync_quarantine`.
    pub fn sync_ingest(&self, keys: &VaultKeys, items: &[Pulled], cursor: i64) -> Result<Ingested> {
        let mut records = Vec::new();
        let mut texts = Vec::new();
        let mut quarantined = Vec::new();
        for item in items {
            match open_item(keys, item) {
                Ok(Opened::Record(record)) => records.push(Incoming { seq: item.seq, record }),
                Ok(Opened::Text { page_id, update }) => texts.push((item.seq, item.kind.as_str(), page_id, update)),
                Err(Unopened::Newer(message)) => return Err(Error(message)),
                Err(Unopened::Skip(reason)) => quarantined.push((item, reason)),
            }
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for (item, reason) in &quarantined {
            tx.prepare_cached("INSERT OR REPLACE INTO sync_quarantine (seq, key, kind, data, reason) VALUES (?1, ?2, ?3, ?4, ?5)")?
                .execute(params![item.seq, item.key, item.kind, item.data.as_bytes(), reason])?;
        }
        super::records::receive_in(&tx, &records, cursor)?;
        for (seq, kind, page_id, update) in &texts {
            receive_text(&tx, *seq, kind, page_id, update)?;
        }
        tx.commit()?;
        Ok(Ingested { skipped: quarantined.len() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::PagePatch;
    use crate::sync::text::TextCommit;
    use crate::sync::testkit::{bare_replica, keys, mail, replica, temp_db};
    use std::path::PathBuf;

    fn temp_secrets() -> (Secrets, PathBuf) {
        let dir = std::env::temp_dir().join(format!("td-vault-{}", uuid::Uuid::new_v4().simple()));
        (Secrets::new(dir.clone()), dir)
    }

    fn b64(bytes: &[u8]) -> String {
        base64url(bytes)
    }

    #[test]
    fn a_vault_is_made_joined_and_forgotten() {
        let (one, dir_one) = temp_secrets();
        let (two, dir_two) = temp_secrets();
        let (vault_one, vault_two) = (SyncVault::default(), SyncVault::default());
        let db = temp_db("vault-made");
        assert!(vault_one.with(|_| Ok(())).is_err(), "locked at first");
        assert_eq!(vault_one.with(|_| Ok(())).unwrap_err().0, "Sync is locked");

        let made = create(&db, &one, &vault_one, "user_1").unwrap();
        assert_eq!(made.recovery_key.len(), 30 + 5);
        assert!(vault_one.with(|_| Ok(())).is_ok());
        assert!(!open(&db, &two, &vault_two, "user_1").unwrap(), "another computer has no key yet");
        assert!(join(&db, &two, &vault_two, "user_1", "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", &made.wrapped_key).is_err());
        assert!(vault_two.with(|_| Ok(())).is_err());
        join(&db, &two, &vault_two, "user_1", &made.recovery_key.to_lowercase(), &made.wrapped_key).unwrap();

        // The two ends read each other.
        let sealed = vault_one.with(|k| Ok(crypto::seal(k, "r", "k", b"hello"))).unwrap();
        let plain = vault_two.with(|k| Ok(crypto::open(k, "r", "k", &sealed).unwrap())).unwrap();
        assert_eq!(plain, b"hello");

        // After a restart the key store has it.
        let again = SyncVault::default();
        assert!(open(&db, &two, &again, "user_1").unwrap());
        // The proof is the same on both computers, and there is none while locked.
        assert_eq!(proof(&again).unwrap(), proof(&vault_one).unwrap());
        assert_eq!(proof(&again).unwrap().len(), 43);
        forget(&db, &two, &again, "user_1").unwrap();
        assert!(again.with(|_| Ok(())).is_err());
        assert_eq!(proof(&again).unwrap_err().0, "Sync is locked");
        assert!(!open(&db, &two, &again, "user_1").unwrap());
        let _ = std::fs::remove_dir_all(dir_one);
        let _ = std::fs::remove_dir_all(dir_two);
    }

    #[test]
    fn a_record_and_a_text_update_go_all_the_way() {
        let (a, b) = (bare_replica("vault-a"), bare_replica("vault-b"));
        let mut mail = mail();
        let page = a.create_page(None, None, "Shared page", "").unwrap();
        a.update_page(&page.id, PagePatch { content: Some("{\"body\":\"one\"}".into()), text: Some("one".into()), ..Default::default() }).unwrap();

        let todo = a.sync_text_todo().unwrap();
        assert_eq!(todo.bodies, vec![page.id.clone()]);
        let read = a.sync_text_read(&page.id).unwrap();
        assert!(read.state.is_empty() && read.updates.is_empty());
        let commit = TextCommit {
            page_id: page.id.clone(),
            base: Some(read.content.clone()),
            state: b64(b"state-1"),
            update: Some(b64(b"update-1")),
            first: Some(true),
            ..Default::default()
        };
        assert!(a.sync_text_commit(&commit).unwrap());
        mail.push_records(&a);
        mail.push_text(&a);
        assert!(a.sync_seal_text(&keys(), 1 << 20).unwrap().is_empty(), "sent");

        // B hears of the page, then of its text, which waited for the page.
        let applied = mail.deliver(&b);
        assert_eq!(applied.skipped, 0);
        assert_eq!(b.get_page(&page.id).unwrap().meta.title, "Shared page");
        assert_eq!(b.sync_text_todo().unwrap().incoming, vec![page.id.clone()]);
        let read = b.sync_text_read(&page.id).unwrap();
        assert_eq!(read.updates.len(), 1);
        assert_eq!(read.updates[0].kind, "y");
        assert_eq!(unbase64url(&read.updates[0].data).unwrap(), b"update-1");
        let before = b.get_page(&page.id).unwrap().meta.updated_at;
        let commit = TextCommit {
            page_id: page.id.clone(),
            base: Some(read.content.clone()),
            state: b64(b"state-1"),
            content: Some("{\"body\":\"one\"}".into()),
            text: Some("one".into()),
            consumed: Some(read.updates[0].seq),
            ..Default::default()
        };
        assert!(b.sync_text_commit(&commit).unwrap());
        let got = b.get_page(&page.id).unwrap();
        assert_eq!(got.content, "{\"body\":\"one\"}");
        assert_eq!(got.meta.updated_at, before, "text that arrives is not an edit");
        assert!(b.sync_text_todo().unwrap().incoming.is_empty());
        assert_eq!(b.search("one", 5).unwrap().len(), 1);
    }

    #[test]
    fn the_vault_commands_keep_to_the_account_sync_is_on_for() {
        let db = temp_db("vault-account");
        let (secrets, dir) = temp_secrets();
        let vault = SyncVault::default();
        // Off: any account, and a key is replaced by a new one.
        let first = create(&db, &secrets, &vault, "user_1").unwrap();
        let before = secrets.load_vault_key("user_1").unwrap();
        create(&db, &secrets, &vault, "user_1").unwrap();
        assert_ne!(secrets.load_vault_key("user_1").unwrap(), before);
        assert!(create(&db, &secrets, &vault, "").is_err());

        db.sync_turn_on("user_1", false, &first.wrapped_key, &db.data_dir.join("app").join(crate::sync::setup::BACKUP)).unwrap();
        // On: not another account, in any command.
        let key = secrets.load_vault_key("user_1").unwrap();
        let err = "Sync is on for another account. Turn it off first";
        assert_eq!(create(&db, &secrets, &vault, "user_2").unwrap_err().0, err);
        assert_eq!(open(&db, &secrets, &vault, "user_2").unwrap_err().0, err);
        assert_eq!(forget(&db, &secrets, &vault, "user_2").unwrap_err().0, err);
        let (recovery, wrapped) = {
            let (r, shown) = crypto::new_recovery_key();
            (shown, crypto::wrap_vault_key(&r, &[5u8; 32]))
        };
        assert_eq!(join(&db, &secrets, &vault, "user_2", &recovery, &wrapped).unwrap_err().0, err);
        assert_eq!(secrets.load_vault_key("user_1").unwrap(), key, "nothing was touched");
        assert!(secrets.load_vault_key("user_2").is_none());
        // On, with a key: create doesn't overwrite it.
        assert!(create(&db, &secrets, &vault, "user_1").is_err());
        assert_eq!(secrets.load_vault_key("user_1").unwrap(), key);
        // The others work for the account.
        assert!(open(&db, &secrets, &vault, "user_1").unwrap());
        // On, but the key is gone from this computer: a new one can be made.
        forget(&db, &secrets, &vault, "user_1").unwrap();
        create(&db, &secrets, &vault, "user_1").unwrap();
        // Off again: any account.
        db.sync_disable().unwrap();
        create(&db, &secrets, &vault, "user_2").unwrap();
        forget(&db, &secrets, &vault, "user_2").unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    fn pulled(k: &VaultKeys, kind: &str, key: &str, plain: &[u8], seq: i64) -> Pulled {
        Pulled { seq, key: key.to_string(), kind: kind.to_string(), data: b64(&crypto::seal(k, kind, key, plain)) }
    }

    fn quarantine(db: &Db) -> Vec<(i64, String, String, String)> {
        let conn = db.conn();
        let mut stmt = conn.prepare("SELECT seq, key, kind, reason FROM sync_quarantine ORDER BY seq").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    fn column(db: &Db, sql: &str) -> Vec<String> {
        let conn = db.conn();
        let mut stmt = conn.prepare(sql).unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    #[test]
    fn a_record_sealed_under_another_records_key_is_quarantined_not_applied() {
        let b = bare_replica("wrong-key");
        let k = keys();
        let stamp = "0000000000001-0000-aaaaaaaa";
        let record = |entity: &str, id: &str| {
            serde_json::json!({
                "e": entity, "id": id,
                "f": { "title": ["Hijacked", stamp], "created_at": [1, stamp], "updated_at": [1, stamp] },
            })
            .to_string()
        };
        let key_of = |name: &str| crypto::item_key(&k, name);
        let items = vec![
            // Sealed for another record, by a record that says it is a different one.
            pulled(&k, "r", &key_of("page/other"), record("page", "victim").as_bytes(), 1),
            // The right key for what it says it is: fine.
            pulled(&k, "r", &key_of("page/fine"), record("page", "fine").as_bytes(), 2),
            // The same id, under another entity's key.
            pulled(&k, "r", &key_of("page/same-id"), record("note", "same-id").as_bytes(), 3),
        ];
        let ingested = b.sync_ingest(&k, &items, 3).unwrap();
        assert_eq!(ingested.skipped, 2);
        let rows = quarantine(&b);
        assert_eq!(rows.iter().map(|r| r.0).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(rows[0].1, key_of("page/other"));
        assert_eq!(rows[0].2, "r");
        assert_eq!(rows[0].3, "sealed under another record's key");
        assert_eq!(column(&b, "SELECT CAST(seq AS TEXT) FROM sync_inbox"), vec!["2".to_string()]);
        b.sync_apply().unwrap();
        assert_eq!(column(&b, "SELECT id FROM pages"), vec!["fine".to_string()], "only the record under its own key");
        // Nothing of the refused ones was remembered, so no later push is wedged by their seq.
        assert_eq!(column(&b, "SELECT id FROM sync_record WHERE id IN ('victim', 'same-id')").len(), 0);
        assert_eq!(b.sync_cursor().unwrap(), 3, "and the cursor moved on");
    }

    #[test]
    fn items_that_do_not_open_are_quarantined_with_a_reason() {
        let b = bare_replica("quarantine");
        let k = keys();
        let key = crypto::item_key(&k, "page/p");
        let text_key = crypto::item_key(&k, "body/p");
        let mut tampered = pulled(&k, "r", &key, b"{\"e\":\"page\",\"id\":\"p\"}", 1);
        let mut bytes = unbase64url(&tampered.data).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        tampered.data = b64(&bytes);
        let items = vec![
            tampered,
            pulled(&k, "r", &key, b"this is not json", 2),
            pulled(&k, "r", &key, b"[1, 2]", 3),
            pulled(&k, "r", &key, &[0xff, 0xfe], 4),
            Pulled { seq: 5, key: key.clone(), kind: "r".into(), data: "!!not base64!!".into() },
            // Sealed with another vault key.
            pulled(&VaultKeys::from_vault_key(&[1u8; 32]), "r", &key, b"{\"e\":\"page\",\"id\":\"p\"}", 6),
            pulled(&k, "y", &text_key, b"no newline", 7),
            pulled(&k, "z", &key, b"anything", 8),
            pulled(&k, "y", &text_key, b"p\nfine", 9),
        ];
        let ingested = b.sync_ingest(&k, &items, 9).unwrap();
        assert_eq!(ingested.skipped, 8);
        let rows = quarantine(&b);
        let reasons: Vec<(i64, &str)> = rows.iter().map(|r| (r.0, r.3.as_str())).collect();
        assert_eq!(
            reasons,
            vec![
                (1, "damaged, changed, or sealed with another key"),
                (2, "not JSON"),
                (3, "not a record"),
                (4, "not text"),
                (5, "not base64"),
                (6, "damaged, changed, or sealed with another key"),
                (7, "page text without a page"),
                (8, "not a kind this version knows"),
            ]
        );
        let kept: Vec<u8> = b.conn().query_row("SELECT data FROM sync_quarantine WHERE seq = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, items[0].data.as_bytes(), "what came, kept as it came");
        let waiting: i64 = b.conn().query_row("SELECT count(*) FROM sync_y_in", [], |r| r.get(0)).unwrap();
        assert_eq!(waiting, 1, "the good one arrived");
        assert_eq!(b.sync_status().unwrap().unreadable, 8);
        // The same items again don't pile up.
        b.sync_ingest(&k, &items, 9).unwrap();
        assert_eq!(quarantine(&b).len(), 8);
        // A newer format still fails the whole call, and keeps nothing.
        let mut newer = pulled(&k, "r", &key, b"{}", 10);
        let mut bytes = unbase64url(&newer.data).unwrap();
        bytes[0] = 2;
        newer.data = b64(&bytes);
        let bad = pulled(&k, "r", &key, b"not json", 11);
        assert!(b.sync_ingest(&k, &[bad, newer], 11).is_err());
        assert_eq!(quarantine(&b).len(), 8);
        assert_eq!(b.sync_cursor().unwrap(), 9);
    }

    #[test]
    fn a_tampered_item_is_skipped_and_the_rest_arrive() {
        let (a, b) = (replica("tamper-a"), replica("tamper-b"));
        a.create_page(None, None, "One", "").unwrap();
        a.create_page(None, None, "Two", "").unwrap();
        let mut mail = mail();
        mail.push_records(&a);
        assert!(mail.items.len() >= 2);
        let mut bytes = unbase64url(&mail.items[0].data).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        mail.items[0].data = b64(&bytes);
        let cursor = mail.items.last().unwrap().seq;
        let ingested = b.sync_ingest(&keys(), &mail.items, cursor).unwrap();
        assert_eq!(ingested.skipped, 1);
        assert_eq!(quarantine(&b).len(), 1, "kept, not lost");
        assert_eq!(b.sync_cursor().unwrap(), cursor);
        b.sync_apply().unwrap();
        assert_eq!(b.list_pages().unwrap().len(), mail.items.len() - 1 + 1, "all but one, and B's own welcome page");
    }

    #[test]
    fn a_newer_format_fails_the_call_and_leaves_the_cursor() {
        let (a, b) = (replica("newer-a"), bare_replica("newer-b"));
        a.create_page(None, None, "One", "").unwrap();
        let mut mail = mail();
        mail.push_records(&a);
        let last = mail.items.len() - 1;
        let mut bytes = unbase64url(&mail.items[last].data).unwrap();
        bytes[0] = 2;
        mail.items[last].data = b64(&bytes);
        let cursor = mail.items.last().unwrap().seq;
        let err = b.sync_ingest(&keys(), &mail.items, cursor).unwrap_err();
        assert_eq!(err.0, CryptoError::NewerFormat.to_string());
        assert_eq!(b.sync_cursor().unwrap(), 0);
        assert!(b.conn().query_row("SELECT count(*) FROM sync_inbox", [], |r| r.get::<_, i64>(0)).unwrap() == 0, "nothing was stored");
    }

    #[test]
    fn a_text_frame_that_is_not_one_is_skipped() {
        let b = replica("frame-b");
        let k = keys();
        let key = crypto::item_key(&k, "body/page-1");
        let item = |plain: &[u8], key: &str, seq: i64| Pulled {
            seq,
            key: key.to_string(),
            kind: "y".into(),
            data: b64(&crypto::seal(&k, "y", key, plain)),
        };
        let items = vec![
            item(b"no newline here", &key, 1),
            item(b"page-2\nsome bytes", &key, 2),
            item(b"\nno page", &crypto::item_key(&k, "body/"), 3),
            item(b"page-1\nfine", &key, 4),
        ];
        let ingested = b.sync_ingest(&k, &items, 4).unwrap();
        assert_eq!(ingested.skipped, 3);
        let waiting: i64 = b.conn().query_row("SELECT count(*) FROM sync_y_in", [], |r| r.get(0)).unwrap();
        assert_eq!(waiting, 1);
    }
}
