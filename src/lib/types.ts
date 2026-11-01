export interface PageMeta {
  id: string;
  parentId: string | null;
  title: string;
  icon: string;
  position: number;
  /** 0 when not a favorite, otherwise when it was favorited (ms). */
  favorite: number;
  fullWidth: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  tags: string[];
  /** "database" for a database (its sub-pages are its rows), else "". */
  kind: string;
  /** The Cowork room (invite code) of a page shared live, else null. */
  sharedRoom: string | null;
}

/** A file the workspace export writes: its text, or a library file to copy. */
export interface ExportEntry {
  /** Relative to the export folder, `/`-separated ("Biology/Lecture.md"). */
  path: string;
  text?: string;
  /** Stored name of a library file. */
  stored?: string;
}

export interface Page extends PageMeta {
  /** Editor JSON (or HTML for seeded pages that were never edited). */
  content: string;
}

export interface PagePatch {
  title?: string;
  icon?: string;
  content?: string;
  text?: string;
  favorite?: boolean;
  fullWidth?: boolean;
}

export interface SearchHit {
  id: string;
  title: string;
  icon: string;
  /** Excerpt with matches wrapped in \u0001 ... \u0002. */
  snippet: string;
  updatedAt: number;
}

export interface DataInfo {
  dataDir: string;
  /** Thought Desk's own folder, where notes are kept unless another is chosen. */
  defaultDir: string;
  /** The notes are in a folder the user chose. */
  chosenDir: boolean;
  /** THOUGHTDESK_DATA_DIR set the folder, so Settings can't change it. */
  envDir: boolean;
  /** A chosen folder that wasn't there at start-up. */
  missingDir: string | null;
  dbBytes: number;
  /** Bytes of everything in the files folder. */
  fileBytes: number;
  /** Live files in the library. */
  fileCount: number;
  pageCount: number;
  assignmentCount: number;
  eventCount: number;
  version: string;
}

export interface Course {
  id: string;
  name: string;
  /** Palette key, see colors.ts. */
  color: string;
  position: number;
  createdAt: number;
  teacher: string;
  email: string;
  officeHours: string;
  room: string;
  /** The page holding this course's notes; lecture notes go inside it. */
  pageId: string | null;
  /** Grade category → weight in percent. Empty: the grade is total points. */
  weights: Record<string, number>;
}

export type CoursePatch = Partial<
  Pick<Course, 'name' | 'color' | 'teacher' | 'email' | 'officeHours' | 'room' | 'pageId' | 'weights'>
>;

export type AssignmentStatus = 'todo' | 'doing' | 'done';

export interface Assignment {
  id: string;
  title: string;
  courseId: string | null;
  /** Local calendar date, "YYYY-MM-DD". */
  dueDate: string | null;
  /** Local time, "HH:MM"; null means "end of the day". */
  dueTime: string | null;
  status: AssignmentStatus;
  /** 0 none, 1 low, 2 medium, 3 high. */
  priority: number;
  notes: string;
  pageId: string | null;
  fileIds: string[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  deletedAt: number | null;
  tags: string[];
  /** UID of the calendar entry it was imported from. */
  sourceUid: string | null;
  /** Points earned and possible, once graded. */
  score: number | null;
  maxScore: number | null;
  /** Grade category ("Homework", "Exams"), weighted by the course. */
  category: string;
}

export type AssignmentPatch = Partial<
  Pick<
    Assignment,
    'title' | 'courseId' | 'dueDate' | 'dueTime' | 'status' | 'priority' | 'notes' | 'pageId' | 'fileIds' | 'score' | 'maxScore' | 'category'
  >
> & { sourceUid?: string };

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';

export interface CalEvent {
  id: string;
  title: string;
  startDate: string;
  /** null for all-day events. */
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  /** Palette key; empty means "use the course color". */
  color: string;
  courseId: string | null;
  location: string;
  notes: string;
  repeat: Repeat;
  repeatUntil: string | null;
  pageId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  tags: string[];
  /** Dates a repeating event skips. */
  exdates: string[];
  sourceUid: string | null;
}

/** The notes page for one session of an event. */
export interface OccurrencePage {
  eventId: string;
  date: string;
  pageId: string;
}

/** Spaced-repetition progress of a flashcard. */
export interface CardReview {
  /** Next due date. */
  due: string;
  /** Days until the next review (0 = again today). */
  interval: number;
  ease: number;
  reps: number;
  lapses: number;
}

/** A page's flashcards, counted for today. */
export interface Deck {
  pageId: string;
  /** Cards with something on the front. */
  count: number;
  /** Studied before and due today (or earlier). */
  due: number;
  /** Never studied. */
  fresh: number;
  /** Learned well enough to be shown three weeks apart. */
  mastered: number;
}

/** Inline editor content (text with marks, line breaks, links), read only. */
export interface RichNode {
  type: string;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
  content?: RichNode[];
}

/** A flashcard block in a page. */
export interface Card {
  pageId: string;
  id: string;
  front: string;
  back: string;
  /** Each side as written, with its formatting. */
  frontContent: RichNode[];
  backContent: RichNode[];
  review: CardReview | null;
}

export interface Reminder {
  key: string;
  /** When (ms since the epoch). */
  at: number;
  title: string;
  body: string;
}

export type EventPatch = { exdates?: string[]; sourceUid?: string } & Partial<
  Pick<
    CalEvent,
    | 'title'
    | 'startDate'
    | 'startTime'
    | 'endDate'
    | 'endTime'
    | 'color'
    | 'courseId'
    | 'location'
    | 'notes'
    | 'repeat'
    | 'repeatUntil'
    | 'pageId'
  >
>;

export interface FileMeta {
  id: string;
  /** Display name, with extension. */
  name: string;
  /** Name of the bytes inside the data folder (its tdfile URL). */
  stored: string;
  mime: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** The bytes are gone from disk. */
  missing: boolean;
  tags: string[];
}

export interface Tag {
  name: string;
  /** Palette key, or empty for the default. */
  color: string;
}

/** An unchecked to-do item inside a page. */
export interface Todo {
  pageId: string;
  /** Position among the page's to-dos, in document order. */
  index: number;
  text: string;
  /** Raw content of the item; proves it hasn't changed when toggling. */
  key: string;
}

export interface FileUsage {
  fileId: string;
  pageIds: string[];
}

/** Everything that can sit in the trash. */
export type TrashTable = 'pages' | 'assignments' | 'events' | 'files';

// ------------------------------------------------------------------ databases

export type PropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multiSelect'
  | 'status'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'files'
  | 'relation'
  | 'rollup'
  | 'formula'
  | 'created'
  | 'edited'
  | 'tags'
  | 'course'
  | 'id'
  | 'button';

/** A choice of a select, multi-select or status property. */
export interface SelectOption {
  id: string;
  name: string;
  /** Palette key (see colors.ts). */
  color: string;
  /** Status options only: which stage it belongs to. */
  group?: 'todo' | 'doing' | 'done';
}

export type NumberFormat = 'number' | 'comma' | 'percent' | 'dollar' | 'euro' | 'pound' | 'yen' | 'rupee';

export type RollupFn =
  | 'show'
  | 'count'
  | 'countValues'
  | 'sum'
  | 'average'
  | 'min'
  | 'max'
  | 'percentChecked'
  | 'percentDone'
  | 'earliest'
  | 'latest';

export interface PropertyConfig {
  /** Shown as a tooltip on the column. */
  description?: string;
  /** Select, multi-select and status. */
  options?: SelectOption[];
  /** Number. */
  format?: NumberFormat;
  decimals?: number | null;
  display?: 'number' | 'bar' | 'ring';
  /** The value that fills a bar or ring (default 100). */
  max?: number;
  /** Date: also show these dates on the Calendar. */
  onCalendar?: boolean;
  /** Formula. */
  expression?: string;
  /** Relation: the database it links to, and its twin property there. */
  database?: string;
  back?: string | null;
  /** Rollup: a relation property, a property of the linked rows, and how to sum them up. */
  relation?: string;
  target?: string;
  fn?: RollupFn;
  /** ID: text before the number ("TASK-12"). */
  prefix?: string;
  /** Relation to its own database: this one holds each row's parent (sub-items). */
  parent?: boolean;
  /** Button: what it says and what it does. */
  label?: string;
  actions?: DbAction[];
}

/** Something a button or an automation does. */
export type DbAction =
  /** Sets a property of the row. */
  | { type: 'set'; prop: string; value: ActionValue }
  /** Adds a row to a database (this one or another), maybe linked back to this row. */
  | { type: 'add'; db: string; title?: string; link?: string | null; open?: boolean }
  /** Opens the row as a page. */
  | { type: 'open' }
  /** Opens a web address. */
  | { type: 'url'; url: string };

/** The value a "set" action gives. */
export type ActionValue =
  | { mode: 'value'; value: CellValue }
  | { mode: 'clear' }
  /** A date: today, or some days from it. */
  | { mode: 'today'; days?: number }
  /** A date and time: right now. */
  | { mode: 'now' }
  /** A checkbox: flipped. */
  | { mode: 'toggle' }
  /** A number: raised (or lowered) by an amount. */
  | { mode: 'add'; by: number };

/** A rule: when a row is added or a value changes, do something. */
export interface Automation {
  id: string;
  name: string;
  type: 'added' | 'changed';
  config: {
    /** Off rules are kept but don't run. */
    off?: boolean;
    /** "changed": which property, and (optionally) the value it changed to. */
    prop?: string;
    to?: string | boolean | null;
    actions: DbAction[];
  };
  sortKey: string;
}

export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  config: PropertyConfig;
  sortKey: string;
}

export type ViewType = 'table' | 'board' | 'gallery' | 'list' | 'calendar' | 'chart' | 'timeline' | 'form';

export type CalcFn =
  | 'none'
  | 'count'
  | 'countValues'
  | 'countEmpty'
  | 'countUnique'
  | 'percentFilled'
  | 'percentEmpty'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  | 'checked'
  | 'unchecked'
  | 'percentChecked'
  | 'earliest'
  | 'latest';

export interface FilterRule {
  id: string;
  prop: string;
  op: string;
  value?: unknown;
}

export interface SortRule {
  prop: string;
  dir: 'asc' | 'desc';
}

export interface ViewConfig {
  filters?: FilterRule[];
  /** Whether rows must match every filter or any of them. */
  match?: 'all' | 'any';
  sorts?: SortRule[];
  /** Property to group by (a board's columns). */
  group?: string | null;
  /** Group keys folded away (table) or hidden (board). */
  collapsed?: string[];
  hideEmptyGroups?: boolean;
  /** Properties not shown in this view. */
  hidden?: string[];
  /** Properties shown on cards (board, gallery, list), when not all. */
  shown?: string[];
  /** Table column widths. */
  widths?: Record<string, number>;
  /** Wrap long text in table cells. */
  wrap?: boolean;
  /** Table: where New adds rows (the bottom unless set). */
  newRows?: 'top' | 'bottom';
  /** Table: keep the leading columns in place through this property (null: none). */
  freezeThrough?: string | null;
  /** The summary under each table column. */
  calc?: Record<string, CalcFn>;
  /** Gallery and board cards. */
  cardSize?: 'small' | 'medium' | 'large';
  /** Gallery: what fills a card's top ("page": the first image in it, or a files property). */
  cover?: string;
  /** Calendar and timeline: which date property places rows. */
  dateProp?: string;
  /** Timeline: a second date property that ends each bar (else the date's own end). */
  endProp?: string | null;
  /** Timeline: how much time one column is. */
  scale?: 'day' | 'week' | 'month' | 'quarter';
  /** Timeline: show the list of titles beside the bars. */
  showTable?: boolean;
  /** Sub-items: shown under their parent (default), or as plain rows. */
  subItems?: 'nested' | 'flat';
  /** The template new rows from this view start from ('' for an empty row). */
  template?: string;
  /** Form: its heading, a note under it, and the fields to fill in. */
  form?: {
    title?: string;
    intro?: string;
    fields: { prop: string; required?: boolean }[];
    submit?: string;
  };
  /** Chart: what to count. */
  chart?: {
    kind: 'bar' | 'donut' | 'line';
    /** Property along the bottom (or the slices). */
    x: string;
    /** Count rows, or sum/average a number property. */
    agg: 'count' | 'sum' | 'average';
    y?: string;
  };
}

export interface DbView {
  id: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  sortKey: string;
}

/** A database's schema; its title and icon are its page's. */
export interface DatabaseSchema {
  id: string;
  description: string;
  properties: Property[];
  views: DbView[];
  automations: Automation[];
}

/** A date property's value: "YYYY-MM-DD", or "YYYY-MM-DDTHH:MM" with a time. */
export interface DateValue {
  start: string;
  end?: string;
}

export type CellValue = string | number | boolean | string[] | DateValue | null;

export interface DbRow {
  /** The row's page id. */
  id: string;
  dbId: string;
  sortKey: string;
  number: number;
  cells: Record<string, CellValue>;
  /** The first image in the row's page (a gallery card's picture). */
  cover?: string | null;
  /** A template new rows can start from, not a row of its own. */
  template?: boolean;
}

export interface NewRow {
  title: string;
  icon?: string;
  sortKey: string;
  cells: Record<string, CellValue>;
  template?: boolean;
  /** A template whose body and tags the row starts with. */
  fromTemplate?: string;
}

export interface CreatedRow {
  page: PageMeta;
  row: DbRow;
}
