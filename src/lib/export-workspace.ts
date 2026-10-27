/**
 * Exports every note as Markdown into a new folder in Downloads: pages in
 * folders like the sidebar, databases as CSV (with the rows that have notes
 * as pages of their own), and the pictures and files pages use, copied into
 * `attachments/`. Page links become `[[wiki links]]` that resolve inside the
 * folder, so it opens as an Obsidian vault too.
 */

import { api, storedName } from './api';
import { toMarkdown, type JNode } from './markdown';
import { docOf, expandDatabases } from './page-actions';
import { titleOf } from './editor/page-link';
import { iconText } from './page-icon';
import { isoDate } from './db/schema';
import { store } from './store.svelte';
import { databases } from './databases.svelte';
import { library } from './library.svelte';
import { ui } from './ui.svelte';
import { t } from './i18n';
import type { DbRow, ExportEntry, PageMeta } from './types';

/** Pages read from storage at a time. */
const BATCH = 200;
/** Text written to disk at a time (characters). */
const WRITE_AT = 1_000_000;

/** Names Windows keeps for devices. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Text without what file names can't hold ("" when nothing is left). */
function cleanName(text: string): string {
  return text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
}

/** A title as a file or folder name Windows (and everything else) accepts. */
export function fileName(title: string): string {
  // The fallback is cleaned too: a translation of it could hold a ":" or "?".
  let name = cleanName(title) || cleanName(t('common.untitled'));
  if (RESERVED.test(name.split('.')[0])) name = t('pages.export.reservedName', { name });
  return name;
}

/** `relative/path` as a Markdown link target from a file at `from`. */
export function linkFrom(from: string, path: string): string {
  const up = '../'.repeat(from.split('/').length - 1);
  return up + path.split('/').map(encodeURIComponent).join('/');
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const yamlKey = (k: string) => (/^[A-Za-z_][\w -]*$/.test(k) && !k.endsWith(' ') ? k : JSON.stringify(k));

/** YAML front matter: what Markdown has no place for (tags, dates, a row's values). */
export function frontMatter(page: PageMeta, fields: [string, string][] = []): string {
  const lines: string[] = [];
  const icon = iconText(page.icon);
  if (icon) lines.push(`icon: ${JSON.stringify(icon)}`);
  if (page.tags.length) lines.push(`tags: [${page.tags.map((tag) => JSON.stringify(tag)).join(', ')}]`);
  for (const [k, v] of fields) lines.push(`${yamlKey(k)}: ${JSON.stringify(v)}`);
  lines.push(`created: ${stamp(page.createdAt)}`, `updated: ${stamp(page.updatedAt)}`);
  if (page.favorite) lines.push('favorite: true');
  return `---\n${lines.join('\n')}\n---\n\n`;
}

/** Whether a body has anything in it (a new row's page is empty). */
function hasNotes(content: string): boolean {
  return (docOf(content).content ?? []).some((n: JNode) => n.type !== 'paragraph' || !!n.content?.length);
}

/** One file per folder name, ignoring case and extension (as Windows sees it). */
class Names {
  #taken = new Map<string, Set<string>>();

  /** A free name for `title` in `folder` ("" is the top), claimed. */
  claim(folder: string, title: string): string {
    let set = this.#taken.get(folder);
    if (!set) this.#taken.set(folder, (set = new Set()));
    const base = fileName(title);
    let name = base;
    for (let n = 2; set.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    set.add(name.toLowerCase());
    return name;
  }
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

let running = false;

export async function exportWorkspace() {
  if (running) return;
  running = true;
  const toast = ui.toast(t('pages.export.progress'), undefined, 10 * 60_000);
  try {
    window.dispatchEvent(new Event('td:flush'));
    await Promise.all([store.flush(), databases.flush()]);
    const dbIds = databases.list.map((d) => d.id);
    await databases.ensure(dbIds);

    // Where everything goes, worked out first so links can point anywhere.
    const names = new Names();
    const paths = new Map<string, string>(); // page or database id → file
    const rowsWithNotes = new Map<string, { row: DbRow; content: string }>();
    const order: string[] = []; // pages to write, parents first

    // Taken before any page, so a page called "Attachments" can't share it.
    const attachDir = names.claim('', t('pages.export.attachmentsFolder'));
    const place = (folder: string, page: PageMeta) => {
      order.push(page.id);
      const kids = store.children(page.id);
      const name = names.claim(folder, page.title);
      if (kids.length) {
        const inside = join(folder, name);
        paths.set(page.id, join(inside, `${names.claim(inside, page.title)}.md`));
        for (const kid of kids) place(inside, kid);
      } else paths.set(page.id, join(folder, `${name}.md`));
    };
    for (const page of store.roots) place('', page);

    const dbFolder = dbIds.length ? names.claim('', t('pages.export.databasesFolder')) : '';
    for (const id of dbIds) {
      const db = store.byId.get(id);
      if (!db) continue;
      const name = names.claim(dbFolder, db.title || t('common.untitledDatabase'));
      paths.set(id, join(dbFolder, `${name}.csv`));
      const rows = databases.rowsOf(id);
      const folder = join(dbFolder, name);
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const bodies = new Map((await api.pageContents(slice.map((r) => r.id))).map((p) => [p.id, p.content]));
        for (const row of slice) {
          const content = bodies.get(row.id) ?? '';
          const page = store.byId.get(row.id);
          if (!page || (!hasNotes(content) && !store.children(row.id).length)) continue;
          rowsWithNotes.set(row.id, { row, content });
          place(folder, page);
        }
      }
      ui.retoast(toast, t('pages.export.progressDatabase', { name: db.title || t('common.untitledDatabase') }));
    }

    // A wiki link's target: the file's name, or its path when two share a name.
    const stems = new Map<string, number>();
    const stemOf = (path: string) => path.split('/').pop()!.replace(/\.md$/, '');
    for (const path of paths.values()) stems.set(stemOf(path).toLowerCase(), (stems.get(stemOf(path).toLowerCase()) ?? 0) + 1);
    const linkTitle = (id: string, kind: Parameters<typeof titleOf>[1] = 'page') => {
      const title = titleOf(id, kind);
      const path = kind === 'page' ? paths.get(id) : undefined;
      if (!path) return title;
      const stem = stemOf(path);
      const target = (stems.get(stem.toLowerCase()) ?? 0) > 1 ? path.replace(/\.md$/, '') : stem;
      // A shown name can't hold what ends or splits a wiki link.
      return target === title ? target : `${target}|${title.replace(/\||\]\]/g, ' ')}`;
    };

    // Library files the pages use, copied once each.
    const byStored = new Map(library.files.map((f) => [f.stored, f]));
    const attachments = new Map<string, string>(); // stored name → path
    const attachment = (stored: string) => {
      let path = attachments.get(stored);
      if (!path) {
        const name = byStored.get(stored)?.name || stored;
        const dot = name.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
        path = `${attachDir}/${names.claim(attachDir, stem)}${cleanName(ext)}`;
        attachments.set(stored, path);
      }
      return path;
    };

    const dir = await api.exportBegin(t('pages.export.folderName', { date: isoDate(new Date()) }));
    let batch: ExportEntry[] = [];
    let size = 0;
    const write = async (entry: ExportEntry, force = false) => {
      if (entry.path) {
        batch.push(entry);
        size += entry.text?.length ?? 0;
      }
      if (force || size >= WRITE_AT) {
        if (batch.length) await api.exportWrite(batch);
        batch = [];
        size = 0;
      }
    };

    const markdown = (page: PageMeta, content: string, path: string, fields?: [string, string][]) =>
      frontMatter(page, fields) +
      toMarkdown(expandDatabases(docOf(content)), page.title || t('common.untitled'), linkTitle, {
        image: (src) => {
          const stored = storedName(src);
          return stored ? linkFrom(path, attachment(stored)) : src;
        },
        file: (id) => {
          const f = library.byId.get(id);
          return f ? linkFrom(path, attachment(f.stored)) : null;
        },
      });

    let done = 0;
    for (let i = 0; i < order.length; i += BATCH) {
      const slice = order.slice(i, i + BATCH);
      const needed = slice.filter((id) => !rowsWithNotes.has(id));
      const bodies = new Map((needed.length ? await api.pageContents(needed) : []).map((p) => [p.id, p.content]));
      for (const id of slice) {
        const page = store.byId.get(id)!;
        const path = paths.get(id)!;
        const row = rowsWithNotes.get(id);
        const text = row ? markdown(page, row.content, path, databases.fields(row.row)) : markdown(page, bodies.get(id) ?? '', path);
        await write({ path, text });
      }
      done += slice.length;
      ui.retoast(toast, t('pages.export.progressCount', { done, total: order.length }));
    }
    for (const id of dbIds) {
      const path = paths.get(id);
      if (path) await write({ path, text: databases.csv(id) });
    }
    for (const [stored, path] of attachments) await write({ path, stored });
    await write({ path: '' }, true);

    ui.dismissToast(toast);
    const count = order.length + dbIds.length;
    ui.toast(t('pages.export.done', { count, folder: dir.split(/[\\/]/).pop()! }), { label: t('pages.showInFolder'), run: () => void api.exportReveal().catch((e) => ui.error(e)) });
  } catch (e) {
    ui.dismissToast(toast);
    ui.error(e);
  } finally {
    running = false;
  }
}
