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
 * `providerCalls` = provider requests ATTEMPTED (0 only when no request was issued — e.g. no
 * key). `succeeded` = the request returned without error and the provider did not report
 * `available:false`. `bars` may still be empty on a successful call (no data for the range) —
 * that is a distinct condition from an error and from "not attempted".
 */
export interface FetchBarsResult { bars: Bar[]; providerCalls: number; succeeded: boolean; note: string }

/** Never echo a key: strip apiKey/Bearer tokens from provider error strings and bound length. */
export function sanitizeProviderNote(s: unknown): string {
  return String(s ?? "")
    .replace(/apiKey=[^&\s]+/gi, "apiKey=***")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer ***")
    .slice(0, 200);
}

/**
 * Fetch real historical stock bars via the existing provider (/v2/aggs). Lazy-requires
 * the provider so the pure replay core stays importable under `node --test`. Never
 * fabricates data — an unavailable provider returns an empty bar set with a note. Reports
 * attempted-vs-succeeded honestly so a caller can never mistake "no request issued" or
 * "provider error" for "no data".
 */
export async function fetchHistoricalStockBars(
  symbol: string,
  opts: { from: string; to: string; timespan?: string; multiplier?: number } = { from: "", to: "" },
  env: NodeJS.ProcessEnv = process.env,
): Promise<FetchBarsResult> {
  if (!stockReplayAvailable(env)) {
    return { bars: [], providerCalls: 0, succeeded: false, note: "stock replay INACTIVE — no provider key (POLYGON_API_KEY / MASSIVE_API_KEY); no request issued" };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetchCandles } = require("@/lib/polygon-provider");
    // fetchCandles reads the aggregate multiplier from `resolution` (not `multiplier`) — pass it
    // correctly so replay actually fetches the intended 1-minute bars, not the 5-minute default.
    const res = await fetchCandles(symbol, { from: opts.from, to: opts.to, timespan: opts.timespan ?? "minute", resolution: String(opts.multiplier ?? 1) });
    const available = res?.available !== false; // fetchCandles returns available:false on its own caught error
    const raw = Array.isArray(res) ? res : (res?.candles ?? res?.bars ?? []);
    const bars: Bar[] = raw
      .map((b: any) => ({ t: Number(b.t ?? b.timestamp ?? b.time), o: Number(b.o ?? b.open), h: Number(b.h ?? b.high), l: Number(b.l ?? b.low), c: Number(b.c ?? b.close), v: Number(b.v ?? b.volume ?? 0) }))
      .filter((b: Bar) => Number.isFinite(b.t) && Number.isFinite(b.c))
      .sort((a: Bar, b: Bar) => a.t - b.t);
    if (!available) return { bars: [], providerCalls: 1, succeeded: false, note: sanitizeProviderNote(res?.note ?? "provider reported available:false") };
    return { bars, providerCalls: 1, succeeded: true, note: bars.length ? "real /v2/aggs OHLCV" : "provider OK but returned no bars for the requested range/timespan" };
  } catch (err: any) {
    return { bars: [], providerCalls: 1, succeeded: false, note: sanitizeProviderNote(`provider error (no fabrication): ${err?.message ?? String(err)}`) };
  }
}
