/**
 * Estimated Massive/Polygon request budget for OptiScan lanes.
 * Soft guidance for ops — not a hard enforcer. UI/content/AI must not add
 * independent per-card refetches; they consume canonical snapshots.
 */

export interface BudgetLane {
  lane: string;
  priority: number;
  symbols: string[];
  intervalMs: number;
  estUnderlyingPerMin: number;
  estChainPerMin: number;
  notes: string;
}

export interface ProviderBudgetEstimate {
  generatedAtMs: number;
  provider: "massive_polygon";
  priorities: { liveScanner: 1; grading: 2; uiCharts: 3; contentAi: 4 };
  lanes: BudgetLane[];
  totals: {
    estUnderlyingPerMin: number;
    estChainPerMin: number;
    softCapSubscriberTier0: number;
    softCapZeroDteResearch: number;
  };
  rules: string[];
}

function n(env: NodeJS.ProcessEnv, key: string, d: number): number {
  const x = Number(env[key]);
  return Number.isFinite(x) ? x : d;
}

export function estimateMassiveRequestBudget(env: NodeJS.ProcessEnv = process.env): ProviderBudgetEstimate {
  const t0 = Math.max(3000, n(env, "OPTIONS_TIER0_INTERVAL_MS", 5000));
  const t1 = Math.max(8000, n(env, "OPTIONS_TIER1_INTERVAL_MS", 12000));
  const t2 = Math.max(20000, n(env, "OPTIONS_TIER2_INTERVAL_MS", 45000));
  const r0 = Math.max(3000, n(env, "PAPER_0DTE_TIER0_INTERVAL_MS", 5000));
  const r1 = Math.max(8000, n(env, "PAPER_0DTE_TIER1_INTERVAL_MS", 12000));
  const r2 = Math.max(20000, n(env, "PAPER_0DTE_TIER2_INTERVAL_MS", 45000));
  const subCap = n(env, "OPTIONS_TIER0_PROVIDER_BUDGET_PER_MINUTE", 60);
  const zdCap = n(env, "PAPER_0DTE_PROVIDER_BUDGET_PER_MINUTE", 80);
  const gradeOpen = n(env, "OPTIONS_GRADE_OPEN_BUDGET_PER_MINUTE", 40);
  const uiRefreshSec = 10;

  const perMin = (symbols: number, intervalMs: number) =>
    +(symbols * (60_000 / intervalMs)).toFixed(2);

  // Underlying snaps are heavily cached (market-snap TTL); chain only on trigger.
  const lanes: BudgetLane[] = [
    {
      lane: "subscriber_tier0_spy_qqq",
      priority: 1,
      symbols: ["SPY", "QQQ"],
      intervalMs: t0,
      estUnderlyingPerMin: perMin(2, t0),
      estChainPerMin: +(perMin(2, t0) * 0.25).toFixed(2),
      notes: "Highest priority. Shared __optiscanMarketSnap cache. Chain coalesced; Stage-2 only after score pass.",
    },
    {
      lane: "subscriber_tier1",
      priority: 1,
      symbols: ["IWM", "DIA", "NVDA", "AAPL", "TSLA"],
      intervalMs: t1,
      estUnderlyingPerMin: perMin(5, t1),
      estChainPerMin: +(perMin(5, t1) * 0.2).toFixed(2),
      notes: "Live scanner priority shared with Tier0.",
    },
    {
      lane: "subscriber_tier2",
      priority: 1,
      symbols: ["AMD", "META", "MSFT", "AMZN"],
      intervalMs: t2,
      estUnderlyingPerMin: perMin(4, t2),
      estChainPerMin: +(perMin(4, t2) * 0.15).toFixed(2),
      notes: "Lower cadence; never steals Tier0 headroom.",
    },
    {
      lane: "open_position_grading",
      priority: 2,
      symbols: ["open_contracts"],
      intervalMs: 15_000,
      estUnderlyingPerMin: 0,
      estChainPerMin: 0,
      notes: `Est. ~${gradeOpen} quote marks/min soft budget. Second priority after live scanner.`,
    },
    {
      lane: "zero_dte_research_r0",
      priority: 1,
      symbols: ["SPY", "QQQ"],
      intervalMs: r0,
      estUnderlyingPerMin: env.PAPER_0DTE_RESEARCH_ENABLED === "1" ? perMin(2, r0) : 0,
      estChainPerMin: env.PAPER_0DTE_RESEARCH_ENABLED === "1" ? +(perMin(2, r0) * 0.2).toFixed(2) : 0,
      notes: "Flag-gated. Shares market-snap/bars cache with subscriber; dedicated soft cap.",
    },
    {
      lane: "zero_dte_research_r1_r2",
      priority: 1,
      symbols: ["IWM", "DIA", "NVDA", "AAPL", "TSLA", "AMD", "META", "MSFT", "AMZN"],
      intervalMs: r1,
      estUnderlyingPerMin: env.PAPER_0DTE_RESEARCH_ENABLED === "1" ? +(perMin(5, r1) + perMin(4, r2)).toFixed(2) : 0,
      estChainPerMin: env.PAPER_0DTE_RESEARCH_ENABLED === "1" ? +((perMin(5, r1) + perMin(4, r2)) * 0.15).toFixed(2) : 0,
      notes: "Research only when enabled; never Discord.",
    },
    {
      lane: "ui_refreshes",
      priority: 3,
      symbols: ["canonical_snapshots"],
      intervalMs: uiRefreshSec * 1000,
      estUnderlyingPerMin: 0,
      estChainPerMin: 0,
      notes: "Command Center / Quant Lab / Paper poll canonical APIs only — no per-card Massive refetch.",
    },
    {
      lane: "historical_analytics",
      priority: 4,
      symbols: ["sqlite"],
      intervalMs: 0,
      estUnderlyingPerMin: 0,
      estChainPerMin: 0,
      notes: "Quant Lab & equity curves read persisted paper/marks. Content/AI must not create Massive calls.",
    },
  ];

  const totals = {
    estUnderlyingPerMin: +lanes.reduce((s, l) => s + l.estUnderlyingPerMin, 0).toFixed(2),
    estChainPerMin: +lanes.reduce((s, l) => s + l.estChainPerMin, 0).toFixed(2),
    softCapSubscriberTier0: subCap,
    softCapZeroDteResearch: zdCap,
  };

  return {
    generatedAtMs: Date.now(),
    provider: "massive_polygon",
    priorities: { liveScanner: 1, grading: 2, uiCharts: 3, contentAi: 4 },
    lanes,
    totals,
    rules: [
      "Shared quote and chain cache; coalesce identical in-flight requests",
      "Live scanner Tier0 SPY/QQQ highest priority",
      "Grading second; UI charts use persisted/cached data",
      "Content and AI jobs must not create unnecessary Massive calls",
      "Missing data shown as unavailable — never fabricated",
      "Rate-limit / backoff must not stop Tier0 SPY/QQQ unless provider unavailable",
      "Do not expose or redistribute raw vendor data outside permitted use",
    ],
  };
}
