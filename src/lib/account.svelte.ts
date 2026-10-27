/**
 * Your account: whether you're signed in, and your profile (name, @username,
 * picture). Signing in is optional: notes stay on this computer either way;
 * an account is for friends and writing together.
 */

import { cloud, type CloudUser, type Profile, type Provider } from './cloud';
import { t } from './i18n';

class Account {
  user = $state<CloudUser | null>(null);
  profile = $state<Profile | null>(null);
  /** The sign-in state has been read (until then, don't offer to sign in). */
  ready = $state(false);
  /** A Google or GitHub sign-in waiting on the browser. */
  waiting = $state<Provider | null>(null);
  /** Done before signing out, while still signed in (live sessions end). */
  beforeSignOut: (() => Promise<void>)[] = [];

  get signedIn(): boolean {
    return !!this.user;
  }

  /** Signed in but no @username yet: friends can't find you until there is one. */
  get needsUsername(): boolean {
    return !!this.user && !!this.profile && !this.profile.username;
  }

  /** How the app shows you: your name, else your @username. */
  get name(): string {
    return this.profile?.displayName || (this.profile?.username ? `@${this.profile.username}` : this.user?.email || t('social.account.you'));
  }

  async init() {
    try {
      const c = await cloud();
      if ('finishRedirect' in c) await (c as { finishRedirect(): Promise<void> }).finishRedirect();
      c.onAuth((user) => void this.#take(user));
      await this.#take(await c.user());
    } catch (e) {
      // Offline or the service is down: the app works without an account.
      console.warn('Account: could not read the sign-in state', e);
    } finally {
      this.ready = true;
    }
  }

  async #take(user: CloudUser | null) {
    // Token refreshes report the same person again.
    if (user?.id === this.user?.id && (this.profile || !user)) return;
    this.user = user;
    this.profile = user ? await (await cloud()).myProfile().catch(() => null) : null;
  }

  async signInWith(provider: Provider) {
    this.waiting = provider;
    try {
      await (await cloud()).signInWith(provider);
      await this.#take(await (await cloud()).user());
    } finally {
      this.waiting = null;
    }
  }

  cancelSignIn() {
    void cloud().then((c) => c.cancelSignIn());
    this.waiting = null;
  }

  async sendCode(email: string) {
    await (await cloud()).sendEmailCode(email.trim());
  }

  async verifyCode(email: string, code: string) {
    await (await cloud()).verifyEmailCode(email.trim(), code.replace(/\s/g, ''));
    await this.#take(await (await cloud()).user());
  }

  async saveProfile(patch: { username?: string; displayName?: string }) {
    this.profile = await (await cloud()).updateProfile(patch);
  }

  /** Whether a username is free (someone else has it, or not). */
  async usernameFree(username: string): Promise<boolean> {
    if (username === this.profile?.username) return true;
    return !(await (await cloud()).findProfile(username));
  }

  async signOut() {
    for (const step of this.beforeSignOut) await step().catch((e) => console.warn(e));
    await (await cloud()).signOut();
    this.user = null;
    this.profile = null;
  }
}

export const account = new Account();
