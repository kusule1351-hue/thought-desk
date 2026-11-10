/**
 * The two limits on one account (docs/sync.md, Limits per account): a rolling
 * per-minute budget that every call spends from (heavier calls spend more),
 * and the bucket of items a push spends from, which fills again over a day.
 * Both are plain arithmetic on a clock; the Vault keeps their state.
 */

/** Every call draws on this much a minute; a pull, blob call or push costs `HEAVY`, an info or key call `LIGHT`. */
export const BUDGET = 600;
export const WINDOW = 60_000;
export const LIGHT = 1;
export const HEAVY = 5;

/** Items an account may push in a burst, and how long an empty bucket takes to fill. */
export const BUCKET_ITEMS = 200_000;
export const BUCKET_PERIOD = 24 * 60 * 60_000;

/** The calls of the last minute, in memory (a limiter that forgets on eviction is fine for reads). */
export class Hits {
  #log: [at: number, weight: number][] = [];

  /** Spends `weight`. Returns 0, or the seconds to wait (and spends nothing). */
  take(weight: number, now: number): number {
    this.#log = this.#log.filter(([at]) => at > now - WINDOW);
    let over = this.#log.reduce((sum, [, w]) => sum + w, 0) + weight - BUDGET;
    if (over > 0) {
      for (const [at, w] of this.#log) {
        over -= w;
        if (over <= 0) return Math.max(1, Math.ceil((at + WINDOW - now) / 1000));
      }
    }
    this.#log.push([now, weight]);
    return 0;
  }
}

/** What the item bucket held at `at`. Kept in Durable Object storage, so an eviction doesn't refill it. */
export interface Bucket {
  tokens: number;
  at: number;
}

/** The bucket as it is at `now`: filled linearly, never past its capacity. A bucket never seen is full. */
export function refilled(bucket: Bucket | undefined, now: number): Bucket {
  if (!bucket) return { tokens: BUCKET_ITEMS, at: now };
  const gained = (Math.max(0, now - bucket.at) * BUCKET_ITEMS) / BUCKET_PERIOD;
  return { tokens: Math.min(BUCKET_ITEMS, bucket.tokens + gained), at: now };
}

/** Seconds until `bucket` holds `need` items (0 if it already does). */
export function secondsFor(bucket: Bucket, need: number): number {
  if (bucket.tokens >= need) return 0;
  return Math.max(1, Math.ceil(((need - bucket.tokens) * BUCKET_PERIOD) / BUCKET_ITEMS / 1000));
}
