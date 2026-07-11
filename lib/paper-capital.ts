/**
 * paper-capital.ts — buying-power + exposure protections (rebuild, PURE).
 *
 * Composes WITH lib/paper-risk.ts (which stays the per-trade risk authority).
 * This module owns the capital-level guards the old engine lacked: available
 * buying power vs equity, max position dollars, max concurrent positions,
 * duplicate CONTRACT exposure, per-strategy daily entry caps, and hard guards
 * against zero / negative / null / NaN / infinite inputs.
 *
 * No I/O, no clock in the output. The engine assembles the context from the DB.
 */

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface CapitalConfig {
  startingBalance: number;
  /** Fraction of equity that may be committed to open positions (0–1). */
  maxBuyingPowerUtilization: number;
  /** Max cost basis for a single new position (dollars). */
  maxPositionDollars: number;
  /** Max simultaneously open positions. */
  maxConcurrentPositions: number;
  /** Max new entries per strategy per trading day. */
  maxPerStrategyDailyEntries: number;
}

export function defaultCapitalConfig(env: NodeJS.ProcessEnv = process.env): CapitalConfig {
  const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    startingBalance: num(env.PAPER_STARTING_BALANCE, 5000),
    maxBuyingPowerUtilization: Math.max(0, Math.min(1, num(env.PAPER_MAX_BP_UTILIZATION, 1))),
    maxPositionDollars: num(env.PAPER_MAX_POSITION_DOLLARS, 2000),
    maxConcurrentPositions: num(env.PAPER_MAX_CONCURRENT_POSITIONS, 5),
    maxPerStrategyDailyEntries: num(env.PAPER_MAX_STRATEGY_DAILY_ENTRIES, 10),
  };
}

export interface CapitalContext {
  /** startingBalance + realized P/L. */
  equityDollars: number;
  /** Sum of open-position cost basis (dollars already committed). */
  reservedOpenDollars: number;
  /** Count of currently open positions. */
  openPositions: number;
  /** Open contract identifiers (option symbols) to block duplicate exposure. */
  openContractSymbols: ReadonlySet<string>;
  /** Entries already made today for the proposed strategy. */
  todayStrategyEntries: number;
}

export interface CapitalProposal {
  ticker: string;
  optionSymbol: string | null;
  strategy: string;
  /** Total cost basis of the proposed position in dollars (premium×100×contracts, or price×shares). */
  costDollars: number;
  units: number;
}

export interface CapitalVerdict {
  allowed: boolean;
  failures: string[];
  buyingPowerRemaining: number;
}

export function checkCapital(
  proposed: CapitalProposal,
  ctx: CapitalContext,
  cfg: CapitalConfig = defaultCapitalConfig(),
): CapitalVerdict {
  const failures: string[] = [];

  // Numeric sanity — reject anything not a clean positive number outright.
  if (!finite(proposed.costDollars) || proposed.costDollars <= 0) {
    failures.push(`invalid position cost (${String(proposed.costDollars)}) — must be a positive number`);
  }
  if (!finite(proposed.units) || proposed.units <= 0) {
    failures.push(`invalid unit count (${String(proposed.units)})`);
  }
  // With a broken cost we cannot reason about capital — stop here.
  if (failures.length) return { allowed: false, failures, buyingPowerRemaining: 0 };

  const buyingPower = Math.max(0, cfg.startingBalance + (ctx.equityDollars - cfg.startingBalance)) * cfg.maxBuyingPowerUtilization;
  const available = +(buyingPower - ctx.reservedOpenDollars).toFixed(2);

  if (proposed.costDollars > available) {
    failures.push(`insufficient buying power: cost $${proposed.costDollars.toFixed(0)} > available $${available.toFixed(0)}`);
  }
  if (proposed.costDollars > cfg.maxPositionDollars) {
    failures.push(`position $${proposed.costDollars.toFixed(0)} exceeds max position size $${cfg.maxPositionDollars}`);
  }
  if (ctx.openPositions >= cfg.maxConcurrentPositions) {
    failures.push(`already ${ctx.openPositions} open positions (max ${cfg.maxConcurrentPositions})`);
  }
  if (proposed.optionSymbol && ctx.openContractSymbols.has(proposed.optionSymbol)) {
    failures.push(`duplicate contract exposure: ${proposed.optionSymbol} is already open`);
  }
  if (ctx.todayStrategyEntries >= cfg.maxPerStrategyDailyEntries) {
    failures.push(`strategy "${proposed.strategy}" hit ${cfg.maxPerStrategyDailyEntries} entries today`);
  }

  return { allowed: failures.length === 0, failures, buyingPowerRemaining: +(available - proposed.costDollars).toFixed(2) };
}
