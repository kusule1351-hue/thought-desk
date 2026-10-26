# Development

Building Thought Desk from source, where your notes are stored, and how the code is laid out. See also [CONTRIBUTING.md](../CONTRIBUTING.md).

## Build and test

Requirements: Node 20+, Rust (stable, MSVC toolchain on Windows), WebView2 runtime (preinstalled on Windows 10/11).

```bash
git clone https://github.com/kusule1351-hue/thought-desk.git
cd thought-desk
npm install
npm run app        # desktop app with hot reload (tauri dev)
npm run dev        # UI only, in a browser, with an in-memory fake backend
npm run check      # type-check the frontend
npm run e2e        # interface tests: drive the UI in Chromium (tests/e2e); starts the relay in test mode too
npm run bundle     # release build + Windows installer
```

```bash
cd src-tauri && cargo test   # storage tests
cd src-tauri && cargo test --release stress -- --ignored --nocapture --exact stress::stress   # heavy-workspace benchmark
cd src-tauri && cargo test --release stress_databases -- --ignored --nocapture                # 55,000-row database benchmark
```

## Trying accounts and writing together by hand

Sign-in needs the steps in [supabase/SETUP.md](../supabase/SETUP.md) (redirect URLs, the email code template, Google and GitHub). With those done:

```bash
npm --prefix server install
npm --prefix server run dev   # the relay, on localhost:8787, checking real sign-ins
npm run dev                   # the interface, on localhost:1420
```

Open http://localhost:1420 in a normal window and in a private window (each has its own workspace and its own sign-in). Sign in as two different people, add each other as friends, and invite one to a page. The interface tests do all of this without accounts: they use a fake cloud shared by two browser profiles (`tests/e2e/fake-cloud.ts`) and the relay in test mode.

## Data

Everything lives in one SQLite database (`thoughtdesk.db`, WAL mode) plus a `files/` folder for the file library (stored under random names; the database keeps their real names). On Windows that's `%APPDATA%\app.thoughtdesk.desktop\`, and **Settings → Storage** shows the exact path. Back up that folder to back up your notes.

**Settings → Storage → Change…** keeps your notes in another folder, such as OneDrive or a USB drive: they're copied there (a consistent copy of the database, taken while the app runs, and the files folder) and the app restarts using it; the old folder keeps its copy. A folder that already has Thought Desk notes is opened instead, never overwritten. *Use Default* copies them back (older notes in the app's folder are put aside in a "Replaced" folder). The choice is remembered in `location.json` in the app's own folder; if the chosen folder isn't there at start-up (a drive not plugged in), the app opens its own folder and says so. Don't open one folder from two computers at once.

Set `THOUGHTDESK_DATA_DIR` to use a different folder, e.g. a portable copy on a USB drive; it wins over the folder chosen in Settings.

**Ready for sync.** Databases are stored so that two copies can later be merged without a server deciding who wins. Each install has a device id; every edit to a cell, property, view, automation or row's title, icon, place or deletion carries a hybrid logical clock stamp, and changed records are queued in an outbox. Merging keeps the newest stamp per cell, so two people editing different cells of the same row both keep their edits; deleted properties and views stay as tombstones so a deletion can't be undone by an older copy. Row order uses fractional keys, so moving a row never renumbers the others. The `sync_pending` / `sync_apply` / `sync_sent` commands are the hooks an online service will use (`src-tauri/src/sync.rs`, `databases.rs`). Page bodies and the rest of the workspace aren't stamped yet.

## Layout

```
src/                     TypeScript + Svelte UI
  App.svelte             shell, global shortcuts, window show/close handling
  lib/store.svelte.ts    page tree state, navigation history (pages and views), debounced saving
  lib/planner.svelte.ts  courses, assignments and events
  lib/library.svelte.ts  the file library
  lib/tags.svelte.ts     tags; lib/todos.svelte.ts to-dos rolled up from pages; lib/capture.ts Quick Capture
  lib/databases.svelte.ts databases: rows, values, saving, undo, import and export
  lib/export-workspace.ts every note as Markdown in folders, databases as CSV, attachments copied
  lib/cowork.svelte.ts   live sessions: invites and requests, starting and ending them, the relay connection, who's here
  lib/account.svelte.ts  signing in and your profile; lib/friends.svelte.ts friends, requests and who's online
  lib/cloud/             the cloud: Supabase (supabase.ts), signing in with Clerk (clerk.ts), and the fake the interface tests share (fake.ts)
  lib/tabs.svelte.ts     tabs: each one a place with its own history (the active one's lives in the store)
  lib/db/                database views (table, board, gallery, list, calendar, chart, timeline, form), pickers, formula
                         language, query engine (filters, sorts, groups), templates, CSV, order keys
  lib/editor/            TipTap editor: slash menu, @-links, block handle, callouts, file blocks…
  lib/views/             Home, Assignments, Calendar (month and week), Files and tag pages
  lib/sheets/            assignment and event editors, file preview
  lib/components/        sidebar, title bar, search, settings, trash, menus
  lib/ui/                shared controls: segmented control, switch, swatches, rows…
  dev-mock.ts            fake backend for `npm run dev` (dev only, not bundled)
tests/e2e/               interface tests (Playwright), run against `npm run dev`
src-tauri/src/
  db.rs                  SQLite schema and migrations, page tree, trash, FTS search (+ tests)
  planner.rs             courses, assignments, events (+ tests)
  library.rs             file library: import, rename, usage (+ tests)
  organize.rs            tags, backlinks, to-dos rolled up from pages (+ tests)
  commands.rs            Tauri commands
  cards.rs               flashcards: decks, reviews (+ tests)
  databases.rs           database schemas, properties, views, automations, rows and templates, merging copies (+ tests)
  sync.rs                device id, hybrid logical clocks, outbox
  export.rs              writing the whole-workspace export into its folder (+ tests)
  location.rs            the folder notes are kept in: remembering a chosen one, copying the workspace there (+ tests)
  cowork.rs              pages in a live session: their room and the Yjs state kept for reconnecting (+ tests)
  auth.rs                the 127.0.0.1 listener Google and GitHub sign-in comes back to (+ tests)
  secrets.rs             the sign-in, kept encrypted by Windows (DPAPI) in the app's own folder (+ tests)
  files.rs               `tdfile://` protocol (byte ranges), stray-file cleanup
  stress.rs              heavy-workspace benchmark (`cargo test --release stress -- --ignored`)
  memory.rs              WebView2 suspend/trim while minimized, idle, or after Settings
server/                  the relay for live sessions: a Cloudflare Worker that checks who may join and keeps nothing (see server/README.md)
supabase/                the cloud schema: migrations, row-level security tests, and how to turn sign-in on (SETUP.md)
site/                    thoughtdesk.org: the website, and the Worker that serves it (see site/README.md)
```
