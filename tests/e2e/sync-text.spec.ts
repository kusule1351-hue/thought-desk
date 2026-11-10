// The logic that turns page text into Yjs documents and back (src/lib/sync/text.ts),
// run in the real browser with the editor's real schema and the real Yjs.
import type { Page } from '@playwright/test';
import { test, expect, open } from './fixtures';

/** Runs `body` in the page with the text module, the editor's schema and a few builders. */
async function inPage<T>(page: Page, body: string): Promise<T> {
  // The helpers are source text so one definition serves every test.
  return page.evaluate(
    async ([code]) => {
      const T = await import('/src/lib/sync/text.ts');
      const { syncSchema } = await import('/src/lib/sync/schema.ts');
      const schema = syncSchema();
      const { Y } = T;
      const p = (text: string, attrs?: Record<string, unknown>) => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), ...(text ? { content: [{ type: 'text', text }] } : {}) });
      const doc = (...content: unknown[]) => ({ type: 'doc', content });
      const image = (src: string, extra: Record<string, unknown> = {}) => ({ type: 'image', attrs: { src, alt: null, title: null, width: null, height: null, ...extra } });
      const swap = (a: any, b: any) => {
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a), T.REMOTE);
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b), T.REMOTE);
      };
      const run = new Function('T', 'schema', 'Y', 'p', 'doc', 'image', 'swap', `return (async () => { ${code} })()`);
      return run(T, schema, Y, p, doc, image, swap);
    },
    [body],
  ) as Promise<T>;
}

test.beforeEach(async ({ page }) => {
  await open(page);
});

test('two documents that trade updates end up the same', async ({ page }) => {
  const result = await inPage<{ same: boolean; text: string }>(
    page,
    `
    const a = new Y.Doc(), b = new Y.Doc();
    T.seed(a, doc(p('First'), p('Second'), p('Third')), schema);
    swap(a, b);
    T.diffInto(a, doc(p('First, edited'), p('Second'), p('Third')), schema);
    T.diffInto(b, doc(p('First'), p('Second'), p('Third'), p('Added on b')), schema);
    swap(a, b);
    const x = T.read(a), y = T.read(b);
    return { same: JSON.stringify(x.json) === JSON.stringify(y.json), text: x.text };
  `,
  );
  expect(result.same).toBe(true);
  expect(result.text).toBe('First, edited\nSecond\nThird\nAdded on b');
});

test('a page seeded on both sides does not double when the second one adopts', async ({ page }) => {
  const result = await inPage<{ adopted: string; naive: string }>(
    page,
    `
    const body = doc(p('Shared sentence.'), p('Another line.'));
    const first = new Y.Doc();
    T.seed(first, body, schema);
    // The second computer adopts what the mailbox has, then diffs its own body in.
    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first), T.REMOTE);
    const changed = T.diffInto(second, body, schema);
    // Seeding it separately and merging is what would have doubled it.
    const other = new Y.Doc();
    T.seed(other, body, schema);
    Y.applyUpdate(other, Y.encodeStateAsUpdate(first), T.REMOTE);
    return { adopted: T.read(second).text + '|' + changed, naive: T.read(other).text };
  `,
  );
  expect(result.adopted).toBe('Shared sentence.\nAnother line.|false');
  expect(result.naive, 'seeding twice is what the first-push rule prevents').not.toBe('Shared sentence.\nAnother line.');
});

test('local changes made before adopting become an ordinary update, once', async ({ page }) => {
  const result = await inPage<{ text: string; a: string; b: string }>(
    page,
    `
    const server = new Y.Doc();
    T.seed(server, doc(p('One'), p('Two')), schema);
    // This computer had "One" and typed more before it ever heard from the mailbox.
    const mine = new Y.Doc();
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(server), T.REMOTE);
    T.diffInto(mine, doc(p('One'), p('Two'), p('Three')), schema);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(mine), T.REMOTE);
    return { text: T.read(server).text, a: T.read(mine).text, b: T.read(server).text };
  `,
  );
  expect(result.text).toBe('One\nTwo\nThree');
  expect(result.a).toBe(result.b);
});

test('a small edit makes a small update and leaves the rest alone', async ({ page }) => {
  const result = await inPage<{ state: number; update: number; others: boolean; text: string }>(
    page,
    `
    const lines = Array.from({ length: 60 }, (_, i) => p('Line number ' + i + ' with a fair bit of ordinary text in it.'));
    const a = new Y.Doc();
    T.seed(a, doc(...lines), schema);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), T.REMOTE);
    const before = Y.encodeStateVector(a);
    const edited = lines.slice();
    edited[30] = p('Line number 30 with a fair bit of ordinary text in it, plus this.');
    T.diffInto(a, doc(...edited), schema);
    const update = Y.encodeStateAsUpdate(a, before);
    Y.applyUpdate(b, update, T.REMOTE);
    const x = T.read(b).json.content;
    return {
      state: Y.encodeStateAsUpdate(a).length,
      update: update.length,
      others: x.every((n, i) => i === 30 || JSON.stringify(n) === JSON.stringify(lines[i])),
      text: T.read(b).json.content[30].content[0].text,
    };
  `,
  );
  expect(result.update).toBeLessThan(result.state / 20);
  expect(result.update).toBeLessThan(120);
  expect(result.others).toBe(true);
  expect(result.text).toBe('Line number 30 with a fair bit of ordinary text in it, plus this.');
});

test('a picture compares equal in either address form and is not rewritten', async ({ page }) => {
  const result = await inPage<{
    forms: (boolean | null)[];
    untouched: boolean | null;
    srcAfterOther: string;
    srcWhenNew: string;
  }>(
    page,
    `
    const win = 'http://tdfile.localhost/abc123.png';
    const mac = 'tdfile://localhost/abc123.png';
    const forms = [
      T.docsEqual(doc(image(win)), doc(image(mac)), schema),
      T.docsEqual(doc(image(mac)), doc(image(mac)), schema),
      T.docsEqual(doc(image(win)), doc(image(win + 'x')), schema),
    ];
    // The document holds the Windows form; the body on disk says the other.
    const d = new Y.Doc();
    T.seed(d, doc(p('Top'), image(mac)), schema);
    // (the editor inserts a picture in the platform's form)
    d.getXmlFragment(T.FIELD).get(1).setAttribute('src', win);
    const untouched = T.diffInto(d, doc(p('Top'), image(mac)), schema);
    // Something else differs: the picture still isn't rewritten.
    T.diffInto(d, doc(p('Top, changed'), image(mac)), schema);
    const srcAfterOther = T.read(d).json.content[1].attrs.src;
    // A picture the document has never had is stored in the canonical form.
    const e = new Y.Doc();
    T.seed(e, doc(p('x'), image(win)), schema);
    const srcWhenNew = T.read(e).json.content[1].attrs.src;
    return { forms, untouched, srcAfterOther, srcWhenNew };
  `,
  );
  expect(result.forms).toEqual([true, true, false]);
  expect(result.untouched).toBe(false);
  expect(result.srcAfterOther).toBe('http://tdfile.localhost/abc123.png');
  expect(result.srcWhenNew).toBe('tdfile://localhost/abc123.png');
});

test('a page with nothing in it equals one empty paragraph', async ({ page }) => {
  const result = await inPage<unknown[]>(
    page,
    `
    const d = new Y.Doc();
    return [
      T.docsEqual(doc(), doc(p('')), schema),
      T.docsEqual(doc(p('')), doc(p(''), p('')), schema),
      T.docsEqual(doc(), doc(p('x')), schema),
      T.docsEqual(doc(p('')), doc(image('tdfile://localhost/a.png')), schema),
      // Nothing to seed, and nothing is made.
      T.seed(d, doc(), schema),
      T.seed(d, doc(p('')), schema),
      d.getXmlFragment(T.FIELD).length,
      T.bodyJson('', schema).content.length,
    ];
  `,
  );
  expect(result).toEqual([true, false, false, false, false, false, 0, 0]);
});

test('null attributes do not make documents differ', async ({ page }) => {
  const result = await inPage<unknown[]>(
    page,
    `
    // Yjs drops attributes that are null, so the stored JSON and the document's differ.
    const withNulls = doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text: 'Body' }] },
      image('tdfile://localhost/q.png', { alt: null, width: null }),
    );
    const d = new Y.Doc();
    T.seed(d, withNulls, schema);
    const back = T.read(d).json;
    return [
      JSON.stringify(back) === JSON.stringify(withNulls),
      T.docsEqual(back, withNulls, schema),
      T.diffInto(d, withNulls, schema),
      T.diffInto(d, back, schema),
    ];
  `,
  );
  expect(result).toEqual([false, true, false, false]);
});

test('a block the schema does not know is skipped, not thrown', async ({ page }) => {
  const result = await inPage<unknown[]>(
    page,
    `
    const future = doc(p('Known'), { type: 'quantumBlock', attrs: { n: 1 } });
    const d = new Y.Doc();
    T.seed(d, doc(p('Known')), schema);
    const before = Y.encodeStateAsUpdate(d).length;
    return [
      T.docsEqual(future, doc(p('Known')), schema),
      T.diffInto(d, future, schema),
      T.seed(new Y.Doc(), future, schema),
      T.parse(future, schema),
      Y.encodeStateAsUpdate(d).length === before,
    ];
  `,
  );
  expect(result).toEqual([null, null, null, null, true]);
});

test('a page stored as HTML is read the way the editor would', async ({ page }) => {
  const result = await inPage<string>(page, `return T.textOf(T.bodyJson('<p>Hello <strong>there</strong></p><p>Again</p>', schema));`);
  expect(result).toBe('Hello there\nAgain');
});

test('a hostile icon value builds no element: the colour goes through the palette, and nothing else reaches the markup', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderIcon } = await import('/src/lib/page-icon.ts');
    const values = [
      'icon:book-open:red"><img src=https://evil.example/x onerror=alert(1)><style>*{display:none}</style>',
      'icon:book-open:red" onmouseover="alert(1)',
      'icon:book-open:var(--x);background:url(https://evil.example/y)',
      'icon:book-open:blue',
      'icon:book-open',
      '<img src=https://evil.example/z onerror=alert(1)>',
      'icon:<img src=x>',
    ];
    return values.map((value) => {
      const el = document.createElement('div');
      renderIcon(el, value);
      const all = [...el.querySelectorAll('*')];
      return {
        value,
        tags: all.map((n) => n.tagName.toLowerCase()),
        attrs: all.flatMap((n) => n.getAttributeNames()),
        color: el.querySelector('svg')?.getAttribute('style') ?? null,
        text: el.textContent,
      };
    });
  });
  for (const r of result) {
    expect(r.tags.every((t) => ['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'].includes(t)), r.value).toBe(true);
    expect(r.attrs.some((a) => /^on/i.test(a)), r.value).toBe(false);
    // Only the palette can colour it: an unknown key is gray, never the value.
    if (r.color) expect(r.color).toMatch(/^color:\s*var\(--c-[a-z]+\);?$/);
  }
  expect(result[3].color).toContain('var(--c-blue)');
  expect(result[0].color).toContain('var(--c-gray)');
  expect(result[4].color).toBeNull();
  // Not a line icon at all: text, and only text.
  expect(result[5].text).toBe(result[5].value);
  expect(result[5].tags).toEqual([]);
});

test('a hostile icon on a page or in a callout reaches no markup in the sidebar or the editor', async ({ page }) => {
  const hostile = 'icon:book-open:red"><img src=https://evil.example/x><style>*{display:none}</style>';
  await page.click('.sidebar >> text=Getting started');
  await expect(page.locator('.scroller .ProseMirror')).toBeVisible();
  await page.evaluate(async (hostile) => {
    const { store } = await import('/src/lib/store.svelte.ts');
    await (window as any).__TAURI_INTERNALS__.invoke('update_page', { id: store.currentId, patch: { icon: hostile } });
    await store.refresh();
    (window as any).__editor.chain().focus('end').insertContent({ type: 'callout', attrs: { icon: hostile }, content: [{ type: 'paragraph' }] }).run();
  }, hostile);
  await expect(page.locator('.callout-icon svg').last()).toBeVisible();
  const found = await page.evaluate(() => ({
    evil: document.querySelectorAll('img[src*="evil"]').length,
    styles: [...document.querySelectorAll('style')].filter((s) => s.textContent?.includes('display:none')).length,
    inCallout: [...document.querySelectorAll('.callout-icon *')].map((n) => n.tagName.toLowerCase()).filter((t) => !['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'].includes(t)),
  }));
  expect(found).toEqual({ evil: 0, styles: 0, inCallout: [] });
});
