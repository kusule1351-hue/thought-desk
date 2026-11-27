/**
 * The cloud in interface tests: every call goes to `window.__fakeCloud`,
 * which the test exposes (tests/e2e/fake-cloud.ts). It runs in the test
 * itself, so two browser profiles (two people) share one backend.
 */

import type { Cloud, CloudChange, CloudUser, Friend, LiveSession, Profile, Provider } from './types';

type Bridge = (method: string, args: unknown[]) => Promise<unknown>;
const call = <T>(method: string, ...args: unknown[]) => ((window as unknown as { __fakeCloud: Bridge }).__fakeCloud(method, args) as Promise<T>);

class FakeCloud implements Cloud {
  #listeners = new Set<(user: CloudUser | null) => void>();

  async #changed() {
    const user = await this.user();
    for (const cb of this.#listeners) cb(user);
  }

  user() {
    return call<CloudUser | null>('user');
  }

  onAuth(cb: (user: CloudUser | null) => void) {
    this.#listeners.add(cb);
    return () => void this.#listeners.delete(cb);
  }

  async signInWith(provider: Provider) {
    await call('signInWith', provider);
    await this.#changed();
  }

  cancelSignIn() {}

  async sendEmailCode(email: string) {
    await call('sendEmailCode', email);
  }

  async verifyEmailCode(email: string, code: string) {
    await call('verifyEmailCode', email, code);
    await this.#changed();
  }

  async signOut() {
    await call('signOut');
    await this.#changed();
  }

  accessToken() {
    return call<string | null>('accessToken');
  }

  startAccountCheck() {
    return call<string | null>('startAccountCheck');
  }

  async finishAccountCheck(code: string) {
    await call('finishAccountCheck', code);
  }

  async checkDeleteAccount() {
    await call('checkDeleteAccount');
  }

  async deleteAccount() {
    await call('deleteAccount');
    await this.#changed();
  }

  myProfile() {
    return call<Profile | null>('myProfile');
  }

  updateProfile(patch: { username?: string; displayName?: string }) {
    return call<Profile>('updateProfile', patch);
  }

  findProfile(username: string) {
    return call<Profile | null>('findProfile', username);
  }

  friends() {
    return call<Friend[]>('friends');
  }

  async requestFriend(userId: string) {
    await call('requestFriend', userId);
  }

  async acceptFriend(userId: string) {
    await call('acceptFriend', userId);
  }

  async removeFriend(userId: string) {
    await call('removeFriend', userId);
  }

  async touchPresence() {
    await call('touchPresence');
  }

  sessions() {
    return call<LiveSession[]>('sessions');
  }

  createSession(input: { kind: 'invite' | 'request'; friendId: string; title: string }) {
    return call<LiveSession>('createSession', input);
  }

  async respondSession(id: string, accept: boolean, title?: string) {
    await call('respondSession', id, accept, title ?? null);
  }

  async endSession(id: string) {
    await call('endSession', id);
  }

  /** Live updates: asks the fake what changed, a few times a second. */
  subscribe(cb: (change: CloudChange) => void) {
    let seen: Record<CloudChange, number> | null = null;
    const timer = setInterval(async () => {
      const now = await call<Record<CloudChange, number>>('versions').catch(() => null);
      if (!now) return;
      if (seen) for (const change of ['friends', 'sessions'] as const) if (now[change] !== seen[change]) cb(change);
      seen = now;
    }, 250);
    return () => clearInterval(timer);
  }

  /** Wake-ups: asks the fake how many the other person has sent, a few times a second. */
  nudges(sessionId: string, onNudge: () => void) {
    let seen: number | null = null;
    const timer = setInterval(async () => {
      const now = await call<number>('nudges', sessionId).catch(() => null);
      if (now === null) return;
      if (seen !== null && now !== seen) onNudge();
      seen = now;
    }, 250);
    return {
      send: () => void call('nudge', sessionId).catch(() => {}),
      stop: () => clearInterval(timer),
    };
  }
}

export const fakeCloud = new FakeCloud();
