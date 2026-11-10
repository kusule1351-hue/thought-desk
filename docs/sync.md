# Sync

How a person's notes move between their computers. Each computer's SQLite file
stays the real copy; the server is an encrypted mailbox that can't read or merge
anything, so the computers do all the merging. With sync off, nothing here runs.

```
Computer A                         Cloudflare                       Computer B
SQLite + merge + encrypt  <--->  Worker (checks the sign-in)  <--->  SQLite + merge + encrypt
                                 Vault Durable Object: numbered
                                 encrypted items, one per account
                                 R2: files and big items
```

## Records

Everything except page text is a **record**: `{ e, id, f, gone }`.

- `e`: the entity (table below). `id`: its key; two-part keys are joined with `/`.
- `f`: `{ field: [value, stamp] }`, every field, each with the stamp of its last change.
- `gone`: a stamp, on a record that was deleted for good. It then has no `f`.

A **stamp** is a hybrid logical clock (`sync.rs`): `{ms:013}-{n:04}-{device}`. Comparing
two as strings orders them in time. The later stamp wins a field on every copy, so
copies end up identical whichever order they hear about changes in. Equal stamps with
different values (only possible from a device-id clash) go to the greater value's JSON.

| Entity | Table | Key | Fields that sync | Local only |
|---|---|---|---|---|
| `page` | `pages` + `databases` + `db_rows` | `id` | `parent_id` `title` `icon` `favorite` `full_width` `tags` `kind` `created_at` `updated_at` `deleted_at` `order`; on a database `db.description` `db.next_number`; on a row `row.sort_key` `row.number` `row.template` and one `c.<property>` per cell | `rid` `position` `shared_room`, `db_rows.cover` `.clocks` |
| `course` | `courses` | `id` | `name` `color` `teacher` `email` `office_hours` `room` `page_id` `weights` `created_at` `order` | `position` |
| `assignment` | `assignments` | `id` | every column | |
| `event` | `events` | `id` | every column | |
| `file` | `files` | `id` | every column (the bytes go separately, as R2 blobs) | |
| `attachment` | `attachments` | `assignment_id/file_id` | `position` | |
| `occurrence` | `occurrence_pages` | `event_id/date` | `page_id` | |
| `tag` | `tags` | `name` | `color` `created_at` | |
| `review` | `card_reviews` | `page_id/card_id` | `due` `interval` `ease` `reps` `lapses` `reviewed_at` | |
| `property` `view` `automation` | `db_properties` `db_views` `db_automations` | `db_id/id` | `name` `type` `config` `sort_key` `deleted` | `clock` |

Page bodies (`page_content`, and what's derived from them: `pages_fts.body`,
`page_links`, `page_derived`, `db_rows.cover`) are not records. See **Page text**.

Not synced at all: settings and preferences, live sessions (`shared_room`, `page_yjs`),
and `sync_meta` itself.

### Noticing changes

While sync is on, TEMP triggers on the writer connection note which records changed in
`sync_changed`. They're created when the database opens (nothing is saved in the schema,
and a copy with sync off pays nothing). They can't miss a write path, foreign-key
cascades included.

`sync_record` keeps, per record, the stamp and a hash of each field as last known
(`{ field: [stamp, hash] }`), the order key, the tombstone, the mailbox's number for it
(`seq`) and whether it still has to be sent. **Reconciling** compares each noted record
with this: a field whose hash differs gets a new stamp, a missing record gets a
tombstone, and a record no one else ever saw is just forgotten.

Applying a remote record writes the table and `sync_record` together, so reconciling
afterwards finds nothing to do. That's what stops copies echoing changes at each other.

### Order

`position` stays what the app reads and writes. The synced `order` field is a fractional
key (`sync/order.rs`, the same algorithm as `src/lib/db/order.ts`). Reconciling keeps the
longest run of siblings whose keys are already in order and gives the rest new keys, so
one drag is one change however many positions it rewrote. Applying sorts siblings by
`(key, id)` and writes `position`.

### Merging

- **Fields**: later stamp wins, per field. So a rename here and a move there both survive.
- **`db.next_number`**: the larger number wins, so no number is handed out twice.
- **Edit beats delete**: a record with any field stamped after the tombstone survives. If
  it can be trashed (it has `deleted_at`), it lands in Trash, with `deleted_at` from the
  tombstone, so every copy computes the same thing.
- **A deleted parent never takes a live child**: children are moved to the top level first.
- **A reference to something missing**: nullable ones become NULL, a record that can't
  exist without its target (`attachment`, `occurrence`, `review`, `property`…) is dropped.
  Reconciling then stamps that as an ordinary local change.
- **Parent cycles** (A moved X under Y, B moved Y under X): the page with the smallest id in
  the cycle moves to the top level.
- **A live page under a trashed one**: moves to the top level. A row can't, so it joins its
  database in the Trash.

A whole pull is applied in one transaction, with foreign keys deferred. Records are sent
parents first, so a copy never sees a child whose parent is yet to come.

### Turning sync on

1. Stamp everything that exists (from `updated_at`, or the like), so a copied notes
   folder merges on what's actually newer. No order keys yet.
2. Back up the database (`VACUUM INTO`).
3. Pull and apply. An untouched "Getting started" goes if the mailbox has data.
4. Reconcile: the order keys. This copy's pages go after the ones that came in.
5. Push.

Turning sync off drops the triggers and forgets the vault key on this computer, and keeps
everything else: what each field was last synced as stays in `sync_record`. Turning it on
again (the recovery key is asked for) looks at every record once (an **audit**, below), so
whatever changed while it was off gets a fresh stamp and wins, and whatever didn't keeps its
old stamp and loses to newer edits from elsewhere. Joining a different synced copy (another
wrapped key) keeps the stamps but sends everything again from scratch; another account
starts from step 1.

A computer remembers the wrapped key of the synced copy it belongs to. If the mailbox has
none, or another (someone chose Delete Synced Copy, and maybe started a new one), it stops
and says so: anything it pushed with the old key would be unreadable to the rest.

The device id in stamps belongs to the install, not the notes folder (a copied folder,
or a cloud drive, must not make two computers one).

### Repairs are local

A repair is how this computer shows something it can't show as the records say: a page
whose parent is gone or in the Trash, a cycle of parents, a property whose database is
missing. It's never stamped and never sent, because a stamp would count as an edit and beat
a later delete (pages deleted for good would come back as Trash zombies), and because a
record that failed to merge on one computer would otherwise delete what depends on it on
every computer. The record keeps its real value; this computer **parks** what it shows
instead (`sync_parked`: the field, the record's value, and the value shown). Each merge
first puts parked values back, then repairs again whatever still needs it. Reconciling and
sending read records through the parked values, so a repair never looks like a change. An
edit by the person to a parked field is an ordinary edit, and ends the parking.

### Audit

`sync_audit` compares every record with `sync_record` and notes what differs. It runs once
after the app opens with sync on, and when sync is turned on again, which catches writes
made without the triggers: an older version of the app, another tool, a migration.

### What a record may hold

Every value is checked before it's written: its JSON type against the column's declared
type and `NOT NULL`, text at most 1 MB, an order key valid and at most 255 characters, a
file's `size` at most 4 GiB, and every stamp of the exact form `\d{13}-\d{4}-[0-9a-f]{0,8}`.
A record that fails is passed over, but its `seq` is still kept, so the next push from here
isn't refused for a base that's out of date. Fields this version doesn't know are kept with
their stamps and sent on unchanged, so an older computer never strips what a newer one wrote.

## Page text

Page text is a Yjs document, kept per page in `sync_y`, separate from `page_yjs`
(which belongs to a live session and is dropped when it ends). `page_content` stays what
the rest of the app reads. A page in a live session waits, and syncs when it ends.

- **The server's state is the baseline.** A copy adopts what the mailbox has, then diffs
  its local body in with `updateYFragment`. Only a page the mailbox has never seen gets
  seeded, once, with a `first` push the server refuses if someone else got there first.
  Otherwise the same text would appear twice.
- **Adopting never takes text away.** A page that arrives with text and a blank body here keeps the text; diffing the blank body in would delete it.
- **Any body write counts.** A trigger on `page_content` notes the page; the engine compares
  the body with the document and turns differences into a Yjs update. Saves from an editor
  turn out equal, because it already wrote into the document.
- **Open pages** bind the editor to the page's document (the Collaboration path live
  sessions use), so a change from another computer appears without touching what you're
  typing. Updates from the mailbox are tagged and never trigger a save or a new stamp.
- Image `src` is platform-specific (`tdfile://`, `http://tdfile.localhost/`), so documents
  hold one canonical form and each copy converts at the boundary.

## Encryption

The vault key (32 random bytes) never leaves Rust and the OS key store. The server holds
only a copy wrapped with the recovery key, which it can't open.

| Key | Derivation (HKDF-SHA256, no salt) |
|---|---|
| Records and text | `info = "td sync records v1"` |
| Names | `info = "td sync names v1"` |
| File bytes | `info = "td sync files v1"` |
| Wrapping the vault key | from the recovery key, `info = "td sync recovery v1"` |

- **Item key on the server**: `base64url(HMAC-SHA256(names, name)[..16])`, where `name` is
  `<entity>/<id>` for a record, and `body/<page id>` for a page's text. The server sees
  random-looking keys and sizes, never ids or titles.
- **Blob name**: the same, as lowercase hex, with `name` = `file/<stored>/<chunk>`.
- **Envelope**: `version (1 byte, =1) | flags (1 byte, bit 0 = deflated) | nonce (24) | ciphertext + tag`,
  XChaCha20-Poly1305, with `AAD = "td-sync-v1|" + kind + "|" + key`. So the server can't swap
  one item for another. A version this app doesn't know means "update to keep syncing".
- **Recovery key**: 16 random bytes plus a 22-bit SHA-256 checksum, as 30 Crockford base32
  characters in groups of five. Shown once. Typing it accepts lower case, spaces, and
  `I`/`L` for 1 and `O` for 0. Lose it and every computer, and the synced copy can't be opened.

## Mailbox API

A `Vault` Durable Object per account (`idFromName(<Clerk user id>)`), in the relay Worker
(`server/`), under `/sync`. `Authorization: Bearer <Clerk session token>`, checked with
`server/src/auth.ts`. All bodies are JSON except blobs. `data` is base64url.

An **item** is `{ key, kind, data }` (or `blob` in place of `data`):

- `kind: "r"`, a record: one per key, replaced on each push.
- `kind: "y"`, a page text update: appended; many per key.
- `kind: "s"`, a page text snapshot: replaces that key's `y` and `s` items up to `upto`.

Every stored item gets the next number in the account's sequence, `seq`.

| Call | Body / query | Answer |
|---|---|---|
| `GET /sync/info` | | `{ seq, used, limit, wrappedKey, format: 1 }` (`wrappedKey` may be null) |
| `PUT /sync/key` | `{ wrappedKey }` | `204`; `409` if already set: it's set once |
| `POST /sync/push` | `{ items: [{ key, kind, data \| blob, size?, base?, first?, upto? }] }` | `{ seq, results: [{ key, seq }], used, limit }` |
| `GET /sync/pull` | `?after=<seq>&limit=<n, at most 1000>` | `{ items: [{ seq, key, kind, data \| blob }], seq, more }` |
| `PUT /sync/blob/<name>` | the bytes, with `Content-Length` | `{ used, limit }` |
| `GET /sync/blob/<name>` | | the bytes |
| `DELETE /sync/blob/<name>` | | `204` |
| `GET /sync/live` | WebSocket, Clerk token as the second subprotocol, like the relay | messages `{ seq }` when something new arrives |
| `DELETE /sync/account` | | `204`; everything of this account is gone, R2 included |

- **A push is all or nothing.** For `r`, `base` must equal the `seq` the key has now (0 if
  it's new). If not, nothing is stored and the answer is `409 { conflicts: [key…] }`: the
  computer pulls, merges and retries. Plain overwriting would lose fields.
- `first: true` on `y` is refused the same way if the key has any items.
- **Pull** answers with the items after `after`, in order, at most `limit` items and about
  4 MB. `more` says there's another page.
- **Quota.** `used` is everything the account stores, R2 included, counted by the server.
  A push or blob that would go over `limit` (1 GiB, `SYNC_LIMIT_BYTES`) gets
  `413 { used, limit }`. A push that doesn't add bytes always goes through, so someone at the
  limit can still delete. When it's full, uploads stop, everything stays on the computers,
  and the meter shows it.
- **Big items.** `data` of more than 64 KB goes to a blob first (DO storage costs 13× R2's),
  and the item carries `blob` and `size` instead. A blob a replaced item used is deleted with it.
- A chunk of a file is at most 8 MiB.
- At most 120 pushes a minute per account: `429`.

### Vault proof

Every call that changes or deletes something carries `X-Vault-Proof`: 32 bytes derived from
the vault key (HKDF-SHA256, `info = "td sync proof v1"`), base64url. `PUT /sync/key` takes
`{ wrappedKey, proof }` and keeps only `SHA-256(proof)`. After that, `POST /push`,
`PUT`/`DELETE /blob/<name>` and `DELETE /account` answer `403 { proof: false }` without the
right proof, and `409 { noVault: true }` while no wrapped key is set. Reads need only the
sign-in. So a sign-in token on its own (it lives 60 seconds, and can leak) can read only
what it can't decrypt: it can't overwrite, delete or re-key anything. A computer whose
copy was deleted and replaced holds the old proof, so it can't delete the new copy either.

### Limits per account

- **Size**: every item costs its data plus 256 bytes, plus its key; that's what `used` counts.
- **Items**: a bucket of 200,000 that fills again over a day; a push that would take more is
  `429`. Every other call has its own per-minute limit (pulls and blobs weigh more).
- **Blobs** are written once: `PUT` to a name that exists is `409`. The bytes are reserved
  before the upload and released if it fails, so R2 never holds what the quota didn't count.
- **Bodies**: a push is at most 6 MiB; the limits are checked before the body is read.
- A refused push (`409`) lists `conflicts: [{ key, seq }]`, with each key's `seq` now. A
  computer whose cursor is already past that `seq` has seen that version (or couldn't read
  it), so it takes that `seq` as its new base (`sync_records_rebase`) and pushes again,
  instead of pulling for ever.
- `/sync/live` sockets last 15 minutes and close on any message but `ping`.

## Inside the app

Rust holds the keys, the storage and the record merging. The engine that talks to the
mailbox is TypeScript (`src/lib/sync/`), because the webview already has `fetch`, Yjs and the
editor's schema, and it's loaded only when sync is on. It runs one cycle at a time, so the
commands below never overlap with each other. A cycle:

1. `await store.flush()` and fire `td:flush`, so saved bodies are the latest.
2. **Pull** until `more` is false: blobs fetched and inlined, then `sync_ingest`. Then `sync_apply`.
   Refresh what the app shows if `entities` isn't empty.
3. **Text**: `sync_text_todo`. For each page in `bodies`, compare and diff into its document. For
   each in `incoming`, merge the updates. Both end in `sync_text_commit`.
4. **Push records**: `sync_seal_records` until empty; on 409 stop and start a new cycle.
5. **Push text**: `sync_seal_text` until empty (updates, snapshots, and markers for deleted pages).
6. **Files**: one at a time, in the background of the cycle (a big file never holds up text).

A cycle starts a few seconds after a change (noted by `td:page-saved` and friends, at most
every 30 s while typing), when `sync_has_changes` says so (asked every 5 s while the window shows, so a title or an assignment goes too), on a `{ seq }` from `/sync/live` that's new, on focus, and once a minute.

| Command | Takes | Gives |
|---|---|---|
| `sync_vault_create` | `account` | `{ recoveryKey, wrappedKey }`. Makes the vault key and keeps it in the OS key store. The recovery key isn't kept anywhere |
| `sync_vault_join` | `account, recoveryKey, wrappedKey` | Fails with a plain message if the key doesn't open it |
| `sync_vault_open` | `account` | `bool`: the key was there and is now in memory |
| `sync_vault_forget` | `account` | |
| `sync_status` | | `{ enabled, account, ready, cursor, wrappedKey }` |
| `sync_turn_on` | `account, joining, wrappedKey` | Backs up (`VACUUM INTO` `thoughtdesk-before-sync.db` in the notes folder), removes an untouched "Getting started" if `joining`, stamps everything |
| `sync_mark_ready` | | The first whole cycle is done |
| `sync_turn_off` | | Forgets all sync state, the notes stay |
| `sync_ingest` | `items: [{ seq, key, kind, data }], cursor` | `{ skipped }`. An envelope from a newer format fails the whole call, and the cursor doesn't move |
| `sync_apply` | | `{ entities, skipped }` |
| `sync_seal_records` | `maxBytes` | `[{ entity, id, key, kind: "r", base, data }]` |
| `sync_records_sent` | `[{ entity, id, seq }]` | |
| `sync_text_todo` | | `{ bodies: [pageId], incoming: [pageId] }`; pages in a live session wait; `incoming` leaves out pages not here (yet) |
| `sync_text_read` | `pageId` | `{ state, content, updates: [{ seq, kind, data }] }`, all binary as base64url |
| `sync_text_commit` | see below | `bool`: false if the page's body changed since `sync_text_read`, and nothing was stored |
| `sync_seal_text` | `maxBytes` | `[{ ref, pageId, key, kind, data, first?, upto? }]` |
| `sync_text_sent` | `[{ ref, seq }]` | |
| `sync_text_refused` | `pageId` | A `first` push was refused: drop what this copy seeded, and adopt what comes |
| `sync_has_changes` | | `bool`: something changed here since the last look |
| `sync_files_todo` | | `{ upload: [{ id, stored, chunks }], download: [{ id, stored, chunks }], remove: [{ id, stored, chunks }] }` |
| `sync_file_names` | `stored, chunks` | The blob name of each chunk |
| `sync_file_seal` | `stored, index` | The sealed bytes (raw) |
| `sync_file_open` | raw body: sealed chunk; headers `stored`, `index`, `chunks` | `bool`: all chunks are in, and the file is in place |
| `sync_file_done` | `id, step: "uploaded" \| "removed"` | |

`sync_text_commit` takes `{ pageId, base, state, update?, first?, content?, text?, consumed? }`:

- `base`: the `content` that `sync_text_read` returned. If the page's body isn't that any more, nothing happens and it answers false. Whoever wrote it noted the page, so it comes round again. Null from a page open in an editor: its document is the truth, so the body isn't compared, and any note of the body stays for the engine to look at. A commit with a `base` clears the note, even with nothing to store.
- `state`: the document's whole state.
- `update` + `first`: local changes to send (`first` for a page's seed).
- `content` + `text`: a new body and its search text. It's written without touching `updated_at`, which is a record field that arrives by itself.
- `consumed`: the highest `seq` of the merged `updates`.

The item plaintext for page text is `<page id>\n<update bytes>`, so the server's key says
nothing. An empty update is the marker of a deleted page. On receiving one, a copy that still
has the page (an edit beat the delete) sends its whole state again.
