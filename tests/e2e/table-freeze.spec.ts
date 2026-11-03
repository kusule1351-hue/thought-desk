// Frozen leading columns. The fixtures are synthetic: a 32-property, 335-row
// table, a grouped view and two embedded copies. Checks use measured
// rectangles, not class names alone, so a strip that paints but does not line
// up with its header, cells and summary fails.
import type { Page } from '@playwright/test';
import { test, expect, open } from './fixtures';

test.use({ viewport: { width: 1280, height: 800 } });

/** Seeds 335 rows x 32 properties through the mock backend, then reloads. */
async function seed(page: Page) {
  const info = await page.evaluate(async () => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<any>;
    const k = (i: number) => `a${i.toString(36).padStart(4, '0')}`;
    const properties: any[] = [{ id: 'title', name: 'Name', type: 'title', config: {}, sortKey: k(0) }];
    for (let i = 0; i < 24; i++) {
      properties.push({ id: `p${String(i).padStart(2, '0')}`, name: `Text ${String(i + 1).padStart(2, '0')}`, type: 'text', config: {}, sortKey: k(i + 1) });
    }
    const at = 25;
    properties.push({ id: 'p24', name: 'Score', type: 'number', config: {}, sortKey: k(at) });
    properties.push({
      id: 'p25',
      name: 'Stage',
      type: 'select',
      config: { options: [
        { id: 's1', name: 'Alpha', color: 'blue' },
        { id: 's2', name: 'Beta', color: 'green' },
        { id: 's3', name: 'Gamma', color: 'yellow' },
        { id: 's4', name: 'Delta', color: 'red' },
      ] },
      sortKey: k(at + 1),
    });
    properties.push({ id: 'p26', name: 'Done', type: 'checkbox', config: {}, sortKey: k(at + 2) });
    properties.push({ id: 'p27', name: 'Due', type: 'date', config: {}, sortKey: k(at + 3) });
    properties.push({ id: 'p28', name: 'Link', type: 'url', config: {}, sortKey: k(at + 4) });
    properties.push({ id: 'p29', name: 'Email', type: 'email', config: {}, sortKey: k(at + 5) });
    properties.push({ id: 'p30', name: 'Phone', type: 'phone', config: {}, sortKey: k(at + 6) });

    const rows = Array.from({ length: 335 }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      const cells: Record<string, unknown> = {};
      for (let c = 0; c < 24; c++) {
        cells[`p${String(c).padStart(2, '0')}`] =
          c === 1 ? `Row ${n} first line\nrow ${n} second line` : `R${n} C${String(c + 1).padStart(2, '0')} value`;
      }
      cells.p24 = i * 7;
      cells.p25 = `s${(i % 4) + 1}`;
      cells.p26 = i % 3 === 0;
      cells.p27 = { start: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}` };
      cells.p28 = `https://example.test/row/${i + 1}`;
      cells.p29 = `row${i + 1}@example.test`;
      cells.p30 = `+8490${String(i + 1).padStart(6, '0')}`;
      return { title: `Row ${n} - synthetic record ${i + 1}`, sortKey: k(i), cells };
    });

    const views = [
      { id: 'table', name: 'Table', type: 'table', config: { calc: { p24: 'sum' }, widths: { p00: 220 } }, sortKey: 'a0' },
      { id: 'grouped', name: 'Grouped', type: 'table', config: { group: 'p25', hideEmptyGroups: true }, sortKey: 'a1' },
      { id: 'board', name: 'Board', type: 'board', config: { group: 'p25' }, sortKey: 'a2' },
    ];
    const made = await invoke('create_database', {
      parentId: null,
      title: 'Synthetic probe',
      icon: '',
      input: { properties, views, rows },
    });
    const host = await invoke('create_page', { parentId: null, title: 'Synthetic host', icon: '' });
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Two embedded copies follow.' }] },
        { type: 'databaseBlock', attrs: { id: made.page.id, view: 'table' } },
        { type: 'databaseBlock', attrs: { id: made.page.id, view: 'table' } },
      ],
    };
    await invoke('update_page', { id: host.id, patch: { content: JSON.stringify(doc) } });
    return { dbId: made.page.id as string };
  });
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(400);
  return info;
}

async function openDatabase(page: Page) {
  await page.locator('.sidebar .db-row .nav-main', { hasText: 'Synthetic probe' }).first().click();
  await expect(page.locator('.table .grid')).toBeVisible();
  await page.waitForTimeout(250);
}

/** A small database for layout and navigation edge cases. */
async function seedBare(page: Page, opts: { title: string; rows: number; props?: number }) {
  const { title, rows, props = 12 } = opts;
  await page.evaluate(async ({ title, rows, props }) => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<any>;
    const k = (i: number) => `a${i.toString(36).padStart(4, '0')}`;
    const properties: any[] = [{ id: 'title', name: 'Name', type: 'title', config: {}, sortKey: k(0) }];
    for (let i = 0; i < props; i++) {
      properties.push({ id: `p${String(i).padStart(2, '0')}`, name: `Field ${String(i + 1).padStart(2, '0')}`, type: 'text', config: {}, sortKey: k(i + 1) });
    }
    const list = Array.from({ length: rows }, (_, i) => {
      const n = String(i + 1).padStart(4, '0');
      const cells: Record<string, string> = {};
      for (let c = 0; c < props; c++) cells[`p${String(c).padStart(2, '0')}`] = `R${n} F${c + 1}`;
      return { title: `Bare ${n}`, sortKey: k(i), cells };
    });
    await invoke('create_database', {
      parentId: null,
      title,
      icon: '',
      input: { properties, views: [{ id: 'table', name: 'Table', type: 'table', config: {}, sortKey: 'a0' }], rows: list },
    });
  }, { title, rows, props });
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(500);
  await page.locator('.sidebar .db-row .nav-main', { hasText: title }).first().click();
  await expect(page.locator('.table .grid')).toBeVisible();
  await page.waitForTimeout(300);
}

async function freeze(page: Page, propName: string) {
  await page.locator(`.head .th:has-text("${propName}")`).first().click();
  await page.locator('.db-pop button', { hasText: 'Freeze through this column' }).click();
  // The view saves on a short debounce; wait past it so a snapshot of the
  // stored config in a test is the one that includes this boundary.
  await page.waitForTimeout(500);
}

const cell = (page: Page, r: number, c: number) => page.locator(`.td[data-r="${r}"][data-c="${c}"]`).first();
const tableBody = (page: Page) => page.locator('.table .body').first();
const gutter = (page: Page) => page.locator('.tr .gutter').first();

async function scrollLeft(page: Page, x: number) {
  await tableBody(page).evaluate((el, left) => (el.scrollLeft = left), x);
  await page.waitForTimeout(120);
}

test('freeze title: pinned at both sideways extremes, header aligned, persisted', async ({ page }) => {
  await open(page);
  await seed(page);
  await openDatabase(page);

  await test.step('freeze through the title column', async () => {
    await freeze(page, 'Name');
    await expect(page.locator('.th.pinned[data-prop="title"]')).toHaveCount(1);
    await expect(page.locator('.td.pinned[data-r="0"][data-c="0"]')).toHaveCount(1);
    await expect(page.locator('.th.frozen-end')).toHaveCount(1);
  });

  await test.step('at the far right the title stays at the left edge of the rows', async () => {
    await scrollLeft(page, 2400);
    const g = (await gutter(page).boundingBox())!;
    const t = (await cell(page, 0, 0).boundingBox())!;
    const h = (await page.locator('.th[data-prop="title"]').boundingBox())!;
    expect(Math.abs(t.x - (g.x + g.width))).toBeLessThan(2.5);
    expect(Math.abs(h.x - t.x)).toBeLessThan(2.5);
    expect(t.width).toBeGreaterThan(100);
  });

  await test.step('the data columns keep scrolling under it', async () => {
    await scrollLeft(page, 800);
    const a = (await cell(page, 0, 10).boundingBox())!;
    await scrollLeft(page, 1300);
    const c = (await cell(page, 0, 10).boundingBox())!;
    expect(c.x).toBeLessThan(a.x - 400);
  });

  await test.step('at the left edge it sits by the gutter, not over it', async () => {
    await scrollLeft(page, 0);
    const g = (await gutter(page).boundingBox())!;
    const t = (await cell(page, 0, 0).boundingBox())!;
    expect(t.x).toBeGreaterThan(g.x + g.width - 1);
  });

  await test.step('resizing a pinned column keeps header, rows and summary aligned', async () => {
    const handle = page.locator('.head .th[data-prop="title"] .resize');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + 3, hb.y + 8);
    await page.mouse.down();
    await page.mouse.move(hb.x + 63, hb.y + 8, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const h = (await page.locator('.th[data-prop="title"]').boundingBox())!;
    const t = (await cell(page, 0, 0).boundingBox())!;
    const calc = (await page.locator('.calc-cell.pinned').first().boundingBox())!;
    expect(Math.abs(t.width - h.width)).toBeLessThan(2);
    expect(Math.abs(calc.width - h.width)).toBeLessThan(2);
    expect(t.width).toBeGreaterThan(300);
    await handle.dblclick();
    await page.waitForTimeout(300);
    expect(Math.round((await cell(page, 0, 0).boundingBox())!.width)).toBe(280);
  });

  await test.step('zoom and dark theme keep the pinned strip readable', async () => {
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(350);
    await scrollLeft(page, 2400);
    let t = (await cell(page, 0, 0).boundingBox())!;
    let g = (await gutter(page).boundingBox())!;
    expect(Math.abs(t.x - (g.x + g.width))).toBeLessThan(3);
    await page.keyboard.press('Control+Digit0');
    await page.waitForTimeout(300);
    await scrollLeft(page, 0);
    await page.keyboard.press('Control+Comma');
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.locator('.segmented[aria-label="Theme"] button', { hasText: 'Dark' }).click();
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await scrollLeft(page, 2400);
    const darkBg = await cell(page, 0, 0).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(darkBg).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)/);
    g = (await gutter(page).boundingBox())!;
    t = (await cell(page, 0, 0).boundingBox())!;
    expect(Math.abs(t.x - (g.x + g.width))).toBeLessThan(3);
    await page.keyboard.press('Control+Comma');
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.locator('.segmented[aria-label="Theme"] button', { hasText: 'Light' }).click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await scrollLeft(page, 0);
  });

  await test.step('switching views and reloading keeps the boundary for this view only', async () => {
    await page.locator('.tab:has-text("Grouped")').click();
    await page.waitForTimeout(200);
    await expect(page.locator('.th.pinned')).toHaveCount(0);
    await page.locator('.tab:has-text("Table")').click();
    await page.waitForTimeout(250);
    await expect(page.locator('.th.pinned[data-prop="title"]')).toHaveCount(1);
    await page.reload();
    await page.locator('.sidebar').waitFor();
    await page.waitForTimeout(400);
    await openDatabase(page);
    await expect(page.locator('.th.pinned[data-prop="title"]')).toHaveCount(1);
  });
});

test('freeze through a later column pins the exact inclusive prefix, with no 60% share', async ({ page }) => {
  await open(page);
  const info = await seed(page);
  await openDatabase(page);
  const widthsBefore = await page.evaluate(async (dbId) => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<any>;
    const list = await invoke('list_databases');
    const db = list.find((d: any) => d.id === dbId);
    return JSON.parse(JSON.stringify(db.views.find((v: any) => v.id === 'table').config.widths ?? {}));
  }, info.dbId);

  await test.step('a prefix wider than 60% but with a real column to spare is enabled and pinned whole', async () => {
    // Name 280 + Text 01 220 + Text 02 220 = 720 CSS px in a 1020 px body.
    await freeze(page, 'Text 02');
    await expect(page.locator('.th.pinned')).toHaveCount(3);
    await expect(page.locator('.th.pinned[data-prop="p00"]')).toHaveCount(1);
    await expect(page.locator('.th.pinned[data-prop="p01"]')).toHaveCount(1);
    await expect(page.locator('.th.frozen-end[data-prop="p01"]')).toHaveCount(1);
    await expect(page.locator('.th.pinned[data-prop="p02"]')).toHaveCount(0);

    await scrollLeft(page, 2600);
    const g = (await gutter(page).boundingBox())!;
    const t = (await cell(page, 0, 0).boundingBox())!;
    const c1 = (await cell(page, 0, 1).boundingBox())!;
    const c2 = (await cell(page, 0, 2).boundingBox())!;
    const h2 = (await page.locator('.th[data-prop="p01"]').boundingBox())!;
    const calc2 = (await page.locator('.calc-cell.pinned').last().boundingBox())!;
    expect(Math.abs(t.x - (g.x + g.width))).toBeLessThan(2.5);
    expect(Math.abs(c1.x - (t.x + t.width))).toBeLessThan(2.5);
    expect(Math.abs(c2.x - (c1.x + c1.width))).toBeLessThan(2.5);
    expect(Math.abs(h2.width - c2.width)).toBeLessThan(2);
    expect(Math.abs(calc2.width - c2.width)).toBeLessThan(2);
    // The next real column keeps a visible sliver instead of a 160px reserve.
    const box = (await tableBody(page).boundingBox())!;
    expect(box.x + box.width - (c2.x + c2.width)).toBeGreaterThanOrEqual(1);
    expect(Math.round(t.width)).toBe(280);
    expect(widthsBefore).toEqual({ p00: 220 });
  });

  await test.step('a boundary that would cover the viewport stays disabled and saves nothing', async () => {
    await page.locator('.head .th:has-text("Text 05")').first().scrollIntoViewIfNeeded();
    await page.locator('.head .th:has-text("Text 05")').first().click();
    const item = page.locator('.db-pop button', { hasText: 'Freeze through this column' });
    await expect(item).toBeDisabled();
    await expect(page.locator('.db-pop')).toContainText('Not enough room to freeze through this column');
    const saved = await page.evaluate(async (dbId) => {
      const invoke = (window as any).__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<any>;
      const list = await invoke('list_databases');
      return list.find((d: any) => d.id === dbId).views.find((v: any) => v.id === 'table').config.freezeThrough ?? null;
    }, info.dbId);
    expect(saved).toBe('p01');
    await page.keyboard.press('Escape');
    await expect(page.locator('.db-pop')).toHaveCount(0);
  });

  await test.step('unfreezing leaves the table scrolling normally', async () => {
    await page.locator('.head .th[data-prop="title"]').click();
    await page.locator('.db-pop button', { hasText: 'Unfreeze columns' }).click();
    await expect(page.locator('.th.pinned')).toHaveCount(0);
  });
});

test('a saved freeze keeps its exact prefix after a resize and offers a reachable Unfreeze', async ({ page }) => {
  await open(page);
  const info = await seed(page);
  await openDatabase(page);
  await freeze(page, 'Text 02');
  await expect(page.locator('.th.pinned')).toHaveCount(3);
  await expect
    .poll(() =>
      page.evaluate(async (dbId) => {
        const invoke = (window as any).__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<any>;
        const list = await invoke('list_databases');
        return list.find((d: any) => d.id === dbId).views.find((v: any) => v.id === 'table').config.freezeThrough ?? null;
      }, info.dbId),
    )
    .toBe('p01');
  const before = await page.evaluate(async (dbId) => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<any>;
    const list = await invoke('list_databases');
    return JSON.parse(JSON.stringify(list.find((d: any) => d.id === dbId).views.find((v: any) => v.id === 'table').config));
  }, info.dbId);

  await test.step('a narrower window keeps every pinned column and does not rewrite widths', async () => {
    await page.setViewportSize({ width: 900, height: 760 });
    await page.waitForTimeout(400);
    await expect(page.locator('.th.pinned')).toHaveCount(3);
    await expect(page.locator('.th.pinned[data-prop="p01"]')).toHaveCount(1);
    await expect(page.locator('.freeze-overflow')).toBeVisible();
    await expect(page.locator('.freeze-overflow')).toContainText('Frozen columns no longer fit in this window.');
    const title = (await page.locator('.th.pinned[data-prop="title"]').boundingBox())!;
    expect(Math.round(title.width)).toBe(280);
    const after = await page.evaluate(async (dbId) => {
      const invoke = (window as any).__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<any>;
      const list = await invoke('list_databases');
      return JSON.parse(JSON.stringify(list.find((d: any) => d.id === dbId).views.find((v: any) => v.id === 'table').config));
    }, info.dbId);
    expect(after).toEqual(before);
  });

  await test.step('the hint clears when the window fits the saved prefix again', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    await expect(page.locator('.freeze-overflow')).toHaveCount(0);
    await expect(page.locator('.th.pinned')).toHaveCount(3);
  });

  await test.step('the hint Unfreeze is a real escape when the strip covers the boundary', async () => {
    await page.setViewportSize({ width: 900, height: 760 });
    await page.waitForTimeout(400);
    await page.locator('.freeze-overflow button', { hasText: 'Unfreeze' }).click();
    await expect(page.locator('.th.pinned')).toHaveCount(0);
    await expect(page.locator('.freeze-overflow')).toHaveCount(0);
  });
});

/** A table whose column widths leave a chosen sliver of the next column. */
async function seedSized(page: Page, opts: { title: string; widths: Record<string, number>; props?: { id: string; name: string; type: string }[] }) {
  const props = opts.props ?? [
    { id: 'p00', name: 'Field 01', type: 'text' },
    { id: 'p01', name: 'Field 02', type: 'text' },
    { id: 'p02', name: 'Field 03', type: 'text' },
    { id: 'p03', name: 'Field 04', type: 'text' },
  ];
  const info = await page.evaluate(async ({ title, widths, props }) => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<any>;
    const k = (i: number) => `a${i.toString(36).padStart(4, '0')}`;
    const properties: any[] = [{ id: 'title', name: 'Name', type: 'title', config: {}, sortKey: k(0) }];
    props.forEach((p, i) => properties.push({ ...p, config: {}, sortKey: k(i + 1) }));
    const made = await invoke('create_database', {
      parentId: null,
      title,
      icon: '',
      input: {
        properties,
        views: [{ id: 'table', name: 'Table', type: 'table', config: { widths }, sortKey: 'a0' }],
        rows: [{ title: 'Sized row', sortKey: k(0), cells: {} }],
      },
    });
    return { dbId: made.page.id as string };
  }, opts);
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(400);
  await page.locator('.sidebar .db-row .nav-main', { hasText: opts.title }).first().click();
  await expect(page.locator('.table .grid')).toBeVisible();
  await page.waitForTimeout(300);
  return info;
}

test('a prefix that just fits keeps one pixel of the next real column, with no 160px reserve', async ({ page }) => {
  await open(page);
  const info = await seedSized(page, {
    title: 'Sliver probe',
    widths: {},
    props: [
      { id: 'p00', name: 'Field 01', type: 'text' },
      { id: 'p01', name: 'Field 02', type: 'text' },
      { id: 'p02', name: 'Field 03', type: 'text' },
    ],
  });
  // Size the prefix from the body the table actually has in this window, so
  // the boundary leaves a three-pixel sliver of the next real column.
  const widths = await page.evaluate(async (dbId) => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<any>;
    const body = document.querySelector('.table .body') as HTMLElement;
    const list = await invoke('list_databases');
    const db = list.find((d: any) => d.id === dbId);
    const view = db.views.find((v: any) => v.id === 'table');
    const measured = body.clientWidth;
    const title = 480;
    let first = 280;
    if (measured - 3 - 40 - title - first < 90) first = measured - 3 - 40 - title - 90;
    const second = measured - 3 - 40 - title - first;
    view.config = { ...view.config, widths: { title, p00: first, p01: second } };
    await invoke('save_view', { dbId, view });
    return { measured, title, first, second };
  }, info.dbId);
  expect(widths.measured).toBeGreaterThan(700);
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(400);
  await page.locator('.sidebar .db-row .nav-main', { hasText: 'Sliver probe' }).first().click();
  await expect(page.locator('.table .grid')).toBeVisible();
  await page.waitForTimeout(300);

  await freeze(page, 'Field 02');
  await expect(page.locator('.th.pinned')).toHaveCount(3);
  await expect(page.locator('.th.frozen-end[data-prop="p01"]')).toHaveCount(1);
  await tableBody(page).evaluate((el) => (el.scrollLeft = 44));
  await page.waitForTimeout(150);
  const box = (await tableBody(page).boundingBox())!;
  const last = (await page.locator('.th.pinned').last().boundingBox())!;
  const sliver = box.x + box.width - (last.x + last.width);
  expect(sliver).toBeGreaterThanOrEqual(1);
  // It is a sliver, not the old 160px scrolling reserve.
  expect(sliver).toBeLessThan(160);
  // The next real column, not the add button, is partly visible.
  const next = (await page.locator('.head .th[data-prop="p02"]').boundingBox())!;
  expect(next.x).toBeLessThan(box.x + box.width);
  expect(next.x + next.width).toBeGreaterThan(box.x + box.width);
  await expect(page.locator('.th.add')).toHaveCount(1);
});

test('frozen rows stay live while the legacy path keeps its containment', async ({ page }) => {
  await open(page);
  await seedBare(page, { title: 'Containment probe', rows: 40, props: 3 });
  const containment = () => page.locator('.tr').first().evaluate((el) => getComputedStyle(el).contentVisibility);
  const count = () => page.locator('.tr').count();
  expect(await containment()).toBe('auto');
  expect(await count()).toBe(40);

  await freeze(page, 'Name');
  expect(await containment()).toBe('visible');
  expect(await count()).toBe(40);

  await page.locator('.head .th[data-prop="title"]').click();
  await page.locator('.db-pop button', { hasText: 'Unfreeze columns' }).click();
  await expect(page.locator('.th.pinned')).toHaveCount(0);
  expect(await containment()).toBe('auto');
});

test('the last real column and a Button column follow the inclusive boundary rules', async ({ page }) => {
  await open(page);
  await seedSized(page, {
    title: 'Button probe',
    widths: {},
    props: [
      { id: 'p00', name: 'Run', type: 'button' },
      { id: 'p01', name: 'After', type: 'text' },
    ],
  });

  await test.step('a Button column can be a boundary and pins its full prefix', async () => {
    await freeze(page, 'Run');
    await expect(page.locator('.th.pinned')).toHaveCount(2);
    await expect(page.locator('.th.frozen-end[data-prop="p00"]')).toHaveCount(1);
    await expect(page.locator('.td.pinned[data-r="0"][data-c="1"]')).toHaveCount(1);
  });

  await test.step('the last real column stays disabled even after unfreezing', async () => {
    await page.locator('.head .th[data-prop="title"]').click();
    await page.locator('.db-pop button', { hasText: 'Unfreeze columns' }).click();
    await expect(page.locator('.th.pinned')).toHaveCount(0);
    await page.locator('.head .th:has-text("After")').first().click();
    const item = page.locator('.db-pop button', { hasText: 'Freeze through this column' });
    await expect(item).toBeDisabled();
    await expect(page.locator('.db-pop')).toContainText('Not enough room to freeze through this column');
  });
});

test('stable ids: rename, hide, reorder and delete follow the property, not a column position', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 800 });
  await open(page);
  await seed(page);
  await openDatabase(page);

  await freeze(page, 'Text 02');
  await expect(page.locator('.th.pinned')).toHaveCount(3);

  await test.step('renaming the boundary keeps it pinned', async () => {
    await page.locator('.head .th[data-prop="p01"]').click();
    const name = page.locator('.db-pop input[aria-label="Property name"]');
    await name.fill('Renamed 02');
    await name.press('Enter');
    await expect(page.locator('.head .th[data-prop="p01"]')).toContainText('Renamed 02');
    await expect(page.locator('.th.pinned')).toHaveCount(3);
  });

  await test.step('hiding a column before the boundary keeps the prefix', async () => {
    await page.locator('.head .th[data-prop="p00"]').click();
    await page.locator('.db-pop button', { hasText: 'Hide in this view' }).click();
    await page.waitForTimeout(250);
    await expect(page.locator('.th.pinned')).toHaveCount(2);
    await expect(page.locator('.th.pinned').last()).toHaveAttribute('data-prop', 'p01');
  });

  await test.step('unhiding restores it, and moving it past the boundary drops it from the prefix', async () => {
    await page.locator('.tools button[aria-label="View settings"]').click();
    await page.locator('.db-pop .pop-item', { hasText: 'Text 01' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await expect(page.locator('.th.pinned')).toHaveCount(3);
    await page.locator('.head .th[data-prop="p00"]').dragTo(page.locator('.head .th[data-prop="p02"]'));
    await page.waitForTimeout(500);
    await expect(page.locator('.th.pinned')).toHaveCount(2);
    await expect(page.locator('.th.pinned').last()).toHaveAttribute('data-prop', 'p01');
  });

  await test.step('deleting the boundary falls back to no freeze without rewriting the view', async () => {
    await page.locator('.head .th[data-prop="p01"]').click();
    await page.locator('.db-pop button', { hasText: 'Delete property' }).click();
    await page.waitForTimeout(400);
    await expect(page.locator('.th.pinned')).toHaveCount(0);
    await page.locator('.tab:has-text("Grouped")').click();
    await page.waitForTimeout(250);
    await page.locator('.tab:has-text("Table")').click();
    await page.waitForTimeout(300);
    await expect(page.locator('.th.pinned')).toHaveCount(0);
  });
});
