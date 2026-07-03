/**
 * scan-cache.ts — tiny in-memory TTL cache + a bounded concurrency runner.
 *
 * Protects the Polygon/Massive rate limit: repeated polls inside the TTL window
 * are served from memory, and per-symbol fan-out is capped by mapLimit so we
 * never blast dozens of requests at once.
 */

interface Entry<T> {
  value: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();

/** Run `fn` at most once per `ttlMs` for a given key; cache the resolved value. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > now) return hit.value;
  const value = await fn();
  store.set(key, { value, expires: now + ttlMs });
  return value;
}

export function cacheAgeMs(key: string, ttlMs: number): number | null {
  const hit = store.get(key);
  if (!hit) return null;
  return Math.max(0, ttlMs - (hit.expires - Date.now()));
}

export function clearCache(): void {
  store.clear();
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
