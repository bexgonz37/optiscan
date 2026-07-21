/**
 * lib/research/replay-provider.ts — honest historical-data capability wrapper for
 * replay (Phase 7). PURE capability reporting + a thin lazy fetch for STOCK bars.
 *
 * TRUTH: the current Polygon/Massive integration supplies historical STOCK OHLCV via
 * /v2/aggs, but only a PRESENT-TIME options snapshot (/v3/snapshot/options). Historical
 * option quotes, Greeks, NBBO, open interest, and spreads are NOT integrated/entitled —
 * so options replay is reported INACTIVE_MISSING_PROVIDER and NEVER fabricates those.
 */
export interface Bar {
  t: number; // ms epoch (bar start)
  o: number; h: number; l: number; c: number; v: number;
}

export type ReplayCapabilityStatus = "AVAILABLE" | "INACTIVE_MISSING_PROVIDER";

export interface ReplayCapability {
  assetClass: "stock" | "option";
  status: ReplayCapabilityStatus;
  reason: string;
  availableFields: string[];
  missingFields: string[];
}

export function replayCapabilities(env: NodeJS.ProcessEnv = process.env): ReplayCapability[] {
  const hasKey = Boolean(env.POLYGON_API_KEY || env.MASSIVE_API_KEY);
  return [
    {
      assetClass: "stock",
      status: hasKey ? "AVAILABLE" : "INACTIVE_MISSING_PROVIDER",
      reason: hasKey ? "historical OHLCV via /v2/aggs" : "no POLYGON_API_KEY / MASSIVE_API_KEY configured",
      availableFields: ["timestamp", "open", "high", "low", "close", "volume"],
      missingFields: hasKey ? [] : ["provider_api_key"],
    },
    {
      assetClass: "option",
      status: "INACTIVE_MISSING_PROVIDER",
      reason: "current integration provides only a present-time /v3/snapshot/options; historical option quotes/Greeks/NBBO/OI/spreads are not integrated or entitled",
      availableFields: [],
      missingFields: [
        "historical_bid", "historical_ask", "historical_spread", "historical_open_interest",
        "historical_volume", "historical_iv", "historical_delta", "historical_gamma", "historical_theta", "historical_vega",
      ],
    },
  ];
}

export function stockReplayAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return replayCapabilities(env).find((c) => c.assetClass === "stock")?.status === "AVAILABLE";
}

/** The exact reason options replay cannot be truthfully activated. */
export function optionsReplayBlocker(): string {
  return replayCapabilities().find((c) => c.assetClass === "option")!.reason;
}

/**
 * `providerCalls` = provider requests ATTEMPTED across all chunks (0 only when no request was
 * issued — e.g. no key). `succeeded` = EVERY chunk returned without error and the provider did
 * not report `available:false`. `bars` may still be empty on a successful call (no data for the
 * range). `rangeComplete` = every chunk succeeded AND none hit the per-call result cap (so no
 * silent truncation). `truncated` = at least one chunk returned exactly the requested limit.
 */
export interface ChunkDetail { from: string; to: string; bars: number; succeeded: boolean; truncated: boolean; note?: string }
export interface FetchBarsResult {
  bars: Bar[]; providerCalls: number; succeeded: boolean; note: string;
  chunks: number; rangeComplete: boolean; truncated: boolean;
  firstBarMs: number | null; lastBarMs: number | null;
  chunkDetail: ChunkDetail[];
}

/** Never echo a key: strip apiKey/Bearer tokens from provider error strings and bound length. */
export function sanitizeProviderNote(s: unknown): string {
  return String(s ?? "")
    .replace(/apiKey=[^&\s]+/gi, "apiKey=***")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer ***")
    .slice(0, 200);
}

// One /v2/aggs call caps at Polygon's per-page maximum and the adapter does NOT follow next_url,
// so we split the requested range into deterministic calendar-day windows small enough that a
// single call comfortably covers each — no reliance on next_url pagination semantics.
export const REPLAY_CHUNK_DAYS = 30;      // ~21 trading days ≈ ≤ ~20k 1-min bars, well under the cap
export const REPLAY_PER_CALL_LIMIT = 50_000; // Polygon /v2/aggs max results per call

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Split [from,to] (inclusive, YYYY-MM-DD) into non-overlapping windows of `chunkDays` days. */
export function replayDateWindows(from: string, to: string, chunkDays: number = REPLAY_CHUNK_DAYS): Array<{ from: string; to: string }> {
  const s0 = Date.parse(`${from}T00:00:00Z`);
  const e0 = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(s0) || !Number.isFinite(e0) || s0 > e0) return [{ from, to }];
  const span = Math.max(1, Math.floor(chunkDays));
  const out: Array<{ from: string; to: string }> = [];
  for (let s = s0; s <= e0; s = s + span * DAY_MS) {
    const e = Math.min(s + (span - 1) * DAY_MS, e0);
    out.push({ from: isoDay(s), to: isoDay(e) });
  }
  return out;
}

function mapBars(raw: any[]): Bar[] {
  return raw
    .map((b: any) => ({ t: Number(b.t ?? b.timestamp ?? b.time), o: Number(b.o ?? b.open), h: Number(b.h ?? b.high), l: Number(b.l ?? b.low), c: Number(b.c ?? b.close), v: Number(b.v ?? b.volume ?? 0) }))
    .filter((b: Bar) => Number.isFinite(b.t) && Number.isFinite(b.c));
}

/**
 * Fetch real historical stock bars via the existing provider (/v2/aggs), chunking the requested
 * range into date windows so the full interval is covered instead of being truncated at the
 * per-call result cap. Bars are deduplicated by timestamp across chunks and sorted ascending.
 * Lazy-requires the provider so the pure replay core stays importable under `node --test`. Never
 * fabricates data. Reports attempted-vs-succeeded, per-chunk detail, and whether the range is
 * complete so a caller can never mistake truncated/partial coverage for a full fetch.
 */
export type FetchCandlesFn = (symbol: string, opts: Record<string, unknown>) => Promise<any>;

export async function fetchHistoricalStockBars(
  symbol: string,
  opts: { from: string; to: string; timespan?: string; multiplier?: number; chunkDays?: number; onChunk?: (d: ChunkDetail & { index: number; total: number }) => void } = { from: "", to: "" },
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetchCandles?: FetchCandlesFn } = {},
): Promise<FetchBarsResult> {
  if (!stockReplayAvailable(env)) {
    return { bars: [], providerCalls: 0, succeeded: false, note: "stock replay INACTIVE — no provider key (POLYGON_API_KEY / MASSIVE_API_KEY); no request issued", chunks: 0, rangeComplete: false, truncated: false, firstBarMs: null, lastBarMs: null, chunkDetail: [] };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fetchCandles: FetchCandlesFn = deps.fetchCandles ?? require("@/lib/polygon-provider").fetchCandles;
  const timespan = opts.timespan ?? "minute";
  const resolution = String(opts.multiplier ?? 1); // fetchCandles reads the multiplier from `resolution`
  const windows = replayDateWindows(opts.from, opts.to, opts.chunkDays ?? REPLAY_CHUNK_DAYS);

  const seen = new Map<number, Bar>(); // dedup by timestamp across chunks
  const chunkDetail: ChunkDetail[] = [];
  let providerCalls = 0, anyError = false, truncated = false;

  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    providerCalls += 1;
    let detail: ChunkDetail;
    try {
      const res = await fetchCandles(symbol, { from: w.from, to: w.to, timespan, resolution, limit: REPLAY_PER_CALL_LIMIT });
      const available = res?.available !== false;
      if (!available) {
        anyError = true;
        detail = { from: w.from, to: w.to, bars: 0, succeeded: false, truncated: false, note: sanitizeProviderNote(res?.note ?? "provider reported available:false") };
      } else {
        const raw = Array.isArray(res) ? res : (res?.candles ?? res?.bars ?? []);
        const bars = mapBars(raw);
        for (const b of bars) if (!seen.has(b.t)) seen.set(b.t, b);
        const capHit = res?.resultCap === true || bars.length >= REPLAY_PER_CALL_LIMIT;
        if (capHit) truncated = true;
        detail = { from: w.from, to: w.to, bars: bars.length, succeeded: true, truncated: capHit };
      }
    } catch (err: any) {
      anyError = true;
      detail = { from: w.from, to: w.to, bars: 0, succeeded: false, truncated: false, note: sanitizeProviderNote(`provider error: ${err?.message ?? String(err)}`) };
    }
    chunkDetail.push(detail);
    try { opts.onChunk?.({ ...detail, index: wi, total: windows.length }); } catch { /* progress callback must never break the fetch */ }
  }

  const bars = [...seen.values()].sort((a, b) => a.t - b.t);
  const succeeded = chunkDetail.length > 0 && chunkDetail.every((c) => c.succeeded);
  const rangeComplete = succeeded && !truncated && bars.length > 0;
  const firstBarMs = bars.length ? bars[0].t : null;
  const lastBarMs = bars.length ? bars[bars.length - 1].t : null;
  const note = !succeeded
    ? sanitizeProviderNote(chunkDetail.find((c) => !c.succeeded)?.note ?? "one or more chunks failed")
    : truncated
      ? `truncated: a chunk hit the ${REPLAY_PER_CALL_LIMIT}-result cap — range NOT fully covered`
      : bars.length
        ? `real /v2/aggs OHLCV across ${windows.length} chunk(s)`
        : "provider OK but returned no bars for the requested range/timespan";

  return { bars, providerCalls, succeeded, note, chunks: windows.length, rangeComplete, truncated, firstBarMs, lastBarMs, chunkDetail };
}
