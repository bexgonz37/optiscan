/**
 * High-Asymmetry Radar — canonical evidence model. PURE, shadow-only.
 *
 * This module defines the ONLY vocabulary the radar is allowed to reason with:
 * timestamped facts that were genuinely available at the candidate timestamp.
 *
 * Three rules are enforced structurally rather than by convention:
 *
 *  1. MISSING STAYS MISSING. Every optional field is `number | null` (or a
 *     `…_UNKNOWN` enum member) and every null carries a machine-readable reason
 *     in `missing`. Nothing is ever defaulted to 0, and 0 is never a stand-in
 *     for "we could not source this".
 *  2. NOTHING IS FABRICATED. A catalyst without a named source is REJECTED, not
 *     downgraded to a guess. Greeks are accepted only with a provider source. A
 *     relative-volume figure is accepted only with a named baseline. An OCC
 *     symbol is accepted only when it parses AND agrees with the separately
 *     supplied underlying/expiration/strike/type.
 *  3. NO FUTURE EVIDENCE. Any observation stamped after the candidate timestamp
 *     is rejected with `EVIDENCE_FROM_FUTURE` and cannot reach the candidate.
 *
 * No I/O. No provider access. No clock reads beyond the caller-supplied
 * `detectionAtMs` / `maxQuoteAgeMs`.
 */
import { isOptionsQuoteSession } from "../../market-session-guard.ts";
import { marketSession, tradingDay } from "../../trading-session.ts";
import type { SetupFamily } from "../watchlist/setup-families.ts";

/** Why a field is null. Never "0", never an inferred value. */
export type MissingReason =
  | "NOT_PROVIDED"
  | "NOT_FINITE"
  | "OUT_OF_RANGE"
  | "NO_NAMED_SOURCE"
  | "NO_BASELINE"
  | "PROVIDER_UNSUPPORTED"
  | "EVIDENCE_FROM_FUTURE"
  | "QUOTE_INVALID"
  | "OCC_UNVERIFIED";

/** Why an executable quote was refused. */
export type QuoteRejection =
  | "INVALID_QUOTE"
  | "QUOTE_TIMESTAMP_UNAVAILABLE"
  | "QUOTE_TIMESTAMP_IN_FUTURE"
  | "QUOTE_STALE"
  | "QUOTE_OUTSIDE_OPTIONS_SESSION"
  | "QUOTE_FROM_DIFFERENT_SESSION"
  | "QUOTE_WRONG_OCC";

export type QuoteFreshness = "FRESH" | "STALE" | "UNKNOWN";
export type CatalystState = "CONFIRMED" | "ABSENT_OR_UNKNOWN" | "REJECTED_UNSOURCED";
export type Alignment = "ALIGNED" | "CONFLICTED" | "NEUTRAL" | "UNKNOWN";
export type CompressionState = "COMPRESSED" | "EXPANDING" | "EXPANDED" | "UNKNOWN";
export type LiquidityState = "EXECUTABLE" | "THIN" | "ILLIQUID" | "UNKNOWN";
export type SpreadQuality = "TIGHT" | "ACCEPTABLE" | "WIDE" | "UNKNOWN";
export type IvState = "ELEVATED" | "NEUTRAL" | "DEPRESSED" | "UNKNOWN";

/** Session bucket of the candidate timestamp, from the ET clock only. */
export type SessionPhase = "PREMARKET" | "REGULAR" | "AFTERHOURS" | "CLOSED";

/** Time-of-day bucket (ET). Fixed boundaries; not a tuned parameter. */
export type TimeOfDayBucket =
  | "PREMARKET"
  | "OPEN_30"
  | "MORNING"
  | "MIDDAY"
  | "AFTERNOON"
  | "POWER_HOUR"
  | "AFTERHOURS";

export const TIME_OF_DAY_BUCKETS: TimeOfDayBucket[] = [
  "PREMARKET", "OPEN_30", "MORNING", "MIDDAY", "AFTERNOON", "POWER_HOUR", "AFTERHOURS",
];

/** One timestamped option quote observation for an exact OCC contract. */
export interface AsymmetryQuoteObservation {
  occSymbol: string;
  atMs: number;
  bid: number | null;
  ask: number | null;
  /** Provider event time for the quote, not the time we happened to read it. */
  quoteTimestampMs: number | null;
  source: string;
}

/** A validated executable quote, or the reason it was refused. */
export interface ExecutableQuote {
  valid: boolean;
  reason: QuoteRejection | null;
  atMs: number;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  spread: number | null;
  spreadPct: number | null;
  quoteTimestampMs: number | null;
  quoteAgeMs: number | null;
  freshness: QuoteFreshness;
}

/**
 * Raw, untrusted input. Every field is optional: the normalizer decides what
 * survives. Callers must NOT pre-fill anything they could not source.
 */
export interface RawAsymmetryEvidence {
  candidateId: string;
  symbol: string;
  direction?: string | null;
  detectionAtMs: number;
  setupFamily?: SetupFamily | string | null;
  underlyingPrice?: number | null;

  occSymbol?: string | null;
  expiration?: string | null;
  strike?: number | null;
  optionType?: string | null;
  dte?: number | null;

  bid?: number | null;
  ask?: number | null;
  quoteTimestampMs?: number | null;
  quoteSource?: string | null;

  optionVolume?: number | null;
  openInterest?: number | null;
  stockVolume?: number | null;

  /** Relative volume is accepted ONLY with a named same-time-of-day baseline. */
  relativeStockVolume?: number | null;
  relativeVolumeBaselineSource?: string | null;

  /** Volume acceleration over an explicit bounded window; both are required. */
  volumeAcceleration?: number | null;
  volumeAccelerationWindowMs?: number | null;

  underlyingMovePctBeforeDetection?: number | null;
  underlyingMoveWindowMs?: number | null;

  distanceToLevelPct?: number | null;
  roomToNextLevelPct?: number | null;
  levelSource?: string | null;

  relativeStrengthVsSpyPct?: number | null;
  relativeStrengthVsQqqPct?: number | null;
  relativeStrengthVsSectorPct?: number | null;
  relativeStrengthSource?: string | null;

  impliedVolatility?: number | null;
  impliedVolatilityChange?: number | null;
  ivSource?: string | null;
  ivState?: IvState | null;

  /** Greeks are provider facts. Without a provider source they do not exist. */
  delta?: number | null;
  gamma?: number | null;
  greeksSource?: string | null;

  catalystType?: string | null;
  catalystSource?: string | null;

  marketAlignment?: Alignment | null;
  sectorAlignment?: Alignment | null;
  compressionState?: CompressionState | null;

  blockers?: string[] | null;
}

/** Normalized, trustworthy evidence. Nulls are real absences, never zeros. */
export interface AsymmetryEvidence {
  candidateId: string;
  symbol: string;
  direction: "bullish" | "bearish" | null;
  detectionAtMs: number;
  sessionDate: string | null;
  sessionPhase: SessionPhase;
  timeOfDay: TimeOfDayBucket | null;
  setupFamily: string | null;
  underlyingPrice: number | null;

  occSymbol: string | null;
  expiration: string | null;
  strike: number | null;
  optionType: "call" | "put" | null;
  dte: number | null;

  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  spread: number | null;
  spreadPct: number | null;
  quoteTimestampMs: number | null;
  quoteAgeMs: number | null;
  quoteFreshness: QuoteFreshness;
  quoteRejection: QuoteRejection | null;

  optionVolume: number | null;
  openInterest: number | null;
  volumeOpenInterestRatio: number | null;
  stockVolume: number | null;
  relativeStockVolume: number | null;
  volumeAcceleration: number | null;
  volumeAccelerationWindowMs: number | null;

  underlyingMovePctBeforeDetection: number | null;
  distanceToLevelPct: number | null;
  roomToNextLevelPct: number | null;

  relativeStrengthVsSpyPct: number | null;
  relativeStrengthVsQqqPct: number | null;
  relativeStrengthVsSectorPct: number | null;

  impliedVolatility: number | null;
  impliedVolatilityChange: number | null;
  ivState: IvState;

  delta: number | null;
  gamma: number | null;

  catalystType: string | null;
  catalystSource: string | null;
  catalystState: CatalystState;

  marketAlignment: Alignment;
  sectorAlignment: Alignment;
  compressionState: CompressionState;
  liquidityState: LiquidityState;
  spreadQuality: SpreadQuality;

  blockers: string[];
  /** Field name → why it is null. The audit trail for every absence. */
  missing: Record<string, MissingReason>;
  /** True only when identity, session, OCC, and an executable quote all hold. */
  evidenceComplete: boolean;
}

const OCC_RE = /^(?:O:)?([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/**
 * Strict OCC identity check. Deliberately separate from the broker display
 * parser: this one REFUSES a symbol rather than returning nulls, and it also
 * verifies the symbol agrees with the separately supplied contract terms.
 */
export interface OccIdentity {
  ok: boolean;
  occSymbol: string | null;
  underlying: string | null;
  expiration: string | null;
  strike: number | null;
  optionType: "call" | "put" | null;
}

export function verifyOccIdentity(input: {
  occSymbol?: string | null;
  symbol?: string | null;
  expiration?: string | null;
  strike?: number | null;
  optionType?: string | null;
}): OccIdentity {
  const refused: OccIdentity = { ok: false, occSymbol: null, underlying: null, expiration: null, strike: null, optionType: null };
  const raw = String(input.occSymbol ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const match = raw ? OCC_RE.exec(raw) : null;
  if (!match) return refused;

  const underlying = match[1];
  const year = 2000 + Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return refused;
  const expiration = `${year}-${match[3]}-${match[4]}`;
  const strike = Number(match[6]) / 1000;
  const optionType = match[5] === "C" ? "call" as const : "put" as const;
  if (!Number.isFinite(strike) || strike <= 0) return refused;

  // Cross-checks: a supplied term that DISAGREES refuses the identity outright.
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (symbol && symbol !== underlying) return refused;
  const suppliedExpiration = String(input.expiration ?? "").trim();
  if (suppliedExpiration && suppliedExpiration !== expiration) return refused;
  if (input.strike != null && Number.isFinite(input.strike) && Math.abs(Number(input.strike) - strike) > 1e-6) return refused;
  const suppliedType = String(input.optionType ?? "").trim().toLowerCase();
  if (suppliedType && suppliedType !== optionType) return refused;

  return { ok: true, occSymbol: raw.startsWith("O:") ? raw.slice(2) : raw, underlying, expiration, strike, optionType };
}

/**
 * Validates one option quote as executable AS OF `referenceAtMs`.
 * Rejects invalid, undated, future, stale, after-hours, wrong-session, and
 * wrong-OCC quotes. There is no "close enough" branch.
 */
export function validateExecutableQuote(input: {
  occSymbol?: string | null;
  expectedOccSymbol?: string | null;
  atMs: number;
  bid: number | null | undefined;
  ask: number | null | undefined;
  quoteTimestampMs: number | null | undefined;
  referenceAtMs: number;
  maxQuoteAgeMs: number;
  env?: NodeJS.ProcessEnv;
}): ExecutableQuote {
  const base = {
    atMs: input.atMs,
    bid: null, ask: null, midpoint: null, spread: null, spreadPct: null,
    quoteTimestampMs: null, quoteAgeMs: null,
  };
  const refuse = (reason: QuoteRejection, freshness: QuoteFreshness = "UNKNOWN"): ExecutableQuote =>
    ({ ...base, valid: false, reason, freshness });

  if (input.expectedOccSymbol != null) {
    const seen = String(input.occSymbol ?? "").trim().toUpperCase();
    const want = String(input.expectedOccSymbol).trim().toUpperCase();
    if (!seen || seen !== want) return refuse("QUOTE_WRONG_OCC");
  }

  const bid = input.bid, ask = input.ask;
  if (bid == null || !Number.isFinite(bid) || bid <= 0
    || ask == null || !Number.isFinite(ask) || ask <= 0 || ask < bid) {
    return refuse("INVALID_QUOTE");
  }

  const ts = input.quoteTimestampMs;
  if (ts == null || !Number.isFinite(ts)) return refuse("QUOTE_TIMESTAMP_UNAVAILABLE");
  if (!Number.isFinite(input.atMs) || !Number.isFinite(input.referenceAtMs)) return refuse("QUOTE_TIMESTAMP_UNAVAILABLE");
  if (ts > input.atMs || input.atMs > input.referenceAtMs) return refuse("QUOTE_TIMESTAMP_IN_FUTURE");
  if (!isOptionsQuoteSession(ts, input.env)) return refuse("QUOTE_OUTSIDE_OPTIONS_SESSION");
  if (tradingDay(ts) !== tradingDay(input.referenceAtMs)) return refuse("QUOTE_FROM_DIFFERENT_SESSION");

  const quoteAgeMs = input.atMs - ts;
  if (!Number.isFinite(quoteAgeMs) || quoteAgeMs < 0) return refuse("QUOTE_TIMESTAMP_IN_FUTURE");
  if (quoteAgeMs > input.maxQuoteAgeMs) {
    return { ...base, valid: false, reason: "QUOTE_STALE", quoteTimestampMs: ts, quoteAgeMs, freshness: "STALE" };
  }

  const midpoint = round((bid + ask) / 2, 6);
  const spread = round(ask - bid, 6);
  return {
    valid: true, reason: null, atMs: input.atMs,
    bid, ask, midpoint, spread,
    spreadPct: midpoint > 0 ? round((spread / midpoint) * 100, 4) : null,
    quoteTimestampMs: ts, quoteAgeMs, freshness: "FRESH",
  };
}

export function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

const ET_HM = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
});

/** ET minutes past midnight for a timestamp, or null when unusable. */
export function etMinutes(atMs: number): number | null {
  if (!Number.isFinite(atMs)) return null;
  const parts = ET_HM.formatToParts(new Date(atMs));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour % 24) * 60 + minute;
}

/** Fixed ET boundaries — a labelling convention, not a tuned threshold. */
export function timeOfDayBucket(atMs: number): TimeOfDayBucket | null {
  const minutes = etMinutes(atMs);
  if (minutes == null) return null;
  if (minutes < 9 * 60 + 30) return "PREMARKET";
  if (minutes < 10 * 60) return "OPEN_30";
  if (minutes < 11 * 60) return "MORNING";
  if (minutes < 14 * 60) return "MIDDAY";
  if (minutes < 15 * 60) return "AFTERNOON";
  if (minutes < 16 * 60) return "POWER_HOUR";
  return "AFTERHOURS";
}

function sessionPhaseFor(atMs: number): SessionPhase {
  if (!Number.isFinite(atMs)) return "CLOSED";
  const session = marketSession(atMs);
  if (session === "premarket") return "PREMARKET";
  if (session === "regular") return "REGULAR";
  if (session === "afterhours") return "AFTERHOURS";
  return "CLOSED";
}

/**
 * Normalizes raw input into trustworthy evidence.
 *
 * `referenceAtMs` defaults to the detection timestamp: evidence stamped after
 * detection is future evidence and is refused, so a candidate can never be
 * built out of facts that did not exist when it was detected.
 */
export function normalizeAsymmetryEvidence(
  raw: RawAsymmetryEvidence,
  opts: { maxQuoteAgeMs?: number; referenceAtMs?: number; env?: NodeJS.ProcessEnv } = {},
): AsymmetryEvidence {
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;
  const detectionAtMs = Number(raw.detectionAtMs);
  const referenceAtMs = opts.referenceAtMs ?? detectionAtMs;
  const missing: Record<string, MissingReason> = {};

  /** Accept a finite number, or record exactly why it is absent. */
  const num = (
    field: string,
    value: number | null | undefined,
    opt: { min?: number; max?: number; requires?: [string, unknown] } = {},
  ): number | null => {
    if (opt.requires) {
      const [, present] = opt.requires;
      const ok = typeof present === "string" ? present.trim().length > 0 : present != null;
      if (!ok) {
        missing[field] = opt.requires[0] === "baseline" ? "NO_BASELINE" : "NO_NAMED_SOURCE";
        return null;
      }
    }
    if (value == null) { missing[field] = "NOT_PROVIDED"; return null; }
    if (!Number.isFinite(value)) { missing[field] = "NOT_FINITE"; return null; }
    if ((opt.min != null && value < opt.min) || (opt.max != null && value > opt.max)) {
      missing[field] = "OUT_OF_RANGE";
      return null;
    }
    return value;
  };

  const sessionUsable = Number.isFinite(detectionAtMs);
  const sessionDate = sessionUsable ? tradingDay(detectionAtMs) : null;
  if (!sessionUsable) missing.detectionAtMs = "NOT_FINITE";

  const identity = verifyOccIdentity({
    occSymbol: raw.occSymbol, symbol: raw.symbol,
    expiration: raw.expiration, strike: raw.strike, optionType: raw.optionType,
  });
  if (!identity.ok) missing.occSymbol = raw.occSymbol == null ? "NOT_PROVIDED" : "OCC_UNVERIFIED";

  const quote = sessionUsable && identity.ok
    ? validateExecutableQuote({
        occSymbol: identity.occSymbol, expectedOccSymbol: identity.occSymbol,
        atMs: detectionAtMs, bid: raw.bid, ask: raw.ask,
        quoteTimestampMs: raw.quoteTimestampMs, referenceAtMs, maxQuoteAgeMs, env: opts.env,
      })
    : null;
  if (!quote?.valid) {
    for (const field of ["bid", "ask", "midpoint", "spread", "spreadPct"]) {
      missing[field] = quote?.reason === "QUOTE_TIMESTAMP_IN_FUTURE" ? "EVIDENCE_FROM_FUTURE"
        : identity.ok ? "QUOTE_INVALID" : "OCC_UNVERIFIED";
    }
  }

  const optionVolume = num("optionVolume", raw.optionVolume, { min: 0 });
  const openInterest = num("openInterest", raw.openInterest, { min: 0 });
  // A ratio needs a positive denominator. OI of 0 is a real observation, but it
  // makes the ratio undefined — it must not become 0 or Infinity.
  let volumeOpenInterestRatio: number | null = null;
  if (optionVolume != null && openInterest != null && openInterest > 0) {
    volumeOpenInterestRatio = round(optionVolume / openInterest, 4);
  } else {
    missing.volumeOpenInterestRatio = optionVolume == null || openInterest == null ? "NOT_PROVIDED" : "OUT_OF_RANGE";
  }

  const catalystType = String(raw.catalystType ?? "").trim();
  const catalystSource = String(raw.catalystSource ?? "").trim();
  let catalystState: CatalystState = "ABSENT_OR_UNKNOWN";
  if (catalystType && catalystSource) catalystState = "CONFIRMED";
  else if (catalystType && !catalystSource) {
    // A named catalyst with no source is worse than no catalyst: it is a claim
    // we cannot stand behind. It is dropped, and the drop is recorded.
    catalystState = "REJECTED_UNSOURCED";
    missing.catalystType = "NO_NAMED_SOURCE";
  } else missing.catalystType = "NOT_PROVIDED";

  const accelerationWindow = num("volumeAccelerationWindowMs", raw.volumeAccelerationWindowMs, { min: 1 });
  const volumeAcceleration = accelerationWindow == null
    ? (missing.volumeAcceleration = "NO_BASELINE", null)
    : num("volumeAcceleration", raw.volumeAcceleration);

  const direction = String(raw.direction ?? "").trim().toLowerCase();
  const normalizedDirection = direction === "bullish" || direction === "call" ? "bullish" as const
    : direction === "bearish" || direction === "put" ? "bearish" as const
    : (missing.direction = "NOT_PROVIDED", null);

  const spreadPct = quote?.valid ? quote.spreadPct : null;
  const spreadQuality: SpreadQuality = spreadPct == null ? "UNKNOWN"
    : spreadPct <= 5 ? "TIGHT" : spreadPct <= 15 ? "ACCEPTABLE" : "WIDE";
  // Liquidity is a statement about executability, not about attractiveness.
  const liquidityState: LiquidityState = !quote?.valid ? "UNKNOWN"
    : (openInterest != null && openInterest <= 0) || (optionVolume != null && optionVolume <= 0) ? "ILLIQUID"
    : spreadQuality === "WIDE" ? "THIN"
    : spreadQuality === "UNKNOWN" ? "UNKNOWN"
    : "EXECUTABLE";

  const evidence: AsymmetryEvidence = {
    candidateId: String(raw.candidateId),
    symbol: String(raw.symbol ?? "").trim().toUpperCase(),
    direction: normalizedDirection,
    detectionAtMs,
    sessionDate,
    sessionPhase: sessionPhaseFor(detectionAtMs),
    timeOfDay: sessionUsable ? timeOfDayBucket(detectionAtMs) : null,
    setupFamily: raw.setupFamily == null || String(raw.setupFamily).trim() === ""
      ? (missing.setupFamily = "NOT_PROVIDED", null)
      : String(raw.setupFamily),
    underlyingPrice: num("underlyingPrice", raw.underlyingPrice, { min: 0 }),

    occSymbol: identity.occSymbol,
    expiration: identity.expiration,
    strike: identity.strike,
    optionType: identity.optionType,
    dte: num("dte", raw.dte, { min: 0 }),

    bid: quote?.valid ? quote.bid : null,
    ask: quote?.valid ? quote.ask : null,
    midpoint: quote?.valid ? quote.midpoint : null,
    spread: quote?.valid ? quote.spread : null,
    spreadPct,
    quoteTimestampMs: quote?.valid ? quote.quoteTimestampMs : null,
    quoteAgeMs: quote?.valid ? quote.quoteAgeMs : null,
    quoteFreshness: quote?.valid ? "FRESH" : quote?.reason === "QUOTE_STALE" ? "STALE" : "UNKNOWN",
    quoteRejection: quote?.valid ? null : quote?.reason ?? null,

    optionVolume,
    openInterest,
    volumeOpenInterestRatio,
    stockVolume: num("stockVolume", raw.stockVolume, { min: 0 }),
    relativeStockVolume: num("relativeStockVolume", raw.relativeStockVolume, {
      min: 0, requires: ["baseline", raw.relativeVolumeBaselineSource],
    }),
    volumeAcceleration,
    volumeAccelerationWindowMs: accelerationWindow,

    underlyingMovePctBeforeDetection: raw.underlyingMoveWindowMs == null
      ? (missing.underlyingMovePctBeforeDetection = "NO_BASELINE", null)
      : num("underlyingMovePctBeforeDetection", raw.underlyingMovePctBeforeDetection),
    distanceToLevelPct: num("distanceToLevelPct", raw.distanceToLevelPct, { requires: ["source", raw.levelSource] }),
    roomToNextLevelPct: num("roomToNextLevelPct", raw.roomToNextLevelPct, { requires: ["source", raw.levelSource] }),

    relativeStrengthVsSpyPct: num("relativeStrengthVsSpyPct", raw.relativeStrengthVsSpyPct, { requires: ["source", raw.relativeStrengthSource] }),
    relativeStrengthVsQqqPct: num("relativeStrengthVsQqqPct", raw.relativeStrengthVsQqqPct, { requires: ["source", raw.relativeStrengthSource] }),
    relativeStrengthVsSectorPct: num("relativeStrengthVsSectorPct", raw.relativeStrengthVsSectorPct, { requires: ["source", raw.relativeStrengthSource] }),

    impliedVolatility: num("impliedVolatility", raw.impliedVolatility, { min: 0, requires: ["source", raw.ivSource] }),
    impliedVolatilityChange: num("impliedVolatilityChange", raw.impliedVolatilityChange, { requires: ["source", raw.ivSource] }),
    ivState: raw.ivState ?? "UNKNOWN",

    delta: num("delta", raw.delta, { min: -1, max: 1, requires: ["source", raw.greeksSource] }),
    gamma: num("gamma", raw.gamma, { requires: ["source", raw.greeksSource] }),

    catalystType: catalystState === "CONFIRMED" ? catalystType : null,
    catalystSource: catalystState === "CONFIRMED" ? catalystSource : null,
    catalystState,

    marketAlignment: raw.marketAlignment ?? "UNKNOWN",
    sectorAlignment: raw.sectorAlignment ?? "UNKNOWN",
    compressionState: raw.compressionState ?? "UNKNOWN",
    liquidityState,
    spreadQuality,

    blockers: Array.isArray(raw.blockers) ? raw.blockers.filter((b) => String(b ?? "").trim().length > 0).map(String) : [],
    missing,
    evidenceComplete: false,
  };

  evidence.evidenceComplete = Boolean(
    sessionUsable && identity.ok && quote?.valid
    && evidence.symbol.length > 0
    && evidence.direction != null
    && evidence.setupFamily != null
    && isOptionsQuoteSession(detectionAtMs, opts.env),
  );
  return evidence;
}

/** Numeric feature names compared across cohorts. Single source of truth. */
export const ASYMMETRY_NUMERIC_FEATURES = [
  "relativeStockVolume",
  "volumeAcceleration",
  "volumeOpenInterestRatio",
  "optionVolume",
  "openInterest",
  "spreadPct",
  "distanceToLevelPct",
  "roomToNextLevelPct",
  "dte",
  "moneynessPct",
  "impliedVolatility",
  "impliedVolatilityChange",
  "underlyingMovePctBeforeDetection",
  "premiumChasePct",
] as const;
export type AsymmetryNumericFeature = typeof ASYMMETRY_NUMERIC_FEATURES[number];

/** Categorical feature names compared across cohorts. */
export const ASYMMETRY_CATEGORICAL_FEATURES = [
  "setupFamily",
  "timeOfDay",
  "sessionPhase",
  "catalystState",
  "marketAlignment",
  "sectorAlignment",
  "compressionState",
  "liquidityState",
  "spreadQuality",
  "ivState",
  "premiumChaseBucket",
] as const;
export type AsymmetryCategoricalFeature = typeof ASYMMETRY_CATEGORICAL_FEATURES[number];

/**
 * Strike distance from spot as a percentage. Null unless BOTH sides are known —
 * a missing underlying price never becomes "at the money".
 */
export function moneynessPct(evidence: AsymmetryEvidence): number | null {
  if (evidence.strike == null || evidence.underlyingPrice == null || evidence.underlyingPrice <= 0) return null;
  return round(((evidence.strike - evidence.underlyingPrice) / evidence.underlyingPrice) * 100, 4);
}
