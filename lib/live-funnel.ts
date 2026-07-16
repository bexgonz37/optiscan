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
    emitted: number;
    delivered: number;
    notActionableNow: number;
    contractIncomplete: number;
    contractMismatch: number;
    topReason: string | null;
    deliveryGateReason: string | null;
  } | null;
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
  };
}
