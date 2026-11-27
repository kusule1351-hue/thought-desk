/**
 * Your account: whether you're signed in, and your profile (name, @username,
 * picture). Signing in is optional: notes stay on this computer either way;
 * an account is for friends and writing together.
 */

import { api } from './api';
import { cloud, type CloudUser, type Profile, type Provider } from './cloud';
import { t } from './i18n';
import { isDesktop } from './platform';

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

  /**
   * Deleting the account, step one: the sign-in is proved afresh. Null if it was lately; otherwise a code has
   * been emailed, to the address returned, and `confirmDelete` takes it.
   */
  async startDelete(): Promise<string | null> {
    return (await cloud()).startAccountCheck();
  }

  async confirmDelete(code: string) {
    await (await cloud()).finishAccountCheck(code.replace(/\s/g, ''));
  }

  /**
   * Deletes the account for good, in an order that leaves nothing half-kept if a step fails: first a check that
   * deletes nothing, then the server
   * (it stops Pro renewing, and only then removes the synced copy and the assistant's counts; if it can't,
   * nothing is deleted), then the profile with its friends and invitations, then the sign-in itself. Every step
   * can be run again. The notes on this computer are not touched.
   */
  async deleteAccount() {
    const c = await cloud();
    const id = this.user?.id;
    const token = await c.accessToken();
    if (!id || !token) throw new Error(t('settings.account.delete.signedOut'));
    // First, with nothing deleted: can the last steps go through? (The database knows how, and finds the sign-in fresh.)
    await c.checkDeleteAccount();
    const { base } = await import('./assistant/client');
    let res: Response;
    try {
      res = await fetch(`${base()}/account`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      throw new Error(t('settings.account.delete.offline'));
    }
    if (!res.ok) throw new Error(t(res.status === 403 || res.status === 401 ? 'settings.account.delete.unproved' : 'settings.account.delete.failed'));
    for (const step of this.beforeSignOut) await step().catch((e) => console.warn(e));
    await c.deleteAccount();
    this.user = null;
    this.profile = null;
    // The key to a synced copy that no longer exists.
    if (isDesktop()) await api.syncVaultForget(id).catch(() => {});
  }
}

export const account = new Account();
