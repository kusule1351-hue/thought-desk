/** The assistant's tools for databases: reading them, adding rows, changing rows. */

import { databases, type CellSet } from '../../databases.svelte';
import { checkboxText, formatDateValue, option, optionNamed, options } from '../../db/schema';
import { t } from '../../i18n';
import { store } from '../../store.svelte';
import type { CellValue, DateValue, DbRow, Property, PropertyType } from '../../types';
import { keptFromAssistant, markedKept } from '../access';
import { ToolError, type Done, type Preview, type Tool } from '../types';
import { day, hour } from './planner';

const MAX_ROWS = 50;
/** The types a value can be given for. Everything else is calculated, automatic or a link. */
const SETTABLE = new Set<PropertyType>(['text', 'url', 'email', 'phone', 'number', 'checkbox', 'select', 'status', 'multiSelect', 'date']);

const named = (title: string) => title || t('common.untitled');
const none = () => t('assistantTools.values.none');
const dbTitle = (id: string) => named(store.untracked.get(id)?.title ?? '');

/** The database asked for, or the error the model is told. */
function databaseFor(id: unknown): string {
  const page = typeof id === 'string' ? store.untracked.get(id) : undefined;
  if (!page || page.deletedAt || !databases.isDatabase(page.id)) throw new ToolError('There is no database with that id. Use list_databases.');
  if (keptFromAssistant(page.id)) throw new ToolError('This database is kept from the assistant by its owner. Do not try to read or change it; say so if it matters.');
  return page.id;
}

const titleProp = (dbId: string) => databases.props(dbId).find((p) => p.type === 'title');

// ------------------------------------------------------------- showing values

/** A stored value, as plain words. `model` gives dates as YYYY-MM-DD and yes/no; the person's text follows their language. */
function show(p: Property, v: CellValue | undefined, model: boolean): string {
  if (v === null || v === undefined || v === '') return '';
  switch (p.type) {
    case 'number':
      return typeof v === 'number' ? String(v) : '';
    case 'checkbox':
      return model ? (v === true ? 'yes' : 'no') : checkboxText(v === true);
    case 'select':
    case 'status':
      return option(p, v)?.name ?? '';
    case 'multiSelect':
      return (Array.isArray(v) ? v : []).map((id) => option(p, id)?.name ?? '').filter(Boolean).join(', ');
    case 'date': {
      const d = v as DateValue;
      if (!d?.start) return '';
      if (!model) return formatDateValue(d);
      const plain = (s: string) => s.replace('T', ' ');
      return d.end ? `${plain(d.start)} to ${plain(d.end)}` : plain(d.start);
    }
    case 'relation':
      return (Array.isArray(v) ? v : [])
        .filter((id) => !store.untracked.get(id)?.deletedAt && !keptFromAssistant(id))
        .map((id) => databases.title(id))
        .join(', ');
    default:
      return typeof v === 'string' ? v : '';
  }
}

/** What a row holds for a property, for the model. */
function cellText(row: DbRow, p: Property): string {
  switch (p.type) {
    case 'title':
      return databases.title(row);
    case 'formula':
    case 'rollup':
    case 'created':
    case 'edited':
    case 'id':
    case 'course':
    case 'tags':
    case 'files':
      return databases.text(row, p);
    case 'button':
      return '';
    case 'relation': {
      // A link to a database that is kept from the assistant says nothing.
      const target = p.config.database;
      return target && keptFromAssistant(target) ? '' : show(p, databases.raw(row, p), true);
    }
    default:
      return show(p, databases.raw(row, p), true);
  }
}

/** Whether a property is left out for what it would give away (a rollup or link into a kept database). */
function hidden(dbId: string, p: Property): boolean {
  if (p.type === 'relation') return !!p.config.database && keptFromAssistant(p.config.database);
  if (p.type === 'rollup') {
    const rel = databases.prop(dbId, p.config.relation);
    return !!rel?.config.database && keptFromAssistant(rel.config.database);
  }
  return false;
}

const typeLine = (p: Property) => `${p.name || t('common.untitled')} (${p.type})`;

const listDatabases: Tool<Record<string, never>> = {
  name: 'list_databases',
  kind: 'read',
  description:
    'Lists the person’s databases (tables of rows with typed properties): title, id, how many rows, and the properties as `Name (type)`. Use it to find the database a question or a new entry belongs to. Read the rows with read_database.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  label: () => t('assistantTools.tools.listingDatabases'),
  async run() {
    const found = databases.list.filter((d) => !keptFromAssistant(d.id));
    if (!found.length) return 'There are no databases yet.';
    return found
      .map((d) => {
        const props = databases.props(d.id).filter((p) => !hidden(d.id, p));
        return `- "${named(d.title)}" (id ${d.id}), ${databases.rowCount(d.id)} rows. Properties: ${props.map(typeLine).join(', ')}`;
      })
      .join('\n');
  },
};

const readDatabase: Tool<{ id: string; limit?: number; offset?: number }> = {
  name: 'read_database',
  kind: 'read',
  description:
    'Reads the rows of one database, in the database’s own order. First the properties (name, type, and the option names of select, multi-select and status ones; calculated ones are marked read-only), then up to `limit` rows (default 50, at most 200) starting after `offset` rows, each with its row id, title and values (option names, dates as YYYY-MM-DD, checkboxes as yes or no, links as the titles of the linked rows; empty values are left out). It says how many rows there are in all: use `offset` to read on. The row id is what update_rows needs.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The database’s id.' }, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } },
    required: ['id'],
    additionalProperties: false,
  },
  label: (i) => t('assistantTools.tools.readingDatabase', { title: dbTitle(String(i.id ?? '')) }),
  async run(i) {
    const id = databaseFor(i.id);
    const limit = Math.min(200, Math.max(1, Math.floor(Number(i.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(i.offset) || 0));
    // Rows are read from storage the first time a database is looked at.
    await databases.ensure([id]);
    const props = databases.props(id).filter((p) => !hidden(id, p) && p.type !== 'button');
    const rows = databases.rowsOf(id).filter((r) => !markedKept(r.id));
    const head = props.map((p) => {
      const extra = options(p).length && (p.type === 'select' || p.type === 'multiSelect' || p.type === 'status') ? `: ${options(p).map((o) => o.name).join(', ')}` : '';
      return `- ${p.name || t('common.untitled')} (${p.type}${extra}${SETTABLE.has(p.type) || p.type === 'title' ? '' : ', read-only'})`;
    });
    const slice = rows.slice(offset, offset + limit);
    const out = [`Database "${dbTitle(id)}" (id ${id}), ${rows.length} rows. Properties:`, ...head];
    if (!slice.length) out.push(offset ? `There are no rows after the first ${offset}.` : 'It has no rows yet.');
    else {
      out.push(`Rows ${offset + 1} to ${offset + slice.length} of ${rows.length}:`);
      for (const r of slice) {
        const values = props
          .filter((p) => p.type !== 'title')
          .map((p) => [p.name, cellText(r, p)] as const)
          .filter(([, v]) => v)
          .map(([name, v]) => `${name}: ${v.length > 300 ? `${v.slice(0, 300)}…` : v}`);
        out.push(`- "${databases.title(r)}" (row id ${r.id})${values.length ? `: ${values.join('; ')}` : ''}`);
      }
      if (offset + slice.length < rows.length) out.push(`(${rows.length - offset - slice.length} more: call again with offset ${offset + slice.length}.)`);
    }
    return out.join('\n');
  },
};

// ------------------------------------------------------------- checking values

const names = (dbId: string) => databases.props(dbId).map((p) => `${p.name} (${p.type})`).join(', ');

/** The property a name means: the same name in any case. */
function propertyNamed(dbId: string, name: string): Property {
  const n = name.trim().toLowerCase();
  const p = databases.props(dbId).find((x) => x.name.trim().toLowerCase() === n);
  if (!p) throw new ToolError(`There is no property called "${name}" in this database. Its properties are: ${names(dbId)}.`);
  if (p.type === 'title') throw new ToolError(`"${p.name}" is the row’s title: give it as \`title\`, not in \`values\`.`);
  if (!SETTABLE.has(p.type)) throw new ToolError(`The property "${p.name}" is a ${p.type} property, which can’t be set (it is calculated, automatic or a link). Leave it out.`);
  return p;
}

function textOf(v: unknown, p: Property): string {
  if (typeof v !== 'string') throw new ToolError(`"${p.name}" takes text.`);
  if (v.length > 10_000) throw new ToolError(`The value for "${p.name}" is too long (at most 10000 characters).`);
  return v;
}

/** A date or a date with a time: YYYY-MM-DD or YYYY-MM-DDTHH:MM. */
function dateOf(v: unknown, p: Property): string {
  if (typeof v !== 'string') throw new ToolError(`"${p.name}" takes a date written YYYY-MM-DD.`);
  const [d, time, extra] = v.split('T');
  if (extra !== undefined) throw new ToolError(`"${p.name}" takes a date written YYYY-MM-DD.`);
  const date = day(d, `The date for "${p.name}"`);
  return time === undefined ? date : `${date}T${hour(time, `The time for "${p.name}"`)}`;
}

/** The stored value for what the model gave a property; `null` clears it. */
function cellFor(p: Property, v: unknown): CellValue {
  if (v === null) return null;
  switch (p.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return textOf(v, p);
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`"${p.name}" takes a number (not text).`);
      return v;
    case 'checkbox':
      if (typeof v !== 'boolean') throw new ToolError(`"${p.name}" takes true or false.`);
      return v;
    case 'select':
    case 'status': {
      const o = typeof v === 'string' ? optionNamed(p, v) : undefined;
      if (!o) throw new ToolError(`${JSON.stringify(v)} is not an option of "${p.name}". Its options are: ${options(p).map((x) => x.name).join(', ') || '(none)'}. New options can’t be made with this tool.`);
      return o.id;
    }
    case 'multiSelect': {
      if (!Array.isArray(v)) throw new ToolError(`"${p.name}" takes a list of option names.`);
      const ids = v.map((name) => {
        const o = typeof name === 'string' ? optionNamed(p, name) : undefined;
        if (!o) throw new ToolError(`${JSON.stringify(name)} is not an option of "${p.name}". Its options are: ${options(p).map((x) => x.name).join(', ') || '(none)'}. New options can’t be made with this tool.`);
        return o.id;
      });
      return [...new Set(ids)];
    }
    case 'date': {
      if (typeof v === 'string') return { start: dateOf(v, p) };
      const range = v as { start?: unknown; end?: unknown } | null;
      if (!range || typeof range !== 'object' || Array.isArray(range)) throw new ToolError(`"${p.name}" takes a date (YYYY-MM-DD) or {"start": …, "end": …}.`);
      const start = dateOf(range.start, p);
      if (range.end === undefined || range.end === null) return { start };
      const end = dateOf(range.end, p);
      if (end < start) throw new ToolError(`The end of "${p.name}" is before its start.`);
      return { start, end };
    }
  }
  throw new ToolError(`The property "${p.name}" can’t be set.`);
}

/** The values of a row as cell values by property, in the database's property order. */
function valuesFor(dbId: string, values: unknown): { prop: Property; value: CellValue }[] {
  if (values === undefined) return [];
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new ToolError('`values` must be an object of property names and values.');
  const out = new Map<string, { prop: Property; value: CellValue }>();
  for (const [name, v] of Object.entries(values)) {
    const prop = propertyNamed(dbId, name);
    out.set(prop.id, { prop, value: cellFor(prop, v) });
  }
  return databases.props(dbId).flatMap((p) => out.get(p.id) ?? []);
}

const rowTitle = (v: unknown) => {
  if (typeof v !== 'string' || v.length > 500) throw new ToolError('A row’s title must be text of at most 500 characters.');
  return v.trim();
};

const same = (a: CellValue | undefined, b: CellValue | undefined) => {
  const empty = (v: CellValue | undefined) => v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length);
  return (empty(a) && empty(b)) || JSON.stringify(a) === JSON.stringify(b);
};

const asValues = (changes: { prop: Property; value: CellValue }[]) => changes.map((c) => t('assistantTools.values.propertyValue', { name: c.prop.name, value: show(c.prop, c.value, false) || none() })).join('; ');

// ------------------------------------------------------------- adding rows

interface AddInput {
  database_id: string;
  rows: { title: string; values?: Record<string, unknown> }[];
}

function planAdd(i: AddInput) {
  const db = databaseFor(i.database_id);
  if (!Array.isArray(i.rows) || !i.rows.length) throw new ToolError('rows must be a list with at least one row.');
  if (i.rows.length > MAX_ROWS) throw new ToolError(`At most ${MAX_ROWS} rows can be added in one call. Add them in several calls.`);
  const rows = i.rows.map((r) => {
    if (!r || typeof r !== 'object') throw new ToolError('Each row must be {"title": …, "values": {…}}.');
    return { title: rowTitle(r.title), changes: valuesFor(db, r.values) };
  });
  return { db, rows };
}

const addRows: Tool<AddInput> = {
  name: 'add_rows',
  kind: 'create',
  description:
    'Adds rows to a database (at most 50 a call). Each row is {"title": …, "values": {"Property name": value}}. Property names are matched without regard to case. Values by type: text, url, email and phone take a string; number takes a number; checkbox takes true or false; select and status take the name of an existing option; multi-select takes a list of existing option names; date takes "YYYY-MM-DD" or {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}. Options are never created, and calculated or linking properties (formula, rollup, relation, created, edited, button, files, person, tags, course) can’t be set. A status left out starts at its first stage. The person is shown the rows and decides first. Returns the new rows’ ids.',
  input_schema: {
    type: 'object',
    properties: {
      database_id: { type: 'string' },
      rows: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ROWS,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            // Names of the database's own properties are the keys, so they can't be listed here.
            values: { type: 'object', additionalProperties: true },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
    },
    required: ['database_id', 'rows'],
    additionalProperties: false,
  },
  label: (i) => t('assistantTools.changes.addRows', { count: Array.isArray(i.rows) ? i.rows.length : 0, title: dbTitle(String(i.database_id ?? '')) }),
  preview(i): Preview {
    const { db, rows } = planAdd(i);
    return {
      title: t('assistantTools.changes.addRows', { count: rows.length, title: dbTitle(db) }),
      lines: rows.map((r) => ({ label: named(r.title), value: r.changes.length ? asValues(r.changes) : none() })),
    };
  },
  async run(i): Promise<Done> {
    const { db, rows } = planAdd(i);
    await databases.ensure([db]);
    const list = rows.map((r) => {
      const cells: Record<string, CellValue> = {};
      // A new status starts at its first "to do" stage, as a row a person adds does.
      for (const p of databases.props(db)) {
        if (p.type !== 'status') continue;
        const first = options(p).find((o) => (o.group ?? 'todo') === 'todo') ?? options(p)[0];
        if (first) cells[p.id] = first.id;
      }
      for (const c of r.changes) if (c.value !== null) cells[c.prop.id] = c.value;
      return { title: r.title, cells };
    });
    const made = await databases.addRows(db, list);
    if (!made.length) throw new ToolError('The rows could not be added.');
    const ids = made.map((r) => r.id);
    return {
      summary: t('assistantTools.changes.addedRows', { count: made.length, title: dbTitle(db) }),
      result: `Added ${made.length} rows to "${dbTitle(db)}":\n${made.map((r) => `- "${databases.title(r)}" (row id ${r.id})`).join('\n')}`,
      place: { kind: 'page', id: db },
      // The app's own "delete row": rows go to the Trash (api.trashPage), where they can be had back.
      undo: () => databases.deleteRows(ids),
    };
  },
};

// ------------------------------------------------------------- changing rows

interface UpdateInput {
  rows: { id: string; title?: string; values?: Record<string, unknown> }[];
}

/** The settable properties of a row, as they are stored now (to put back, and to see what changed since). */
function snapshot(row: DbRow): { prop: Property; value: CellValue }[] {
  return databases.props(row.dbId).filter((p) => p.type === 'title' || SETTABLE.has(p.type)).map((p) => ({ prop: p, value: databases.raw(row, p) }));
}

async function planUpdate(i: UpdateInput) {
  if (!Array.isArray(i.rows) || !i.rows.length) throw new ToolError('rows must be a list with at least one row.');
  if (i.rows.length > MAX_ROWS) throw new ToolError(`At most ${MAX_ROWS} rows can be changed in one call. Change them in several calls.`);
  const seen = new Set<string>();
  const plan: { row: DbRow; sets: CellSet[]; shown: { name: string; from: string; to: string }[] }[] = [];
  for (const r of i.rows) {
    if (!r || typeof r.id !== 'string') throw new ToolError('Each row needs an `id`: the row id read_database gave.');
    if (seen.has(r.id)) throw new ToolError(`The row ${r.id} is listed twice. Put all its changes in one entry.`);
    seen.add(r.id);
    const db = databases.dbOf(r.id);
    if (db) await databases.ensure([db]);
    const row = databases.rows[r.id];
    const page = store.untracked.get(r.id);
    if (!db || !row || row.template || !page || page.deletedAt) throw new ToolError(`There is no row with the id "${r.id}". Use read_database to find the right row id.`);
    if (keptFromAssistant(r.id) || keptFromAssistant(db)) throw new ToolError('This row is kept from the assistant by its owner. Do not try to read or change it; say so if it matters.');
    const wanted: { prop: Property; value: CellValue }[] = [];
    if (r.title !== undefined) {
      const prop = titleProp(db);
      const title = rowTitle(r.title);
      if (!prop) throw new ToolError('This database has no title property.');
      wanted.push({ prop, value: title });
    }
    wanted.push(...valuesFor(db, r.values));
    const sets: CellSet[] = [];
    const shown: { name: string; from: string; to: string }[] = [];
    for (const w of wanted) {
      const old = databases.raw(row, w.prop);
      if (same(old, w.value)) continue;
      sets.push({ row, prop: w.prop, value: w.value });
      shown.push({ name: w.prop.type === 'title' ? t('assistantTools.labels.title') : w.prop.name, from: (w.prop.type === 'title' ? String(old ?? '') : show(w.prop, old, false)) || none(), to: (w.prop.type === 'title' ? String(w.value ?? '') : show(w.prop, w.value, false)) || none() });
    }
    if (sets.length) plan.push({ row, sets, shown });
  }
  if (!plan.length) throw new ToolError('Nothing would change: those rows already have these values.');
  return plan;
}

const updateRows: Tool<UpdateInput> = {
  name: 'update_rows',
  kind: 'edit',
  description:
    'Changes rows of databases (at most 50 a call; the ids come from read_database). Each entry is {"id": row id, "title": …, "values": {"Property name": value}} with only what changes. Values follow the same rules as add_rows (select and status take an existing option’s name, multi-select a list of them, dates "YYYY-MM-DD", and so on); `null` clears a value. Calculated or linking properties can’t be changed. The database’s own rules (automations) run as they do when a person edits. The person is shown each old and new value and decides first.',
  input_schema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ROWS,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            // Names of the database's own properties are the keys, so they can't be listed here.
            values: { type: 'object', additionalProperties: true },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    required: ['rows'],
    additionalProperties: false,
  },
  label: (i) => t('assistantTools.changes.updateRows', { count: Array.isArray(i.rows) ? i.rows.length : 0 }),
  async preview(i): Promise<Preview> {
    const plan = await planUpdate(i);
    return {
      title: t('assistantTools.changes.updateRows', { count: plan.length }),
      lines: plan.map((p) => ({
        label: named(databases.title(p.row)),
        value: p.shown.map((c) => t('assistantTools.values.propertyChange', { name: c.name, from: c.from, to: c.to })).join('; '),
      })),
    };
  },
  async run(i): Promise<Done> {
    const plan = await planUpdate(i);
    const rows = plan.map((p) => p.row);
    const before = rows.flatMap((r) => snapshot(r).map((s) => ({ row: r, ...s })));
    // The person's own rules run, as they would for an edit by hand, and the change joins the
    // app's undo history. A rule can change other values of these rows, so undo puts back every
    // value the rows had, not only the ones asked for.
    databases.set(plan.flatMap((p) => p.sets));
    await databases.flush();
    await store.flush();
    const after = rows.flatMap((r) => snapshot(r).map((s) => ({ row: r, ...s })));
    const live = (r: DbRow) => !!databases.rows[r.id] && !store.untracked.get(r.id)?.deletedAt;
    /** The values that were changed again since (by a person, or a rule), which undoing would lose. */
    const moved = () => after.filter((a) => live(a.row) && !same(databases.raw(a.row, a.prop), a.value));
    return {
      summary: t('assistantTools.changes.updatedRows', { count: plan.length }),
      result: `Done. Changed ${plan.length} rows:\n${plan.map((p) => `- "${databases.title(p.row)}" (row id ${p.row.id}): ${p.shown.map((c) => c.name).join(', ')}`).join('\n')}`,
      place: plan.length === 1 ? { kind: 'page', id: plan[0].row.id } : { kind: 'page', id: plan[0].row.dbId },
      undo: async () => {
        const back = before.filter((b) => live(b.row) && !same(databases.raw(b.row, b.prop), b.value));
        databases.set(
          back.map((b) => ({ row: b.row, prop: b.prop, value: b.value })),
          { undo: false, automate: false },
        );
        await databases.flush();
        await store.flush();
      },
      undoLoses: async () => moved().length > 0,
    };
  },
};

export const databaseTools: Tool[] = [listDatabases, readDatabase, addRows, updateRows];
