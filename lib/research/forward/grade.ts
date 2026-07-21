/**
 * lib/research/forward/grade.ts — forward outcome grading (Phase F). PURE core + OnDb store.
 * Outcomes are graded from bars strictly AFTER capture (labelAsOfMs > capturedAtMs — no look-ahead)
 * and written to forward_outcomes, so the captured recommendation is never mutated. Side-aware:
 * puts/bearish profit from a DOWN move.
 */
import type { ForwardHorizon, ForwardOutcome, Vehicle } from "./schema.ts";

export interface Bar { t: number; o: number; h: number; l: number; c: number }

export interface GradeInput {
  recId: string;
  side: Vehicle;               // call/stock → up is a win; put → down is a win
  capturedAtMs: number;
  entryPrice: number;          // underlying entry (next-bar open, supplied by the caller)
  horizon: ForwardHorizon;
  forwardBars: Bar[];          // bars with t > capturedAtMs only
  horizonEndMs: number;        // resolved end of the horizon (must be reached by forwardBars)
}

/** Grade one horizon. Returns null if the forward window is not fully covered (never guesses). */
export function gradeForwardOutcome(input: GradeInput): ForwardOutcome | null {
  const bars = input.forwardBars.filter((b) => b.t > input.capturedAtMs && b.t <= input.horizonEndMs).sort((a, b) => a.t - b.t);
  if (bars.length === 0) return null;
  if (!bars.some((b) => b.t >= input.horizonEndMs) && bars[bars.length - 1].t < input.horizonEndMs) {
    // window not reached → do not fabricate a partial outcome
    return null;
  }
  const last = bars[bars.length - 1];
  const bullish = input.side !== "put";
  const raw = input.entryPrice > 0 ? ((last.c - input.entryPrice) / input.entryPrice) * 100 : 0;
  const returnPct = bullish ? raw : -raw;             // side-aware
  const highs = bars.map((b) => b.h), lows = bars.map((b) => b.l);
  const upMax = ((Math.max(...highs) - input.entryPrice) / input.entryPrice) * 100;
  const downMax = ((Math.min(...lows) - input.entryPrice) / input.entryPrice) * 100;
  const mfePct = bullish ? upMax : -downMax;          // max favorable excursion (side-aware)
  const maePct = bullish ? downMax : -upMax;          // max adverse excursion (side-aware)
  return { recId: input.recId, horizon: input.horizon, labelAsOfMs: last.t, returnPct: +returnPct.toFixed(6), win: returnPct > 0, mfePct: +mfePct.toFixed(6), maePct: +maePct.toFixed(6), outcomeKind: "REAL_UNDERLYING" };
}

interface GradeDb { prepare(sql: string): { run: (...a: any[]) => { changes: number } } }

/** Persist a forward outcome (idempotent per rec_id+horizon). Refuses a non-forward label. */
export function persistForwardOutcomeOnDb(db: GradeDb, capturedAtMs: number, o: ForwardOutcome, nowMs: number = Date.now()): { inserted: boolean; refused: boolean } {
  if (o.labelAsOfMs <= capturedAtMs) return { inserted: false, refused: true }; // look-ahead guard
  const info = db.prepare(
    `INSERT OR IGNORE INTO forward_outcomes (rec_id, horizon, label_as_of_ms, return_pct, win, mfe_pct, mae_pct, outcome_kind, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(o.recId, o.horizon, o.labelAsOfMs, o.returnPct, o.win ? 1 : 0, o.mfePct, o.maePct, o.outcomeKind, nowMs);
  return { inserted: info.changes > 0, refused: false };
}
