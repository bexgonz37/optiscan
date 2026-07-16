/**
 * live-funnel.ts — PURE aggregation of the current-session stock + options alert
 * funnels for the dashboard. No provider/DB/@-alias imports so it stays unit
 * testable; the live wiring (loopState, supervisorTelemetry, readiness) is passed
 * in by the API route. The whole point: when a channel sends ZERO alerts, this
 * makes the exact drop-off point immediately visible instead of a mystery.
 */

export interface StockTapeRow {
  symbol?: string;
  classification?: string | null;
  stockPolicyOk?: boolean;
  stockPolicyReason?: string | null;
  direction?: string | null;
  promoted?: boolean;
  core?: boolean;
}

export interface StockDiscoveryStats {
  atMs: number;
  curatedCount: number;
  broadCount: number;
  broadPass: number;
  universeSize: number;
  promoted: number;
  source: string;
}

export interface ChannelReadiness {
  ready: boolean;
  blockedBy: string[];
}

export interface StockFunnel {
  lastCycleAtMs: number | null;
  universeSize: number;
  curatedCount: number;
  broadCount: number;
  broadPass: number;
  promoted: number;
  source: string;
  fastMoverPass: number;
  classifications: Record<string, number>;
  topRejections: Array<{ reason: string; count: number }>;
  actionableReady: boolean;
  premarketReady: boolean;
  blockedBy: string[];
}

export interface OptionsFunnel {
  lastCycleAtMs: number | null;
  underlyingsEvaluated: number;
  chainsOk: number;
  chainsFailed: number;
  tickersWithCanonical: number;
  canonical: number;
  // Stage counts: canonical → actionable → collapsed → (dedup / portfolio suppressed) → emitted → delivered.
  actionable: number;
  collapsed: number;
  dedupSuppressed: number;
  portfolioSuppressed: number;
  emitted: number;
  delivered: number;
  notActionableNow: number;
  contractIncomplete: number;
  contractMismatch: number;
  selectedContracts: string[];
  topReason: string | null;
  deliveryGateReason: string | null;
  ready: boolean;
  blockedBy: string[];
  /** Why each canonical candidate did not emit (bounded). */
  suppressedItems: Array<{ ticker: string; direction: string; optionSymbol: string | null; status: string; previousStatus: string | null; suppressionReason: string; materialChange: boolean }>;
}

/** Rank the first-failing gate across rejected tape rows (the "why nothing fired" list). */
export function topRejectionReasons(tape: StockTapeRow[], limit = 5): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of tape) {
    if (r.stockPolicyOk) continue;
    const reason = firstReasonPhrase(r.stockPolicyReason) || "unknown";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Compact a policy reason string to its leading phrase (before any numbers/paren detail). */
function firstReasonPhrase(reason: string | null | undefined): string {
  if (!reason) return "";
  // Keep the human category ("spread", "gain", "day volume", …), dropping the
  // noisy per-symbol numbers so "spread 2.1% > 1.5%" and "spread 3.0% > 1.5%"
  // aggregate into one "spread" bucket. Cut at the first digit, ':' or '('.
  return String(reason).split(/[:(]|\d/)[0].trim().slice(0, 60) || String(reason).trim().slice(0, 60);
}

/** Count tape rows by classification (FRESH_ACCELERATION / SLOW_GRINDER / …). */
export function classificationCounts(tape: StockTapeRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of tape) {
    const c = (r.classification ?? "UNCLASSIFIED") || "UNCLASSIFIED";
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}

export function buildStockFunnel(
  tape: StockTapeRow[],
  discovery: StockDiscoveryStats | null,
  stockReadiness: ChannelReadiness,
  premarketReadiness: ChannelReadiness,
): StockFunnel {
  const fastMoverPass = tape.filter((r) => r.stockPolicyOk === true).length;
  return {
    lastCycleAtMs: discovery?.atMs ?? null,
    universeSize: discovery?.universeSize ?? 0,
    curatedCount: discovery?.curatedCount ?? 0,
    broadCount: discovery?.broadCount ?? 0,
    broadPass: discovery?.broadPass ?? 0,
    promoted: discovery?.promoted ?? 0,
    source: discovery?.source ?? "unavailable",
    fastMoverPass,
    classifications: classificationCounts(tape),
    topRejections: topRejectionReasons(tape),
    actionableReady: stockReadiness.ready,
    premarketReady: premarketReadiness.ready,
    blockedBy: Array.from(new Set([...stockReadiness.blockedBy, ...premarketReadiness.blockedBy])),
  };
}

export interface OptionsTelemetryLike {
  lastCycleAtMs: number | null;
  lastFunnel: {
    tickersConsidered: number;
    chainsOk: number;
    chainsFailed: number;
    tickersWithCanonical: number;
    canonical: number;
    actionable?: number;
    collapsed?: number;
    dedupSuppressed?: number;
    portfolioSuppressed?: number;
    emitted: number;
    delivered: number;
    notActionableNow: number;
    contractIncomplete: number;
    contractMismatch: number;
    topReason: string | null;
    deliveryGateReason: string | null;
  } | null;
  lastSuppressedItems?: OptionsFunnel["suppressedItems"];
}

export function buildOptionsFunnel(
  telemetry: OptionsTelemetryLike,
  selectedContracts: string[],
  optionsReadiness: ChannelReadiness,
): OptionsFunnel {
  const f = telemetry.lastFunnel;
  return {
    lastCycleAtMs: telemetry.lastCycleAtMs,
    underlyingsEvaluated: f?.tickersConsidered ?? 0,
    chainsOk: f?.chainsOk ?? 0,
    chainsFailed: f?.chainsFailed ?? 0,
    tickersWithCanonical: f?.tickersWithCanonical ?? 0,
    canonical: f?.canonical ?? 0,
    actionable: f?.actionable ?? 0,
    collapsed: f?.collapsed ?? 0,
    dedupSuppressed: f?.dedupSuppressed ?? 0,
    portfolioSuppressed: f?.portfolioSuppressed ?? 0,
    emitted: f?.emitted ?? 0,
    delivered: f?.delivered ?? 0,
    notActionableNow: f?.notActionableNow ?? 0,
    contractIncomplete: f?.contractIncomplete ?? 0,
    contractMismatch: f?.contractMismatch ?? 0,
    selectedContracts: selectedContracts.slice(0, 20),
    topReason: f?.topReason ?? null,
    deliveryGateReason: f?.deliveryGateReason ?? null,
    ready: optionsReadiness.ready,
    blockedBy: optionsReadiness.blockedBy,
    suppressedItems: (telemetry.lastSuppressedItems ?? []).slice(0, 30),
  };
}

// ── TODAY audit ──────────────────────────────────────────────────────────────
// The current-session funnels above only show the LAST supervisor cycle, so a
// quiet cycle is indistinguishable from a quiet DAY. This audit aggregates the
// PERSISTED per-day diagnostics (momentum_diagnostics + options_diagnostics) so
// the Terminal/Funnel can answer "did OptiScan notify me AT ALL today, and where
// did every candidate go?" — including the last successful notification time.
// PURE: the API route reads the day's rows and computes the summaries + last
// delivery timestamps; this only shapes them for display and never fabricates.

export interface StockDaySummaryLike {
  total: number;
  sent: number;
  rescued: number;
  nearMisses: number;
  rejected: number;
  extendedRejections: number;
  staleRejected: number;
  directionSuppressed: number;
  deliveryRevalidationFailed: number;
  avgLatencyMs: number | null;
  freshAccelerationAlerts?: number;
  slowGrinderAlerts?: number;
}

export interface OptionsDaySummaryLike {
  cycles: number;
  tickersConsidered: number;
  canonical: number;
  emitted: number;
  delivered: number;
  emittedButUndelivered: number;
  gateRejections: { portfolioSuppressed: number; dedupSuppressed: number; notActionableNow: number };
  topDeliveryGateReason: string | null;
  diagnosis: string | null;
}

export interface TodayAudit {
  tradingDay: string;
  generatedAtMs: number;
  hasData: boolean;
  /** Max of the two channels' last-delivery timestamps, or null if nothing sent today. */
  lastNotificationMs: number | null;
  stocks: {
    candidates: number;
    actionable: number;      // reached an actionable state today (sent + near-misses)
    delivered: number;       // actually pushed to Discord
    suppressed: number;      // direction-invariant / delivery-revalidation holds
    rejected: number;
    lastDeliveryMs: number | null;
    avgLatencyMs: number | null;
    topReasons: Array<{ reason: string; count: number }>;
  };
  options: {
    canonical: number;
    emitted: number;
    delivered: number;
    emittedButUndelivered: number;
    dedupSuppressed: number;
    portfolioSuppressed: number;
    cycles: number;
    lastDeliveryMs: number | null;
    diagnosis: string | null;
    topReason: string | null;
  };
}

export function buildTodayAudit(input: {
  tradingDay: string;
  nowMs: number;
  stockSummary: StockDaySummaryLike | null;
  optionsSummary: OptionsDaySummaryLike | null;
  lastStockDeliveryMs: number | null;
  lastOptionsDeliveryMs: number | null;
}): TodayAudit {
  const s = input.stockSummary;
  const o = input.optionsSummary;
  const stockTopReasons: Array<{ reason: string; count: number }> = s
    ? [
        { reason: "direction/revalidation suppressed", count: s.directionSuppressed },
        { reason: "extended / chase", count: s.extendedRejections },
        { reason: "stale quote", count: s.staleRejected },
      ].filter((r) => r.count > 0).sort((a, b) => b.count - a.count)
    : [];

  const lastStock = isFiniteNum(input.lastStockDeliveryMs) ? input.lastStockDeliveryMs : null;
  const lastOptions = isFiniteNum(input.lastOptionsDeliveryMs) ? input.lastOptionsDeliveryMs : null;
  const lastNotificationMs = lastStock == null && lastOptions == null
    ? null
    : Math.max(lastStock ?? 0, lastOptions ?? 0);

  const hasData = (s?.total ?? 0) > 0 || (o?.cycles ?? 0) > 0;

  return {
    tradingDay: input.tradingDay,
    generatedAtMs: input.nowMs,
    hasData,
    lastNotificationMs,
    stocks: {
      candidates: s?.total ?? 0,
      actionable: (s?.sent ?? 0) + (s?.nearMisses ?? 0),
      delivered: s?.sent ?? 0,
      suppressed: (s?.directionSuppressed ?? 0) + (s?.deliveryRevalidationFailed ?? 0),
      rejected: s?.rejected ?? 0,
      lastDeliveryMs: lastStock,
      avgLatencyMs: s?.avgLatencyMs ?? null,
      topReasons: stockTopReasons,
    },
    options: {
      canonical: o?.canonical ?? 0,
      emitted: o?.emitted ?? 0,
      delivered: o?.delivered ?? 0,
      emittedButUndelivered: o?.emittedButUndelivered ?? 0,
      dedupSuppressed: o?.gateRejections?.dedupSuppressed ?? 0,
      portfolioSuppressed: o?.gateRejections?.portfolioSuppressed ?? 0,
      cycles: o?.cycles ?? 0,
      lastDeliveryMs: lastOptions,
      diagnosis: o?.diagnosis ?? null,
      topReason: o?.topDeliveryGateReason ?? null,
    },
  };
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
