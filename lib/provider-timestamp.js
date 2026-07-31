/**
 * provider-timestamp.js — ONE deterministic normalization for provider clocks.
 *
 * PROVEN, NOT ASSUMED. Production capture telemetry recorded raw Polygon option
 * quote timestamps beside the millisecond clock they were compared against:
 *
 *   COIN  raw 1785510912137034800  now 1785510921734  ratio 999999.995
 *   CRWV  raw 1785510913640033500  now 1785510921784  ratio 999999.995
 *
 * 19 digits against 13, a ratio of exactly 1e6: NANOSECONDS. Every freshness
 * check compared that to Date.now() in milliseconds, so `now - ts` was hugely
 * NEGATIVE and the quote read as far in the future. High-Asymmetry refused
 * 1167/1167 candidates as EVIDENCE_FROM_FUTURE — correctly, on bad input.
 *
 * SAFE BY CONSTRUCTION: a value already in milliseconds passes through
 * unchanged, so applying this at a boundary that was already correct is a
 * no-op. That is why it can be applied broadly without auditing every caller.
 *
 * NEVER GUESSES. The four supported units are three orders of magnitude apart,
 * so they are distinguishable without ambiguity. Anything outside those bands
 * is REJECTED as UNKNOWN rather than coerced, and the caller receives null —
 * never a fabricated "now", which would turn missing data into fake freshness.
 *
 * It does not widen any freshness threshold and does not make a genuinely
 * future quote acceptable; it only ensures both sides of the comparison are in
 * the same unit.
 */

/**
 * Plausible epoch bands, in each unit, for any realistic market timestamp.
 * Lower bound ~2001 and upper bound ~2065 in each unit; the bands cannot
 * overlap because consecutive units differ by 1000x.
 */
const BANDS = [
  { unit: "s", min: 1e9, max: 3e9, toMs: (v) => v * 1000 },
  { unit: "ms", min: 1e12, max: 3e12, toMs: (v) => v },
  { unit: "us", min: 1e15, max: 3e15, toMs: (v) => v / 1000 },
  { unit: "ns", min: 1e18, max: 3e18, toMs: (v) => v / 1e6 },
];

/**
 * Normalize one provider timestamp to milliseconds.
 *
 * @param {unknown} raw
 * @returns {{ ms: number|null, unit: string, rejected: string|null, raw: number|null }}
 */
export function normalizeProviderTimestamp(raw) {
  const v = typeof raw === "number" ? raw : Number(raw);
  if (raw == null || raw === "") return { ms: null, unit: "ABSENT", rejected: "ABSENT", raw: null };
  if (!Number.isFinite(v)) return { ms: null, unit: "UNKNOWN", rejected: "NOT_FINITE", raw: null };
  if (v <= 0) return { ms: null, unit: "UNKNOWN", rejected: "NON_POSITIVE", raw: v };

  for (const band of BANDS) {
    if (v >= band.min && v < band.max) {
      return { ms: Math.round(band.toMs(v)), unit: band.unit, rejected: null, raw: v };
    }
  }
  // Between bands, or absurdly large/small. Refusing is the honest answer: a
  // value we cannot attribute to a unit must not become a confident timestamp.
  return { ms: null, unit: "UNKNOWN", rejected: "IMPLAUSIBLE_MAGNITUDE", raw: v };
}

/** Convenience: milliseconds or null. Never throws, never fabricates. */
export function providerTimestampMs(raw) {
  return normalizeProviderTimestamp(raw).ms;
}

/** The detected unit, for diagnostics. */
export function providerTimestampUnit(raw) {
  return normalizeProviderTimestamp(raw).unit;
}
