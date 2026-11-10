//! Where the notes live: the app's own data folder, or a folder the user
//! chose (OneDrive, a USB drive…). The choice is remembered in
//! `location.json` in the app's own folder, which is always there to read.
//! Moving copies the workspace and never deletes anything: the old folder
//! stays as it was, and notes a folder already had are set aside.

use crate::db::{Db, Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE: &str = "location.json";
const DB: &str = "thoughtdesk.db";

#[derive(Serialize, Deserialize)]
struct Stored {
    dir: PathBuf,
}

/// The folder to open, worked out at start-up.
pub struct Location {
    pub dir: PathBuf,
    /// The app's own folder (where `location.json` lives).
    pub default_dir: PathBuf,
    /// Set by THOUGHTDESK_DATA_DIR, which wins over any choice.
    pub from_env: bool,
    /// Whether `dir` is one the user chose.
    pub chosen: bool,
    /// A chosen folder that wasn't there (a drive not plugged in), so the
    /// app's own folder was opened instead.
    pub missing: Option<PathBuf>,
}

pub fn resolve(default_dir: &Path) -> Location {
    let chosen = std::fs::read_to_string(default_dir.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Stored>(&text).ok())
        .map(|s| s.dir);
    let here = |dir: PathBuf, chosen, missing| Location { dir, default_dir: default_dir.to_path_buf(), from_env: false, chosen, missing };
    match chosen {
        Some(dir) if dir.is_dir() => here(dir, true, None),
        Some(dir) => here(default_dir.to_path_buf(), false, Some(dir)),
        None => here(default_dir.to_path_buf(), false, None),
    }
}

/// Opens `dir` from the next start (None: the app's own folder).
pub fn remember(default_dir: &Path, dir: Option<&Path>) -> Result<()> {
    let file = default_dir.join(FILE);
    match dir {
        Some(dir) if dir != default_dir => {
            std::fs::create_dir_all(default_dir)?;
            std::fs::write(file, serde_json::to_string(&Stored { dir: dir.to_path_buf() })?)?;
        }
        _ => {
            if file.exists() {
                std::fs::remove_file(file)?;
            }
        }
    }
    Ok(())
}

/// What a folder holds, before moving there.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderState {
    /// It has a Thought Desk workspace already.
    pub has_notes: bool,
    /// When that workspace was last changed (ms).
    pub modified: Option<i64>,
}

pub fn inspect(dir: &Path) -> FolderState {
    let modified = [DB, "thoughtdesk.db-wal"]
        .iter()
        .filter_map(|name| std::fs::metadata(dir.join(name)).ok()?.modified().ok())
        .max()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    FolderState { has_notes: dir.join(DB).is_file(), modified }
}

/// Moves a workspace already in `dir` into a dated folder inside it, so a
/// copy can take its place without anything being lost.
fn set_aside(dir: &Path) -> Result<()> {
    let names = [DB, "thoughtdesk.db-wal", "thoughtdesk.db-shm", "files"];
    if !names.iter().any(|n| dir.join(n).exists()) {
        return Ok(());
    }
    let stamp = now_stamp();
    let mut aside = dir.join(format!("Replaced {stamp}"));
    let mut n = 1;
    while aside.exists() {
        n += 1;
        aside = dir.join(format!("Replaced {stamp} ({n})"));
    }
    std::fs::create_dir_all(&aside)?;
    for name in names {
        let from = dir.join(name);
        if from.exists() {
            std::fs::rename(&from, aside.join(name))?;
        }
    }
    Ok(())
}

/// "2026-10-24 0930" in UTC (good enough to tell copies apart).
fn now_stamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}{:02}", rest / 3600, rest % 3600 / 60)
}

impl Db {
    /// Copies the open workspace into `dir`: a consistent snapshot of the
    /// database (taken while the app runs) and the files folder. A workspace
    /// already there is set aside first when `replace`, refused otherwise.
    pub fn copy_to(&self, dir: &Path, replace: bool) -> Result<()> {
        if same_folder(dir, &self.data_dir) {
            return Err(Error("Your notes are already in that folder".into()));
        }
        std::fs::create_dir_all(dir)?;
        if inspect(dir).has_notes {
            if !replace {
                return Err(Error("That folder already has notes".into()));
            }
            set_aside(dir)?;
        } else if has_files(dir) {
            // Someone's own `files` folder, not ours: copying in would mix the two
            // (and the app tidies up strays there). With `replace` it's set aside.
            if !replace {
                return Err(Error("That folder already has a \"files\" folder with things in it. Choose an empty folder instead.".into()));
            }
            set_aside(dir)?;
        }
        let target = dir.join(DB);
        self.conn().execute("VACUUM INTO ?1", [target.to_string_lossy()])?;
        let files = dir.join("files");
        std::fs::create_dir_all(&files)?;
        for entry in std::fs::read_dir(&self.files_dir)?.flatten() {
            if entry.file_type()?.is_file() {
                std::fs::copy(entry.path(), files.join(entry.file_name()))?;
            }
        }
        Ok(())
    }
}

/// Whether `dir` has a `files` folder with anything in it.
fn has_files(dir: &Path) -> bool {
    std::fs::read_dir(dir.join("files")).is_ok_and(|mut entries| entries.next().is_some())
}

/// Whether two paths are the same folder (whatever case or spelling).
pub fn same_folder(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-loc-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn remembers_and_forgets_a_chosen_folder() {
        let home = temp("home");
        let chosen = temp("chosen");
        assert_eq!(resolve(&home).dir, home);
        remember(&home, Some(&chosen)).unwrap();
        let loc = resolve(&home);
        assert!(loc.chosen && loc.dir == chosen && loc.missing.is_none());

        // A drive that isn't plugged in: the app's own folder, and say so.
        std::fs::remove_dir_all(&chosen).unwrap();
        let loc = resolve(&home);
        assert!(!loc.chosen && loc.dir == home && loc.missing == Some(chosen));

        remember(&home, None).unwrap();
        assert!(resolve(&home).missing.is_none());
    }

    #[test]
    fn copies_the_workspace_and_never_overwrites() {
        let (home, other) = (temp("src"), temp("dst"));
        let db = Db::open(&home).unwrap();
        let page = db.create_page(None, None, "Copied page", "").unwrap();
        db.import_file(b"bytes", "note.txt", "text/plain").unwrap();
        assert!(db.copy_to(&home, false).is_err(), "not into its own folder");

        db.copy_to(&other, false).unwrap();
        assert!(inspect(&other).has_notes);
        let copy = Db::open(&other).unwrap();
        assert_eq!(copy.get_page(&page.id).unwrap().meta.title, "Copied page");
        assert_eq!(std::fs::read_dir(other.join("files")).unwrap().count(), 1);
        drop(copy);

        // A folder with notes: refused, unless they're set aside first.
        assert!(db.copy_to(&other, false).is_err());
        db.copy_to(&other, true).unwrap();
        let aside: Vec<_> = std::fs::read_dir(&other)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("Replaced "))
            .collect();
        assert_eq!(aside.len(), 1);
        assert!(aside[0].path().join(DB).is_file(), "the old notes are kept");
    }

    #[test]
    fn refuses_a_folder_with_someone_elses_files() {
        let (home, other) = (temp("mine"), temp("theirs"));
        let db = Db::open(&home).unwrap();
        db.import_file(b"bytes", "note.txt", "text/plain").unwrap();
        std::fs::create_dir_all(other.join("files")).unwrap();
        std::fs::write(other.join("files").join("holiday.jpg"), b"jpg").unwrap();

        let refused = db.copy_to(&other, false).unwrap_err();
        assert!(refused.0.contains("files"), "{}", refused.0);
        assert!(other.join("files").join("holiday.jpg").is_file());
        assert!(!other.join(DB).exists(), "nothing was copied in");

        // An empty `files` folder is fine.
        let empty = temp("empty");
        std::fs::create_dir_all(empty.join("files")).unwrap();
        db.copy_to(&empty, false).unwrap();
        assert!(inspect(&empty).has_notes);

        // A folder that already holds notes keeps the "open those notes" path.
        drop(Db::open(&other).unwrap());
        assert!(inspect(&other).has_notes);
        assert!(db.copy_to(&other, false).unwrap_err().0.contains("already has notes"));
    }

    #[test]
    fn replacing_sets_someone_elses_files_aside() {
        let (home, other) = (temp("mine2"), temp("theirs2"));
        let db = Db::open(&home).unwrap();
        std::fs::create_dir_all(other.join("files")).unwrap();
        std::fs::write(other.join("files").join("holiday.jpg"), b"jpg").unwrap();
        db.copy_to(&other, true).unwrap();
        let aside = std::fs::read_dir(&other).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with("Replaced ")).unwrap();
        assert!(aside.path().join("files").join("holiday.jpg").is_file());
        assert!(!other.join("files").join("holiday.jpg").exists());
    }

    #[test]
    fn stamps_dates() {
        let s = now_stamp();
        assert_eq!(s.len(), 15, "{s}");
        assert!(s.starts_with("20"));
    }
}
