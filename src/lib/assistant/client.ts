/**
 * The assistant's line to its model: the app's own server (server/src/assistant.ts),
 * which holds the key. The server speaks Anthropic's own protocol, so
 * Anthropic's library is the client, pointed there and signed in with the
 * person's session instead of a key. The library is loaded when the assistant
 * is first used, not at start-up.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { cloud } from '../cloud';

/** Why the server (or the way to it) turned a request away. */
export type Reason = 'signed-out' | 'closed' | 'off' | 'spent' | 'busy' | 'fast' | 'bad' | 'offline' | 'failed';

export class AssistantError extends Error {
  constructor(
    readonly reason: Reason,
    message: string = reason,
  ) {
    super(message);
  }
}
/** The person stopped it. */
export class Stopped extends Error {}

/** The server's address: the one sync and live sessions use; a test sets its own (`window.__assistantUrl`, development builds only). */
function base(): string {
  const test = import.meta.env.DEV ? (window as { __assistantUrl?: string }).__assistantUrl : undefined;
  if (test) return test.replace(/\/$/, '');
  const host = ((import.meta.env.VITE_COWORK_URL as string | undefined) ?? (import.meta.env.DEV ? 'localhost:8787' : 'relay.thoughtdesk.org')).replace(/^\w+:\/\//, '').replace(/\/$/, '');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  return `${local ? 'http' : 'https'}://${host}`;
}

async function token(): Promise<string> {
  let jwt: string | null;
  try {
    jwt = await (await cloud()).accessToken();
  } catch {
    throw new AssistantError('offline');
  }
  if (!jwt) throw new AssistantError('signed-out');
  return jwt;
}

const REASONS: Reason[] = ['signed-out', 'closed', 'off', 'spent', 'busy', 'fast', 'bad', 'failed'];

export interface Ask {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

/**
 * One request: the conversation so far, answered. `onText` gets the answer's
 * words as they are written. The model and the answer's length are the
 * server's to choose; what is named here is only what the library asks for.
 */
export async function ask(body: Ask, signal: AbortSignal, onText: (delta: string) => void): Promise<Anthropic.Message> {
  const { default: Client, APIUserAbortError, APIConnectionError, APIError } = await import('@anthropic-ai/sdk');
  const client = new Client({ baseURL: `${base()}/assistant`, authToken: await token(), apiKey: null, maxRetries: 0, dangerouslyAllowBrowser: true });
  if (signal.aborted) throw new Stopped();
  try {
    const stream = client.messages.stream({ model: 'claude-haiku-5-5', max_tokens: 8000, ...body }, { signal });
    stream.on('text', onText);
    return await stream.finalMessage();
  } catch (e) {
    if (e instanceof APIUserAbortError || signal.aborted) throw new Stopped();
    if (e instanceof APIConnectionError) throw new AssistantError('offline');
    if (e instanceof APIError) {
      const said = e.headers?.get('x-td-reason') as Reason | null | undefined;
      const reason: Reason = said && REASONS.includes(said) ? said : e.status === 401 ? 'signed-out' : e.status === 403 ? 'closed' : 'failed';
      throw new AssistantError(reason, e.message);
    }
    throw e;
  }
}

export interface Allowance {
  /** Spent this month and the month's limit, in millionths of a dollar. */
  used: number;
  limit: number;
  /** The server has its key. */
  on: boolean;
}

/** This month's allowance, or null when it can't be asked (signed out, offline, closed). */
export async function allowance(): Promise<Allowance | null> {
  try {
    const res = await fetch(`${base()}/assistant/usage`, { headers: { Authorization: `Bearer ${await token()}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<Allowance>;
    return typeof body.used === 'number' && typeof body.limit === 'number' ? { used: body.used, limit: body.limit, on: body.on !== false } : null;
  } catch {
    return null;
  }
}
