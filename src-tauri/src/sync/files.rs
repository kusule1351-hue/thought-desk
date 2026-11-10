//! The bytes of files, which travel apart from records: encrypted in chunks of
//! at most 8 MiB, one blob per chunk. `sync_file` remembers per file whether
//! its bytes are in the mailbox. A stored name ends up in a path, so every
//! function here that takes one checks it first.

use super::crypto::{self, VaultKeys};
use crate::db::{Db, Error, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};

/// Bytes of a file in one chunk.
pub(crate) const CHUNK: u64 = 8 * 1024 * 1024;
/// Files handed out per list and cycle.
const LIST: usize = 20;
/// The biggest file that is synced. A bigger one is left alone: not listed, and an error if asked for.
pub(crate) const MAX_SIZE: i64 = 4 << 30;
/// The chunks of a file that big (and of no bigger one).
const MAX_CHUNKS: i64 = MAX_SIZE / CHUNK as i64;

/// Names Windows keeps for devices, with or without an extension.
fn is_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// `^[A-Za-z0-9.]+$`, never starting with a dot, and no `..`: safe to join to a folder
/// on every system. Also not a Windows device name (`CON`, `COM1.png`), not ending in a
/// dot or a space, and not ending in `.part`, which is where a download is built.
pub(crate) fn valid_stored(name: &str) -> bool {
    crate::files::is_valid_name(name)
        && !name.contains("..")
        && !name.ends_with(['.', ' '])
        && !name.to_ascii_lowercase().ends_with(".part")
        && !is_device_name(name)
}

fn checked(name: &str) -> Result<&str> {
    if valid_stored(name) {
        Ok(name)
    } else {
        Err(Error("That isn't the name of a stored file".into()))
    }
}

/// Whether the bytes of a file of this size are synced.
fn in_range(size: i64) -> bool {
    (0..=MAX_SIZE).contains(&size)
}

fn chunk_count(size: i64, chunk: u64) -> i64 {
    (size.max(0) as u64).div_ceil(chunk).max(1) as i64
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub id: String,
    pub stored: String,
    pub chunks: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesTodo {
    pub upload: Vec<FileRef>,
    pub download: Vec<FileRef>,
    pub remove: Vec<FileRef>,
}

struct Row {
    file: FileRef,
    uploaded: bool,
    size: i64,
}

impl Db {
    pub fn sync_files_todo(&self) -> Result<FilesTodo> {
        self.files_todo_with(CHUNK)
    }

    fn files_todo_with(&self, chunk: u64) -> Result<FilesTodo> {
        let (rows, remove) = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT OR IGNORE INTO sync_file (id, stored, chunks) SELECT id, stored, max(1, (size + ?1 - 1) / ?1) FROM files
                 WHERE size BETWEEN 0 AND ?2",
                params![chunk as i64, MAX_SIZE],
            )?;
            tx.commit()?;
            let rows = {
                let mut stmt = conn.prepare(
                    "SELECT s.id, f.stored, s.chunks, s.uploaded, f.size FROM sync_file s JOIN files f ON f.id = s.id
                     ORDER BY f.created_at, f.id",
                )?;
                let rows = stmt.query_map([], |r| {
                    Ok(Row {
                        file: FileRef { id: r.get(0)?, stored: r.get(1)?, chunks: r.get(2)? },
                        uploaded: r.get(3)?,
                        size: r.get(4)?,
                    })
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut stmt = conn.prepare("SELECT id, stored, chunks FROM sync_file WHERE id NOT IN (SELECT id FROM files)")?;
            let gone = stmt.query_map([], |r| Ok(FileRef { id: r.get(0)?, stored: r.get(1)?, chunks: r.get(2)? }))?;
            (rows, gone.collect::<rusqlite::Result<Vec<_>>>()?)
        };
        let mut todo = FilesTodo {
            remove: remove.into_iter().filter(|f| valid_stored(&f.stored)).take(LIST).collect(),
            ..Default::default()
        };
        for row in rows {
            // A name that isn't one is passed over, not a reason to stop syncing the rest.
            if !valid_stored(&row.file.stored) || !in_range(row.size) {
                continue;
            }
            match fs::metadata(self.files_dir.join(&row.file.stored)) {
                Err(_) if todo.download.len() < LIST => todo.download.push(row.file),
                Ok(m) if !row.uploaded && m.len() as i64 == row.size && todo.upload.len() < LIST => todo.upload.push(row.file),
                _ => {}
            }
        }
        Ok(todo)
    }

    /// What the server calls each chunk of a file.
    pub fn sync_file_names(&self, keys: &VaultKeys, stored: &str, chunks: i64) -> Result<Vec<String>> {
        checked(stored)?;
        if !(1..=MAX_CHUNKS).contains(&chunks) {
            return Err(Error("A file with an unexpected number of pieces".into()));
        }
        // A file that is in the library and too big has no pieces to name.
        if self.file_size(stored).is_ok_and(|size| !in_range(size)) {
            return Err(Error("That file is too big to sync".into()));
        }
        Ok((0..chunks as u32).map(|i| crypto::blob_name(keys, stored, i)).collect())
    }

    fn file_size(&self, stored: &str) -> Result<i64> {
        let size = self.conn().query_row("SELECT size FROM files WHERE stored = ?1", [stored], |r| r.get(0)).optional()?;
        size.ok_or_else(|| Error("That file isn't in the library".into()))
    }

    pub fn sync_file_seal(&self, keys: &VaultKeys, stored: &str, index: u32) -> Result<Vec<u8>> {
        self.file_seal_with(keys, stored, index, CHUNK)
    }

    /// One chunk of a file, read with a seek and sealed.
    fn file_seal_with(&self, keys: &VaultKeys, stored: &str, index: u32, chunk: u64) -> Result<Vec<u8>> {
        checked(stored)?;
        let size = self.file_size(stored)?;
        if !in_range(size) {
            return Err(Error("That file is too big to sync".into()));
        }
        if i64::from(index) >= chunk_count(size, chunk) {
            return Err(Error("That piece isn't part of the file".into()));
        }
        let mut file = File::open(self.files_dir.join(stored))?;
        if file.metadata()?.len() as i64 != size {
            return Err(Error("The file changed on this computer, so it isn't sent".into()));
        }
        let offset = u64::from(index) * chunk;
        let mut bytes = vec![0u8; (size as u64 - offset).min(chunk) as usize];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut bytes)?;
        Ok(crypto::seal_file_chunk(keys, &crypto::blob_name(keys, stored, index), &bytes))
    }

    pub fn sync_file_open(&self, keys: &VaultKeys, stored: &str, index: u32, chunks: i64, sealed: &[u8]) -> Result<bool> {
        self.file_open_with(keys, stored, index, chunks, sealed, CHUNK)
    }

    /// Writes one chunk into `<stored>.part`. With the last one the file is
    /// checked against its size and moved into place. Chunks must come in
    /// order, from 0: any error leaves no `.part`, and the next try starts over.
    fn file_open_with(&self, keys: &VaultKeys, stored: &str, index: u32, chunks: i64, sealed: &[u8], chunk: u64) -> Result<bool> {
        checked(stored)?;
        let opened = self.write_chunk(keys, stored, index, chunks, sealed, chunk);
        if opened.is_err() {
            let _ = fs::remove_file(self.files_dir.join(format!("{stored}.part")));
        }
        opened
    }

    fn write_chunk(&self, keys: &VaultKeys, stored: &str, index: u32, chunks: i64, sealed: &[u8], chunk: u64) -> Result<bool> {
        let size = self.file_size(stored)?;
        if !in_range(size) {
            return Err(Error("That file is too big to sync".into()));
        }
        let count = chunk_count(size, chunk);
        if chunks != count || i64::from(index) >= count {
            return Err(Error("The pieces of that file don't match its record".into()));
        }
        let plain = crypto::open_file_chunk(keys, &crypto::blob_name(keys, stored, index), sealed)?;
        let part = self.files_dir.join(format!("{stored}.part"));
        let offset = u64::from(index) * chunk;
        if plain.len() as u64 != (size as u64 - offset).min(chunk) {
            return Err(Error("The file came out the wrong size, so it was dropped".into()));
        }
        // The first piece starts the file; each one after it goes exactly where the last ended.
        if index > 0 && fs::metadata(&part).map_or(0, |m| m.len()) != offset {
            return Err(Error("The pieces of that file came out of order, so it was dropped".into()));
        }
        let mut out = OpenOptions::new().write(true).create(true).truncate(index == 0).open(&part)?;
        out.seek(SeekFrom::Start(offset))?;
        out.write_all(&plain)?;
        drop(out);
        if i64::from(index) + 1 < count {
            return Ok(false);
        }
        if fs::metadata(&part)?.len() as i64 != size {
            return Err(Error("The file came out the wrong size, so it was dropped".into()));
        }
        let place = self.files_dir.join(stored);
        if place.exists() {
            let _ = fs::remove_file(&part);
        } else {
            fs::rename(&part, &place)?;
        }
        self.conn().execute(
            "INSERT INTO sync_file (id, stored, chunks, uploaded) SELECT id, stored, ?2, 1 FROM files WHERE stored = ?1
             ON CONFLICT (id) DO UPDATE SET uploaded = 1",
            params![stored, count],
        )?;
        Ok(true)
    }

    /// `uploaded`: the bytes are in the mailbox. `removed`: they've been deleted from it.
    pub fn sync_file_done(&self, id: &str, step: &str) -> Result<()> {
        let sql = match step {
            "uploaded" => "UPDATE sync_file SET uploaded = 1 WHERE id = ?1",
            "removed" => "DELETE FROM sync_file WHERE id = ?1",
            _ => return Err(Error("Not a step of a file".into())),
        };
        self.conn().execute(sql, [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::testkit::{keys, mail, replica};

    const SMALL: u64 = 10;

    /// Everything of one file, from one copy into another.
    fn transfer(from: &Db, to: &Db, file: &FileRef, chunk: u64) -> Result<bool> {
        let k = keys();
        let mut done = false;
        for index in 0..file.chunks as u32 {
            let sealed = from.file_seal_with(&k, &file.stored, index, chunk)?;
            done = to.file_open_with(&k, &file.stored, index, file.chunks, &sealed, chunk)?;
        }
        Ok(done)
    }

    #[test]
    fn a_file_bigger_than_a_chunk_goes_across() {
        let (a, b) = (replica("files-a"), replica("files-b"));
        let bytes: Vec<u8> = (0..25u8).collect();
        let file = a.import_file(&bytes, "Notes.pdf", "").unwrap();
        mail().move_records(&a, &b);

        let todo = a.files_todo_with(SMALL).unwrap();
        assert_eq!(todo.upload, vec![FileRef { id: file.id.clone(), stored: file.stored.clone(), chunks: 3 }]);
        assert!(todo.download.is_empty());

        let todo = b.files_todo_with(SMALL).unwrap();
        assert!(todo.upload.is_empty(), "no bytes to send");
        assert_eq!(todo.download.len(), 1);
        let wanted = todo.download[0].clone();
        assert_eq!(wanted.chunks, 3);
        assert_eq!(b.sync_file_names(&keys(), &wanted.stored, 3).unwrap().len(), 3);

        assert!(transfer(&a, &b, &wanted, SMALL).unwrap());
        assert_eq!(fs::read(b.files_dir.join(&file.stored)).unwrap(), bytes);
        assert!(!b.files_dir.join(format!("{}.part", file.stored)).exists());
        let todo = b.files_todo_with(SMALL).unwrap();
        assert!(todo.download.is_empty() && todo.upload.is_empty(), "arrived, and not for sending back");

        a.sync_file_done(&file.id, "uploaded").unwrap();
        assert!(a.files_todo_with(SMALL).unwrap().upload.is_empty());
    }

    #[test]
    fn a_file_with_the_wrong_size_is_dropped() {
        let (a, b) = (replica("size-a"), replica("size-b"));
        let file = a.import_file(&[7u8; 25], "Notes.pdf", "").unwrap();
        mail().move_records(&a, &b);
        let k = keys();
        let stored = file.stored.clone();
        // The right pieces for another size: the second chunk is short.
        let mut sealed = Vec::new();
        for (index, len) in [(0u32, 10usize), (1, 10), (2, 3)] {
            let bytes = vec![7u8; len];
            sealed.push(crypto::seal_file_chunk(&k, &crypto::blob_name(&k, &stored, index), &bytes));
        }
        assert!(b.file_open_with(&k, &stored, 0, 3, &sealed[0], SMALL).unwrap() == false);
        assert!(b.files_dir.join(format!("{stored}.part")).exists());
        assert!(b.file_open_with(&k, &stored, 1, 3, &sealed[1], SMALL).unwrap() == false);
        assert!(b.file_open_with(&k, &stored, 2, 3, &sealed[2], SMALL).is_err());
        assert!(!b.files_dir.join(format!("{stored}.part")).exists(), "the half-made file is gone");
        assert!(!b.files_dir.join(&stored).exists());
        // A damaged piece is refused too.
        let mut bad = sealed[0].clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(b.file_open_with(&k, &stored, 0, 3, &bad, SMALL).is_err());
        assert!(b.file_open_with(&k, &stored, 0, 4, &sealed[0], SMALL).is_err(), "a different number of pieces");
    }

    #[test]
    fn a_bad_stored_name_fails_everywhere() {
        let a = replica("evil");
        let k = keys();
        for name in ["../evil", "..", ".", "a/b", "a\\b", "", "x..y", ".hidden", "a b"] {
            assert!(!valid_stored(name), "{name:?}");
            assert!(a.sync_file_names(&k, name, 1).is_err(), "{name:?}");
            assert!(a.sync_file_seal(&k, name, 0).is_err(), "{name:?}");
            assert!(a.sync_file_open(&k, name, 0, 1, b"x").is_err(), "{name:?}");
        }
        assert!(valid_stored("0b9a1c2d3e4f4a5b8c6d7e8f9a0b1c2d.pdf"));
        // A record naming one fails alone and never reaches a path.
        let good = a.import_file(b"abc", "Good.txt", "").unwrap();
        let mut mail = mail();
        mail.push_raw_record(&a, "file", "evil-file", serde_json::json!({
            "name": ["x", "0000000000001-0000-aaaaaaaa"], "stored": ["../../evil.txt", "0000000000001-0000-aaaaaaaa"],
            "mime": ["", "0000000000001-0000-aaaaaaaa"], "size": [3, "0000000000001-0000-aaaaaaaa"],
            "created_at": [1, "0000000000001-0000-aaaaaaaa"], "updated_at": [1, "0000000000001-0000-aaaaaaaa"], "deleted_at": [null, "0000000000001-0000-aaaaaaaa"],
        }));
        let b = replica("evil-b");
        let applied = mail.deliver(&b);
        assert_eq!(applied.skipped, 1);
        let count: i64 = b.conn().query_row("SELECT count(*) FROM files", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0, "nothing of a bad record was written");
        let _ = good;
    }

    #[test]
    fn windows_names_and_part_files_are_not_stored_names() {
        for name in [
            "CON", "con", "Con.txt", "PRN", "prn.pdf", "AUX", "aux.tar.gz", "NUL", "nul.", "nUl.png", "COM1", "com9.txt", "LPT1", "lpt9.png", "Lpt5",
            "file.", "a.b.", "x.part", "x.PART", "x.Part", "0b9a1c2d3e4f4a5b8c6d7e8f9a0b1c2d.pdf.part", ".part", ".hidden", "a b", "a ", "",
        ] {
            assert!(!valid_stored(name), "{name:?}");
        }
        // Near misses are fine.
        for name in ["COM0", "COM10", "LPT0", "CONSOLE.txt", "console", "nullable.png", "xcom1.txt", "com.txt", "partial.pdf", "a.parts", "part", "a.b", "A1"] {
            assert!(valid_stored(name), "{name:?}");
        }
        assert!(valid_stored("0b9a1c2d3e4f4a5b8c6d7e8f9a0b1c2d.pdf"));
        // Every function that takes a stored name refuses them, and so does a record that names one.
        let a = replica("reserved");
        let k = keys();
        for name in ["CON", "com1.txt", "x.part", "file."] {
            assert!(a.sync_file_names(&k, name, 1).is_err(), "{name:?}");
            assert!(a.sync_file_seal(&k, name, 0).is_err(), "{name:?}");
            assert!(a.sync_file_open(&k, name, 0, 1, b"x").is_err(), "{name:?}");
        }
        let mut mail = mail();
        let stamp = "0000000000001-0000-aaaaaaaa";
        mail.push_raw_record(&a, "file", "reserved-file", serde_json::json!({
            "name": ["x", stamp], "stored": ["NUL.txt", stamp], "mime": ["", stamp], "size": [3, stamp],
            "created_at": [1, stamp], "updated_at": [1, stamp], "deleted_at": [null, stamp],
        }));
        let b = replica("reserved-b");
        assert_eq!(mail.deliver(&b).skipped, 1);
        let count: i64 = b.conn().query_row("SELECT count(*) FROM files", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    /// The sealed pieces of a 25-byte file in chunks of 10, and a copy that has the record but not the bytes.
    fn pieces(name: &str) -> (crate::testutil::TempDb, Vec<Vec<u8>>, String) {
        let (a, b) = (replica(&format!("{name}-a")), replica(&format!("{name}-b")));
        let file = a.import_file(&(0..25u8).collect::<Vec<_>>(), "Notes.pdf", "").unwrap();
        mail().move_records(&a, &b);
        let k = keys();
        let sealed = (0..3).map(|i| a.file_seal_with(&k, &file.stored, i, SMALL).unwrap()).collect();
        (b, sealed, file.stored)
    }

    #[test]
    fn pieces_must_come_in_order_and_a_mistake_leaves_nothing() {
        let (b, sealed, stored) = pieces("order");
        let k = keys();
        let part = b.files_dir.join(format!("{stored}.part"));
        let open = |i: u32| b.file_open_with(&k, &stored, i, 3, &sealed[i as usize], SMALL);

        // The last piece alone: no sparse file made whole.
        assert!(open(2).is_err());
        assert!(!part.exists() && !b.files_dir.join(&stored).exists());
        // A missing middle piece.
        assert!(!open(0).unwrap());
        assert!(part.exists());
        assert!(open(2).is_err());
        assert!(!part.exists(), "the half-made file is gone");
        // A retry from the middle, after the start was lost.
        assert!(open(1).is_err());
        assert!(!part.exists());
        // A retry of a piece already in: also refused, and starts over.
        assert!(!open(0).unwrap());
        assert!(!open(1).unwrap());
        assert!(open(1).is_err());
        assert!(!part.exists());
        // A stale start isn't continued: 0 truncates.
        assert!(!open(0).unwrap());
        assert!(!open(0).unwrap());
        assert_eq!(fs::metadata(&part).unwrap().len(), 10);
        assert!(!open(1).unwrap());
        assert!(open(2).unwrap());
        assert!(!part.exists());
        assert_eq!(fs::read(b.files_dir.join(&stored)).unwrap(), (0..25u8).collect::<Vec<_>>());
    }

    #[test]
    fn a_huge_size_is_left_alone() {
        let (b, sealed, stored) = pieces("huge");
        let k = keys();
        let part = b.files_dir.join(format!("{stored}.part"));
        let set_size = |size: i64| b.conn().execute("UPDATE files SET size = ?1 WHERE stored = ?2", params![size, stored]).unwrap();
        assert_eq!(b.files_todo_with(SMALL).unwrap().download.len(), 1);
        // A piece that was already in is dropped when the size turns out to be too big.
        assert!(!b.file_open_with(&k, &stored, 0, 3, &sealed[0], SMALL).unwrap());
        for size in [MAX_SIZE + 1, 1 << 45, i64::MAX, -1] {
            set_size(size);
            assert!(b.file_open_with(&k, &stored, 0, 3, &sealed[0], SMALL).is_err(), "{size}");
            assert!(b.sync_file_open(&k, &stored, 0, 3, &sealed[0]).is_err(), "{size}");
            assert!(b.sync_file_seal(&k, &stored, 0).is_err(), "{size}");
            assert!(b.sync_file_names(&k, &stored, 3).is_err(), "{size}");
            assert!(!part.exists(), "{size}");
        }
        let todo = b.files_todo_with(SMALL).unwrap();
        assert!(todo.download.is_empty() && todo.upload.is_empty(), "not listed");
        // The biggest one is still fine to ask about.
        set_size(MAX_SIZE);
        assert_eq!(b.sync_file_names(&k, &stored, MAX_CHUNKS).unwrap().len() as i64, MAX_CHUNKS);
        assert!(b.sync_file_names(&k, &stored, MAX_CHUNKS + 1).is_err());
        // Names of a file that is gone from the library are still asked for, to remove its pieces.
        assert!(b.sync_file_names(&k, "0b9a1c2d3e4f4a5b8c6d7e8f9a0b1c2d.pdf", 3).is_ok());
        assert!(b.sync_file_names(&k, "0b9a1c2d3e4f4a5b8c6d7e8f9a0b1c2d.pdf", MAX_CHUNKS + 1).is_err());
        set_size(25);
        assert_eq!(b.files_todo_with(SMALL).unwrap().download.len(), 1, "a normal size is listed again");
    }

    #[test]
    fn a_survivor_of_a_delete_goes_up_again() {
        let (a, b) = (replica("keep-a"), replica("keep-b"));
        let file = a.import_file(b"bytes", "Keep.txt", "").unwrap();
        let mut mail = mail();
        mail.move_records(&a, &b);
        a.files_todo_with(SMALL).unwrap();
        a.sync_file_done(&file.id, "uploaded").unwrap();
        b.files_todo_with(SMALL).unwrap();
        // B deletes it for good; A edits it before hearing.
        b.trash_item(crate::db::Table::Files, &file.id).unwrap();
        b.delete_item(crate::db::Table::Files, &file.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        a.update_file(&file.id, crate::library::FilePatch { name: Some("Kept.txt".into()) }).unwrap();
        mail.move_records(&b, &a);
        assert!(a.files_todo_with(SMALL).unwrap().upload.iter().any(|f| f.id == file.id), "uploaded again");
        // And what was deleted is a thing to clear from the mailbox.
        let todo = b.files_todo_with(SMALL).unwrap();
        assert_eq!(todo.remove.len(), 1);
        b.sync_file_done(&todo.remove[0].id, "removed").unwrap();
        assert!(b.files_todo_with(SMALL).unwrap().remove.is_empty());
    }
}
