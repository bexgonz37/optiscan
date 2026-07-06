/**
 * scan-cache.ts — tiny in-memory TTL cache + a bounded concurrency runner.
 *
 * Protects the Polygon/Massive rate limit: repeated polls inside the TTL window
 * are served from memory, per-symbol fan-out is capped by mapLimit, and
 * IN-FLIGHT promises are shared — if two requests (e.g. /momentum and /unusual
 * on the same tick) miss the cache simultaneously, only ONE scan runs and both
 * await the same promise.
 *
 * NOTE: this cache is process-local. In a multi-instance or serverless deploy
 * every instance/lambda keeps its own copy, so dedup and TTLs only apply per
 * process. Fine for the intended single-instance `next start`; see README.
 */

interface Entry<T> {
  value: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();
const pending = new Map<string, Promise<unknown>>();

/** Run `fn` at most once per `ttlMs` for a given key; cache the resolved value.
 * Concurrent callers on a cold key share one in-flight promise. Rejections are
 * NOT cached — the next caller retries. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > now) return hit.value;

  const inflight = pending.get(key) as Promise<T> | undefined;
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const value = await fn();
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

interface AgeEntry<T> {
  value: T;
  ts: number;
}
const ageStore = new Map<string, AgeEntry<unknown>>();
const agePending = new Map<string, Promise<unknown>>();

/**
 * Age-based cache: serve the stored value only if it's younger than `maxAgeMs`.
 * Lets the caller (the client's poll rate) control freshness at request time.
 * Concurrent callers on a stale/cold key share one in-flight promise, so a
 * simultaneous momentum + unusual request triggers a single underlying scan.
 * Rejections are not cached.
 */
export async function cachedMaxAge<T>(key: string, maxAgeMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = ageStore.get(key) as AgeEntry<T> | undefined;
  if (hit && now - hit.ts <= Math.max(0, maxAgeMs)) return hit.value;

  const inflight = agePending.get(key) as Promise<T> | undefined;
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const value = await fn();
      ageStore.set(key, { value, ts: Date.now() });
      return value;
    } finally {
      agePending.delete(key);
    }
  })();
  agePending.set(key, p);
  return p;
}

export function clearCache(): void {
  store.clear();
  ageStore.clear();
  pending.clear();
  agePending.clear();
}

/** Map over items with a bounded number of in-flight promises. Order preserved. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const size = Math.max(1, Math.min(limit || 1, items.length || 1));
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: size }, () => run()));
  return results;
}
