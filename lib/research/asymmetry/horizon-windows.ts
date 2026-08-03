/**
 * horizon-windows.ts — deterministic acceptance windows per mark horizon, and
 * the independence rule they enforce. PURE: no DB, no network, no AI.
 *
 * WHY WINDOWS EXIST AT ALL. `dueHorizons` returns EVERY elapsed, unmarked
 * horizon at once. When a position has been open an hour, one sweep sees 1, 3,
 * 5, 10, 15, 30 and 60 all "due", fetches one quote, and writes it to all seven.
 * Seven rows appear, the series looks complete, and it is a single observation
 * repeated — which is exactly how 84.1% of series became degenerate.
 *
 * A window makes that impossible: a quote observed at t+62min belongs to the
 * 60m horizon and to nothing else. It may still be CARRIED FORWARD into the
 * other rows for continuity, but it can never be counted as independent
 * evidence for them.
 *
 * WINDOWS DO NOT OVERLAP. Each horizon's acceptance band is bounded by the
 * midpoints to its neighbours, so no timestamp can independently satisfy two
 * horizons. That property is asserted by test rather than assumed.
 */

export const HORIZON_WINDOW_VERSION = "HORIZON_WINDOW_V1" as const;

export const HORIZONS_MINUTES = [1, 3, 5, 10, 15, 30, 60] as const;
export type HorizonMinutes = (typeof HORIZONS_MINUTES)[number];

export type HorizonMatchStatus =
  | "ON_TIME"
  | "ACCEPTABLE_EARLY"
  | "ACCEPTABLE_LATE"
  | "TOO_EARLY"
  | "TOO_LATE"
  | "MISSED"
  | "REUSED_NOT_INDEPENDENT";

export interface HorizonWindow {
  horizonMinutes: number;
  targetAtMs: number;
  acceptableFromMs: number;
  acceptableUntilMs: number;
  /** Maximum provider-quote age inside the window. */
  maxQuoteAgeMs: number;
  /** After this, the horizon is MISSED and never independently satisfiable. */
  missedAfterMs: number;
  version: string;
}

/**
 * Half-way to the neighbouring horizon, capped. Using the midpoint guarantees
 * adjacent windows touch but never overlap, so the non-overlap property holds
 * for any horizon list without hand-tuned constants.
 */
function boundsFor(horizon: number, index: number, all: readonly number[]): { back: number; fwd: number } {
  const prev = index > 0 ? all[index - 1] : 0;
  const next = index < all.length - 1 ? all[index + 1] : horizon * 2;
  const backMin = (horizon - prev) / 2;
  const fwdMin = (next - horizon) / 2;
  return { back: backMin * 60_000, fwd: fwdMin * 60_000 };
}

/**
 * Build the window for one horizon, anchored on when the position was opened.
 *
 * `maxQuoteAgeMs` scales with the horizon: a 1-minute mark must be seconds
 * fresh to mean anything, while a 60-minute mark tolerates more. It is capped
 * so a long horizon never accepts an arbitrarily stale quote.
 */
export function horizonWindow(firstDetectedAtMs: number, horizonMinutes: number): HorizonWindow {
  const idx = (HORIZONS_MINUTES as readonly number[]).indexOf(horizonMinutes);
  const all = HORIZONS_MINUTES as readonly number[];
  const { back, fwd } = idx >= 0
    ? boundsFor(horizonMinutes, idx, all)
    : { back: horizonMinutes * 30_000, fwd: horizonMinutes * 30_000 };

  const targetAtMs = firstDetectedAtMs + horizonMinutes * 60_000;
  return {
    horizonMinutes,
    targetAtMs,
    acceptableFromMs: targetAtMs - back,
    acceptableUntilMs: targetAtMs + fwd,
    maxQuoteAgeMs: Math.min(120_000, Math.max(30_000, horizonMinutes * 6_000)),
    // A horizon stays claimable for one further window before it is MISSED,
    // so a single budget-blocked sweep does not destroy it.
    missedAfterMs: targetAtMs + fwd * 2,
    version: HORIZON_WINDOW_VERSION,
  };
}

/** Every window for a position, in horizon order. */
export function allHorizonWindows(firstDetectedAtMs: number): HorizonWindow[] {
  return (HORIZONS_MINUTES as readonly number[]).map((h) => horizonWindow(firstDetectedAtMs, h));
}

/**
 * Where an observation falls relative to a horizon's window.
 *
 * The judgement uses the PROVIDER timestamp, not the write time: a quote is
 * evidence about the instant the market produced it, not the instant we
 * happened to persist it.
 */
export function classifyHorizonMatch(
  window: HorizonWindow,
  providerAtMs: number | null,
  observedAtMs: number | null,
): { status: HorizonMatchStatus; deltaFromTargetMs: number | null; quoteAgeMs: number | null } {
  if (providerAtMs == null) return { status: "MISSED", deltaFromTargetMs: null, quoteAgeMs: null };
  const delta = providerAtMs - window.targetAtMs;
  const quoteAgeMs = observedAtMs != null ? observedAtMs - providerAtMs : null;

  if (providerAtMs > window.missedAfterMs) return { status: "MISSED", deltaFromTargetMs: delta, quoteAgeMs };
  if (providerAtMs > window.acceptableUntilMs) return { status: "TOO_LATE", deltaFromTargetMs: delta, quoteAgeMs };
  if (providerAtMs < window.acceptableFromMs) return { status: "TOO_EARLY", deltaFromTargetMs: delta, quoteAgeMs };
  if (quoteAgeMs != null && quoteAgeMs > window.maxQuoteAgeMs) {
    // Inside the window but built on a quote too old to describe it.
    return { status: "TOO_LATE", deltaFromTargetMs: delta, quoteAgeMs };
  }
  // Within a tenth of the spacing counts as on time; otherwise early/late but
  // still acceptable, and still independent evidence for THIS horizon.
  const onTimeBand = Math.max(5_000, (window.acceptableUntilMs - window.acceptableFromMs) / 10);
  if (Math.abs(delta) <= onTimeBand) return { status: "ON_TIME", deltaFromTargetMs: delta, quoteAgeMs };
  return { status: delta < 0 ? "ACCEPTABLE_EARLY" : "ACCEPTABLE_LATE", deltaFromTargetMs: delta, quoteAgeMs };
}

/** Horizon statuses that represent a genuine observation of that horizon. */
export const INDEPENDENT_MATCH_STATUSES: readonly HorizonMatchStatus[] =
  Object.freeze(["ON_TIME", "ACCEPTABLE_EARLY", "ACCEPTABLE_LATE"]);

export function isIndependentMatch(status: HorizonMatchStatus): boolean {
  return (INDEPENDENT_MATCH_STATUSES as readonly string[]).includes(status);
}

/**
 * THE INDEPENDENCE RULE.
 *
 * A mark counts as independent evidence for a horizon only when all hold:
 *   1. the provider timestamp falls inside that horizon's window,
 *   2. the quote is fresh enough for that horizon,
 *   3. the same provider timestamp has not already been used for another
 *      horizon on this position.
 *
 * Rule 3 is why `usedProviderTimestamps` is threaded through: identical PRICES
 * on separate observations are fine — a quiet contract legitimately repeats a
 * price — but an identical provider TIMESTAMP is the same observation counted
 * twice, and no amount of price movement makes it two.
 */
export interface IndependenceInput {
  window: HorizonWindow;
  providerAtMs: number | null;
  observedAtMs: number | null;
  /** Provider timestamps already consumed by other horizons on this position. */
  usedProviderTimestamps: ReadonlySet<number>;
}

export interface IndependenceResult {
  independent: boolean;
  horizonMatch: HorizonMatchStatus;
  deltaFromTargetMs: number | null;
  quoteAgeMs: number | null;
  /** Set when this exact provider observation already served another horizon. */
  reusedFromHorizon: number | null;
  reason: string;
}

export function evaluateIndependence(
  input: IndependenceInput,
  usedByHorizon: ReadonlyMap<number, number> = new Map(),
): IndependenceResult {
  const m = classifyHorizonMatch(input.window, input.providerAtMs, input.observedAtMs);

  if (input.providerAtMs != null && input.usedProviderTimestamps.has(input.providerAtMs)) {
    let from: number | null = null;
    for (const [ts, h] of usedByHorizon) if (ts === input.providerAtMs) { from = h; break; }
    return {
      independent: false, horizonMatch: "REUSED_NOT_INDEPENDENT",
      deltaFromTargetMs: m.deltaFromTargetMs, quoteAgeMs: m.quoteAgeMs,
      reusedFromHorizon: from,
      reason: from != null
        ? `same provider observation already counted for the ${from}m horizon`
        : "same provider observation already counted for another horizon",
    };
  }
  const independent = isIndependentMatch(m.status);
  return {
    independent, horizonMatch: m.status,
    deltaFromTargetMs: m.deltaFromTargetMs, quoteAgeMs: m.quoteAgeMs,
    reusedFromHorizon: null,
    reason: independent
      ? `distinct observation inside the ${input.window.horizonMinutes}m window (${m.status})`
      : `observation is ${m.status} for the ${input.window.horizonMinutes}m window`,
  };
}

/**
 * Which horizons a sweep may CLAIM right now.
 *
 * This is the fix for one-quote-to-seven-horizons. `dueHorizons` returns every
 * elapsed unmarked horizon; this narrows that to the ones whose window actually
 * contains the current instant, so a sweep fetches a quote for a horizon that
 * quote can legitimately describe.
 */
export function claimableHorizons(
  firstDetectedAtMs: number, nowMs: number, alreadyMarked: readonly number[],
): number[] {
  const done = new Set(alreadyMarked);
  return (HORIZONS_MINUTES as readonly number[])
    .filter((h) => !done.has(h))
    .filter((h) => {
      const w = horizonWindow(firstDetectedAtMs, h);
      return nowMs >= w.acceptableFromMs && nowMs <= w.missedAfterMs;
    });
}

/** Horizons whose window has closed unclaimed. Permanently MISSED. */
export function missedHorizons(
  firstDetectedAtMs: number, nowMs: number, alreadyMarked: readonly number[],
): number[] {
  const done = new Set(alreadyMarked);
  return (HORIZONS_MINUTES as readonly number[])
    .filter((h) => !done.has(h))
    .filter((h) => nowMs > horizonWindow(firstDetectedAtMs, h).missedAfterMs);
}

export interface IndependenceSummary {
  attempted: number;
  independent: number;
  reused: number;
  outOfWindow: number;
  missed: number;
  independentRatePct: number | null;
  byHorizon: Record<string, { attempted: number; independent: number }>;
  meetsGate: boolean;
  note: string;
}

/** Gate B's target. Below this, horizon conclusions are not defensible. */
export const INDEPENDENT_RATE_GATE = 0.5;

export function summarizeIndependence(
  rows: ReadonlyArray<{ horizonMinutes: number; independent: boolean; horizonMatch: HorizonMatchStatus }>,
): IndependenceSummary {
  const byHorizon: Record<string, { attempted: number; independent: number }> = {};
  let independent = 0, reused = 0, outOfWindow = 0, missed = 0;
  for (const r of rows) {
    const k = `${r.horizonMinutes}m`;
    byHorizon[k] ??= { attempted: 0, independent: 0 };
    byHorizon[k].attempted += 1;
    if (r.independent) { independent += 1; byHorizon[k].independent += 1; }
    else if (r.horizonMatch === "REUSED_NOT_INDEPENDENT") reused += 1;
    else if (r.horizonMatch === "MISSED") missed += 1;
    else outOfWindow += 1;
  }
  const rate = rows.length ? independent / rows.length : null;
  return {
    attempted: rows.length, independent, reused, outOfWindow, missed,
    independentRatePct: rate == null ? null : Math.round(rate * 1000) / 10,
    byHorizon,
    meetsGate: rate != null && rate >= INDEPENDENT_RATE_GATE,
    note: rate == null
      ? "No marks attempted."
      : rate >= INDEPENDENT_RATE_GATE
        ? `Independent rate ${(rate * 100).toFixed(1)}% meets the ${INDEPENDENT_RATE_GATE * 100}% gate.`
        : `Independent rate ${(rate * 100).toFixed(1)}% is below the ${INDEPENDENT_RATE_GATE * 100}% gate — horizon conclusions are not defensible.`,
  };
}
