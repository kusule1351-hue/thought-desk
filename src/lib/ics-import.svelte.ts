/** Importing an .ics file: pick it, preview it, then add or update items. */

import { t } from './i18n';
import { parseIcs, type IcsItem } from './ics';
import { pickFiles } from './library.svelte';
import { planner } from './planner.svelte';
import { ui } from './ui.svelte';

export interface ImportRow extends IcsItem {
  include: boolean;
}

/** Opens the file picker, then the import preview. */
export async function importCalendar() {
  const [file] = await pickFiles({ multiple: false, accept: '.ics,text/calendar' });
  if (!file) return;
  let items: IcsItem[];
  try {
    // Some feeds repeat an entry; the first one wins.
    const seen = new Set<string>();
    items = parseIcs(await file.text()).filter((i) => !seen.has(i.uid) && !!seen.add(i.uid));
  } catch {
    ui.error(t('sheets.import.unreadable', { name: file.name }));
    return;
  }
  if (items.length === 0) {
    ui.error(t('sheets.import.noEvents', { name: file.name }));
    return;
  }
  ui.settingsOpen = false;
  ui.importSheet = { name: file.name, items };
}

/** The live item an entry was imported as before, if any. */
export function previous(row: IcsItem) {
  if (row.kind === 'assignment') return planner.live.find((a) => a.sourceUid === row.uid);
  return planner.liveEvents.find((e) => e.sourceUid === row.uid);
}

/** Matches "BIO 101" to a course named "Bio 101" (or creates it). */
async function courseIds(rows: IcsItem[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const name of new Set(rows.map((r) => r.course).filter((c): c is string => !!c))) {
    const found = planner.courses.find((c) => norm(c.name) === norm(name));
    const id = found?.id ?? (await planner.addCourse(name))?.id;
    if (id) ids.set(name, id);
  }
  return ids;
}

/** Adds (or updates, when imported before) the chosen rows. */
export async function runImport(rows: ImportRow[]): Promise<{ added: number; updated: number }> {
  const chosen = rows.filter((r) => r.include);
  const courses = await courseIds(chosen);
  let added = 0;
  let updated = 0;
  for (const r of chosen) {
    const courseId = r.course ? (courses.get(r.course) ?? null) : null;
    const old = previous(r);
    if (r.kind === 'assignment') {
      const patch = { title: r.title, courseId, dueDate: r.startDate, dueTime: r.startTime, notes: r.notes };
      if (old) {
        planner.updateAssignment(old.id, patch, { immediate: true });
        updated++;
      } else if (await planner.addAssignment({ ...patch, sourceUid: r.uid })) added++;
    } else {
      const patch = {
        title: r.title,
        courseId,
        startDate: r.startDate,
        startTime: r.startTime,
        endDate: r.endDate,
        endTime: r.endTime,
        location: r.location,
        notes: r.notes,
        repeat: r.repeat,
        repeatUntil: r.repeatUntil,
        exdates: r.exdates,
      };
      if (old) {
        planner.updateEvent(old.id, patch, { immediate: true });
        updated++;
      } else if (await planner.addEvent({ ...patch, sourceUid: r.uid })) added++;
    }
  }
  return { added, updated };
}
