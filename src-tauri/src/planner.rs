//! Courses, assignments and calendar events.
//!
//! Assignments and events can belong to a course (which gives them a colour),
//! link to a page for longer notes, and go to the trash like pages do.
//! Assignments can also carry attachments from the file library.

use crate::db::{fail, new_id, now, Db, Result};
use rusqlite::{params, OptionalExtension, ToSql, Transaction};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

/// Lets a patch tell "leave as is" (field missing) apart from "clear it"
/// (field present and null).
fn nullable<'de, T: Deserialize<'de>, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

// ------------------------------------------------------------------ validation

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn is_time(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5 && b[2] == b':' && b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit())
}

pub(crate) fn check_date(v: &Option<String>) -> Result<()> {
    match v {
        Some(d) if !is_date(d) => fail("Dates must look like 2026-10-12"),
        _ => Ok(()),
    }
}

fn check_time(v: &Option<String>) -> Result<()> {
    match v {
        Some(t) if !is_time(t) => fail("Times must look like 09:30"),
        _ => Ok(()),
    }
}

/// Colours are palette keys ("blue", "pink"…), never free-form CSS.
fn check_color(c: &str) -> Result<()> {
    if c.len() <= 16 && c.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        fail("Unknown colour")
    }
}

fn set<T: ToSql>(tx: &Transaction, table: &str, col: &str, id: &str, value: T) -> Result<()> {
    tx.execute(&format!("UPDATE {table} SET {col} = ?1 WHERE id = ?2"), params![value, id])?;
    Ok(())
}

// --------------------------------------------------------------------- courses

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Course {
    pub id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub created_at: i64,
    pub teacher: String,
    pub email: String,
    pub office_hours: String,
    pub room: String,
    /// The page that holds this course's notes (lecture notes go inside).
    pub page_id: Option<String>,
    /// Grade category → weight (percent). Empty: grades are total points.
    pub weights: BTreeMap<String, f64>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CoursePatch {
    pub name: Option<String>,
    pub color: Option<String>,
    pub teacher: Option<String>,
    pub email: Option<String>,
    pub office_hours: Option<String>,
    pub room: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub page_id: Option<Option<String>>,
    pub weights: Option<BTreeMap<String, f64>>,
}

fn course_from_row(r: &rusqlite::Row) -> rusqlite::Result<Course> {
    Ok(Course {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        position: r.get(3)?,
        created_at: r.get(4)?,
        teacher: r.get(5)?,
        email: r.get(6)?,
        office_hours: r.get(7)?,
        room: r.get(8)?,
        page_id: r.get(9)?,
        weights: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
    })
}

const COURSE_COLS: &str = "id, name, color, position, created_at, teacher, email, office_hours, room, page_id, weights";

/// Grade weights: up to 20 named categories, each 0–100%.
fn check_weights(weights: &BTreeMap<String, f64>) -> Result<()> {
    if weights.len() > 20 {
        return fail("Too many grade categories");
    }
    for (name, w) in weights {
        if name.trim().is_empty() || name.chars().count() > 40 {
            return fail("Grade categories need a short name");
        }
        if !w.is_finite() || !(0.0..=100.0).contains(w) {
            return fail("Weights are percentages from 0 to 100");
        }
    }
    Ok(())
}

/// Points: finite, not negative, and not absurd.
fn check_points(v: &Option<f64>) -> Result<()> {
    match v {
        Some(p) if !p.is_finite() || *p < 0.0 || *p > 1e6 => fail("Scores are numbers of points"),
        _ => Ok(()),
    }
}

// ----------------------------------------------------------------- assignments

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub id: String,
    pub title: String,
    pub course_id: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    /// "todo", "doing" or "done".
    pub status: String,
    /// 0 none, 1 low, 2 medium, 3 high.
    pub priority: i64,
    pub notes: String,
    pub page_id: Option<String>,
    /// Attached library files, in order.
    pub file_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub tags: Vec<String>,
    /// UID of the calendar entry this was imported from.
    pub source_uid: Option<String>,
    /// Points earned and possible, once graded.
    pub score: Option<f64>,
    pub max_score: Option<f64>,
    /// Grade category ("Homework", "Exams"); weighted by the course.
    pub category: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AssignmentPatch {
    pub source_uid: Option<String>,
    pub title: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub course_id: Option<Option<String>>,
    #[serde(deserialize_with = "nullable")]
    pub due_date: Option<Option<String>>,
    #[serde(deserialize_with = "nullable")]
    pub due_time: Option<Option<String>>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub notes: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub page_id: Option<Option<String>>,
    pub file_ids: Option<Vec<String>>,
    #[serde(deserialize_with = "nullable")]
    pub score: Option<Option<f64>>,
    #[serde(deserialize_with = "nullable")]
    pub max_score: Option<Option<f64>>,
    pub category: Option<String>,
}

const ASSIGNMENT_COLS: &str = "id, title, course_id, due_date, due_time, status, priority, notes, page_id,
     created_at, updated_at, completed_at, deleted_at, tags, source_uid, score, max_score, category";

fn assignment_from_row(r: &rusqlite::Row) -> rusqlite::Result<Assignment> {
    Ok(Assignment {
        id: r.get(0)?,
        title: r.get(1)?,
        course_id: r.get(2)?,
        due_date: r.get(3)?,
        due_time: r.get(4)?,
        status: r.get(5)?,
        priority: r.get(6)?,
        notes: r.get(7)?,
        page_id: r.get(8)?,
        file_ids: Vec::new(),
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
        completed_at: r.get(11)?,
        deleted_at: r.get(12)?,
        tags: crate::organize::parse_tags(&r.get::<_, String>(13)?),
        source_uid: r.get(14)?,
        score: r.get(15)?,
        max_score: r.get(16)?,
        category: r.get(17)?,
    })
}

fn attachments_of(tx: &rusqlite::Connection, id: &str) -> Result<Vec<String>> {
    let mut stmt = tx.prepare("SELECT file_id FROM attachments WHERE assignment_id = ?1 ORDER BY position")?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn assignment_by_id(tx: &rusqlite::Connection, id: &str) -> Result<Assignment> {
    let found = tx
        .query_row(&format!("SELECT {ASSIGNMENT_COLS} FROM assignments WHERE id = ?1"), [id], assignment_from_row)
        .optional()?;
    let Some(mut a) = found else {
        return fail("Assignment not found");
    };
    a.file_ids = attachments_of(tx, id)?;
    Ok(a)
}

fn apply_assignment(tx: &Transaction, id: &str, patch: &AssignmentPatch) -> Result<()> {
    const T: &str = "assignments";
    if let Some(v) = &patch.title {
        set(tx, T, "title", id, v)?;
    }
    if let Some(v) = &patch.course_id {
        set(tx, T, "course_id", id, v)?;
    }
    if let Some(v) = &patch.due_time {
        check_time(v)?;
        set(tx, T, "due_time", id, v)?;
    }
    if let Some(v) = &patch.due_date {
        check_date(v)?;
        set(tx, T, "due_date", id, v)?;
    }
    // A time without a date means nothing.
    tx.execute("UPDATE assignments SET due_time = NULL WHERE id = ?1 AND due_date IS NULL", [id])?;
    if let Some(v) = &patch.status {
        if !matches!(v.as_str(), "todo" | "doing" | "done") {
            return fail("Unknown status");
        }
        set(tx, T, "status", id, v)?;
        // Remember when it was finished; reopening clears it.
        tx.execute(
            "UPDATE assignments SET completed_at = CASE
               WHEN ?1 = 'done' THEN coalesce(completed_at, ?2) ELSE NULL END
             WHERE id = ?3",
            params![v, now(), id],
        )?;
    }
    if let Some(v) = patch.priority {
        set(tx, T, "priority", id, v.clamp(0, 3))?;
    }
    if let Some(v) = &patch.notes {
        set(tx, T, "notes", id, v)?;
    }
    if let Some(v) = &patch.page_id {
        set(tx, T, "page_id", id, v)?;
    }
    if let Some(v) = &patch.source_uid {
        set(tx, T, "source_uid", id, v)?;
    }
    if let Some(v) = &patch.score {
        check_points(v)?;
        set(tx, T, "score", id, v)?;
    }
    if let Some(v) = &patch.max_score {
        check_points(v)?;
        set(tx, T, "max_score", id, v)?;
    }
    if let Some(v) = &patch.category {
        set(tx, T, "category", id, v.trim())?;
    }
    if let Some(files) = &patch.file_ids {
        tx.execute("DELETE FROM attachments WHERE assignment_id = ?1", [id])?;
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO attachments (assignment_id, file_id, position)
             SELECT ?1, id, ?3 FROM files WHERE id = ?2",
        )?;
        for (i, fid) in files.iter().enumerate() {
            stmt.execute(params![id, fid, i as i64])?;
        }
    }
    set(tx, T, "updated_at", id, now())
}

// ---------------------------------------------------------------------- events

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub title: String,
    pub start_date: String,
    /// None for all-day events.
    pub start_time: Option<String>,
    pub end_date: String,
    pub end_time: Option<String>,
    /// Palette key; empty means "use the course colour".
    pub color: String,
    pub course_id: Option<String>,
    pub location: String,
    pub notes: String,
    /// "none", "daily", "weekly" or "monthly".
    pub repeat: String,
    pub repeat_until: Option<String>,
    pub page_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub tags: Vec<String>,
    /// Dates ("YYYY-MM-DD") a repeating event skips.
    pub exdates: Vec<String>,
    /// UID of the calendar entry this was imported from.
    pub source_uid: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EventPatch {
    pub exdates: Option<Vec<String>>,
    pub source_uid: Option<String>,
    pub title: Option<String>,
    pub start_date: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub start_time: Option<Option<String>>,
    pub end_date: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub end_time: Option<Option<String>>,
    pub color: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub course_id: Option<Option<String>>,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub repeat: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub repeat_until: Option<Option<String>>,
    #[serde(deserialize_with = "nullable")]
    pub page_id: Option<Option<String>>,
}

const EVENT_COLS: &str = "id, title, start_date, start_time, end_date, end_time, color, course_id, location, notes,
     repeat, repeat_until, page_id, created_at, updated_at, deleted_at, tags, exdates, source_uid";

fn event_from_row(r: &rusqlite::Row) -> rusqlite::Result<Event> {
    Ok(Event {
        id: r.get(0)?,
        title: r.get(1)?,
        start_date: r.get(2)?,
        start_time: r.get(3)?,
        end_date: r.get(4)?,
        end_time: r.get(5)?,
        color: r.get(6)?,
        course_id: r.get(7)?,
        location: r.get(8)?,
        notes: r.get(9)?,
        repeat: r.get(10)?,
        repeat_until: r.get(11)?,
        page_id: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
        deleted_at: r.get(15)?,
        tags: crate::organize::parse_tags(&r.get::<_, String>(16)?),
        exdates: crate::organize::parse_tags(&r.get::<_, String>(17)?),
        source_uid: r.get(18)?,
    })
}

fn event_by_id(tx: &rusqlite::Connection, id: &str) -> Result<Event> {
    match tx
        .query_row(&format!("SELECT {EVENT_COLS} FROM events WHERE id = ?1"), [id], event_from_row)
        .optional()?
    {
        Some(e) => Ok(e),
        None => fail("Event not found"),
    }
}

fn apply_event(tx: &Transaction, id: &str, patch: &EventPatch) -> Result<()> {
    const T: &str = "events";
    if let Some(v) = &patch.title {
        set(tx, T, "title", id, v)?;
    }
    if let Some(v) = &patch.start_date {
        check_date(&Some(v.clone()))?;
        set(tx, T, "start_date", id, v)?;
    }
    if let Some(v) = &patch.start_time {
        check_time(v)?;
        set(tx, T, "start_time", id, v)?;
    }
    if let Some(v) = &patch.end_date {
        check_date(&Some(v.clone()))?;
        set(tx, T, "end_date", id, v)?;
    }
    if let Some(v) = &patch.end_time {
        check_time(v)?;
        set(tx, T, "end_time", id, v)?;
    }
    if let Some(v) = &patch.color {
        if !v.is_empty() {
            check_color(v)?;
        }
        set(tx, T, "color", id, v)?;
    }
    if let Some(v) = &patch.course_id {
        set(tx, T, "course_id", id, v)?;
    }
    if let Some(v) = &patch.location {
        set(tx, T, "location", id, v)?;
    }
    if let Some(v) = &patch.notes {
        set(tx, T, "notes", id, v)?;
    }
    if let Some(v) = &patch.repeat {
        if !matches!(v.as_str(), "none" | "daily" | "weekly" | "monthly") {
            return fail("Unknown repeat rule");
        }
        set(tx, T, "repeat", id, v)?;
    }
    if let Some(v) = &patch.repeat_until {
        check_date(v)?;
        set(tx, T, "repeat_until", id, v)?;
    }
    if let Some(v) = &patch.page_id {
        set(tx, T, "page_id", id, v)?;
    }
    if let Some(dates) = &patch.exdates {
        for d in dates {
            check_date(&Some(d.clone()))?;
        }
        let mut dates = dates.clone();
        dates.sort();
        dates.dedup();
        set(tx, T, "exdates", id, serde_json::to_string(&dates)?)?;
    }
    if let Some(v) = &patch.source_uid {
        set(tx, T, "source_uid", id, v)?;
    }
    // An event never ends before it starts; all-day events have no times.
    tx.execute(
        "UPDATE events SET end_date = start_date WHERE id = ?1 AND end_date < start_date",
        [id],
    )?;
    tx.execute(
        "UPDATE events SET end_time = NULL WHERE id = ?1 AND start_time IS NULL",
        [id],
    )?;
    tx.execute(
        "UPDATE events SET end_time = start_time
         WHERE id = ?1 AND start_time IS NOT NULL
           AND (end_time IS NULL OR (end_date = start_date AND end_time < start_time))",
        [id],
    )?;
    set(tx, T, "updated_at", id, now())
}

// ------------------------------------------------------------------------- Db

impl Db {
    pub fn list_courses(&self) -> Result<Vec<Course>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT {COURSE_COLS} FROM courses ORDER BY position, created_at"))?;
        let rows = stmt.query_map([], course_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn create_course(&self, name: &str, color: &str) -> Result<Course> {
        check_color(color)?;
        let conn = self.conn();
        let id = new_id();
        conn.execute(
            "INSERT INTO courses (id, name, color, position, created_at)
             VALUES (?1, ?2, ?3, (SELECT coalesce(max(position), -1) + 1 FROM courses), ?4)",
            params![id, name.trim(), color, now()],
        )?;
        Ok(conn.query_row(&format!("SELECT {COURSE_COLS} FROM courses WHERE id = ?1"), [&id], course_from_row)?)
    }

    /// Puts the courses in this order (the first is position 0), as dragged in
    /// the sidebar. It's given every course; ids it doesn't know are skipped.
    pub fn reorder_courses(&self, ids: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            set(&tx, "courses", "position", id, i as i64)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn update_course(&self, id: &str, patch: CoursePatch) -> Result<Course> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if let Some(name) = &patch.name {
            set(&tx, "courses", "name", id, name.trim())?;
        }
        if let Some(color) = &patch.color {
            check_color(color)?;
            set(&tx, "courses", "color", id, color)?;
        }
        for (col, value) in [
            ("teacher", &patch.teacher),
            ("email", &patch.email),
            ("office_hours", &patch.office_hours),
            ("room", &patch.room),
        ] {
            if let Some(v) = value {
                set(&tx, "courses", col, id, v.trim())?;
            }
        }
        if let Some(v) = &patch.page_id {
            set(&tx, "courses", "page_id", id, v)?;
        }
        if let Some(w) = &patch.weights {
            check_weights(w)?;
            let clean: BTreeMap<String, f64> = w.iter().map(|(k, v)| (k.trim().to_string(), *v)).collect();
            set(&tx, "courses", "weights", id, serde_json::to_string(&clean)?)?;
        }
        let course = tx
            .query_row(&format!("SELECT {COURSE_COLS} FROM courses WHERE id = ?1"), [id], course_from_row)
            .optional()?;
        tx.commit()?;
        match course {
            Some(c) => Ok(c),
            None => fail("Course not found"),
        }
    }

    /// Deletes a course; its assignments and events simply lose the course.
    pub fn delete_course(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM courses WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn list_assignments(&self) -> Result<Vec<Assignment>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT {ASSIGNMENT_COLS} FROM assignments ORDER BY created_at"))?;
        let mut list: Vec<Assignment> = stmt
            .query_map([], assignment_from_row)?
            .collect::<rusqlite::Result<_>>()?;
        let mut att = conn.prepare("SELECT assignment_id, file_id FROM attachments ORDER BY position")?;
        let pairs = att.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut by_id: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for (aid, fid) in pairs.flatten() {
            by_id.entry(aid).or_default().push(fid);
        }
        for a in &mut list {
            if let Some(files) = by_id.remove(&a.id) {
                a.file_ids = files;
            }
        }
        Ok(list)
    }

    pub fn create_assignment(&self, input: AssignmentPatch) -> Result<Assignment> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let id = new_id();
        let ts = now();
        tx.execute(
            "INSERT INTO assignments (id, created_at, updated_at) VALUES (?1, ?2, ?2)",
            params![id, ts],
        )?;
        apply_assignment(&tx, &id, &input)?;
        let a = assignment_by_id(&tx, &id)?;
        tx.commit()?;
        Ok(a)
    }

    pub fn update_assignment(&self, id: &str, patch: AssignmentPatch) -> Result<Assignment> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        assignment_by_id(&tx, id)?;
        apply_assignment(&tx, id, &patch)?;
        let a = assignment_by_id(&tx, id)?;
        tx.commit()?;
        Ok(a)
    }

    pub fn list_events(&self) -> Result<Vec<Event>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT {EVENT_COLS} FROM events ORDER BY start_date, start_time"))?;
        let rows = stmt.query_map([], event_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn create_event(&self, input: EventPatch) -> Result<Event> {
        let Some(start) = input.start_date.clone() else {
            return fail("An event needs a date");
        };
        check_date(&Some(start.clone()))?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let id = new_id();
        let ts = now();
        tx.execute(
            "INSERT INTO events (id, start_date, end_date, created_at, updated_at) VALUES (?1, ?2, ?2, ?3, ?3)",
            params![id, start, ts],
        )?;
        apply_event(&tx, &id, &input)?;
        let e = event_by_id(&tx, &id)?;
        tx.commit()?;
        Ok(e)
    }

    pub fn update_event(&self, id: &str, patch: EventPatch) -> Result<Event> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        event_by_id(&tx, id)?;
        apply_event(&tx, id, &patch)?;
        let e = event_by_id(&tx, id)?;
        tx.commit()?;
        Ok(e)
    }
}

/// The notes page for one session of an event ("Biology lecture, Oct 14").
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OccurrencePage {
    pub event_id: String,
    pub date: String,
    pub page_id: String,
}

impl Db {
    pub fn list_occurrence_pages(&self) -> Result<Vec<OccurrencePage>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT event_id, date, page_id FROM occurrence_pages")?;
        let rows = stmt.query_map([], |r| Ok(OccurrencePage { event_id: r.get(0)?, date: r.get(1)?, page_id: r.get(2)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn set_occurrence_page(&self, event_id: &str, date: &str, page_id: &str) -> Result<()> {
        check_date(&Some(date.to_string()))?;
        self.conn().execute(
            "INSERT INTO occurrence_pages (event_id, date, page_id) VALUES (?1, ?2, ?3)
             ON CONFLICT(event_id, date) DO UPDATE SET page_id = excluded.page_id",
            params![event_id, date, page_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Table;
    use std::path::PathBuf;

    fn temp_db() -> (Db, PathBuf) {
        let dir = std::env::temp_dir().join(format!("td-test-{}", uuid::Uuid::new_v4().simple()));
        (Db::open(&dir).expect("open db"), dir)
    }

    fn patch(json: &str) -> AssignmentPatch {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn assignment_lifecycle() {
        let (db, _) = temp_db();
        let course = db.create_course("Biology", "green").unwrap();
        let a = db
            .create_assignment(patch(&format!(
                r#"{{"title":"Lab report","courseId":"{}","dueDate":"2026-10-20","dueTime":"23:59","priority":5}}"#,
                course.id
            )))
            .unwrap();
        assert_eq!(a.title, "Lab report");
        assert_eq!(a.course_id.as_deref(), Some(course.id.as_str()));
        assert_eq!(a.priority, 3, "priority is clamped");
        assert_eq!(a.status, "todo");

        // Finishing stamps completed_at; reopening clears it.
        let done = db.update_assignment(&a.id, patch(r#"{"status":"done"}"#)).unwrap();
        assert!(done.completed_at.is_some());
        let open = db.update_assignment(&a.id, patch(r#"{"status":"doing"}"#)).unwrap();
        assert!(open.completed_at.is_none());

        // A missing field is left alone; null clears it (and the time with the date).
        let same = db.update_assignment(&a.id, patch(r#"{"notes":"Use figure 2"}"#)).unwrap();
        assert_eq!(same.due_date.as_deref(), Some("2026-10-20"));
        let cleared = db.update_assignment(&a.id, patch(r#"{"dueDate":null}"#)).unwrap();
        assert_eq!(cleared.due_date, None);
        assert_eq!(cleared.due_time, None);

        assert!(db.update_assignment(&a.id, patch(r#"{"status":"later"}"#)).is_err());
        assert!(db.update_assignment(&a.id, patch(r#"{"dueDate":"tomorrow"}"#)).is_err());

        // Deleting the course keeps the assignment.
        db.delete_course(&course.id).unwrap();
        let list = db.list_assignments().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].course_id, None);
    }

    #[test]
    fn attachments_follow_the_library() {
        let (db, _) = temp_db();
        let f1 = db.import_file(b"one", "notes.txt", "text/plain").unwrap();
        let f2 = db.import_file(b"two", "data.csv", "").unwrap();
        let a = db
            .create_assignment(patch(&format!(r#"{{"title":"Essay","fileIds":["{}","{}","nope"]}}"#, f2.id, f1.id)))
            .unwrap();
        assert_eq!(a.file_ids, vec![f2.id.clone(), f1.id.clone()], "unknown ids are dropped, order kept");

        db.delete_item(Table::Files, &f2.id).unwrap();
        let list = db.list_assignments().unwrap();
        assert_eq!(list[0].file_ids, vec![f1.id.clone()]);
    }

    #[test]
    fn events_normalize_their_range() {
        let (db, _) = temp_db();
        let input: EventPatch = serde_json::from_str(
            r#"{"title":"Lecture","startDate":"2026-10-12","startTime":"10:00","endDate":"2026-10-11","endTime":"09:00","repeat":"weekly"}"#,
        )
        .unwrap();
        let e = db.create_event(input).unwrap();
        assert_eq!(e.end_date, "2026-10-12", "end can't precede start");
        assert_eq!(e.end_time.as_deref(), Some("10:00"));
        assert_eq!(e.repeat, "weekly");

        // Turning it into an all-day event drops both times.
        let all_day = db
            .update_event(&e.id, serde_json::from_str(r#"{"startTime":null}"#).unwrap())
            .unwrap();
        assert_eq!(all_day.start_time, None);
        assert_eq!(all_day.end_time, None);

        assert!(db.create_event(EventPatch::default()).is_err(), "a date is required");
        assert!(db
            .update_event(&e.id, serde_json::from_str(r#"{"color":"url(x)"}"#).unwrap())
            .is_err());
    }

    #[test]
    fn unified_trash() {
        let (db, _) = temp_db();
        let a = db.create_assignment(patch(r#"{"title":"Quiz"}"#)).unwrap();
        let e = db
            .create_event(serde_json::from_str(r#"{"title":"Exam","startDate":"2026-11-02"}"#).unwrap())
            .unwrap();
        let f = db.import_file(b"bytes", "scan.pdf", "application/pdf").unwrap();
        let disk = db.files_dir.join(&f.stored);
        assert!(disk.exists());

        db.trash_item(Table::Assignments, &a.id).unwrap();
        db.trash_item(Table::Events, &e.id).unwrap();
        db.trash_item(Table::Files, &f.id).unwrap();
        assert_eq!(db.live_count(Table::Assignments).unwrap(), 0);
        assert!(disk.exists(), "trashed files stay on disk");

        db.restore_item(Table::Events, &e.id).unwrap();
        assert_eq!(db.live_count(Table::Events).unwrap(), 1);

        db.empty_trash().unwrap();
        assert!(db.list_assignments().unwrap().is_empty());
        assert_eq!(db.list_events().unwrap().len(), 1);
        assert!(db.list_files().unwrap().is_empty());
        assert!(!disk.exists(), "emptying the trash removes the file");
    }

    #[test]
    fn grades_and_weights() {
        let (db, _) = temp_db();
        let c = db.create_course("Physics", "teal").unwrap();
        let c = db
            .update_course(&c.id, serde_json::from_str(r#"{"weights":{" Exams ":60,"Homework":40}}"#).unwrap())
            .unwrap();
        assert_eq!(c.weights.get("Exams"), Some(&60.0), "names trimmed");
        assert!(db.update_course(&c.id, serde_json::from_str(r#"{"weights":{"Labs":140}}"#).unwrap()).is_err());
        assert!(db.update_course(&c.id, serde_json::from_str(r#"{"weights":{"":10}}"#).unwrap()).is_err());

        let a = db
            .create_assignment(serde_json::from_str(r#"{"title":"Lab 1","score":18.5,"maxScore":20,"category":" Homework "}"#).unwrap())
            .unwrap();
        assert_eq!((a.score, a.max_score, a.category.as_str()), (Some(18.5), Some(20.0), "Homework"));
        let a = db.update_assignment(&a.id, serde_json::from_str(r#"{"score":null}"#).unwrap()).unwrap();
        assert_eq!((a.score, a.max_score), (None, Some(20.0)), "null clears only the score");
        assert!(db.update_assignment(&a.id, serde_json::from_str(r#"{"score":-1}"#).unwrap()).is_err());
    }

    #[test]
    fn course_details_exdates_and_session_notes() {
        let (db, _) = temp_db();
        let c = db.create_course("Chemistry", "blue").unwrap();
        let c = db
            .update_course(&c.id, serde_json::from_str(r#"{"teacher":" Dr. Lee ","email":"lee@uni.edu","room":"B12"}"#).unwrap())
            .unwrap();
        assert_eq!((c.teacher.as_str(), c.room.as_str()), ("Dr. Lee", "B12"));

        let e = db
            .create_event(serde_json::from_str(r#"{"title":"Lab","startDate":"2026-10-05","startTime":"14:00","repeat":"weekly","sourceUid":"abc@school"}"#).unwrap())
            .unwrap();
        assert_eq!(e.source_uid.as_deref(), Some("abc@school"));
        let e = db
            .update_event(&e.id, serde_json::from_str(r#"{"exdates":["2026-10-19","2026-10-12","2026-10-19"]}"#).unwrap())
            .unwrap();
        assert_eq!(e.exdates, vec!["2026-10-12", "2026-10-19"], "sorted and de-duplicated");
        assert!(db.update_event(&e.id, serde_json::from_str(r#"{"exdates":["soon"]}"#).unwrap()).is_err());

        let page = db.create_page(None, None, "Lab — Oct 5", "").unwrap();
        db.set_occurrence_page(&e.id, "2026-10-05", &page.id).unwrap();
        let list = db.list_occurrence_pages().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].page_id, page.id);
        db.delete_page(&page.id).unwrap();
        assert!(db.list_occurrence_pages().unwrap().is_empty(), "goes away with the page");
    }

    #[test]
    fn courses_keep_the_order_they_are_put_in() {
        let (db, _dir) = temp_db();
        let names = |db: &Db| db.list_courses().unwrap().into_iter().map(|c| c.name).collect::<Vec<_>>();
        let a = db.create_course("Biology", "green").unwrap();
        let b = db.create_course("History", "orange").unwrap();
        let c = db.create_course("Physics", "blue").unwrap();
        assert_eq!(names(&db), ["Biology", "History", "Physics"], "in the order they were added");

        db.reorder_courses(&[c.id.clone(), a.id.clone(), b.id.clone()]).unwrap();
        assert_eq!(names(&db), ["Physics", "Biology", "History"]);
        let d = db.create_course("Spanish", "pink").unwrap();
        assert_eq!(names(&db), ["Physics", "Biology", "History", "Spanish"], "a new one goes last");

        db.reorder_courses(&[d.id.clone(), "gone".into(), c.id.clone(), a.id.clone(), b.id.clone()]).unwrap();
        assert_eq!(names(&db)[0], "Spanish", "an unknown id is skipped");
    }
}
