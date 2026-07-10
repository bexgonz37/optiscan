/**
 * timestamps.ts — THE central timestamp normalizer (stabilization 2026-07-10).
 *
 * Root cause fixed: Polygon/Massive returns trade timestamps in NANOSECONDS
 * (lastTrade.t, sip_timestamp), minute bars in MILLISECONDS, and some fields
 * in seconds or microseconds. Raw values were assigned into `*Ms` fields
 * (scanner-loop → move-timing), so nanosecond values did date math as
 * milliseconds → year ~56,000 → `Invalid time value` thrown by toISOString()
 * → valid quotes classified NO_DATA and actionable entries wrongly blocked.
 *
 * Every timestamp entering the app goes through normalizeTimestamp():
 *   input → unit detection (magnitude/digit-count) → ms → plausibility check
 * It NEVER throws. toISOString() is only called after validation.
 */

export type TimestampUnit =
  | "seconds" | "milliseconds" | "microseconds" | "nanoseconds"
  | "date" | "iso" | "unknown";

export interface NormalizedTimestamp {
  milliseconds: number | null;
  iso: string | null;
  valid: boolean;
  sourceUnit: TimestampUnit;
  reason?: string;
}

/** Plausibility window: configurable, defensible defaults. */
export const TS_MIN_MS = Number(process.env.TS_MIN_MS ?? Date.parse("2000-01-01T00:00:00Z"));
export const TS_MAX_FUTURE_SKEW_MS = Number(process.env.TS_MAX_FUTURE_SKEW_MS ?? 5 * 60_000);

const invalid = (sourceUnit: TimestampUnit, reason: string): NormalizedTimestamp =>
  ({ milliseconds: null, iso: null, valid: false, sourceUnit, reason });

function finish(ms: number, sourceUnit: TimestampUnit, nowMs: number): NormalizedTimestamp {
  if (!Number.isFinite(ms)) return invalid(sourceUnit, "not finite after conversion");
  const rounded = Math.round(ms);
  if (rounded <= 0) return invalid(sourceUnit, "zero or negative");
  if (rounded < TS_MIN_MS) return invalid(sourceUnit, `before minimum plausible date (${new Date(TS_MIN_MS).getUTCFullYear()})`);
  if (rounded > nowMs + TS_MAX_FUTURE_SKEW_MS) return invalid(sourceUnit, "too far in the future");
  // Only NOW is toISOString safe — the value is a validated, plausible ms epoch.
  return { milliseconds: rounded, iso: new Date(rounded).toISOString(), valid: true, sourceUnit };
}

/** Digit-count → unit. Magnitude-aware, not one brittle threshold. */
function unitForDigits(digits: number): { unit: TimestampUnit; divisorN: bigint; multiplierN: bigint } {
  if (digits <= 10) return { unit: "seconds", divisorN: 1n, multiplierN: 1000n };
  if (digits <= 13) return { unit: "milliseconds", divisorN: 1n, multiplierN: 1n };
  if (digits <= 16) return { unit: "microseconds", divisorN: 1000n, multiplierN: 1n };
  return { unit: "nanoseconds", divisorN: 1_000_000n, multiplierN: 1n };
}

function fromBigInt(raw: bigint, nowMs: number): NormalizedTimestamp {
  if (raw <= 0n) return invalid("unknown", "zero or negative");
  const digits = raw.toString().length;
  const { unit, divisorN, multiplierN } = unitForDigits(digits);
  // Scale IN BIGINT first — converting a raw nanosecond bigint to Number
  // before scaling loses precision / can exceed MAX_SAFE_INTEGER.
  const scaled = (raw * multiplierN) / divisorN;
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return invalid(unit, "exceeds safe integer after scaling");
  return finish(Number(scaled), unit, nowMs);
}

function fromNumber(n: number, nowMs: number): NormalizedTimestamp {
  if (!Number.isFinite(n)) return invalid("unknown", Number.isNaN(n) ? "NaN" : "Infinity");
  if (n <= 0) return invalid("unknown", "zero or negative");
  // Unit detection uses the INTEGER part's digit count, so fractional-seconds
  // floats (1720627200.123) classify as seconds, not sub-millisecond noise.
  const whole = Math.trunc(Math.abs(n));
  const digits = String(whole).length;
  const { unit } = unitForDigits(digits);
  const ms = unit === "seconds" ? n * 1000
    : unit === "milliseconds" ? n
    : unit === "microseconds" ? n / 1000
    : n / 1_000_000;
  return finish(ms, unit, nowMs);
}

export function normalizeTimestamp(
  input: number | string | bigint | Date | null | undefined,
  nowMs: number = Date.now(),
): NormalizedTimestamp {
  if (input == null) return invalid("unknown", "missing");
  if (input instanceof Date) {
    const t = input.getTime();
    if (!Number.isFinite(t)) return invalid("date", "invalid Date object");
    return finish(t, "date", nowMs);
  }
  if (typeof input === "bigint") return fromBigInt(input, nowMs);
  if (typeof input === "number") return fromNumber(input, nowMs);
  const text = String(input).trim();
  if (!text) return invalid("unknown", "empty string");
  if (/^[+-]?\d+$/.test(text)) {
    try { return fromBigInt(BigInt(text), nowMs); } catch { return invalid("unknown", "unparseable integer string"); }
  }
  if (/^[+-]?\d*\.\d+$/.test(text)) return fromNumber(Number(text), nowMs);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return invalid("iso", "unparseable date string");
  return finish(parsed, "iso", nowMs);
}

/** Convenience: normalized epoch ms or null. Never throws. */
export function toMs(
  input: number | string | bigint | Date | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  return normalizeTimestamp(input, nowMs).milliseconds;
}

/** Convenience: validated ISO string or null. Never throws. */
export function toIso(
  input: number | string | bigint | Date | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  return normalizeTimestamp(input, nowMs).iso;
}
