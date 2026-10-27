/**
 * Live sessions: two friends writing one page together. The host's page is
 * the one shared; the guest gets a page of their own that fills in as they
 * work, and both keep their page when the session ends. Nothing else is
 * shared: not other pages, not files.
 *
 * Invites and requests go through the cloud (cloud/); the writing goes
 * through the relay (server/) as a Yjs document that merges both people's
 * edits, which the editor reads and writes instead of the page body (it
 * still saves the body, for search, exports and the rest). The relay keeps
 * nothing; each side keeps the document's state locally (page_yjs), so
 * reconnecting, or restarting the app mid-session, loses and repeats nothing.
 *
 * A session belongs to its tab, not to an editor: switching tabs keeps you
 * in it, and closing the tab ends it.
 */

import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';
import { Awareness } from 'y-protocols/awareness';
import { untrack } from 'svelte';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { account } from './account.svelte';
import { api } from './api';
import { cloud, type Friend, type LiveSession } from './cloud';
import { buildExtensions } from './editor/extensions';
import { announce, friends, oneAtATime } from './friends.svelte';
import { t, type Params, type TextKey } from './i18n';
import { fmt } from './i18n/format';
import type { JNode } from './markdown';
import { docOf } from './page-actions';
import { prefs } from './prefs.svelte';
import { store } from './store.svelte';
import { tabs } from './tabs.svelte';
import { ui } from './ui.svelte';

/** The relay: VITE_COWORK_URL, a local one while developing, the one a test
 *  sets, or ours (the only one the app's content security policy allows). */
function relayHost(): string {
  const test = (window as { __coworkHost?: string }).__coworkHost;
  const url = test ?? (import.meta.env.VITE_COWORK_URL as string | undefined) ?? (import.meta.env.DEV ? 'localhost:8787' : 'relay.thoughtdesk.org');
  return url.replace(/^\w+:\/\//, '').replace(/\/$/, '');
}

/** The subprotocol the relay picks; the sign-in rides as the second one (server/src/auth.ts). */
const RELAY_PROTOCOL = 'thoughtdesk';

/** The editor's field in the document, and the map that holds the title. */
const FIELD = 'default';
const META = 'meta';
/** How long after an edit the document's state is kept on this computer. */
const SAVE_DELAY = 600;
/** Invites and requests older than this have lapsed. */
const PENDING_FOR = 3600_000;
/** How often sessions are checked anyway (besides live updates). */
const EVERY = 60_000;
/** A session lets go of the relay after this long with no edits from either
 *  side and nobody at the page here, since an open room is paid for by the
 *  second (a test sets a shorter one). */
const IDLE_AFTER = 10 * 60_000;
const idleAfter = () => (window as { __coworkIdleMs?: number }).__coworkIdleMs ?? IDLE_AFTER;
/** Wake-ups to the other person's app go at most this often. */
const NUDGE_EVERY = 10_000;
/** A sign-in token lasts a minute, and the relay lets a connection go if it
 *  hasn't seen a fresh one for two (server/src/index.ts), so one goes to it
 *  over the connection this often. */
const RENEW_EVERY = 45_000;
/** What the other side can put here: a title, a name, and the whole page's
 *  state. Past the last, the session ends rather than keep growing. */
const MAX_TITLE = 500;
const MAX_NAME = 50;
const MAX_DOC = 32 * 1024 * 1024;
/** Their colour reaches styles, so only a #rrggbb code gets through. */
const safeColor = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : '#8e8e93');

/** How long someone's name shows by their cursor after they type or move. */
const NAME_FOR = 2500;

/** Cursor colours: hex (the cursor extension takes only that), dark enough for white names in either theme. */
const CURSOR_COLORS = ['#e5484d', '#e2620e', '#2b9a66', '#0d9488', '#0b7ee8', '#3e63dd', '#8e4ec6', '#d6409f'];

/** A message without plural forms. */
type SentenceKey = TextKey;

export interface Person {
  id: number;
  name: string;
  color: string;
  me: boolean;
}

let schema: ReturnType<typeof getSchema> | null = null;

/** A page body's words, for search (a block per line). */
function textOf(node: JNode): string {
  if (node.text) return node.text;
  const inner = (node.content ?? []).map(textOf);
  return node.type === 'doc' || node.type?.endsWith('List') || node.type === 'listItem' || node.type === 'taskItem' ? inner.join('\n') : inner.join('');
}

/** One live page here: its document, connection and the people in it. */
export class Session {
  readonly doc = new Y.Doc();
  /** Who's here and where their cursors are. It outlives connections, so the
   *  editor's cursors keep working across reconnects. */
  readonly awareness = new Awareness(this.doc);
  /** id: this copy's Yjs client id, which marks its cursor in the other's editor. */
  readonly user: { name: string; color: string; id: number };
  /** Paused: let go of the relay while nobody writes or is at the page. */
  status = $state<'connecting' | 'live' | 'offline' | 'paused'>('connecting');
  /** Has heard from the relay since opening (so the title is the real one). */
  synced = $state(false);
  people = $state<Person[]>([]);
  /** Holders: the session's tab, and editors showing the page (both panes may). */
  uses = 0;
  #provider: YProvider | null = null;
  #renew: ReturnType<typeof setInterval> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopEffects: () => void = () => {};
  /** The last edit from either side, or sign of someone at the page here. */
  #lastActive = Date.now();
  #idle: ReturnType<typeof setTimeout> | undefined;
  /** Editors showing the page now, and their elements. */
  #views = 0;
  #hosts = new Set<HTMLElement>();
  /** When each other person's name, shown by their cursor, fades again. */
  #names = new Map<number, ReturnType<typeof setTimeout>>();
  /** Wake-ups to and from the other person's app (through the cloud). */
  #nudges: { send(): void; stop(): void } | null = null;
  #nudged = 0;
  /** Past MAX_DOC: the session is being ended. */
  #tooBig = false;
  /** The other person is writing, or back: reconnect so the two catch up. */
  #woken = () => {
    this.#lastActive = Date.now();
    if (this.status === 'paused') this.#resume(false);
  };
  // A lost network can leave a WebSocket that never reports closing, so the
  // connection is dropped as soon as the system says it's offline, and a
  // new one made when it's back (unless the session has gone quiet).
  #offline = () => {
    this.#drop();
    if (this.status !== 'paused') this.status = 'offline';
  };
  #online = () => {
    if (this.#provider || this.status === 'paused') return;
    if (Date.now() - this.#lastActive >= idleAfter()) this.status = 'paused';
    else this.#connect();
  };
  /** The window back in front with the page on screen: someone's here. */
  #back = () => {
    if (this.#views && !document.hidden) this.touch();
  };

  constructor(
    readonly pageId: string,
    readonly room: string,
  ) {
    this.user = { name: account.name, color: CURSOR_COLORS[this.doc.clientID % CURSOR_COLORS.length], id: this.doc.clientID };
    // Cursors change in the middle of anything (a blur while the page redraws):
    // update who's here just after, never during.
    this.awareness.on('change', ({ added, updated }: { added: number[]; updated: number[] }, origin: unknown) => {
      queueMicrotask(() => this.#readPeople());
      if (origin !== 'local') for (const id of [...added, ...updated]) if (id !== this.doc.clientID) this.#showName(id);
    });
    this.awareness.setLocalStateField('user', this.user);
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      this.#scheduleSave();
      // An edit from either side keeps the connection; one made here while
      // paused (a new title, say) brings it back.
      this.#lastActive = Date.now();
      if (this.status === 'paused') this.#resume();
      // Writing here while the other person's app has let go: wake it.
      else if (origin !== this.#provider && origin !== 'kept' && !this.people.some((p) => !p.me)) this.#nudge();
    });

    // The title: theirs comes in, ours goes out once we've heard theirs.
    const meta = this.doc.getMap<string>(META);
    meta.observe((e) => {
      const title = meta.get('title');
      if (e.transaction.local || typeof title !== 'string') return;
      const theirs = title.slice(0, MAX_TITLE);
      if (store.byId.get(pageId)?.title !== theirs) store.update(pageId, { title: theirs });
    });
    this.#stopEffects = $effect.root(() => {
      $effect(() => {
        const title = store.byId.get(pageId)?.title;
        if (title === undefined || (!this.synced && !meta.has('title'))) return;
        if (meta.get('title') !== title) meta.set('title', title);
      });
    });
  }

  #connect() {
    let token = '';
    const provider = new YProvider(relayHost(), this.room, this.doc, {
      party: 'page',
      connect: false,
      disableBc: true,
      awareness: this.awareness,
      // Asked again before every reconnect, so a refreshed sign-in is used...
      params: async () => {
        token = (await (await cloud()).accessToken()) ?? '';
        return {};
      },
      // ...and sent as a subprotocol, not in the address, so it stays out of logs.
      WebSocketPolyfill: class extends WebSocket {
        constructor(url: string | URL) {
          super(url, token ? [RELAY_PROTOCOL, token] : [RELAY_PROTOCOL]);
        }
      },
    });
    provider.on('status', ({ status }: { status: string }) => {
      if (this.#provider !== provider) return;
      this.status = status === 'connected' ? 'live' : status === 'connecting' && this.status !== 'offline' ? 'connecting' : 'offline';
    });
    provider.on('sync', (synced: boolean) => {
      if (synced && this.#provider === provider) this.synced = true;
    });
    clearInterval(this.#renew);
    this.#renew = setInterval(async () => {
      const fresh = await (await cloud()).accessToken().catch(() => null);
      if (fresh && this.#provider === provider && provider.wsconnected) provider.sendMessage('token:' + fresh);
    }, RENEW_EVERY);
    this.#provider = provider;
    this.status = 'connecting';
    this.#armIdle();
    void provider.connect();
  }

  #drop() {
    const provider = this.#provider;
    // Cleared first, so the closing connection's last word is ignored.
    this.#provider = null;
    clearInterval(this.#renew);
    provider?.destroy();
  }

  /** Pauses once nothing has happened for a while (looked at when the time is up). */
  #armIdle() {
    clearTimeout(this.#idle);
    const left = idleAfter() - (Date.now() - this.#lastActive);
    if (left <= 0) this.#pause();
    else this.#idle = setTimeout(() => this.#armIdle(), left);
  }

  /** Lets go of the relay. The other person sees you as away; whatever they
   *  write meanwhile merges in when you're back. */
  #pause() {
    clearTimeout(this.#idle);
    this.#drop();
    this.status = 'paused';
  }

  /** Reconnects, and (unless woken by them) wakes the other side so the two catch up. */
  #resume(nudge = true) {
    if (navigator.onLine) this.#connect();
    else this.status = 'offline';
    if (nudge) this.#nudge(true);
  }

  /** Coming back always wakes the other side; writing alone does so now and then. */
  #nudge(now = false) {
    if (!this.#nudges || (!now && Date.now() - this.#nudged < NUDGE_EVERY)) return;
    this.#nudged = Date.now();
    this.#nudges.send();
  }

  /** Someone's at the page: keeps the connection, or brings it back. */
  touch() {
    this.#lastActive = Date.now();
    if (this.status === 'paused') this.#resume();
  }

  /** An editor showing the page. Typing, clicking, scrolling or pointing in
   *  it counts as being here. Returns the way to stop watching. */
  watch(el: HTMLElement): () => void {
    const here = () => this.touch();
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'focusin'];
    for (const type of events) el.addEventListener(type, here, { passive: true });
    this.#views++;
    this.#hosts.add(el);
    this.touch();
    return () => {
      for (const type of events) el.removeEventListener(type, here);
      this.#views--;
      this.#hosts.delete(el);
    };
  }

  /** Someone typed or moved: their name shows by their cursor for a moment,
   *  then fades, so it doesn't sit over the words above. */
  #showName(id: number) {
    const mark = (on: boolean) => {
      for (const host of this.#hosts) host.querySelector(`.collaboration-carets__caret[data-who="${id}"]`)?.classList.toggle('awake', on);
    };
    clearTimeout(this.#names.get(id));
    // After the editor has drawn the cursor where it now is.
    requestAnimationFrame(() => mark(true));
    this.#names.set(id, setTimeout(() => (mark(false), this.#names.delete(id)), NAME_FOR));
  }

  /** Whether someone's name is showing: the editor redraws their cursor as
   *  they type, and a cursor drawn then starts with its name (extensions.ts). */
  isAwake(id: number): boolean {
    return this.#names.has(id);
  }

  /** Reads the state kept here, then connects. */
  async start() {
    const kept = await api.getPageYjs(this.pageId);
    if (kept.byteLength) Y.applyUpdate(this.doc, new Uint8Array(kept), 'kept');
    window.addEventListener('offline', this.#offline);
    window.addEventListener('online', this.#online);
    window.addEventListener('focus', this.#back);
    document.addEventListener('visibilitychange', this.#back);
    try {
      this.#nudges = (await cloud()).nudges(this.room, this.#woken);
    } catch {
      /* no wake-ups: the session still works while both are at it */
    }
    if (navigator.onLine) this.#connect();
    else this.status = 'offline';
  }

  #readPeople() {
    const me = this.doc.clientID;
    this.people = [...this.awareness.getStates()]
      .filter(([, s]) => s.user)
      .map(([id, s]) => ({ id, name: String(s.user.name ?? t('social.session.guest')).slice(0, MAX_NAME), color: safeColor(s.user.color), me: id === me }))
      .sort((a, b) => Number(b.me) - Number(a.me) || fmt.collator({}).compare(a.name, b.name));
    this.#ownColor();
  }

  /** Two people with the same colour can't be told apart, so the one who
   *  came later (the higher client id) takes a colour nobody here has. The
   *  editor shares this.user, so a cursor drawn later keeps the new one. */
  #ownColor() {
    const me = this.doc.clientID;
    const others = this.people.filter((p) => !p.me);
    if (!others.some((p) => p.id < me && p.color.toLowerCase() === this.user.color.toLowerCase())) return;
    const taken = new Set(others.map((p) => p.color.toLowerCase()));
    const free = CURSOR_COLORS.find((c) => !taken.has(c));
    if (!free) return;
    this.user.color = free;
    // A new object: awareness sends only what differs from the last state.
    this.awareness.setLocalStateField('user', { ...this.user });
  }

  #scheduleSave() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.save(), SAVE_DELAY);
  }

  /** Keeps the document's state on this computer. */
  async save() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const state = Y.encodeStateAsUpdate(this.doc);
    if (state.byteLength > MAX_DOC) {
      // Far past any real page: stop here rather than let it keep growing.
      if (!this.#tooBig) {
        this.#tooBig = true;
        this.#drop();
        ui.toast(t('social.session.tooBig'));
        void cowork.end(this.room);
      }
      return;
    }
    try {
      await api.savePageYjs(this.pageId, state);
    } catch (e) {
      // The session ended (or the page was deleted) meanwhile: nothing to keep.
      if (store.byId.get(this.pageId)?.sharedRoom) ui.error(e);
    }
  }

  /** The page as it is in the document now (null if nothing ever arrived). */
  body(): { content: string; text: string } | null {
    const fragment = this.doc.getXmlFragment(FIELD);
    if (!fragment.length && !this.synced) return null;
    const json = yXmlFragmentToProsemirrorJSON(fragment) as JNode;
    return { content: JSON.stringify(json), text: textOf(json) };
  }

  async destroy() {
    window.removeEventListener('offline', this.#offline);
    window.removeEventListener('online', this.#online);
    window.removeEventListener('focus', this.#back);
    document.removeEventListener('visibilitychange', this.#back);
    clearTimeout(this.#idle);
    clearInterval(this.#renew);
    for (const timer of this.#names.values()) clearTimeout(timer);
    this.#nudges?.stop();
    this.#stopEffects();
    if (this.#timer !== undefined) await this.save();
    this.#provider?.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

class Cowork {
  /** Live pages here, by page id. */
  sessions = $state<Record<string, Session>>({});
  /** Your invites, requests and sessions (the last day's), from the cloud. */
  rows = $state<LiveSession[]>([]);

  /** Invites and requests waiting for you to answer. */
  incoming = $derived.by(() => {
    const me = account.user?.id;
    const now = Date.now();
    return this.rows.filter((r) => r.status === 'pending' && now - r.createdAt < PENDING_FOR && (r.kind === 'invite' ? r.guestId : r.hostId) === me);
  });
  /** Yours, waiting for them. */
  outgoing = $derived.by(() => {
    const me = account.user?.id;
    const now = Date.now();
    return this.rows.filter((r) => r.status === 'pending' && now - r.createdAt < PENDING_FOR && (r.kind === 'invite' ? r.hostId : r.guestId) === me);
  });

  /** Sessions this app holds open (session id → page id). */
  #held = new Map<string, string>();
  #busy = new Set<string>();
  #following: string | null = null;
  #stop: (() => void) | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #loaded = false;

  /** The other person in a session. */
  other(row: LiveSession): Friend | undefined {
    const id = row.hostId === account.user?.id ? row.guestId : row.hostId;
    return friends.list.find((f) => f.profile.id === id);
  }

  /** Their name, else their @username; null when they aren't among your friends (any more). */
  knownName(row: LiveSession): string | null {
    const f = this.other(row);
    return f ? f.profile.displayName || `@${f.profile.username}` : null;
  }

  /** The other person shown on their own (a name in a list): their name, else "Your friend". */
  otherName(row: LiveSession): string {
    return this.knownName(row) ?? t('social.yourFriend');
  }

  /** A sentence about the other person: `named`, given their {name}, or
   *  `unnamed`, worded with "your friend" its own way, when it isn't known. */
  aboutOther(row: LiveSession, named: SentenceKey, unnamed: SentenceKey, params: Params = {}): string {
    const name = this.knownName(row);
    return name === null ? t(unnamed, params) : t(named, { ...params, name });
  }

  /** The live session a page is in, if any. */
  liveFor(pageId: string): LiveSession | undefined {
    const room = store.byId.get(pageId)?.sharedRoom;
    return room ? this.rows.find((r) => r.id === room && r.status === 'active') : undefined;
  }

  #pageOf(room: string) {
    return [...store.byId.values()].find((p) => p.sharedRoom === room && !p.deletedAt);
  }

  // ------------------------------------------------------------ following

  /** Follows whoever is signed in; closing a live tab ends its session. */
  init() {
    tabs.onClose = (tab) => {
      if (tab.live) void this.end(tab.live);
    };
    account.beforeSignOut.push(() => this.#leaveAll());
    $effect.root(() => {
      $effect(() => {
        const id = account.user?.id ?? null;
        const ready = !!account.profile?.username;
        untrack(() => void this.#follow(ready ? id : null));
      });
    });
  }

  async #follow(id: string | null) {
    if (id === this.#following) return;
    this.#following = id;
    this.#stop?.();
    this.#stop = null;
    clearInterval(this.#timer);
    this.rows = [];
    this.#loaded = false;
    if (!id) return;
    const c = await cloud();
    if (this.#following !== id) return;
    this.#stop = c.subscribe((change) => change === 'sessions' && void this.refresh());
    this.#timer = setInterval(() => void this.refresh(), EVERY);
    await this.refresh();
  }

  /** Reads your sessions and catches up: starts the ones that became live,
   *  finishes the ones that ended, and tells you what's new. */
  refresh = oneAtATime(() => this.#refresh());

  async #refresh() {
    const following = this.#following;
    const before = new Map(this.rows.map((r) => [r.id, r]));
    const first = !this.#loaded;
    let rows: LiveSession[];
    try {
      rows = await (await cloud()).sessions();
    } catch (e) {
      console.warn('Live sessions: could not refresh', e);
      return;
    }
    // Signed out, or someone else signed in, meanwhile.
    if (this.#following !== following) return;
    this.rows = rows;
    this.#loaded = true;
    const me = account.user?.id;
    for (const row of this.rows) {
      const was = before.get(row.id);
      const mine = (row.kind === 'invite' ? row.hostId : row.guestId) === me;
      if (row.status === 'pending' && !was && !first && !mine) {
        if (row.kind === 'invite')
          announce(this.aboutOther(row, 'social.session.invitesYou', 'social.session.invitesYouFriend'), t('social.session.quotedTitle', { title: row.title || t('common.untitled') }), {
            label: t('social.session.join'),
            run: () => void this.join(row).catch((e) => ui.error(e)),
          });
        else
          announce(this.aboutOther(row, 'social.session.wantsTo', 'social.session.wantsToFriend'), t('social.session.pickPage'), {
            label: t('social.session.openFriends'),
            run: () => store.go('friends'),
          });
      }
      if (row.status === 'active' && !this.#held.has(row.id)) {
        const fresh = !first && was?.status !== 'active';
        // They said yes: to your invite, or to your request, with a page of theirs.
        if (fresh && was && mine) {
          const title = row.title || t('common.untitled');
          announce(
            row.kind === 'invite'
              ? this.aboutOther(row, 'social.session.joined', 'social.session.joinedFriend', { title })
              : this.aboutOther(row, 'social.session.shared', 'social.session.sharedFriend', { title }),
          );
        }
        void this.#start(row, fresh);
      }
      if ((row.status === 'ended' || row.status === 'declined' || row.status === 'cancelled') && (this.#held.has(row.id) || this.#pageOf(row.id) || prefs.coworkPages[row.id])) {
        if (was && was.status !== row.status) {
          if (row.status === 'ended') ui.toast(this.aboutOther(row, 'social.session.ended', 'social.session.endedFriend'));
          else if (row.status === 'declined' && mine) ui.toast(this.aboutOther(row, 'social.session.saidNo', 'social.session.saidNoFriend'));
        }
        void this.#finish(row.id);
      }
    }
    // A page left live by a session that's gone (it ended while the app was closed).
    if (first)
      for (const p of store.pages)
        if (p.sharedRoom && !this.rows.some((r) => r.id === p.sharedRoom && r.status === 'active')) void this.#finish(p.sharedRoom);
  }

  // ------------------------------------------------------------- actions

  /** Invites a friend to write a page with you. */
  async invite(friend: Friend, pageId: string) {
    const page = store.byId.get(pageId);
    if (!page || page.deletedAt) throw new Error(t('social.session.errors.pageGone'));
    if (page.kind === 'database') throw new Error(t('social.session.errors.database'));
    if (page.sharedRoom) throw new Error(t('social.session.errors.thisPageLive'));
    if (Object.values(prefs.coworkPages).includes(pageId)) throw new Error(t('social.session.errors.alreadyInvited'));
    const row = await (await cloud()).createSession({ kind: 'invite', friendId: friend.profile.id, title: page.title || t('common.untitled') });
    prefs.coworkPages = { ...prefs.coworkPages, [row.id]: pageId };
    this.rows = [row, ...this.rows];
  }

  /** Asks a friend to write together; they pick the page. */
  async ask(friend: Friend) {
    const row = await (await cloud()).createSession({ kind: 'request', friendId: friend.profile.id, title: '' });
    this.rows = [row, ...this.rows];
  }

  /** Joins a session you were invited to: a new tab opens on both sides. */
  async join(row: LiveSession) {
    await (await cloud()).respondSession(row.id, true);
    await this.refresh();
  }

  /** Accepts a request on one of your pages. */
  async share(row: LiveSession, pageId: string) {
    const page = store.byId.get(pageId);
    if (!page) throw new Error(t('social.session.errors.pageGone'));
    if (page.sharedRoom) throw new Error(t('social.session.errors.thatPageLive'));
    prefs.coworkPages = { ...prefs.coworkPages, [row.id]: pageId };
    await (await cloud()).respondSession(row.id, true, page.title || t('common.untitled'));
    await this.refresh();
  }

  async decline(row: LiveSession) {
    await (await cloud()).respondSession(row.id, false);
    await this.refresh();
  }

  /** Withdraws your invite or request. */
  async withdraw(row: LiveSession) {
    await (await cloud()).endSession(row.id);
    await this.refresh();
  }

  /** Ends a live session (both keep the page). */
  async end(room: string) {
    await (await cloud())
      .endSession(room)
      .catch((e) => console.warn('Live sessions: could not end it in the cloud', e));
    await this.#finish(room);
    await this.refresh();
  }

  async #leaveAll() {
    for (const room of [...this.#held.keys()]) await this.end(room);
  }

  // ------------------------------------------------------- start / finish

  /** Opens a live session here: on the host's page (made into the shared
   *  document), or a new page for the guest; then its tab. */
  async #start(row: LiveSession, focus: boolean) {
    if (this.#busy.has(row.id) || this.#held.has(row.id)) return;
    this.#busy.add(row.id);
    try {
      const me = account.user?.id;
      if (!me) return;
      let page = this.#pageOf(row.id);
      if (!page) {
        if (row.hostId === me) {
          const chosen = prefs.coworkPages[row.id];
          const p = chosen ? store.byId.get(chosen) : undefined;
          if (!p || p.deletedAt) {
            await (await cloud()).endSession(row.id).catch(() => {});
            ui.toast(t('social.session.pageGoneEnded'));
            return;
          }
          await this.#seed(p.id, row.id);
        } else {
          const made = await api.createPage(null, null, row.title || t('social.session.sharedPage'), '');
          await api.setPageShared(made.id, row.id);
        }
        await store.refresh();
        page = this.#pageOf(row.id);
        if (!page) return;
      }
      if (prefs.coworkPages[row.id]) {
        const rest = { ...prefs.coworkPages };
        delete rest[row.id];
        prefs.coworkPages = rest;
      }
      await this.open(page.id, row.id);
      this.#held.set(row.id, page.id);
      // A new tab for the session, on both sides (after a restart, the tab
      // that was already live for it).
      const tab = tabs.list.find((x) => x.live === row.id);
      if (tab) {
        if (focus) tabs.activate(tab.id);
      } else tabs.openPage(page.id, { live: row.id, focus });
    } catch (e) {
      ui.error(e);
    } finally {
      this.#busy.delete(row.id);
    }
  }

  /** Makes a page the shared document of a session, from what it has now. */
  async #seed(pageId: string, room: string) {
    window.dispatchEvent(new Event('td:flush'));
    await store.flush();
    const page = await api.getPage(pageId);
    const doc = new Y.Doc();
    schema ??= getSchema(buildExtensions({ onMenu: () => {} }));
    prosemirrorJSONToYXmlFragment(schema, docOf(page.content), doc.getXmlFragment(FIELD));
    doc.getMap<string>(META).set('title', page.title);
    await api.setPageShared(pageId, room);
    await api.savePageYjs(pageId, Y.encodeStateAsUpdate(doc));
    doc.destroy();
  }

  /** Ends a session here: the page keeps what was written and becomes an
   *  ordinary page again; its tab stays, as an ordinary tab. */
  async #finish(room: string) {
    if (this.#busy.has(room)) return;
    this.#busy.add(room);
    try {
      const pageId = this.#held.get(room) ?? this.#pageOf(room)?.id;
      if (pageId) {
        const s = this.sessions[pageId];
        const body = s?.body();
        if (body) store.update(pageId, body, { immediate: true });
        window.dispatchEvent(new Event('td:flush'));
        await store.flush();
        if (this.#held.get(room) === pageId) {
          this.#held.delete(room);
          this.release(pageId);
        }
        if (store.byId.get(pageId)?.sharedRoom === room) await api.setPageShared(pageId, null);
        await store.refresh();
      }
      for (const tab of tabs.list) if (tab.live === room) tab.live = null;
      if (prefs.coworkPages[room]) {
        const rest = { ...prefs.coworkPages };
        delete rest[room];
        prefs.coworkPages = rest;
      }
    } catch (e) {
      console.warn('Live sessions: could not finish', e);
    } finally {
      this.#busy.delete(room);
    }
  }

  // --------------------------------------------------- the editor's side

  /** The session for a live page (its tab holds one, each editor showing it another). */
  async open(pageId: string, room: string): Promise<Session> {
    let s = this.sessions[pageId];
    if (!s || s.room !== room) {
      s = new Session(pageId, room);
      this.sessions[pageId] = s;
      await s.start();
    }
    s.uses++;
    return s;
  }

  release(pageId: string) {
    const s = this.sessions[pageId];
    if (!s || --s.uses > 0) return;
    delete this.sessions[pageId];
    void s.destroy();
  }

  /** Whether a page is live here now (its editor should write together).
   *  Reactive: editors remount when it changes. */
  isLive(pageId: string): boolean {
    const s = this.sessions[pageId];
    return !!s && store.byId.get(pageId)?.sharedRoom === s.room;
  }
}

export const cowork = new Cowork();
