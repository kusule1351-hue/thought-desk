//! Records: noticing what changed, stamping it, and merging what other copies
//! changed. docs/sync.md explains the design; this is its implementation.
//!
//! The order of a sync is always: reconcile (give local changes their stamps),
//! merge what came in, then repair whatever only the merged whole can show (a
//! parent gone, a cycle, a live page under a trashed one). Repairs are ordinary
//! local writes: the triggers note them and reconciling stamps them, so every
//! copy making the same repair ends up with the same value.

use super::{make, observe, order, parse, tick, device};
use crate::db::{insert_page_as, is_database, write_positions, Db, Error, Result};
use rusqlite::{params, types::Value as Sql, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

/// How one table syncs.
pub(crate) struct Spec {
    pub entity: &'static str,
    pub table: &'static str,
    /// The key columns; two make an id of the form `a/b`.
    pub key: &'static [&'static str],
    pub fields: &'static [&'static str],
    /// References that become NULL when their target is missing: (column, table).
    pub refs: &'static [(&'static str, &'static str)],
    /// What this record can't exist without: (column, table).
    pub needs: &'static [(&'static str, &'static str)],
    /// Has an `order` field among siblings.
    pub ordered: bool,
    /// Has `deleted_at`, so it can land in the Trash.
    pub trashable: bool,
    /// SQL for when a record last changed, to stamp what already exists.
    pub touched: &'static str,
}

/// In the order records are sent and applied: what's referred to comes first.
pub(crate) const SPECS: &[Spec] = &[
    Spec {
        entity: "page",
        table: "pages",
        key: &["id"],
        fields: &["parent_id", "title", "icon", "favorite", "full_width", "tags", "kind", "created_at", "updated_at", "deleted_at"],
        refs: &[("parent_id", "pages")],
        needs: &[],
        ordered: true,
        trashable: true,
        touched: "max(updated_at, created_at, coalesce(deleted_at, 0))",
    },
    Spec {
        entity: "course",
        table: "courses",
        key: &["id"],
        fields: &["name", "color", "teacher", "email", "office_hours", "room", "page_id", "weights", "created_at"],
        refs: &[("page_id", "pages")],
        needs: &[],
        ordered: true,
        trashable: false,
        touched: "created_at",
    },
    Spec {
        entity: "file",
        table: "files",
        key: &["id"],
        fields: &["name", "stored", "mime", "size", "tags", "created_at", "updated_at", "deleted_at"],
        refs: &[],
        needs: &[],
        ordered: false,
        trashable: true,
        touched: "max(updated_at, created_at, coalesce(deleted_at, 0))",
    },
    Spec {
        entity: "tag",
        table: "tags",
        key: &["name"],
        fields: &["color", "created_at"],
        refs: &[],
        needs: &[],
        ordered: false,
        trashable: false,
        touched: "created_at",
    },
    Spec {
        entity: "assignment",
        table: "assignments",
        key: &["id"],
        fields: &[
            "title", "course_id", "due_date", "due_time", "status", "priority", "notes", "page_id", "tags", "source_uid", "score",
            "max_score", "category", "created_at", "updated_at", "completed_at", "deleted_at",
        ],
        refs: &[("course_id", "courses"), ("page_id", "pages")],
        needs: &[],
        ordered: false,
        trashable: true,
        touched: "max(updated_at, created_at, coalesce(deleted_at, 0))",
    },
    Spec {
        entity: "event",
        table: "events",
        key: &["id"],
        fields: &[
            "title", "start_date", "start_time", "end_date", "end_time", "color", "course_id", "location", "notes", "repeat",
            "repeat_until", "page_id", "tags", "exdates", "source_uid", "created_at", "updated_at", "deleted_at",
        ],
        refs: &[("course_id", "courses"), ("page_id", "pages")],
        needs: &[],
        ordered: false,
        trashable: true,
        touched: "max(updated_at, created_at, coalesce(deleted_at, 0))",
    },
    Spec {
        entity: "attachment",
        table: "attachments",
        key: &["assignment_id", "file_id"],
        fields: &["position"],
        refs: &[],
        needs: &[("assignment_id", "assignments"), ("file_id", "files")],
        ordered: false,
        trashable: false,
        touched: "1",
    },
    Spec {
        entity: "occurrence",
        table: "occurrence_pages",
        key: &["event_id", "date"],
        fields: &["page_id"],
        refs: &[],
        needs: &[("event_id", "events"), ("page_id", "pages")],
        ordered: false,
        trashable: false,
        touched: "1",
    },
    Spec {
        entity: "review",
        table: "card_reviews",
        key: &["page_id", "card_id"],
        fields: &["due", "interval", "ease", "reps", "lapses", "reviewed_at"],
        refs: &[],
        needs: &[("page_id", "pages")],
        ordered: false,
        trashable: false,
        touched: "reviewed_at",
    },
    Spec {
        entity: "property",
        table: "db_properties",
        key: &["db_id", "id"],
        fields: &["name", "type", "config", "sort_key", "deleted"],
        refs: &[],
        needs: &[("db_id", "pages")],
        ordered: false,
        trashable: false,
        touched: "1",
    },
    Spec {
        entity: "view",
        table: "db_views",
        key: &["db_id", "id"],
        fields: &["name", "type", "config", "sort_key", "deleted"],
        refs: &[],
        needs: &[("db_id", "pages")],
        ordered: false,
        trashable: false,
        touched: "1",
    },
    Spec {
        entity: "automation",
        table: "db_automations",
        key: &["db_id", "id"],
        fields: &["name", "type", "config", "sort_key", "deleted"],
        refs: &[],
        needs: &[("db_id", "pages")],
        ordered: false,
        trashable: false,
        touched: "1",
    },
];

fn spec_of(entity: &str) -> Option<(usize, &'static Spec)> {
    SPECS.iter().enumerate().find(|(_, s)| s.entity == entity)
}

/// The most the mailbox takes in one push.
const MAX_ITEMS: usize = 1000;

/// What a database or row adds to its page's record (besides `c.<property>`).
const PAGE_PARTS: &[&str] = &["db.description", "db.next_number", "row.sort_key", "row.number", "row.template"];
const CELL: &str = "c.";
const ORDER: &str = "order";
const NEXT_NUMBER: &str = "db.next_number";

fn accepts(spec: &Spec, field: &str) -> bool {
    spec.fields.contains(&field) || (spec.entity == "page" && (field.starts_with(CELL) || PAGE_PARTS.contains(&field)))
}

// ------------------------------------------------------- what a record may hold

/// Text in any one field, cell or unknown field, at most.
const MAX_TEXT: usize = 1 << 20;
/// A file's size at most (its bytes are chunked by it).
const MAX_FILE: i64 = 4 << 30;
/// Fields a newer version added that this one keeps without knowing them, at most.
const MAX_EXTRA: usize = 64;

/// The one shape a stamp has. Anything else sorts wrongly for good: a
/// malformed one above every real stamp, a 14-digit time below them.
pub(crate) fn valid_stamp(stamp: &str) -> bool {
    let b = stamp.as_bytes();
    (19..=27).contains(&b.len())
        && b[13] == b'-'
        && b[18] == b'-'
        && b[..13].iter().all(u8::is_ascii_digit)
        && b[14..18].iter().all(u8::is_ascii_digit)
        && b[19..].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

#[derive(Clone, Copy)]
struct Column {
    /// `i`nteger, `r`eal or `t`ext, as declared.
    kind: u8,
    required: bool,
}

/// Each column's declared type and whether it may be NULL, read once.
fn columns(conn: &Connection, table: &str) -> Result<Arc<HashMap<String, Column>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<HashMap<String, Column>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(found) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(table) {
        return Ok(found.clone());
    }
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |r| {
        let kind = match r.get::<_, String>(2)?.to_ascii_uppercase().as_str() {
            "INTEGER" => b'i',
            "REAL" => b'r',
            _ => b't',
        };
        Ok((r.get::<_, String>(1)?, Column { kind, required: r.get::<_, i64>(3)? != 0 }))
    })?;
    let found = Arc::new(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?);
    cache.lock().unwrap_or_else(|p| p.into_inner()).insert(table.to_string(), found.clone());
    Ok(found)
}

/// The table and column a field is written to (None for one this version doesn't know).
fn column_of(spec: &Spec, field: &str) -> Option<(&'static str, &'static str)> {
    if let Some(column) = spec.fields.iter().find(|f| **f == field) {
        return Some((spec.table, column));
    }
    if spec.entity != "page" {
        return None;
    }
    match field {
        "db.description" => Some(("databases", "description")),
        "db.next_number" => Some(("databases", "next_number")),
        "row.sort_key" => Some(("db_rows", "sort_key")),
        "row.number" => Some(("db_rows", "number")),
        "row.template" => Some(("db_rows", "template")),
        _ => None,
    }
}

/// Whether a value can go in a column: its JSON type against the declared one,
/// NULL only where it may be, and the few columns with a shape of their own.
fn value_fits(conn: &Connection, table: &str, column: &str, field: &str, value: &Value) -> Result<bool> {
    let Some(col) = columns(conn, table)?.get(column).copied() else {
        return Ok(false);
    };
    let typed = match value {
        // A row's key is NULL when the page is no longer a row.
        Value::Null => !col.required || field == "row.sort_key",
        Value::Bool(_) => col.kind == b'i',
        Value::Number(n) => match col.kind {
            b'i' => n.as_i64().is_some(),
            b'r' => true,
            _ => false,
        },
        Value::String(s) => col.kind == b't' && s.len() <= MAX_TEXT,
        _ => false,
    };
    Ok(typed
        && match (table, column, value) {
            (_, "sort_key", Value::String(s)) => (1..=255).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric()),
            ("files", "size", v) => v.as_i64().is_some_and(|n| (0..=MAX_FILE).contains(&n)),
            ("files", "stored", Value::String(s)) => super::files::valid_stored(s),
            ("pages", "kind", Value::String(s)) => s.len() <= 64,
            _ => true,
        })
}

/// Whether a record from elsewhere is one this computer can write as it is.
/// One that isn't is passed over (and kept, see `quarantine`), never half-written.
fn check_record(conn: &Connection, spec: &Spec, rec: &Record) -> Result<()> {
    let bad = |what: &str| Err(Error(format!("A {} record with {what}", spec.entity)));
    if rec.id.is_empty() || rec.id.len() > 512 {
        return bad("an id it can't have");
    }
    key_parts(spec, &rec.id)?;
    if rec.gone.as_deref().is_some_and(|g| !valid_stamp(g)) || rec.by.as_deref().is_some_and(|b| b.len() > 600) {
        return bad("a tombstone it can't have");
    }
    let mut extra = 0;
    for (field, (value, stamp)) in &rec.f {
        if !valid_stamp(stamp) {
            return bad("a stamp it can't have");
        }
        let fits = if field == ORDER && spec.ordered {
            value.is_null() || value.as_str().is_some_and(|k| k.len() <= 255 && order::valid_key(k))
        } else if let Some(prop) = field.strip_prefix(CELL).filter(|_| spec.entity == "page") {
            !prop.is_empty() && prop.len() <= 255 && value.to_string().len() <= MAX_TEXT
        } else if let Some((table, column)) = column_of(spec, field) {
            value_fits(conn, table, column, field, value)?
        } else {
            extra += 1;
            field.len() <= 255 && extra <= MAX_EXTRA && value.to_string().len() <= MAX_TEXT
        };
        if !fits {
            return bad(&format!("a value {field} can't have"));
        }
    }
    Ok(())
}

/// A record as other copies see it. Values are as they'd be read from the table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub e: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub f: BTreeMap<String, (Value, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gone: Option<String>,
    /// On a tombstone: the record whose deletion took this one with it, as `entity/id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

type Fields = BTreeMap<String, Value>;

/// What this copy knows about a record: each field's stamp and a hash of its value.
#[derive(Default)]
struct State {
    stamps: BTreeMap<String, (String, String)>,
    sort_key: Option<String>,
    gone: Option<String>,
    /// Whose deletion took this one with it (`entity/id`): if that comes back, so does this.
    gone_by: Option<String>,
    seq: i64,
    unsent: bool,
    /// Offered to the mailbox at least once, so it may be there before its `seq` is known.
    tried: bool,
    /// Fields this version doesn't know, as they came: sent on unchanged.
    extra: BTreeMap<String, (Value, String)>,
}

impl State {
    fn newest(&self) -> Option<&str> {
        self.stamps.values().map(|(s, _)| s.as_str()).chain(self.extra.values().map(|(_, s)| s.as_str())).max()
    }

    fn stamp(&self, field: &str) -> &str {
        self.stamps.get(field).map_or("", |(s, _)| s.as_str())
    }

    fn set(&mut self, field: &str, stamp: &str, value: &Value) {
        self.stamps.insert(field.to_string(), (stamp.to_string(), hash(value)));
    }

    fn forget(&mut self, gone: &str, by: Option<String>) {
        self.stamps.clear();
        self.extra.clear();
        self.sort_key = None;
        self.gone = Some(gone.to_string());
        self.gone_by = by;
    }
}

/// A hash of a value, to tell whether it changed. It's saved, so it must never
/// change between versions of the app (which rules out the standard library's).
fn hash(value: &Value) -> String {
    hash_text(&value.to_string())
}

/// The same hash, of text as it is (a page body).
pub(crate) fn hash_text(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn load_state(conn: &Connection, entity: &str, id: &str) -> Result<State> {
    let found = conn
        .prepare_cached(
            "SELECT stamps, sort_key, gone, seq, unsent, gone_by, tried, extra FROM sync_record WHERE entity = ?1 AND id = ?2",
        )?
        .query_row([entity, id], |r| {
            Ok(State {
                stamps: serde_json::from_str(&r.get::<_, String>(0)?).unwrap_or_default(),
                sort_key: r.get(1)?,
                gone: r.get(2)?,
                seq: r.get(3)?,
                unsent: r.get(4)?,
                gone_by: r.get(5)?,
                tried: r.get(6)?,
                extra: r.get::<_, Option<String>>(7)?.and_then(|e| serde_json::from_str(&e).ok()).unwrap_or_default(),
            })
        })
        .optional()?;
    Ok(found.unwrap_or_default())
}

fn save_state(conn: &Connection, entity: &str, id: &str, state: &State) -> Result<()> {
    let extra = if state.extra.is_empty() { None } else { Some(serde_json::to_string(&state.extra)?) };
    conn.prepare_cached(
        "INSERT INTO sync_record (entity, id, stamps, sort_key, gone, seq, unsent, gone_by, tried, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (entity, id) DO UPDATE SET stamps = excluded.stamps, sort_key = excluded.sort_key,
           gone = excluded.gone, seq = excluded.seq, unsent = excluded.unsent, gone_by = excluded.gone_by,
           tried = excluded.tried, extra = excluded.extra",
    )?
    .execute(params![
        entity,
        id,
        serde_json::to_string(&state.stamps)?,
        state.sort_key,
        state.gone,
        state.seq,
        state.unsent,
        state.gone_by,
        state.tried,
        extra
    ])?;
    Ok(())
}

/// The id of a table's rows, as records name them.
fn key_expr(spec: &Spec) -> String {
    let parts: Vec<String> = spec.key.iter().map(|k| format!("\"{k}\"")).collect();
    parts.join(" || '/' || ")
}

fn key_parts<'a>(spec: &Spec, id: &'a str) -> Result<Vec<&'a str>> {
    if spec.key.len() == 1 {
        return Ok(vec![id]);
    }
    match id.split_once('/') {
        Some((a, b)) => Ok(vec![a, b]),
        None => Err(Error(format!("A {} with an unexpected id", spec.entity))),
    }
}

fn key_where(spec: &Spec) -> String {
    let parts: Vec<String> = spec.key.iter().enumerate().map(|(i, k)| format!("\"{k}\" = ?{}", i + 1)).collect();
    parts.join(" AND ")
}

const PAGE_SELECT: &str = "SELECT json_object('parent_id', p.parent_id, 'title', p.title, 'icon', p.icon, 'favorite', p.favorite,
    'full_width', p.full_width, 'tags', p.tags, 'kind', p.kind, 'created_at', p.created_at, 'updated_at', p.updated_at,
    'deleted_at', p.deleted_at),
  CASE WHEN d.page_id IS NULL THEN NULL ELSE json_object('db.description', d.description, 'db.next_number', d.next_number) END,
  CASE WHEN r.page_id IS NULL THEN NULL ELSE json_object('row.sort_key', r.sort_key, 'row.number', r.number, 'row.template', r.template) END,
  r.cells
  FROM pages p LEFT JOIN databases d ON d.page_id = p.id LEFT JOIN db_rows r ON r.page_id = p.id WHERE p.id = ?1";

fn parse_fields(json: &str) -> Fields {
    serde_json::from_str::<BTreeMap<String, Value>>(json).unwrap_or_default()
}

/// A record's fields as they are in its table, or None if it isn't there.
fn read_fields(conn: &Connection, spec: &Spec, id: &str) -> Result<Option<Fields>> {
    if spec.entity == "page" {
        let found = conn
            .prepare_cached(PAGE_SELECT)?
            .query_row([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?))
            })
            .optional()?;
        let Some((page, db, row, cells)) = found else {
            return Ok(None);
        };
        let mut fields = parse_fields(&page);
        for part in [db, row].into_iter().flatten() {
            fields.extend(parse_fields(&part));
        }
        if let Some(cells) = cells {
            for (k, v) in parse_fields(&cells) {
                if !v.is_null() {
                    fields.insert(format!("{CELL}{k}"), v);
                }
            }
        }
        return Ok(Some(fields));
    }
    let pairs: Vec<String> = spec.fields.iter().map(|f| format!("'{f}', \"{f}\"")).collect();
    let sql = format!("SELECT json_object({}) FROM {} WHERE {}", pairs.join(", "), spec.table, key_where(spec));
    let parts = key_parts(spec, id)?;
    let json: Option<String> = conn
        .prepare_cached(&sql)?
        .query_row(rusqlite::params_from_iter(parts), |r| r.get(0))
        .optional()?;
    Ok(json.map(|j| parse_fields(&j)))
}

fn to_sql(value: &Value) -> Sql {
    match value {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Sql::Integer(i),
            None => Sql::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

/// Writes fields to a table, making the record if it isn't there. Only names
/// from the spec reach the SQL, whatever a record claims to have.
fn write_columns(tx: &Transaction, spec: &Spec, id: &str, exists: bool, changed: &Fields) -> Result<()> {
    let columns: Vec<(&str, Sql)> = spec
        .fields
        .iter()
        .filter_map(|f| changed.get(*f).map(|v| (*f, to_sql(v))))
        .collect();
    let parts = key_parts(spec, id)?;
    if exists {
        if columns.is_empty() {
            return Ok(());
        }
        let sets: Vec<String> = columns.iter().enumerate().map(|(i, (c, _))| format!("\"{c}\" = ?{}", i + 1 + parts.len())).collect();
        let sql = format!("UPDATE {} SET {} WHERE {}", spec.table, sets.join(", "), key_where(spec));
        let mut values: Vec<Sql> = parts.iter().map(|p| Sql::Text((*p).to_string())).collect();
        values.extend(columns.into_iter().map(|(_, v)| v));
        tx.prepare_cached(&sql)?.execute(rusqlite::params_from_iter(values))?;
    } else {
        let names: Vec<String> = spec.key.iter().map(|k| format!("\"{k}\"")).chain(columns.iter().map(|(c, _)| format!("\"{c}\""))).collect();
        let marks: Vec<String> = (1..=names.len()).map(|i| format!("?{i}")).collect();
        let sql = format!("INSERT INTO {} ({}) VALUES ({})", spec.table, names.join(", "), marks.join(", "));
        let mut values: Vec<Sql> = parts.iter().map(|p| Sql::Text((*p).to_string())).collect();
        values.extend(columns.into_iter().map(|(_, v)| v));
        tx.prepare_cached(&sql)?.execute(rusqlite::params_from_iter(values))?;
    }
    Ok(())
}

fn write_page(tx: &Transaction, spec: &Spec, id: &str, exists: bool, changed: &Fields) -> Result<()> {
    if !exists {
        // Search and the body's tables come with it; the fields follow.
        insert_page_as(tx, id, None, "", "", "", "")?;
    }
    write_columns(tx, spec, id, true, changed)?;
    if let Some(Value::String(title)) = changed.get("title") {
        tx.prepare_cached("UPDATE pages_fts SET title = ?1 WHERE rowid = (SELECT rid FROM pages WHERE id = ?2)")?
            .execute(params![title, id])?;
    }
    write_database_part(tx, id, changed)?;
    write_row_part(tx, id, changed)
}

fn write_database_part(tx: &Transaction, id: &str, changed: &Fields) -> Result<()> {
    if !changed.keys().any(|k| k.starts_with("db.")) {
        return Ok(());
    }
    tx.prepare_cached("INSERT OR IGNORE INTO databases (page_id) VALUES (?1)")?.execute([id])?;
    if let Some(v) = changed.get("db.description") {
        tx.prepare_cached("UPDATE databases SET description = ?2 WHERE page_id = ?1")?.execute(params![id, to_sql(v)])?;
    }
    if let Some(v) = changed.get(NEXT_NUMBER) {
        tx.prepare_cached("UPDATE databases SET next_number = ?2 WHERE page_id = ?1")?.execute(params![id, to_sql(v)])?;
    }
    Ok(())
}

/// A row's key decides whether the page is a row: NULL means it no longer is,
/// a merge like any other (its database went). Other fields only touch a row
/// that's there.
fn write_row_part(tx: &Transaction, id: &str, changed: &Fields) -> Result<()> {
    if !changed.keys().any(|k| k.starts_with("row.") || k.starts_with(CELL)) {
        return Ok(());
    }
    match changed.get("row.sort_key") {
        Some(Value::Null) => {
            tx.prepare_cached("DELETE FROM db_rows WHERE page_id = ?1")?.execute([id])?;
            return Ok(());
        }
        Some(key) => {
            tx.prepare_cached("INSERT OR IGNORE INTO db_rows (page_id, sort_key) VALUES (?1, ?2)")?.execute(params![id, to_sql(key)])?;
        }
        None => {}
    }
    let is_row: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM db_rows WHERE page_id = ?1)", [id], |r| r.get(0))?;
    if !is_row {
        return Ok(());
    }
    for (field, column) in [("row.sort_key", "sort_key"), ("row.number", "number"), ("row.template", "template")] {
        if let Some(v) = changed.get(field) {
            tx.prepare_cached(&format!("UPDATE db_rows SET {column} = ?2 WHERE page_id = ?1"))?.execute(params![id, to_sql(v)])?;
        }
    }
    if changed.keys().any(|k| k.starts_with(CELL)) {
        let cells: String = tx.query_row("SELECT cells FROM db_rows WHERE page_id = ?1", [id], |r| r.get(0))?;
        let mut cells: Map<String, Value> = serde_json::from_str(&cells).unwrap_or_default();
        for (field, value) in changed {
            if let Some(prop) = field.strip_prefix(CELL) {
                if value.is_null() {
                    cells.remove(prop);
                } else {
                    cells.insert(prop.to_string(), value.clone());
                }
            }
        }
        tx.prepare_cached("UPDATE db_rows SET cells = ?2 WHERE page_id = ?1")?
            .execute(params![id, Value::Object(cells).to_string()])?;
    }
    Ok(())
}

fn write_fields(tx: &Transaction, spec: &Spec, id: &str, exists: bool, changed: &Fields) -> Result<()> {
    if spec.entity == "page" {
        write_page(tx, spec, id, exists, changed)
    } else {
        write_columns(tx, spec, id, exists, changed)
    }
}

// ----------------------------------------------------------- repairs are local
//
// A repair is how this computer shows what it can't show as the records say
// (docs/sync.md, "Repairs are local"). It's never stamped or sent: the record
// keeps its real value, and this computer parks what it shows instead.

/// A whole record, removed here until what it needs is here.
const WHOLE: &str = "*";
/// A row's part of its page, removed while its database isn't one.
const ROW_PART: &str = "row";

/// Notes that this computer shows `shown` where the record says `logical`.
/// Parking twice keeps the first logical value: what the record said.
fn park(tx: &Transaction, entity: &str, id: &str, field: &str, logical: &Value, shown: &Value) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO sync_parked (entity, id, field, logical, shown) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (entity, id, field) DO UPDATE SET shown = excluded.shown",
    )?
    .execute(params![entity, id, field, logical.to_string(), shown.to_string()])?;
    Ok(())
}

fn parked(conn: &Connection, entity: &str, id: &str) -> Result<Vec<(String, Value, Value)>> {
    let mut stmt = conn.prepare_cached("SELECT field, logical, shown FROM sync_parked WHERE entity = ?1 AND id = ?2")?;
    let rows = stmt.query_map([entity, id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    let read = |s: &str| serde_json::from_str(s).unwrap_or(Value::Null);
    let mut out = Vec::new();
    for row in rows {
        let (field, logical, shown) = row?;
        out.push((field, read(&logical), read(&shown)));
    }
    Ok(out)
}

/// The values a parked whole record holds (its order and unknown fields are in its state).
fn values_of(spec: &Spec, record: &Value) -> Fields {
    let Ok(rec) = serde_json::from_value::<Record>(record.clone()) else {
        return Fields::new();
    };
    rec.f.into_iter().filter(|(f, _)| f != ORDER && accepts(spec, f)).map(|(f, (v, _))| (f, v)).collect()
}

/// A record's fields as its record says they are: what this computer shows
/// instead is read through. With `settle`, a parking that an edit here has
/// ended is dropped (that's an ordinary edit). The reader can't settle.
fn logical_fields(conn: &Connection, spec: &Spec, id: &str, settle: bool) -> Result<Option<Fields>> {
    let mut fields = read_fields(conn, spec, id)?;
    for (field, logical, shown) in parked(conn, spec.entity, id)? {
        let ended = if field == WHOLE {
            if fields.is_none() {
                fields = Some(values_of(spec, &logical));
                false
            } else {
                true
            }
        } else if let Some(f) = fields.as_mut() {
            if field == ROW_PART {
                if f.contains_key("row.sort_key") {
                    true
                } else {
                    if let Value::Object(m) = logical {
                        f.extend(m);
                    }
                    false
                }
            } else if f.get(&field).unwrap_or(&Value::Null) == &shown {
                f.insert(field.clone(), logical);
                false
            } else {
                true
            }
        } else {
            true
        };
        if ended && settle {
            conn.prepare_cached("DELETE FROM sync_parked WHERE entity = ?1 AND id = ?2 AND field = ?3")?
                .execute(params![spec.entity, id, field])?;
        }
    }
    Ok(fields)
}

/// Puts back what repairs changed, so merging works on what the records say;
/// the repairs run again on the merged whole. Whether there was anything.
fn unpark_all(tx: &Transaction) -> Result<bool> {
    let all: Vec<(String, String, String, String, String)> = {
        let mut stmt = tx.prepare("SELECT entity, id, field, logical, shown FROM sync_parked")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if all.is_empty() {
        return Ok(false);
    }
    tx.execute("DELETE FROM sync_parked", [])?;
    for (entity, id, field, logical, shown) in all {
        let Some((_, spec)) = spec_of(&entity) else {
            continue;
        };
        let logical: Value = serde_json::from_str(&logical).unwrap_or(Value::Null);
        let shown: Value = serde_json::from_str(&shown).unwrap_or(Value::Null);
        tx.execute_batch("SAVEPOINT sync_unpark;")?;
        let put_back = (|| -> Result<()> {
            let now = read_fields(tx, spec, &id)?;
            match (field.as_str(), now) {
                (WHOLE, None) => write_fields(tx, spec, &id, false, &values_of(spec, &logical)),
                (ROW_PART, Some(_)) => match &logical {
                    Value::Object(m) => write_row_part(tx, &id, &m.clone().into_iter().collect()),
                    _ => Ok(()),
                },
                (WHOLE | ROW_PART, _) => Ok(()),
                (column, Some(f)) if f.get(column).unwrap_or(&Value::Null) == &shown => {
                    write_fields(tx, spec, &id, true, &Fields::from([(column.to_string(), logical.clone())]))
                }
                _ => Ok(()),
            }
        })();
        match put_back {
            Ok(()) => tx.execute_batch("RELEASE sync_unpark;")?,
            Err(_) => {
                // It stays as it's shown, and parked, until it can go back.
                tx.execute_batch("ROLLBACK TO sync_unpark; RELEASE sync_unpark;")?;
                park(tx, &entity, &id, &field, &logical, &shown)?;
            }
        }
    }
    Ok(true)
}

/// What points at a record about to go keeps pointing at it in its own record;
/// this computer shows nothing there. So a deleted parent never takes a live
/// child with it, and nothing is stamped that would outlive a later delete.
fn unhook(tx: &Transaction, spec: &Spec, id: &str) -> Result<()> {
    for other in SPECS {
        for (column, target) in other.refs {
            if *target != spec.table {
                continue;
            }
            let ids: Vec<String> = {
                let mut stmt = tx.prepare_cached(&format!("SELECT {} FROM {} WHERE {column} = ?1", key_expr(other), other.table))?;
                let rows = stmt.query_map([id], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for rid in &ids {
                park(tx, other.entity, rid, column, &Value::from(id), &Value::Null)?;
            }
            tx.prepare_cached(&format!("UPDATE {} SET {column} = NULL WHERE {column} = ?1", other.table))?.execute([id])?;
        }
    }
    Ok(())
}

fn exists(conn: &Connection, table: &str, id: &str) -> Result<bool> {
    Ok(conn.query_row(&format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE id = ?1)"), [id], |r| r.get(0))?)
}

/// The record whose deletion took this one with it just now, if any: a
/// page's parent, or what a record's id names (a database, an event...).
fn owner_gone(tx: &Transaction, spec: &Spec, id: &str) -> Result<Option<String>> {
    if spec.entity == "page" {
        let parent: Option<String> =
            tx.query_row("SELECT parent FROM sync_deleted WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten();
        return Ok(match parent {
            Some(p) if !exists(tx, "pages", &p)? => Some(format!("page/{p}")),
            _ => None,
        });
    }
    let parts = key_parts(spec, id)?;
    for (column, table) in spec.needs {
        let Some(at) = spec.key.iter().position(|k| k == column) else {
            continue;
        };
        let Some(owner) = SPECS.iter().find(|s| s.table == *table) else {
            continue;
        };
        if !exists(tx, table, parts[at])? {
            return Ok(Some(format!("{}/{}", owner.entity, parts[at])));
        }
    }
    Ok(None)
}

/// Whether the record a deletion came from (`entity/id`) is here after all.
fn owner_alive(conn: &Connection, by: &str) -> Result<bool> {
    let Some((entity, id)) = by.split_once('/') else {
        return Ok(false);
    };
    match spec_of(entity) {
        Some((_, spec)) if spec.key.len() == 1 => exists(conn, spec.table, id),
        _ => Ok(false),
    }
}

/// Whether that record is in the Trash.
fn owner_trashed(conn: &Connection, by: Option<&str>) -> Result<bool> {
    let Some((entity, id)) = by.and_then(|b| b.split_once('/')) else {
        return Ok(false);
    };
    let Some((_, spec)) = spec_of(entity).filter(|(_, s)| s.trashable && s.key.len() == 1) else {
        return Ok(false);
    };
    Ok(conn
        .query_row(&format!("SELECT deleted_at IS NOT NULL FROM {} WHERE id = ?1", spec.table), [id], |r| r.get(0))
        .optional()?
        .unwrap_or(false))
}

// -------------------------------------------------------------- noticing changes

/// Notes every change to a synced table in `sync_changed`, on this connection
/// only. Nothing is saved in the database's schema.
///
/// `ON CONFLICT DO NOTHING`, never `OR IGNORE`: SQLite runs a foreign key's
/// cascade with its own conflict policy, which overrides `OR IGNORE` in triggers
/// it sets off. Deleting a course whose assignment was already noted would fail.
pub(crate) fn create_triggers(conn: &Connection) -> Result<()> {
    let mut sql = String::new();
    let note = |sql: &mut String, table: &str, entity: &str, key: &[&str]| {
        let id = |row: &str| {
            let parts: Vec<String> = key.iter().map(|k| format!("{row}.\"{k}\"")).collect();
            parts.join(" || '/' || ")
        };
        for (op, row) in [("INSERT", "new"), ("UPDATE", "new"), ("DELETE", "old")] {
            sql.push_str(&format!(
                "CREATE TEMP TRIGGER IF NOT EXISTS sync_{op}_{table} AFTER {op} ON main.{table} BEGIN
                   INSERT INTO sync_changed (entity, id) VALUES ('{entity}', {}) ON CONFLICT DO NOTHING;
                 END;\n",
                id(row)
            ));
        }
    };
    for spec in SPECS {
        note(&mut sql, spec.table, spec.entity, spec.key);
    }
    note(&mut sql, "databases", "page", &["page_id"]);
    note(&mut sql, "db_rows", "page", &["page_id"]);
    // A body written is a body to look at; the text engine decides what it means
    // (a new page with nothing in it has nothing to say yet). A page deleted
    // takes its text with it, and leaves a marker only if the mailbox may have its text.
    sql.push_str(
        "CREATE TEMP TRIGGER IF NOT EXISTS sync_body_new AFTER INSERT ON main.page_content WHEN new.content != '' BEGIN
           INSERT INTO sync_changed (entity, id) SELECT 'body', id FROM main.pages WHERE rid = new.rid ON CONFLICT DO NOTHING;
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_body_edit AFTER UPDATE OF content ON main.page_content BEGIN
           INSERT INTO sync_changed (entity, id) SELECT 'body', id FROM main.pages WHERE rid = new.rid ON CONFLICT DO NOTHING;
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_deleted_parent AFTER DELETE ON main.pages BEGIN
           INSERT INTO sync_deleted (id, parent) VALUES (old.id, old.parent_id)
             ON CONFLICT (id) DO UPDATE SET parent = excluded.parent;
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_body_gone AFTER DELETE ON main.pages BEGIN
           INSERT INTO sync_y_gone (page_id) SELECT old.id WHERE EXISTS (SELECT 1 FROM sync_y WHERE page_id = old.id) ON CONFLICT DO NOTHING;
           DELETE FROM sync_y WHERE page_id = old.id;
           DELETE FROM sync_y_out WHERE page_id = old.id;
           DELETE FROM sync_y_in WHERE page_id = old.id;
         END;",
    );
    // Which sets of siblings need looking at (positions aren't part of a record).
    sql.push_str(
        "CREATE TEMP TRIGGER IF NOT EXISTS sync_order_page_new AFTER INSERT ON main.pages BEGIN
           INSERT INTO sync_changed (entity, id) VALUES ('order', 'page:' || ifnull(new.parent_id, '')) ON CONFLICT DO NOTHING;
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_order_page AFTER UPDATE OF position, parent_id, deleted_at ON main.pages
         WHEN old.position IS NOT new.position OR old.parent_id IS NOT new.parent_id OR old.deleted_at IS NOT new.deleted_at BEGIN
           INSERT INTO sync_changed (entity, id) VALUES ('order', 'page:' || ifnull(new.parent_id, '')) ON CONFLICT DO NOTHING;
           INSERT INTO sync_changed (entity, id) VALUES ('order', 'page:' || ifnull(old.parent_id, '')) ON CONFLICT DO NOTHING;
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_order_course_new AFTER INSERT ON main.courses BEGIN
           INSERT INTO sync_changed (entity, id) VALUES ('order', 'course:') ON CONFLICT DO NOTHING;
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_order_course AFTER UPDATE OF position ON main.courses
         WHEN old.position IS NOT new.position BEGIN
           INSERT INTO sync_changed (entity, id) VALUES ('order', 'course:') ON CONFLICT DO NOTHING;
         END;",
    );
    conn.execute_batch(&sql)?;
    Ok(())
}

fn drop_triggers(conn: &Connection) -> Result<()> {
    let names: Vec<String> = {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for name in names {
        conn.execute_batch(&format!("DROP TRIGGER temp.{name}"))?;
    }
    Ok(())
}

/// The stamp shared by everything one pass of reconciling finds.
struct PassStamp<'c> {
    conn: &'c Connection,
    stamp: Option<String>,
}

impl PassStamp<'_> {
    fn get(&mut self) -> Result<String> {
        if self.stamp.is_none() {
            self.stamp = Some(tick(self.conn)?);
        }
        Ok(self.stamp.clone().unwrap_or_default())
    }
}

/// Gives every noted change its stamp, and every deleted record its tombstone.
fn reconcile_fields(tx: &Transaction) -> Result<()> {
    let noted: Vec<(String, String)> = {
        let mut stmt = tx.prepare_cached("SELECT entity, id FROM sync_changed WHERE entity NOT IN ('order', 'body')")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if noted.is_empty() {
        return Ok(());
    }
    let mut pass = PassStamp { conn: tx, stamp: None };
    for (entity, id) in &noted {
        if let Some((_, spec)) = spec_of(entity) {
            reconcile_record(tx, spec, id, &mut pass)?;
        }
    }
    tx.execute("DELETE FROM sync_changed WHERE entity NOT IN ('order', 'body')", [])?;
    tx.execute("DELETE FROM sync_deleted", [])?;
    Ok(())
}

fn reconcile_record(tx: &Transaction, spec: &Spec, id: &str, pass: &mut PassStamp) -> Result<()> {
    let mut state = load_state(tx, spec.entity, id)?;
    let Some(mut fields) = logical_fields(tx, spec, id, true)? else {
        if state.gone.is_some() || state.stamps.is_empty() {
            return Ok(());
        }
        if state.seq == 0 && !state.tried {
            // No one else ever saw it.
            tx.prepare_cached("DELETE FROM sync_record WHERE entity = ?1 AND id = ?2")?.execute([spec.entity, id])?;
            return Ok(());
        }
        let by = owner_gone(tx, spec, id)?;
        state.forget(&pass.get()?, by);
        state.unsent = true;
        return save_state(tx, spec.entity, id, &state);
    };
    let mut changed = false;
    if state.gone.take().is_some() {
        state.gone_by = None;
        changed = true;
    }
    // A cell that was cleared, or a row that's no longer one (its database
    // went), is a change to nothing, stamped like any other.
    let known: Vec<String> = state.stamps.keys().cloned().collect();
    for field in known {
        if !fields.contains_key(&field) && (field.starts_with(CELL) || field.starts_with("row.")) {
            fields.insert(field, Value::Null);
        }
    }
    for (field, value) in &fields {
        let now = hash(value);
        if state.stamps.get(field).is_none_or(|(_, h)| *h != now) {
            state.stamps.insert(field.clone(), (pass.get()?, now));
            changed = true;
        }
    }
    if changed {
        state.unsent = true;
        save_state(tx, spec.entity, id, &state)?;
    }
    Ok(())
}

/// Siblings as shown, with their order keys, and whether each is only shown
/// here by a repair (its own parent is elsewhere, so its key belongs there).
fn siblings(tx: &Transaction, group: &str) -> Result<Vec<(String, Option<String>, bool)>> {
    let collect = |sql: &str, arg: Option<&str>| -> Result<Vec<(String, Option<String>, bool)>> {
        let mut stmt = tx.prepare_cached(sql)?;
        let rows = stmt.query_map(params![arg], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    };
    match group.split_once(':') {
        Some(("page", parent)) => {
            let parent = (!parent.is_empty()).then_some(parent);
            // A database's rows keep their own order.
            if let Some(pid) = parent {
                if is_database(tx, pid)? {
                    return Ok(Vec::new());
                }
            }
            collect(
                "SELECT p.id, s.sort_key, EXISTS (SELECT 1 FROM sync_parked k WHERE k.entity = 'page' AND k.id = p.id AND k.field = 'parent_id')
                 FROM pages p LEFT JOIN sync_record s ON s.entity = 'page' AND s.id = p.id
                 WHERE p.parent_id IS ?1 AND p.deleted_at IS NULL ORDER BY p.position, p.created_at, p.id",
                parent,
            )
        }
        Some(("course", _)) => collect(
            "SELECT c.id, s.sort_key, 0 FROM courses c LEFT JOIN sync_record s ON s.entity = 'course' AND s.id = c.id
             WHERE ?1 IS NULL ORDER BY c.position, c.created_at, c.id",
            None,
        ),
        _ => Ok(Vec::new()),
    }
}

/// Indices of the longest run of keys that are valid and strictly increasing.
fn keep_in_order(keys: &[Option<&str>]) -> Vec<usize> {
    let mut tails: Vec<usize> = Vec::new();
    let mut before: Vec<Option<usize>> = vec![None; keys.len()];
    for (i, key) in keys.iter().enumerate() {
        let Some(key) = key.filter(|k| order::valid_key(k)) else {
            continue;
        };
        let at = tails.partition_point(|&t| keys[t].unwrap_or("") < key);
        before[i] = at.checked_sub(1).map(|p| tails[p]);
        if at == tails.len() {
            tails.push(i);
        } else {
            tails[at] = i;
        }
    }
    let mut out = Vec::with_capacity(tails.len());
    let mut cur = tails.last().copied();
    while let Some(i) = cur {
        out.push(i);
        cur = before[i];
    }
    out.reverse();
    out
}

/// Gives order keys to whichever siblings need one to match how they're shown.
/// One drag changes one key, however many positions it rewrote.
fn assign_order(tx: &Transaction, group: &str, pass: &mut PassStamp) -> Result<()> {
    // A page only shown here by a repair keeps the key it has where it belongs:
    // a new one would be stamped, and outlive the delete that moved it here.
    let sibs: Vec<(String, Option<String>)> =
        siblings(tx, group)?.into_iter().filter(|(_, _, parked)| !parked).map(|(id, key, _)| (id, key)).collect();
    if sibs.is_empty() {
        return Ok(());
    }
    let entity = if group.starts_with("course") { "course" } else { "page" };
    let keys: Vec<Option<&str>> = sibs.iter().map(|(_, k)| k.as_deref()).collect();
    let kept = keep_in_order(&keys);
    let mut next_kept = kept.iter().copied().peekable();
    let mut lower: Option<String> = None;
    let mut i = 0;
    while i < sibs.len() {
        if next_kept.peek() == Some(&i) {
            next_kept.next();
            lower = keys[i].map(str::to_string);
            i += 1;
            continue;
        }
        // A run of siblings between two that stay where they are.
        let end = next_kept.peek().copied().unwrap_or(sibs.len());
        let upper = if end < sibs.len() { keys[end] } else { None };
        let fresh = order::keys_between(lower.as_deref(), upper, end - i);
        for (j, key) in fresh.into_iter().enumerate() {
            let id = &sibs[i + j].0;
            let mut state = load_state(tx, entity, id)?;
            state.stamps.insert(ORDER.to_string(), (pass.get()?, String::new()));
            lower = Some(key.clone());
            state.sort_key = Some(key);
            state.unsent = true;
            save_state(tx, entity, id, &state)?;
        }
        i = end;
    }
    Ok(())
}

fn reconcile_order(tx: &Transaction) -> Result<()> {
    let groups = noted_groups(tx)?;
    if groups.is_empty() {
        return Ok(());
    }
    let mut pass = PassStamp { conn: tx, stamp: None };
    for group in &groups {
        assign_order(tx, group, &mut pass)?;
        // Sub-pages restored from the Trash can come back sharing a position.
        resort(tx, group)?;
    }
    tx.execute("DELETE FROM sync_changed WHERE entity = 'order'", [])?;
    Ok(())
}

fn noted_groups(tx: &Transaction) -> Result<Vec<String>> {
    let mut stmt = tx.prepare_cached("SELECT id FROM sync_changed WHERE entity = 'order'")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

// ---------------------------------------------------------------------- merging

#[derive(Default)]
struct Run {
    /// Sets of siblings whose order changed.
    groups: HashSet<String>,
    /// Stored file names of files deleted for good, whose bytes can go.
    files: Vec<String>,
    newest: String,
    changed: HashSet<&'static str>,
}

impl Run {
    fn note(&mut self, stamp: &str) {
        if stamp > self.newest.as_str() {
            self.newest = stamp.to_string();
        }
    }

    fn wrote(&mut self, spec: &Spec, _fields: &Fields) {
        self.changed.insert(spec.entity);
    }
}

/// If a record survives a delete and has `deleted_at`, it lands in the Trash at
/// the moment of the delete, as computed the same way on every copy.
fn to_trash(spec: &Spec, state: &mut State, gone: &str, fields: &mut Fields) {
    if spec.trashable && state.stamp("deleted_at") < gone {
        let at = Value::from(parse(gone).0);
        state.set("deleted_at", gone, &at);
        fields.insert("deleted_at".to_string(), at);
    }
}

fn hard_delete(tx: &Transaction, spec: &Spec, id: &str, run: &mut Run) -> Result<()> {
    unhook(tx, spec, id)?;
    if spec.entity == "file" {
        let stored: Option<String> =
            tx.query_row("SELECT stored FROM files WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        run.files.extend(stored);
    }
    let parts = key_parts(spec, id)?;
    tx.prepare_cached(&format!("DELETE FROM {} WHERE {}", spec.table, key_where(spec)))?
        .execute(rusqlite::params_from_iter(parts))?;
    tx.prepare_cached("DELETE FROM sync_parked WHERE entity = ?1 AND id = ?2")?.execute([spec.entity, id])?;
    run.changed.insert(spec.entity);
    Ok(())
}

fn group_of(spec: &Spec, fields: &Fields, current: Option<&Fields>) -> Vec<String> {
    let parent = |f: &Fields| f.get("parent_id").and_then(Value::as_str).unwrap_or("").to_string();
    match spec.entity {
        "course" => vec!["course:".to_string()],
        "page" => {
            let mut out = Vec::new();
            if let Some(cur) = current {
                out.push(format!("page:{}", parent(cur)));
            }
            if fields.contains_key("parent_id") {
                out.push(format!("page:{}", parent(fields)));
            }
            out
        }
        _ => Vec::new(),
    }
}

fn merge(tx: &Transaction, rec: &Record, seq: i64, run: &mut Run) -> Result<()> {
    let Some((_, spec)) = spec_of(&rec.e) else {
        return Ok(());
    };
    check_record(tx, spec, rec)?;
    let id = rec.id.as_str();
    let mut state = load_state(tx, spec.entity, id)?;
    state.seq = state.seq.max(seq);
    let current = logical_fields(tx, spec, id, true)?;

    if let Some(gone) = &rec.gone {
        run.note(gone);
        let undone = match &rec.by {
            Some(by) => owner_alive(tx, by)?,
            None => false,
        };
        match &current {
            Some(_) if undone || state.newest().is_some_and(|n| n > gone.as_str()) => {
                // Changed here after it was deleted there, or what took it with it
                // is here after all: it stays. In the Trash with the delete, unless
                // what it belongs to is back and out of the Trash.
                let mut fields = Fields::new();
                if !undone || owner_trashed(tx, rec.by.as_deref())? {
                    to_trash(spec, &mut state, gone, &mut fields);
                }
                if !fields.is_empty() {
                    write_fields(tx, spec, id, true, &fields)?;
                    run.wrote(spec, &fields);
                }
                if spec.entity == "file" {
                    // The other copies lost the bytes with the delete; they go up again.
                    tx.execute("UPDATE sync_file SET uploaded = 0 WHERE id = ?1", [id])?;
                }
                state.unsent = true;
            }
            Some(_) => {
                hard_delete(tx, spec, id, run)?;
                state.forget(gone, rec.by.clone());
                state.unsent = false;
            }
            None => {
                let ours_later = state.gone.as_deref().is_some_and(|g| g > gone.as_str());
                if !ours_later {
                    state.forget(gone, rec.by.clone());
                }
                state.unsent = ours_later;
            }
        }
        return save_state(tx, spec.entity, id, &state);
    }

    let Some(newest) = rec.f.values().map(|(_, s)| s.as_str()).max() else {
        // Nothing in it, but its number in the mailbox still counts.
        return keep_seq(tx, rec, seq);
    };
    run.note(newest);

    let Some(current) = current else {
        // A delete of ours stands, unless what took it with it is back.
        let void = match &state.gone_by {
            Some(by) => owner_alive(tx, by)?,
            None => false,
        };
        if !void && state.gone.as_deref().is_some_and(|g| g >= newest) {
            // Our delete is the later one, and the mailbox should know.
            state.unsent = true;
            return save_state(tx, spec.entity, id, &state);
        }
        let gone = state.gone.take();
        let by = state.gone_by.take();
        let mut fields = Fields::new();
        for (field, (value, stamp)) in &rec.f {
            if field == ORDER && spec.ordered {
                state.sort_key = value.as_str().map(str::to_string);
                state.stamps.insert(ORDER.to_string(), (stamp.clone(), String::new()));
            } else if accepts(spec, field) {
                state.set(field, stamp, value);
                fields.insert(field.clone(), value.clone());
            } else {
                state.extra.insert(field.clone(), (value.clone(), stamp.clone()));
            }
        }
        if let Some(gone) = &gone {
            if by.is_none() || owner_trashed(tx, by.as_deref())? {
                to_trash(spec, &mut state, gone, &mut fields);
            }
        }
        run.groups.extend(group_of(spec, &fields, None));
        write_fields(tx, spec, id, false, &fields)?;
        run.wrote(spec, &fields);
        state.unsent = differs(&state, rec);
        return save_state(tx, spec.entity, id, &state);
    };

    let mut changed = Fields::new();
    for (field, (value, stamp)) in &rec.f {
        if field == ORDER && spec.ordered {
            let ours = state.stamp(ORDER).to_string();
            let theirs = value.as_str().map(str::to_string);
            if *stamp > ours || (*stamp == ours && theirs > state.sort_key) {
                state.sort_key = theirs;
                state.stamps.insert(ORDER.to_string(), (stamp.clone(), String::new()));
                run.groups.extend(group_of(spec, &Fields::new(), Some(&current)));
                run.changed.insert(spec.entity);
            }
            continue;
        }
        if !accepts(spec, field) {
            // A field this version doesn't know: kept as it came, the later one winning.
            let take = state.extra.get(field).is_none_or(|(v, s)| stamp > s || (stamp == s && value.to_string() > v.to_string()));
            if take {
                state.extra.insert(field.clone(), (value.clone(), stamp.clone()));
            }
            continue;
        }
        let ours = current.get(field).unwrap_or(&Value::Null);
        let ours_stamp = state.stamp(field).to_string();
        let now = if field == NEXT_NUMBER {
            // The larger wins, or two rows could be given one number.
            let larger = if value.as_i64() > ours.as_i64() { value } else { ours };
            state.set(field, stamp.max(&ours_stamp), larger);
            larger
        } else {
            let later = *stamp > ours_stamp;
            let tie = *stamp == ours_stamp && value.to_string() > ours.to_string();
            if !later && !tie {
                continue;
            }
            state.set(field, stamp, value);
            value
        };
        if now != ours {
            changed.insert(field.clone(), now.clone());
        }
    }
    if !changed.is_empty() {
        run.groups.extend(group_of(spec, &changed, Some(&current)));
        write_fields(tx, spec, id, true, &changed)?;
        run.wrote(spec, &changed);
    }
    state.unsent = differs(&state, rec);
    save_state(tx, spec.entity, id, &state)
}

/// A record passed over still moved this copy past its number in the mailbox:
/// without keeping that, the next push of it from here would be refused for good.
fn keep_seq(tx: &Transaction, rec: &Record, seq: i64) -> Result<()> {
    tx.prepare_cached("UPDATE sync_record SET seq = max(seq, ?3) WHERE entity = ?1 AND id = ?2")?
        .execute(params![rec.e, rec.id, seq])?;
    Ok(())
}

/// Keeps what couldn't be merged, for a later version to try again.
fn quarantine(tx: &Transaction, seq: i64, key: &str, data: &[u8], reason: &str) -> Result<()> {
    tx.prepare_cached("INSERT OR REPLACE INTO sync_quarantine (seq, key, kind, data, reason) VALUES (?1, ?2, 'r', ?3, ?4)")?
        .execute(params![seq, key, data, reason])?;
    Ok(())
}

/// Whether what this copy now has isn't what the record said, so it has to be sent.
fn differs(state: &State, rec: &Record) -> bool {
    let known = state.stamps.iter().any(|(field, (stamp, hashed))| match rec.f.get(field) {
        None => true,
        Some((value, theirs)) => {
            theirs != stamp
                || if field == ORDER {
                    value.as_str() != state.sort_key.as_deref()
                } else {
                    hash(value) != *hashed
                }
        }
    });
    let extra = state.extra.iter().any(|(field, (value, stamp))| match rec.f.get(field) {
        None => true,
        Some((theirs, their_stamp)) => their_stamp != stamp || theirs != value,
    });
    known || extra
}

/// The smallest id in each cycle of parents moves to the top level, on every copy.
fn break_cycles(tx: &Transaction) -> Result<()> {
    let parents: HashMap<String, String> = {
        let mut stmt = tx.prepare("SELECT id, parent_id FROM pages WHERE parent_id IS NOT NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut done: HashSet<&str> = HashSet::new();
    let mut starts: Vec<&str> = parents.keys().map(String::as_str).collect();
    starts.sort_unstable();
    for start in starts {
        let mut path: Vec<&str> = Vec::new();
        let mut cur = start;
        loop {
            if done.contains(cur) {
                break;
            }
            if let Some(at) = path.iter().position(|p| *p == cur) {
                if let Some(smallest) = path[at..].iter().min() {
                    let parent = parents.get(*smallest).cloned().unwrap_or_default();
                    park(tx, "page", smallest, "parent_id", &Value::from(parent), &Value::Null)?;
                    tx.execute("UPDATE pages SET parent_id = NULL WHERE id = ?1", [smallest])?;
                }
                break;
            }
            path.push(cur);
            match parents.get(cur) {
                Some(p) => cur = p,
                None => break,
            }
        }
        done.extend(path);
    }
    Ok(())
}

/// A live page under a trashed one would be out of sight: it moves to the top
/// level, or (a row, which can't) joins its database in the Trash.
fn lift_from_trash(tx: &Transaction) -> Result<()> {
    let lost: Vec<(String, String, i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT c.id, p.id, CAST(p.deleted_at AS INTEGER), p.kind FROM pages p JOIN pages c ON c.parent_id = p.id
             WHERE p.deleted_at IS NOT NULL AND c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (id, parent, deleted_at, kind) in lost {
        if kind == "database" {
            park(tx, "page", &id, "deleted_at", &Value::Null, &Value::from(deleted_at))?;
            tx.execute("UPDATE pages SET deleted_at = ?2 WHERE id = ?1", params![id, deleted_at])?;
        } else {
            park(tx, "page", &id, "parent_id", &Value::from(parent), &Value::Null)?;
            tx.execute("UPDATE pages SET parent_id = NULL WHERE id = ?1", [id])?;
        }
    }
    Ok(())
}

/// Clears references to what isn't there, and removes what can't exist without it.
fn sweep(tx: &Transaction) -> Result<()> {
    for spec in SPECS {
        let key = key_expr(spec);
        for (column, target) in spec.refs {
            let dangling: Vec<(String, String)> = {
                let mut stmt = tx.prepare(&format!(
                    "SELECT {key}, {column} FROM {t} WHERE {column} IS NOT NULL AND {column} NOT IN (SELECT id FROM {target})",
                    t = spec.table
                ))?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for (rid, value) in &dangling {
                park(tx, spec.entity, rid, column, &Value::from(value.as_str()), &Value::Null)?;
                tx.prepare_cached(&format!("UPDATE {} SET {column} = NULL WHERE {}", spec.table, key_where(spec)))?
                    .execute(rusqlite::params_from_iter(key_parts(spec, rid)?))?;
            }
        }
        for (column, target) in spec.needs {
            let orphans: Vec<String> = {
                let mut stmt =
                    tx.prepare(&format!("SELECT {key} FROM {t} WHERE {column} NOT IN (SELECT id FROM {target})", t = spec.table))?;
                let rows = stmt.query_map([], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for rid in &orphans {
                let state = load_state(tx, spec.entity, rid)?;
                if let Some(fields) = read_fields(tx, spec, rid)? {
                    let rec = record_from(spec, rid, &state, &fields);
                    park(tx, spec.entity, rid, WHOLE, &serde_json::to_value(&rec)?, &Value::Null)?;
                }
                tx.prepare_cached(&format!("DELETE FROM {} WHERE {}", spec.table, key_where(spec)))?
                    .execute(rusqlite::params_from_iter(key_parts(spec, rid)?))?;
            }
        }
    }
    // A row whose database isn't one: its part of the page waits.
    let lost: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT r.page_id FROM db_rows r JOIN pages p ON p.id = r.page_id LEFT JOIN pages q ON q.id = p.parent_id
             WHERE q.id IS NULL OR q.kind != 'database'",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for pid in &lost {
        let part: Map<String, Value> = read_fields(tx, &SPECS[0], pid)?
            .unwrap_or_default()
            .into_iter()
            .filter(|(k, _)| k.starts_with("row.") || k.starts_with(CELL))
            .collect();
        park(tx, "page", pid, ROW_PART, &Value::Object(part), &Value::Null)?;
        tx.execute("DELETE FROM db_rows WHERE page_id = ?1", [pid])?;
    }
    Ok(())
}

/// Puts siblings in key order; any without a key yet go after the rest, as they are.
fn resort(tx: &Transaction, group: &str) -> Result<()> {
    let mut sibs: Vec<(String, Option<String>)> = siblings(tx, group)?.into_iter().map(|(id, key, _)| (id, key)).collect();
    sibs.sort_by(|(a_id, a), (b_id, b)| match (a, b) {
        (Some(a), Some(b)) => a.cmp(b).then_with(|| a_id.cmp(b_id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    let ids: Vec<String> = sibs.into_iter().map(|(id, _)| id).collect();
    if group.starts_with("course") {
        let mut stmt = tx.prepare_cached("UPDATE courses SET position = ?1 WHERE id = ?2 AND position != ?1")?;
        for (i, id) in ids.iter().enumerate() {
            stmt.execute(params![i as i64, id])?;
        }
        Ok(())
    } else {
        write_positions(tx, &ids)
    }
}

pub(crate) fn meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub(crate) fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

/// Stamps everything that already exists, from when it last changed: a copied
/// notes folder then merges on what's actually newer. Order keys come later.
fn backfill(tx: &Transaction) -> Result<()> {
    let device = device(tx)?;
    let mut newest = String::new();
    for spec in SPECS {
        let rows: Vec<(String, i64)> = {
            let mut stmt = tx.prepare(&format!("SELECT {}, CAST({} AS INTEGER) FROM {}", key_expr(spec), spec.touched, spec.table))?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for (id, touched) in rows {
            let Some(fields) = read_fields(tx, spec, &id)? else {
                continue;
            };
            let stamp = make(touched.max(1), 0, &device);
            let mut state = State { unsent: true, ..Default::default() };
            for (field, value) in &fields {
                state.set(field, &stamp, value);
            }
            save_state(tx, spec.entity, &id, &state)?;
            if stamp > newest {
                newest = stamp;
            }
        }
    }
    tx.execute_batch(
        "INSERT OR IGNORE INTO sync_changed (entity, id)
           SELECT DISTINCT 'order', 'page:' || ifnull(parent_id, '') FROM pages;
         INSERT OR IGNORE INTO sync_changed (entity, id) SELECT DISTINCT 'order', 'course:' FROM courses;",
    )?;
    observe(tx, &newest)
}

/// One record ready to send.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    pub entity: String,
    pub id: String,
    /// The `seq` the mailbox has to still have for this record, or it's refused.
    pub base: i64,
    pub record: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sent {
    pub entity: String,
    pub id: String,
    pub seq: i64,
}

/// The mailbox refused a push because it has a newer version of this record,
/// one this computer has already seen (or couldn't read): that's the new base.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rebase {
    pub entity: String,
    pub id: String,
    pub seq: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Incoming {
    pub seq: i64,
    pub record: String,
}

/// What a merge changed, for the app to refresh what it shows.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub entities: Vec<String>,
    pub skipped: usize,
}

fn record_from(spec: &Spec, id: &str, state: &State, fields: &Fields) -> Record {
    let mut f = BTreeMap::new();
    for (field, (stamp, _)) in &state.stamps {
        let value = if field == ORDER { Value::from(state.sort_key.clone()) } else { fields.get(field).cloned().unwrap_or(Value::Null) };
        f.insert(field.clone(), (value, stamp.clone()));
    }
    for (field, (value, stamp)) in &state.extra {
        f.insert(field.clone(), (value.clone(), stamp.clone()));
    }
    Record { e: spec.entity.to_string(), id: id.to_string(), f, gone: None, by: None }
}

fn build_record(conn: &Connection, spec: &Spec, id: &str, state: &State) -> Result<Option<Record>> {
    if let Some(gone) = &state.gone {
        return Ok(Some(Record {
            e: spec.entity.to_string(),
            id: id.to_string(),
            f: BTreeMap::new(),
            gone: Some(gone.clone()),
            by: state.gone_by.clone(),
        }));
    }
    Ok(logical_fields(conn, spec, id, true)?.map(|fields| record_from(spec, id, state, &fields)))
}

/// How far down a chain of deletions each page's tombstone is: a folder's
/// before the pages it took with it, which go before theirs.
fn tombstone_depths(conn: &Connection) -> Result<HashMap<String, usize>> {
    let owners: HashMap<String, String> = {
        let mut stmt =
            conn.prepare("SELECT id, substr(gone_by, 6) FROM sync_record WHERE entity = 'page' AND gone_by LIKE 'page/%'")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    Ok(chain_depths(&owners))
}

/// For each key, how many links there are above it, following `owners`.
fn chain_depths(owners: &HashMap<String, String>) -> HashMap<String, usize> {
    let mut out = HashMap::with_capacity(owners.len());
    for id in owners.keys() {
        let mut depth = 0;
        let mut cur = id;
        while let Some(owner) = owners.get(cur) {
            depth += 1;
            cur = owner;
            if depth > owners.len() {
                break;
            }
        }
        out.insert(id.clone(), depth);
    }
    out
}

/// How deep each page is, so parents are sent before their children.
fn depths(conn: &Connection) -> Result<HashMap<String, usize>> {
    let parents: HashMap<String, Option<String>> = {
        let mut stmt = conn.prepare("SELECT id, parent_id FROM pages")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut out = HashMap::with_capacity(parents.len());
    for id in parents.keys() {
        let mut depth = 0;
        let mut cur = id;
        while let Some(Some(parent)) = parents.get(cur) {
            depth += 1;
            cur = parent;
            if depth > parents.len() {
                break;
            }
        }
        out.insert(id.clone(), depth);
    }
    Ok(out)
}

/// Whether what's in the table isn't what was last synced.
fn stale(state: &State, fields: Option<&Fields>) -> bool {
    let Some(fields) = fields else {
        return state.gone.is_none() && !state.stamps.is_empty();
    };
    if state.gone.is_some() || state.stamps.is_empty() {
        return true;
    }
    let cleared = state.stamps.keys().filter(|f| !fields.contains_key(*f) && (f.starts_with(CELL) || f.starts_with("row.")));
    let null = hash(&Value::Null);
    cleared.into_iter().any(|f| state.stamps.get(f).is_some_and(|(_, h)| *h != null))
        || fields.iter().any(|(f, v)| state.stamps.get(f).is_none_or(|(_, h)| *h != hash(v)))
}

impl Db {
    /// Called when the database opens.
    pub(crate) fn sync_on_open(&self) -> Result<()> {
        let conn = self.conn();
        if meta(&conn, "enabled")?.is_some() {
            create_triggers(&conn)?;
        }
        Ok(())
    }

    pub fn sync_enabled(&self) -> Result<bool> {
        Ok(meta(&self.conn(), "enabled")?.is_some())
    }

    /// Starts keeping track of changes. The first time, everything that exists
    /// is stamped; after a turn-off it goes on from what it kept, with an audit.
    pub fn sync_enable(&self) -> Result<()> {
        let kept = {
            let mut conn = self.conn();
            if meta(&conn, "enabled")?.is_some() {
                return Ok(());
            }
            let kept: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM sync_record)", [], |r| r.get(0))?;
            let tx = conn.transaction()?;
            if !kept {
                backfill(&tx)?;
            }
            set_meta(&tx, "enabled", "1")?;
            tx.commit()?;
            create_triggers(&conn)?;
            kept
        };
        // Back after a turn-off: whatever changed in between gets its stamp.
        if kept {
            self.sync_audit()?;
        }
        Ok(())
    }

    /// Stops noticing changes. What each record was last synced as is kept, so
    /// turning on again catches up with what changed in between.
    pub fn sync_disable(&self) -> Result<()> {
        let conn = self.conn();
        drop_triggers(&conn)?;
        conn.execute("DELETE FROM sync_meta WHERE key = 'enabled'", [])?;
        Ok(())
    }

    /// Joining another synced copy (another wrapped key): the stamps stay, so
    /// merging with what's there goes on what's newer, and everything goes up again.
    pub fn sync_new_copy(&self) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute_batch(
            "DELETE FROM sync_record WHERE gone IS NOT NULL;
             UPDATE sync_record SET seq = 0, unsent = 1, tried = 0;
             DELETE FROM sync_inbox;
             DELETE FROM sync_y;
             DELETE FROM sync_y_out;
             DELETE FROM sync_y_in;
             DELETE FROM sync_y_gone;
             DELETE FROM sync_quarantine;
             UPDATE sync_file SET uploaded = 0;
             DELETE FROM sync_meta WHERE key IN ('cursor', 'ready');",
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Forgets everything about syncing (another account). Notes aren't touched.
    pub fn sync_forget_all(&self) -> Result<()> {
        let mut conn = self.conn();
        drop_triggers(&conn)?;
        let tx = conn.transaction()?;
        tx.execute_batch(
            "DELETE FROM sync_record;
             DELETE FROM sync_changed;
             DELETE FROM sync_inbox;
             DELETE FROM sync_y;
             DELETE FROM sync_y_out;
             DELETE FROM sync_y_in;
             DELETE FROM sync_y_gone;
             DELETE FROM sync_file;
             DELETE FROM sync_parked;
             DELETE FROM sync_quarantine;
             DELETE FROM sync_deleted;
             DELETE FROM sync_meta WHERE key IN ('enabled', 'ordered', 'cursor', 'account', 'ready', 'wrapped');",
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The last item of the mailbox this copy has read.
    pub fn sync_cursor(&self) -> Result<i64> {
        Ok(meta(&self.conn(), "cursor")?.and_then(|c| c.parse().ok()).unwrap_or(0))
    }

    /// Keeps records read from the mailbox until `sync_apply` merges them all
    /// at once, so a parent and its child never arrive apart.
    pub fn sync_receive(&self, items: &[Incoming], cursor: i64) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        receive_in(&tx, items, cursor)?;
        tx.commit()?;
        Ok(())
    }

    /// Merges everything received. The file names returned have lost their
    /// record, and their bytes have been deleted.
    pub fn sync_apply(&self) -> Result<Applied> {
        let (applied, files) = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let (applied, files) = apply(&tx)?;
            tx.commit()?;
            (applied, files)
        };
        for name in files {
            let _ = std::fs::remove_file(self.files_dir.join(name));
        }
        Ok(applied)
    }

    /// Records to send, parents first, up to about `max_bytes`.
    pub fn sync_outgoing(&self, max_bytes: usize) -> Result<Vec<Outgoing>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        reconcile_fields(&tx)?;
        reconcile_order(&tx)?;
        set_meta(&tx, "ordered", "1")?;
        tx.commit()?;
        let unsent: Vec<(String, String, Option<String>)> = {
            let mut stmt = conn.prepare("SELECT entity, id, gone FROM sync_record WHERE unsent = 1")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        if unsent.is_empty() {
            return Ok(Vec::new());
        }
        let depth = depths(&conn)?;
        let gone_depth = tombstone_depths(&conn)?;
        let mut order: Vec<(bool, usize, usize, String, String)> = unsent
            .into_iter()
            .filter_map(|(entity, id, gone)| {
                let (rank, _) = spec_of(&entity)?;
                let d = match (entity.as_str(), gone.is_some()) {
                    ("page", false) => depth.get(&id).copied().unwrap_or(0),
                    ("page", true) => gone_depth.get(&id).copied().unwrap_or(0),
                    _ => 0,
                };
                Some((gone.is_some(), rank, d, entity, id))
            })
            .collect();
        order.sort();
        let mut out = Vec::new();
        let mut bytes = 0;
        for (_, rank, _, entity, id) in order {
            let spec = &SPECS[rank];
            let state = load_state(&conn, &entity, &id)?;
            let Some(record) = build_record(&conn, spec, &id, &state)? else {
                continue;
            };
            let record = serde_json::to_string(&record)?;
            bytes += record.len();
            out.push(Outgoing { entity, id, base: state.seq, record });
            if bytes >= max_bytes || out.len() >= MAX_ITEMS {
                break;
            }
        }
        // Offered now: if the answer is lost, a delete here must still reach the mailbox.
        let mut stmt = conn.prepare_cached("UPDATE sync_record SET tried = 1 WHERE entity = ?1 AND id = ?2 AND tried = 0")?;
        for o in &out {
            stmt.execute(params![o.entity, o.id])?;
        }
        Ok(out)
    }

    /// The mailbox stored these. Anything changed since is noted, and goes next time.
    pub fn sync_sent(&self, sent: &[Sent]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for item in sent {
            tx.prepare_cached("UPDATE sync_record SET seq = max(seq, ?3), unsent = 0 WHERE entity = ?1 AND id = ?2")?
                .execute(params![item.entity, item.id, item.seq])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Takes the mailbox's `seq` for records it refused for an old base, when this
    /// computer has already read that version. The engine checks that it has.
    pub fn sync_records_rebase(&self, items: &[Rebase]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for item in items {
            tx.prepare_cached("UPDATE sync_record SET seq = ?3 WHERE entity = ?1 AND id = ?2 AND seq < ?3")?
                .execute(params![item.entity, item.id, item.seq])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Notes every record whose fields differ from what was last synced (see
    /// "Audit" in docs/sync.md). Returns how many.
    pub fn sync_audit(&self) -> Result<usize> {
        if !self.sync_enabled()? {
            return Ok(0);
        }
        let mut noted: Vec<(&'static str, String)> = Vec::new();
        for spec in SPECS {
            // One table at a time, so searches aren't held up for long.
            let conn = self.reader();
            let ids: Vec<String> = {
                let mut stmt = conn.prepare(&format!("SELECT {} FROM {}", key_expr(spec), spec.table))?;
                let rows = stmt.query_map([], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            let mut seen: HashSet<String> = HashSet::with_capacity(ids.len());
            for id in ids {
                let state = load_state(&conn, spec.entity, &id)?;
                if stale(&state, logical_fields(&conn, spec, &id, false)?.as_ref()) {
                    noted.push((spec.entity, id.clone()));
                }
                seen.insert(id);
            }
            // Gone from the table, with no tombstone and nothing parked for it.
            let kept: Vec<String> = {
                let mut stmt = conn.prepare("SELECT id FROM sync_record WHERE entity = ?1 AND gone IS NULL")?;
                let rows = stmt.query_map([spec.entity], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for id in kept {
                if !seen.contains(&id) && logical_fields(&conn, spec, &id, false)?.is_none() {
                    noted.push((spec.entity, id));
                }
            }
        }
        // Page bodies written without the triggers: not the body their text last matched.
        let bodies: Vec<String> = {
            let conn = self.reader();
            let mut stmt = conn.prepare(
                "SELECT p.id, c.content, y.body_hash FROM sync_y y JOIN pages p ON p.id = y.page_id
                 JOIN page_content c ON c.rid = p.rid WHERE y.body_hash IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
            let mut out = Vec::new();
            for row in rows {
                let (id, content, matched) = row?;
                if hash_text(&content) != matched {
                    out.push(id);
                }
            }
            out
        };
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for (entity, id) in &noted {
            tx.prepare_cached("INSERT OR IGNORE INTO sync_changed (entity, id) VALUES (?1, ?2)")?.execute([*entity, id.as_str()])?;
        }
        for id in &bodies {
            tx.prepare_cached("INSERT OR IGNORE INTO sync_changed (entity, id) VALUES ('body', ?1)")?.execute([id])?;
        }
        // Positions aren't records: every set of siblings is looked at again.
        tx.execute_batch(
            "INSERT OR IGNORE INTO sync_changed (entity, id)
               SELECT DISTINCT 'order', 'page:' || ifnull(parent_id, '') FROM pages;
             INSERT OR IGNORE INTO sync_changed (entity, id) SELECT DISTINCT 'order', 'course:' FROM courses;",
        )?;
        tx.commit()?;
        Ok(noted.len() + bodies.len())
    }

    /// Whether anything changed here since the last look. It's asked every few
    /// seconds, so it reads on its own connection and never holds up a save.
    pub fn sync_has_changes(&self) -> Result<bool> {
        Ok(self.reader().query_row("SELECT EXISTS (SELECT 1 FROM sync_changed WHERE entity != 'order')", [], |r| r.get(0))?)
    }

    /// Whether anything is waiting to be sent or merged.
    pub fn sync_idle(&self) -> Result<bool> {
        let conn = self.conn();
        let busy: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM sync_record WHERE unsent = 1)
                 OR EXISTS (SELECT 1 FROM sync_inbox)
                 OR EXISTS (SELECT 1 FROM sync_changed WHERE entity != 'body')",
            [],
            |r| r.get(0),
        )?;
        Ok(!busy)
    }
}

/// `sync_receive` inside someone else's transaction, so records and page text
/// from one pull are stored together with the cursor.
pub(crate) fn receive_in(tx: &Transaction, items: &[Incoming], cursor: i64) -> Result<()> {
    for item in items {
        tx.prepare_cached("INSERT OR REPLACE INTO sync_inbox (seq, record) VALUES (?1, ?2)")?
            .execute(params![item.seq, item.record])?;
    }
    set_meta(tx, "cursor", &cursor.to_string())
}

fn apply(tx: &Transaction) -> Result<(Applied, Vec<String>)> {
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    reconcile_fields(tx)?;
    // Local drags get their keys before anything can be re-sorted. On a first
    // sync this waits until after: this copy's pages go after the ones coming in.
    if meta(tx, "ordered")?.is_some() {
        reconcile_order(tx)?;
    }
    let mut skipped = 0;
    let mut items: Vec<(usize, bool, i64, Record)> = Vec::new();
    {
        let mut stmt = tx.prepare("SELECT seq, record FROM sync_inbox ORDER BY seq")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (seq, json) = row?;
            match serde_json::from_str::<Record>(&json) {
                Ok(rec) => {
                    let rank = spec_of(&rec.e).map_or(usize::MAX, |(r, _)| r);
                    items.push((rank, rec.gone.is_some(), seq, rec));
                }
                Err(e) => {
                    quarantine(tx, seq, "", json.as_bytes(), &format!("not a record: {e}"))?;
                    skipped += 1;
                }
            }
        }
    }
    // Live records first, what they refer to before them; then what's gone,
    // a deletion before the ones it took with it.
    let owners: HashMap<String, String> = items
        .iter()
        .filter(|(_, gone, _, r)| *gone && r.e == "page")
        .filter_map(|(_, _, _, r)| Some((r.id.clone(), r.by.as_deref()?.strip_prefix("page/")?.to_string())))
        .collect();
    let depth = chain_depths(&owners);
    let rank_of = |item: &(usize, bool, i64, Record)| (item.1, item.0, depth.get(&item.3.id).copied().unwrap_or(0), item.2);
    items.sort_by(|a, b| rank_of(a).cmp(&rank_of(b)));

    // What repairs changed goes back first, so merging works on what the records say.
    let parked = unpark_all(tx)?;
    let mut run = Run::default();
    for (_, _, seq, rec) in &items {
        tx.execute_batch("SAVEPOINT sync_merge;")?;
        match merge(tx, rec, *seq, &mut run) {
            Ok(()) => tx.execute_batch("RELEASE sync_merge;")?,
            Err(e) => {
                // A record this copy can't make sense of mustn't hold up the rest.
                tx.execute_batch("ROLLBACK TO sync_merge; RELEASE sync_merge;")?;
                eprintln!("Sync: passed over a {} record: {}", rec.e, e.0);
                keep_seq(tx, rec, *seq)?;
                quarantine(tx, *seq, &format!("{}/{}", rec.e, rec.id), &serde_json::to_vec(rec)?, &format!("merge: {}", e.0))?;
                skipped += 1;
            }
        }
    }
    if !run.newest.is_empty() {
        observe(tx, &run.newest)?;
    }
    // Repairs, on the merged whole: never stamped, never sent. Nothing may be
    // left pointing at nothing either, or this couldn't commit.
    if parked || !items.is_empty() {
        break_cycles(tx)?;
        lift_from_trash(tx)?;
        sweep(tx)?;
    }
    let mut groups = run.groups.clone();
    groups.extend(noted_groups(tx)?);
    for group in &groups {
        resort(tx, group)?;
    }
    reconcile_fields(tx)?;
    reconcile_order(tx)?;
    set_meta(tx, "ordered", "1")?;
    tx.execute("DELETE FROM sync_inbox", [])?;
    let mut entities: Vec<String> = run.changed.iter().map(|e| e.to_string()).collect();
    entities.sort();
    Ok((Applied { entities, skipped }, run.files))
}
