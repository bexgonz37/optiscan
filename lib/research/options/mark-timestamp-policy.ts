/**
 * mark-timestamp-policy.ts — ONE explicit, versioned policy for judging an
 * option mark's timestamp. PURE: no DB, no network, no AI.
 *
 * THE DEFECT THIS FIXES. Production rejected 636 of 995 marks as FUTURE_QUOTE
 * — 64% of all mark failures. The obvious readings were all wrong:
 *
 *   - normalization: `provider-timestamp.js` handles 19-digit nanoseconds
 *     correctly (1.785e18 falls in the ns band, /1e6 gives the right ms).
 *   - provider clock skew: measured live across NVDA/AAPL/SPY/TSLA/AMD, the
 *     provider timestamp is ALWAYS BEHIND local time (-0.9s, -2.8s, -599s,
 *     -2.2s, -1.4s). The provider is never ahead, so it cannot produce a
 *     genuinely future quote.
 *
 * The real cause is the CLOCK WE COMPARE AGAINST. `deps.nowMs` is captured once
 * when the scheduler beat starts and reused for every case in the sweep. With
 * ~171 open cases at roughly 200ms per provider call, the sweep runs for tens
 * of seconds. A quote fetched 40 seconds into the sweep is legitimately NEWER
 * than the sweep-start clock, so `quoteAt > nowMs` fires and a perfectly good
 * mark is thrown away as "from the future".
 *
 * THE FIX DOES NOT WEAKEN THE GUARD. It compares against the instant the quote
 * was actually observed instead of a stale one. A genuinely future timestamp is
 * still rejected — proven by test. No tolerance is required to fix this defect,
 * so the default tolerance is ZERO; a bounded one exists only because the
 * policy must be configurable, and it is never applied to other timestamp
 * sources.
 */

export const TIMESTAMP_POLICY_VERSION = "MARK_TS_POLICY_V1" as const;

export type TimestampClass =
  | "TIMESTAMP_VALID"
  | "FUTURE_WITHIN_PROVIDER_TOLERANCE"
  | "FUTURE_BEYOND_TOLERANCE"
  | "AMBIGUOUS_UNIT"
  | "PRECISION_LOSS"
  | "INVALID_TIMESTAMP"
  | "SERVER_CLOCK_UNTRUSTED"
  | "PROVIDER_CLOCK_UNTRUSTED"
  | "WRONG_TIMESTAMP_FIELD"
  | "UNKNOWN_TIMESTAMP_DEFECT";

/**
 * Default forward tolerance: ZERO.
 *
 * Deliberate. The measured provider clock is always BEHIND, so no forward
 * allowance is needed to fix the observed defect, and adding one would mask a
 * real future-evidence bug later. It is configurable so a future, MEASURED
 * skew can be accommodated with evidence rather than by guesswork.
 */
export const DEFAULT_FUTURE_TOLERANCE_MS = 0;

/**
 * Beyond this, the observation clock itself is suspect rather than the quote.
 * A quote hours ahead of the observation time means something is wrong with a
 * clock, not with the contract.
 */
export const SERVER_CLOCK_UNTRUSTED_MS = 60 * 60_000;

/**
 * JavaScript loses integer precision above 2^53. A 19-digit nanosecond value
 * exceeds it, so the RAW value must be carried as a string when precision
 * matters; the millisecond result is unaffected because the lost digits are
 * sub-millisecond.
 */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export interface TimestampEvidence {
  /** The raw provider value, as received. String-safe for 19-digit inputs. */
  raw: string | number | null | undefined;
  /** Which provider field it came from. */
  sourceField: string | null;
  /** Normalized milliseconds, from provider-timestamp.js. */
  normalizedMs: number | null;
  /** Unit inferred by the normalizer. */
  inferredUnit: string | null;
  /**
   * The instant the quote was ACTUALLY OBSERVED — not the sweep-start clock.
   * Using the wrong one here is the entire defect this module exists for.
   */
  observedAtMs: number;
  /** The sweep clock, kept for diagnostics so the drift stays visible. */
  sweepStartedAtMs?: number | null;
}

export interface TimestampVerdict {
  timestampClass: TimestampClass;
  accepted: boolean;
  /** normalizedMs - observedAtMs. Positive means the quote is ahead. */
  skewMs: number | null;
  /** How stale the sweep clock was when this quote was observed. */
  sweepClockDriftMs: number | null;
  rawPreserved: string | null;
  sourceField: string | null;
  inferredUnit: string | null;
  precisionLossPossible: boolean;
  policyVersion: string;
  reason: string;
}

export interface TimestampPolicyConfig {
  futureToleranceMs: number;
  serverClockUntrustedMs: number;
}

export const DEFAULT_TIMESTAMP_POLICY: Readonly<TimestampPolicyConfig> = Object.freeze({
  futureToleranceMs: DEFAULT_FUTURE_TOLERANCE_MS,
  serverClockUntrustedMs: SERVER_CLOCK_UNTRUSTED_MS,
});

export function resolveTimestampPolicy(env: NodeJS.ProcessEnv = process.env): TimestampPolicyConfig {
  const n = (raw: string | undefined, d: number, lo: number, hi: number): number => {
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d;
  };
  return {
    // Capped at 5s: anything larger is not a clock artifact, it is a bug.
    futureToleranceMs: n(env.MARK_FUTURE_TOLERANCE_MS, DEFAULT_FUTURE_TOLERANCE_MS, 0, 5_000),
    serverClockUntrustedMs: n(env.MARK_CLOCK_UNTRUSTED_MS, SERVER_CLOCK_UNTRUSTED_MS, 60_000, 24 * 60 * 60_000),
  };
}

/**
 * Judge one mark timestamp. Total and deterministic.
 *
 * Precedence is worst-defect-first: an unusable value is reported as such
 * before any comparison is attempted, so a null never reaches the skew maths
 * and become a confident verdict.
 */
export function classifyMarkTimestamp(
  e: TimestampEvidence,
  cfg: TimestampPolicyConfig = DEFAULT_TIMESTAMP_POLICY,
): TimestampVerdict {
  const rawStr = e.raw == null ? null : String(e.raw);
  const precisionLossPossible = rawStr != null
    && /^\d+$/.test(rawStr)
    && rawStr.length >= 17
    && Number(rawStr) > MAX_SAFE;

  const base = {
    rawPreserved: rawStr,
    sourceField: e.sourceField ?? null,
    inferredUnit: e.inferredUnit ?? null,
    precisionLossPossible,
    policyVersion: TIMESTAMP_POLICY_VERSION,
    sweepClockDriftMs: e.sweepStartedAtMs != null ? e.observedAtMs - e.sweepStartedAtMs : null,
  };
  const no = (timestampClass: TimestampClass, reason: string, skewMs: number | null = null): TimestampVerdict =>
    ({ ...base, timestampClass, accepted: false, skewMs, reason });

  if (e.raw == null || rawStr === "") return no("INVALID_TIMESTAMP", "no timestamp on the quote");
  if (e.sourceField == null) return no("WRONG_TIMESTAMP_FIELD", "timestamp source field not recorded");
  if (e.normalizedMs == null) {
    return no(
      e.inferredUnit === "UNKNOWN" ? "AMBIGUOUS_UNIT" : "INVALID_TIMESTAMP",
      e.inferredUnit === "UNKNOWN"
        ? "magnitude does not fall in a supported unit band — refused rather than coerced"
        : "timestamp could not be normalized",
    );
  }
  if (!Number.isFinite(e.observedAtMs) || e.observedAtMs <= 0) {
    return no("SERVER_CLOCK_UNTRUSTED", "observation clock is not usable");
  }

  const skewMs = e.normalizedMs - e.observedAtMs;

  // Ahead of the observation clock.
  if (skewMs > 0) {
    if (skewMs > cfg.serverClockUntrustedMs) {
      return no("SERVER_CLOCK_UNTRUSTED",
        `quote is ${Math.round(skewMs / 1000)}s ahead of the observation clock — a clock is wrong, not the contract`, skewMs);
    }
    if (skewMs > cfg.futureToleranceMs) {
      return no("FUTURE_BEYOND_TOLERANCE",
        `quote is ${skewMs}ms ahead of when it was observed, past the ${cfg.futureToleranceMs}ms tolerance`, skewMs);
    }
    return {
      ...base, timestampClass: "FUTURE_WITHIN_PROVIDER_TOLERANCE", accepted: true, skewMs,
      reason: `quote is ${skewMs}ms ahead but within the measured, versioned tolerance`,
    };
  }

  return {
    ...base, timestampClass: "TIMESTAMP_VALID", accepted: true, skewMs,
    reason: precisionLossPossible
      ? `valid; raw exceeds MAX_SAFE_INTEGER so the raw string is preserved (lost digits are sub-millisecond)`
      : "valid: the quote precedes the instant it was observed",
  };
}

// ── skew diagnostics ───────────────────────────────────────────────────────

export interface SkewDistribution {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
  maxAccepted: number | null;
  maxRejected: number | null;
  bySourceField: Record<string, number>;
  byUnit: Record<string, number>;
  byClass: Record<string, number>;
  /** How stale the sweep clock got. The signature of THIS defect. */
  sweepDrift: { p50: number | null; p95: number | null; max: number | null };
}

/**
 * Aggregate verdicts into a distribution.
 *
 * `sweepDrift` is reported separately and deliberately: a large drift with
 * negative provider skew is the fingerprint of the stale-clock defect, and
 * distinguishes it from a genuine provider-clock problem, which would show
 * positive skew independent of drift.
 */
export function summarizeSkew(verdicts: readonly TimestampVerdict[]): SkewDistribution {
  const skews = verdicts.map((v) => v.skewMs).filter((v): v is number => v != null).sort((a, b) => a - b);
  const drifts = verdicts.map((v) => v.sweepClockDriftMs).filter((v): v is number => v != null).sort((a, b) => a - b);
  const q = (arr: number[], p: number): number | null => {
    if (!arr.length) return null;
    const i = Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)));
    return arr[i];
  };
  const bySourceField: Record<string, number> = {};
  const byUnit: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  let maxAccepted: number | null = null, maxRejected: number | null = null;
  for (const v of verdicts) {
    bySourceField[v.sourceField ?? "UNKNOWN"] = (bySourceField[v.sourceField ?? "UNKNOWN"] ?? 0) + 1;
    byUnit[v.inferredUnit ?? "UNKNOWN"] = (byUnit[v.inferredUnit ?? "UNKNOWN"] ?? 0) + 1;
    byClass[v.timestampClass] = (byClass[v.timestampClass] ?? 0) + 1;
    if (v.skewMs == null) continue;
    if (v.accepted) maxAccepted = maxAccepted == null ? v.skewMs : Math.max(maxAccepted, v.skewMs);
    else maxRejected = maxRejected == null ? v.skewMs : Math.max(maxRejected, v.skewMs);
  }
  return {
    n: verdicts.length,
    p50: q(skews, 0.5), p95: q(skews, 0.95), p99: q(skews, 0.99),
    min: skews.length ? skews[0] : null, max: skews.length ? skews[skews.length - 1] : null,
    maxAccepted, maxRejected, bySourceField, byUnit, byClass,
    sweepDrift: { p50: q(drifts, 0.5), p95: q(drifts, 0.95), max: drifts.length ? drifts[drifts.length - 1] : null },
  };
}
