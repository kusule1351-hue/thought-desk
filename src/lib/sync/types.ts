/** What the sync commands (src-tauri, docs/sync.md "Inside the app") take and give. Binary is always base64url text. */

export interface SyncStatus {
  enabled: boolean;
  account: string | null;
  ready: boolean;
  cursor: number;
  /** Which synced copy this computer belongs to. */
  wrappedKey?: string | null;
  /** Items that could not be opened here; they are kept. */
  unreadable?: number;
  /** A copy of the notes from before sync was turned on is kept on this computer. */
  backup?: boolean;
}

export interface IngestItem {
  seq: number;
  key: string;
  kind: string;
  data: string;
}

export interface OutRecord {
  entity: string;
  id: string;
  key: string;
  kind: 'r';
  base: number;
  data: string;
}

export interface TextTodo {
  bodies: string[];
  incoming: string[];
}

export interface TextRead {
  /** The document's whole state; empty when this computer has none yet. */
  state: string;
  /** The page's body as stored. */
  content: string;
  updates: { seq: number; kind: string; data: string }[];
}

export interface TextCommit {
  pageId: string;
  /** The body `sync_text_read` returned. Only compared when `content` is given (null otherwise). */
  base: string | null;
  state: string;
  update?: string;
  first?: boolean;
  content?: string;
  text?: string;
  consumed?: number;
}

export interface OutText {
  ref: string | number;
  pageId: string;
  key: string;
  kind: 'y' | 's';
  data: string;
  first?: boolean;
  upto?: number;
}

export interface FileJob {
  id: string;
  stored: string;
  chunks: number;
}

export interface FilesTodo {
  upload: FileJob[];
  download: FileJob[];
  remove: FileJob[];
}
