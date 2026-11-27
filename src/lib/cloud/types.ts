/**
 * What the app needs from the cloud: accounts, profiles, friends and live
 * sessions. Notes never go there. The real cloud is Supabase (supabase.ts),
 * with Clerk for signing in (clerk.ts); interface tests use a fake shared by
 * two browser profiles (fake.ts). Errors carry messages meant for people.
 */

export type Provider = 'google' | 'github';

export interface CloudUser {
  id: string;
  email: string | null;
}

export interface Profile {
  id: string;
  /** Lowercase, 3–20 of a–z, 0–9 and _; null until chosen after the first sign-in. */
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
}

/** Someone you're friends with, or have a request with. */
export interface Friend {
  profile: Profile;
  /** accepted; incoming (they asked you); outgoing (you asked them). */
  status: 'accepted' | 'incoming' | 'outgoing';
  /** The app is open on their side (seen in the last two minutes). Friends only. */
  online: boolean;
}

/**
 * A live session between two friends. An invite: the host offers a page. A
 * request: the guest asks, and the host picks the page when accepting. Only
 * the two of them can see it.
 */
export interface LiveSession {
  id: string;
  hostId: string;
  guestId: string;
  kind: 'invite' | 'request';
  /** The page's title (set when a request is accepted). */
  title: string;
  status: 'pending' | 'active' | 'declined' | 'cancelled' | 'ended';
  createdAt: number;
  updatedAt: number;
}

/** What changed in the cloud, for live updates. */
export type CloudChange = 'friends' | 'sessions';

export interface Cloud {
  /** Who's signed in on this computer, or null. */
  user(): Promise<CloudUser | null>;
  /** Called when someone signs in or out. Returns a function that stops it. */
  onAuth(cb: (user: CloudUser | null) => void): () => void;
  /** Signs in with Google or GitHub in the browser; resolves once signed in. */
  signInWith(provider: Provider): Promise<void>;
  /** Stops waiting for a Google or GitHub sign-in. */
  cancelSignIn(): void;
  /** Emails a 6-digit sign-in code (making the account if it's new). */
  sendEmailCode(email: string): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Deleting the account needs the sign-in proved afresh. Null when it was, in the last few minutes; otherwise a
   * 6-digit code has just been emailed, and this is the address it went to.
   */
  startAccountCheck(): Promise<string | null>;
  /** The code from that email. */
  finishAccountCheck(code: string): Promise<void>;
  /** Throws unless `deleteAccount` could go through now. Deletes nothing: asked before anything else is removed. */
  checkDeleteAccount(): Promise<void>;
  /** Deletes the profile, friends and invitations, then the sign-in itself. It can't be undone. */
  deleteAccount(): Promise<void>;
  /** The current access token (for the live-session relay). */
  accessToken(): Promise<string | null>;
  myProfile(): Promise<Profile | null>;
  updateProfile(patch: { username?: string; displayName?: string }): Promise<Profile>;
  /** Someone else, by exact username. */
  findProfile(username: string): Promise<Profile | null>;

  /** Your friends and requests, with their profiles. */
  friends(): Promise<Friend[]>;
  requestFriend(userId: string): Promise<void>;
  acceptFriend(userId: string): Promise<void>;
  /** Declines, cancels or unfriends. */
  removeFriend(userId: string): Promise<void>;
  /** Says you're here (friends see you online for two minutes). */
  touchPresence(): Promise<void>;
  /** Your sessions from the last day (pending, live and finished), newest first. */
  sessions(): Promise<LiveSession[]>;
  /** Invites a friend to a page (you host), or asks one to work together (they host). */
  createSession(input: { kind: 'invite' | 'request'; friendId: string; title: string }): Promise<LiveSession>;
  /** Accepts or declines. Accepting a request names the page it's on. */
  respondSession(id: string, accept: boolean, title?: string): Promise<void>;
  /** Ends a live session, or withdraws a pending one you made. */
  endSession(id: string): Promise<void>;
  /** Calls back when your friends or sessions change elsewhere. Returns a function that stops it. */
  subscribe(cb: (change: CloudChange) => void): () => void;
  /** Wake-ups between the two people in a live session, for when one writes
   *  or comes back while the other's app has let go of the relay. They carry
   *  nothing. Returns how to send one, and how to stop listening. */
  nudges(sessionId: string, onNudge: () => void): { send(): void; stop(): void };
}

/** How long after their last "here" someone still counts as online. */
export const ONLINE_FOR = 2 * 60_000;

/** Usernames: what a valid one looks like. */
export const USERNAME = /^[a-z0-9_]{3,20}$/;

/** A username suggested from a name ("Ana Lima" → "analima"), or "". */
export function suggestUsername(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9_]/g, '').slice(0, 20);
  return s.length >= 3 ? s : '';
}
