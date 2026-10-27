/**
 * The real cloud: Supabase, for profiles, friends, sessions and live updates.
 * Signing in is Clerk's (clerk.ts): Supabase trusts the session tokens Clerk
 * issues, and every request carries one. Live updates come as signals over
 * Realtime, which carries no sign-in (see signals).
 */

import { createClient, type PostgrestError } from '@supabase/supabase-js';
import { t } from '../i18n';
import * as clerk from './clerk';
import { ONLINE_FOR, type Cloud, type CloudChange, type CloudUser, type Friend, type LiveSession, type Profile, type Provider } from './types';

/** The project and its publishable key: both public by design (row-level security protects the data). */
export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://nbzojbfkkpeisitbkwpg.supabase.co';
const SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_KEY as string | undefined) ?? 'sb_publishable_6W6p3hj5pIszsSA36NWUbQ_TXB4YwLD';

const PROFILE_COLS = 'id, username, display_name, avatar_url';

const SESSION_COLS = 'id, host, guest, kind, title, status, created_at, updated_at';
interface SessionRow {
  id: string;
  host: string;
  guest: string;
  kind: LiveSession['kind'];
  title: string;
  status: LiveSession['status'];
  created_at: string;
  updated_at: string;
}
const asSession = (r: SessionRow): LiveSession => ({
  id: r.id,
  hostId: r.host,
  guestId: r.guest,
  kind: r.kind,
  title: r.title,
  status: r.status,
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});

const asProfile = (r: { id: string; username: string | null; display_name: string; avatar_url: string | null }): Profile => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
});

/** An error as something to show people (the database's own words, as they come, when it isn't one of these). */
function friendly(e: PostgrestError | Error | null | undefined, fallback = t('social.cloud.somethingWrong')): Error {
  if (!e) return new Error(fallback);
  const code = 'code' in e ? String(e.code ?? '') : '';
  if (code === '23505') return new Error(t('social.cloud.usernameTaken'));
  if (code === '23514') return new Error(t('social.cloud.usernameRule'));
  if (e instanceof TypeError || /fetch/i.test(e.message)) return new Error(t('social.cloud.cloudOffline'));
  return new Error(e.message || fallback);
}

/** The session functions' errors (supabase/README.md) as something to show people. */
function sessionError(e: PostgrestError): Error {
  if (/expired/.test(e.message)) return new Error(t('social.cloud.inviteExpired'));
  if (/not friends/.test(e.message)) return new Error(t('social.cloud.notFriends'));
  if (/not pending/.test(e.message)) return new Error(t('social.cloud.inviteAnswered'));
  if (/already (ended|cancelled|declined)/.test(e.message)) return new Error(t('social.cloud.sessionEnded'));
  if (e.code === 'P0002') return new Error(t('social.cloud.sessionGone'));
  return friendly(e);
}

type Channel = ReturnType<SupabaseCloud['signals']['channel']>;

class SupabaseCloud implements Cloud {
  /** Requests, each with the Clerk session token. */
  readonly client = createClient(SUPABASE_URL, SUPABASE_KEY, { accessToken: () => clerk.sessionToken() });
  /** Realtime, with no sign-in at all: Realtime can't check sign-ins from
   *  Clerk on a domain of its own (clerk.thoughtdesk.org,
   *  supabase/realtime#1791), and what goes through it here needs none:
   *  empty signals to an inbox only its owner knows the name of, and
   *  wake-ups between the two people in a session. */
  readonly signals = createClient(SUPABASE_URL, SUPABASE_KEY, { accessToken: async () => null });
  /** Who's listening for changes, and the inbox they share. */
  #listeners = new Set<(change: CloudChange) => void>();
  #inbox: { user: string; stop: () => void } | null = null;

  /** In a browser (development): finishes a Google or GitHub sign-in that came back to this page. */
  finishRedirect = clerk.finishRedirect;
  user = clerk.user;
  onAuth = clerk.onAuth;
  cancelSignIn = clerk.cancelSignIn;
  signOut = clerk.signOut;

  signInWith(provider: Provider) {
    return clerk.signInWith(provider);
  }

  sendEmailCode(email: string) {
    return clerk.sendEmailCode(email);
  }

  verifyEmailCode(_email: string, code: string) {
    return clerk.verifyEmailCode(code);
  }

  accessToken() {
    return clerk.sessionToken();
  }

  /** Makes your profile the first time (from your Clerk name and picture),
   *  and keeps its picture in step with Clerk's. */
  async myProfile() {
    if (!(await this.user())) return null;
    const { data, error } = await this.client.rpc('ensure_profile');
    if (error) throw friendly(error);
    return data ? asProfile(data as Parameters<typeof asProfile>[0]) : null;
  }

  async updateProfile(patch: { username?: string; displayName?: string }) {
    const me = await this.#me();
    const row: Record<string, string> = {};
    if (patch.username !== undefined) row.username = patch.username;
    if (patch.displayName !== undefined) row.display_name = patch.displayName;
    const { data, error } = await this.client.from('profiles').update(row).eq('id', me.id).select(PROFILE_COLS).single();
    if (error) throw friendly(error);
    return asProfile(data);
  }

  async findProfile(username: string) {
    const { data, error } = await this.client.rpc('find_profile', { name: username });
    if (error) throw friendly(error);
    const row = (data as Parameters<typeof asProfile>[0][] | null)?.[0];
    return row ? asProfile(row) : null;
  }

  async friends(): Promise<Friend[]> {
    const me = await this.user();
    if (!me) return [];
    // Row-level security returns only your own requests and friendships,
    // and only the profiles and presence of the people in them.
    const { data: rows, error } = await this.client.from('friendships').select('requester, addressee, status');
    if (error) throw friendly(error);
    const others = rows.map((r) => (r.requester === me.id ? r.addressee : r.requester) as string);
    if (!others.length) return [];
    const [profiles, presence] = await Promise.all([
      this.client.from('profiles').select(PROFILE_COLS).in('id', others),
      this.client.from('presence').select('user_id, seen_at').in('user_id', others),
    ]);
    if (profiles.error) throw friendly(profiles.error);
    const seen = new Map((presence.data ?? []).map((p) => [p.user_id as string, Date.parse(p.seen_at as string)]));
    const byId = new Map(profiles.data.map((p) => [p.id as string, asProfile(p)]));
    return rows.flatMap((r): Friend[] => {
      const other = (r.requester === me.id ? r.addressee : r.requester) as string;
      const profile = byId.get(other);
      if (!profile) return [];
      const status = r.status === 'accepted' ? 'accepted' : r.requester === me.id ? 'outgoing' : 'incoming';
      return [{ profile, status, online: status === 'accepted' && Date.now() - (seen.get(other) ?? 0) < ONLINE_FOR }];
    });
  }

  async requestFriend(userId: string) {
    const me = await this.#me();
    const { error } = await this.client.from('friendships').insert({ requester: me.id, addressee: userId });
    if (error?.code === '23505') throw new Error(t('social.cloud.alreadyFriends'));
    if (error) throw friendly(error);
  }

  async acceptFriend(userId: string) {
    const me = await this.#me();
    const { error } = await this.client.from('friendships').update({ status: 'accepted' }).eq('requester', userId).eq('addressee', me.id);
    if (error) throw friendly(error);
  }

  async removeFriend(userId: string) {
    const me = await this.#me();
    const pair = (a: string, b: string) => 'and(requester.eq.' + a + ',addressee.eq.' + b + ')';
    const { error } = await this.client.from('friendships').delete().or(pair(me.id, userId) + ',' + pair(userId, me.id));
    if (error) throw friendly(error);
  }

  async touchPresence() {
    const { error } = await this.client.rpc('touch_presence');
    if (error) throw friendly(error);
  }

  async sessions() {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data, error } = await this.client.from('cowork_sessions').select(SESSION_COLS).gte('updated_at', since).order('updated_at', { ascending: false });
    if (error) throw friendly(error);
    return (data as SessionRow[]).map(asSession);
  }

  async createSession({ kind, friendId, title }: { kind: 'invite' | 'request'; friendId: string; title: string }) {
    const me = await this.#me();
    const row: Pick<SessionRow, 'host' | 'guest' | 'kind' | 'title'> =
      kind === 'invite' ? { host: me.id, guest: friendId, kind, title } : { host: friendId, guest: me.id, kind, title: '' };
    const { data, error } = await this.client.from('cowork_sessions').insert(row).select(SESSION_COLS).single();
    if (error?.code === '42501') throw new Error(t('social.cloud.friendsOnly'));
    if (error) throw friendly(error);
    return asSession(data as SessionRow);
  }

  async respondSession(id: string, accept: boolean, title?: string) {
    const { error } = await this.client.rpc('respond_session', { session_id: id, accept, page_title: title ?? null });
    if (error) throw sessionError(error);
  }

  async endSession(id: string) {
    const { error } = await this.client.rpc('end_session', { session_id: id });
    if (error) throw sessionError(error);
  }

  subscribe(cb: (change: CloudChange) => void) {
    this.#listeners.add(cb);
    void this.#listen();
    return () => {
      this.#listeners.delete(cb);
      if (this.#listeners.size) return;
      this.#inbox?.stop();
      this.#inbox = null;
    };
  }

  /** Listens on the signed-in person's inbox. Whenever a friendship or a
   *  session of theirs changes, the database sends it an empty "friends" or
   *  "sessions" signal (supabase/README.md), and the listeners fetch what
   *  changed. Everyone listening shares one channel: Realtime hands back an
   *  existing channel of the same name, which takes no new callbacks. */
  async #listen() {
    const me = await this.user();
    if (!me || !this.#listeners.size || this.#inbox?.user === me.id) return;
    this.#inbox?.stop();
    const inbox = { user: me.id, stop: () => {} };
    this.#inbox = inbox;
    const { data: box, error } = await this.client.rpc('my_inbox');
    if (this.#inbox !== inbox) return;
    if (error || typeof box !== 'string') {
      // No live updates this time: the lists still refresh every minute.
      console.warn('Live updates: no inbox', error);
      this.#inbox = null;
      return;
    }
    const tell = (change: CloudChange) => () => {
      for (const cb of this.#listeners) cb(change);
    };
    inbox.stop = this.#keep('inbox:' + box, (ch) => ch.on('broadcast', { event: 'friends' }, tell('friends')).on('broadcast', { event: 'sessions' }, tell('sessions'))).stop;
  }

  nudges(sessionId: string, onNudge: () => void) {
    // A broadcast, stored nowhere, on a channel named by the session's
    // unguessable id. It only makes the other app reconnect to the relay,
    // which checks who may join.
    const kept = this.#keep('nudge:' + sessionId, (ch) => ch.on('broadcast', { event: 'nudge' }, () => onNudge()), { config: { broadcast: { self: false } } });
    return {
      send: () => void kept.current()?.send({ type: 'broadcast', event: 'nudge', payload: {} }),
      stop: kept.stop,
    };
  }

  /** Whoever is signed in, or an error saying to sign in. */
  async #me(): Promise<CloudUser> {
    const me = await this.user();
    if (!me) throw new Error(t('social.cloud.signInFirst'));
    return me;
  }

  /** A Realtime channel that comes back if it closes on its own, or if the
   *  server turns it down (Realtime rejoins neither), sooner or later
   *  depending on how often it has failed. */
  #keep(name: string, setup: (ch: Channel) => Channel, params?: Parameters<SupabaseCloud['signals']['channel']>[1]) {
    let current: Channel | null = null;
    let stopped = false;
    let wait = 1000;
    /** When the current channel joined (0: it hasn't). */
    let since = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (stopped) return;
      const ch = setup(this.signals.channel(name, params));
      current = ch;
      ch.on('system', {}, (message: { status?: string }) => message.status === 'error' && retire(ch));
      ch.subscribe((status) => {
        if (status !== 'SUBSCRIBED') retire(ch);
        else if (current === ch) since = Date.now();
      });
    };
    // Gone, or no use: make a new one (the same name would give back this one).
    const retire = (ch: Channel) => {
      if (stopped || current !== ch) return;
      current = null;
      // Up for a while before this: start the waiting over.
      if (since && Date.now() - since > 60_000) wait = 1000;
      since = 0;
      void this.signals.removeChannel(ch).finally(() => {
        if (!stopped) retry = setTimeout(open, wait);
        wait = Math.min(wait * 2, 60_000);
      });
    };
    open();
    return {
      current: () => current,
      stop: () => {
        stopped = true;
        clearTimeout(retry);
        if (current) void this.signals.removeChannel(current);
        current = null;
      },
    };
  }
}

export const supabaseCloud = new SupabaseCloud();
