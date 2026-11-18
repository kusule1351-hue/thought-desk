# Issue #50: the app freezes when multi-line text is pasted into a page

[Issue #50](https://github.com/kusule1351-hue/thought-desk/issues/50), reported against `Thought.Desk_0.8.4_amd64.AppImage`.

## Summary

- The app does not hang. The web view's process **crashes**, and the window keeps showing its last picture. Because the title bar and window buttons are drawn by the web view too, nothing responds any more.
- The crash is inside **WebKitGTK 2.50.4**, the engine the AppImage bundles. It is triggered by the `content-visibility: auto` rule on editor blocks in `src/app.css` (line 1086).
- It is not specific to pasting. Any change that adds several blocks at once while the caret is in an empty line crashes the same way.
- Windows is not affected (WebView2 is Chromium). WebKitGTK 2.52.6 is not affected either.
- **Recommended fix:** turn the `content-visibility` optimisation on only for Chromium. The patch is below; with it the crash is gone on 2.50.4.

## What happens

1. The reporter pastes text with more than one line into an empty line (a new page, or a line just made with Enter).
2. ProseMirror replaces the empty paragraph with several paragraphs in one DOM update.
3. `WebKitWebProcess` calls `abort()` on its main thread, from deep inside `libwebkit2gtk-4.1.so.0`. The stack is a long recursive walk with no symbols, so it is an internal assertion in the engine, not a JavaScript error.
4. Nothing listens for the web process ending, so the window stays as it was, dead.

The paste itself is lost, because the crash comes before the 350 ms autosave. Text saved earlier was intact after restarting the app.

## Root cause

`src/app.css`, lines 1086–1090:

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
| same | dev build with the patch below | paste 3 lines into a new page | works |

The dev build is `npm run dev` with the in-memory backend, so the Rust side is not involved.

## Recommended fix

Keep the optimisation where it is known to be safe, and leave it off on WebKit.

```diff
--- a/src/lib/platform.ts
+++ b/src/lib/platform.ts
@@ -11,6 +11,12 @@ export function isDesktop(): boolean {
 export const isMac = /Mac/i.test(navigator.platform) || (import.meta.env.DEV && new URLSearchParams(location.search).has('mac'));
 
+/** Whether blocks out of sight may skip layout and painting (app.css: html.skip-offscreen).
+ *  Only on Chromium (WebView2 on Windows, and the browser the interface tests run in).
+ *  WebKit (Linux, macOS) crashes its web process when a block changes from always drawn
+ *  to skipped while blocks are added beside it: WebKitGTK 2.50.4, issue #50. */
+export const skipsOffscreen = /Chrom(e|ium)\//.test(navigator.userAgent);
+
 /** The shortcut key and Alt, as this system names them (and, off a Mac, as
```

```diff
--- a/src/main.ts
+++ b/src/main.ts
@@ -4,11 +4,14 @@
 import App from './App.svelte';
-import { isMac } from './lib/platform';
+import { isMac, skipsOffscreen } from './lib/platform';
 
 // macOS draws the window's buttons over the top-left corner (app.css: --traffic-lights).
 if (isMac) document.documentElement.classList.add('mac');
 
+// Long pages draw only what's on screen, where the engine can be trusted with it (app.css).
+if (skipsOffscreen) document.documentElement.classList.add('skip-offscreen');
+
```

```diff
--- a/src/app.css
+++ b/src/app.css
@@ -1083,8 +1083,8 @@
-.prose > :not(.holds-float, .has-caret),
-.prose > :is(ul, ol) > li:not(.holds-float, .has-caret) {
+html.skip-offscreen .prose > :not(.holds-float, .has-caret),
+html.skip-offscreen .prose > :is(ul, ol) > li:not(.holds-float, .has-caret) {
   content-visibility: auto;
   contain-intrinsic-size: auto 1.6em;
 }
```

Checked with this patch applied:

- WebKitGTK 2.50.4: the paste that crashed now works.
- Chromium: the class is set and blocks still compute to `content-visibility: auto`, so Windows keeps the optimisation.
- `npm run check` passes.

The interface tests (`npm run e2e`) were not run against it.

**Cost:** on Linux and macOS, long pages lose the faster opening described in `docs/PERFORMANCE.md`. Windows is unchanged.

**Why not a narrower fix:** making the caret block skip painting too also avoided the crash, but it brings back the caret problem the CSS comment describes, and it depends on engine behaviour nobody controls.

## Why rebuilding is not enough

The release job runs on `ubuntu-22.04` and bundles that system's WebKitGTK. Ubuntu 22.04 still ships 2.50.4 today (`jammy-updates` and `jammy-security`), so a rebuild bundles the same engine. People who install the `.deb` use their own system's WebKitGTK, which is also 2.50.4 on Ubuntu 22.04.

## Also worth doing

1. **Recover when the web process ends.** On Linux, listen for WebKitGTK's `web-process-terminated` signal (through `with_webview`, as `memory.rs` and `pdf.rs` already do for other platforms) and reload the page. Any future engine crash then costs a reload, not a dead window.
2. **Check the table view.** `.table.frozen .tr` in `src/lib/db/TableView.svelte` (line 1201) also switches rows between `content-visibility: visible` and `auto`. It may hit the same engine bug when columns are frozen or unfrozen.
3. **Add a regression test.** A test that pastes three lines into a new page. The tests run only in Chromium, so it would not have caught this one; a WebKit project in Playwright would cover this class of bug better.

## Workaround for the reporter until a release

Paste into a line that already has some text (type a character first), or paste one line at a time. On a distribution with WebKitGTK 2.52 or later, the `.deb` should not crash.

## Not verified

- **macOS.** It also uses WebKit, but was not tested. The patch turns the optimisation off there too.
- **The exact WebKit bug.** The stack has no symbols, so the upstream bug and the commit that fixed it between 2.50.4 and 2.52.6 are not identified.
- **The reload-on-crash handler** in point 1 was not written or built.
- **The table view** in point 2 was not tested.
