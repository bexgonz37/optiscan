/**
 * capability-matrix.ts — what the Massive plan actually provides, PROVEN.
 *
 * EVERY ROW BELOW WAS PROBED, NOT ASSUMED. The probe is
 * scripts/massive-capability-probe.mjs; it issues one request per endpoint and
 * prints status, row count, and a sample. `probedAt` records when the claims in
 * this file were last confirmed against the live key.
 *
 * THIS FILE CORRECTS A MATERIAL REPO ERROR. Two modules asserted that
 * historical option data was unavailable:
 *
 *   lib/research/replay-provider.ts:
 *     "historical option quotes, Greeks, NBBO, open interest, and spreads are
 *      NOT integrated/entitled"
 *   lib/research/asymmetry/source-priority.ts (historicalOptionQuotes):
 *     providerSupport: "NOT_AVAILABLE"
 *
 * The first clause was right and the second was wrong. Nothing was INTEGRATED —
 * true, and still the reason options replay had to stay inactive. But the plan
 * IS ENTITLED: /v3/quotes/{OCC} returns full NBBO with sizes for expired
 * contracts back to at least 2023-07-31. Believing otherwise is why the radar
 * could only grade forward, and why no historical winner cohort existed.
 *
 * Both modules now defer to this matrix rather than restating a claim.
 */

export const CAPABILITY_MATRIX_VERSION = "MASSIVE_CAPS_2026_07_31" as const;
/** When the probe last confirmed these rows against the live key. */
export const PROBED_AT = "2026-07-31" as const;

export type Availability =
  /** Probed: returned 200 with usable rows. */
  | "AVAILABLE_PROVEN"
  /** Probed: returned 200 but the shape carries no usable value for us. */
  | "AVAILABLE_NOT_USEFUL"
  /** Probed: refused (401/403/entitlement message). */
  | "NOT_ENTITLED"
  /** Not probed. Never treated as available. */
  | "UNPROVEN";

export type IntegrationStatus =
  /** A repo wrapper calls it today. */
  | "INTEGRATED"
  /** A wrapper exists but nothing in the live path calls it yet. */
  | "INTEGRATED_UNUSED"
  /** Entitled, no wrapper. */
  | "NOT_INTEGRATED";

export interface CapabilityRow {
  dataType: string;
  endpoint: string;
  /** The repo function that calls it, or null when nothing does. */
  providerMethod: string | null;
  availability: Availability;
  integration: IntegrationStatus;
  /** How far back the probe confirmed data. Null when not applicable. */
  historicalDepth: string | null;
  bidAskAvailable: boolean;
  /** Requests consumed by one logical fetch, before pagination. */
  requestCost: string;
  paginationCost: string;
  cacheStatus: string;
  /** What stops this being used today. Null when nothing does. */
  blocker: string | null;
  /** The probe observation this row rests on. */
  evidence: string;
}

export const MASSIVE_CAPABILITY_MATRIX: readonly CapabilityRow[] = Object.freeze([
  {
    dataType: "Historical exact-OCC NBBO quotes (bid/ask + sizes)",
    endpoint: "GET /v3/quotes/{optionsTicker}",
    providerMethod: "fetchHistoricalOptionQuotes (lib/research/asymmetry/historical/massive-historical.ts)",
    availability: "AVAILABLE_PROVEN",
    integration: "INTEGRATED_UNUSED",
    historicalDepth: "confirmed to 2023-07-31 on expired NVDA contracts; not probed earlier",
    bidAskAvailable: true,
    requestCost: "1 request per contract per timestamp window",
    paginationCost: "next_url present; 1 extra request per additional page (limit max 50,000)",
    cacheStatus: "cached by [OCC|window|QUOTES|providerVersion|dataVersion]; settled windows never expire",
    blocker: null,
    evidence: "Probe 2026-07-31: 200, rows carry bid_price/ask_price/bid_size/ask_size/sip_timestamp (ns). Verified on O:NVDA260729C00210000, O:NVDA240802C00118000, O:NVDA230804C00432500.",
  },
  {
    dataType: "Historical exact-OCC trades",
    endpoint: "GET /v3/trades/{optionsTicker}",
    providerMethod: "fetchHistoricalOptionTrades (same module)",
    availability: "AVAILABLE_PROVEN",
    integration: "INTEGRATED_UNUSED",
    historicalDepth: "confirmed to 2024-07-31; sparse or empty for illiquid contracts, which is real absence not failure",
    bidAskAvailable: false,
    requestCost: "1 request per contract per window",
    paginationCost: "next_url present; 1 request per page",
    cacheStatus: "cached by [OCC|window|TRADES|...]",
    blocker: null,
    evidence: "Probe 2026-07-31: 200 with price/size/sip_timestamp/conditions. Two probed illiquid contracts returned 0 rows with status 200 — confirmed empty, distinguishable from an error.",
  },
  {
    dataType: "Historical exact-OCC aggregates (1-minute and daily)",
    endpoint: "GET /v2/aggs/ticker/{O:...}/range/{mult}/{span}/{from}/{to}",
    providerMethod: "fetchHistoricalBars (same module)",
    availability: "AVAILABLE_PROVEN",
    integration: "INTEGRATED_UNUSED",
    historicalDepth: "confirmed to 2023-07-31",
    bidAskAvailable: false,
    requestCost: "1 request per ticker per date range",
    paginationCost: "50,000 results per call; chunk by date window rather than paginate",
    cacheStatus: "cached by [ticker|window|AGGS_1M|...]",
    blocker: "TRADE-derived. Cannot answer 'what could have been paid' — only /v3/quotes can. Never substitute it for NBBO.",
    evidence: "Probe 2026-07-31: 200 with o/h/l/c/v/vw/n on option tickers and plain symbols alike.",
  },
  {
    dataType: "Historical underlying NBBO and trades",
    endpoint: "GET /v3/quotes/{stocksTicker}, GET /v3/trades/{stocksTicker}",
    providerMethod: null,
    availability: "AVAILABLE_PROVEN",
    integration: "NOT_INTEGRATED",
    historicalDepth: "confirmed on 2026-07-30",
    bidAskAvailable: true,
    requestCost: "1 request per symbol per window",
    paginationCost: "next_url; 1 request per page",
    cacheStatus: "no wrapper, so no cache",
    blocker: "Not needed yet — 1-minute bars answer the underlying questions the radar asks at far lower cost.",
    evidence: "Probe 2026-07-31: 200 with bid_price/ask_price/sizes/participant_timestamp for NVDA.",
  },
  {
    dataType: "Historical underlying aggregates",
    endpoint: "GET /v2/aggs/ticker/{sym}/range/...",
    providerMethod: "fetchCandles (lib/polygon-provider.js), fetchHistoricalStockBars (lib/research/replay-provider.ts)",
    availability: "AVAILABLE_PROVEN",
    integration: "INTEGRATED",
    historicalDepth: "confirmed to 2023-07-31",
    bidAskAvailable: false,
    requestCost: "1 request per symbol per chunk (30-day chunks)",
    paginationCost: "50,000 cap per call; chunked by date",
    cacheStatus: "lib/scan-cache.ts TTL cache on the live path only",
    blocker: null,
    evidence: "Probe 2026-07-31: 200 with full OHLCV + vw + n.",
  },
  {
    dataType: "Live option chain snapshot (quotes, Greeks, IV, OI, day volume)",
    endpoint: "GET /v3/snapshot/options/{underlying}",
    providerMethod: "fetchOptionChain (lib/polygon-provider.js)",
    availability: "AVAILABLE_PROVEN",
    integration: "INTEGRATED",
    historicalDepth: "present-time only — this endpoint has no historical mode",
    bidAskAvailable: true,
    requestCost: "1 request per 250 contracts",
    paginationCost: "next_url; OPTIONS_CHAIN_MAX_PAGES caps at 4 pages = 1,000 contracts",
    cacheStatus: "lib/scan-cache.ts TTL cache",
    blocker: null,
    evidence: "Probe 2026-07-31 on NVDA, 250-contract page: 250/250 rows carried open_interest and last_quote (bid/ask/sizes/last_updated); 160/250 carried greeks and implied_volatility; 221/250 carried day.volume. last_quote.timeframe reported REAL-TIME, not delayed.",
  },
  {
    dataType: "Greeks (delta, gamma, theta, vega) and implied volatility",
    endpoint: "GET /v3/snapshot/options/{underlying} → results[].greeks / .implied_volatility",
    providerMethod: "fetchOptionChain",
    availability: "AVAILABLE_PROVEN",
    integration: "INTEGRATED",
    historicalDepth: "none — Greeks are snapshot-only and CANNOT be reconstructed historically",
    bidAskAvailable: false,
    requestCost: "included in the chain request, no extra call",
    paginationCost: "as chain",
    cacheStatus: "as chain",
    blocker: "Only delta is mapped downstream (lib/research/options/live-deps.ts); gamma/theta/vega/IV are fetched and then dropped before persistence. Absent on 90/250 probed contracts — deep ITM/OTM rows carry an empty greeks object.",
    evidence: "Probe 2026-07-31: ATM NVDA call returned delta 0.6577, gamma 0.1871, theta -1.2906, vega 0.0194, IV 0.3561.",
  },
  {
    dataType: "Open interest",
    endpoint: "GET /v3/snapshot/options/{underlying} → results[].open_interest",
    providerMethod: "fetchOptionChain",
    availability: "AVAILABLE_PROVEN",
    integration: "INTEGRATED",
    historicalDepth: "none via snapshot. OI is a daily settlement figure and has no intraday history on this plan.",
    bidAskAvailable: false,
    requestCost: "included in the chain request",
    paginationCost: "as chain",
    cacheStatus: "as chain",
    blocker: "Historical OI for a past session is NOT reconstructible. Cohort rows for past dates must leave it missing.",
    evidence: "Probe 2026-07-31: 250/250 contracts carried open_interest (ATM sample 32,325).",
  },
  {
    dataType: "Contract reference, including expired contracts",
    endpoint: "GET /v3/reference/options/contracts?expired=true",
    providerMethod: null,
    availability: "AVAILABLE_PROVEN",
    integration: "NOT_INTEGRATED",
    historicalDepth: "confirmed back to 2010 expirations",
    bidAskAvailable: false,
    requestCost: "1 request per 200-1,000 contracts",
    paginationCost: "next_url; 1 request per page",
    cacheStatus: "no wrapper, so no cache",
    blocker: "Needed to enumerate the historical cohort universe — an expired OCC cannot be found any other way. This is the next integration to build.",
    evidence: "Probe 2026-07-31: 200. expired=true + expiration_date range returned 200 NVDA contracts per page for 2026, 2025, 2024 and 2023 windows. NOTE: combining as_of with an expiration_date range returned 0 rows — use the date range alone.",
  },
  {
    dataType: "Historical option chain snapshot (whole chain as of a past instant)",
    endpoint: "none",
    providerMethod: null,
    availability: "UNPROVEN",
    integration: "NOT_INTEGRATED",
    historicalDepth: null,
    bidAskAvailable: false,
    requestCost: "n/a",
    paginationCost: "n/a",
    cacheStatus: "n/a",
    blocker: "No such endpoint was found. A past chain must be REBUILT: enumerate contracts via reference(expired=true), then request per-OCC quotes. Cost is linear in contracts, which is exactly why the per-run and per-symbol caps exist.",
    evidence: "Not probed successfully; no endpoint identified. Recorded as UNPROVEN rather than unavailable.",
  },
  {
    dataType: "Rate limit / throttling",
    endpoint: "all",
    providerMethod: "recordPolygonCall (lib/polygon-provider.js) + RequestAccountant (historical lane)",
    availability: "AVAILABLE_PROVEN",
    integration: "INTEGRATED",
    historicalDepth: null,
    bidAskAvailable: false,
    requestCost: "n/a",
    paginationCost: "n/a",
    cacheStatus: "n/a",
    blocker: "No provider-side limit was observed, so OUR caps are the only real limit. That makes them load-bearing, not advisory.",
    evidence: "Probe 2026-07-31: 40 concurrent /v3/quotes requests returned 40x200 in 663ms with zero 429s. No X-RateLimit or Retry-After headers were returned on any probed response.",
  },
]);

/** Rows that block a piece of planned work. The honest to-do list. */
export function blockers(): Array<{ dataType: string; blocker: string }> {
  return MASSIVE_CAPABILITY_MATRIX
    .filter((r) => r.blocker != null)
    .map((r) => ({ dataType: r.dataType, blocker: r.blocker as string }));
}

/** True only for rows actually probed and proven. Never optimistic. */
export function isProven(dataType: string): boolean {
  return MASSIVE_CAPABILITY_MATRIX.some((r) => r.dataType === dataType && r.availability === "AVAILABLE_PROVEN");
}

export function capabilitySummary(): {
  version: string; probedAt: string;
  proven: number; notEntitled: number; unproven: number;
  integrated: number; entitledButUnintegrated: number;
} {
  const m = MASSIVE_CAPABILITY_MATRIX;
  return {
    version: CAPABILITY_MATRIX_VERSION,
    probedAt: PROBED_AT,
    proven: m.filter((r) => r.availability === "AVAILABLE_PROVEN").length,
    notEntitled: m.filter((r) => r.availability === "NOT_ENTITLED").length,
    unproven: m.filter((r) => r.availability === "UNPROVEN").length,
    integrated: m.filter((r) => r.integration === "INTEGRATED").length,
    entitledButUnintegrated: m.filter(
      (r) => r.availability === "AVAILABLE_PROVEN" && r.integration !== "INTEGRATED").length,
  };
}
