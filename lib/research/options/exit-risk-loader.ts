/**
 * Feed the two exit-risk observation studies from the owner lane.
 *
 * Both studies (`profit-protection-observation.ts`, `overnight-risk-observation.ts`) are pure
 * and take marks. This module is the only place that reads them out of SQLite, so the
 * exact-contract discipline is applied once: a mark on a re-selected strike is a different
 * instrument, and the phantom +149% MFE in an earlier packet is what happens when it is not.
 *
 * The population is `buildOwnerLearningReportOnDb`'s — the same rows the nightly research, the
 * strength experiment and the private app read. Nothing here recomputes an outcome, a path
 * label, a stop or a return; it maps what the owner lane already decided onto the studies'
 * inputs, so no consumer can show a different result for the same callout.
 *
 * READ-ONLY. No INSERT/UPDATE/DELETE, no provider call, no exit or stop path reads any of it.
 */

import { tradingDay } from "../../trading-session.ts";
import { easternMinuteOfDay } from "./pre-entry-features.ts";
import {
  buildOwnerLearningReportOnDb,
  type OwnerLearningDb,
  type OwnerLearningRow,
} from "./owner-learning.ts";
import {
  observeMilestones,
  buildProtectionObservation,
  type ProtectionCase,
  type ProtectionOutcome,
  type ProtectionObservationReport,
} from "./profit-protection-observation.ts";
import {
  observeOvernight,
  buildOvernightObservation,
  type OvernightCase,
  type OvernightObservationReport,
} from "./overnight-risk-observation.ts";

interface MarkRow {
  atMs: number | null;
  returnPct: number | null;
  exitFill: number | null;
}

function hasTable(db: OwnerLearningDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name)); }
  catch { return false; }
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Same-contract marks only, in time order. */
function marksFor(db: OwnerLearningDb, tradeId: number, occ: string | null): MarkRow[] {
  if (!occ || !hasTable(db, "options_paper_marks")) return [];
  try {
    return ((db.prepare(
      `SELECT mark_at_ms, return_pct, exit_fill FROM options_paper_marks
        WHERE trade_id=? AND UPPER(TRIM(option_symbol))=UPPER(TRIM(?))
        ORDER BY mark_at_ms ASC`,
    ).all?.(tradeId, occ) ?? []) as Record<string, unknown>[]).map((r) => ({
      atMs: num(r.mark_at_ms),
      returnPct: num(r.return_pct),
      exitFill: num(r.exit_fill),
    }));
  } catch {
    return [];
  }
}

/**
 * Map the owner lane's path verdict onto the studies' outcome vocabulary.
 *
 * `PATH_UNKNOWN` becomes `UNGRADED`, never `OTHER_CLOSED`. A trade whose marks could not
 * support a verdict is not a trade that failed to work — collapsing the two is exactly the
 * substitution the owner lane refuses to make, and it must not be reintroduced here.
 */
export function toOutcome(row: OwnerLearningRow): ProtectionOutcome {
  if (row.status !== "EXITED" || row.realizedReturnPct == null) return "UNGRADED";
  switch (row.pathLabel) {
    case "EVENTUAL_T1_WINNER": return "EVENTUAL_T1_WINNER";
    case "GOOD_MOVE_THEN_REVERSED": return "GOOD_MOVE_THEN_REVERSED";
    case "PATH_UNKNOWN": return "UNGRADED";
    default: return "OTHER_CLOSED";
  }
}

export interface ExitRiskObservations {
  sessionDate: string | null;
  productionBehaviorChanged: false;
  profitProtection: ProtectionObservationReport;
  overnightRisk: OvernightObservationReport;
  /** Callouts considered before either study excluded anything. */
  calloutsConsidered: number;
  note: string;
}

export interface ExitRiskOptions {
  /** Narrow to one ET session. Omit for the whole forward record. */
  sessionDate?: string | null;
  sinceMs?: number | null;
  nowMs?: number;
}

/**
 * Build both observation reports from the owner lane.
 *
 * Closed rows only. An open trade has no outcome to be separated from, and including it at 0%
 * would price an unfinished trade as a scratch.
 */
export function buildExitRiskObservationsOnDb(
  db: OwnerLearningDb,
  opts: ExitRiskOptions = {},
): ExitRiskObservations {
  const report = buildOwnerLearningReportOnDb(db, {
    sessionDate: opts.sessionDate ?? null,
    sinceMs: opts.sinceMs ?? null,
  });
  const closed = report.rows.filter((r) => r.status === "EXITED" && r.realizedReturnPct != null);

  const protectionCases: ProtectionCase[] = [];
  const overnightCases: OvernightCase[] = [];

  for (const row of closed) {
    const occ = row.frozenOptionSymbol ?? row.optionSymbol;
    const marks = marksFor(db, row.paperTradeId, occ);
    const outcome = toOutcome(row);

    protectionCases.push(observeMilestones({
      opportunityCaseId: row.opportunityCaseId,
      symbol: row.symbol,
      optionSymbol: occ,
      side: row.side,
      strategyKey: row.strategyKey,
      sessionDate: row.sessionDate,
      dte: row.dte,
      delta: row.selection.delta,
      selectionStrength: row.selection.selectionStrength,
      rewardRemainingFraction: row.selection.rewardRemainingFraction,
      moveConsumedFraction: row.selection.moveConsumedFraction,
      entryAtMs: row.enteredAtMs,
      realizedReturnPct: row.realizedReturnPct,
      outcome,
      marks,
      occExact: row.occExact,
    }, (a, b) => tradingDay(a) === tradingDay(b)));

    overnightCases.push(observeOvernight({
      opportunityCaseId: row.opportunityCaseId,
      symbol: row.symbol,
      optionSymbol: occ,
      side: row.side,
      strategyKey: row.strategyKey,
      sessionDate: row.sessionDate,
      exitSessionDate: row.exitSessionDate,
      dte: row.dte,
      selectionStrength: row.selection.selectionStrength,
      stopLevel: row.stopEvidence.stopLevel,
      entryAtMs: row.enteredAtMs,
      closedAtMs: row.closedAtMs,
      exitFill: row.stopEvidence.exitFill,
      realizedReturnPct: row.realizedReturnPct,
      outcome,
      marks,
      occExact: row.occExact,
    }, tradingDay, easternMinuteOfDay));
  }

  return {
    sessionDate: opts.sessionDate ?? null,
    productionBehaviorChanged: false,
    profitProtection: buildProtectionObservation(protectionCases),
    overnightRisk: buildOvernightObservation(overnightCases),
    calloutsConsidered: closed.length,
    note:
      "OBSERVATION ONLY. No profit-protection rule and no overnight policy exists or is proposed. " +
      "No target, stop, exit or overnight handling is changed by anything in this report.",
  };
}
