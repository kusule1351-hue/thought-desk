/**
 * A conversation as it is kept on this computer (the notes database, through
 * `api.saveChat`), and how one that was kept is brought back.
 *
 * What is kept is what is shown (the items) and what the model was told and
 * said (the history, which a reopened chat needs to go on). What cannot be
 * kept is anything that was still in the air when the app closed: an answer
 * half written, a change still waiting for a yes, and the way to take a
 * change back. Bringing a chat back settles all of those, so it opens at
 * rest: nothing in it is waiting, and the history is one the model will take.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Item } from './assistant.svelte';

export interface Kept {
  items: Item[];
  history: Anthropic.MessageParam[];
  /** The next item's id. */
  next: number;
}

const VERSION = 1;
/** A chat's name in the list: the first thing asked, on one line. */
export const titleOf = (items: Item[]) => (items.find((i) => i.type === 'ask')?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

export const write = (kept: Kept) => JSON.stringify({ v: VERSION, ...kept });

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** One item as it may be shown again, or null for one this version can't read. */
function settled(raw: unknown): Item | null {
  if (!isObject(raw) || typeof raw.id !== 'number') return null;
  const id = raw.id;
  switch (raw.type) {
    case 'ask':
      return typeof raw.text === 'string' ? { id, type: 'ask', text: raw.text } : null;
    case 'answer':
      return typeof raw.text === 'string' && raw.text.trim() ? { id, type: 'answer', text: raw.text, writing: false } : null;
    case 'read':
      return typeof raw.label === 'string' ? { id, type: 'read', label: raw.label, state: raw.state === 'done' ? 'done' : 'failed' } : null;
    case 'notice':
      return typeof raw.reason === 'string' ? ({ id, type: 'notice', reason: raw.reason } as Item) : null;
    case 'change': {
      if (!isObject(raw.preview) || typeof raw.preview.title !== 'string') return null;
      // Made, taken back, turned down or failed stay as they were. One that was still waiting was never made.
      const state = raw.state === 'done' || raw.state === 'undone' || raw.state === 'failed' ? raw.state : 'declined';
      return {
        id,
        type: 'change',
        kind: raw.kind === 'create' ? 'create' : 'edit',
        preview: raw.preview as unknown as Extract<Item, { type: 'change' }>['preview'],
        state,
        summary: typeof raw.summary === 'string' ? raw.summary : '',
        place: isObject(raw.place) ? (raw.place as unknown as Extract<Item, { type: 'change' }>['place']) : null,
        // The way back was in memory, and went with the app.
        canUndo: false,
      };
    }
    default:
      return null;
  }
}

/**
 * The history as the model will take it: every tool it asked for has an
 * answer. A chat cut off between the model asking and the tools answering
 * gets the answers it lacks, saying so.
 */
function mended(raw: unknown): Anthropic.MessageParam[] {
  const history: Anthropic.MessageParam[] = [];
  if (!Array.isArray(raw)) return history;
  for (const m of raw) {
    if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) continue;
    history.push(m as unknown as Anthropic.MessageParam);
  }
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const asked = m.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use').map((b) => b.id);
    if (!asked.length) continue;
    const next = history[i + 1];
    const answered = new Set(next?.role === 'user' && typeof next.content !== 'string' ? next.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result').map((b) => b.tool_use_id) : []);
    const missing = asked.filter((id) => !answered.has(id)).map((id): Anthropic.ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: id, content: 'The app was closed before this ran.', is_error: true }));
    if (!missing.length) continue;
    if (next?.role === 'user' && typeof next.content !== 'string' && answered.size) next.content = [...missing, ...next.content];
    else history.splice(i + 1, 0, { role: 'user', content: missing });
  }
  return history;
}

/** A kept chat, ready to show and to go on with. Throws for text that isn't one. */
export function read(data: string): Kept {
  const raw: unknown = JSON.parse(data);
  if (!isObject(raw) || raw.v !== VERSION || !Array.isArray(raw.items)) throw new Error('Not a chat this version can read');
  const items = raw.items.map(settled).filter((i): i is Item => i !== null);
  const next = Math.max(typeof raw.next === 'number' ? raw.next : 1, ...items.map((i) => i.id + 1));
  return { items, history: mended(raw.history), next };
}
