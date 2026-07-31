/**
 * management.ts — the deterministic, VERSIONED paper-management rules. PURE.
 *
 * No db, no clock, no provider, no AI. Every function here maps its inputs to
 * exactly one output, so a position's whole life is reproducible from its
 * stored marks and the rules version stamped on it at entry.
 *
 * MARKS AND EXITS ARE THE BID. Entry was the ask (entry.ts). Conservative on
 * both sides: you pay the offer to get in and you hit the bid to get out. A mid
 * would flatter every result in this lane by roughly a full spread.
 *
 * AN EXIT PRICE IS NEVER INVENTED. When no valid bid exists the caller is told
 * UNVERIFIED and the position stays open with the reason recorded. It is not
 * closed at zero, not marked a loss, and not carried at its last known price as
 * though that were a fill.
 *
 * PRECEDENCE IS FIXED and ordered worst-first, so a position that is
 * simultaneously invalidated and stopped reports the more fundamental cause.
 */
import { PAPER_RULES_VERSION } from "./lane.ts";

/** Return milestones tracked for every position, ascending. */
export const PAPER_MILESTONES = [25, 50, 100, 200, 500] as const;

export interface ManagementConfig {
  /** Exit when the option premium falls this far below the entry fill. */
  stopLossPct: number;
  /** Exit at this gain. The deterministic target. */
  targetPct: number;
  /** Above this MFE, trailing protection arms. */
  trailArmPct: number;
  /** Once armed, exit if the return gives back to this fraction of the peak. */
  trailGiveBackFraction: number;
  /** Exit a position that has gone nowhere after this long. */
  timeStopMs: number;
  /** A position under this return at the time stop is "gone nowhere". */
  timeStopMinReturnPct: number;
  /** A spread wider than this is a liquidity failure. */
  maxSpreadPct: number;
  /** Close everything this long before the session close. */
  sessionExitLeadMs: number;
  /** Give up retrying an unobtainable exit after this many attempts. */
  maxExitAttempts: number;
}

export const DEFAULT_MANAGEMENT: Readonly<ManagementConfig> = Object.freeze({
  stopLossPct: 35,
  targetPct: 200,
  trailArmPct: 100,
  trailGiveBackFraction: 0.5,
  timeStopMs: 120 * 60_000,
  timeStopMinReturnPct: 10,
  maxSpreadPct: 50,
  sessionExitLeadMs: 5 * 60_000,
  maxExitAttempts: 20,
});

export function resolveManagementConfig(env: NodeJS.ProcessEnv = process.env): ManagementConfig {
  const n = (raw: string | undefined, dflt: number, lo: number, hi: number): number => {
    const x = Number(raw);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
  };
  return {
    ...DEFAULT_MANAGEMENT,
    stopLossPct: n(env.HIGH_ASYMMETRY_PAPER_STOP_PCT, DEFAULT_MANAGEMENT.stopLossPct, 5, 95),
    targetPct: n(env.HIGH_ASYMMETRY_PAPER_TARGET_PCT, DEFAULT_MANAGEMENT.targetPct, 10, 2000),
    timeStopMs: n(env.HIGH_ASYMMETRY_PAPER_TIME_STOP_MS, DEFAULT_MANAGEMENT.timeStopMs, 5 * 60_000, 8 * 60 * 60_000),
  };
}

export type PaperExitReason =
  | "UNDERLYING_INVALIDATION"
  | "LIQUIDITY_FAILURE"
  | "PREMIUM_STOP"
  | "TRAILING_PROTECTION"
  | "TARGET_REACHED"
  | "TIME_STOP"
  | "SESSION_END";

export type PaperManagementAction =
  | { action: "HOLD"; reason: null; exitReason: null; exitFill: null; rulesVersion: string }
  | { action: "EXIT"; reason: string; exitReason: PaperExitReason; exitFill: number; rulesVersion: string }
  /** An exit is warranted but no valid bid exists. The position stays open. */
  | { action: "UNVERIFIED"; reason: string; exitReason: PaperExitReason | null; exitFill: null; rulesVersion: string };

export interface ManagedPosition {
  entryFill: number;
  entryAtMs: number;
  mfePct: number | null;
  maePct: number | null;
  exitAttempts: number;
}

export interface ManagementObservation {
  /** Present-time bid. The only price an exit may use. */
  bid: number | null;
  ask: number | null;
  quoteAtMs: number | null;
  /** True only when the case was deterministically invalidated. */
  caseInvalidated: boolean;
  /** Spread at observation, when computable. */
  spreadPct: number | null;
}

/** Running excursions from a new return observation. Pure. */
export function updateExcursions(
  prior: { mfePct: number | null; maePct: number | null },
  returnPct: number | null,
): { mfePct: number | null; maePct: number | null } {
  if (returnPct == null || !Number.isFinite(returnPct)) return prior;
  return {
    mfePct: prior.mfePct == null ? returnPct : Math.max(prior.mfePct, returnPct),
    maePct: prior.maePct == null ? returnPct : Math.min(prior.maePct, returnPct),
  };
}

/**
 * Highest milestone reached, from the PEAK return rather than the current one —
 * a position that touched +100% and fell back still reached +100%.
 * Returns null when nothing was reached, never 0.
 */
export function highestMilestone(mfePct: number | null): number | null {
  if (mfePct == null || !Number.isFinite(mfePct)) return null;
  let best: number | null = null;
  for (const m of PAPER_MILESTONES) if (mfePct >= m) best = m;
  return best;
}

/** Milestone counts across a cohort. Every milestone is always present. */
export function milestoneDistribution(mfes: Array<number | null>): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const m of PAPER_MILESTONES) dist[`+${m}%`] = 0;
  for (const mfe of mfes) {
    if (mfe == null) continue;
    for (const m of PAPER_MILESTONES) if (mfe >= m) dist[`+${m}%`] += 1;
  }
  return dist;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Decide what to do with one open position, right now.
 *
 * `sessionCloseAtMs` is supplied by the caller because the close moves on early
 * -close days; deriving it here would make this module time-zone aware and
 * therefore untestable as a pure function.
 */
export function evaluatePaperManagement(
  position: ManagedPosition,
  obs: ManagementObservation,
  nowMs: number,
  sessionCloseAtMs: number,
  cfg: ManagementConfig = DEFAULT_MANAGEMENT,
): PaperManagementAction {
  const v = PAPER_RULES_VERSION;
  const bid = num(obs.bid);
  const entry = num(position.entryFill);
  const hold = (): PaperManagementAction => ({ action: "HOLD", reason: null, exitReason: null, exitFill: null, rulesVersion: v });
  const unverified = (reason: string, exitReason: PaperExitReason | null): PaperManagementAction =>
    ({ action: "UNVERIFIED", reason, exitReason, exitFill: null, rulesVersion: v });
  const exit = (exitReason: PaperExitReason, reason: string): PaperManagementAction =>
    ({ action: "EXIT", reason, exitReason, exitFill: bid as number, rulesVersion: v });

  if (entry == null || entry <= 0) return unverified("position has no usable entry fill", null);

  const returnPct = bid != null && bid > 0 ? ((bid - entry) / entry) * 100 : null;
  const mfe = num(position.mfePct);
  const timeInTradeMs = nowMs - position.entryAtMs;
  const sessionDue = nowMs >= sessionCloseAtMs - cfg.sessionExitLeadMs;

  // Which rule WOULD fire, independent of whether a price exists to fill at.
  // Determining the reason first is what lets an unobtainable exit be reported
  // as missing data about a specific decision rather than as a vague failure.
  let due: { reason: PaperExitReason; detail: string } | null = null;

  if (obs.caseInvalidated) {
    due = { reason: "UNDERLYING_INVALIDATION", detail: "the case was deterministically invalidated" };
  } else if (obs.spreadPct != null && obs.spreadPct > cfg.maxSpreadPct) {
    due = { reason: "LIQUIDITY_FAILURE", detail: `spread ${round2(obs.spreadPct)}% exceeds ${cfg.maxSpreadPct}%` };
  } else if (returnPct != null && returnPct <= -cfg.stopLossPct) {
    due = { reason: "PREMIUM_STOP", detail: `return ${round2(returnPct)}% hit the -${cfg.stopLossPct}% premium stop` };
  } else if (returnPct != null && mfe != null && mfe >= cfg.trailArmPct && returnPct <= mfe * cfg.trailGiveBackFraction) {
    due = {
      reason: "TRAILING_PROTECTION",
      detail: `peak +${round2(mfe)}% gave back to ${round2(returnPct)}%, past the ${cfg.trailGiveBackFraction * 100}% floor`,
    };
  } else if (returnPct != null && returnPct >= cfg.targetPct) {
    due = { reason: "TARGET_REACHED", detail: `return ${round2(returnPct)}% reached the +${cfg.targetPct}% target` };
  } else if (timeInTradeMs >= cfg.timeStopMs && (returnPct == null || returnPct < cfg.timeStopMinReturnPct)) {
    due = {
      reason: "TIME_STOP",
      detail: `${Math.round(timeInTradeMs / 60_000)} min in trade below +${cfg.timeStopMinReturnPct}%`,
    };
  } else if (sessionDue) {
    due = { reason: "SESSION_END", detail: "the session close is within the exit lead" };
  }

  if (!due) return hold();

  // The rule fired. Now — and only now — does a fill price matter.
  if (bid == null || bid <= 0) {
    if (position.exitAttempts >= cfg.maxExitAttempts) {
      return unverified(`${due.reason}: no valid bid after ${position.exitAttempts} attempts`, due.reason);
    }
    return unverified(`${due.reason}: no valid bid to exit against`, due.reason);
  }
  return exit(due.reason, due.detail);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
export { PAPER_RULES_VERSION };
