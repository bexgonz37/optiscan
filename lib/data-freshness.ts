import { toMs } from "./timestamps.ts";
import { marketSession, tradingDay, type MarketSession } from "./trading-session.ts";

export type FreshnessStatus =
  | "LIVE"
  | "DEGRADED"
  | "DELAYED"
  | "STALE"
  | "DISCONNECTED"
  | "MARKET_CLOSED"
  | "NOT_ENTITLED"
  | "NO_DATA";

export type DataKind =
  | "stock_quote"
  | "stock_trade"
  | "one_minute_candle"
  | "options_chain"
  | "options_quote"
  | "options_trade"
  | "greeks"
  | "news";

export type FreshnessSample = {
  symbol: string;
  kind: DataKind;
  provider: string;
  provider_timestamp: string | null;
  provider_timestamp_ms: number | null;
  received_at: string;
  received_at_ms: number;
  data_age_seconds: number | null;
  market_session: MarketSession;
  freshness_status: FreshnessStatus;
  note?: string | null;
};

type ProviderState = {
  provider: string;
  connected: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  last_latency_ms: number | null;
  entitlement_limitations: string[];
};

type G = typeof globalThis & {
  __optiscanFreshness?: {
    samples: Map<string, FreshnessSample>;
    provider: ProviderState;
  };
};

const DEFAULT_MAX_AGE_SECONDS: Record<DataKind, number> = {
  stock_quote: 20,
  stock_trade: 20,
  one_minute_candle: 180,
  options_chain: 45,
  options_quote: 45,
  options_trade: 45,
  greeks: 90,
  news: 86400,
};

// Session-aware relaxation (Phase 1, 2026-07-10): extended-hours tape prints
// far less often — a 67s-old quote on a quiet name after hours is normal, not
// a system failure. RTH keeps the strict bars; premarket/after-hours multiply
// them. Env-tunable; MARKET_CLOSED short-circuits before any of this.
const SESSION_AGE_MULTIPLIER: Record<string, number> = {
  regular: 1,
  premarket: Number(process.env.FRESHNESS_EXTENDED_MULTIPLIER ?? 4),
  afterhours: Number(process.env.FRESHNESS_EXTENDED_MULTIPLIER ?? 4),
};

/** Max LIVE age for a data kind in a session (exported for tests + UI copy). */
export function maxAgeSecondsFor(kind: DataKind, session: MarketSession): number {
  const base = DEFAULT_MAX_AGE_SECONDS[kind] ?? 60;
  return Math.round(base * (SESSION_AGE_MULTIPLIER[session] ?? 1));
}

function store() {
  const g = globalThis as G;
  if (!g.__optiscanFreshness) {
    g.__optiscanFreshness = {
      samples: new Map(),
      provider: {
        provider: "polygon",
        connected: false,
        last_success_at: null,
        last_failure_at: null,
        last_failure_reason: null,
        last_latency_ms: null,
        entitlement_limitations: [],
      },
    };
  }
  return g.__optiscanFreshness;
}

function key(symbol: string, kind: DataKind) {
  return `${String(symbol || "SYSTEM").toUpperCase()}::${kind}`;
}

const MIN_REASONABLE_TIMESTAMP_MS = Date.parse("2000-01-01T00:00:00.000Z");
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function plausibleMs(ms: number, nowMs = Date.now()): number | null {
  if (!Number.isFinite(ms)) return null;
  const rounded = Math.round(ms);
  if (rounded <= 0) return null;
  if (rounded < MIN_REASONABLE_TIMESTAMP_MS) return null;
  if (rounded > nowMs + MAX_FUTURE_SKEW_MS) return null;
  return rounded;
}

// Delegates to the central normalizer (lib/timestamps.ts) — one unit-detection
// implementation for the whole app. Kept for backward compatibility.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function integerStringToMs(text: string, nowMs: number): number | null {
  try {
    const raw = BigInt(text);
    if (raw <= 0n) return null;
    const digits = text.replace(/^[+-]/, "").length;
    let ms: bigint;
    if (digits <= 10) ms = raw * 1000n; // Unix seconds
    else if (digits <= 13) ms = raw; // Unix milliseconds
    else if (digits <= 16) ms = raw / 1000n; // Unix microseconds
    else ms = raw / 1_000_000n; // Unix nanoseconds
    if (ms > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return plausibleMs(Number(ms), nowMs);
  } catch {
    return null;
  }
}

export function normalizeProviderTimestampMs(
  input?: number | string | bigint | Date | null,
  nowMs = Date.now(),
): number | null {
  return toMs(input, nowMs);
}

function classify(kind: DataKind, ageSeconds: number | null, session: MarketSession, note?: string | null): FreshnessStatus {
  const n = String(note ?? "").toLowerCase();
  if (session === "closed") return "MARKET_CLOSED";
  if (n.includes("not entitled") || n.includes("not authorized") || n.includes("forbidden") || n.includes("403")) return "NOT_ENTITLED";
  if (n.includes("no polygon") || n.includes("api key") || n.includes("timeout") || n.includes("quota_exceeded")) return "DISCONNECTED";
  if (ageSeconds == null) return "DEGRADED";
  const max = maxAgeSecondsFor(kind, session);
  if (ageSeconds <= max) return "LIVE";
  if (ageSeconds <= max * 3) return "DELAYED";
  return "STALE";
}

export function recordProviderSuccess(provider = "polygon", latencyMs: number | null = null) {
  const s = store();
  s.provider.provider = provider;
  s.provider.connected = true;
  s.provider.last_success_at = new Date().toISOString();
  s.provider.last_latency_ms = latencyMs;
}

export function recordProviderFailure(provider = "polygon", reason = "request failed", latencyMs: number | null = null) {
  const s = store();
  s.provider.provider = provider;
  s.provider.connected = false;
  s.provider.last_failure_at = new Date().toISOString();
  s.provider.last_failure_reason = String(reason).slice(0, 240);
  s.provider.last_latency_ms = latencyMs;
  if (/not entitled|not authorized|forbidden|403/i.test(reason)) {
    if (!s.provider.entitlement_limitations.includes("provider reported an entitlement/authorization limitation")) {
      s.provider.entitlement_limitations.push("provider reported an entitlement/authorization limitation");
    }
  }
}

export function recordDataSample(input: {
  symbol: string;
  kind: DataKind;
  provider?: string;
  providerTimestamp?: number | string | bigint | Date | null;
  receivedAt?: number | string | bigint | Date | null;
  note?: string | null;
}) {
  const receivedMs = normalizeProviderTimestampMs(input.receivedAt) ?? Date.now();
  const pMs = normalizeProviderTimestampMs(input.providerTimestamp, receivedMs);
  const session = marketSession(receivedMs);
  const ageSeconds = pMs == null ? null : Math.max(0, Math.round((receivedMs - pMs) / 1000));
  const sample: FreshnessSample = {
    symbol: String(input.symbol || "SYSTEM").toUpperCase(),
    kind: input.kind,
    provider: input.provider ?? "polygon",
    provider_timestamp: pMs == null ? null : new Date(pMs).toISOString(),
    provider_timestamp_ms: pMs,
    received_at: new Date(receivedMs).toISOString(),
    received_at_ms: receivedMs,
    data_age_seconds: ageSeconds,
    market_session: session,
    freshness_status: classify(input.kind, ageSeconds, session, input.note),
    note: input.note ?? null,
  };
  store().samples.set(key(sample.symbol, sample.kind), sample);
  return sample;
}

export function recordNoData(symbol: string, kind: DataKind, note = "provider returned no usable data") {
  const sample = recordDataSample({ symbol, kind, note });
  sample.freshness_status = /not entitled|not authorized|forbidden|403/i.test(note) ? "NOT_ENTITLED" : "NO_DATA";
  store().samples.set(key(sample.symbol, sample.kind), sample);
  return sample;
}

export function getFreshnessSample(symbol: string, kind: DataKind): FreshnessSample | null {
  return store().samples.get(key(symbol, kind)) ?? null;
}

export function getSymbolFreshness(symbol: string) {
  const sym = String(symbol || "").toUpperCase();
  const samples = [...store().samples.values()].filter((s) => s.symbol === sym);
  const requiredProblems = samples.filter((s) => isBlockingFreshness(s.freshness_status));
  return {
    symbol: sym,
    market_session: marketSession(),
    trading_day: tradingDay(),
    samples,
    actionable: requiredProblems.length === 0,
    blocking: requiredProblems,
  };
}

export function isBlockingFreshness(status: FreshnessStatus): boolean {
  return status === "STALE"
    || status === "DISCONNECTED"
    || status === "NOT_ENTITLED"
    || status === "NO_DATA"
    || status === "MARKET_CLOSED";
}

export function actionableFreshness(symbol: string, kinds: DataKind[]) {
  const samples = kinds.map((kind) => getFreshnessSample(symbol, kind)).filter(Boolean) as FreshnessSample[];
  const missing = kinds.filter((kind) => !getFreshnessSample(symbol, kind));
  const blocking = samples.filter((s) => isBlockingFreshness(s.freshness_status));
  for (const kind of missing) {
    blocking.push(recordNoData(symbol, kind, "required data type has not been observed in this process"));
  }
  return {
    ok: blocking.length === 0,
    symbol: String(symbol || "").toUpperCase(),
    required: kinds,
    samples: kinds.map((kind) => getFreshnessSample(symbol, kind)).filter(Boolean),
    blocking,
    reason: blocking.map((s) => `${s.kind}: ${s.freshness_status}`).join("; "),
  };
}

function exchangeTime(nowMs = Date.now()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(nowMs));
}

export function getProviderHealth(callStats?: Record<string, unknown>) {
  return {
    ...store().provider,
    call_stats: callStats ?? null,
    rate_limit_status: callStats?.quotaExceeded ? "AT_LIMIT" : "OK",
  };
}

export function getSystemDataHealth(callStats?: Record<string, unknown>) {
  const samples = [...store().samples.values()].sort((a, b) => b.received_at_ms - a.received_at_ms);
  const latestByKind: Partial<Record<DataKind, FreshnessSample>> = {};
  for (const sample of samples) {
    if (!latestByKind[sample.kind]) latestByKind[sample.kind] = sample;
  }
  const staleSymbols = [...new Set(samples.filter((s) => isBlockingFreshness(s.freshness_status)).map((s) => s.symbol))];
  return {
    application_time: new Date().toISOString(),
    exchange_time: exchangeTime(),
    trading_day: tradingDay(),
    market_session: marketSession(),
    provider: getProviderHealth(callStats),
    freshness: latestByKind,
    monitored_symbols: [...new Set(samples.map((s) => s.symbol))].sort(),
    stale_symbols: staleSymbols.sort(),
    entitlement_limitations: store().provider.entitlement_limitations,
    samples: samples.slice(0, 250),
  };
}

export function __resetFreshnessForTest() {
  delete (globalThis as G).__optiscanFreshness;
}
