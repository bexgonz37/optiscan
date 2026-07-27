/**

 * Static demo callouts for UI review screenshots only.

 * Shown when isUiReviewMode() — never injected in production.

 */

export type DemoCallout = {

  key: string;

  status: string;

  ticker: string;

  direction: "bullish" | "bearish";

  strategyAgent: string;

  horizon: string;

  reason: string;

  contract: {

    optionSymbol: string;

    strike: number;

    expiration: string;

    dte: number;

    side: string;

    bid: number;

    ask: number;

    mid: number;

    spreadPct: number;

    delta: number;

    iv: number;

    volume: number;

    openInterest: number;

  };

  underlyingPrice: number;

  confidenceTier: "HIGH" | "MEDIUM" | "LOW";

  estimatedEntry: number | null;

  entryStatusLabel: string;

  quoteFreshness: string;

  contractScore: number;

  portfolioRank?: number | null;

  evidenceStatus: string;

  sampleSize: number;

  modelState: string;

  probability: number | null;

  actionable: boolean;

  waitFor: string | null;

  doNotEnter: string | null;

  currently: string | null;

  alreadyHappened: string | null;

  researchOnlyWarning: string | null;

  insufficientEvidenceWarning: string | null;

  primaryBlockingReason: string | null;

  demo: true;

};

/** Six curated setups: 2 SEND · 2 WATCH · 1 RESEARCH · 1 BLOCK */

export const DEMO_CALLOUTS: DemoCallout[] = [

  {

    key: "demo-spy-0dte-send",

    status: "ACTIONABLE_NOW",

    ticker: "SPY",

    direction: "bullish",

    strategyAgent: "momentum_acceleration",

    horizon: "0DTE",

    reason: "Opening-range breakout with volume surge; contract passes spread and delta gates.",

    contract: {

      optionSymbol: "O:SPY260727C00635000",

      strike: 635,

      expiration: "2026-07-27",

      dte: 0,

      side: "call",

      bid: 1.18,

      ask: 1.28,

      mid: 1.23,

      spreadPct: 7.6,

      delta: 0.52,

      iv: 0.19,

      volume: 4200,

      openInterest: 12000,

    },

    underlyingPrice: 634.82,

    confidenceTier: "HIGH",

    estimatedEntry: 1.23,

    entryStatusLabel: "ACTIONABLE NOW",

    quoteFreshness: "fresh",

    contractScore: 91,

    portfolioRank: 1.1,

    evidenceStatus: "SUFFICIENT",

    sampleSize: 42,

    modelState: "CALIBRATED",

    probability: null,

    actionable: true,

    waitFor: null,

    doNotEnter: "Do not chase if mid exceeds $1.45 without new high.",

    currently: "Price holding above ORB high with positive tape.",

    alreadyHappened: "First 15m range established; breakout confirmed.",

    researchOnlyWarning: null,

    insufficientEvidenceWarning: null,

    primaryBlockingReason: null,

    demo: true,

  },

  {

    key: "demo-nvda-0dte-send",

    status: "ACTIONABLE_NOW",

    ticker: "NVDA",

    direction: "bullish",

    strategyAgent: "vwap_reclaim",

    horizon: "0DTE",

    reason: "Semiconductor leader reclaiming VWAP with tight spreads and rising delta.",

    contract: {

      optionSymbol: "O:NVDA260727C00178000",

      strike: 178,

      expiration: "2026-07-27",

      dte: 0,

      side: "call",

      bid: 2.44,

      ask: 2.58,

      mid: 2.51,

      spreadPct: 5.4,

      delta: 0.47,

      iv: 0.32,

      volume: 6800,

      openInterest: 15400,

    },

    underlyingPrice: 177.62,

    confidenceTier: "HIGH",

    estimatedEntry: 2.51,

    entryStatusLabel: "ACTIONABLE NOW",

    quoteFreshness: "fresh",

    contractScore: 84,

    portfolioRank: 1.8,

    evidenceStatus: "SUFFICIENT",

    sampleSize: 36,

    modelState: "CALIBRATED",

    probability: null,

    actionable: true,

    waitFor: null,

    doNotEnter: "Skip if underlying loses VWAP on a 5m close.",

    currently: "VWAP held on retest; volume picking up into midday.",

    alreadyHappened: "Morning dip rejected at prior-day POC.",

    researchOnlyWarning: null,

    insufficientEvidenceWarning: null,

    primaryBlockingReason: null,

    demo: true,

  },

  {

    key: "demo-qqq-watch",

    status: "NEAR_TRIGGER",

    ticker: "QQQ",

    direction: "bullish",

    strategyAgent: "vwap_reclaim",

    horizon: "0DTE",

    reason: "VWAP reclaim developing — WATCH until mid holds above reclaim level.",

    contract: {

      optionSymbol: "O:QQQ260727C00568000",

      strike: 568,

      expiration: "2026-07-27",

      dte: 0,

      side: "call",

      bid: 0.92,

      ask: 1.02,

      mid: 0.97,

      spreadPct: 9.8,

      delta: 0.48,

      iv: 0.21,

      volume: 2100,

      openInterest: 8500,

    },

    underlyingPrice: 567.45,

    confidenceTier: "MEDIUM",

    estimatedEntry: 0.97,

    entryStatusLabel: "WAIT FOR PULLBACK",

    quoteFreshness: "fresh",

    contractScore: 72,

    portfolioRank: 2.4,

    evidenceStatus: "BUILDING",

    sampleSize: 18,

    modelState: "WATCH",

    probability: null,

    actionable: false,

    waitFor: "Hold above VWAP for 2 consecutive 1m bars.",

    doNotEnter: "Spread widens past 12%.",

    currently: "Testing VWAP from below.",

    alreadyHappened: "Morning selloff rejected at prior low.",

    researchOnlyWarning: null,

    insufficientEvidenceWarning: "Sample still building for this family.",

    primaryBlockingReason: null,

    demo: true,

  },

  {

    key: "demo-meta-watch",

    status: "DEVELOPING",

    ticker: "META",

    direction: "bullish",

    strategyAgent: "range_breakout",

    horizon: "1-5",

    reason: "Weekly call developing — needs hold above prior-day high before entry.",

    contract: {

      optionSymbol: "O:META260801C00720000",

      strike: 720,

      expiration: "2026-08-01",

      dte: 4,

      side: "call",

      bid: 4.10,

      ask: 4.35,

      mid: 4.22,

      spreadPct: 5.7,

      delta: 0.41,

      iv: 0.28,

      volume: 980,

      openInterest: 4200,

    },

    underlyingPrice: 718.9,

    confidenceTier: "MEDIUM",

    estimatedEntry: 4.22,

    entryStatusLabel: "NEAR TRIGGER",

    quoteFreshness: "fresh",

    contractScore: 68,

    portfolioRank: 3.1,

    evidenceStatus: "BUILDING",

    sampleSize: 22,

    modelState: "WATCH",

    probability: null,

    actionable: false,

    waitFor: "Close above $719.50 on 15m bar.",

    doNotEnter: "Avoid if IV rank spikes above 80.",

    currently: "Coiling under resistance with rising call volume.",

    alreadyHappened: "Base formed over two sessions.",

    researchOnlyWarning: null,

    insufficientEvidenceWarning: null,

    primaryBlockingReason: null,

    demo: true,

  },

  {

    key: "demo-tsla-research",

    status: "RESEARCH_ONLY",

    ticker: "TSLA",

    direction: "bearish",

    strategyAgent: "failed_breakout_reversal",

    horizon: "0DTE",

    reason: "Put research lane — reversal pattern under prior high; not subscriber delivery.",

    contract: {

      optionSymbol: "O:TSLA260727P00320000",

      strike: 320,

      expiration: "2026-07-27",

      dte: 0,

      side: "put",

      bid: 1.85,

      ask: 2.05,

      mid: 1.95,

      spreadPct: 9.7,

      delta: -0.38,

      iv: 0.45,

      volume: 3100,

      openInterest: 9100,

    },

    underlyingPrice: 321.4,

    confidenceTier: "MEDIUM",

    estimatedEntry: 1.95,

    entryStatusLabel: "RESEARCH ONLY",

    quoteFreshness: "fresh",

    contractScore: 61,

    portfolioRank: null,

    evidenceStatus: "EXPERIMENTAL",

    sampleSize: 11,

    modelState: "RESEARCH",

    probability: null,

    actionable: false,

    waitFor: "Confirm rejection wick on 5m chart.",

    doNotEnter: "Not for live Discord delivery.",

    currently: "Testing breakdown of opening range low.",

    alreadyHappened: "Failed breakout at pre-market high.",

    researchOnlyWarning: "Put research lane — not subscriber delivery.",

    insufficientEvidenceWarning: "Experimental sample — monitor only.",

    primaryBlockingReason: null,

    demo: true,

  },

  {

    key: "demo-amd-block",

    status: "BLOCKED",

    ticker: "AMD",

    direction: "bullish",

    strategyAgent: "momentum_acceleration",

    horizon: "0DTE",

    reason: "Setup blocked — spread too wide for executable entry.",

    contract: {

      optionSymbol: "O:AMD260727C00165000",

      strike: 165,

      expiration: "2026-07-27",

      dte: 0,

      side: "call",

      bid: 0.55,

      ask: 0.82,

      mid: 0.68,

      spreadPct: 32.4,

      delta: 0.39,

      iv: 0.38,

      volume: 620,

      openInterest: 2800,

    },

    underlyingPrice: 164.72,

    confidenceTier: "LOW",

    estimatedEntry: null,

    entryStatusLabel: "NO VALID ENTRY",

    quoteFreshness: "stale",

    contractScore: 48,

    portfolioRank: null,

    evidenceStatus: "INSUFFICIENT",

    sampleSize: 6,

    modelState: "BLOCKED",

    probability: null,

    actionable: false,

    waitFor: null,

    doNotEnter: "Do not enter wide-spread contracts.",

    currently: "Momentum signal present but liquidity poor.",

    alreadyHappened: null,

    researchOnlyWarning: null,

    insufficientEvidenceWarning: null,

    primaryBlockingReason: "spread_too_wide",

    demo: true,

  },

];



/** Review-only note — never shown in production. */

export const DEMO_CALLOUTS_NOTE =

  "UI review — seeded demo hierarchy (2 SEND · 2 WATCH · 1 RESEARCH · 1 BLOCK).";



/** Strip supervisor/legacy routing notes from trader-facing Live Options. */

export function isSupervisorRoutingNote(note: string): boolean {

  return /supervisor discord delivery|supervisor is the canonical|CALLOUT_CANONICAL_PATH|desktop is the active channel/i.test(

    note,

  );

}


