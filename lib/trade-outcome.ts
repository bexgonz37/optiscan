/**
 * trade-outcome.ts — deterministic, fee-aware grading of a completed paper trade.
 *
 * PURE: no I/O, no DB, no clock in the OUTPUT. Given the immutable entry/exit
 * fields the engine already records, it produces the normalized outcome record
 * plus a WIN / LOSS / BREAKEVEN / UNGRADABLE grade.
 *
 * Cost integrity:
 *  - Slippage is ALREADY embedded in the simulated fill prices (paper-fill-model
 *    fills long entries at ask+slip and exits at bid−slip). It is surfaced for
 *    transparency but MUST NOT be subtracted again.
 *  - Net P&L = gross P&L − entry fees − exit fees.
 *  - A positive GROSS result that goes negative after fees is a LOSS.
 *
 * Only actually-filled, terminal trades may be graded. A filled trade missing
 * required exit information is graded UNGRADABLE (never silently dropped).
 */
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const OUTCOME_VERSION = 1;

export type OutcomeGrade = "WIN" | "LOSS" | "BREAKEVEN" | "UNGRADABLE";
export type GradingStatus = "GRADED" | "UNGRADABLE";
export type DataQualityStatus = "OK" | "LEGACY_LIMITED" | "INCOMPLETE";

/** Deterministic, configurable breakeven tolerance in dollars (net P&L). */
export function breakevenToleranceDollars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OUTCOME_BREAKEVEN_TOLERANCE_DOLLARS);
  return Number.isFinite(n) && n >= 0 ? n : 0.5;
}

export interface OutcomeInput {
  /** True only when the trade actually filled (entry price exists). */
  filled: boolean;
  /** True when the trade reached a terminal state. */
  terminal: boolean;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number | null;
  /** 100 for options, 1 for stock. */
  multiplier: number;
  /** +1 long; −1 short (short disabled while bearish is off, kept for completeness). */
  direction: 1 | -1;
  entryFees: number | null;
  exitFees: number | null;
  entrySlippage: number | null;
  exitSlippage: number | null;
  riskAmount: number | null;
  mfePct: number | null;
  maePct: number | null;
  entryAtMs: number | null;
  exitAtMs: number | null;
  /** Pre-rebuild trade with incomplete entry-time provenance. */
  legacy?: boolean;
}

export interface GradedOutcome {
  grade: OutcomeGrade;
  gradingStatus: GradingStatus;
  dataQualityStatus: DataQualityStatus;
  dataQualityReasons: string[];
  grossPnl: number | null;
  netPnl: number | null;
  returnPct: number | null;
  rMultiple: number | null;
  holdMinutes: number | null;
  entryFees: number | null;
  exitFees: number | null;
  entrySlippage: number | null;
  exitSlippage: number | null;
  mfePct: number | null;
  maePct: number | null;
  outcomeVersion: number;
}

/** Grade a completed trade on NET realized P&L after fees. */
export function gradeOutcome(input: OutcomeInput, env: NodeJS.ProcessEnv = process.env): GradedOutcome {
  const reasons: string[] = [];
  const tol = breakevenToleranceDollars(env);

  const qty = isNum(input.quantity) && input.quantity > 0 ? input.quantity : null;
  const entry = isNum(input.entryPrice) && input.entryPrice > 0 ? input.entryPrice : null;
  const exit = isNum(input.exitPrice) && input.exitPrice >= 0 ? input.exitPrice : null;
  const mult = isNum(input.multiplier) && input.multiplier > 0 ? input.multiplier : null;

  if (!input.filled) reasons.push("not_filled");
  if (entry == null) reasons.push("missing_entry_price");
  if (exit == null) reasons.push("missing_exit_price");
  if (qty == null) reasons.push("missing_quantity");
  if (mult == null) reasons.push("missing_multiplier");
  if (!isNum(input.entryAtMs)) reasons.push("missing_entry_time");
  if (!isNum(input.exitAtMs)) reasons.push("missing_exit_time");

  const entryFees = isNum(input.entryFees) ? input.entryFees : null;
  const exitFees = isNum(input.exitFees) ? input.exitFees : null;
  const entrySlippage = isNum(input.entrySlippage) ? input.entrySlippage : null;
  const exitSlippage = isNum(input.exitSlippage) ? input.exitSlippage : null;

  const holdMinutes = isNum(input.entryAtMs) && isNum(input.exitAtMs)
    ? +(((input.exitAtMs as number) - (input.entryAtMs as number)) / 60000).toFixed(2)
    : null;

  const gradable = input.filled && entry != null && exit != null && qty != null && mult != null
    && isNum(input.entryAtMs) && isNum(input.exitAtMs);

  if (!gradable) {
    return {
      grade: "UNGRADABLE",
      gradingStatus: "UNGRADABLE",
      dataQualityStatus: "INCOMPLETE",
      dataQualityReasons: reasons,
      grossPnl: null,
      netPnl: null,
      returnPct: null,
      rMultiple: null,
      holdMinutes,
      entryFees,
      exitFees,
      entrySlippage,
      exitSlippage,
      mfePct: isNum(input.mfePct) ? input.mfePct : null,
      maePct: isNum(input.maePct) ? input.maePct : null,
      outcomeVersion: OUTCOME_VERSION,
    };
  }

  const grossPnl = +(((exit as number) - (entry as number)) * input.direction * (mult as number) * (qty as number)).toFixed(2);
  const feeTotal = (entryFees ?? 0) + (exitFees ?? 0);
  const netPnl = +(grossPnl - feeTotal).toFixed(2);
  const notional = (entry as number) * (mult as number) * (qty as number);
  const returnPct = notional > 0 ? +((netPnl / notional) * 100).toFixed(2) : null;

  const riskAmount = isNum(input.riskAmount) && input.riskAmount > 0 ? input.riskAmount : null;
  const rMultiple = riskAmount != null ? +(netPnl / riskAmount).toFixed(3) : null;
  if (riskAmount == null) reasons.push("risk_amount_missing");

  let grade: OutcomeGrade;
  if (netPnl > tol) grade = "WIN";
  else if (netPnl < -tol) grade = "LOSS";
  else grade = "BREAKEVEN";

  const dataQualityStatus: DataQualityStatus = input.legacy ? "LEGACY_LIMITED" : "OK";

  return {
    grade,
    gradingStatus: "GRADED",
    dataQualityStatus,
    dataQualityReasons: reasons,
    grossPnl,
    netPnl,
    returnPct,
    rMultiple,
    holdMinutes,
    entryFees,
    exitFees,
    entrySlippage,
    exitSlippage,
    mfePct: isNum(input.mfePct) ? input.mfePct : null,
    maePct: isNum(input.maePct) ? input.maePct : null,
    outcomeVersion: OUTCOME_VERSION,
  };
}

/** Map a terminal PaperState to a stable terminal-kind label. */
export function terminalKind(status: string, exitReason: string | null | undefined): string {
  switch (status) {
    case "STOPPED_OUT": return "STOP";
    case "TAKE_PROFIT": return "TARGET";
    case "EXPIRED": return "EXPIRATION";
    case "EXITED": {
      const r = String(exitReason ?? "").toLowerCase();
      if (r.startsWith("manual")) return "MANUAL";
      if (r.startsWith("smart")) return "SMART";
      if (r.startsWith("timeout") || r.includes("max hold")) return "TIMEOUT";
      return "EXITED";
    }
    default: return "UNKNOWN";
  }
}
