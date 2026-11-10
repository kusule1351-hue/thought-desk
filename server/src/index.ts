/**
 * The relay for live sessions: one Durable Object per session passes both
 * people's edits and cursors between them (Yjs over a WebSocket). It keeps
 * nothing: when everyone has left, the room is gone. Each person's app keeps
 * the session's state, so reconnecting loses nothing. Only the two people in
 * an active session get in (see auth.ts), and they stay only while their app
 * keeps showing a fresh sign-in, each checked again, so an ended session or
 * a sign-out doesn't linger.
 */

import { routePartykitRequest, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import { authorize, isLocal, PROTOCOL, tokenFrom } from './auth';
import { handleSync, type SyncEnv } from './sync';

export { Vault } from './vault';

interface Env extends SyncEnv {
  Page: DurableObjectNamespace<Page>;
}

/** Who connected, as the Worker checked it (set by the Worker, never by the client). */
const USER = 'x-td-user';
const LOCAL = 'x-td-local';
/** The largest message passed on: a whole long page pasted at once fits. */
const MAX_MESSAGE = 4 * 1024 * 1024;
/** Connections one person may have in a room (the app needs one). */
const PER_PERSON = 3;
/** A sign-in token lasts a minute; the app sends a fresh one every 45 seconds
 *  ("token:<token>"). A connection that hasn't shown one for this long is let go. */
const STALE = 120_000;
/** How often a room looks for those, and the most often it checks one connection's token. */
const RECHECK = 60_000;
const RENEW_AT_MOST = 10_000;

interface Who {
  user: string;
  /** From this computer (tests). */
  local: boolean;
  /** When its sign-in was last shown to be good. */
  renewed: number;
  /** When a fresh token last came in. */
  asked: number;
}

export class Page extends YServer<Env> {
  #who = new Map<string, Who>();
  #recheck: ReturnType<typeof setInterval> | null = null;

  onConnect(conn: Connection, ctx: ConnectionContext) {
    const user = ctx.request.headers.get(USER);
    if (!user) return conn.close(4001, 'Sign in first');
    if ([...this.#who.values()].filter((w) => w.user === user).length >= PER_PERSON) return conn.close(4008, 'Too many connections');
    this.#who.set(conn.id, { user, local: ctx.request.headers.get(LOCAL) === '1', renewed: Date.now(), asked: 0 });
    this.#recheck ??= setInterval(() => this.#check(), RECHECK);
    return super.onConnect(conn, ctx);
  }

  onMessage(conn: Connection, message: WSMessage) {
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_MESSAGE) return conn.close(1009, 'Message too big');
    return super.onMessage(conn, message);
  }

  /** A fresh sign-in from the app: checked like the first, session and all. */
  onCustomMessage(conn: Connection, message: string) {
    const who = this.#who.get(conn.id);
    if (!who || !message.startsWith('token:') || Date.now() - who.asked < RENEW_AT_MOST) return;
    who.asked = Date.now();
    void this.#renew(conn, who, message.slice('token:'.length));
  }

  onClose(conn: Connection, code: number, reason: string, wasClean: boolean) {
    this.#who.delete(conn.id);
    if (!this.#who.size) {
      clearInterval(this.#recheck);
      this.#recheck = null;
    }
    return super.onClose(conn, code, reason, wasClean);
  }

  async #renew(conn: Connection, who: Who, token: string) {
    // Not answered (Supabase unreachable): the next one may be, and STALE decides.
    const verdict = await authorize(token, this.name, who.local, this.env).catch(() => null);
    if (!verdict) return;
    if (!verdict.ok && verdict.status === 403) {
      // The session is over, or the two are no longer friends: the room closes.
      for (const c of this.getConnections()) c.close(4003, verdict.reason);
    } else if (!verdict.ok) conn.close(4001, verdict.reason);
    else if (verdict.userId !== who.user) conn.close(4001, 'Signed in as someone else');
    else who.renewed = Date.now();
  }

  /** Lets go of connections whose sign-in hasn't been renewed (the app
   *  reconnects with a fresh one, if it still has one). */
  #check() {
    for (const conn of this.getConnections()) {
      const who = this.#who.get(conn.id);
      if (who && Date.now() - who.renewed > STALE) conn.close(4001, 'Your sign-in has expired: sign in again');
    }
  }
}

const ROOM = /^\/parties\/page\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/sync' || url.pathname.startsWith('/sync/')) return handleSync(request, env);
    if (url.pathname === '/') return new Response('Thought Desk live sessions', { headers: { 'content-type': 'text/plain' } });
    const room = ROOM.exec(url.pathname)?.[1];
    if (!room) return new Response('Not found', { status: 404 });
    const token = tokenFrom(request.headers.get('Sec-WebSocket-Protocol'));
    const local = isLocal(request);
    const verdict = await authorize(token, room, local, env).catch((e) => {
      console.error('Could not check a sign-in', e);
      return null;
    });
    if (!verdict) return new Response('Could not check your sign-in. Try again in a moment.', { status: 503 });
    if (!verdict.ok) return new Response(verdict.reason, { status: verdict.status });

    // The room learns who this is from here alone: these overwrite anything the client sent.
    const headers = new Headers(request.headers);
    headers.delete('Sec-WebSocket-Protocol');
    headers.set(USER, verdict.userId);
    headers.set(LOCAL, local ? '1' : '0');
    const res = await routePartykitRequest(new Request(request, { headers }), env as unknown as Record<string, unknown>);
    if (!res) return new Response('Not found', { status: 404 });
    if (res.status !== 101) return res;
    // The browser only takes the socket if the relay picks one of the subprotocols it offered.
    const out = new Headers(res.headers);
    out.set('Sec-WebSocket-Protocol', PROTOCOL);
    return new Response(null, { status: 101, webSocket: res.webSocket, headers: out });
  },
} satisfies ExportedHandler<Env>;
