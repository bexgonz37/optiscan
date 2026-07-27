/**
 * Seeded NOW-page fixtures for UI review screenshots only.
 * Never injected unless isUiReviewMode().
 */
import { heroTitleForMode, resolveOperatingMode, reviewSessionFromMode, type OperatingMode } from "./operating-mode.ts";
import type { DecisionState } from "./setup-decision.ts";

export interface NowSetupCard {
  key: string;
  rank: number;
  symbol: string;
  side: "call" | "put";
  state: DecisionState;
  trigger: string;
  entryZone: number | null;
  preferredStructure: string;
  t1: number | null;
  stop: number | null;
  confidence: number;
  reason: string;
  mainRisk: string;
  freshness: string;
  quantSampleSize: number;
  confirmationNeeded: string | null;
  contract: string | null;
  verifyContractAfterOpen: boolean;
  whyFirst?: string;
  href: string;
}

export interface NowOpenPosition {
  alertId: string;
  symbol: string;
  side: string;
  optionSymbol: string;
  status: string;
  returnPct: number;
  mfePct: number;
  maePct: number;
  ageLabel: string;
}

export interface NowReviewSnapshot {
  operatingMode: OperatingMode;
  operatingLabel: string;
  operatingDetail: string;
  heroTitle: string;
  setups: NowSetupCard[];
  openPositions: NowOpenPosition[];
}

function baseSetups(mode: OperatingMode): NowSetupCard[] {
  const closed = mode !== "REGULAR_SESSION_LIVE";
  return [
    {
      key: "demo-spy-trade",
      rank: 1,
      symbol: "SPY",
      side: "call",
      state: closed ? "TOMORROW" : "TRADE_NOW",
      trigger: "Hold above 634.50",
      entryZone: closed ? null : 1.23,
      preferredStructure: "0DTE ATM call",
      t1: closed ? null : 1.66,
      stop: closed ? null : 0.89,
      confidence: 88,
      reason: "ORB breakout with volume surge; spread and delta gates pass.",
      mainRisk: "Do not chase if mid exceeds $1.45 without new high.",
      freshness: closed ? "STALE · PRIOR SESSION" : "fresh · 8s",
      quantSampleSize: 42,
      confirmationNeeded: null,
      contract: closed ? null : "O:SPY260727C00635000",
      verifyContractAfterOpen: closed,
      whyFirst: closed
        ? "Highest confidence next-session plan with clear trigger and prior-day structure."
        : "Highest action score with fresh executable quote and READY contract.",
      href: "/callouts",
    },
    {
      key: "demo-nvda-almost",
      rank: 2,
      symbol: "NVDA",
      side: "call",
      state: closed ? "TOMORROW" : "ALMOST_READY",
      trigger: "Hold VWAP 177.20",
      entryZone: closed ? null : 2.51,
      preferredStructure: "0DTE near-ATM call",
      t1: closed ? null : 3.39,
      stop: closed ? null : 1.81,
      confidence: 76,
      reason: "VWAP reclaim developing — needs one confirmation bar.",
      mainRisk: "Skip if underlying loses VWAP on a 5m close.",
      freshness: closed ? "STALE · PRIOR SESSION" : "fresh · 22s",
      quantSampleSize: 36,
      confirmationNeeded: closed ? null : "Hold above VWAP for 2 consecutive 1m bars",
      contract: closed ? null : "O:NVDA260727C00178000",
      verifyContractAfterOpen: closed,
      href: "/callouts",
    },
    {
      key: "demo-qqq-tomorrow",
      rank: 3,
      symbol: "QQQ",
      side: "call",
      state: "TOMORROW",
      trigger: "Break and hold 568.00",
      entryZone: null,
      preferredStructure: "0–5 DTE ATM/OTM call",
      t1: null,
      stop: null,
      confidence: 71,
      reason: "Prior-day resistance retest; plan for next regular session.",
      mainRisk: "Gap through trigger without pullback invalidates structure.",
      freshness: "STALE · PRIOR SESSION",
      quantSampleSize: 28,
      confirmationNeeded: null,
      contract: null,
      verifyContractAfterOpen: true,
      href: "/callouts",
    },
    {
      key: "demo-meta-tomorrow",
      rank: 4,
      symbol: "META",
      side: "call",
      state: "TOMORROW",
      trigger: "Close above 719.50",
      entryZone: null,
      preferredStructure: "1–5 DTE ATM call",
      t1: null,
      stop: null,
      confidence: 64,
      reason: "Weekly base under resistance — watchlist only.",
      mainRisk: "IV spike above 80 makes premium expensive.",
      freshness: "STALE · PRIOR SESSION",
      quantSampleSize: 22,
      confirmationNeeded: null,
      contract: null,
      verifyContractAfterOpen: true,
      href: "/callouts",
    },
    {
      key: "demo-amd-avoid",
      rank: 5,
      symbol: "AMD",
      side: "call",
      state: "AVOID",
      trigger: "—",
      entryZone: null,
      preferredStructure: "—",
      t1: null,
      stop: null,
      confidence: 38,
      reason: "Spread too wide for executable entry.",
      mainRisk: "Do not enter wide-spread contracts.",
      freshness: "stale",
      quantSampleSize: 6,
      confirmationNeeded: null,
      contract: null,
      verifyContractAfterOpen: true,
      href: "/callouts",
    },
    {
      key: "demo-tsla-avoid",
      rank: 6,
      symbol: "TSLA",
      side: "put",
      state: "AVOID",
      trigger: "—",
      entryZone: null,
      preferredStructure: "research put only",
      t1: null,
      stop: null,
      confidence: 52,
      reason: "Put research lane — not subscriber delivery.",
      mainRisk: "Experimental sample — monitor only.",
      freshness: closed ? "STALE · PRIOR SESSION" : "fresh",
      quantSampleSize: 11,
      confirmationNeeded: null,
      contract: null,
      verifyContractAfterOpen: true,
      href: "/callouts",
    },
  ];
}

const POSITIONS: NowOpenPosition[] = [
  {
    alertId: "demo-pos-1",
    symbol: "SPY",
    side: "call",
    optionSymbol: "O:SPY260727C00634000",
    status: "CONFIRMED",
    returnPct: 4.2,
    mfePct: 9.1,
    maePct: -2.4,
    ageLabel: "42m",
  },
];

export function buildNowReviewSnapshot(mode: OperatingMode): NowReviewSnapshot {
  const operating = resolveOperatingMode({ sessionOverride: reviewSessionFromMode(mode) });
  return {
    operatingMode: operating.mode,
    operatingLabel: operating.label,
    operatingDetail: operating.detail,
    heroTitle: heroTitleForMode(operating.mode),
    setups: baseSetups(mode),
    openPositions: POSITIONS,
  };
}

export function modeFromReviewSession(session: string | null): OperatingMode {
  switch (session) {
    case "regular":
      return "REGULAR_SESSION_LIVE";
    case "premarket":
      return "PREMARKET_RESEARCH";
    case "afterhours":
      return "AFTER_HOURS_RESEARCH";
    case "weekend":
      return "WEEKEND_PLANNING";
    case "overnight":
    default:
      return "OVERNIGHT_RESEARCH";
  }
}
