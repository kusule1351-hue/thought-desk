//! Automatic backups of the notes database.
//!
//! About once a day, while the app is open, a consistent copy of
//! `thoughtdesk.db` is written with `VACUUM INTO` into a `Backups` folder in
//! the app's own folder: never in a folder the user chose, which may be on a
//! cloud drive that damages the database and would take the backups with it.
//! A copy the same as the newest one isn't kept, and a database that fails
//! SQLite's quick check is never copied, so damage can't push good backups out.
//! Seven daily backups and four weekly ones are kept.
//!
//! The copy is made on a connection of its own, which only reads: saving a
//! page never waits for it. Whatever goes wrong (a full disk, a folder that
//! can't be written), the live database isn't touched.
//!
//! Only the database is copied, not the `files` folder: added files are never
//! changed once stored, and the app only removes one a day after nothing
//! refers to it.
//!
//! Restoring is done at the next start, before the database is opened: the
//! current database is moved into a "Replaced <date>" folder beside it (as
//! `location.rs` does), never written over, and the backup is copied in.

use crate::db::{Error, Result};
use crate::location::{aside_folder, same_folder, stamp};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub const FOLDER: &str = "Backups";
const DB: &str = "thoughtdesk.db";
/// The database and what SQLite keeps beside it while it's open.
const LIVE: [&str; 3] = [DB, "thoughtdesk.db-wal", "thoughtdesk.db-shm"];
/// A backup is "thoughtdesk 2026-10-24 0930.db" (UTC, as `location::stamp` writes it).
const PREFIX: &str = "thoughtdesk ";
/// The copy while it's being written: only a whole one gets a backup's name.
const PARTIAL: &str = "snapshot.partial";
const STATE: &str = "state.json";
const PENDING: &str = "restore.json";
/// The backup on its way in, in the notes folder, during a restore.
const INCOMING: &str = "thoughtdesk.db.restoring";
const DAY: i64 = 86_400_000;
/// A backup is due this long after the last one was made or found unneeded:
/// under a day, so someone who opens the app at the same hour gets one daily.
const EVERY: i64 = 20 * 3_600_000;
const DAILY: usize = 7;
const WEEKLY: usize = 4;

/// Why the last attempt made no backup.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    /// The database failed its check: the older backups are all there is.
    Damaged,
    /// The copy couldn't be written (a full disk, say). It's tried again.
    Failed,
}

/// What's remembered between runs, in the backups folder.
#[derive(Default, Serialize, Deserialize)]
struct State {
    /// When a backup was last made or found unneeded (ms).
    #[serde(default)]
    checked_at: i64,
    #[serde(default)]
    problem: Option<Problem>,
}

fn read_state(dir: &Path) -> State {
    std::fs::read_to_string(dir.join(STATE)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Backup {
    pub name: String,
    /// When it was made (ms), read from its name.
    pub at: i64,
    pub bytes: u64,
}

/// When a backup was made, from its name; None for any other file.
fn time_of(name: &str) -> Option<i64> {
    let rest = name.strip_prefix(PREFIX)?.strip_suffix(".db")?;
    if rest.len() < 15 || !rest.is_char_boundary(15) {
        return None;
    }
    // "2026-10-24 0930", then " (2)" for a second one in the same minute.
    let (date, extra) = rest.split_at(15);
    let nth = match extra {
        "" => 0,
        _ => extra.strip_prefix(" (")?.strip_suffix(')')?.parse::<u16>().ok()?,
    };
    let shaped = date.bytes().enumerate().all(|(i, b)| match i {
        4 | 7 => b == b'-',
        10 => b == b' ',
        _ => b.is_ascii_digit(),
    });
    if !shaped {
        return None;
    }
    let num = |from: usize, to: usize| date[from..to].parse::<i64>().ok();
    let (y, m, d, h, min) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(13, 15)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || min > 59 {
        return None;
    }
    // Days since 1970 from a civil date (Howard Hinnant's algorithm, as in `stamp`).
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    // A later one of the same minute sorts as newer.
    Some((days * 86_400 + h * 3600 + min * 60) * 1000 + i64::from(nth))
}

/// The backups in `dir`, newest first. Other files there are left out, and left alone.
pub fn list(dir: &Path) -> Vec<Backup> {
    let mut found: Vec<Backup> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let at = time_of(&name)?;
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| Backup { name, at, bytes: meta.len() })
        })
        .collect();
    found.sort_by(|a, b| b.at.cmp(&a.at));
    found
}

/// Whether a database passes SQLite's quick check.
fn sound(conn: &Connection) -> rusqlite::Result<bool> {
    let first: String = conn.query_row("PRAGMA quick_check(1)", [], |r| r.get(0))?;
    Ok(first == "ok")
}

fn read_only(file: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(Duration::from_secs(10))?;
    Ok(conn)
}

enum Trouble {
    Damaged,
    Failed(String),
}

impl From<rusqlite::Error> for Trouble {
    fn from(e: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode::{DatabaseCorrupt, NotADatabase};
        match e.sqlite_error_code() {
            Some(DatabaseCorrupt | NotADatabase) => Trouble::Damaged,
            _ => Trouble::Failed(e.to_string()),
        }
    }
}

impl From<std::io::Error> for Trouble {
    fn from(e: std::io::Error) -> Self {
        Trouble::Failed(e.to_string())
    }
}

fn remove_if_there(file: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Whether two files hold the same bytes.
fn same_bytes(a: &Path, b: &Path) -> std::io::Result<bool> {
    if std::fs::metadata(a)?.len() != std::fs::metadata(b)?.len() {
        return Ok(false);
    }
    let (mut a, mut b) = (std::fs::File::open(a)?, std::fs::File::open(b)?);
    let (mut x, mut y) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    // Fills the buffer unless the file ends first.
    fn fill(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut n = 0;
        while n < buf.len() {
            match file.read(&mut buf[n..])? {
                0 => break,
                read => n += read,
            }
        }
        Ok(n)
    }
    loop {
        let (n, m) = (fill(&mut a, &mut x)?, fill(&mut b, &mut y)?);
        if n != m || x[..n] != y[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// Writes a backup of the database in `data_dir` into `dir`. None when it
/// would be the same as the newest one there.
fn snapshot(data_dir: &Path, dir: &Path, now: i64) -> std::result::Result<Option<Backup>, Trouble> {
    std::fs::create_dir_all(dir)?;
    let partial = dir.join(PARTIAL);
    // `VACUUM INTO` can't write over a file.
    remove_if_there(&partial)?;
    {
        // A connection of its own, which only reads: nothing waits for it.
        let source = read_only(&data_dir.join(DB))?;
        if !sound(&source)? {
            return Err(Trouble::Damaged);
        }
        source.execute("VACUUM INTO ?1", [partial.to_string_lossy()])?;
    }
    // The copy must read back whole before it counts as a backup.
    let whole = read_only(&partial).and_then(|copy| sound(&copy));
    if !matches!(whole, Ok(true)) {
        return Err(Trouble::Failed("The backup didn't read back whole".into()));
    }
    std::fs::OpenOptions::new().write(true).open(&partial)?.sync_all()?;
    if let Some(newest) = list(dir).first() {
        if same_bytes(&partial, &dir.join(&newest.name))? {
            std::fs::remove_file(&partial)?;
            return Ok(None);
        }
    }
    let date = stamp(now);
    let mut name = format!("{PREFIX}{date}.db");
    let mut n = 1;
    while dir.join(&name).exists() {
        n += 1;
        name = format!("{PREFIX}{date} ({n}).db");
    }
    std::fs::rename(&partial, dir.join(&name))?;
    let bytes = std::fs::metadata(dir.join(&name))?.len();
    Ok(Some(Backup { at: time_of(&name).unwrap_or(now), name, bytes }))
}

/// Which of `all` (newest first) to keep: the newest of each of the last
/// seven days that have one, then the newest of each of four weeks before those.
fn kept(all: &[Backup]) -> Vec<&str> {
    let (mut days, mut weeks, mut keep) = (Vec::new(), Vec::new(), Vec::new());
    for backup in all {
        let day = backup.at.div_euclid(DAY);
        if days.contains(&day) {
            continue;
        }
        if days.len() < DAILY {
            days.push(day);
            keep.push(backup.name.as_str());
            continue;
        }
        let week = day.div_euclid(7);
        if weeks.len() < WEEKLY && !weeks.contains(&week) {
            weeks.push(week);
            keep.push(backup.name.as_str());
        }
    }
    keep
}

/// Deletes the backups that are no longer kept. Only files named as backups go.
fn rotate(dir: &Path) {
    let all = list(dir);
    let keep = kept(&all);
    for backup in &all {
        if !keep.contains(&backup.name.as_str()) {
            let _ = std::fs::remove_file(dir.join(&backup.name));
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Made(Backup),
    /// The notes are as they were at the newest backup.
    Unchanged,
    NotDue,
    /// The database failed its check: nothing was copied, nothing removed.
    Damaged,
    Failed(String),
}

/// Makes a backup of the database in `data_dir` if one is due at `now` (ms),
/// or whenever `force`. The live database is only read.
pub fn run(data_dir: &Path, dir: &Path, now: i64, force: bool) -> Outcome {
    let mut state = read_state(dir);
    // A clock that was set back mustn't stop backups until it catches up.
    if !force && state.checked_at <= now && now - state.checked_at < EVERY {
        return Outcome::NotDue;
    }
    let outcome = match snapshot(data_dir, dir, now) {
        Ok(Some(backup)) => {
            rotate(dir);
            Outcome::Made(backup)
        }
        Ok(None) => Outcome::Unchanged,
        Err(Trouble::Damaged) => Outcome::Damaged,
        Err(Trouble::Failed(why)) => Outcome::Failed(why),
    };
    match outcome {
        Outcome::Damaged => state.problem = Some(Problem::Damaged),
        // `checked_at` stays, so it's tried again at the next look.
        Outcome::Failed(_) => state.problem = Some(Problem::Failed),
        _ => {
            state.checked_at = now;
            state.problem = None;
        }
    }
    let _ = std::fs::remove_file(dir.join(PARTIAL));
    if let Ok(text) = serde_json::to_string(&state) {
        let _ = std::fs::write(dir.join(STATE), text);
    }
    outcome
}

// ------------------------------------------------------------------ restore

/// A restore asked for, to do at the next start.
#[derive(Serialize, Deserialize)]
struct Pending {
    name: String,
    /// The notes folder it was asked for: another one is never touched.
    data_dir: PathBuf,
}

/// Asks for the backup `name` to take the place of the notes in `data_dir`
/// at the next start. Nothing changes until then.
pub fn request_restore(dir: &Path, data_dir: &Path, name: &str) -> Result<()> {
    // A name from the list, so never a path to somewhere else.
    if !list(dir).iter().any(|b| b.name == name) {
        return Err(Error("That backup isn't there any more".into()));
    }
    let readable = read_only(&dir.join(name)).and_then(|backup| {
        let ok = sound(&backup)?;
        backup.query_row("SELECT count(*) FROM pages", [], |r| r.get::<_, i64>(0))?;
        Ok(ok)
    });
    if !matches!(readable, Ok(true)) {
        return Err(Error("That backup can't be read, so nothing was changed".into()));
    }
    let pending = Pending { name: name.to_string(), data_dir: data_dir.to_path_buf() };
    std::fs::write(dir.join(PENDING), serde_json::to_string(&pending)?)?;
    Ok(())
}

/// At start-up, before the database is opened: does the restore that was
/// asked for, if any. Gives the folder the notes were set aside in.
pub fn apply_pending(dir: &Path, data_dir: &Path, now: i64) -> Option<Result<PathBuf>> {
    // A restore cut short (the power went) between setting the notes aside
    // and putting the backup in: the copy was whole by then, so it goes in
    // now, rather than the app starting on empty notes. Any other leftover
    // copy is only a copy.
    let incoming = data_dir.join(INCOMING);
    if incoming.is_file() {
        let _ = match LIVE.iter().any(|name| data_dir.join(name).exists()) {
            true => std::fs::remove_file(&incoming),
            false => std::fs::rename(&incoming, data_dir.join(DB)),
        };
    }
    let file = dir.join(PENDING);
    let text = std::fs::read_to_string(&file).ok()?;
    // Asked once, tried once: a restore that fails mustn't fail at every start.
    let _ = std::fs::remove_file(&file);
    let attempt = || {
        let pending: Pending = serde_json::from_str(&text)?;
        // A chosen folder that isn't there today (a drive not plugged in)
        // leaves other notes open: those aren't the ones to replace.
        if !same_folder(&pending.data_dir, data_dir) {
            return Err(Error("The notes folder isn't the one the backup was to be restored to".into()));
        }
        if !list(dir).iter().any(|b| b.name == pending.name) {
            return Err(Error("That backup isn't there any more".into()));
        }
        restore(&dir.join(&pending.name), data_dir, now)
    };
    Some(attempt())
}

fn restore(backup: &Path, data_dir: &Path, now: i64) -> Result<PathBuf> {
    std::fs::create_dir_all(data_dir)?;
    let incoming = data_dir.join(INCOMING);
    // The copy comes first: if the disk is full, nothing has moved yet.
    if let Err(e) = std::fs::copy(backup, &incoming) {
        let _ = std::fs::remove_file(&incoming);
        return Err(e.into());
    }
    let aside = aside_folder(data_dir, now);
    let moved = set_aside(data_dir, &aside).and_then(|()| std::fs::rename(&incoming, data_dir.join(DB)));
    if let Err(e) = moved {
        // Back to how it was: the notes in place, and no half of a restore.
        for name in LIVE {
            if aside.join(name).exists() && !data_dir.join(name).exists() {
                let _ = std::fs::rename(aside.join(name), data_dir.join(name));
            }
        }
        let _ = std::fs::remove_dir(&aside);
        let _ = std::fs::remove_file(&incoming);
        return Err(e.into());
    }
    Ok(aside)
}

/// Moves the database, with its write-ahead log (which may hold the latest
/// saves), into `aside`.
fn set_aside(data_dir: &Path, aside: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(aside)?;
    for name in LIVE {
        let from = data_dir.join(name);
        if from.exists() {
            rename_patiently(&from, &aside.join(name))?;
        }
    }
    Ok(())
}

/// A rename that waits a little for the app's last run to let go of the file:
/// a restart starts the new run a moment before the old one has gone.
fn rename_patiently(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match std::fs::rename(from, to) {
            // Windows: access denied, or in use by another process.
            Err(e) if cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33)) && tries < 20 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(250));
            }
            done => return done,
        }
    }
}

/// Whether a database a restore set aside is still in the notes folder. Its
/// files are the ones in `files`, so nothing there is tidied away meanwhile.
pub fn has_set_aside(data_dir: &Path) -> bool {
    std::fs::read_dir(data_dir).into_iter().flatten().flatten().any(|entry| {
        let dir = entry.path();
        entry.file_name().to_string_lossy().starts_with("Replaced ") && dir.join(DB).is_file() && !dir.join("files").exists()
    })
}

// ---------------------------------------------------------------- the app's

/// The backups folder, and what the interface is told about it.
pub struct Backups {
    pub dir: PathBuf,
    /// What a restore asked for before this start came to: the name of the
    /// folder the notes were set aside in, or why it wasn't done.
    restored: Option<std::result::Result<String, String>>,
    problem: Mutex<Option<Problem>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    dir: String,
    /// Newest first.
    backups: Vec<Backup>,
    problem: Option<Problem>,
    restored: Option<String>,
    restore_error: Option<String>,
}

impl Backups {
    pub fn new(dir: PathBuf, restored: Option<Result<PathBuf>>) -> Self {
        let restored = restored.map(|done| match done {
            Ok(aside) => Ok(aside.file_name().unwrap_or_default().to_string_lossy().into_owned()),
            Err(e) => Err(e.0),
        });
        let problem = Mutex::new(read_state(&dir).problem);
        Backups { dir, restored, problem }
    }

    pub fn status(&self) -> Status {
        Status {
            dir: self.dir.to_string_lossy().into_owned(),
            backups: list(&self.dir),
            problem: *self.problem.lock().unwrap_or_else(|p| p.into_inner()),
            restored: self.restored.as_ref().and_then(|r| r.as_ref().ok()).cloned(),
            restore_error: self.restored.as_ref().and_then(|r| r.as_ref().err()).cloned(),
        }
    }

    /// Notes what a run came to; gives whether damage was found for the first time.
    fn note(&self, outcome: &Outcome) -> bool {
        let now = match outcome {
            Outcome::NotDue => return false,
            Outcome::Damaged => Some(Problem::Damaged),
            Outcome::Failed(_) => Some(Problem::Failed),
            Outcome::Made(_) | Outcome::Unchanged => None,
        };
        let was = std::mem::replace(&mut *self.problem.lock().unwrap_or_else(|p| p.into_inner()), now);
        now == Some(Problem::Damaged) && was != now
    }
}

/// Looks a minute after start-up, then every hour, whether a backup is due.
pub fn start<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    use tauri::{Emitter, Manager};
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        loop {
            let backups = app.state::<Backups>();
            let outcome = run(&app.state::<crate::db::Db>().data_dir, &backups.dir, crate::db::now(), false);
            if backups.note(&outcome) {
                let _ = app.emit("td-backup-damaged", ());
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::testutil::TempDir;

    const HOUR: i64 = 3_600_000;
    /// 2026-10-24 09:30 UTC.
    const T0: i64 = 1_792_834_200_000;

    /// A notes folder and, apart from it, a backups folder.
    fn folders(name: &str) -> (TempDir, TempDir) {
        (TempDir::new(&format!("td-bk-{name}")), TempDir::new(&format!("td-bk-{name}-app")))
    }

    fn titles(file: &Path) -> Vec<String> {
        let conn = read_only(file).unwrap();
        let mut stmt = conn.prepare("SELECT title FROM pages ORDER BY title").unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    fn made(outcome: Outcome) -> Backup {
        match outcome {
            Outcome::Made(backup) => backup,
            other => panic!("no backup was made: {other:?}"),
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn makes_a_whole_copy_while_the_notes_are_open() {
        let (home, app) = folders("make");
        let dir = app.join(FOLDER);
        let db = Db::open(&home).unwrap();
        db.create_page(None, None, "Lecture 1", "").unwrap();

        let backup = made(run(&home, &dir, T0, false));
        assert_eq!(backup.name, "thoughtdesk 2026-10-24 0930.db");
        assert_eq!(backup.at, T0);
        assert_eq!(titles(&dir.join(&backup.name)), ["Getting started", "Lecture 1"]);
        // Nothing half-made, and nothing in the notes folder.
        assert_eq!(names(&dir), ["state.json", "thoughtdesk 2026-10-24 0930.db"]);
        assert!(!home.join(FOLDER).exists());
        assert_eq!(list(&dir), [backup]);
        // The notes are still open and can be written.
        db.create_page(None, None, "Lecture 2", "").unwrap();
    }

    #[test]
    fn skips_when_not_due_or_nothing_changed() {
        let (home, app) = folders("skip");
        let dir = app.join(FOLDER);
        let db = Db::open(&home).unwrap();
        made(run(&home, &dir, T0, false));

        // The same day: it doesn't even look.
        db.create_page(None, None, "Written at ten", "").unwrap();
        assert_eq!(run(&home, &dir, T0 + HOUR, false), Outcome::NotDue);
        assert_eq!(list(&dir).len(), 1);

        // The next day there's something new.
        let second = made(run(&home, &dir, T0 + 21 * HOUR, false));
        assert!(titles(&dir.join(&second.name)).contains(&"Written at ten".to_string()));

        // A day on with nothing written: no copy of the same thing, and none
        // is tried again until another day has passed.
        assert_eq!(run(&home, &dir, T0 + 42 * HOUR, false), Outcome::Unchanged);
        assert_eq!(run(&home, &dir, T0 + 43 * HOUR, false), Outcome::NotDue);
        assert_eq!(list(&dir).len(), 2);
        assert!(!dir.join(PARTIAL).exists());

        // Writing the same value again isn't a change either.
        db.sync_set_install("0123abcd-0000-4000-8000-000000000000").unwrap();
        made(run(&home, &dir, T0 + 63 * HOUR, false));
        db.sync_set_install("0123abcd-0000-4000-8000-000000000000").unwrap();
        assert_eq!(run(&home, &dir, T0 + 84 * HOUR, false), Outcome::Unchanged);

        // A clock set back doesn't stop them.
        db.create_page(None, None, "Written last week", "").unwrap();
        made(run(&home, &dir, T0 - 7 * 24 * HOUR, false));
    }

    #[test]
    fn two_in_one_minute_keep_their_order() {
        let (home, app) = folders("minute");
        let dir = app.join(FOLDER);
        let db = Db::open(&home).unwrap();
        let first = made(run(&home, &dir, T0, true));
        db.create_page(None, None, "A moment later", "").unwrap();
        let second = made(run(&home, &dir, T0 + 5_000, true));
        assert_eq!(second.name, "thoughtdesk 2026-10-24 0930 (2).db");
        assert!(second.at > first.at);
        // And only the newer of a day is kept.
        assert_eq!(list(&dir), [second]);
    }

    fn fake(day: i64, hour: i64) -> Backup {
        let at = T0 - 9 * HOUR - 30 * 60_000 + day * DAY + hour * HOUR;
        Backup { name: format!("{PREFIX}{}.db", stamp(at)), at, bytes: 1 }
    }

    #[test]
    fn keeps_seven_days_and_four_weeks() {
        // One every day for sixty days, newest first; two on the newest day.
        let mut all: Vec<Backup> = (0..60).rev().map(|day| fake(day, 9)).collect();
        all.insert(0, fake(59, 20));
        let keep = kept(&all);
        let today = all[0].at.div_euclid(DAY);
        let days_ago: Vec<i64> = all.iter().filter(|b| keep.contains(&b.name.as_str())).map(|b| today - b.at.div_euclid(DAY)).collect();
        assert_eq!(keep.len(), DAILY + WEEKLY);
        assert_eq!(keep[0], all[0].name, "the newer of two in a day");
        assert_eq!(&days_ago[..7], [0, 1, 2, 3, 4, 5, 6]);
        // Then the newest of each week before: the first is the next day
        // back, the others the last days of their weeks, a week apart.
        assert_eq!(days_ago[7], 7, "{days_ago:?}");
        assert!(days_ago[8] - days_ago[7] <= 7, "{days_ago:?}");
        assert!(days_ago[8..].windows(2).all(|w| w[1] - w[0] == 7), "{days_ago:?}");
        assert!(days_ago[10] >= 21 && days_ago[10] <= 7 + 4 * 7, "{days_ago:?}");

        // Days with none between: still seven days that have one, then four weeks.
        let weekly: Vec<Backup> = (0..20).rev().map(|n| fake(n * 7, 9)).collect();
        assert_eq!(kept(&weekly), weekly[..DAILY + WEEKLY].iter().map(|b| b.name.as_str()).collect::<Vec<_>>());
        assert!(kept(&[]).is_empty());
    }

    #[test]
    fn rotation_deletes_old_backups_and_nothing_else() {
        let (home, app) = folders("rotate");
        let dir = app.join(FOLDER);
        let db = Db::open(&home).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("thoughtdesk-before-sync.db"), b"not ours").unwrap();
        std::fs::write(dir.join("thoughtdesk notes.db"), b"not ours").unwrap();
        std::fs::write(dir.join("essay.docx"), b"not ours").unwrap();

        for day in 0..45 {
            db.create_page(None, None, &format!("Day {day}"), "").unwrap();
            made(run(&home, &dir, T0 + day * DAY, false));
        }
        let left = list(&dir);
        assert_eq!(left.len(), DAILY + WEEKLY);
        assert_eq!(left[0].at, T0 + 44 * DAY);
        assert_eq!(left[6].at, T0 + 38 * DAY, "a week of days");
        assert!(left.last().unwrap().at >= T0 + 44 * DAY - 6 * 7 * DAY, "and about a month before");
        // The newest holds every page; the oldest kept still opens.
        assert!(titles(&dir.join(&left[0].name)).contains(&"Day 44".to_string()));
        assert!(!titles(&dir.join(&left.last().unwrap().name)).is_empty());
        for stranger in ["thoughtdesk-before-sync.db", "thoughtdesk notes.db", "essay.docx"] {
            assert!(dir.join(stranger).is_file(), "{stranger}");
        }
    }

    /// Writes rubbish over the database's pages, past the first one (the file header).
    fn damage(file: &Path) {
        let mut bytes = std::fs::read(file).unwrap();
        assert!(bytes.len() > 8192);
        for b in &mut bytes[4096..] {
            *b = 0x5a;
        }
        std::fs::write(file, bytes).unwrap();
    }

    #[test]
    fn a_damaged_database_is_never_copied_over_good_backups() {
        let (home, app) = folders("damaged");
        let dir = app.join(FOLDER);
        let db = Db::open(&home).unwrap();
        db.create_page(None, None, "Before the damage", "").unwrap();
        let good = made(run(&home, &dir, T0, false));
        let good_bytes = std::fs::read(dir.join(&good.name)).unwrap();
        // Everything into the one file, which is then closed.
        db.conn().execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        drop(db);

        damage(&home.join(DB));
        assert_eq!(run(&home, &dir, T0 + 24 * HOUR, false), Outcome::Damaged);
        assert_eq!(read_state(&dir).problem, Some(Problem::Damaged));
        // It's looked at again at the next chance, not a day later.
        assert_eq!(run(&home, &dir, T0 + 25 * HOUR, false), Outcome::Damaged);

        // Not a database at all any more.
        std::fs::write(home.join(DB), vec![0x5a; 20_000]).unwrap();
        assert_eq!(run(&home, &dir, T0 + 26 * HOUR, false), Outcome::Damaged);

        // However long it stays damaged, the good backup is kept as it was.
        for day in 2..60 {
            assert_eq!(run(&home, &dir, T0 + day * DAY, false), Outcome::Damaged);
        }
        assert_eq!(list(&dir), [good.clone()]);
        assert_eq!(std::fs::read(dir.join(&good.name)).unwrap(), good_bytes);
        assert!(!dir.join(PARTIAL).exists());
        assert_eq!(titles(&dir.join(&good.name)), ["Before the damage", "Getting started"]);
    }

    #[test]
    fn a_backup_that_cant_be_written_leaves_the_notes_alone() {
        let (home, app) = folders("failed");
        let db = Db::open(&home).unwrap();
        db.create_page(None, None, "Safe", "").unwrap();

        // The backups folder can't be made: a file has its name.
        let blocked = app.join(FOLDER);
        std::fs::write(&blocked, b"in the way").unwrap();
        assert!(matches!(run(&home, &blocked, T0, false), Outcome::Failed(_)));

        // The copy can't be written: a folder has its name.
        let dir = app.join("Backups 2");
        std::fs::create_dir_all(dir.join(PARTIAL)).unwrap();
        assert!(matches!(run(&home, &dir, T0, false), Outcome::Failed(_)));
        assert_eq!(read_state(&dir).problem, Some(Problem::Failed));
        assert!(list(&dir).is_empty());

        // The notes are as they were, and still take writes.
        db.create_page(None, None, "Still safe", "").unwrap();
        assert!(db.list_pages().unwrap().iter().any(|p| p.title == "Safe"));

        // Once the way is clear it's made at the next look, not a day later.
        std::fs::remove_dir(dir.join(PARTIAL)).unwrap();
        made(run(&home, &dir, T0 + HOUR, false));
        assert_eq!(read_state(&dir).problem, None);
    }

    #[test]
    fn restoring_sets_the_current_notes_aside() {
        let (home, app) = folders("restore");
        let dir = app.join(FOLDER);
        let db = Db::open(&home).unwrap();
        db.create_page(None, None, "Old", "").unwrap();
        db.import_file(b"bytes", "note.txt", "text/plain").unwrap();
        let backup = made(run(&home, &dir, T0, false));
        db.create_page(None, None, "New", "").unwrap();

        // Asking changes nothing yet.
        request_restore(&dir, &home, &backup.name).unwrap();
        assert!(db.list_pages().unwrap().iter().any(|p| p.title == "New"));
        assert!(!has_set_aside(&home));
        drop(db);

        let aside = apply_pending(&dir, &home, T0 + HOUR).unwrap().unwrap();
        assert_eq!(aside, home.join("Replaced 2026-10-24 1030"));
        // The notes from before are whole in the folder, not written over.
        assert_eq!(titles(&aside.join(DB)), ["Getting started", "New", "Old"]);
        assert!(has_set_aside(&home));
        // The backup is in their place, and is still a backup too.
        let db = Db::open(&home).unwrap();
        let now: Vec<String> = db.list_pages().unwrap().into_iter().map(|p| p.title).collect();
        assert!(now.contains(&"Old".to_string()) && !now.contains(&"New".to_string()), "{now:?}");
        assert_eq!(list(&dir), [backup.clone()]);
        // Added files stay where they are.
        assert_eq!(std::fs::read_dir(home.join("files")).unwrap().count(), 1);
        assert!(!home.join(INCOMING).exists());
        drop(db);

        // Done once: the next start restores nothing.
        assert!(apply_pending(&dir, &home, T0 + 2 * HOUR).is_none());

        // Restoring again in the same minute sets aside beside the first.
        request_restore(&dir, &home, &backup.name).unwrap();
        let again = apply_pending(&dir, &home, T0 + HOUR).unwrap().unwrap();
        assert_eq!(again, home.join("Replaced 2026-10-24 1030 (2)"));
        assert!(aside.join(DB).is_file() && again.join(DB).is_file());
    }

    #[test]
    fn a_restore_that_cant_be_done_changes_nothing() {
        let (home, app) = folders("refuse");
        let dir = app.join(FOLDER);
        let db = Db::open(&home).unwrap();
        db.create_page(None, None, "Mine", "").unwrap();
        let backup = made(run(&home, &dir, T0, false));

        // Only a backup from the list, never a path.
        std::fs::write(app.join("elsewhere.db"), b"x").unwrap();
        for name in ["../elsewhere.db", "state.json", "thoughtdesk 2026-01-01 0000.db", ""] {
            assert!(request_restore(&dir, &home, name).is_err(), "{name}");
        }
        // One that can't be read is refused when asked for.
        let broken = "thoughtdesk 2026-10-25 0930.db";
        std::fs::write(dir.join(broken), vec![0x5a; 20_000]).unwrap();
        assert!(request_restore(&dir, &home, broken).is_err());
        assert!(!dir.join(PENDING).exists());
        std::fs::remove_file(dir.join(broken)).unwrap();
        drop(db);

        let untouched = |why: &str| {
            assert_eq!(titles(&home.join(DB)), ["Getting started", "Mine"], "{why}");
            assert!(!has_set_aside(&home) && !home.join(INCOMING).exists(), "{why}");
            assert!(!dir.join(PENDING).exists(), "{why}: it isn't tried again");
        };

        // Asked for other notes (the chosen folder wasn't there at start-up).
        let other = TempDir::new("td-bk-refuse-other");
        request_restore(&dir, &other, &backup.name).unwrap();
        assert!(apply_pending(&dir, &home, T0 + HOUR).unwrap().is_err());
        untouched("another folder");

        // The backup went missing before the restart.
        request_restore(&dir, &home, &backup.name).unwrap();
        let moved = app.join("moved.db");
        std::fs::rename(dir.join(&backup.name), &moved).unwrap();
        assert!(apply_pending(&dir, &home, T0 + HOUR).unwrap().is_err());
        untouched("no backup");
        std::fs::rename(&moved, dir.join(&backup.name)).unwrap();

        // The backup can't be put in place (a folder has the database's name
        // once it's set aside): the notes go back where they were.
        request_restore(&dir, &home, &backup.name).unwrap();
        std::fs::create_dir_all(home.join(INCOMING)).unwrap();
        assert!(apply_pending(&dir, &home, T0 + HOUR).unwrap().is_err());
        std::fs::remove_dir(home.join(INCOMING)).unwrap();
        untouched("no room");
    }

    #[test]
    fn a_restore_cut_short_is_finished_at_the_next_start() {
        let (home, app) = folders("cut");
        let dir = app.join(FOLDER);
        let db = Db::open(&home).unwrap();
        db.create_page(None, None, "Old", "").unwrap();
        let backup = made(run(&home, &dir, T0, false));
        drop(db);

        // As the power going leaves it: the notes set aside, the backup copied in but not yet named.
        let aside = aside_folder(&home, T0 + HOUR);
        set_aside(&home, &aside).unwrap();
        std::fs::copy(dir.join(&backup.name), home.join(INCOMING)).unwrap();
        assert!(apply_pending(&dir, &home, T0 + 2 * HOUR).is_none(), "nothing new was asked for");
        assert_eq!(titles(&home.join(DB)), ["Getting started", "Old"]);
        assert!(!home.join(INCOMING).exists());

        // Cut short earlier, while copying: the notes are in place, and the half copy goes.
        std::fs::write(home.join(INCOMING), b"half a copy").unwrap();
        assert!(apply_pending(&dir, &home, T0 + 3 * HOUR).is_none());
        assert_eq!(titles(&home.join(DB)), ["Getting started", "Old"]);
        assert!(!home.join(INCOMING).exists());
    }

    #[test]
    fn tells_the_interface_what_it_shows() {
        let (home, app) = folders("status");
        let dir = app.join(FOLDER);
        let db = Db::open(&home).unwrap();
        let backup = made(run(&home, &dir, T0, false));
        db.conn().execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        drop(db);
        damage(&home.join(DB));

        // A restore done at this start, and no trouble yet.
        let backups = Backups::new(dir.clone(), Some(Ok(home.join("Replaced 2026-10-24 1030"))));
        let status = serde_json::to_value(backups.status()).unwrap();
        assert_eq!(
            status,
            serde_json::json!({
                "dir": dir.to_string_lossy(),
                "backups": [{ "name": backup.name, "at": T0, "bytes": backup.bytes }],
                "problem": null,
                "restored": "Replaced 2026-10-24 1030",
                "restoreError": null,
            })
        );
        // Damage is news once, and stays in the status until a backup is made again.
        let outcome = run(&home, &dir, T0 + DAY, false);
        assert!(backups.note(&outcome), "found for the first time");
        assert!(!backups.note(&run(&home, &dir, T0 + DAY + HOUR, false)), "not news again");
        assert!(!backups.note(&Outcome::NotDue));
        assert_eq!(serde_json::to_value(backups.status()).unwrap()["problem"], "damaged");
        // The next start knows of it too, and of a restore that failed.
        let next = Backups::new(dir.clone(), Some(Err(Error("That backup isn't there any more".into()))));
        let status = serde_json::to_value(next.status()).unwrap();
        assert_eq!(status["problem"], "damaged");
        assert_eq!(status["restored"], serde_json::Value::Null);
        assert_eq!(status["restoreError"], "That backup isn't there any more");
        assert!(!next.note(&Outcome::Unchanged));
        assert_eq!(serde_json::to_value(next.status()).unwrap()["problem"], serde_json::Value::Null);
    }

    #[test]
    fn reads_the_time_from_a_backups_name() {
        for at in [0, T0, T0 + 17 * DAY + 5 * HOUR, 1_709_251_140_000] {
            assert_eq!(time_of(&format!("{PREFIX}{}.db", stamp(at))), Some(at));
        }
        assert_eq!(time_of("thoughtdesk 2026-10-24 0930 (3).db"), Some(T0 + 3));
        for other in [
            "thoughtdesk.db",
            "thoughtdesk-before-sync.db",
            "thoughtdesk 2026-10-24 0930.db-wal",
            "thoughtdesk 2026-13-24 0930.db",
            "thoughtdesk 2026-10-24 2460.db",
            "thoughtdesk 2026-10-24 093.db",
            "thoughtdesk 2026-10-24 0930 copy.db",
            "thoughtdesk +026-10-24 0930.db",
            "thoughtdesk 2026-10-24 09é0.db",
            "snapshot.partial",
        ] {
            assert_eq!(time_of(other), None, "{other}");
        }
    }
}
