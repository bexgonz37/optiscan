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

import { paperSizingConfig, sizePosition } from "./paper-position-sizer.ts";

const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);
const on = (v: string | undefined, d: boolean): boolean => (v == null || v === "" ? d : v === "1");

export const CHALLENGE_PORTFOLIO = "CHALLENGE";
export const PRIMARY_PORTFOLIO = "PRIMARY";
export const STOCK_DAY_TRADER_PORTFOLIO = "STOCK_DAY_TRADER";
/** Independent high-volume RESEARCH portfolio (Phase 3). Paper-only; its own stake,
 *  sizing, cooldowns, positions, and analytics — never a mirror of Primary. */
export const RESEARCH_PORTFOLIO = "RESEARCH";

/**
 * Map RESEARCH's own knobs onto the pure sizer env, mirroring challengeSizingEnv but
 * reading PAPER_RESEARCH_* (with sensible aggressive-but-bounded defaults). Research
 * intentionally sizes small-and-broad: a modest per-trade risk so a $10k research
 * stake can take MANY concurrent experiments rather than a few big ones. Primary's
 * env is never touched.
 */
export function researchSizingEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);
  const startingBalanceUsd = num(env.PAPER_RESEARCH_STARTING_BALANCE_USD, 10_000);
  return {
    ...env,
    PAPER_RISK_PROFILE: String(env.PAPER_RESEARCH_RISK_PROFILE ?? "aggressive").trim().toLowerCase(),
    PAPER_STARTING_BALANCE_USD: String(startingBalanceUsd),
    PAPER_RISK_PER_TRADE_PCT: String(num(env.PAPER_RESEARCH_RISK_PER_TRADE_PCT, 3)),
    PAPER_MAX_POSITION_PCT: String(num(env.PAPER_RESEARCH_MAX_POSITION_PCT, 20)),
    PAPER_MAX_TOTAL_EXPOSURE_PCT: String(num(env.PAPER_RESEARCH_MAX_TOTAL_EXPOSURE_PCT, 100)),
    PAPER_MAX_DAILY_LOSS_PCT: String(num(env.PAPER_RESEARCH_MAX_DAILY_LOSS_PCT, 30)),
    PAPER_MAX_OPEN_OPTIONS_POSITIONS: String(Math.max(1, Math.trunc(num(env.PAPER_RESEARCH_MAX_OPEN_POSITIONS, 25)))),
    PAPER_MAX_CONTRACTS_PER_TRADE: String(Math.max(1, Math.trunc(num(env.PAPER_RESEARCH_MAX_CONTRACTS, 50)))),
    PAPER_MIN_CONTRACTS_PER_TRADE: String(Math.max(1, Math.trunc(num(env.PAPER_RESEARCH_MIN_CONTRACTS, 1)))),
  };
}

export type ChallengeStatus = "ACTIVE" | "TARGET_REACHED" | "FAILED";

export interface ChallengeConfig {
  enabled: boolean;
  startingBalanceUsd: number;
  targetUsd: number;
  /** Equity at/below this is a blown account — FAILED, no reset. */
  failureFloorUsd: number;
  /** Risk profile the Challenge sizer uses (its own, independent of Primary). */
  riskProfile: string;
  // ── Aggressive sizing knobs (Challenge-only; NEVER applied to Primary) ──
  // Two SEPARATE concepts, per the research intent:
  //   1. maxLossAtStopPct — how much of equity may be LOST at the defined stop on a
  //      single trade (this drives the by-risk contract count; the real budget).
  //   2. maxPositionPct — how much of equity a single position's COST BASIS may reach
  //      (a ceiling; it does not force 60% onto every trade).
  /** % of equity risked to the stop per trade (the by-risk budget). Aggressive default 15%. */
  maxLossAtStopPct: number;
  /** % of equity one position's cost basis may reach (ceiling). Aggressive default 60%. */
  maxPositionPct: number;
  /** % of equity all open positions combined may reach. Aggressive default 100%. */
  maxTotalExposurePct: number;
  /** % of equity of realized daily loss after which no new entries size. Aggressive default 25%. */
  maxDailyLossPct: number;
  /** Hard cap on simultaneously open Challenge option positions. Aggressive default 3. */
  maxOpenPositions: number;
  /** Hard cap on contracts per Challenge trade (high so it never binds a $10k account). */
  maxContractsPerTrade: number;
  /** Minimum contracts a Challenge trade must fit, else rejected. Default 1. */
  minContractsPerTrade: number;
  /** May the Challenge take same-day-expiry (0DTE) options? */
  allowZeroDte: boolean;
  /** Risk haircut on 0DTE Challenge trades (aggressive keeps more risk on). */
  zeroDteRiskMultiplier: number;
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
    // PAPER_CHALLENGE_RISK_PER_TRADE_PCT and PAPER_CHALLENGE_MAX_LOSS_AT_STOP_PCT are
    // synonyms for the same by-risk budget knob; risk-per-trade wins if both are set.
    maxLossAtStopPct: num(env.PAPER_CHALLENGE_RISK_PER_TRADE_PCT ?? env.PAPER_CHALLENGE_MAX_LOSS_AT_STOP_PCT, 15),
    maxPositionPct: num(env.PAPER_CHALLENGE_MAX_POSITION_PCT, 60),
    maxTotalExposurePct: num(env.PAPER_CHALLENGE_MAX_TOTAL_EXPOSURE_PCT, 100),
    maxDailyLossPct: num(env.PAPER_CHALLENGE_MAX_DAILY_LOSS_PCT, 25),
    maxOpenPositions: Math.max(1, Math.trunc(num(env.PAPER_CHALLENGE_MAX_OPEN_POSITIONS, 3))),
    maxContractsPerTrade: Math.max(1, Math.trunc(num(env.PAPER_CHALLENGE_MAX_CONTRACTS, 500))),
    minContractsPerTrade: Math.max(1, Math.trunc(num(env.PAPER_CHALLENGE_MIN_CONTRACTS, 1))),
    allowZeroDte: on(env.PAPER_CHALLENGE_ALLOW_0DTE, on(env.PAPER_ALLOW_ZERO_DTE, true)),
    zeroDteRiskMultiplier: num(env.PAPER_CHALLENGE_ZERO_DTE_RISK_MULT, 0.7),
  };
}

/**
 * Map the Challenge config onto the env keys the pure sizer (`paperSizingConfig`)
 * reads, so `paperSizingConfig(challengeSizingEnv())` yields the Challenge's OWN
 * aggressive sizer — its by-risk budget (loss-at-stop), 60% position ceiling, and
 * its own exposure / daily-loss / contract caps. This is what makes the 60% ceiling
 * REACHABLE: without a large loss-at-stop budget the 2% aggressive-profile default
 * stayed the binding constraint and the Challenge sized like a conservative account.
 * Primary's env is never touched.
 */
export function challengeSizingEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cfg = challengeConfig(env);
  return {
    ...env,
    PAPER_RISK_PROFILE: cfg.riskProfile,
    PAPER_STARTING_BALANCE_USD: String(cfg.startingBalanceUsd),
    PAPER_RISK_PER_TRADE_PCT: String(cfg.maxLossAtStopPct),
    PAPER_MAX_POSITION_PCT: String(cfg.maxPositionPct),
    PAPER_MAX_TOTAL_EXPOSURE_PCT: String(cfg.maxTotalExposurePct),
    PAPER_MAX_DAILY_LOSS_PCT: String(cfg.maxDailyLossPct),
    PAPER_MAX_OPEN_OPTIONS_POSITIONS: String(cfg.maxOpenPositions),
    PAPER_MAX_CONTRACTS_PER_TRADE: String(cfg.maxContractsPerTrade),
    PAPER_MIN_CONTRACTS_PER_TRADE: String(cfg.minContractsPerTrade),
    PAPER_ZERO_DTE_RISK_MULT: String(cfg.zeroDteRiskMultiplier),
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

export interface ChallengeSizingExample {
  premium: number;
  stopLossPct: number;
  contracts: number;
  costBasisDollars: number;
  costBasisPctOfEquity: number;
  modeledLossAtStopDollars: number;
  modeledLossAtStopPctOfEquity: number;
  bindingConstraint: string;
  rejected: boolean;
}

/**
 * Deterministic example Challenge quantities at a given equity for a set of
 * premiums, using the ACTUAL implemented sizer (`sizePosition`) with the Challenge's
 * own aggressive config. Pure — proves how aggressive the Challenge is without any
 * live fill. Ample buying power / no open exposure is assumed so the numbers reflect
 * the sizing formula itself, not incidental capital state.
 */
export function challengeSizingExamples(
  equityDollars: number = 10_000,
  premiums: number[] = [0.5, 1.0, 2.5, 5.0, 10.0],
  stopLossPct = 30,
  env: NodeJS.ProcessEnv = process.env,
): ChallengeSizingExample[] {
  const cfg = paperSizingConfig(challengeSizingEnv(env));
  return premiums.map((premium) => {
    const r = sizePosition({
      equityDollars, entryPrice: premium, multiplier: 100, stopLossPct,
      openExposureDollars: 0, openTickerExposureDollars: 0,
      availableBuyingPowerDollars: equityDollars, realizedDailyLossDollars: 0, isZeroDte: false,
    }, cfg);
    const costBasis = r.contracts * premium * 100;
    const lossAtStop = r.contracts * premium * 100 * Math.min(1, stopLossPct / 100);
    return {
      premium,
      stopLossPct,
      contracts: r.contracts,
      costBasisDollars: +costBasis.toFixed(2),
      costBasisPctOfEquity: +((costBasis / equityDollars) * 100).toFixed(1),
      modeledLossAtStopDollars: +lossAtStop.toFixed(2),
      modeledLossAtStopPctOfEquity: +((lossAtStop / equityDollars) * 100).toFixed(1),
      bindingConstraint: r.calc.bindingConstraint,
      rejected: r.rejected,
    };
  });
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
