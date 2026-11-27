/**
 * What the assistant has cost, counted in millionths of a US dollar. One of
 * these per account (a month at a time) and one for everybody together (a day
 * at a time), so neither one person nor a crowd can spend more than the owner
 * set (assistant.ts reads the limits).
 *
 * A request is counted before it runs: `admit` holds what it could cost at
 * most, and `settle` swaps that for what it did cost. A Worker cut off in
 * between leaves the hold standing, which errs on the side of spending less.
 */

import { DurableObject } from 'cloudflare:workers';

/** Requests one account may start a minute (an assistant task is several). */
export const PER_MINUTE = 30;
const WINDOW = 60_000;

/** The plan Polar last said this account is on, and when it was asked (plan.ts). */
export interface Kept {
  pro: boolean;
  until: number | null;
  ending: boolean;
  checked: number;
}

export type Admitted = { ok: true; spent: number } | { ok: false; reason: 'spent'; spent: number } | { ok: false; reason: 'fast'; retryAfter: number };

export class Budget extends DurableObject {
  #sql: SqlStorage;
  /** When the last minute's requests started (forgotten on eviction, which is fine for a rate). */
  #starts: number[] = [];

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS spend (period TEXT PRIMARY KEY, micro INTEGER NOT NULL)`);
    // One row at most: the account's plan (never set for the everyone-together budget).
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS plan (id INTEGER PRIMARY KEY CHECK (id = 1), pro INTEGER NOT NULL, until INTEGER, ending INTEGER NOT NULL, checked INTEGER NOT NULL)`);
  }

  /** Forgets everything counted and kept for this account: it has been deleted. */
  async clear(): Promise<void> {
    this.#starts = [];
    await this.ctx.storage.deleteAll();
    // The tables are made again, empty, so a late request finds them (its account no longer signs in).
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS spend (period TEXT PRIMARY KEY, micro INTEGER NOT NULL)`);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS plan (id INTEGER PRIMARY KEY CHECK (id = 1), pro INTEGER NOT NULL, until INTEGER, ending INTEGER NOT NULL, checked INTEGER NOT NULL)`);
  }

  #read(period: string): number {
    return Number(this.#sql.exec(`SELECT micro FROM spend WHERE period = ?`, period).toArray()[0]?.micro ?? 0);
  }

  #add(period: string, micro: number): number {
    const next = Math.max(0, this.#read(period) + Math.round(micro));
    this.#sql.exec(`INSERT OR REPLACE INTO spend (period, micro) VALUES (?, ?)`, period, next);
    // Earlier periods are history nobody reads.
    this.#sql.exec(`DELETE FROM spend WHERE period < ?`, period);
    return next;
  }

  /** What `period` has cost so far. */
  spent(period: string): number {
    return this.#read(period);
  }

  /**
   * Lets a request start if `period` has spent less than `limit`, holding
   * `hold` for it. `perMinute` (0 for none) also limits how many may start a minute.
   */
  admit(period: string, limit: number, hold: number, perMinute = 0, now = Date.now()): Admitted {
    if (perMinute > 0) {
      this.#starts = this.#starts.filter((at) => at > now - WINDOW);
      if (this.#starts.length >= perMinute) return { ok: false, reason: 'fast', retryAfter: Math.max(1, Math.ceil((this.#starts[0] + WINDOW - now) / 1000)) };
    }
    const spent = this.#read(period);
    if (spent >= limit) return { ok: false, reason: 'spent', spent };
    if (perMinute > 0) this.#starts.push(now);
    return { ok: true, spent: this.#add(period, hold) };
  }

  /** Swaps a request's hold for what it cost. Returns what the period has spent. */
  settle(period: string, hold: number, cost: number): number {
    return this.#add(period, cost - hold);
  }

  /** The plan last kept for this account, or null if Polar was never asked. */
  plan(): Kept | null {
    const row = this.#sql.exec(`SELECT pro, until, ending, checked FROM plan WHERE id = 1`).toArray()[0];
    return row ? { pro: row.pro === 1, until: row.until === null ? null : Number(row.until), ending: row.ending === 1, checked: Number(row.checked) } : null;
  }

  /** Keeps what Polar said, as of `now`. */
  setPlan(pro: boolean, until: number | null, ending: boolean, now = Date.now()): Kept {
    this.#sql.exec(`INSERT OR REPLACE INTO plan (id, pro, until, ending, checked) VALUES (1, ?, ?, ?, ?)`, pro ? 1 : 0, until, ending ? 1 : 0, now);
    return { pro, until, ending, checked: now };
  }

  /** Marks what is kept as out of date, so Polar is asked at the next look. */
  stalePlan(): void {
    this.#sql.exec(`UPDATE plan SET checked = 0 WHERE id = 1`);
  }
}
