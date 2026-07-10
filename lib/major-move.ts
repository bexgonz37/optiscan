/**
 * major-move.ts — large-cap grind detection (pure).
 *
 * ROOT CAUSE this fixes (the "META miss", diagnosed 2026-07-09): the trigger
 * engine measures velocity over ~10-SECOND windows (burst detection). A major
 * large-cap move — META grinding +3% over an hour — averages ~0.04%/min and
 * never clears the 0.15%/min burst gate in any 10s window, so every gate
 * correctly says "no burst" while an obvious institutional move develops.
 * Lowering the burst threshold would flood the scanner with noise; the fix is
 * a SEPARATE day-timeframe detector with market-cap/liquidity-aware bars.
 *
 * This is DETECTION, not entry: it makes the move visible ("MOVE DETECTED" /
 * "EXTENDED — DO NOT CHASE") on the dashboard and in diagnostics. It sends no
 * BUY, changes no burst gates, and never fires Discord directives.
 */

export interface MajorMoveInput {
  symbol: string;
  price: number | null;
  movePct: number | null;      // day move %
  volume: number | null;       // cumulative day volume (shares)
  relVol: number | null;       // vs symbol's own baseline (null = unknown)
  aboveVwap: boolean | null;
  core: boolean;               // core/mega-cap watch list membership
}

export interface MajorMoveRead {
  detected: boolean;
  /** "detected" = significant move in progress · "extended" = do not chase */
  status: "detected" | "extended" | null;
  direction: "up" | "down" | null;
  why: string[];
  failed: string[];
}

// Tier thresholds (env-tunable). Core/mega-caps: a 2.25% day move on $150M+
// of traded dollars IS news; runners need more % and less dollar proof.
export const MAJOR_MOVE_CORE_MIN_PCT = Number(process.env.MAJOR_MOVE_CORE_MIN_PCT ?? 2.25);
export const MAJOR_MOVE_RUNNER_MIN_PCT = Number(process.env.MAJOR_MOVE_RUNNER_MIN_PCT ?? 5);
export const MAJOR_MOVE_EXTENDED_MULT = Number(process.env.MAJOR_MOVE_EXTENDED_MULT ?? 2);
export const MAJOR_MOVE_MIN_RELVOL = Number(process.env.MAJOR_MOVE_MIN_RELVOL ?? 1.4);
export const MAJOR_MOVE_CORE_MIN_DOLLARS = Number(process.env.MAJOR_MOVE_CORE_MIN_DOLLARS ?? 150_000_000);
export const MAJOR_MOVE_RUNNER_MIN_DOLLARS = Number(process.env.MAJOR_MOVE_RUNNER_MIN_DOLLARS ?? 25_000_000);

export function detectMajorMove(r: MajorMoveInput): MajorMoveRead {
  const why: string[] = [];
  const failed: string[] = [];
  const none: MajorMoveRead = { detected: false, status: null, direction: null, why, failed };

  const movePct = r.movePct;
  if (movePct == null || r.price == null || r.price <= 0) {
    failed.push("no price/day-move data");
    return none;
  }
  const minPct = r.core ? MAJOR_MOVE_CORE_MIN_PCT : MAJOR_MOVE_RUNNER_MIN_PCT;
  const magnitude = Math.abs(movePct);
  const direction: "up" | "down" = movePct >= 0 ? "up" : "down";

  if (magnitude >= minPct) {
    why.push(`day move ${movePct.toFixed(1)}% ≥ ${minPct}% (${r.core ? "large-cap" : "runner"} bar)`);
  } else {
    failed.push(`day move ${movePct.toFixed(1)}% < ${minPct}% ${r.core ? "large-cap" : "runner"} bar`);
    return none;
  }

  // Dollar-volume proof: a % move without dollars behind it is not "major".
  const minDollars = r.core ? MAJOR_MOVE_CORE_MIN_DOLLARS : MAJOR_MOVE_RUNNER_MIN_DOLLARS;
  const dollars = r.volume != null ? r.volume * r.price : null;
  if (dollars == null) {
    failed.push("volume unavailable — dollar-volume unproven");
    return none;
  }
  if (dollars >= minDollars) {
    why.push(`$${(dollars / 1e6).toFixed(0)}M traded ≥ $${(minDollars / 1e6).toFixed(0)}M floor`);
  } else {
    failed.push(`$${(dollars / 1e6).toFixed(0)}M traded < $${(minDollars / 1e6).toFixed(0)}M floor`);
    return none;
  }

  // Participation: elevated RVOL when known; unknown tolerated for core names
  // (their dollar floor already proves participation).
  if (r.relVol != null) {
    if (r.relVol >= MAJOR_MOVE_MIN_RELVOL) why.push(`RVOL ${r.relVol.toFixed(1)}x ≥ ${MAJOR_MOVE_MIN_RELVOL}x`);
    else if (!r.core) { failed.push(`RVOL ${r.relVol.toFixed(1)}x < ${MAJOR_MOVE_MIN_RELVOL}x (runner requires it)`); return none; }
    else failed.push(`RVOL ${r.relVol.toFixed(1)}x below ${MAJOR_MOVE_MIN_RELVOL}x (tolerated: dollar floor met)`);
  }

  // Structure: VWAP on the move's side when known (null tolerated — VWAP is
  // only fetched for near-trigger symbols).
  if (r.aboveVwap != null) {
    const aligned = direction === "up" ? r.aboveVwap : !r.aboveVwap;
    if (aligned) why.push(`holding ${direction === "up" ? "above" : "below"} VWAP`);
    else { failed.push(`VWAP against the move — grind unconfirmed`); return none; }
  }

  const extended = magnitude >= minPct * MAJOR_MOVE_EXTENDED_MULT;
  if (extended) why.push(`${magnitude.toFixed(1)}% ≥ ${(minPct * MAJOR_MOVE_EXTENDED_MULT).toFixed(1)}% — extended, do not chase`);

  return { detected: true, status: extended ? "extended" : "detected", direction, why, failed };
}
