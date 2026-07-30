import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { resolveOperatingMode, heroTitleForMode } from "@/lib/dashboard/operating-mode";
import { classifySetupDecision, DECISION_LABEL, type DecisionState } from "@/lib/dashboard/setup-decision";
import { plainEnglishAlertReason } from "@/lib/research/options/format";
import { formatOccContract, parseOccContract } from "@/lib/format-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function humanContractLabel(symbol: string, occ: string | null, fallbackSide: string): string | null {
  const parsed = parseOccContract(occ);
  if (!parsed || parsed.symbol !== symbol.toUpperCase() || parsed.side !== fallbackSide) return null;
  return formatOccContract(occ);
}

/**
 * GET /api/now — decision-first homepage snapshot.
 * Groups setups into TRADE NOW / ALMOST READY / TOMORROW / AVOID.
 * Does not change trading formulas or Discord delivery gates.
 */
export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  const now = Date.now();
  const faults: string[] = [];
  const safe = <T,>(label: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err: any) {
      faults.push(`${label}: ${String(err?.message ?? err).slice(0, 160)}`);
      return fallback;
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  const db = safe("db", () => getDb(), null);

  // Reuse command-center composition for positions / ranked setups / independent health.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hasPolygon } = require("@/lib/polygon-provider");
  const independent = safe("independent", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { optionsMonitorHealth } = require("@/lib/research/options/monitor");
    const monitor = optionsMonitorHealth(process.env, now);
    return {
      monitorAlive: monitor.alive || monitor.running,
      polygonConfigured: hasPolygon(),
      polygonHealthy: hasPolygon(),
    };
  }, { monitorAlive: null, polygonConfigured: hasPolygon(), polygonHealthy: null });

  const operating = resolveOperatingMode({
    nowMs: now,
    monitorAlive: independent.monitorAlive,
    providerConfigured: independent.polygonConfigured,
    providerHealthy: independent.polygonHealthy,
    dbOk: db != null,
  });

  const rankedSetups = safe("rankedSetups", () => {
    if (!db) return [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildRankedSetupsNow } = require("@/lib/research/options/ranked-setups");
    return buildRankedSetupsNow(db, now);
  }, []);

  const overnight = safe("overnight", () => {
    if (!db) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadOvernightPlan, buildNextSessionPlan, persistOvernightPlan } = require("@/lib/research/overnight/next-session-plan");
    let plan = loadOvernightPlan(db);
    if (!operating.optionsExecutableWindow) {
      plan = buildNextSessionPlan(db, now);
      persistOvernightPlan(db, plan);
    }
    return plan;
  }, null);

  const openPositions = safe("openPositions", () => {
    if (!db) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildPaperChainDiagnostic } = require("@/lib/research/options/paper-chain");
      const chain = buildPaperChainDiagnostic(db, process.env, 40);
      return (chain?.rows ?? []).filter((r: any) => r.paperStatus === "ENTERED").slice(0, 12);
    } catch {
      return [];
    }
  }, []);

  type Card = {
    key: string;
    rank: number;
    symbol: string;
    side: string;
    state: DecisionState;
    label: string;
    trigger: string;
    entryZone: number | null;
    preferredStructure: string;
    t1: number | null;
    stop: number | null;
    confidence: number | null;
    reason: string;
    mainRisk: string;
    freshness: string;
    quantSampleSize: number | null;
    confirmationNeeded: string | null;
    contract: string | null;
    verifyContractAfterOpen: boolean;
    quoteLabel: string;
    whyFirst?: string;
    href: string;
  };

  const cards: Card[] = [];

  for (const s of rankedSetups as any[]) {
    const decision = classifySetupDecision({
      operatingMode: operating.mode,
      systemAction: s.systemAction,
      entryStatusLabel: s.entryQualityState,
      quoteFreshness: s.freshnessLabel === "live" || (typeof s.freshnessMs === "number" && s.freshnessMs < 60_000) ? "fresh" : "stale",
      contractReady: s.contractReadiness === "READY",
      contractThin: s.contractReadiness === "THIN",
      contractUnavailable: s.contractReadiness === "UNAVAILABLE" || !s.realExecutableQuote,
      hasFreshBidAsk: Boolean(s.realExecutableQuote && s.entryZone != null),
      spreadPct: s.spreadPct,
      actionable: s.systemAction === "SEND" || s.entryState === "ACTIONABLE",
      researchOnly: s.systemAction === "RESEARCH",
      waitFor: s.systemAction === "WATCH" ? "Needs confirmation" : null,
    });
    cards.push({
      key: `ranked-${s.symbol}-${s.rank}`,
      rank: s.rank,
      symbol: s.symbol,
      side: s.side,
      state: decision.state,
      label: decision.label,
      trigger: decision.confirmationNeeded ?? "Setup conditions confirmed",
      entryZone: decision.executable ? s.entryZone : null,
      preferredStructure: decision.executable
        ? humanContractLabel(s.symbol, s.contract, s.side) ?? "Contract pending verification"
        : "Contract pending verification",
      t1: decision.executable ? s.target : null,
      stop: decision.executable ? s.stop : null,
      confidence: s.actionScore ?? s.signalScore ?? s.confidenceScore,
      reason: plainEnglishAlertReason({
        symbol: s.symbol,
        side: s.side,
        strategyKey: s.strategy,
        sourceReason: s.reason,
      }),
      mainRisk: s.mainRisk ?? "—",
      freshness: decision.quoteLabel === "STALE · PRIOR SESSION" ? decision.quoteLabel : (s.freshnessLabel ?? "—"),
      quantSampleSize: null,
      confirmationNeeded: decision.confirmationNeeded,
      contract: decision.executable ? s.contract : null,
      verifyContractAfterOpen: decision.verifyContractAfterOpen,
      quoteLabel: decision.quoteLabel,
      href: s.href ?? "/callouts",
    });
  }

  // Merge overnight recommendations into TOMORROW when not already present.
  if (overnight?.recommendations) {
    for (const r of overnight.recommendations) {
      if (cards.some((c) => c.symbol === r.symbol && c.state === "TOMORROW")) continue;
      const decision = classifySetupDecision({
        operatingMode: operating.mode,
        overnightLane: true,
        systemAction: "WATCH",
      });
      cards.push({
        key: `overnight-${r.symbol}`,
        rank: 100 + r.rank,
        symbol: r.symbol,
        side: r.bias === "bearish" ? "put" : "call",
        state: decision.state,
        label: decision.label,
        trigger: r.triggerLevel != null ? `Trigger ${r.triggerLevel}` : "Confirm levels at open",
        entryZone: null,
        preferredStructure: "Contract pending verification",
        t1: null,
        stop: null,
        confidence: r.confidence,
        reason: r.supportingEvidence?.[0] ?? r.setupFamily,
        mainRisk: r.mainRisk,
        freshness: "STALE · PRIOR SESSION",
        quantSampleSize: null,
        confirmationNeeded: null,
        contract: null,
        verifyContractAfterOpen: true,
        quoteLabel: "STALE · PRIOR SESSION",
        href: "/callouts",
      });
    }
  }

  // Rank within groups by confidence.
  cards.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  cards.forEach((c, i) => {
    c.rank = i + 1;
  });

  const groups: Record<DecisionState, Card[]> = {
    TRADE_NOW: [],
    ALMOST_READY: [],
    TOMORROW: [],
    AVOID: [],
  };
  for (const c of cards) groups[c.state].push(c);

  // Hide TRADE NOW outside executable window.
  if (!operating.optionsExecutableWindow) {
    for (const c of groups.TRADE_NOW) {
      c.state = "TOMORROW";
      c.label = DECISION_LABEL.TOMORROW;
      c.entryZone = null;
      c.t1 = null;
      c.stop = null;
      c.contract = null;
      c.verifyContractAfterOpen = true;
      c.freshness = "STALE · PRIOR SESSION";
      groups.TOMORROW.push(c);
    }
    groups.TRADE_NOW = [];
  }

  const ordered = [
    ...groups.TRADE_NOW,
    ...groups.ALMOST_READY,
    ...groups.TOMORROW,
    ...groups.AVOID,
  ];
  const hero = ordered[0] ?? null;
  if (hero) {
    hero.whyFirst = operating.optionsExecutableWindow
      ? "Highest decision score with the best current executable readiness."
      : "Highest-confidence next-session plan with clear structure and risk.";
  }

  return NextResponse.json({
    ok: faults.length === 0,
    faults,
    generatedAtMs: now,
    generatedAtIso: new Date(now).toISOString(),
    sourceEndpoint: "/api/now",
    operatingMode: operating.mode,
    operatingLabel: operating.label,
    operatingDetail: operating.detail,
    optionsExecutableWindow: operating.optionsExecutableWindow,
    researchActive: operating.researchActive,
    heroTitle: heroTitleForMode(operating.mode),
    hero,
    nextThree: ordered.slice(1, 4),
    groups: {
      TRADE_NOW: groups.TRADE_NOW,
      ALMOST_READY: groups.ALMOST_READY,
      TOMORROW: groups.TOMORROW,
      AVOID: groups.AVOID,
    },
    counts: {
      TRADE_NOW: groups.TRADE_NOW.length,
      ALMOST_READY: groups.ALMOST_READY.length,
      TOMORROW: groups.TOMORROW.length,
      AVOID: groups.AVOID.length,
    },
    openPositions,
    overnight: overnight
      ? {
          tradingDay: overnight.tradingDay,
          planVersion: overnight.planVersion,
          count: overnight.recommendations?.length ?? 0,
          marketContext: overnight.marketContext,
          recommendations: overnight.recommendations ?? [],
          needsMoreData: overnight.needsMoreData ?? [],
          omitted: overnight.omitted ?? [],
        }
      : null,
  });
}
