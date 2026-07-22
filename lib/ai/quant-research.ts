export interface QuantCalculationInventoryItem {
  scanner: "stock" | "options" | "paper";
  name: string;
  unit: string;
  ownerFile: string;
  purpose: string;
  formula: string;
  currentThresholds: Record<string, number | string | boolean | null>;
  hardGates: string[];
  scores: string[];
}

export interface WeeklyQuantResearchContext {
  cadence: "weekly";
  aiRole: "offline_research_only";
  livePathAuthority: "deterministic_only";
  evidenceLearning: unknown;
  calculationInventory: QuantCalculationInventoryItem[];
  gateAttribution: string[];
  outcomeComparisons: Record<string, unknown>;
  thresholdExperimentEvidence: Record<string, unknown>[];
  gateTraceRequired: string[];
  experimentRules: string[];
  promotionRule: string;
}

const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);

export interface WeeklyQuantResearchOptions {
  env?: NodeJS.ProcessEnv;
  metrics?: Record<string, unknown>;
  evidenceLearning?: unknown;
}

function currentThresholds(env: NodeJS.ProcessEnv) {
  return {
    stock: {
      minPrice: num(env.STOCK_MOMENTUM_MIN_PRICE, 0.5),
      maxPrice: num(env.STOCK_MOMENTUM_MAX_PRICE, 50),
      minDayVolume: num(env.STOCK_MOMENTUM_MIN_DAY_VOLUME ?? env.SCANNER_DISCOVERY_MIN_VOLUME, 500_000),
      minGainFromPrevClosePct: num(env.STOCK_MOMENTUM_MIN_GAIN_FROM_PREV_CLOSE_PCT, 10),
      minRet10sPct: num(env.STOCK_FAST_MIN_RET_10S_PCT, 0.40),
      minRet30sPct: num(env.STOCK_FAST_MIN_RET_30S_PCT, 1.00),
      minRet60sPct: num(env.STOCK_FAST_MIN_RET_60S_PCT, 1.50),
      minVelocityPctPerMin: num(env.STOCK_FAST_MIN_VELOCITY_PCT_PER_MIN, 2.00),
      maxSpreadPct: num(env.STOCK_MAX_SPREAD_PCT, 1.5),
      maxQuoteAgeMs: num(env.STOCK_MAX_QUOTE_AGE_MS, 15_000),
      maxVwapExtensionPct: num(env.STOCK_MAX_VWAP_EXT_PCT, 2.5),
    },
    options: {
      entryMaxVwapDistPct: num(env.ENTRY_MAX_VWAP_DIST_PCT, 1.5),
      entryExtendedVwapDistPct: num(env.ENTRY_EXTENDED_VWAP_DIST_PCT, 3.0),
      entryMinRelVol: num(env.ENTRY_MIN_REL_VOL, 1.2),
      entryMaxSpreadPct: num(env.ENTRY_MAX_SPREAD_PCT, 8),
      optionsPutsEnabled: env.OPTIONS_PUTS_ENABLED !== "0" && env.OPTIONS_PUT_CALLOUTS !== "0",
      bearishStockActionable: env.BEARISH_ACTIONABLE === "1",
    },
    paper: {
      primaryStartingBalanceUsd: num(env.PAPER_STARTING_BALANCE_USD ?? env.PAPER_STARTING_BALANCE, 5000),
      challengeStartingBalanceUsd: num(env.PAPER_CHALLENGE_STARTING_BALANCE_USD, 10_000),
      challengeTargetUsd: num(env.PAPER_CHALLENGE_TARGET_USD, 100_000),
      challengeMaxPositionPct: num(env.PAPER_CHALLENGE_MAX_POSITION_PCT, 60),
      challengeMaxTotalExposurePct: num(env.PAPER_CHALLENGE_MAX_TOTAL_EXPOSURE_PCT ?? env.PAPER_MAX_TOTAL_EXPOSURE_PCT, 60),
      stockDayStartingBalanceUsd: num(env.PAPER_STOCK_DAY_STARTING_BALANCE_USD, 10_000),
    },
  };
}

export function weeklyQuantResearchContext(opts: WeeklyQuantResearchOptions = {}): WeeklyQuantResearchContext {
  const env = opts.env ?? process.env;
  const t = currentThresholds(env);
  return {
    cadence: "weekly",
    aiRole: "offline_research_only",
    livePathAuthority: "deterministic_only",
    evidenceLearning: opts.evidenceLearning ?? null,
    calculationInventory: [
      {
        scanner: "stock", name: "broadStockEligibility", unit: "dollars, shares, percent", ownerFile: "lib/stock-momentum-policy.ts",
        purpose: "price band, cumulative day volume, and prior-close gain floor",
        formula: "minPrice <= price <= maxPrice AND dayVolume >= minDayVolume AND gainFromPrevClosePct >= minGainFromPrevClosePct",
        currentThresholds: t.stock,
        hardGates: ["symbol", "price", "dayVolume", "gainFromPrevClosePct"],
        scores: [],
      },
      {
        scanner: "stock", name: "fastStockMomentumEligibility", unit: "percent returns, percent/min, shares/sec", ownerFile: "lib/stock-momentum-policy.ts",
        purpose: "current bullish momentum evidence for stock alerts",
        formula: "broadStockEligibility AND bullish direction AND fresh quote AND spread <= cap AND not VWAP-extended AND structureOk AND volumeOk AND ((ret10 >= floor AND ret30 >= floor AND velocity >= floor) OR exceptional velocity with any return)",
        currentThresholds: t.stock,
        hardGates: ["direction", "freshness", "spread", "vwap_extension", "classification", "structure", "volume_now", "fast_momentum"],
        scores: ["ret10sPct", "ret30sPct", "ret60sPct", "velocityPctPerMin", "volumeAcceleration"],
      },
      {
        scanner: "stock", name: "classifyStockMomentum", unit: "classifier labels", ownerFile: "lib/stock-momentum-classifier.ts",
        purpose: "suppress slow grinders, late exhaustion, and illiquid spikes",
        formula: "deterministic label from recent returns, extension, freshness, and spread; suppressed labels cannot enter Discord/paper",
        currentThresholds: t.stock,
        hardGates: ["SLOW_GRINDER", "LATE_EXHAUSTION", "NOISY_ILLIQUID_SPIKE"],
        scores: ["fresh acceleration", "continuation", "extension", "staleness"],
      },
      {
        scanner: "options", name: "contractEntryGate", unit: "spread percent, delta, DTE, premium economics", ownerFile: "lib/zero-dte.ts",
        purpose: "verified option contract tradability",
        formula: "two-sided quote AND spread <= cap AND delta in profile band AND DTE in horizon AND premium <= expected remaining move",
        currentThresholds: t.options,
        hardGates: ["twoSidedQuote", "spread", "delta", "dte", "premiumEconomics", "session"],
        scores: ["contractScore", "liquidityScore", "worthItScore"],
      },
      {
        scanner: "options", name: "nowOnlyActionable", unit: "gate verdict", ownerFile: "lib/callouts/eligibility.ts",
        purpose: "private options Discord and paper eligibility boundary",
        formula: "ACTIONABLE_NOW AND callout.actionable AND entryWindow == ACTIONABLE AND fresh two-sided quote AND risk allowed AND confidenceTier == HIGH",
        currentThresholds: t.options,
        hardGates: ["status", "actionable", "entryWindow", "twoSidedQuote", "quoteFreshness", "riskVerdict", "confidenceTier"],
        scores: ["confidenceTier"],
      },
      {
        scanner: "paper", name: "sizePosition", unit: "dollars, percent caps, contracts/shares", ownerFile: "lib/paper-position-sizer.ts",
        purpose: "deterministic paper sizing for portfolio experiments",
        formula: "floor(min(byRisk, byPosition, byExposure, byTicker, byBuyingPower, byMaxContracts)); reject below minimum or daily-loss cap",
        currentThresholds: t.paper,
        hardGates: ["dailyLossCap", "minContractsPerTrade", "buyingPower", "maxPositionPct", "maxTotalExposurePct"],
        scores: ["bindingConstraint", "riskBudgetDollars", "riskPerUnitDollars"],
      },
    ],
    gateAttribution: [
      "Every accepted setup must retain the exact gate path that allowed it.",
      "Every rejected setup must retain the first hard gate and reason that blocked it.",
      "Compare accepted versus rejected candidates by entryState, confidenceTier, direction, and rejection reason.",
      "Split calls versus puts; do not use bullish call outcomes as bearish put evidence.",
      "Split stock sessions: premarket, regular, afterhours.",
      "Split portfolios: PRIMARY, CHALLENGE, STOCK_DAY_TRADER.",
      "Separate entry quality from exit quality: opportunity HIT with realized LOSS/BREAKEVEN is an exit-management problem.",
    ],
    outcomeComparisons: opts.metrics ?? {},
    thresholdExperimentEvidence: [
      {
        name: "baseline_current_policy",
        source: "deterministic weekly summary",
        metricsRequired: ["sampleSize", "winRate", "avgReturnPct", "opportunityHitRate", "rejectionCounts", "entryVsExitBreakdown"],
        challenger: null,
        rule: "No challenger can be recommended unless deterministic replay/shadow metrics are calculated first.",
      },
      {
        name: "threshold_challenger",
        source: "future deterministic replay or shadow run",
        metricsRequired: ["same frozen input sample as baseline", "acceptedCount", "rejectedCount", "deltaWinRate", "deltaOpportunityHitRate", "deltaDrawdownOrLossRate"],
        challenger: null,
        rule: "AI may interpret challenger evidence only after the deterministic layer computes it.",
      },
    ],
    gateTraceRequired: [
      "record pass/fail reason for each deterministic setup gate",
      "preserve units for thresholds and observed values",
      "separate stock, primary options, challenge, and stock-day portfolios",
      "compare accepted versus rejected candidates before proposing a threshold change",
      "compare baseline versus challenger metrics before recommending promotion",
      "never infer missing quotes, fills, greeks, volume, or open interest",
    ],
    experimentRules: [
      "baseline and challenger must run side by side on the same frozen deterministic inputs",
      "challenger proposals must include required tests, shadow or replay plan, rollback plan, and evidence threshold",
      "AI proposals remain pending until human approval promotes a deterministic change",
      "AI must not paste source code; it receives structured metrics, formulas, units, thresholds, and curated file names only",
    ],
    promotionRule: "AI may propose threshold experiments weekly, but only deterministic code/config with tests can be promoted after human approval.",
  };
}
