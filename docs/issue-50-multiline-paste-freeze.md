# Issue #50: the app freezes when multi-line text is pasted into a page

[Issue #50](https://github.com/kusule1351-hue/thought-desk/issues/50), reported against `Thought.Desk_0.8.4_amd64.AppImage`.

## Summary

- The app does not hang. The web view's process **crashes**, and the window keeps showing its last picture. Because the title bar and window buttons are drawn by the web view too, nothing responds any more.
- The crash is inside **WebKitGTK 2.50.4**, the engine the AppImage bundles. It is triggered by the `content-visibility: auto` rule on editor blocks in `src/app.css` (line 1086).
- It is not specific to pasting. Any change that adds several blocks at once while the caret is in an empty line crashes the same way.
- Windows is not affected (WebView2 is Chromium). WebKitGTK 2.52.6 is not affected either.
- **Fix:** the `content-visibility` optimisation is now on only for Chromium. With it the crash is gone on 2.50.4.

## What happens

1. The reporter pastes text with more than one line into an empty line (a new page, or a line just made with Enter).
2. ProseMirror replaces the empty paragraph with several paragraphs in one DOM update.
3. `WebKitWebProcess` calls `abort()` on its main thread, from deep inside `libwebkit2gtk-4.1.so.0`. The stack is a long recursive walk with no symbols, so it is an internal assertion in the engine, not a JavaScript error.
4. Nothing listens for the web process ending, so the window stays as it was, dead.

The paste itself is lost, because the crash comes before the 350 ms autosave. Text saved earlier was intact after restarting the app.

## Root cause

`src/app.css`, as it was in 0.8.4:

```css
.prose > :not(.holds-float, .has-caret),
.prose > :is(ul, ol) > li:not(.holds-float, .has-caret) {
  content-visibility: auto;
  contain-intrinsic-size: auto 1.6em;
}
```

Every top-level block skips layout and painting while off screen, except the block with the caret, which `caret()` in `src/lib/editor/float-safe.ts` (line 50) marks `has-caret`.

When several paragraphs go into an empty line, the paragraph that had the caret loses `has-caret` and the last new paragraph gets it. So one element changes from `content-visibility: visible` to `auto` in the same update that adds new blocks beside it. WebKitGTK 2.50.4 aborts on that.

Pasting one line never moves `has-caret` to another block, which is why single-line pastes work.

## How this was checked

All runs were on Ubuntu 24.04 under Xvfb, with real `Ctrl+V` key events and the clipboard owned by a separate process.

| Engine | Interface | Action | Result |
| --- | --- | --- | --- |
| Chromium (Playwright) | dev build | paste 3 lines into a new page | works |
| WebKitGTK 2.52.6 (Ubuntu 24.04) | dev build | paste 3 lines, plain or rich text, new or existing page | works |
| 0.8.4 AppImage (bundles 2.50.4) | released | paste 1 line | works |
| 0.8.4 AppImage | released | Enter, then paste 3 lines | **web process aborts**, 2 of 2 runs |
| 0.8.4 AppImage | released | paste 3 lines at the end of a line with text | works, 1 run |
| WebKitGTK 2.50.4 taken from the AppImage | dev build | paste 3 lines into a new page | **crashes**, 3 of 3 runs |
| same | dev build, blocks forced to `content-visibility: visible` | same paste | works |
| same | dev build, `contain-intrinsic-size` set to `none` or `1.6em` | same paste | still crashes |
| same | dev build, caret block also `content-visibility: auto` | same paste | works |
| same | dev build | 3 paragraphs added by `insertContent`, no clipboard | **crashes** |
| same | dev build with the fix | paste 3 lines into a new page | works, 3 of 3 runs |

The dev build is `npm run dev` with the in-memory backend, so the Rust side is not involved.

## The fix

The optimisation stays where it is known to be safe, and is off on WebKit:

- `src/lib/platform.ts`: `skipsOffscreen` is true when the user agent says Chromium.
- `src/main.ts`: sets the class `skip-offscreen` on `<html>` when it is.
- `src/app.css`: the `content-visibility` rule applies only under `html.skip-offscreen`.

Checked with the fix applied:

- WebKitGTK 2.50.4: the paste that crashed now works.
- Chromium: the class is set and blocks still compute to `content-visibility: auto`, so Windows keeps the optimisation. A test in `tests/e2e/basics.spec.ts` pastes three lines into a new page and checks this.
- `npm run check` passes.

**Cost:** on Linux and macOS, long pages lose the faster opening described in `docs/PERFORMANCE.md`. Windows is unchanged.

**Why not a narrower fix:** making the caret block skip painting too also avoided the crash, but it brings back the caret problem the CSS comment describes, and it depends on engine behaviour nobody controls.

## Why rebuilding is not enough

The release job runs on `ubuntu-22.04` and bundles that system's WebKitGTK. Ubuntu 22.04 still ships 2.50.4 today (`jammy-updates` and `jammy-security`), so a rebuild bundles the same engine. People who install the `.deb` use their own system's WebKitGTK, which is also 2.50.4 on Ubuntu 22.04.

## Also worth doing

1. **Recover when the web process ends.** On Linux, listen for WebKitGTK's `web-process-terminated` signal (through `with_webview`, as `memory.rs` and `pdf.rs` already do for other platforms) and reload the page. Any future engine crash then costs a reload, not a dead window.
2. **Check the table view.** `.table.frozen .tr` in `src/lib/db/TableView.svelte` (line 1201) also switches rows between `content-visibility: visible` and `auto`. It may hit the same engine bug when columns are frozen or unfrozen.
3. **Run the tests on WebKit too.** They run only in Chromium, so the new paste test would not have caught this crash. A WebKit project in Playwright would cover this class of bug.

## Workaround for the reporter until a release

Paste into a line that already has some text (type a character first), or paste one line at a time. On a distribution with WebKitGTK 2.52 or later, the `.deb` should not crash.

## Not verified

- **macOS.** It also uses WebKit, but was not tested. The fix turns the optimisation off there too.
- **The exact WebKit bug.** The stack has no symbols, so the upstream bug and the commit that fixed it between 2.50.4 and 2.52.6 are not identified.
- **The reload-on-crash handler** in point 1 was not written or built.
- **The table view** in point 2 was not tested.
