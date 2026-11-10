//! Proves copies converge: real `Db`s, changed only through the methods the app
//! calls, exchange records through a stand-in for the mailbox (same rules as the
//! real one: numbered items, one per key, refuse a stale `base`, all-or-nothing
//! pushes) at random moments. However they interleave, once everyone has caught
//! up they must hold the same notes and have nothing left to say.
//!
//! Page bodies aren't records, so they're not in the comparison (see docs/sync.md).

use super::records::{Incoming, Sent};
use crate::databases::{DatabaseInput, NewRow, RowChange, SchemaItem};
use crate::db::{Db, PagePatch, Table};
use crate::testutil::{TempDb, TempDir};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::ops::Deref;

/// A small seeded generator, so any failure can be replayed from its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        (!items.is_empty()).then(|| &items[self.below(items.len())])
    }
}

/// The mailbox, without the encryption: records stay readable, which is all the
/// difference there is as far as merging goes.
#[derive(Default)]
struct Mailbox {
    seq: i64,
    /// key -> (seq, record)
    items: BTreeMap<String, (i64, String)>,
}

impl Mailbox {
    /// All or nothing. A stale `base` anywhere refuses the whole push.
    fn push(&mut self, batch: &[(String, i64, String)]) -> Option<Vec<i64>> {
        for (key, base, _) in batch {
            if self.items.get(key).map_or(0, |(seq, _)| *seq) != *base {
                return None;
            }
        }
        let mut out = Vec::with_capacity(batch.len());
        for (key, _, record) in batch {
            self.seq += 1;
            self.items.insert(key.clone(), (self.seq, record.clone()));
            out.push(self.seq);
        }
        Some(out)
    }

    fn pull(&self, after: i64, limit: usize) -> (Vec<Incoming>, i64, bool) {
        let mut found: Vec<&(i64, String)> = self.items.values().filter(|(seq, _)| *seq > after).collect();
        found.sort_by_key(|(seq, _)| *seq);
        let more = found.len() > limit;
        let items: Vec<Incoming> =
            found.iter().take(limit).map(|(seq, record)| Incoming { seq: *seq, record: record.clone() }).collect();
        let cursor = items.last().map_or(after, |i| i.seq);
        (items, cursor, more)
    }
}

fn temp_db(name: &str) -> TempDb {
    TempDb::new(&format!("td-sync-{name}"))
}

fn replica(name: &str) -> TempDb {
    let db = temp_db(name);
    db.sync_enable().unwrap();
    db
}

fn pull(db: &Db, mail: &Mailbox, limit: usize) {
    loop {
        let (items, cursor, more) = mail.pull(db.sync_cursor().unwrap(), limit);
        db.sync_receive(&items, cursor).unwrap();
        if !more {
            break;
        }
    }
    let applied = db.sync_apply().unwrap();
    assert_eq!(applied.skipped, 0, "a real record was passed over");
}

/// Sends what's waiting. A refusal means someone else got there first: pull,
/// merge and try again, as the app will.
fn push(db: &Db, mail: &mut Mailbox, max_bytes: usize) {
    for _ in 0..50 {
        let out = db.sync_outgoing(max_bytes).unwrap();
        if out.is_empty() {
            return;
        }
        let batch: Vec<(String, i64, String)> =
            out.iter().map(|o| (format!("{}/{}", o.entity, o.id), o.base, o.record.clone())).collect();
        match mail.push(&batch) {
            Some(seqs) => {
                let sent: Vec<Sent> = out
                    .iter()
                    .zip(seqs)
                    .map(|(o, seq)| Sent { entity: o.entity.clone(), id: o.id.clone(), seq })
                    .collect();
                db.sync_sent(&sent).unwrap();
            }
            None => pull(db, mail, 500),
        }
    }
    panic!("a push never got through");
}

/// Everyone catches up until nobody has anything left to say.
fn settle<D: Deref<Target = Db>>(dbs: &[D], mail: &mut Mailbox) {
    for _ in 0..30 {
        for db in dbs {
            pull(db, mail, 500);
            push(db, mail, 256 * 1024);
        }
        let quiet = dbs.iter().all(|db| {
            pull(db, mail, 500);
            db.sync_outgoing(1).unwrap().is_empty() && db.sync_idle().unwrap()
        });
        if quiet {
            return;
        }
    }
    panic!("copies keep sending changes to each other");
}

/// What's meant to be the same everywhere. `rid` is local, and so is `position`,
/// except that listing siblings by it must give the same order.
fn dump(db: &Db) -> BTreeMap<String, Vec<String>> {
    let conn = db.conn();
    let mut out = BTreeMap::new();
    let mut query = |name: &str, sql: &str| {
        let mut stmt = conn.prepare(sql).unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        out.insert(name.to_string(), rows.collect::<rusqlite::Result<Vec<_>>>().unwrap());
    };
    query(
        "pages",
        "SELECT json_array(id, parent_id, title, icon, favorite, full_width, tags, kind, created_at, updated_at, deleted_at) FROM pages ORDER BY id",
    );
    query(
        "page order",
        "SELECT json_array(parent_id, group_concat(id)) FROM (SELECT id, parent_id FROM pages WHERE deleted_at IS NULL
           AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM pages WHERE kind = 'database')) ORDER BY parent_id, position, created_at)
         GROUP BY parent_id ORDER BY parent_id",
    );
    query("search titles", "SELECT json_array(p.id, f.title) FROM pages p JOIN pages_fts f ON f.rowid = p.rid ORDER BY p.id");
    query(
        "courses",
        "SELECT json_array(id, name, color, teacher, email, office_hours, room, page_id, weights, created_at) FROM courses ORDER BY id",
    );
    query("course order", "SELECT id FROM courses ORDER BY position, created_at");
    query(
        "assignments",
        "SELECT json_array(id, title, course_id, due_date, due_time, status, priority, notes, page_id, tags, source_uid, score, max_score, category, created_at, updated_at, completed_at, deleted_at) FROM assignments ORDER BY id",
    );
    query(
        "events",
        "SELECT json_array(id, title, start_date, start_time, end_date, end_time, color, course_id, location, notes, repeat, repeat_until, page_id, tags, exdates, source_uid, created_at, updated_at, deleted_at) FROM events ORDER BY id",
    );
    query("files", "SELECT json_array(id, name, stored, mime, size, tags, created_at, updated_at, deleted_at) FROM files ORDER BY id");
    query("attachments", "SELECT json_array(assignment_id, file_id, position) FROM attachments ORDER BY 1");
    query("occurrences", "SELECT json_array(event_id, date, page_id) FROM occurrence_pages ORDER BY 1");
    query("tags", "SELECT json_array(name, color, created_at) FROM tags ORDER BY name");
    query("reviews", "SELECT json_array(page_id, card_id, due, interval, ease, reps, lapses, reviewed_at) FROM card_reviews ORDER BY 1");
    query("databases", "SELECT json_array(page_id, description, next_number) FROM databases ORDER BY page_id");
    query("rows", "SELECT json_array(page_id, sort_key, number, template, cells) FROM db_rows ORDER BY page_id");
    for table in ["db_properties", "db_views", "db_automations"] {
        query(table, &format!("SELECT json_array(db_id, id, name, type, config, sort_key, deleted) FROM {table} ORDER BY db_id, id"));
    }
    out
}

fn assert_same<D: Deref<Target = Db>>(dbs: &[D], what: &str) {
    let first = dump(&dbs[0]);
    for (i, db) in dbs.iter().enumerate().skip(1) {
        let other = dump(db);
        for (table, rows) in &first {
            if rows != &other[table] {
                for (n, db) in dbs.iter().enumerate() {
                    let conn = db.conn();
                    let mut stmt = conn.prepare("SELECT entity, id, stamps, sort_key, gone, seq, unsent FROM sync_record").unwrap();
                    let lines = stmt.query_map([], |r| {
                        Ok(format!("{}/{} gone={:?} seq={} unsent={} key={:?} stamps={}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?, r.get::<_, Option<String>>(3)?, r.get::<_, String>(2)?))
                    }).unwrap();
                    for line in lines {
                        let line = line.unwrap();
                        if rows.iter().chain(other[table].iter()).any(|row| !(rows.contains(row) && other[table].contains(row)) && row.contains(line.split('/').nth(1).unwrap_or("?").split_whitespace().next().unwrap_or("?"))) {
                            eprintln!("copy {n}: {line}");
                        }
                    }
                }
            }
            assert_eq!(rows, &other[table], "{what}: copy {i} differs from copy 0 in {table}");
        }
    }
    for db in dbs {
        let conn = db.conn();
        let bad: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(bad, 0, "{what}: broken references");
        let cycles: i64 = conn
            .query_row(
                "WITH RECURSIVE up(start, id, depth) AS (
                   SELECT id, parent_id, 1 FROM pages WHERE parent_id IS NOT NULL
                   UNION ALL
                   SELECT up.start, p.parent_id, up.depth + 1 FROM up JOIN pages p ON p.id = up.id
                   WHERE p.parent_id IS NOT NULL AND up.depth < 500
                 )
                 SELECT COUNT(*) FROM up WHERE id = start",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cycles, 0, "{what}: a page is its own ancestor");
        let hidden: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pages c JOIN pages p ON c.parent_id = p.id WHERE c.deleted_at IS NULL AND p.deleted_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hidden, 0, "{what}: a live page is hidden under a trashed one");
    }
}

fn page_ids(db: &Db, live: bool) -> Vec<String> {
    db.list_pages().unwrap().into_iter().filter(|p| p.deleted_at.is_none() == live).map(|p| p.id).collect()
}

fn plain_page_ids(db: &Db) -> Vec<String> {
    let rows: std::collections::HashSet<String> = db.list_rows().unwrap().into_iter().map(|r| r.id).collect();
    db.list_pages()
        .unwrap()
        .into_iter()
        .filter(|p| p.deleted_at.is_none() && p.kind.is_empty() && !rows.contains(&p.id))
        .map(|p| p.id)
        .collect()
}

fn schema_item(id: &str, name: &str, kind: &str, key: &str) -> SchemaItem {
    SchemaItem { id: id.into(), name: name.into(), kind: kind.into(), config: json!({}), sort_key: key.into() }
}

fn new_row(title: &str, key: &str, cells: Value) -> NewRow {
    NewRow { title: title.into(), icon: String::new(), sort_key: key.into(), cells: cells.as_object().cloned().unwrap_or_default(), ..Default::default() }
}

/// Being refused is part of trying things at random ("that page no longer
/// exists"). A failed constraint never is: a person would see that as a bug.
fn tried<T>(result: crate::db::Result<T>) {
    if let Err(e) = result {
        for sign in ["constraint", "FOREIGN KEY", "no such", "syntax"] {
            assert!(!e.0.contains(sign), "an edit failed: {}", e.0);
        }
    }
}

/// One random thing a person could do, through the same calls the app makes.
fn random_edit(db: &Db, rng: &mut Rng, label: &str) {
    let word = format!("{label}{}", rng.below(1000));
    let pages = plain_page_ids(db);
    let any_page = rng.pick(&pages).cloned();
    match rng.below(29) {
        0 | 1 => {
            let parent = if rng.chance(50) { any_page.clone() } else { None };
            tried(db.create_page(parent.as_deref(), None, &word, ""));
        }
        2 | 3 => {
            if let Some(id) = &any_page {
                tried(db.update_page(id, PagePatch { title: Some(word), ..Default::default() }));
            }
        }
        4 => {
            if let Some(id) = &any_page {
                tried(db.update_page(id, PagePatch { icon: Some(word), favorite: Some(rng.chance(50)), full_width: Some(rng.chance(50)), ..Default::default() }));
            }
        }
        5 | 6 => {
            if let Some(id) = &any_page {
                let parent = if rng.chance(50) { rng.pick(&pages).cloned() } else { None };
                tried(db.move_page(id, parent.as_deref(), rng.below(5)));
            }
        }
        7 => {
            if let Some(id) = &any_page {
                tried(db.duplicate_page(id));
            }
        }
        8 => {
            if let Some(id) = &any_page {
                tried(db.trash_page(id));
            }
        }
        9 => {
            if let Some(id) = rng.pick(&page_ids(db, false)) {
                tried(db.restore_page(id));
            }
        }
        10 => {
            if let Some(id) = rng.pick(&page_ids(db, false)) {
                tried(db.delete_page(id));
            }
        }
        11 => {
            if rng.chance(20) {
                tried(db.empty_trash());
            }
        }
        12 => {
            let courses = db.list_courses().unwrap();
            if courses.len() < 6 {
                tried(db.create_course(&word, "blue"));
            } else if let Some(c) = rng.pick(&courses) {
                tried(db.delete_course(&c.id));
            }
        }
        13 => {
            let mut ids: Vec<String> = db.list_courses().unwrap().into_iter().map(|c| c.id).collect();
            if ids.len() > 1 {
                let i = rng.below(ids.len());
                let moved = ids.remove(i);
                ids.insert(rng.below(ids.len() + 1), moved);
                tried(db.reorder_courses(&ids));
            }
        }
        14 => {
            let course = rng.pick(&db.list_courses().unwrap()).map(|c| c.id.clone());
            let patch = json!({ "title": word, "courseId": course, "pageId": any_page });
            tried(db.create_assignment(serde_json::from_value(patch).unwrap()));
        }
        15 => {
            if let Some(a) = rng.pick(&db.list_assignments().unwrap()) {
                let patch = json!({ "title": word, "status": if rng.chance(50) { "done" } else { "todo" } });
                tried(db.update_assignment(&a.id, serde_json::from_value(patch).unwrap()));
            }
        }
        16 => {
            let patch = json!({ "title": word, "startDate": "2026-11-07", "endDate": "2026-11-07", "pageId": any_page });
            tried(db.create_event(serde_json::from_value(patch).unwrap()));
        }
        17 => {
            if let (Some(e), Some(p)) = (rng.pick(&db.list_events().unwrap()), &any_page) {
                tried(db.set_occurrence_page(&e.id, "2026-11-07", p));
            }
        }
        18 => {
            if let Some(a) = rng.pick(&db.list_assignments().unwrap()) {
                match rng.below(3) {
                    0 => {
                        tried(db.trash_item(Table::Assignments, &a.id));
                    }
                    1 => {
                        tried(db.restore_item(Table::Assignments, &a.id));
                    }
                    _ => {
                        tried(db.delete_item(Table::Assignments, &a.id));
                    }
                }
            }
        }
        19 => {
            if let Some(id) = &any_page {
                let tags = vec![format!("t{}", rng.below(4))];
                tried(db.set_item_tags(Table::Pages, id, &tags));
            }
        }
        20 => {
            let tag = format!("t{}", rng.below(4));
            if rng.chance(70) {
                tried(db.set_tag_color(&tag, "red"));
            } else {
                tried(db.rename_tag(&tag, Some(&format!("t{}", rng.below(4)))));
            }
        }
        21 => {
            let bytes = word.as_bytes().to_vec();
            if let Ok(file) = db.import_file(&bytes, &format!("{word}.txt"), "text/plain") {
                if let Some(a) = rng.pick(&db.list_assignments().unwrap()) {
                    let patch = json!({ "fileIds": [file.id] });
                    tried(db.update_assignment(&a.id, serde_json::from_value(patch).unwrap()));
                }
            }
        }
        22 => {
            if rng.chance(30) {
                let input = DatabaseInput {
                    description: word.clone(),
                    properties: vec![schema_item("status", "Status", "select", "a1")],
                    views: vec![],
                    automations: vec![],
                    rows: vec![new_row("First", "a0", json!({"status": "x"}))],
                };
                tried(db.create_database(None, &word, "", input));
            }
        }
        23 => {
            let dbs = db.list_databases().unwrap();
            if let Some(d) = rng.pick(&dbs) {
                let key = format!("a{}", rng.below(9));
                tried(db.create_rows(&d.id, vec![new_row(&word, &key, json!({"status": word}))]));
            }
        }
        24 => {
            let rows = db.list_rows().unwrap();
            if let Some(row) = rng.pick(&rows) {
                let cell = format!("p{}", rng.below(3));
                let value = if rng.chance(25) { Value::Null } else { json!(word) };
                tried(db.update_rows(vec![RowChange {
                    id: row.id.clone(),
                    cells: Some(json!({ cell: value }).as_object().cloned().unwrap()),
                    sort_key: None,
                }]));
            }
        }
        25 => {
            if let Some(id) = &any_page {
                let review = crate::cards::Review { due: "2026-11-08".into(), interval: rng.below(9) as i64, ease: 2.5, reps: 1, lapses: 0 };
                tried(db.save_review(id, &format!("card{}", rng.below(3)), &review));
            }
        }
        26 => {
            if let Some(id) = &any_page {
                if rng.chance(50) {
                    tried(db.forget_review(id, &format!("card{}", rng.below(3))));
                } else {
                    tried(db.reset_reviews(id));
                }
            }
        }
        27 => {
            let dbs = db.list_databases().unwrap();
            if let Some(d) = rng.pick(&dbs) {
                let id = format!("x{}", rng.below(2));
                if rng.chance(70) {
                    let rule = SchemaItem { id, name: word, kind: "set_property".into(), config: json!({}), sort_key: "a0".into() };
                    tried(db.save_automation(&d.id, rule));
                } else {
                    tried(db.delete_automation(&d.id, &id));
                }
            }
        }
        _ => {
            let dbs = db.list_databases().unwrap();
            if let Some(d) = rng.pick(&dbs) {
                let id = format!("p{}", rng.below(3));
                if rng.chance(70) {
                    tried(db.save_property(&d.id, schema_item(&id, &word, "text", "a2")));
                } else {
                    tried(db.delete_property(&d.id, &id));
                }
            }
        }
    }
}

fn run_seed(seed: u64, copies: usize, steps: usize) {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let dbs: Vec<TempDb> = (0..copies).map(|i| replica(&format!("s{seed}c{i}"))).collect();
    let mut mail = Mailbox::default();
    for step in 0..steps {
        let i = rng.below(copies);
        let label = ["a", "b", "c", "d"][i % 4];
        match rng.below(10) {
            0 => pull(&dbs[i], &mail, 1 + rng.below(50)),
            // A small limit splits a push into several, as a big one really is.
            1 => push(&dbs[i], &mut mail, 1 + rng.below(4000)),
            _ => random_edit(&dbs[i], &mut rng, label),
        }
        // Now and then everyone catches up mid-way, so later edits build on merged state.
        if step % 80 == 79 {
            settle(&dbs, &mut mail);
            assert_same(&dbs, &format!("seed {seed}, step {step}"));
        }
    }
    settle(&dbs, &mut mail);
    assert_same(&dbs, &format!("seed {seed}, end"));
    if std::env::var("TD_SYNC_SHOW").is_ok() {
        let counts: Vec<String> = dump(&dbs[0]).iter().map(|(table, rows)| format!("{table}={}", rows.len())).collect();
        let tombstones: i64 = dbs[0].conn().query_row("SELECT COUNT(*) FROM sync_record WHERE gone IS NOT NULL", [], |r| r.get(0)).unwrap();
        eprintln!("seed {seed}: {} gone={tombstones} mailbox={}", counts.join(" "), mail.seq);
    }
}

/// No mailbox at all: records reach each copy in any order, more than once, in
/// batches that split parents from children. They must still end up the same.
fn run_gossip(seed: u64, copies: usize, steps: usize) {
    let mut rng = Rng(seed.wrapping_mul(0xD6E8_FEB8_6659_FD93) | 1);
    let dbs: Vec<TempDb> = (0..copies).map(|i| replica(&format!("g{seed}c{i}"))).collect();
    let mut sent: Vec<String> = Vec::new();
    let collect = |db: &Db, sent: &mut Vec<String>| {
        let out = db.sync_outgoing(usize::MAX).unwrap();
        for o in &out {
            if !sent.contains(&o.record) {
                sent.push(o.record.clone());
            }
        }
        let marks: Vec<Sent> = out.iter().map(|o| Sent { entity: o.entity.clone(), id: o.id.clone(), seq: 1 }).collect();
        db.sync_sent(&marks).unwrap();
    };
    let deliver = |db: &Db, records: Vec<String>| {
        let items: Vec<Incoming> = records.into_iter().enumerate().map(|(i, record)| Incoming { seq: 1 + i as i64, record }).collect();
        db.sync_receive(&items, 0).unwrap();
        db.sync_apply().unwrap();
    };
    for _ in 0..steps {
        let i = rng.below(copies);
        match rng.below(10) {
            0 | 1 => collect(&dbs[i], &mut sent),
            2 | 3 if !sent.is_empty() => {
                // A random handful, out of order, some twice.
                let picks: Vec<String> = (0..1 + rng.below(12)).map(|_| sent[rng.below(sent.len())].clone()).collect();
                deliver(&dbs[i], picks);
            }
            _ => random_edit(&dbs[i], &mut rng, ["a", "b", "c", "d"][i % 4]),
        }
    }
    // Everything reaches everyone, in order this time, until there's nothing new.
    for _ in 0..40 {
        let known = sent.len();
        for db in &dbs {
            deliver(db, sent.clone());
            collect(db, &mut sent);
        }
        if sent.len() == known {
            assert_same(&dbs, &format!("gossip seed {seed}"));
            return;
        }
    }
    panic!("gossip seed {seed}: copies keep saying new things");
}

#[test]
fn records_in_any_order_converge() {
    let seeds: u64 = std::env::var("TD_SYNC_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(6);
    for seed in 1..=seeds {
        let copies = 2 + (seed % 2) as usize;
        let result = std::panic::catch_unwind(|| run_gossip(seed, copies, 200));
        if let Err(e) = result {
            eprintln!("failed at gossip seed {seed} ({copies} copies)");
            std::panic::resume_unwind(e);
        }
    }
}

#[test]
fn random_edits_converge() {
    let seeds: u64 = std::env::var("TD_SYNC_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(12);
    for seed in 1..=seeds {
        let copies = 2 + (seed % 2) as usize;
        let result = std::panic::catch_unwind(|| run_seed(seed, copies, 240));
        if let Err(e) = result {
            eprintln!("failed at seed {seed} ({copies} copies)");
            std::panic::resume_unwind(e);
        }
    }
}

// ------------------------------------------------------------- the rules, by name

fn two() -> (TempDb, TempDb, Mailbox) {
    (replica("a"), replica("b"), Mailbox::default())
}

fn page(db: &Db, title: &str) -> String {
    db.create_page(None, None, title, "").unwrap().id
}

fn title(db: &Db, id: &str) -> String {
    db.get_page(id).unwrap().meta.title
}

fn exchange(a: &Db, b: &Db, mail: &mut Mailbox) {
    settle(&[a], mail);
    settle(&[b], mail);
    settle(&[a], mail);
}

#[test]
fn cascades_work_while_what_they_touch_is_already_noted() {
    let db = replica("cascade");
    // The trigger on what a cascade changes has to cope with a note already there.
    let course = db.create_course("Biology", "blue").unwrap();
    let patch = json!({ "title": "Essay", "courseId": course.id });
    let assignment = db.create_assignment(serde_json::from_value(patch).unwrap()).unwrap();
    db.update_assignment(&assignment.id, serde_json::from_value(json!({ "title": "Essay 2" })).unwrap()).unwrap();
    db.delete_course(&course.id).unwrap();
    assert_eq!(db.list_assignments().unwrap()[0].course_id, None);

    let parent = page(&db, "Parent");
    let child = db.create_page(Some(&parent), None, "Child", "").unwrap().id;
    db.update_page(&child, PagePatch { title: Some("Child 2".into()), ..Default::default() }).unwrap();
    db.delete_page(&parent).unwrap();
    assert!(db.get_page(&child).is_err());
}

#[test]
fn siblings_never_share_a_position_after_a_restore() {
    let (a, b, mut mail) = two();
    let folder = page(&a, "Folder");
    let one = a.create_page(Some(&folder), None, "One", "").unwrap().id;
    let two = a.create_page(Some(&folder), None, "Two", "").unwrap().id;
    exchange(&a, &b, &mut mail);
    a.trash_page(&folder).unwrap();
    exchange(&a, &b, &mut mail);
    // The order changes while they're in the Trash, then they come back.
    b.restore_page(&folder).unwrap();
    b.move_page(&two, Some(&folder), 0).unwrap();
    exchange(&a, &b, &mut mail);
    for db in [&a, &b] {
        let mut kids = db.list_pages().unwrap();
        kids.retain(|p| p.parent_id.as_deref() == Some(folder.as_str()));
        kids.sort_by_key(|p| p.position);
        assert_eq!(kids.iter().map(|p| p.id.clone()).collect::<Vec<_>>(), [two.clone(), one.clone()]);
        assert_eq!(kids.iter().map(|p| p.position).collect::<Vec<_>>(), [0, 1]);
    }
}

#[test]
fn an_older_version_of_the_app_can_still_write_to_this_file() {
    // 0.8.3 doesn't refuse a newer file, and writes here on every database edit.
    let db = temp_db("older");
    db.conn().execute("INSERT INTO sync_outbox (entity, id, clock) VALUES ('row', 'x', 'y')", []).unwrap();
}

#[test]
fn the_vault_proof_is_what_the_relay_takes() {
    // The relay takes only the canonical spelling: 43 characters of base64url, no padding.
    let keys = super::crypto::VaultKeys::from_vault_key(&super::crypto::new_vault_key());
    let proof = super::crypto::vault_proof(&keys);
    let text = super::crypto::base64url(&proof);
    assert_eq!(text.len(), 43);
    assert!(text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{text}");
    assert_eq!(super::crypto::unbase64url(&text).as_deref(), Some(&proof[..]));
}

#[test]
fn applying_a_remote_change_sends_nothing_back() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Hello");
    exchange(&a, &b, &mut mail);
    let seq = mail.seq;
    a.update_page(&id, PagePatch { title: Some("Hi".into()), ..Default::default() }).unwrap();
    push(&a, &mut mail, 1 << 20);
    assert_eq!(mail.seq, seq + 1, "one edit is one record");
    pull(&b, &mail, 100);
    assert_eq!(title(&b, &id), "Hi");
    assert!(b.sync_outgoing(1 << 20).unwrap().is_empty(), "b has nothing to add");
    assert!(b.sync_idle().unwrap());
}

#[test]
fn a_rename_here_and_a_move_there_both_survive() {
    let (a, b, mut mail) = two();
    let folder = page(&a, "Folder");
    let id = page(&a, "Note");
    exchange(&a, &b, &mut mail);
    a.update_page(&id, PagePatch { title: Some("Renamed".into()), ..Default::default() }).unwrap();
    b.move_page(&id, Some(&folder), 0).unwrap();
    exchange(&a, &b, &mut mail);
    for db in [&a, &b] {
        let meta = db.get_page(&id).unwrap().meta;
        assert_eq!(meta.title, "Renamed");
        assert_eq!(meta.parent_id.as_deref(), Some(folder.as_str()));
    }
    assert_same(&[a, b], "rename and move");
}

#[test]
fn one_drag_is_one_change() {
    let (a, b, mut mail) = two();
    let ids: Vec<String> = (0..50).map(|i| page(&a, &format!("P{i}"))).collect();
    exchange(&a, &b, &mut mail);
    let seq = mail.seq;
    a.move_page(&ids[49], None, 0).unwrap();
    push(&a, &mut mail, 1 << 20);
    assert_eq!(mail.seq, seq + 1, "dragging the last page to the top rewrote 50 positions, and is one record");
    pull(&b, &mail, 100);
    assert_eq!(page_order(&b), page_order(&a));
}

fn page_order(db: &Db) -> Vec<String> {
    let mut pages = db.list_pages().unwrap();
    pages.retain(|p| p.parent_id.is_none() && p.deleted_at.is_none());
    pages.sort_by_key(|p| p.position);
    pages.into_iter().map(|p| p.id).collect()
}

#[test]
fn an_edit_beats_a_delete_and_lands_in_the_trash() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Keep me");
    exchange(&a, &b, &mut mail);
    a.trash_page(&id).unwrap();
    a.delete_page(&id).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.update_page(&id, PagePatch { title: Some("Edited".into()), ..Default::default() }).unwrap();
    exchange(&a, &b, &mut mail);
    for db in [&a, &b] {
        let meta = db.get_page(&id).unwrap().meta;
        assert_eq!(meta.title, "Edited");
        assert!(meta.deleted_at.is_some(), "it's in the Trash");
    }
    assert_same(&[a, b], "edit beats delete");
}

#[test]
fn a_later_delete_beats_an_earlier_edit() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Doomed");
    exchange(&a, &b, &mut mail);
    b.update_page(&id, PagePatch { title: Some("Edited".into()), ..Default::default() }).unwrap();
    push(&b, &mut mail, 1 << 20);
    std::thread::sleep(std::time::Duration::from_millis(5));
    a.delete_page(&id).unwrap();
    exchange(&a, &b, &mut mail);
    assert!(a.get_page(&id).is_err());
    assert!(b.get_page(&id).is_err());
    assert_same(&[a, b], "delete wins");
}

#[test]
fn a_deleted_folder_never_takes_a_new_page_with_it() {
    let (a, b, mut mail) = two();
    let folder = page(&a, "Folder");
    exchange(&a, &b, &mut mail);
    a.delete_page(&folder).unwrap();
    let new = b.create_page(Some(&folder), None, "New here", "").unwrap().id;
    exchange(&a, &b, &mut mail);
    for db in [&a, &b] {
        let meta = db.get_page(&new).unwrap().meta;
        assert_eq!(meta.title, "New here");
        assert_eq!(meta.parent_id, None);
        assert!(meta.deleted_at.is_none());
    }
    assert_same(&[a, b], "new page in a deleted folder");
}

#[test]
fn moves_that_make_a_cycle_are_repaired_the_same_everywhere() {
    let (a, b, mut mail) = two();
    let x = page(&a, "X");
    let y = page(&a, "Y");
    exchange(&a, &b, &mut mail);
    a.move_page(&x, Some(&y), 0).unwrap();
    b.move_page(&y, Some(&x), 0).unwrap();
    exchange(&a, &b, &mut mail);
    let smallest = x.clone().min(y.clone());
    for db in [&a, &b] {
        assert_eq!(db.get_page(&smallest).unwrap().meta.parent_id, None);
    }
    assert_same(&[a, b], "cycle");
}

#[test]
fn a_page_moved_under_a_trashed_one_stays_in_sight() {
    let (a, b, mut mail) = two();
    let folder = page(&a, "Folder");
    let id = page(&a, "Note");
    exchange(&a, &b, &mut mail);
    a.trash_page(&folder).unwrap();
    b.move_page(&id, Some(&folder), 0).unwrap();
    exchange(&a, &b, &mut mail);
    for db in [&a, &b] {
        let meta = db.get_page(&id).unwrap().meta;
        assert!(meta.deleted_at.is_none());
        assert_eq!(meta.parent_id, None);
    }
    assert_same(&[a, b], "moved under trashed");
}

#[test]
fn a_database_and_its_rows_arrive_whole() {
    let (a, b, mut mail) = two();
    let input = DatabaseInput {
        description: "Books".into(),
        properties: vec![schema_item("status", "Status", "select", "a1")],
        views: vec![],
        automations: vec![],
        rows: vec![new_row("Dune", "a0", json!({"status": "todo"})), new_row("Emma", "a1", json!({"status": "done"}))],
    };
    let made = a.create_database(None, "Reading", "", input).unwrap();
    exchange(&a, &b, &mut mail);
    assert_eq!(b.list_rows().unwrap().len(), 2);
    let rows: HashMap<String, Value> = b
        .list_rows()
        .unwrap()
        .into_iter()
        .map(|r| (r.id.clone(), Value::Object(r.cells)))
        .collect();
    assert!(rows.values().any(|c| c["status"] == "todo"));
    assert_eq!(b.list_databases().unwrap()[0].id, made.page.id);
    assert_same(&[a, b], "database");
}

#[test]
fn two_copies_making_rows_never_share_a_next_number() {
    let (a, b, mut mail) = two();
    let input = DatabaseInput {
        description: String::new(),
        properties: vec![],
        views: vec![],
        automations: vec![],
        rows: vec![],
    };
    let id = a.create_database(None, "Numbers", "", input).unwrap().page.id;
    exchange(&a, &b, &mut mail);
    a.create_rows(&id, vec![new_row("1", "a0", json!({}))]).unwrap();
    b.create_rows(&id, vec![new_row("2", "a1", json!({})), new_row("3", "a2", json!({})), new_row("4", "a3", json!({}))]).unwrap();
    exchange(&a, &b, &mut mail);
    let next = |db: &Db| -> i64 {
        db.conn().query_row("SELECT next_number FROM databases", [], |r| r.get(0)).unwrap()
    };
    assert_eq!(next(&a), next(&b));
    assert_eq!(next(&a), 4, "the larger of the two");
}

#[test]
fn turning_on_with_notes_keeps_both_sides_and_puts_mine_after() {
    let a = replica("a");
    let mut mail = Mailbox::default();
    let theirs = page(&a, "Theirs");
    settle(std::slice::from_ref(&a), &mut mail);

    // A second computer with its own notes joins: pull first, then its own go after.
    let b = temp_db("b");
    let mine = b.create_page(None, None, "Mine", "").unwrap().id;
    b.sync_enable().unwrap();
    pull(&b, &mail, 100);
    push(&b, &mut mail, 1 << 20);
    pull(&a, &mail, 100);
    assert_eq!(title(&a, &mine), "Mine");
    assert_eq!(title(&b, &theirs), "Theirs");
    let order = page_order(&b);
    let at = |id: &str| order.iter().position(|p| p == id).unwrap();
    assert!(at(&theirs) < at(&mine), "pages that came in go first");
    assert_eq!(page_order(&a), order);
}

#[test]
fn a_copied_notes_folder_merges_instead_of_doubling() {
    // The same ids on both sides: one was restored from a copy of the other.
    let a = temp_db("a");
    let id = page(&a, "Shared");
    let b_dir = TempDir::new("td-sync-copy");
    a.conn().execute("VACUUM INTO ?1", [b_dir.join("thoughtdesk.db").to_string_lossy().as_ref()]).unwrap();
    let b = Db::open(&b_dir).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.update_page(&id, PagePatch { title: Some("Newer on the copy".into()), ..Default::default() }).unwrap();

    let mut mail = Mailbox::default();
    a.sync_enable().unwrap();
    b.sync_enable().unwrap();
    settle(std::slice::from_ref(&a), &mut mail);
    settle(&[&b], &mut mail);
    settle(std::slice::from_ref(&a), &mut mail);
    assert_eq!(a.list_pages().unwrap().iter().filter(|p| p.id == id).count(), 1);
    assert_eq!(title(&a, &id), "Newer on the copy");
    assert_same(&[&*a, &b], "copied folder");
}

#[test]
fn turning_off_and_on_again_catches_up_with_what_changed_in_between() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Before");
    let gone = page(&a, "Deleted while off");
    let course = a.create_course("Biology", "blue").unwrap().id;
    exchange(&a, &b, &mut mail);
    b.sync_disable().unwrap();
    assert!(!b.sync_enabled().unwrap());
    // While B is off: B edits a page and deletes one, A renames the course.
    b.update_page(&id, PagePatch { title: Some("While off".into()), ..Default::default() }).unwrap();
    b.delete_page(&gone).unwrap();
    assert!(b.conn().query_row("SELECT COUNT(*) = 0 FROM sync_changed", [], |r| r.get::<_, bool>(0)).unwrap(), "nothing is tracked while off");
    std::thread::sleep(std::time::Duration::from_millis(5));
    a.update_course(&course, serde_json::from_value(json!({ "name": "Biology 101" })).unwrap()).unwrap();
    push(&a, &mut mail, 1 << 20);

    b.sync_enable().unwrap();
    exchange(&a, &b, &mut mail);
    assert_eq!(title(&a, &id), "While off", "B's edit while off goes up");
    assert!(a.get_page(&gone).is_err(), "and so does B's delete");
    let name = |db: &Db| db.list_courses().unwrap().into_iter().find(|c| c.id == course).unwrap().name;
    assert_eq!(name(&b), "Biology 101", "what B didn't touch while off loses to the newer edit elsewhere");
    assert_same(&[a, b], "off and on");
}

/// Puts a record in the mailbox as some other copy would, bypassing the checks.
fn plant(mail: &mut Mailbox, key: &str, record: &str) {
    mail.seq += 1;
    mail.items.insert(key.to_string(), (mail.seq, record.to_string()));
}

/// A pull that may pass records over; how many it did.
fn pull_skipping(db: &Db, mail: &Mailbox) -> usize {
    let (items, cursor, _) = mail.pull(db.sync_cursor().unwrap(), 10_000);
    db.sync_receive(&items, cursor).unwrap();
    db.sync_apply().unwrap().skipped
}

fn stamp_now() -> String {
    format!("{:013}-0000-ffffffff", crate::db::now() + 1)
}

#[test]
fn a_record_passed_over_keeps_its_number_so_later_pushes_get_through() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Fine");
    exchange(&a, &b, &mut mail);
    // Another copy sends a version of it this one can't write (a title can't be NULL).
    let bad = format!(r#"{{"e":"page","id":"{id}","f":{{"title":[null,"{}"]}}}}"#, stamp_now());
    plant(&mut mail, &format!("page/{id}"), &bad);
    assert_eq!(pull_skipping(&b, &mail), 1);
    let kept: i64 = b.conn().query_row("SELECT count(*) FROM sync_quarantine", [], |r| r.get(0)).unwrap();
    assert_eq!(kept, 1, "it's kept for a later version");
    // Before, B's next push of it was refused for an old base, for ever.
    b.update_page(&id, PagePatch { title: Some("Edited on B".into()), ..Default::default() }).unwrap();
    push(&b, &mut mail, 1 << 20);
    pull(&a, &mail, 100);
    assert_eq!(title(&a, &id), "Edited on B");
}

#[test]
fn one_copy_failing_to_merge_a_database_deletes_nothing_elsewhere() {
    let (a, b, mut mail) = two();
    let input = DatabaseInput {
        description: String::new(),
        properties: vec![schema_item("status", "Status", "select", "a1")],
        views: vec![],
        automations: vec![],
        rows: vec![],
    };
    let db_id = a.create_database(None, "Books", "", input).unwrap().page.id;
    push(&a, &mut mail, 1 << 20);
    // B gets the database's page in a form it can't write, and its property as it is.
    let bad = format!(r#"{{"e":"page","id":"{db_id}","f":{{"title":[null,"{}"]}}}}"#, stamp_now());
    plant(&mut mail, &format!("page/{db_id}"), &bad);
    pull_skipping(&b, &mail);
    settle(std::slice::from_ref(&b), &mut mail);
    let tombstones = mail.items.values().filter(|(_, r)| r.contains(r#""gone""#)).count();
    assert_eq!(tombstones, 0, "B's gap became nobody's delete");
    // A pulls the version it can't write too, and keeps its own.
    pull_skipping(&a, &mail);
    let props = |db: &Db| db.list_databases().unwrap().into_iter().find(|d| d.id == db_id).map_or(0, |d| d.properties.len());
    let all = props(&a);
    assert!(all > 0, "A still has its properties");

    // The database comes again, writable: B shows its property too.
    a.update_page(&db_id, PagePatch { title: Some("Books again".into()), ..Default::default() }).unwrap();
    exchange(&a, &b, &mut mail);
    assert_eq!(props(&b), all, "B shows them too");
    assert_same(&[a, b], "gap healed");
}

#[test]
fn writes_made_without_sync_are_noticed_by_the_audit() {
    let dir = TempDir::new("td-sync-audit");
    let a = Db::open(&dir).unwrap();
    a.sync_enable().unwrap();
    let b = replica("audit-b");
    let mut mail = Mailbox::default();
    let edited = page(&a, "Before");
    let removed = page(&a, "Removed elsewhere");
    exchange(&a, &b, &mut mail);
    // An older version of the app, or another tool: no triggers on its connection.
    {
        let other = rusqlite::Connection::open(dir.join("thoughtdesk.db")).unwrap();
        other.execute("PRAGMA foreign_keys = ON", []).unwrap();
        other.execute("UPDATE pages SET title = 'Edited elsewhere' WHERE id = ?1", [&edited]).unwrap();
        other.execute("DELETE FROM pages WHERE id = ?1", [&removed]).unwrap();
    }
    assert!(a.sync_outgoing(1 << 20).unwrap().is_empty(), "nothing noticed it");
    assert_eq!(a.sync_audit().unwrap(), 2);
    exchange(&a, &b, &mut mail);
    assert_eq!(title(&b, &edited), "Edited elsewhere");
    assert!(b.get_page(&removed).is_err());
    assert_eq!(a.sync_audit().unwrap(), 0, "and once caught up, nothing is left");
}

#[test]
fn a_body_written_without_sync_is_noticed_by_the_audit() {
    let dir = TempDir::new("td-sync-body");
    let db = Db::open(&dir).unwrap();
    db.sync_enable().unwrap();
    let id = page(&db, "Text");
    let read = db.sync_text_read(&id).unwrap();
    let commit = crate::sync::text::TextCommit { page_id: id.clone(), base: Some(read.content), state: "AAA".into(), ..Default::default() };
    assert!(db.sync_text_commit(&commit).unwrap());
    // (The welcome page has never been seeded, so it's listed anyway.)
    let listed = |db: &Db| db.sync_text_todo().unwrap().bodies.contains(&id);
    assert!(!listed(&db));
    {
        let other = rusqlite::Connection::open(dir.join("thoughtdesk.db")).unwrap();
        other
            .execute("UPDATE page_content SET content = '{\"type\":\"doc\"}' WHERE rid = (SELECT rid FROM pages WHERE id = ?1)", [&id])
            .unwrap();
    }
    assert!(!listed(&db), "nothing noticed it");
    db.sync_audit().unwrap();
    assert!(listed(&db));
}

#[test]
fn a_value_of_the_wrong_type_is_passed_over_and_the_rest_goes_on() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Fine");
    push(&a, &mut mail, 1 << 20);
    let now = stamp_now();
    // Text where a time goes would break listing pages; an assignment's priority is a number.
    let page_bad = format!(
        r#"{{"e":"page","id":"5d0c3b0e-0d0a-4c6e-9d77-1b7d0f2c9a11","f":{{"title":["x","{now}"],"created_at":["yesterday","{now}"],"updated_at":[1,"{now}"]}}}}"#
    );
    plant(&mut mail, "page/bad", &page_bad);
    let assignment_bad = format!(r#"{{"e":"assignment","id":"a1","f":{{"title":["x","{now}"],"priority":["high","{now}"]}}}}"#);
    plant(&mut mail, "assignment/a1", &assignment_bad);
    assert_eq!(pull_skipping(&b, &mail), 2);
    assert_eq!(title(&b, &id), "Fine");
    assert!(b.list_pages().is_ok(), "listing pages still works");
    assert!(b.list_assignments().unwrap().is_empty());
}

#[test]
fn stamps_of_the_wrong_shape_are_refused_and_the_clock_never_passes_13_digits() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Fine");
    exchange(&a, &b, &mut mail);
    for stamp in ["~", "99999999999999-0000-aa", "1794000000000-00-aa", "1794000000000-0000-ZZ", ""] {
        let rec = format!(r#"{{"e":"page","id":"{id}","f":{{"title":["Pinned","{stamp}"]}}}}"#);
        plant(&mut mail, &format!("page/{id}"), &rec);
        assert_eq!(pull_skipping(&b, &mail), 1, "{stamp:?}");
    }
    assert_eq!(title(&b, &id), "Fine");
    // A clock at the very end of 13 digits stays there rather than rolling over.
    let conn = b.conn();
    conn.execute("UPDATE sync_meta SET value = '9999999999999-9999-aa' WHERE key = 'clock'", []).unwrap();
    let next = super::tick(&conn).unwrap();
    assert!(super::records::valid_stamp(&next) && next.starts_with("9999999999999-"), "{next}");
}

#[test]
fn a_big_delete_split_across_pushes_never_comes_back_as_trash() {
    let (a, b, mut mail) = two();
    let folder = page(&a, "Folder");
    let kids: Vec<String> = (0..30).map(|i| a.create_page(Some(&folder), None, &format!("Kid {i}"), "").unwrap().id).collect();
    exchange(&a, &b, &mut mail);
    a.trash_page(&folder).unwrap();
    a.delete_page(&folder).unwrap();
    // The tombstones go up a few at a time, and B pulls in between.
    for _ in 0..40 {
        let out = a.sync_outgoing(400).unwrap();
        if out.is_empty() {
            break;
        }
        let batch: Vec<(String, i64, String)> = out.iter().map(|o| (format!("{}/{}", o.entity, o.id), o.base, o.record.clone())).collect();
        let seqs = mail.push(&batch).expect("nothing else is pushing");
        let sent: Vec<Sent> = out.iter().zip(seqs).map(|(o, seq)| Sent { entity: o.entity.clone(), id: o.id.clone(), seq }).collect();
        a.sync_sent(&sent).unwrap();
        pull(&b, &mail, 100);
    }
    exchange(&a, &b, &mut mail);
    for db in [&a, &b] {
        assert!(db.get_page(&folder).is_err());
        let left = kids.iter().filter(|k| db.get_page(k).is_ok()).count();
        assert_eq!(left, 0, "no sub-page came back");
    }
    assert_same(&[a, b], "big delete");
}

#[test]
fn a_database_brought_back_by_an_edit_keeps_its_schema_and_rows() {
    let (a, b, mut mail) = two();
    let input = DatabaseInput {
        description: String::new(),
        properties: vec![schema_item("status", "Status", "select", "a1")],
        views: vec![],
        automations: vec![],
        rows: vec![new_row("Dune", "a0", json!({"status": "todo"}))],
    };
    let made = a.create_database(None, "Books", "", input).unwrap();
    let db_id = made.page.id.clone();
    let properties = made.database.properties.len();
    exchange(&a, &b, &mut mail);
    a.trash_page(&db_id).unwrap();
    a.delete_page(&db_id).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.update_page(&db_id, PagePatch { title: Some("Books, renamed".into()), ..Default::default() }).unwrap();
    exchange(&a, &b, &mut mail);
    for db in [&a, &b] {
        let meta = db.get_page(&db_id).unwrap().meta;
        assert_eq!(meta.title, "Books, renamed");
        assert!(meta.deleted_at.is_some(), "in the Trash");
        let found = db.list_databases().unwrap().into_iter().find(|d| d.id == db_id).expect("still a database");
        assert_eq!(found.properties.len(), properties, "with its properties");
        assert_eq!(db.list_rows().unwrap().iter().filter(|r| r.db_id == db_id).count(), 1, "and its row");
    }
    assert_same(&[a, b], "database back");
}

#[test]
fn fields_from_a_newer_version_survive_an_older_copy() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Fine");
    exchange(&a, &b, &mut mail);
    // A newer version adds a field this one doesn't know.
    let now = stamp_now();
    let rec = format!(r#"{{"e":"page","id":"{id}","f":{{"title":["Fine","{now}"],"future_thing":[{{"a":1}},"{now}"]}}}}"#);
    plant(&mut mail, &format!("page/{id}"), &rec);
    assert_eq!(pull_skipping(&b, &mail), 0);
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.update_page(&id, PagePatch { title: Some("Edited on the older one".into()), ..Default::default() }).unwrap();
    push(&b, &mut mail, 1 << 20);
    let (_, sent) = &mail.items[&format!("page/{id}")];
    assert!(sent.contains("future_thing") && sent.contains("Edited on the older one"), "{sent}");
}

#[test]
fn a_delete_after_a_lost_answer_still_reaches_the_mailbox() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Short-lived");
    // Sent, but the answer never came back: this copy doesn't know its number.
    let out = a.sync_outgoing(1 << 20).unwrap();
    let batch: Vec<(String, i64, String)> = out.iter().map(|o| (format!("{}/{}", o.entity, o.id), o.base, o.record.clone())).collect();
    mail.push(&batch).unwrap();
    a.delete_page(&id).unwrap();
    exchange(&a, &b, &mut mail);
    assert!(a.get_page(&id).is_err());
    assert!(b.get_page(&id).is_err(), "it didn't come back from the mailbox");
}

#[test]
fn a_record_that_makes_no_sense_holds_nothing_up() {
    let (a, b, mut mail) = two();
    let id = page(&a, "Fine");
    push(&a, &mut mail, 1 << 20);
    mail.seq += 1;
    let bad = [
        r#"{"e":"nonsense","id":"x","f":{}}"#,
        r#"{"e":"assignment","id":"y","f":{"due_date":["2026-01-01","0000000000001-0000-aa"]}}"#,
        r#"{"e":"attachment","id":"no-slash","f":{"position":[1,"0000000000001-0000-aa"]}}"#,
        r#"{"e":"page","id":"z","f":{"title; DROP TABLE pages":["x","0000000000001-0000-aa"]}}"#,
        "not json at all",
    ];
    let items: Vec<Incoming> = bad.iter().enumerate().map(|(i, r)| Incoming { seq: 1000 + i as i64, record: r.to_string() }).collect();
    b.sync_receive(&items, 0).unwrap();
    assert_eq!(b.sync_apply().unwrap().skipped, 3, "the assignment with no dates, the id with no slash, and what isn't JSON");
    pull(&b, &mail, 100);
    assert_eq!(title(&b, &id), "Fine");
}

#[test]
fn nothing_runs_while_sync_is_off() {
    let db = temp_db("off");
    let id = page(&db, "Quiet");
    db.update_page(&id, PagePatch { title: Some("Still quiet".into()), ..Default::default() }).unwrap();
    let conn = db.conn();
    let tracked: i64 = conn
        .query_row("SELECT (SELECT COUNT(*) FROM sync_changed) + (SELECT COUNT(*) FROM sync_record)", [], |r| r.get(0))
        .unwrap();
    let triggers: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'trigger'", [], |r| r.get(0)).unwrap();
    assert_eq!((tracked, triggers), (0, 0));
}

#[test]
fn triggers_come_back_when_the_database_reopens() {
    let dir = TempDir::new("td-sync-reopen");
    let db = Db::open(&dir).unwrap();
    db.sync_enable().unwrap();
    drop(db);
    let db = Db::open(&dir).unwrap();
    assert!(db.sync_enabled().unwrap());
    let before = db.sync_outgoing(1 << 20).unwrap();
    db.sync_sent(&before.iter().map(|o| Sent { entity: o.entity.clone(), id: o.id.clone(), seq: 1 }).collect::<Vec<_>>()).unwrap();
    page(&db, "After reopening");
    assert_eq!(db.sync_outgoing(1 << 20).unwrap().len(), 1);
}
