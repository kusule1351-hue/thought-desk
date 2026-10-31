import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type {
  Assignment,
  AssignmentPatch,
  CalEvent,
  Course,
  CoursePatch,
  OccurrencePage,
  Reminder,
  Card,
  CardReview,
  Deck,
  DataInfo,
  EventPatch,
  ExportEntry,
  FileMeta,
  FileUsage,
  Tag,
  Todo,
  Page,
  PageMeta,
  PagePatch,
  SearchHit,
  TrashTable,
  CreatedRow,
  DatabaseSchema,
  DbRow,
  Automation,
  DbView,
  NewRow,
  Property,
  CellValue,
} from './types';

export const api = {
  listPages: () => invoke<PageMeta[]>('list_pages'),
  getPage: (id: string) => invoke<Page>('get_page', { id }),
  createPage: (parentId: string | null, index: number | null = null, title = '', icon = '') =>
    invoke<PageMeta>('create_page', { parentId, index, title, icon }),
  updatePage: (id: string, patch: PagePatch) => invoke<number>('update_page', { id, patch }),
  movePage: (id: string, parentId: string | null, index: number) =>
    invoke<void>('move_page', { id, parentId, index }),
  duplicatePage: (id: string) => invoke<PageMeta>('duplicate_page', { id }),
  trashPage: (id: string) => invoke<number>('trash_page', { id }),
  restorePage: (id: string) => invoke<void>('restore_page', { id }),
  deletePage: (id: string) => invoke<void>('delete_page', { id }),
  emptyTrash: () => invoke<void>('empty_trash'),
  search: (query: string, limit = 30) => invoke<SearchHit[]>('search', { query, limit }),
  /** Bodies of many pages at once (gone ones left out), for the workspace export. */
  /** Shares a page live in `room` (its invite code), or (null) stops sharing it here. */
  setPageShared: (id: string, room: string | null) => invoke<void>('set_page_shared', { id, room }),
  /** A shared page's Yjs state (empty when none is kept yet). */
  getPageYjs: (id: string) => invoke<ArrayBuffer>('get_page_yjs', { id }),
  savePageYjs: (id: string, state: Uint8Array) => invoke<void>('save_page_yjs', state, { headers: { 'x-id': id } }),
  pageContents: (ids: string[]) => invoke<{ id: string; content: string }[]>('page_contents', { ids }),
  /** Makes a new folder in Downloads for the workspace export; returns its path. */
  exportBegin: (name: string) => invoke<string>('export_begin', { name }),
  /** Writes texts, or copies library files, into the export folder. */
  exportWrite: (entries: ExportEntry[]) => invoke<void>('export_write', { entries }),
  exportReveal: () => invoke<void>('export_reveal'),
  exportMarkdown: (title: string, markdown: string) =>
    invoke<string>('export_markdown', { title, markdown }),
  dataInfo: () => invoke<DataInfo>('data_info'),
  /** Starts the one-time listener a Google or GitHub sign-in comes back to; returns its port. */
  authListen: () => invoke<number>('auth_listen'),
  /** A system notification, for news while the window is in the background. */
  notify: (title: string, body: string) => invoke<void>('notify', { title, body }),
  /** The sign-in, kept encrypted by Windows in the app's own folder (secrets.rs). */
  secretGet: (name: string) => invoke<string | null>('secret_get', { name }),
  secretSet: (name: string, value: string) => invoke<void>('secret_set', { name, value }),
  secretRemove: (name: string) => invoke<void>('secret_remove', { name }),
  /** What a folder holds before keeping notes there. */
  dataFolderCheck: (dir: string) => invoke<{ hasNotes: boolean; modified: number | null }>('data_folder_check', { dir }),
  /** Keeps notes in `dir` from the next start: a copy of these, or the notes it has. */
  dataFolderMove: (dir: string, openExisting: boolean) => invoke<void>('data_folder_move', { dir, openExisting }),
  /** Keeps notes in Thought Desk's own folder again from the next start. */
  dataFolderReset: () => invoke<void>('data_folder_reset'),

  /** Adds a file to the library (bytes are copied into the data folder). */
  async saveFile(file: Blob, name: string): Promise<FileMeta> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Header values must be ASCII, so the name travels percent-encoded.
    return invoke<FileMeta>('save_file', bytes, {
      headers: { 'x-name': encodeURIComponent(name), 'x-mime': encodeURIComponent(file.type) },
    });
  },
  listFiles: () => invoke<FileMeta[]>('list_files'),
  updateFile: (id: string, patch: { name?: string }) => invoke<FileMeta>('update_file', { id, patch }),
  fileUsage: () => invoke<FileUsage[]>('file_usage'),
  openFile: (id: string) => invoke<void>('open_file', { id }),
  revealFile: (id: string) => invoke<void>('reveal_file', { id }),
  exportFile: (id: string) => invoke<string>('export_file', { id }),

  listCourses: () => invoke<Course[]>('list_courses'),
  createCourse: (name: string, color: string) => invoke<Course>('create_course', { name, color }),
  updateCourse: (id: string, patch: CoursePatch) => invoke<Course>('update_course', { id, patch }),
  /** Puts the courses in this order (every course's id). */
  reorderCourses: (ids: string[]) => invoke<void>('reorder_courses', { ids }),
  deleteCourse: (id: string) => invoke<void>('delete_course', { id }),

  listAssignments: () => invoke<Assignment[]>('list_assignments'),
  createAssignment: (input: AssignmentPatch) => invoke<Assignment>('create_assignment', { input }),
  updateAssignment: (id: string, patch: AssignmentPatch) => invoke<Assignment>('update_assignment', { id, patch }),

  listEvents: () => invoke<CalEvent[]>('list_events'),
  createEvent: (input: EventPatch) => invoke<CalEvent>('create_event', { input }),
  updateEvent: (id: string, patch: EventPatch) => invoke<CalEvent>('update_event', { id, patch }),

  listTags: () => invoke<Tag[]>('list_tags'),
  setItemTags: (table: TrashTable, id: string, tags: string[]) => invoke<string[]>('set_item_tags', { table, id, tags }),
  setTagColor: (name: string, color: string) => invoke<void>('set_tag_color', { name, color }),
  /** Renames a tag everywhere, or deletes it with `to = null`. */
  renameTag: (from: string, to: string | null) => invoke<void>('rename_tag', { from, to }),
  backlinks: (id: string) => invoke<string[]>('backlinks', { id }),
  /** Every link from one live page to another, as [from, to] page ids. */
  linkGraph: () => invoke<[string, string][]>('link_graph'),
  /** How many words each live page has, as [page id, words]; pages with none are left out. */
  pageWords: () => invoke<[string, number][]>('page_words'),
  /** A number of this workspace's own that never changes, for the shape of its galaxy. */
  galaxySeed: () => invoke<number>('galaxy_seed'),
  listTodos: () => invoke<Todo[]>('list_todos'),
  setTodo: (pageId: string, index: number, key: string, checked: boolean) =>
    invoke<number>('set_todo', { pageId, index, key, checked }),
  listOccurrencePages: () => invoke<OccurrencePage[]>('list_occurrence_pages'),
  setOccurrencePage: (eventId: string, date: string, pageId: string) =>
    invoke<void>('set_occurrence_page', { eventId, date, pageId }),
  setReminders: (list: Reminder[]) => invoke<void>('set_reminders', { list }),
  listCards: () => invoke<Card[]>('list_cards'),
  listDecks: (today: string) => invoke<Deck[]>('list_decks', { today }),
  saveReview: (pageId: string, cardId: string, review: CardReview) => invoke<void>('save_review', { pageId, cardId, review }),
  /** Undoes a card's only review (it's new again). */
  forgetReview: (pageId: string, cardId: string) => invoke<void>('forget_review', { pageId, cardId }),
  resetReviews: (pageId: string) => invoke<void>('reset_reviews', { pageId }),
  /** Saves an exported document to Downloads; returns its path. */
  exportDocument: (name: string, ext: 'docx' | 'md' | 'html' | 'csv', bytes: Uint8Array) =>
    invoke<string>('export_document', bytes, {
      headers: { 'x-name': encodeURIComponent(name), 'x-ext': ext },
    }),
  /** Saves the open page as a PDF in Downloads; returns its path. */
  exportPdf: (title: string) => invoke<string>('export_pdf', { title }),
  /** Frees graphics memory right away (after closing something heavy to draw). */
  trimMemory: () => invoke<void>('trim_memory'),
  /** `accelerator` like "CmdOrCtrl+Shift+Space". */
  setCaptureShortcut: (enabled: boolean, accelerator: string) => invoke<void>('set_capture_shortcut', { enabled, accelerator }),

  listDatabases: () => invoke<DatabaseSchema[]>('list_databases'),
  /** The rows of these databases (all of them when left out). */
  listRows: (dbIds?: string[]) => invoke<DbRow[]>('list_rows', { dbIds }),
  /** A database's first rows in its own order (a first screen while the rest are read). */
  listRowsHead: (dbId: string, limit: number) => invoke<DbRow[]>('list_rows_head', { dbId, limit }),
  /** Live rows per database, without reading them. */
  rowCounts: () => invoke<Record<string, number>>('row_counts'),
  createDatabase: (
    parentId: string | null,
    title: string,
    icon: string,
    input: { description?: string; properties: Property[]; views: DbView[]; automations?: Automation[]; rows?: NewRow[] },
  ) => invoke<{ page: PageMeta; database: DatabaseSchema; rows: CreatedRow[] }>('create_database', { parentId, title, icon, input }),
  updateDatabase: (id: string, description: string) => invoke<void>('update_database', { id, description }),
  saveProperty: (dbId: string, property: Property) => invoke<void>('save_property', { dbId, property }),
  deleteProperty: (dbId: string, id: string) => invoke<void>('delete_property', { dbId, id }),
  saveView: (dbId: string, view: DbView) => invoke<void>('save_view', { dbId, view }),
  deleteView: (dbId: string, id: string) => invoke<void>('delete_view', { dbId, id }),
  saveAutomation: (dbId: string, automation: Automation) => invoke<void>('save_automation', { dbId, automation }),
  deleteAutomation: (dbId: string, id: string) => invoke<void>('delete_automation', { dbId, id }),
  createRows: (dbId: string, rows: NewRow[]) => invoke<CreatedRow[]>('create_rows', { dbId, rows }),
  /** Sets row values (null clears one) and order; returns the time edited. */
  updateRows: (changes: { id: string; cells?: Record<string, CellValue>; sortKey?: string }[]) =>
    invoke<number>('update_rows', { changes }),

  trashItem: (table: TrashTable, id: string) => invoke<number>('trash_item', { table, id }),
  restoreItem: (table: TrashTable, id: string) => invoke<void>('restore_item', { table, id }),
  deleteItem: (table: TrashTable, id: string) => invoke<void>('delete_item', { table, id }),
};

export function fileUrl(name: string): string {
  return convertFileSrc(name, 'tdfile');
}

/** The stored name a library file URL points to, or null for any other address. */
export function storedName(src: string): string | null {
  return /^(?:https?:\/\/tdfile\.localhost\/|tdfile:\/\/localhost\/)([A-Za-z0-9.]+)$/.exec(src)?.[1] ?? null;
}

/** Rewrites stored file URLs for the current platform's URL scheme. */
export function normalizeFileUrl(src: string): string {
  const name = storedName(src);
  return name ? fileUrl(name) : src;
}
