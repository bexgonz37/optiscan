/**
 * paper-challenge.ts — the independent AGGRESSIVE_CHALLENGE paper-only options
 * portfolio ($10,000 → $100,000). It trades the SAME verified actionable options
 * signals and the SAME exact OCC contracts as Primary, but keeps a completely
 * separate balance, positions, P&L, drawdown, and status. It can take much larger
 * risk, but it FAILS HONESTLY if it loses the account — there is no auto-reset and
 * no replenishment, and there is never a broker or real-money path.
 *
 * The pure functions here (config, status, deterministic replay) have no I/O; the
 * summary reads CHALLENGE-tagged rows only, so Primary and Challenge statistics are
 * never mixed.
 */

const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);

export const CHALLENGE_PORTFOLIO = "CHALLENGE";
export const PRIMARY_PORTFOLIO = "PRIMARY";

export type ChallengeStatus = "ACTIVE" | "TARGET_REACHED" | "FAILED";

export interface ChallengeConfig {
  enabled: boolean;
  startingBalanceUsd: number;
  targetUsd: number;
  /** Equity at/below this is a blown account — FAILED, no reset. */
  failureFloorUsd: number;
  /** Risk profile the Challenge sizer uses (its own, independent of Primary). */
  riskProfile: string;
}

export function challengeConfig(env: NodeJS.ProcessEnv = process.env): ChallengeConfig {
  const startingBalanceUsd = num(env.PAPER_CHALLENGE_STARTING_BALANCE_USD, 10_000);
  return {
    enabled: env.PAPER_CHALLENGE_ENABLED === "1",
    startingBalanceUsd,
    targetUsd: num(env.PAPER_CHALLENGE_TARGET_USD, 100_000),
    // Default failure floor = 10% of the starting stake (a blown challenge account).
    failureFloorUsd: num(env.PAPER_CHALLENGE_FAILURE_FLOOR_USD, Math.round(startingBalanceUsd * 0.1)),
    riskProfile: String(env.PAPER_CHALLENGE_RISK_PROFILE ?? "aggressive").trim().toLowerCase(),
  };
}

/**
 * Deterministic status from realized equity. Order matters: a blown account is
 * FAILED even if a later mark would recover — the account is done. TARGET_REACHED
 * latches at/above the target. Otherwise ACTIVE.
 */
export function deriveChallengeStatus(equityDollars: number, cfg: ChallengeConfig): ChallengeStatus {
  if (equityDollars <= cfg.failureFloorUsd) return "FAILED";
  if (equityDollars >= cfg.targetUsd) return "TARGET_REACHED";
  return "ACTIVE";
}

/** May the Challenge take a NEW entry? Only while ACTIVE (never after target/failure). */
export function challengeAcceptsEntries(equityDollars: number, cfg: ChallengeConfig): boolean {
  return cfg.enabled && deriveChallengeStatus(equityDollars, cfg) === "ACTIVE";
}

export interface ChallengeReplayResult {
  finalEquity: number;
  peakEquity: number;
  status: ChallengeStatus;
  /** Index (0-based) of the outcome that first reached target or failed, else null. */
  resolvedAtIndex: number | null;
  maxDrawdownDollars: number;
}

/**
 * Deterministic replay: walk realized P&L deltas in order, latching TARGET_REACHED
 * or FAILED the moment equity crosses a bound — and once resolved, no further
 * outcome changes the status (no reset). Used to measure target-rate / failure-rate
 * over historical outcomes when enough exist.
 */
export function challengeReplay(realizedDeltas: number[], cfg: ChallengeConfig): ChallengeReplayResult {
  let equity = cfg.startingBalanceUsd;
  let peak = equity;
  let maxDd = 0;
  let status: ChallengeStatus = "ACTIVE";
  let resolvedAtIndex: number | null = null;
  for (let i = 0; i < realizedDeltas.length; i++) {
    if (status !== "ACTIVE") break; // resolved — account is done, no reset
    equity += realizedDeltas[i];
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    const s = deriveChallengeStatus(equity, cfg);
    if (s !== "ACTIVE") { status = s; resolvedAtIndex = i; }
  }
  return { finalEquity: +equity.toFixed(2), peakEquity: +peak.toFixed(2), status, resolvedAtIndex, maxDrawdownDollars: +maxDd.toFixed(2) };
}

/** Target-rate / failure-rate over many independent replays (deterministic). */
export function challengeOutcomeRates(replays: ChallengeReplayResult[]): {
  runs: number; targetReached: number; failed: number; active: number;
  targetRatePct: number | null; failureRatePct: number | null;
} {
  const runs = replays.length;
  const targetReached = replays.filter((r) => r.status === "TARGET_REACHED").length;
  const failed = replays.filter((r) => r.status === "FAILED").length;
  const active = replays.filter((r) => r.status === "ACTIVE").length;
  return {
    runs, targetReached, failed, active,
    targetRatePct: runs ? +((targetReached / runs) * 100).toFixed(1) : null,
    failureRatePct: runs ? +((failed / runs) * 100).toFixed(1) : null,
  };
}
