/**
 * cache.ts — content-addressed cache for historical Massive responses. PURE
 * (in-memory) with an optional injected durable backing store.
 *
 * THE KEY IS THE CONTRACT. A historical response is immutable for a settled
 * window, so caching it is free correctness. But a key that is too loose
 * silently serves the wrong data, which is worse than no cache at all — a
 * mis-keyed hit would put one contract's quotes on another contract's timeline
 * and nothing downstream could detect it.
 *
 * The key therefore includes, always and in this order:
 *   exact OCC | timestamp window | data type | provider version | data version
 *
 * providerVersion changes when the endpoint or its parameters change shape.
 * dataVersion changes when OUR parsing/normalization changes. Bumping either
 * invalidates every prior entry rather than mixing two shapes in one cache.
 */

export const PROVIDER_VERSION = "MASSIVE_V3_2026_07" as const;
export const DATA_VERSION = "ASYM_HIST_V1" as const;

export type HistoricalDataType = "QUOTES" | "TRADES" | "AGGS_1M" | "CHAIN_SNAPSHOT" | "REFERENCE";

export interface CacheKeyParts {
  /** Exact OCC for contract data; the underlying symbol for REFERENCE. */
  occ: string;
  /** Inclusive start of the requested window, epoch ms. */
  fromMs: number;
  /** Exclusive end of the requested window, epoch ms. */
  toMs: number;
  dataType: HistoricalDataType;
  providerVersion?: string;
  dataVersion?: string;
}

/**
 * Build the cache key. Deterministic and total: the same parts always produce
 * the same string, and no part may be omitted.
 */
export function historicalCacheKey(parts: CacheKeyParts): string {
  const occ = String(parts.occ ?? "").trim().toUpperCase();
  if (!occ) throw new Error("historicalCacheKey: occ is required");
  const from = Math.floor(Number(parts.fromMs));
  const to = Math.floor(Number(parts.toMs));
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error("historicalCacheKey: fromMs and toMs must be finite");
  }
  const provider = parts.providerVersion ?? PROVIDER_VERSION;
  const data = parts.dataVersion ?? DATA_VERSION;
  return [occ, `${from}-${to}`, parts.dataType, provider, data].join("|");
}

/** The window portion alone, for per-OCC window accounting. */
export function windowKey(fromMs: number, toMs: number): string {
  return `${Math.floor(fromMs)}-${Math.floor(toMs)}`;
}

export interface CacheEntry<T> {
  value: T;
  storedAtMs: number;
  /** True when the window is fully in the past and can never change again. */
  settled: boolean;
}

export interface DurableCacheStore {
  read: (key: string) => string | null;
  write: (key: string, json: string, storedAtMs: number) => void;
}

/**
 * Bounded LRU over the in-memory tier, with an optional durable tier behind it.
 * A settled window never expires; an unsettled one is re-fetched after `ttlMs`
 * because the last minute of a live session is still moving.
 */
export class HistoricalCache {
  private mem = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly durable: DurableCacheStore | null;

  constructor(opts: { maxEntries?: number; ttlMs?: number; durable?: DurableCacheStore | null } = {}) {
    this.maxEntries = Math.max(16, opts.maxEntries ?? 5_000);
    this.ttlMs = Math.max(1_000, opts.ttlMs ?? 5 * 60_000);
    this.durable = opts.durable ?? null;
  }

  get<T>(key: string, nowMs: number = Date.now()): T | undefined {
    const hit = this.mem.get(key);
    if (hit) {
      if (hit.settled || nowMs - hit.storedAtMs < this.ttlMs) {
        // LRU touch.
        this.mem.delete(key);
        this.mem.set(key, hit);
        return hit.value as T;
      }
      this.mem.delete(key);
    }
    if (!this.durable) return undefined;
    try {
      const raw = this.durable.read(key);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as CacheEntry<T>;
      if (!parsed.settled && nowMs - parsed.storedAtMs >= this.ttlMs) return undefined;
      this.put(key, parsed.value, parsed.settled, parsed.storedAtMs);
      return parsed.value;
    } catch {
      return undefined;
    }
  }

  put<T>(key: string, value: T, settled: boolean, nowMs: number = Date.now()): void {
    if (this.mem.size >= this.maxEntries) {
      const oldest = this.mem.keys().next().value;
      if (oldest !== undefined) this.mem.delete(oldest);
    }
    const entry: CacheEntry<T> = { value, storedAtMs: nowMs, settled };
    this.mem.set(key, entry);
    if (this.durable && settled) {
      try { this.durable.write(key, JSON.stringify(entry), nowMs); } catch { /* cache is never load-bearing */ }
    }
  }

  get size(): number { return this.mem.size; }
  clear(): void { this.mem.clear(); }
}

/**
 * A window is settled once it is entirely in the past by a safety margin. The
 * margin covers late-arriving SIP corrections; inside it we re-fetch rather
 * than trust a possibly incomplete tail.
 */
export const SETTLE_MARGIN_MS = 90_000;

export function isSettledWindow(toMs: number, nowMs: number = Date.now()): boolean {
  return Number.isFinite(toMs) && nowMs - toMs > SETTLE_MARGIN_MS;
}
