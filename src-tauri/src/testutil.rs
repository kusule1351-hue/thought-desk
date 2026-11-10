//! Folders the tests make in the temp folder, removed again when the test ends,
//! pass or fail. Only a run that's killed outright leaves its folders behind.

use crate::db::Db;
use std::ops::Deref;
use std::path::{Path, PathBuf};

/// A new, empty folder named `<prefix>-<uuid>`, removed when dropped.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("make temp dir");
        TempDir(dir)
    }
}

impl Deref for TempDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TempDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Never panic here: a panic while a failing test unwinds aborts the run.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A database in a `TempDir` of its own. Fields drop in order, so the
/// connections close before the folder goes (Windows won't delete open files).
pub struct TempDb {
    db: Db,
    _dir: TempDir,
}

impl TempDb {
    pub fn new(prefix: &str) -> Self {
        let dir = TempDir::new(prefix);
        TempDb { db: Db::open(&dir).expect("open db"), _dir: dir }
    }
}

impl Deref for TempDb {
    type Target = Db;

    fn deref(&self) -> &Db {
        &self.db
    }
}
