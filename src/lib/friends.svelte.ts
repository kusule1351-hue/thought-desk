/**
 * Your friends and friend requests, kept up to date while you're signed in:
 * at once when something changes on their side, and every minute, which is
 * also when the app tells your friends you're here.
 */

import { untrack } from 'svelte';
import { account } from './account.svelte';
import { api } from './api';
import { cloud, USERNAME, type Friend } from './cloud';
import { t } from './i18n';
import { fmt } from './i18n/format';
import { ui } from './ui.svelte';

const EVERY = 60_000;

/** By name, the interface language's way; every difference counts (case, accents), so the order is always the same. */
const byName = (a: Friend, b: Friend) => fmt.collator({}).compare(a.profile.displayName || a.profile.username || '', b.profile.displayName || b.profile.username || '');

/** How to show someone: their name, else their @username. */
export const nameOf = (f: Friend) => f.profile.displayName || `@${f.profile.username ?? '?'}`;

/** News for you: in the app, and as a system notification when it's in the background. */
export function announce(title: string, body = '', action?: { label: string; run: () => void }) {
  ui.toast(body ? t('social.notify.toast', { title, body }) : title, action, 8000);
  if (document.hidden || !document.hasFocus()) void api.notify(title, body).catch(() => {});
}

/** A refresh that runs one at a time. Asked for while one is under way, it
 *  runs once more after that one, for everyone who asked meanwhile: two at
 *  once would compare with the same "before" and tell the same news twice. */
export function oneAtATime(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const go = (): Promise<void> => {
    if (!current) return (current = run().finally(() => (current = null)));
    return (next ??= current
      .catch(() => {})
      .then(() => {
        next = null;
        return go();
      }));
  };
  return go;
}

class Friends {
  list = $state<Friend[]>([]);
  loaded = $state(false);

  /** Friends, the ones here now first. */
  accepted = $derived(this.list.filter((f) => f.status === 'accepted').sort((a, b) => Number(b.online) - Number(a.online) || byName(a, b)));
  /** People who asked you. */
  incoming = $derived(this.list.filter((f) => f.status === 'incoming').sort(byName));
  /** People you asked. */
  outgoing = $derived(this.list.filter((f) => f.status === 'outgoing').sort(byName));

  #stop: (() => void) | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #following: string | null = null;
  /** People you took a request back from (or declined, or unfriended): that
   *  it's gone is your doing, not news. */
  #withdrawn = new Set<string>();

  /** Follows whoever is signed in: starts on sign-in, clears on sign-out. */
  init() {
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
    this.list = [];
    this.loaded = false;
    this.#withdrawn.clear();
    if (!id) return;
    const c = await cloud();
    if (this.#following !== id) return;
    this.#stop = c.subscribe((change) => change === 'friends' && void this.refresh());
    const tick = () => {
      void c.touchPresence().catch(() => {});
      void this.refresh();
    };
    tick();
    this.#timer = setInterval(tick, EVERY);
  }

  /** Reads your friends again, and tells you what changed on their side. */
  refresh = oneAtATime(() => this.#refresh());

  async #refresh() {
    const following = this.#following;
    // As at the last look (none yet: what's there at start-up isn't news).
    const before = this.loaded ? new Map(this.list.map((f) => [f.profile.id, f])) : null;
    let list: Friend[];
    try {
      list = await (await cloud()).friends();
    } catch (e) {
      console.warn('Friends: could not refresh', e);
      return;
    }
    // Signed out, or someone else signed in, meanwhile.
    if (this.#following !== following) return;
    this.list = list;
    this.loaded = true;
    if (!before) return;
    for (const f of list) {
      const was = before.get(f.profile.id)?.status;
      if (f.status === 'incoming' && was !== 'incoming')
        announce(t('social.friends.wantsToBeFriends', { name: nameOf(f) }), `@${f.profile.username}`, { label: t('social.friends.accept'), run: () => void this.accept(f.profile.id) });
      if (f.status === 'accepted' && was === 'outgoing') announce(t('social.friends.acceptedRequest', { name: nameOf(f) }), `@${f.profile.username}`);
    }
    // A request of yours that's gone, and you didn't take it back: they
    // declined. Said in the app only, with no system notification.
    const now = new Set(list.map((f) => f.profile.id));
    for (const [id, f] of before)
      if (f.status === 'outgoing' && !now.has(id) && !this.#withdrawn.has(id)) ui.toast(t('social.friends.declinedRequest', { name: nameOf(f) }), undefined, 8000);
  }

  /** Sends a friend request by username (or accepts theirs). */
  async add(input: string): Promise<'sent' | 'accepted'> {
    const name = input.trim().toLowerCase().replace(/^@/, '');
    if (!USERNAME.test(name)) throw new Error(t('social.friends.errors.usernameRule'));
    if (name === account.profile?.username) throw new Error(t('social.friends.errors.thatsYou'));
    const c = await cloud();
    const person = await c.findProfile(name);
    if (!person) throw new Error(t('social.friends.errors.noOne', { username: name }));
    const already = this.list.find((f) => f.profile.id === person.id);
    if (already?.status === 'accepted') throw new Error(t('social.friends.errors.alreadyFriends', { username: name }));
    if (already?.status === 'outgoing') throw new Error(t('social.friends.errors.alreadyAsked', { username: name }));
    if (already?.status === 'incoming') {
      await this.accept(person.id);
      return 'accepted';
    }
    this.#withdrawn.delete(person.id);
    await c.requestFriend(person.id);
    await this.refresh();
    return 'sent';
  }

  async accept(id: string) {
    await (await cloud()).acceptFriend(id);
    await this.refresh();
  }

  /** Declines, cancels or unfriends. */
  async remove(id: string) {
    this.#withdrawn.add(id);
    try {
      await (await cloud()).removeFriend(id);
    } catch (e) {
      this.#withdrawn.delete(id);
      throw e;
    }
    await this.refresh();
  }
}

export const friends = new Friends();
