//! Databases: pages laid out as a table, board, gallery, list, calendar,
//! chart, timeline or form.
//!
//! A database is a page whose `kind` is "database", and each row is a page
//! inside it, so a row has a body, links, tags, search, favourites and the
//! trash like any other page (and the row's title is its page's title). What
//! makes it a database lives here: typed properties, saved views and
//! automations (the schema), and each row's values (`cells`, keyed by
//! property id). A row can also be a template: a page that new rows start
//! from (its values and its body), kept apart from the rows themselves.
//!
//! Everything is shaped to sync between devices (see docs/sync.md):
//! properties, views and select options have stable ids; rows, properties
//! and views are ordered by fractional keys (strings that sort, so putting
//! one between two others never renumbers the rest); and deleted properties
//! and views are kept as tombstones.

use crate::db::{fail, insert_page, is_database, meta_by_id, now, place, replace_ids, Db, PageMeta, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// Property types the UI knows how to show and edit.
const PROPERTY_TYPES: &[&str] = &[
    "title",
    "text",
    "number",
    "select",
    "multiSelect",
    "status",
    "date",
    "checkbox",
    "url",
    "email",
    "phone",
    "files",
    "relation",
    "rollup",
    "formula",
    "created",
    "edited",
    "tags",
    "course",
    "id",
    "button",
];

const VIEW_TYPES: &[&str] = &["table", "board", "gallery", "list", "calendar", "chart", "timeline", "form"];

/// What starts an automation: a row being added, or a value changing.
const AUTOMATION_TYPES: &[&str] = &["added", "changed"];

/// The title property's fixed id (its values are the row pages' titles).
const TITLE: &str = "title";

/// Most rows one call may create or change (a pasted sheet, an import).
const MAX_BATCH: usize = 20_000;

/// A property or a view: an id, a name, a type, its settings, and its place
/// in order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default = "empty_object")]
    pub config: Value,
    pub sort_key: String,
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

/// A database's schema (its title and icon are its page's).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    pub id: String,
    pub description: String,
    pub properties: Vec<SchemaItem>,
    pub views: Vec<SchemaItem>,
    pub automations: Vec<SchemaItem>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// The row's page id.
    pub id: String,
    pub db_id: String,
    pub sort_key: String,
    /// Assigned in order of creation (for "ID" properties like TASK-12).
    pub number: i64,
    /// Property id → value. Titles, tags and times come from the page.
    pub cells: Map<String, Value>,
    /// The first image in the row's page (a gallery card's picture).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// A template new rows can start from, not a row of its own.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub template: bool,
}

/// A row as the UI loads it: its values passed along as stored, unparsed
/// (loading every row at start-up is the biggest read the app makes).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedRow {
    pub id: String,
    pub db_id: String,
    pub sort_key: String,
    pub number: i64,
    pub cells: Box<RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub template: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewRow {
    pub title: String,
    pub icon: String,
    pub sort_key: String,
    pub cells: Map<String, Value>,
    /// Make a template rather than a row.
    pub template: bool,
    /// A template (or row) of the same database whose body and tags the new
    /// row starts with: making a row from a template, or a template from a row.
    pub from_template: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DatabaseInput {
    pub description: String,
    pub properties: Vec<SchemaItem>,
    pub views: Vec<SchemaItem>,
    pub automations: Vec<SchemaItem>,
    pub rows: Vec<NewRow>,
}

/// Values to set on a row (null clears one) and/or its new place in order.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowChange {
    pub id: String,
    #[serde(default)]
    pub cells: Option<Map<String, Value>>,
    #[serde(default)]
    pub sort_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRow {
    pub page: PageMeta,
    pub row: Row,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDatabase {
    pub page: PageMeta,
    pub database: Database,
    pub rows: Vec<CreatedRow>,
}

// ------------------------------------------------------------------ validation

/// Ids of properties, views and options: short, plain ASCII.
fn check_id(id: &str) -> Result<()> {
    if (1..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        Ok(())
    } else {
        fail("Unexpected id")
    }
}

/// Fractional order keys: letters and digits only.
fn check_key(key: &str) -> Result<()> {
    if (1..=255).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        fail("Unexpected order key")
    }
}

fn check_item(item: &SchemaItem, types: &[&str], what: &str) -> Result<()> {
    check_id(&item.id)?;
    check_key(&item.sort_key)?;
    if !types.contains(&item.kind.as_str()) {
        return fail(&format!("Unknown {what} type “{}”", item.kind));
    }
    if item.name.chars().count() > 200 {
        return fail("Names can be up to 200 characters");
    }
    if !item.config.is_object() || item.config.to_string().len() > 64 * 1024 {
        return fail("Settings are too large");
    }
    Ok(())
}

fn check_property(item: &SchemaItem) -> Result<()> {
    check_item(item, PROPERTY_TYPES, "property")?;
    // Exactly one title property, always with the same id.
    if (item.kind == "title") != (item.id == TITLE) {
        return fail("The title property can't be changed into another type");
    }
    Ok(())
}

fn check_cells(cells: &Map<String, Value>) -> Result<()> {
    for key in cells.keys() {
        check_id(key)?;
    }
    if serde_json::to_string(cells)?.len() > 256 * 1024 {
        return fail("This row holds too much to save");
    }
    Ok(())
}

fn parse_map(raw: &str) -> Map<String, Value> {
    match serde_json::from_str(raw) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// The tables a database's schema is kept in.
const SCHEMA_TABLES: &[&str] = &["db_properties", "db_views", "db_automations"];

// --------------------------------------------------------------------- reading

fn item_from(r: &rusqlite::Row) -> rusqlite::Result<(String, SchemaItem)> {
    Ok((
        r.get(0)?,
        SchemaItem {
            id: r.get(1)?,
            name: r.get(2)?,
            kind: r.get(3)?,
            config: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_else(|_| empty_object()),
            sort_key: r.get(5)?,
        },
    ))
}

/// Live properties or views, by database, in order.
fn items(conn: &Connection, table: &str, db_id: Option<&str>) -> Result<HashMap<String, Vec<SchemaItem>>> {
    let sql = format!(
        "SELECT db_id, id, name, type, config, sort_key FROM {table}
         WHERE deleted = 0 AND (?1 IS NULL OR db_id = ?1) ORDER BY db_id, sort_key, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut out: HashMap<String, Vec<SchemaItem>> = HashMap::new();
    for row in stmt.query_map([db_id], item_from)? {
        let (db, item) = row?;
        out.entry(db).or_default().push(item);
    }
    Ok(out)
}

fn database_by_id(conn: &Connection, id: &str) -> Result<Database> {
    let description: Option<String> = conn
        .query_row("SELECT description FROM databases WHERE page_id = ?1", [id], |r| r.get(0))
        .optional()?;
    let Some(description) = description else {
        return fail("Database not found");
    };
    Ok(Database {
        id: id.to_string(),
        description,
        properties: items(conn, "db_properties", Some(id))?.remove(id).unwrap_or_default(),
        views: items(conn, "db_views", Some(id))?.remove(id).unwrap_or_default(),
        automations: items(conn, "db_automations", Some(id))?.remove(id).unwrap_or_default(),
    })
}

const ROW_COLS: &str = "r.page_id, p.parent_id, r.sort_key, r.number, r.cells, r.cover, r.template";
const ROW_FROM: &str = "db_rows r JOIN pages p ON p.id = r.page_id";

/// A row as the UI lists it, its values passed through as stored.
fn listed_from(r: &rusqlite::Row) -> rusqlite::Result<ListedRow> {
    let cells: String = r.get(4)?;
    Ok(ListedRow {
        id: r.get(0)?,
        db_id: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
        sort_key: r.get(2)?,
        number: r.get(3)?,
        // Written by this module as a JSON object; anything else reads as empty.
        cells: RawValue::from_string(cells)
            .ok()
            .filter(|v| v.get().starts_with('{'))
            .unwrap_or_else(|| RawValue::from_string("{}".into()).expect("valid JSON")),
        cover: r.get(5)?,
        template: r.get(6)?,
    })
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        db_id: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
        sort_key: r.get(2)?,
        number: r.get(3)?,
        cells: parse_map(&r.get::<_, String>(4)?),
        cover: r.get(5)?,
        template: r.get(6)?,
    })
}

fn row_by_id(conn: &Connection, id: &str) -> Result<Row> {
    Ok(conn.query_row(&format!("SELECT {ROW_COLS} FROM {ROW_FROM} WHERE r.page_id = ?1"), [id], row_from)?)
}

/// After a page body was saved: a row keeps its first image (its gallery card's picture).
pub(crate) fn cover_changed(conn: &Connection, id: &str, content: &str) -> Result<()> {
    conn.execute("UPDATE db_rows SET cover = ?1 WHERE page_id = ?2", params![first_image(content), id])?;
    Ok(())
}

/// Every row's picture, worked out once (upgrading to a version that keeps them).
pub(crate) fn fill_covers(conn: &Connection) -> Result<()> {
    let found: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT r.page_id, c.content FROM db_rows r JOIN pages p ON p.id = r.page_id JOIN page_content c ON c.rid = p.rid
             WHERE c.content LIKE '%\"image\"%'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (id, content) in found {
        cover_changed(conn, &id, &content)?;
    }
    Ok(())
}

/// The source of the first image in a page body (editor JSON).
fn first_image(content: &str) -> Option<String> {
    if !content.contains("\"image\"") {
        return None;
    }
    fn walk(node: &Value) -> Option<String> {
        if node.get("type").and_then(Value::as_str) == Some("image") {
            return node.pointer("/attrs/src").and_then(Value::as_str).map(str::to_string);
        }
        node.get("content")?.as_array()?.iter().find_map(walk)
    }
    walk(&serde_json::from_str(content).ok()?)
}

/// Fails unless `id` is a database that isn't in the trash.
fn live_database(conn: &Connection, id: &str) -> Result<()> {
    let state: Option<(String, Option<i64>)> = conn
        .query_row("SELECT kind, deleted_at FROM pages WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match state {
        Some((kind, None)) if kind == "database" => Ok(()),
        Some((kind, Some(_))) if kind == "database" => fail("This database is in the trash"),
        _ => fail("Database not found"),
    }
}

// --------------------------------------------------------------------- writing

/// Inserts or replaces a property or view (bringing back a deleted one).
fn put_item(conn: &Connection, table: &str, db_id: &str, item: &SchemaItem) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO {table} (db_id, id, name, type, config, sort_key, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
             ON CONFLICT (db_id, id) DO UPDATE SET name = excluded.name, type = excluded.type,
               config = excluded.config, sort_key = excluded.sort_key, deleted = 0"
        ),
        params![db_id, item.id, item.name, item.kind, item.config.to_string(), item.sort_key],
    )?;
    Ok(())
}

fn next_number(conn: &Connection, db_id: &str) -> Result<i64> {
    Ok(conn.query_row("SELECT next_number FROM databases WHERE page_id = ?1", [db_id], |r| r.get(0))?)
}

fn insert_rows(tx: &Transaction, db_id: &str, rows: &[NewRow]) -> Result<Vec<CreatedRow>> {
    if rows.len() > MAX_BATCH {
        return fail("That's too many rows at once");
    }
    let mut number = next_number(tx, db_id)?;
    let mut out = Vec::with_capacity(rows.len());
    for new in rows {
        check_key(&new.sort_key)?;
        check_cells(&new.cells)?;
        let (content, text) = if new.from_template.is_empty() { Default::default() } else { template_body(tx, db_id, &new.from_template)? };
        let id = insert_page(tx, Some(db_id), &new.title, &new.icon, &content, &text)?;
        if !new.from_template.is_empty() {
            tx.execute("UPDATE pages SET tags = (SELECT tags FROM pages WHERE id = ?1) WHERE id = ?2", params![new.from_template, id])?;
        }
        let cover = first_image(&content);
        // Templates aren't counted (their number is never shown).
        let n = if new.template { 0 } else { number };
        tx.execute(
            "INSERT INTO db_rows (page_id, sort_key, number, cells, template, cover) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, new.sort_key, n, Value::Object(new.cells.clone()).to_string(), new.template, cover],
        )?;
        out.push(CreatedRow { page: meta_by_id(tx, &id)?, row: row_by_id(tx, &id)? });
        if !new.template {
            number += 1;
        }
    }
    tx.execute("UPDATE databases SET next_number = ?1 WHERE page_id = ?2", params![number, db_id])?;
    Ok(out)
}

/// The body of a template or row of `db_id`: its editor JSON and its
/// searchable text.
fn template_body(conn: &Connection, db_id: &str, id: &str) -> Result<(String, String)> {
    let found: Option<(String, String)> = conn
        .query_row(
            "SELECT c.content, coalesce(f.body, '') FROM db_rows r
               JOIN pages p ON p.id = r.page_id
               JOIN page_content c ON c.rid = p.rid
               LEFT JOIN pages_fts f ON f.rowid = p.rid
             WHERE r.page_id = ?1 AND p.parent_id = ?2",
            params![id, db_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match found {
        Some(body) => Ok(body),
        None => fail("That template no longer exists"),
    }
}

impl Db {
    /// Every database's schema (trashed ones too: the UI hides them).
    pub fn list_databases(&self) -> Result<Vec<Database>> {
        let conn = self.conn();
        let mut props = items(&conn, "db_properties", None)?;
        let mut views = items(&conn, "db_views", None)?;
        let mut automations = items(&conn, "db_automations", None)?;
        let mut stmt = conn.prepare("SELECT page_id, description FROM databases")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, description) = row?;
            out.push(Database {
                properties: props.remove(&id).unwrap_or_default(),
                views: views.remove(&id).unwrap_or_default(),
                automations: automations.remove(&id).unwrap_or_default(),
                id,
                description,
            });
        }
        Ok(out)
    }

    /// The rows of some databases (or of all of them), for the UI (see
    /// `ListedRow`). The UI reads a database's rows when it's first shown.
    pub fn list_rows_raw(&self, db_ids: Option<&[String]>) -> Result<Vec<ListedRow>> {
        let conn = self.reader();
        let ids: Vec<&str> = db_ids.unwrap_or_default().iter().map(String::as_str).collect();
        let filter = match db_ids {
            Some(_) => " WHERE p.parent_id IN (SELECT value FROM json_each(?1))".to_string(),
            None => String::new(),
        };
        let mut stmt = conn.prepare(&format!("SELECT {ROW_COLS} FROM {ROW_FROM}{filter}"))?;
        let params: Vec<String> = if db_ids.is_some() { vec![serde_json::to_string(&ids)?] } else { Vec::new() };
        let rows = stmt.query_map(rusqlite::params_from_iter(params), listed_from)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A database's first `limit` live rows in its own order: enough to draw
    /// a first screen of a big table while the rest are read.
    pub fn list_rows_head(&self, db_id: &str, limit: usize) -> Result<Vec<ListedRow>> {
        let conn = self.reader();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ROW_COLS} FROM {ROW_FROM}
             WHERE p.parent_id = ?1 AND p.deleted_at IS NULL AND r.template = 0
             ORDER BY r.sort_key, r.page_id LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![db_id, limit.min(1000) as i64], listed_from)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// How many live rows each database has (templates aside), without
    /// reading them: what the sidebar and title bar show before one is opened.
    pub fn row_counts(&self) -> Result<HashMap<String, usize>> {
        let conn = self.reader();
        let mut stmt = conn.prepare(&format!(
            "SELECT p.parent_id, count(*) FROM {ROW_FROM}
             WHERE p.deleted_at IS NULL AND r.template = 0 AND p.parent_id IS NOT NULL
             GROUP BY p.parent_id"
        ))?;
        let counts = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)))?;
        Ok(counts.collect::<rusqlite::Result<_>>()?)
    }

    /// Every row of every database, parsed (rows in the trash too: their pages say so).
    #[cfg(test)]
    pub fn list_rows(&self) -> Result<Vec<Row>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT {ROW_COLS} FROM {ROW_FROM}"))?;
        let rows = stmt.query_map([], row_from)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Makes a database page (inside `parent_id`, or at the top) with its
    /// schema and any first rows, all at once.
    pub fn create_database(
        &self,
        parent_id: Option<&str>,
        title: &str,
        icon: &str,
        input: DatabaseInput,
    ) -> Result<CreatedDatabase> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if let Some(pid) = parent_id {
            let alive: Option<Option<i64>> =
                tx.query_row("SELECT deleted_at FROM pages WHERE id = ?1", [pid], |r| r.get(0)).optional()?;
            if !matches!(alive, Some(None)) {
                return fail("Parent page no longer exists");
            }
            if is_database(&tx, pid)? {
                return fail("A database can't go inside another database");
            }
        }
        let mut properties = input.properties;
        if !properties.iter().any(|p| p.id == TITLE) {
            properties.insert(
                0,
                SchemaItem { id: TITLE.into(), name: "Name".into(), kind: "title".into(), config: empty_object(), sort_key: "a0".into() },
            );
        }
        let mut views = input.views;
        if views.is_empty() {
            views.push(SchemaItem {
                id: "table".into(),
                name: "Table".into(),
                kind: "table".into(),
                config: empty_object(),
                sort_key: "a0".into(),
            });
        }
        for p in &properties {
            check_property(p)?;
        }
        for v in &views {
            check_item(v, VIEW_TYPES, "view")?;
        }
        for a in &input.automations {
            check_item(a, AUTOMATION_TYPES, "automation")?;
        }

        let id = insert_page(&tx, parent_id, title, icon, "", "")?;
        tx.execute("UPDATE pages SET kind = 'database' WHERE id = ?1", [&id])?;
        place(&tx, &id, parent_id, None)?;
        tx.execute("INSERT INTO databases (page_id, description) VALUES (?1, ?2)", params![id, input.description])?;
        for p in &properties {
            put_item(&tx, "db_properties", &id, p)?;
        }
        for v in &views {
            put_item(&tx, "db_views", &id, v)?;
        }
        for a in &input.automations {
            put_item(&tx, "db_automations", &id, a)?;
        }
        let rows = insert_rows(&tx, &id, &input.rows)?;
        let created = CreatedDatabase { page: meta_by_id(&tx, &id)?, database: database_by_id(&tx, &id)?, rows };
        tx.commit()?;
        Ok(created)
    }

    pub fn update_database(&self, id: &str, description: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        live_database(&tx, id)?;
        tx.execute("UPDATE databases SET description = ?1 WHERE page_id = ?2", params![description, id])?;
        tx.commit()?;
        Ok(())
    }

    /// Adds or changes a property (or brings back a deleted one).
    pub fn save_property(&self, db_id: &str, property: SchemaItem) -> Result<()> {
        check_property(&property)?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        live_database(&tx, db_id)?;
        put_item(&tx, "db_properties", db_id, &property)?;
        tx.commit()?;
        Ok(())
    }

    /// Deletes a property. Its values stay with the rows, so it can come back.
    pub fn delete_property(&self, db_id: &str, id: &str) -> Result<()> {
        if id == TITLE {
            return fail("Every database keeps its title property");
        }
        self.tombstone("db_properties", db_id, id)
    }

    pub fn save_view(&self, db_id: &str, view: SchemaItem) -> Result<()> {
        check_item(&view, VIEW_TYPES, "view")?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        live_database(&tx, db_id)?;
        put_item(&tx, "db_views", db_id, &view)?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_view(&self, db_id: &str, id: &str) -> Result<()> {
        let left: i64 = self.conn().query_row(
            "SELECT count(*) FROM db_views WHERE db_id = ?1 AND deleted = 0 AND id != ?2",
            params![db_id, id],
            |r| r.get(0),
        )?;
        if left == 0 {
            return fail("A database needs at least one view");
        }
        self.tombstone("db_views", db_id, id)
    }

    /// Adds or changes an automation (or brings back a deleted one).
    pub fn save_automation(&self, db_id: &str, automation: SchemaItem) -> Result<()> {
        check_item(&automation, AUTOMATION_TYPES, "automation")?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        live_database(&tx, db_id)?;
        put_item(&tx, "db_automations", db_id, &automation)?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_automation(&self, db_id: &str, id: &str) -> Result<()> {
        self.tombstone("db_automations", db_id, id)
    }

    fn tombstone(&self, table: &str, db_id: &str, id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(&format!("UPDATE {table} SET deleted = 1 WHERE db_id = ?1 AND id = ?2"), params![db_id, id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn create_rows(&self, db_id: &str, rows: Vec<NewRow>) -> Result<Vec<CreatedRow>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        live_database(&tx, db_id)?;
        let out = insert_rows(&tx, db_id, &rows)?;
        tx.commit()?;
        Ok(out)
    }

    /// Sets values and/or order on rows. Returns the time, the rows' new
    /// "last edited" when values changed.
    pub fn update_rows(&self, changes: Vec<RowChange>) -> Result<i64> {
        if changes.len() > MAX_BATCH {
            return fail("That's too many rows at once");
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let ts = now();
        for change in changes {
            let found: Option<(String, String)> = tx
                .query_row("SELECT cells, sort_key FROM db_rows WHERE page_id = ?1", [&change.id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            // A row deleted for good in the meantime has nothing to update.
            let Some((cells_raw, mut sort_key)) = found else {
                continue;
            };
            let mut cells = parse_map(&cells_raw);
            let edited = change.cells.is_some();
            if let Some(patch) = change.cells {
                check_cells(&patch)?;
                for (key, value) in patch {
                    if value.is_null() {
                        cells.remove(&key);
                    } else {
                        cells.insert(key, value);
                    }
                }
            }
            if let Some(key) = change.sort_key {
                check_key(&key)?;
                sort_key = key;
            }
            tx.execute(
                "UPDATE db_rows SET cells = ?1, sort_key = ?2 WHERE page_id = ?3",
                params![Value::Object(cells).to_string(), sort_key, change.id],
            )?;
            if edited {
                tx.execute("UPDATE pages SET updated_at = ?1 WHERE id = ?2", params![ts, change.id])?;
            }
        }
        tx.commit()?;
        Ok(ts)
    }
}

/// After pages were copied (`map`: old id → new id): a copied database gets
/// its schema, and a copied row its values. Links between copied pages (a
/// relation to another copied row) point at the copies.
pub(crate) fn duplicated(tx: &Transaction, map: &HashMap<String, String>) -> Result<()> {
    for (old, new) in map {
        let found: Option<(String, i64)> = tx
            .query_row("SELECT description, next_number FROM databases WHERE page_id = ?1", [old], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((description, next)) = found else {
            continue;
        };
        tx.execute(
            "INSERT INTO databases (page_id, description, next_number) VALUES (?1, ?2, ?3)",
            params![new, description, next],
        )?;
        for table in SCHEMA_TABLES {
            for mut item in items(tx, table, Some(old))?.remove(old).unwrap_or_default() {
                item.config = serde_json::from_str(&replace_ids(&item.config.to_string(), map)).unwrap_or_else(|_| empty_object());
                put_item(tx, table, new, &item)?;
            }
        }
    }
    for (old, new) in map {
        /// Order key, number, values, database, template, picture.
        type Copied = (String, i64, String, Option<String>, bool, Option<String>);
        let found: Option<Copied> = tx
            .query_row(
                "SELECT r.sort_key, r.number, r.cells, p.parent_id, r.template, r.cover FROM db_rows r JOIN pages p ON p.id = r.page_id WHERE r.page_id = ?1",
                [old],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        let Some((sort_key, number, cells, parent, template, cover)) = found else {
            continue;
        };
        let db_id = parent.unwrap_or_default();
        // A row copied on its own goes right after the original and gets
        // the next number (a template isn't numbered); rows of a copied
        // database keep theirs.
        let after = |key: String| if key.len() < 255 { format!("{key}V") } else { key };
        let (sort_key, number) = if map.contains_key(&db_id) {
            (sort_key, number)
        } else if template {
            (after(sort_key), 0)
        } else {
            let n = next_number(tx, &db_id)?;
            tx.execute("UPDATE databases SET next_number = ?1 WHERE page_id = ?2", params![n + 1, db_id])?;
            (after(sort_key), n)
        };
        let cells = parse_map(&replace_ids(&cells, map));
        tx.execute(
            "INSERT INTO db_rows (page_id, sort_key, number, cells, template, cover) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![new, sort_key, number, Value::Object(cells).to_string(), template, cover],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDb;
    use crate::db::PagePatch;
    use serde_json::json;

    fn temp_db() -> TempDb {
        TempDb::new("td-db-test")
    }

    fn prop(id: &str, name: &str, kind: &str, key: &str, config: Value) -> SchemaItem {
        SchemaItem { id: id.into(), name: name.into(), kind: kind.into(), config, sort_key: key.into() }
    }

    fn new_row(title: &str, key: &str, cells: Value) -> NewRow {
        NewRow {
            title: title.into(),
            icon: String::new(),
            sort_key: key.into(),
            cells: cells.as_object().cloned().unwrap_or_default(),
            ..Default::default()
        }
    }

    fn reading_list(db: &Db) -> CreatedDatabase {
        db.create_database(
            None,
            "Reading list",
            "📚",
            DatabaseInput {
                description: "Books to read".into(),
                properties: vec![
                    prop("status", "Status", "status", "a1", json!({"options": [{"id": "todo", "name": "To read"}, {"id": "done", "name": "Read"}]})),
                    prop("pages", "Pages", "number", "a2", json!({})),
                ],
                views: vec![],
                automations: vec![],
                rows: vec![
                    new_row("Dune", "a0", json!({"status": "todo", "pages": 412})),
                    new_row("Emma", "a1", json!({"status": "done"})),
                ],
            },
        )
        .unwrap()
    }

    fn row(db: &Db, id: &str) -> Row {
        db.list_rows().unwrap().into_iter().find(|r| r.id == id).unwrap()
    }

    #[test]
    fn creates_schema_rows_and_edits() {
        let db = temp_db();
        let created = reading_list(&db);
        let id = created.page.id.clone();
        assert_eq!(created.page.kind, "database");
        let schema = &created.database;
        assert_eq!(schema.properties.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["title", "status", "pages"]);
        assert_eq!(schema.views.len(), 1, "a table view is added when none is given");
        assert_eq!(created.rows.len(), 2);
        assert_eq!(created.rows[0].row.number, 1);
        assert_eq!(created.rows[1].row.number, 2);
        assert_eq!(created.rows[0].page.parent_id.as_deref(), Some(id.as_str()));

        // Set one value, clear another, move the row.
        let dune = created.rows[0].page.id.clone();
        db.update_rows(vec![RowChange {
            id: dune.clone(),
            cells: Some(json!({"status": "done", "pages": null}).as_object().cloned().unwrap()),
            sort_key: Some("a2".into()),
        }])
        .unwrap();
        let r = row(&db, &dune);
        assert_eq!(r.cells.get("status"), Some(&json!("done")));
        assert!(!r.cells.contains_key("pages"));
        assert_eq!(r.sort_key, "a2");

        // More rows keep counting.
        let more = db.create_rows(&id, vec![new_row("Ulysses", "a3", json!({}))]).unwrap();
        assert_eq!(more[0].row.number, 3);

        // Properties: rename, delete (values kept), bring back.
        let mut pages = schema.properties[2].clone();
        pages.name = "Length".into();
        db.save_property(&id, pages.clone()).unwrap();
        db.delete_property(&id, "status").unwrap();
        let names = |db: &Db| {
            db.list_databases().unwrap()[0].properties.iter().map(|p| p.name.clone()).collect::<Vec<_>>()
        };
        assert_eq!(names(&db), vec!["Name", "Length"]);
        assert_eq!(row(&db, &dune).cells.get("status"), Some(&json!("done")), "values outlive a deleted property");
        db.save_property(&id, schema.properties[1].clone()).unwrap();
        assert_eq!(names(&db), vec!["Name", "Status", "Length"]);

        // Rules that keep a database whole.
        assert!(db.delete_property(&id, "title").is_err());
        assert!(db.save_property(&id, prop("x", "X", "title", "a5", json!({}))).is_err());
        assert!(db.save_property(&id, prop("y", "Y", "nonsense", "a5", json!({}))).is_err());
        assert!(db.save_property(&id, prop("bad id!", "Y", "text", "a5", json!({}))).is_err());
        let view = schema.views[0].id.clone();
        assert!(db.delete_view(&id, &view).is_err(), "the last view stays");
        db.save_view(&id, prop("board", "Board", "board", "a1", json!({"group": "status"}))).unwrap();
        db.delete_view(&id, &view).unwrap();
        assert_eq!(db.list_databases().unwrap()[0].views[0].id, "board");
        assert!(db.create_page(Some(&id), None, "Loose page", "").is_err(), "rows are made with create_rows");
        assert!(db.move_page(&dune, None, 0).is_err(), "rows stay in their database");

        db.update_database(&id, "All the books").unwrap();
        assert_eq!(db.list_databases().unwrap()[0].description, "All the books");
    }

    #[test]
    fn trash_restore_and_duplicate() {
        let db = temp_db();
        let created = reading_list(&db);
        let id = created.page.id.clone();
        let dune = created.rows[0].page.id.clone();
        let emma = created.rows[1].page.id.clone();
        // Emma links to Dune.
        db.save_property(&id, prop("rel", "Related", "relation", "a4", json!({ "database": id }))).unwrap();
        db.update_rows(vec![RowChange { id: emma.clone(), cells: Some(json!({ "rel": [dune] }).as_object().cloned().unwrap()), sort_key: None }])
            .unwrap();

        // A row trashed on its own, then the whole database: restoring the
        // row brings the database back too, with the rows trashed with it.
        db.trash_page(&dune).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        db.trash_page(&id).unwrap();
        let alive = |db: &Db, pid: &str| db.get_page(pid).unwrap().meta.deleted_at.is_none();
        assert!(!alive(&db, &emma));
        db.restore_page(&dune).unwrap();
        assert!(alive(&db, &id) && alive(&db, &emma) && alive(&db, &dune));
        assert_eq!(db.get_page(&dune).unwrap().meta.parent_id.as_deref(), Some(id.as_str()));

        // Copying the database copies schema and rows; links point at copies.
        let copy = db.duplicate_page(&id).unwrap();
        assert_eq!(copy.kind, "database");
        let schemas = db.list_databases().unwrap();
        let copied = schemas.iter().find(|d| d.id == copy.id).unwrap();
        assert_eq!(copied.properties.iter().find(|p| p.id == "rel").unwrap().config["database"], json!(copy.id));
        let rows: Vec<Row> = db.list_rows().unwrap().into_iter().filter(|r| r.db_id == copy.id).collect();
        assert_eq!(rows.len(), 2);
        let copied_emma = rows.iter().find(|r| r.cells.contains_key("rel")).unwrap();
        let target = copied_emma.cells["rel"][0].as_str().unwrap();
        assert!(rows.iter().any(|r| r.id == target), "the relation points into the copy");
        assert_eq!(copied_emma.number, 2);

        // Copying one row: same database, right after it, a new number.
        let dup = db.duplicate_page(&emma).unwrap();
        let r = row(&db, &dup.id);
        assert_eq!(r.db_id, id);
        assert_eq!(r.number, 3);
        assert_eq!(r.sort_key, format!("{}V", row(&db, &emma).sort_key));
        assert_eq!(r.cells["rel"], json!([dune]));

        // Deleting for good removes values with the pages.
        db.delete_page(&id).unwrap();
        assert!(db.list_rows().unwrap().iter().all(|r| r.db_id != id));
        assert!(db.list_databases().unwrap().iter().all(|d| d.id != id));
    }

    #[test]
    fn finds_the_first_image() {
        let body = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"image"}]},{"type":"callout","content":[{"type":"image","attrs":{"src":"http://tdfile.localhost/a.png"}}]},{"type":"image","attrs":{"src":"b.png"}}]}"#;
        assert_eq!(first_image(body).as_deref(), Some("http://tdfile.localhost/a.png"));
        assert_eq!(first_image(r#"{"type":"doc","content":[]}"#), None);
        assert_eq!(first_image("<p>old html</p>"), None);
    }

    #[test]
    fn templates_and_automations() {
        let db = temp_db();
        let created = reading_list(&db);
        let id = created.page.id.clone();

        // A template is a page with values, kept apart and not numbered.
        let made = db
            .create_rows(&id, vec![NewRow { template: true, ..new_row("Book report", "a5", json!({"status": "done"})) }])
            .unwrap();
        let tpl = made[0].row.clone();
        assert!(tpl.template);
        assert_eq!(tpl.number, 0);
        db.update_page(
            &tpl.id,
            PagePatch {
                content: Some(r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Summary"}]}]}"#.into()),
                text: Some("Summary".into()),
                ..Default::default()
            },
        )
        .unwrap();

        // A row made from it starts with its body, and takes the next number.
        let from = db
            .create_rows(&id, vec![NewRow { from_template: tpl.id.clone(), ..new_row("Book report", "a6", json!({"status": "done"})) }])
            .unwrap();
        let fresh = &from[0].row;
        assert!(!fresh.template);
        assert_eq!(fresh.number, 3);
        assert!(db.get_page(&fresh.id).unwrap().content.contains("Summary"));
        // A row can become a template the same way; a page from elsewhere can't.
        let saved = db
            .create_rows(&id, vec![NewRow { template: true, from_template: fresh.id.clone(), ..new_row("Report 2", "a7", json!({})) }])
            .unwrap();
        assert!(db.get_page(&saved[0].row.id).unwrap().content.contains("Summary"));
        let elsewhere = db.create_page(None, None, "", "").unwrap();
        assert!(db
            .create_rows(&id, vec![NewRow { from_template: elsewhere.id, ..new_row("x", "a8", json!({})) }])
            .is_err());

        // Duplicating a template makes another template.
        let copy = db.duplicate_page(&tpl.id).unwrap();
        assert!(row(&db, &copy.id).template);

        // Automations are part of the schema, and deleted as tombstones.
        let rule = prop("r1", "Finished date", "changed", "a0", json!({"prop": "status", "actions": []}));
        db.save_automation(&id, rule.clone()).unwrap();
        assert!(db.save_automation(&id, prop("r2", "x", "nonsense", "a1", json!({}))).is_err());
        assert_eq!(db.list_databases().unwrap()[0].automations, vec![rule.clone()]);

        db.delete_automation(&id, "r1").unwrap();
        assert!(db.list_databases().unwrap()[0].automations.is_empty());
    }

    #[test]
    fn listing_stays_lean() {
        let db = temp_db();
        let created = reading_list(&db);
        let id = created.page.id.clone();
        let dune = created.rows[0].row.id.clone();

        // The UI's listing passes values through as stored.
        let listed = db.list_rows_raw(None).unwrap();
        let raw: Value = serde_json::from_str(listed.iter().find(|r| r.id == dune).unwrap().cells.get()).unwrap();
        assert_eq!(raw, json!({"status": "todo", "pages": 412}));

        // One database's rows on their own, and counts without reading rows.
        let other = db.create_database(None, "Other", "", DatabaseInput { rows: vec![new_row("X", "a0", json!({}))], ..Default::default() }).unwrap();
        assert_eq!(db.list_rows_raw(Some(&[id.clone()])).unwrap().len(), 2);
        assert_eq!(db.list_rows_raw(Some(&[other.page.id.clone()])).unwrap().len(), 1);
        assert_eq!(db.list_rows_raw(Some(&[])).unwrap().len(), 0);
        assert_eq!(db.list_rows_raw(None).unwrap().len(), 3);
        let head = db.list_rows_head(&id, 1).unwrap();
        assert_eq!(head.iter().map(|r| r.sort_key.as_str()).collect::<Vec<_>>(), ["a0"], "the first rows, in order");
        let template = db.create_rows(&id, vec![NewRow { template: true, ..new_row("Weekly", "z0", json!({})) }]).unwrap();
        db.trash_page(&created.rows[1].row.id).unwrap();
        let counts = db.row_counts().unwrap();
        assert_eq!((counts[&id], counts[&other.page.id]), (1, 1), "templates and trashed rows aren't counted");
        db.restore_page(&created.rows[1].row.id).unwrap();
        db.trash_page(&template[0].row.id).unwrap();
        db.delete_page(&template[0].row.id).unwrap();

        // Trashing and restoring a row keeps it in its database.
        db.trash_page(&dune).unwrap();
        db.restore_page(&dune).unwrap();
        assert_eq!(db.list_rows().unwrap().iter().filter(|r| r.db_id == id).count(), 2);

        // A row can be deleted for good once it's in the trash.
        db.trash_page(&dune).unwrap();
        db.delete_page(&dune).unwrap();
        assert!(db.list_rows().unwrap().iter().all(|r| r.id != dune));
    }
}
