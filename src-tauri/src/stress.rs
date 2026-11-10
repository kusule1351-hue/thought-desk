//! Heavy-use benchmark: builds a workspace the size of years of daily notes
//! and times every storage call the UI makes. Not part of the normal test run:
//!
//!   cargo test --release stress -- --ignored --nocapture
//!
//! Set TD_STRESS_DIR to keep the generated workspace (point the app at it
//! with THOUGHTDESK_DATA_DIR to try the UI against it).

use crate::db::{Db, PagePatch, Table};
use crate::planner::{AssignmentPatch, EventPatch};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const WORDS: &[&str] = &[
    "the", "cell", "membrane", "energy", "photosynthesis", "lecture", "notes", "chapter", "review", "theory",
    "equation", "history", "market", "design", "system", "process", "analysis", "results", "method", "data",
    "question", "answer", "summary", "example", "project", "meeting", "budget", "planning", "essay", "draft",
    "chemistry", "biology", "physics", "calculus", "algebra", "vector", "matrix", "function", "variable", "proof",
    "and", "of", "to", "in", "is", "for", "with", "on", "that", "this", "from", "by", "as", "at", "an", "be",
    "mitochondria", "enzyme", "protein", "molecule", "reaction", "osmosis", "gradient", "voltage", "current", "wave",
];

/// Small deterministic generator, so every run builds the same workspace.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
    fn sentence(&mut self, words: usize) -> String {
        let mut s = String::new();
        for i in 0..words {
            if i > 0 {
                s.push(' ');
            }
            s.push_str(WORDS[self.below(WORDS.len())]);
        }
        s
    }
}

fn text(t: String) -> Value {
    json!({ "type": "text", "text": t })
}

/// A page body: headings and paragraphs, sometimes to-dos, flashcards,
/// links to other pages and images or files from the library.
fn page_doc(rng: &mut Rng, paragraphs: usize, links: &[String], files: &[(String, String)]) -> (String, String) {
    let mut blocks = Vec::new();
    let mut plain = String::new();
    for i in 0..paragraphs {
        if i % 6 == 0 {
            let t = rng.sentence(4);
            plain.push_str(&t);
            plain.push('\n');
            blocks.push(json!({ "type": "heading", "attrs": { "level": 2 }, "content": [text(t)] }));
        }
        let n = 20 + rng.below(60);
        let t = rng.sentence(n);
        plain.push_str(&t);
        plain.push('\n');
        let mut inline = vec![text(t)];
        if !links.is_empty() && rng.chance(15) {
            inline.push(json!({ "type": "mention", "attrs": { "id": links[rng.below(links.len())], "kind": "page" } }));
        }
        blocks.push(json!({ "type": "paragraph", "content": inline }));
    }
    if rng.chance(30) {
        let items: Vec<Value> = (0..5 + rng.below(15))
            .map(|_| {
                json!({ "type": "taskItem", "attrs": { "checked": rng.chance(50) },
                        "content": [{ "type": "paragraph", "content": [text(rng.sentence(6))] }] })
            })
            .collect();
        blocks.push(json!({ "type": "taskList", "content": items }));
    }
    if rng.chance(10) {
        for _ in 0..10 + rng.below(40) {
            blocks.push(card(rng));
        }
    }
    if !files.is_empty() && rng.chance(10) {
        let (id, stored) = &files[rng.below(files.len())];
        if rng.chance(50) {
            blocks.push(json!({ "type": "image", "attrs": { "src": format!("http://tdfile.localhost/{stored}"), "alt": "" } }));
        } else {
            blocks.push(json!({ "type": "fileBlock", "attrs": { "id": id } }));
        }
    }
    (json!({ "type": "doc", "content": blocks }).to_string(), plain)
}

fn card(rng: &mut Rng) -> Value {
    json!({ "type": "flashcard", "attrs": { "id": format!("c{}", rng.next()) },
            "content": [{ "type": "flashcardFront", "content": [text(rng.sentence(5))] },
                        { "type": "flashcardBack", "content": [text(rng.sentence(12))] }] })
}

pub struct Workspace {
    pub db: Db,
    pub pages: Vec<String>,
    pub big_page: String,
    pub branch: String,
}

/// ~5,000 pages (three levels deep, plus one 40-level chain), 2,000 files,
/// 1,500 assignments, 1,500 events, 600 trashed pages and three monster
/// pages (a long book, 2,000 to-dos, 1,000 flashcards).
pub fn build(dir: PathBuf) -> Workspace {
    let _ = std::fs::remove_dir_all(&dir);
    let db = Db::open(&dir).expect("open");
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);

    let mut files = Vec::new();
    for i in 0..2000 {
        let f = db.import_file(format!("file {i}").as_bytes(), &format!("Scan {i}.png"), "").unwrap();
        files.push((f.id, f.stored));
    }

    let mut pages: Vec<String> = Vec::new();
    let add = |db: &Db, parent: Option<&str>, rng: &mut Rng, pages: &mut Vec<String>, size: usize| -> String {
        let meta = db.create_page(parent, None, &rng.sentence(3), "").unwrap();
        let (content, plain) = page_doc(rng, size, pages, &files);
        db.update_page(&meta.id, PagePatch { content: Some(content), text: Some(plain), ..Default::default() })
            .unwrap();
        pages.push(meta.id.clone());
        meta.id
    };
    let mut branch = String::new();
    for top in 0..40 {
        let a = add(&db, None, &mut rng, &mut pages, 4);
        if top == 0 {
            branch = a.clone();
        }
        for _ in 0..10 {
            let b = add(&db, Some(&a), &mut rng, &mut pages, 8);
            for _ in 0..12 {
                let size = 6 + rng.below(30);
                add(&db, Some(&b), &mut rng, &mut pages, size);
            }
        }
    }
    let mut parent = add(&db, None, &mut rng, &mut pages, 2);
    for _ in 0..40 {
        parent = add(&db, Some(&parent), &mut rng, &mut pages, 2);
    }

    // Monster pages.
    let big_page = add(&db, None, &mut rng, &mut pages, 5000);
    let todo_page = db.create_page(None, None, "Every to-do", "").unwrap();
    let items: Vec<Value> = (0..2000)
        .map(|_| {
            json!({ "type": "taskItem", "attrs": { "checked": false },
                    "content": [{ "type": "paragraph", "content": [text(rng.sentence(6))] }] })
        })
        .collect();
    let doc = json!({ "type": "doc", "content": [{ "type": "taskList", "content": items }] });
    db.update_page(&todo_page.id, PagePatch { content: Some(doc.to_string()), ..Default::default() }).unwrap();
    let deck = db.create_page(None, None, "Huge deck", "").unwrap();
    let doc = json!({ "type": "doc", "content": (0..1000).map(|_| card(&mut rng)).collect::<Vec<_>>() });
    db.update_page(&deck.id, PagePatch { content: Some(doc.to_string()), ..Default::default() }).unwrap();

    // A trashed corner of the tree.
    for _ in 0..50 {
        let a = add(&db, None, &mut rng, &mut pages, 6);
        for _ in 0..11 {
            add(&db, Some(&a), &mut rng, &mut pages, 6);
        }
        db.trash_page(&a).unwrap();
    }

    for i in 0..1500 {
        let day = format!("2026-{:02}-{:02}", 1 + i % 12, 1 + i % 28);
        let p: AssignmentPatch =
            serde_json::from_value(json!({ "title": rng.sentence(4), "dueDate": day, "notes": rng.sentence(30) })).unwrap();
        db.create_assignment(p).unwrap();
        let e: EventPatch =
            serde_json::from_value(json!({ "title": rng.sentence(3), "startDate": day, "startTime": "09:00" })).unwrap();
        db.create_event(e).unwrap();
    }
    Workspace { db, pages, big_page, branch }
}

fn time<T>(label: &str, runs: u32, mut f: impl FnMut() -> T) -> Duration {
    let mut best = Duration::MAX;
    for _ in 0..runs {
        let start = Instant::now();
        std::hint::black_box(f());
        best = best.min(start.elapsed());
    }
    println!("{:>10.2} ms  {label}", best.as_secs_f64() * 1000.0);
    best
}

#[test]
#[ignore]
fn stress() {
    let dir = std::env::var_os("TD_STRESS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("td-stress"));
    let start = Instant::now();
    let ws = build(dir.clone());
    println!("built workspace in {:.1}s", start.elapsed().as_secs_f64());
    let db_bytes = std::fs::metadata(dir.join("thoughtdesk.db")).map(|m| m.len()).unwrap_or(0);
    println!("{} pages, database {:.1} MB\n", ws.pages.len(), db_bytes as f64 / 1048576.0);
    let db = &ws.db;
    let normal = ws.pages[ws.pages.len() / 2].clone();

    time("open (existing database)", 3, || Db::open(&dir).unwrap());
    let list = db.list_pages().unwrap();
    time("list_pages", 5, || db.list_pages().unwrap());
    println!("            list_pages payload {:.0} KB", serde_json::to_string(&list).unwrap().len() as f64 / 1024.0);
    time("get_page (normal)", 5, || db.get_page(&normal).unwrap());
    time("get_page (book)", 5, || db.get_page(&ws.big_page).unwrap());
    let big = db.get_page(&ws.big_page).unwrap().content;
    println!("            book is {:.0} KB of JSON", big.len() as f64 / 1024.0);
    time("update_page (normal, content + text)", 5, || {
        let c = db.get_page(&normal).unwrap().content;
        db.update_page(&normal, PagePatch { content: Some(c), text: Some("short".into()), ..Default::default() })
    });
    time("update_page (book, content + text)", 5, || {
        db.update_page(&ws.big_page, PagePatch { content: Some(big.clone()), text: Some(big.clone()), ..Default::default() })
    });
    time("update_page (title only)", 5, || {
        db.update_page(&normal, PagePatch { title: Some("Renamed".into()), ..Default::default() })
    });
    for q in ["", "mito", "photosynthesis membrane", "brane", "zzqx"] {
        time(&format!("search {q:?}"), 5, || db.search(q, 40).unwrap());
    }
    time("backlinks", 5, || db.backlinks(&normal).unwrap());
    time("list_todos", 3, || db.list_todos().unwrap());
    time("list_cards (study)", 3, || db.list_cards().unwrap());
    time("list_decks (sidebar counts)", 3, || db.list_decks("2026-10-12").unwrap());
    time("file_usage", 1, || db.file_usage().unwrap());
    time("list_files", 3, || db.list_files().unwrap());
    time("list_assignments", 3, || db.list_assignments().unwrap());
    time("list_events", 3, || db.list_events().unwrap());
    time("live_count(pages)", 3, || db.live_count(Table::Pages).unwrap());
    time("collect_garbage", 1, || crate::files::collect_garbage(db));
    time("create_page (top level)", 3, || db.create_page(None, Some(0), "New", "").unwrap());
    time("duplicate_page (130-page branch)", 1, || db.duplicate_page(&ws.branch).unwrap());
    time("trash_page (130-page branch)", 1, || db.trash_page(&ws.branch).unwrap());
    time("restore_page (130-page branch)", 1, || db.restore_page(&ws.branch).unwrap());
    time("move_page (branch to the end)", 3, || db.move_page(&ws.branch, None, 10_000).unwrap());
    time("empty_trash", 1, || db.empty_trash().unwrap());
}

/// Times opening a workspace made by an older version (TD_UPGRADE_DIR is
/// copied first, so the original stays as it was).
#[test]
#[ignore]
fn stress_upgrade() {
    let Some(src) = std::env::var_os("TD_UPGRADE_DIR").map(PathBuf::from) else { return };
    let dir = std::env::temp_dir().join("td-upgrade");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["thoughtdesk.db", "thoughtdesk.db-wal"] {
        if src.join(name).exists() {
            std::fs::copy(src.join(name), dir.join(name)).unwrap();
        }
    }
    let size = |d: &PathBuf| std::fs::metadata(d.join("thoughtdesk.db")).map(|m| m.len()).unwrap_or(0) as f64 / 1048576.0;
    println!("before: {:.1} MB", size(&dir));
    time("open + upgrade", 1, || Db::open(&dir).unwrap());
    println!("after: {:.1} MB", size(&dir));
    let db = Db::open(&dir).unwrap();
    time("list_todos (upgraded)", 3, || db.list_todos().unwrap());
}

/// Years of databases: a 50,000-row tracker linked to a 5,000-row one, 40
/// small ones, row pages with notes, and a long history of edits, deletes
/// and copies. Times every database call the UI makes.
///
///   cargo test --release stress_databases -- --ignored --nocapture
#[test]
#[ignore]
fn stress_databases() {
    use crate::databases::{DatabaseInput, NewRow, RowChange, SchemaItem};
    let dir = std::env::var_os("TD_STRESS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("td-stress-db"));
    let _ = std::fs::remove_dir_all(&dir);
    let db = Db::open(&dir).unwrap();
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let size = || std::fs::metadata(dir.join("thoughtdesk.db")).map(|m| m.len()).unwrap_or(0) as f64 / 1048576.0;
    let item = |id: &str, name: &str, kind: &str, key: &str, config: Value| SchemaItem {
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        config,
        sort_key: key.into(),
    };
    let opts = |names: &[&str]| json!({ "options": names.iter().enumerate().map(|(i, n)| json!({"id": format!("o{i}"), "name": n, "color": "blue"})).collect::<Vec<_>>() });
    let keys = |n: usize| -> Vec<String> { (0..n).map(|i| format!("a{i:06}")).collect() };

    let start = Instant::now();
    // The linked database: 5,000 courses' worth of "projects".
    let projects = db
        .create_database(
            None,
            "Projects",
            "",
            DatabaseInput {
                properties: vec![item("budget", "Budget", "number", "a1", json!({}))],
                rows: keys(5000)
                    .into_iter()
                    .map(|k| NewRow { title: rng.sentence(3), sort_key: k, cells: json!({"budget": rng.below(1000)}).as_object().cloned().unwrap(), ..Default::default() })
                    .collect(),
                ..Default::default()
            },
        )
        .unwrap();
    let project_ids: Vec<String> = projects.rows.iter().map(|r| r.row.id.clone()).collect();

    // The big one: 50,000 tasks with ten properties.
    let props = vec![
        item("status", "Status", "status", "a1", opts(&["Not started", "In progress", "Done"])),
        item("prio", "Priority", "select", "a2", opts(&["Low", "Medium", "High"])),
        item("tags", "Labels", "multiSelect", "a3", opts(&["red", "green", "blue", "work", "home"])),
        item("due", "Due", "date", "a4", json!({})),
        item("est", "Estimate", "number", "a5", json!({})),
        item("done", "Done", "checkbox", "a6", json!({})),
        item("notes", "Notes", "text", "a7", json!({})),
        item("url", "Link", "url", "a8", json!({})),
        item("proj", "Project", "relation", "a9", json!({"database": projects.page.id})),
        item("score", "Score", "formula", "b0", json!({"expression": "{Estimate} * 2"})),
    ];
    let rows: Vec<NewRow> = keys(50_000)
        .into_iter()
        .map(|k| {
            let cells = json!({
                "status": format!("o{}", rng.below(3)),
                "prio": format!("o{}", rng.below(3)),
                "tags": [format!("o{}", rng.below(5)), format!("o{}", rng.below(5))],
                "due": { "start": format!("2026-{:02}-{:02}", 1 + rng.below(12), 1 + rng.below(28)) },
                "est": rng.below(40),
                "done": rng.chance(40),
                "notes": rng.sentence(12),
                "url": "https://example.com/item",
                "proj": [project_ids[rng.below(project_ids.len())].clone()],
            });
            NewRow { title: rng.sentence(4), sort_key: k, cells: cells.as_object().cloned().unwrap(), ..Default::default() }
        })
        .collect();
    // In chunks, as an import does (one call takes at most 20,000 rows).
    let tasks = db.create_database(None, "Tasks", "✅", DatabaseInput { properties: props, ..Default::default() }).unwrap();
    let mut task_ids: Vec<String> = Vec::new();
    let mut rows = rows;
    while !rows.is_empty() {
        let rest = rows.split_off(rows.len().min(20_000));
        task_ids.extend(db.create_rows(&tasks.page.id, rows).unwrap().into_iter().map(|c| c.row.id));
        rows = rest;
    }
    println!("built 55,000 rows in {:.1}s", start.elapsed().as_secs_f64());

    // Notes on one row in ten (some with a picture: the gallery cover).
    for (i, id) in task_ids.iter().enumerate().step_by(10) {
        let (content, plain) = page_doc(&mut rng, 6, &[], &[]);
        let content = if i % 30 == 0 {
            content.replacen("\"content\":[", "\"content\":[{\"type\":\"image\",\"attrs\":{\"src\":\"tdfile://x.png\"}},", 1)
        } else {
            content
        };
        db.update_page(id, PagePatch { content: Some(content), text: Some(plain), ..Default::default() }).unwrap();
    }
    // Forty small databases, as a student would make over the years.
    for i in 0..40 {
        db.create_database(
            None,
            &format!("Small {i}"),
            "",
            DatabaseInput {
                rows: keys(100).into_iter().map(|k| NewRow { title: rng.sentence(2), sort_key: k, ..Default::default() }).collect(),
                ..Default::default()
            },
        )
        .unwrap();
    }
    // A template and an automation.
    db.create_rows(&tasks.page.id, vec![NewRow { title: "Weekly review".into(), sort_key: "z0".into(), template: true, ..Default::default() }]).unwrap();
    db.save_automation(&tasks.page.id, item("r1", "", "changed", "a0", json!({"prop": "status", "to": "o2", "actions": [{"type": "set", "prop": "done", "value": {"mode": "value", "value": true}}]}))).unwrap();
    println!("database {:.1} MB after building\n", size());

    // Years of editing: 100,000 single-cell saves, the way the UI sends them.
    let start = Instant::now();
    for n in 0..100_000 {
        let id = &task_ids[rng.below(task_ids.len())];
        let cells = json!({ "est": n % 50, "notes": rng.sentence(10) }).as_object().cloned().unwrap();
        db.update_rows(vec![RowChange { id: id.clone(), cells: Some(cells), sort_key: None }]).unwrap();
    }
    let per = start.elapsed().as_secs_f64() * 1000.0 / 100_000.0;
    println!("{per:>10.3} ms  update_rows, one cell (average of 100,000)");
    println!("database {:.1} MB after 100,000 edits\n", size());

    time("open (existing database)", 3, || Db::open(&dir).unwrap());
    time("list_databases", 5, || db.list_databases().unwrap());
    let all = db.list_rows_raw(None).unwrap();
    time("list_rows (all 59,000)", 3, || db.list_rows_raw(None).unwrap());
    time("list_rows_head (first 100 of Tasks)", 5, || db.list_rows_head(&tasks.page.id, 100).unwrap());
    time("list_rows serialized for the UI", 3, || serde_json::to_string(&db.list_rows_raw(None).unwrap()).unwrap());
    println!("            list_rows payload {:.1} MB", serde_json::to_string(&all).unwrap().len() as f64 / 1048576.0);
    time("create_rows (one)", 5, || {
        db.create_rows(&tasks.page.id, vec![NewRow { title: "New".into(), sort_key: "zz".into(), ..Default::default() }]).unwrap()
    });
    time("create_rows (a pasted sheet of 1,000)", 1, || {
        db.create_rows(&tasks.page.id, keys(1000).into_iter().map(|k| NewRow { title: "Pasted".into(), sort_key: format!("y{k}"), ..Default::default() }).collect()).unwrap()
    });
    time("update_rows (a column fill of 5,000)", 1, || {
        db.update_rows(task_ids[..5000].iter().map(|id| RowChange { id: id.clone(), cells: Some(json!({"done": true}).as_object().cloned().unwrap()), sort_key: None }).collect())
            .unwrap()
    });
    time("update_page (row title)", 5, || db.update_page(&task_ids[7], PagePatch { title: Some("Renamed".into()), ..Default::default() }).unwrap());
    time("search \"review\"", 3, || db.search("review", 40).unwrap());
    time("duplicate_page (Projects, 5,000 rows)", 1, || db.duplicate_page(&projects.page.id).unwrap());
    time("trash_page (Tasks, 51,000 rows)", 1, || db.trash_page(&tasks.page.id).unwrap());
    time("restore_page (Tasks)", 1, || db.restore_page(&tasks.page.id).unwrap());
    time("trash_page (2,000 rows one by one)", 1, || {
        for id in &task_ids[..2000] {
            db.trash_page(id).unwrap();
        }
    });
    time("empty_trash (2,000 rows)", 1, || db.empty_trash().unwrap());
    time("trash + delete Projects copy for good", 1, || {
        let copy = db.list_pages().unwrap().into_iter().find(|p| p.title == "Projects (copy)").unwrap();
        db.trash_page(&copy.id).unwrap();
        db.delete_page(&copy.id).unwrap();
    });
    println!("\ndatabase {:.1} MB at the end", size());
}
