// A stand-in for the cloud (Supabase) in interface tests. It lives in the
// test process and is exposed to each browser profile as
// `window.__fakeCloud` (see src/lib/cloud/fake.ts), so two profiles, two
// people, share one backend. It follows the real rules where the interface
// depends on them; the real row-level security is tested in supabase/tests.
import { RELAY_HOST } from './relay';
import type { BrowserContext } from '@playwright/test';

export interface FakeProfile {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
}

interface FakeUser {
  id: string;
  email: string;
  profile: FakeProfile;
}

/** The code every email gets in tests. */
export const EMAIL_CODE = '246810';

const USERNAME = /^[a-z0-9_]{3,20}$/;

interface FakeFriendship {
  requester: string;
  addressee: string;
  status: 'pending' | 'accepted';
}

export interface FakeSession {
  id: string;
  hostId: string;
  guestId: string;
  kind: 'invite' | 'request';
  title: string;
  status: 'pending' | 'active' | 'declined' | 'cancelled' | 'ended';
  createdAt: number;
  updatedAt: number;
}

export class FakeCloud {
  users = new Map<string, FakeUser>();
  friendships: FakeFriendship[] = [];
  sessions: FakeSession[] = [];
  /** Bumped on every change, for the app's live updates (see subscribe in src/lib/cloud/fake.ts). */
  versions = { friends: 0, sessions: 0 };
  #seen = new Map<string, number>();
  /** Wake-ups sent in each live session, counted by sender. */
  #nudges = new Map<string, Map<string, number>>();
  #signedIn = new Map<BrowserContext, string>();
  #codes = new Map<string, string>();
  /** Who signs in with Google or GitHub in each browser profile. */
  #oauth = new Map<BrowserContext, { email: string; name: string }>();

  /** Someone who already has an account. */
  addUser({ email, name, username = null }: { email: string; name: string; username?: string | null }): FakeUser {
    const id = crypto.randomUUID();
    const user = { id, email, profile: { id, username, displayName: name, avatarUrl: null } };
    this.users.set(id, user);
    return user;
  }

  /** Makes two people friends already. */
  befriend(a: FakeUser, b: FakeUser) {
    this.friendships.push({ requester: a.id, addressee: b.id, status: 'accepted' });
    this.versions.friends++;
  }

  /** Signs a browser profile in as someone, without going through the sheet. */
  signIn(context: BrowserContext, user: FakeUser) {
    this.#signedIn.set(context, user.id);
  }

  #pair(a: string, b: string) {
    return this.friendships.find((f) => (f.requester === a && f.addressee === b) || (f.requester === b && f.addressee === a));
  }

  /** Gives a browser profile this cloud; `oauth` is who Google and GitHub sign in as there.
   *  Live sessions there use the test relay (port 8788, see playwright.config.ts). */
  async attach(context: BrowserContext, oauth?: { email: string; name: string }) {
    if (oauth) this.#oauth.set(context, oauth);
    await context.addInitScript((host) => ((window as unknown as { __coworkHost: string }).__coworkHost = host), RELAY_HOST);
    await context.exposeBinding('__fakeCloud', ({ context }, method: string, args: unknown[]) => this.#handle(context, method, args));
  }

  #byEmail(email: string, name = email.split('@')[0]): FakeUser {
    return [...this.users.values()].find((u) => u.email === email) ?? this.addUser({ email, name });
  }

  #handle(context: BrowserContext, method: string, args: unknown[]): unknown {
    const meId = this.#signedIn.get(context);
    const me = meId ? this.users.get(meId) : undefined;
    switch (method) {
      case 'user':
        return me ? { id: me.id, email: me.email } : null;
      case 'signInWith': {
        const who = this.#oauth.get(context);
        if (!who) throw new Error('Sign-in was cancelled.');
        this.#signedIn.set(context, this.#byEmail(who.email, who.name).id);
        return null;
      }
      case 'sendEmailCode':
        this.#codes.set(String(args[0]), EMAIL_CODE);
        return null;
      case 'verifyEmailCode': {
        const [email, code] = args as [string, string];
        if (!this.#codes.has(email) || this.#codes.get(email) !== code) throw new Error("That code isn't right, or it has expired. Ask for a new one.");
        this.#codes.delete(email);
        this.#signedIn.set(context, this.#byEmail(email).id);
        return null;
      }
      case 'signOut':
        this.#signedIn.delete(context);
        return null;
      case 'accessToken':
        return me ? `test.${me.id}` : null;
      case 'myProfile':
        return me ? { ...me.profile } : null;
      case 'updateProfile': {
        if (!me) throw new Error('Sign in first.');
        const patch = args[0] as { username?: string; displayName?: string };
        if (patch.username !== undefined) {
          if (!USERNAME.test(patch.username)) throw new Error('Use 3–20 lowercase letters, digits or _.');
          if ([...this.users.values()].some((u) => u.id !== me.id && u.profile.username === patch.username)) throw new Error('That username is taken.');
          me.profile.username = patch.username;
        }
        if (patch.displayName !== undefined) me.profile.displayName = patch.displayName.slice(0, 50);
        return { ...me.profile };
      }
      case 'findProfile': {
        const name = String(args[0]).toLowerCase().replace(/^@/, '');
        const found = [...this.users.values()].find((u) => u.profile.username === name && u.id !== me?.id);
        return found ? { ...found.profile } : null;
      }
      case 'friends': {
        if (!me) return [];
        return this.friendships
          .filter((f) => f.requester === me.id || f.addressee === me.id)
          .map((f) => {
            const other = this.users.get(f.requester === me.id ? f.addressee : f.requester)!;
            const status = f.status === 'accepted' ? 'accepted' : f.requester === me.id ? 'outgoing' : 'incoming';
            const online = status === 'accepted' && Date.now() - (this.#seen.get(other.id) ?? 0) < 2 * 60_000;
            return { profile: { ...other.profile }, status, online };
          });
      }
      case 'requestFriend': {
        const to = this.users.get(String(args[0]));
        if (!me || !to?.profile.username) throw new Error('Sign in first.');
        if (this.#pair(me.id, to.id)) throw new Error("You're already friends, or one of you has asked already.");
        this.friendships.push({ requester: me.id, addressee: to.id, status: 'pending' });
        this.versions.friends++;
        return null;
      }
      case 'acceptFriend': {
        const f = this.friendships.find((f) => f.requester === args[0] && f.addressee === me?.id && f.status === 'pending');
        if (!f) throw new Error('That request is gone.');
        f.status = 'accepted';
        this.versions.friends++;
        return null;
      }
      case 'removeFriend': {
        if (!me) throw new Error('Sign in first.');
        this.friendships = this.friendships.filter((f) => f !== this.#pair(me.id, String(args[0])));
        this.versions.friends++;
        return null;
      }
      case 'touchPresence':
        if (me) this.#seen.set(me.id, Date.now());
        return null;
      case 'versions':
        return { ...this.versions };
      case 'sessions':
        if (!me) return [];
        return this.sessions.filter((s) => s.hostId === me.id || s.guestId === me.id).map((s) => ({ ...s }));
      case 'createSession': {
        const { kind, friendId, title } = args[0] as { kind: 'invite' | 'request'; friendId: string; title: string };
        if (!me) throw new Error('Sign in first.');
        if (this.#pair(me.id, friendId)?.status !== 'accepted') throw new Error('You can only work with friends.');
        const now = Date.now();
        const s: FakeSession = {
          id: crypto.randomUUID(),
          hostId: kind === 'invite' ? me.id : friendId,
          guestId: kind === 'invite' ? friendId : me.id,
          kind,
          title: kind === 'invite' ? title : '',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        };
        this.sessions.push(s);
        this.versions.sessions++;
        return { ...s };
      }
      case 'respondSession': {
        const [id, accept, title] = args as [string, boolean, string | null];
        const s = this.sessions.find((s) => s.id === id);
        if (!s || !me || s.status !== 'pending') throw new Error('That invite is gone.');
        const answerer = s.kind === 'invite' ? s.guestId : s.hostId;
        if (answerer !== me.id) throw new Error('Only the person asked can answer.');
        if (accept && s.kind === 'request') {
          if (!title) throw new Error('Pick a page first.');
          s.title = title;
        }
        s.status = accept ? 'active' : 'declined';
        s.updatedAt = Date.now();
        this.versions.sessions++;
        return null;
      }
      case 'endSession': {
        const s = this.sessions.find((s) => s.id === args[0]);
        if (!s || !me || (s.hostId !== me.id && s.guestId !== me.id)) throw new Error('That session is gone.');
        if (s.status === 'active') s.status = 'ended';
        else if (s.status === 'pending') s.status = 'cancelled';
        else return null;
        s.updatedAt = Date.now();
        this.versions.sessions++;
        return null;
      }
      case 'nudge': {
        if (!me) return null;
        const bySender = this.#nudges.get(String(args[0])) ?? new Map<string, number>();
        bySender.set(me.id, (bySender.get(me.id) ?? 0) + 1);
        this.#nudges.set(String(args[0]), bySender);
        return null;
      }
      case 'nudges': {
        // Only the other person's: your own don't come back to you.
        let count = 0;
        for (const [from, n] of this.#nudges.get(String(args[0])) ?? []) if (from !== me?.id) count += n;
        return count;
      }
      default:
        throw new Error(`The fake cloud doesn't know "${method}"`);
    }
  }
}
