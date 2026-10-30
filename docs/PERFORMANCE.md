# Performance

How Thought Desk stays small and fast, and how it was tested. For the short version, see the [README](../README.md).

## Why it's light

| | Thought Desk | Typical Electron notes app |
|---|---|---|
| Installer / binary | ~4.4 MB exe | 80–200 MB |
| Memory, open | ~115 MB | 300–600 MB |
| Memory, minimized | ~95 MB | unchanged |

*Private working set summed over all processes, measured on Windows 11 with the release build.*

- **System WebView instead of a bundled Chromium.** Tauri renders with the WebView2 runtime that ships with Windows.
- **Tiny frontend runtime.** Svelte compiles to plain DOM code; the JS heap sits around 3–5 MB.
- **Only one editor is alive at a time.** Opening a page destroys the previous editor; the sidebar only loads page titles, never bodies.
- **Trims itself when minimized.** The Rust side hides and suspends the WebView and sets WebView2's memory target to *low*. Everything is restored when the window comes back. See `src-tauri/src/memory.rs`.
- **Size-optimized release profile** (LTO, `opt-level = "s"`, stripped, `panic = "abort"`).
- **The Galaxy is the one exception.** It draws your whole workspace on the GPU, so while it’s open it adds about 20 MB for a typical workspace and about 210 MB for one of 5,900 pages, given back when you leave. It holds still, so it uses no CPU while you look at it, and it’s off until you turn it on, after it says what it costs.

## Built for years of notes

Tested against a workspace of 7,500 pages (a 2 MB book among them), 2,000 files, 3,000 assignments and events, 11,000 open to-dos and 17,000 flashcards:

- **Bodies live apart from the page list.** Listing pages, counting and recent pages never read through page text.
- **Links, to-dos and flashcards are indexed on save.** Backlinks, file usage, Home and the flashcard counts are lookups, not a parse of every page (file usage went from 92 s to 7 ms).
- **Storage work never runs on the UI thread,** so a slow query can't freeze the window.
- **Long lists render as you scroll**: Home, Assignments, Files, Flashcards, tags, Trash and big sidebar folders.
- **Long pages draw only what's on screen.** Blocks (and items of long lists) out of sight skip layout until they scroll near, so pages with thousands of blocks or a long checklist open 2–3× faster.
- **Big media streams in chunks.** Audio, video and PDFs are served as byte ranges instead of being read into memory whole.
- **The database gives space back** when you delete things for good.

Databases were tested the same way: a 50,000-row tracker linked to a 5,000-row one, 40 smaller databases, notes on thousands of rows and 100,000 edits:

- **Rows are read when a database is first shown,** not at start-up, so databases you aren't using cost nothing: with 58,000 rows the app starts at about 185 MB instead of 260 MB. The databases you opened lately are read in the background once start-up settles, and hovering one in the sidebar starts reading it, so even the 49,000-row table opens in 0.02–0.13 s.
- **Saving a value takes about 0.2 ms.** Rows keep their gallery picture with them, so listing them never reads their pages.
- **A row's place in its database is its own order key,** so deleting or restoring one row never renumbers the other 50,000 (it took over a minute; now it's instant).
- **Big tables stay quick in the window:** rows aren't wrapped one value at a time, sort values are worked out once per row, search remembers each row's text between keystrokes, and rows out of sight skip layout. Sorting 50,000 rows takes about 0.3 s, editing a cell 0.1 s.
- **New rows appear at the top of the view** instead of drawing every row down to the end, and board columns show their first 50 cards with more on request.
- **Nothing piles up:** until a copy first syncs, rows deleted for good leave no note behind in the sync outbox.
- **No leaks:** 40 rounds through databases, pages, Home, the Calendar and search leave the page's memory, elements and listeners where they were.
