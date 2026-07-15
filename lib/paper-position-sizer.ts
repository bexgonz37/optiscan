/**
 * paper-position-sizer.ts — PURE, deterministic, risk-based position sizing for
 * paper trading. No I/O, no clock, no randomness in the output.
 *
 * This is the module that decides HOW MANY contracts (or shares) a paper entry
 * takes. It replaces the old "1 contract unless an experimental dollar target is
 * set, then widen every cap" behaviour with an explicit risk profile that sizes
 * from account equity and the loss at the defined stop, and then clamps the
 * result against EVERY hard cap. The aggressive profile takes larger positions
 * but can never breach a cap — over-limit is impossible by construction because
 * the final size is a min() across all caps.
 *
 * The full calculation (every intermediate bound and the binding constraint) and
 * any rejection reason are returned verbatim so the paper trade detail page can
 * show exactly why a size was chosen or refused. Nothing here is confidence- or
 * win-probability-driven: probability NEVER enters sizing and NEVER relaxes a cap.
 */

export type PaperRiskProfile = "conservative" | "standard" | "aggressive";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);
const posInt = (v: number, d: number): number => (Number.isFinite(v) && v > 0 ? Math.floor(v) : d);

export interface PaperSizingConfig {
  profile: PaperRiskProfile;
  /** Simulated account size the percentages are measured against. */
  startingBalanceUsd: number;
  /** % of equity put at risk to the defined stop on a single trade. */
  riskPerTradePct: number;
  /** % of equity a single position's cost basis may reach (hard cap). */
  maxPositionPct: number;
  /** % of equity all open positions combined may reach (hard cap). */
  maxTotalExposurePct: number;
  /** Hard cap on simultaneously open OPTIONS positions. */
  maxOpenOptionsPositions: number;
  /** % of equity of realized daily loss after which no new entries size (hard cap). */
  maxDailyLossPct: number;
  /** Hard cap on contracts (or share-lots) per trade. */
  maxContractsPerTrade: number;
  /** Minimum contracts a trade must be able to hold, else it is rejected (never forced over a cap). */
  minContractsPerTrade: number;
  /** Extra risk haircut applied to 0DTE (same-day expiry) — faster, binary game. */
  zeroDteRiskMultiplier: number;
}

/** Deterministic per-profile defaults. Bounded on purpose; aggressive ≠ unbounded. */
export function profileDefaults(profile: PaperRiskProfile): Omit<PaperSizingConfig, "profile" | "startingBalanceUsd"> {
  switch (profile) {
    case "conservative":
      return { riskPerTradePct: 0.5, maxPositionPct: 5, maxTotalExposurePct: 15, maxOpenOptionsPositions: 3, maxDailyLossPct: 3, maxContractsPerTrade: 5, minContractsPerTrade: 1, zeroDteRiskMultiplier: 0.5 };
    case "aggressive":
      return { riskPerTradePct: 2.0, maxPositionPct: 20, maxTotalExposurePct: 60, maxOpenOptionsPositions: 8, maxDailyLossPct: 8, maxContractsPerTrade: 25, minContractsPerTrade: 2, zeroDteRiskMultiplier: 0.7 };
    case "standard":
    default:
      return { riskPerTradePct: 1.0, maxPositionPct: 10, maxTotalExposurePct: 30, maxOpenOptionsPositions: 5, maxDailyLossPct: 5, maxContractsPerTrade: 10, minContractsPerTrade: 1, zeroDteRiskMultiplier: 0.6 };
  }
}

export function resolveRiskProfile(env: NodeJS.ProcessEnv = process.env): PaperRiskProfile {
  const raw = String(env.PAPER_RISK_PROFILE ?? "standard").trim().toLowerCase();
  return raw === "conservative" || raw === "aggressive" ? raw : "standard";
}

/**
 * Build the sizing config. The profile picks the baseline; each individual knob
 * may be overridden by its own env var (documented, deterministic). Starting
 * balance reads PAPER_STARTING_BALANCE_USD, then the legacy PAPER_STARTING_BALANCE,
 * then a 5000 default so it composes with the existing capital engine.
 */
export function paperSizingConfig(env: NodeJS.ProcessEnv = process.env): PaperSizingConfig {
  const profile = resolveRiskProfile(env);
  const d = profileDefaults(profile);
  return {
    profile,
    startingBalanceUsd: num(env.PAPER_STARTING_BALANCE_USD ?? env.PAPER_STARTING_BALANCE, 5000),
    riskPerTradePct: num(env.PAPER_RISK_PER_TRADE_PCT, d.riskPerTradePct),
    maxPositionPct: num(env.PAPER_MAX_POSITION_PCT, d.maxPositionPct),
    maxTotalExposurePct: num(env.PAPER_MAX_TOTAL_EXPOSURE_PCT, d.maxTotalExposurePct),
    maxOpenOptionsPositions: posInt(num(env.PAPER_MAX_OPEN_OPTIONS_POSITIONS, d.maxOpenOptionsPositions), d.maxOpenOptionsPositions),
    maxDailyLossPct: num(env.PAPER_MAX_DAILY_LOSS_PCT, d.maxDailyLossPct),
    maxContractsPerTrade: posInt(num(env.PAPER_MAX_CONTRACTS_PER_TRADE, d.maxContractsPerTrade), d.maxContractsPerTrade),
    minContractsPerTrade: posInt(num(env.PAPER_MIN_CONTRACTS_PER_TRADE, d.minContractsPerTrade), d.minContractsPerTrade),
    zeroDteRiskMultiplier: num(env.PAPER_ZERO_DTE_RISK_MULT, d.zeroDteRiskMultiplier),
  };
}

export interface SizingInput {
  /** Live account equity (startingBalance + realized P/L). */
  equityDollars: number;
  /** Per-unit entry premium (option) or share price (stock). */
  entryPrice: number;
  /** 100 for options, 1 for stock/shares. */
  multiplier: number;
  /** Stop distance as a % of the premium/price (e.g. 25 = exit at −25%). Null ⇒ full premium at risk. */
  stopLossPct: number | null;
  /** Dollars of open-position cost basis already committed (all positions). */
  openExposureDollars: number;
  /** Dollars of open cost basis already committed to THIS ticker (correlation/dup guard). */
  openTickerExposureDollars: number;
  /** Buying power still available from the capital engine. */
  availableBuyingPowerDollars: number;
  /** Realized loss so far today, as a positive number of dollars (0 if flat/up). */
  realizedDailyLossDollars: number;
  /** Same-day expiry? Applies the 0DTE risk haircut. */
  isZeroDte: boolean;
  /** Per-unit slippage assumption (dollars) folded into risk-per-unit. */
  slippagePerUnit?: number;
  /** Per-unit fee assumption (dollars, one side) folded into risk-per-unit. */
  feePerUnit?: number;
}

export interface SizingCalc {
  profile: PaperRiskProfile;
  equityDollars: number;
  costPerUnitDollars: number;      // entryPrice × multiplier
  riskBudgetDollars: number;       // equity × riskPerTradePct% × 0DTE haircut
  riskPerUnitDollars: number;      // stop loss + slippage + fees per unit
  byRisk: number;
  byPosition: number;
  byExposure: number;
  byTicker: number;
  byBuyingPower: number;
  byMaxContracts: number;
  bindingConstraint: string;       // which cap set the final size
  dailyLossCapReached: boolean;
}

export interface SizingResult {
  contracts: number;               // final size (0 when rejected)
  rejected: boolean;
  reason: string;
  calc: SizingCalc;
}

/**
 * Deterministic risk-based size. The final count is the FLOOR of the risk budget
 * divided by per-unit risk, then clamped by min() against every hard cap. It can
 * only ever be reduced by a cap, never raised past one. If not even the minimum
 * contract count fits inside the caps (or the daily-loss stop is hit), the trade
 * is rejected with the binding reason.
 */
export function sizePosition(input: SizingInput, cfg: PaperSizingConfig): SizingResult {
  const equity = input.equityDollars;
  const costPerUnit = input.entryPrice * input.multiplier;
  const stopFrac = input.stopLossPct == null ? 1 : Math.min(1, Math.max(0, input.stopLossPct / 100));
  const slip = (input.slippagePerUnit ?? 0) * input.multiplier;
  const fee = (input.feePerUnit ?? 0) * 2; // round-trip fee estimate per unit
  const riskPerUnit = costPerUnit * stopFrac + slip + fee;

  const zeroDteMult = input.isZeroDte ? Math.max(0, cfg.zeroDteRiskMultiplier) : 1;
  const riskBudget = equity * (cfg.riskPerTradePct / 100) * zeroDteMult;

  const dailyLossCap = equity * (cfg.maxDailyLossPct / 100);
  const dailyLossCapReached = input.realizedDailyLossDollars >= dailyLossCap && dailyLossCap > 0;

  const safeFloor = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const byRisk = riskPerUnit > 0 ? safeFloor(riskBudget / riskPerUnit) : 0;
  const byPosition = costPerUnit > 0 ? safeFloor((equity * cfg.maxPositionPct / 100) / costPerUnit) : 0;
  const byExposure = costPerUnit > 0 ? safeFloor((equity * cfg.maxTotalExposurePct / 100 - input.openExposureDollars) / costPerUnit) : 0;
  // Correlation guard: no single ticker may exceed one max-position worth of exposure.
  const byTicker = costPerUnit > 0 ? safeFloor((equity * cfg.maxPositionPct / 100 - input.openTickerExposureDollars) / costPerUnit) : 0;
  const byBuyingPower = costPerUnit > 0 ? safeFloor(input.availableBuyingPowerDollars / costPerUnit) : 0;
  const byMaxContracts = cfg.maxContractsPerTrade;

  const caps: Array<[string, number]> = [
    ["per-trade risk", byRisk],
    ["max position %", byPosition],
    ["max total exposure %", byExposure],
    ["per-ticker/correlation cap", byTicker],
    ["buying power", byBuyingPower],
    ["max contracts per trade", byMaxContracts],
  ];
  let contracts = caps.reduce((m, [, v]) => Math.min(m, v), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(contracts)) contracts = 0;
  contracts = Math.max(0, Math.floor(contracts));
  const binding = caps.filter(([, v]) => v === contracts).map(([k]) => k)[0] ?? "none";

  const calc: SizingCalc = {
    profile: cfg.profile,
    equityDollars: +equity.toFixed(2),
    costPerUnitDollars: +costPerUnit.toFixed(2),
    riskBudgetDollars: +riskBudget.toFixed(2),
    riskPerUnitDollars: +riskPerUnit.toFixed(2),
    byRisk, byPosition, byExposure, byTicker, byBuyingPower, byMaxContracts,
    bindingConstraint: binding,
    dailyLossCapReached,
  };

  if (!isNum(costPerUnit) || costPerUnit <= 0) {
    return { contracts: 0, rejected: true, reason: "invalid entry price — cannot size", calc };
  }
  if (dailyLossCapReached) {
    return { contracts: 0, rejected: true, reason: `daily loss cap reached (${cfg.maxDailyLossPct}% of equity) — no new entries`, calc };
  }
  if (contracts < cfg.minContractsPerTrade) {
    return {
      contracts: 0,
      rejected: true,
      reason: `cannot fit minimum ${cfg.minContractsPerTrade} contract(s) inside caps (binding: ${binding}) — would breach a hard limit`,
      calc,
    };
  }
  return { contracts, rejected: false, reason: `sized ${contracts} contract(s) on ${cfg.profile} profile (binding: ${binding})`, calc };
}
