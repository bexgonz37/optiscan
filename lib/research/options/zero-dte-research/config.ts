/**
 * Aggressive 0DTE Research — config (flag-gated, defaults safe/off).
 * Does not alter Discord delivery or subscriber quality bars.
 */

export type ResearchTier = "R0" | "R1" | "R2";

export type ExitPolicyVersion =
  | "fixed_r"
  | "t1_runner"
  | "time"
  | "vwap_inv"
  | "underlying_inv"
  | "premium_loss"
  | "trail_after_t1"
  | "eod_force";

export interface ZeroDteResearchConfig {
  enabled: boolean;
  startingBalanceUsd: number;
  qualityBar: number;
  maxOpenTrades: number;
  maxTradesPerDay: number;
  maxPerSymbol: number;
  maxSpyPerDay: number;
  maxQqqPerDay: number;
  riskPct: number;
  maxOpenRiskPct: number;
  maxExposurePct: number;
  tier0IntervalMs: number;
  tier1IntervalMs: number;
  tier2IntervalMs: number;
  providerBudgetPerMinute: number;
  exitPolicies: ExitPolicyVersion[];
  contractExperiment: "primary_only" | "alts_logged";
  universe: { R0: string[]; R1: string[]; R2: string[] };
}

const n = (v: string | undefined, d: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

const DEFAULT_UNIVERSE = {
  R0: ["SPY", "QQQ"],
  R1: ["IWM", "DIA", "NVDA", "AAPL", "TSLA"],
  R2: ["AMD", "META", "MSFT", "AMZN"],
};

const ALL_POLICIES: ExitPolicyVersion[] = [
  "fixed_r", "t1_runner", "time", "vwap_inv", "underlying_inv", "premium_loss", "trail_after_t1", "eod_force",
];

export function zeroDteResearchConfig(env: NodeJS.ProcessEnv = process.env): ZeroDteResearchConfig {
  const policiesRaw = String(env.PAPER_0DTE_EXIT_POLICIES ?? "fixed_r,t1_runner,time,vwap_inv,eod_force")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean) as ExitPolicyVersion[];
  const policies = policiesRaw.filter((p) => ALL_POLICIES.includes(p));
  const override = String(env.PAPER_0DTE_UNIVERSE ?? "").trim();
  let universe = DEFAULT_UNIVERSE;
  if (override) {
    const all = override.split(/[,;\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    universe = {
      R0: all.filter((s) => DEFAULT_UNIVERSE.R0.includes(s)),
      R1: all.filter((s) => DEFAULT_UNIVERSE.R1.includes(s)),
      R2: all.filter((s) => DEFAULT_UNIVERSE.R2.includes(s)),
    };
    if (universe.R0.length === 0) universe = DEFAULT_UNIVERSE;
  }
  const experiment = String(env.PAPER_0DTE_CONTRACT_EXPERIMENT ?? "primary_only").trim();
  return {
    enabled: env.PAPER_0DTE_RESEARCH_ENABLED === "1",
    startingBalanceUsd: n(env.PAPER_0DTE_STARTING_BALANCE_USD, 100_000),
    qualityBar: n(env.PAPER_0DTE_QUALITY_BAR, 0.55),
    maxOpenTrades: n(env.PAPER_0DTE_MAX_OPEN_TRADES, 10),
    maxTradesPerDay: n(env.PAPER_0DTE_MAX_TRADES_PER_DAY, 30),
    maxPerSymbol: n(env.PAPER_0DTE_MAX_PER_SYMBOL, 5),
    maxSpyPerDay: n(env.PAPER_0DTE_MAX_SPY_PER_DAY, 5),
    maxQqqPerDay: n(env.PAPER_0DTE_MAX_QQQ_PER_DAY, 5),
    riskPct: n(env.PAPER_0DTE_RISK_PCT, 0.75),
    maxOpenRiskPct: n(env.PAPER_0DTE_MAX_OPEN_RISK_PCT, 5),
    maxExposurePct: n(env.PAPER_0DTE_MAX_EXPOSURE_PCT, 30),
    tier0IntervalMs: Math.max(3000, n(env.PAPER_0DTE_TIER0_INTERVAL_MS, 5000)),
    tier1IntervalMs: Math.max(8000, n(env.PAPER_0DTE_TIER1_INTERVAL_MS, 12000)),
    tier2IntervalMs: Math.max(20000, n(env.PAPER_0DTE_TIER2_INTERVAL_MS, 45000)),
    providerBudgetPerMinute: n(env.PAPER_0DTE_PROVIDER_BUDGET_PER_MINUTE, 80),
    exitPolicies: policies.length ? policies : ["fixed_r", "t1_runner", "time", "vwap_inv", "eod_force"],
    contractExperiment: experiment === "alts_logged" ? "alts_logged" : "primary_only",
    universe,
  };
}

export function tierForSymbol(symbol: string, cfg: ZeroDteResearchConfig = zeroDteResearchConfig()): ResearchTier | null {
  const s = symbol.toUpperCase();
  if (cfg.universe.R0.includes(s)) return "R0";
  if (cfg.universe.R1.includes(s)) return "R1";
  if (cfg.universe.R2.includes(s)) return "R2";
  return null;
}

export function intervalForTier(tier: ResearchTier, cfg: ZeroDteResearchConfig): number {
  if (tier === "R0") return cfg.tier0IntervalMs;
  if (tier === "R1") return cfg.tier1IntervalMs;
  return cfg.tier2IntervalMs;
}
