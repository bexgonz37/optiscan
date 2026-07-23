/**
 * Portfolio-level delivery decision layer.
 *
 * Intent is stored separately from final delivery outcome:
 * - outcome: deterministic portfolio decision intent.
 * - finalDeliveryOutcome: what actually happened after hard-gated delivery ran.
 */
import { rankCandidates, type RankableCandidate } from "./ranking.ts";
import { deliverOptionsCallout, type DeliveryInput } from "./delivery.ts";
import { sessionState, type SessionState } from "./session-state.ts";
import { OPTIONS_TIER0 } from "./discovery.ts";

export interface DeliverySubmission {
  deliveryInput: DeliveryInput;
  symbol: string; side: "call" | "put"; strategy: string; researchOnly: boolean;
  tier: 0 | 1 | 2;
  matchedSignals: number; requiredSignals: number; strategyScore: number;
  spreadPct: number | null; openInterest: number | null; volume: number | null;
  fractionMove: number | null;
  levelProximityPct: number | null;
  nowMs: number;
}

export type DecisionOutcome = "DELIVER_TO_DISCORD" | "RESEARCH_ONLY" | "REJECT";
export type FinalDeliveryOutcome =
  | "DELIVERED"
  | "SKIPPED"
  | "REJECTED"
  | "BLOCKED_KILL_SWITCH"
  | "DISCORD_FAILURE"
  | "WEBHOOK_FAILURE"
  | "DOWNSTREAM_ERROR";

export interface DeliveryDecision {
  symbol: string; strategy: string; side: string; tier: number;
  outcome: DecisionOutcome; reason: string;
  quality: number; components: Record<string, number>;
  rank: number; batchSize: number; clusterKey: string;
  threshold: number; sessionState: SessionState; wouldDeliverSolo: boolean;
  alertId: string | null;
  deliveryAttempted: boolean; deliverySent: boolean;
  deliveryState: string | null; finalDeliveryOutcome: FinalDeliveryOutcome;
  deliveryFailureCategory: string | null; finalDeliveryReason: string | null;
}

export interface DecisionConfig {
  deliverBar: number; openingBump: number; excellentBar: number;
  researchFloor: number; maxPerFlush: number; correlationWindowMs: number;
}

export function decisionConfig(env: NodeJS.ProcessEnv = process.env): DecisionConfig {
  const n = (v: string | undefined, d: number, lo: number, hi: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= lo && x <= hi ? x : d;
  };
  return {
    deliverBar: n(env.OPTIONS_QUALITY_DELIVER_BAR, 0.62, 0, 1),
    openingBump: n(env.OPTIONS_QUALITY_OPENING_BUMP, 0.06, 0, 0.3),
    excellentBar: n(env.OPTIONS_QUALITY_EXCELLENT_BAR, 0.75, 0, 1),
    researchFloor: n(env.OPTIONS_QUALITY_RESEARCH_FLOOR, 0.35, 0, 1),
    maxPerFlush: n(env.OPTIONS_MAX_DELIVER_PER_FLUSH, 2, 1, 10),
    correlationWindowMs: n(env.OPTIONS_CORRELATION_WINDOW_MS, 15 * 60_000, 0, 3_600_000),
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const TIER0_SET = new Set<string>([...OPTIONS_TIER0, "DIA"]);

export function clusterKey(symbol: string, side: string): string {
  return TIER0_SET.has(symbol.toUpperCase()) ? `index:${side}` : `${symbol.toUpperCase()}:${side}`;
}

export interface StrategyEvidence { n: number; winRate: number }
/** Detail passed alongside the blended evidence scalar so the persisted rationale shows exactly which
 *  evidence moved the score and how much of it was leak-free HISTORICAL (underlying-forward) vs FORWARD
 *  live-mirror. HISTORICAL is underlying-forward movement, NOT an option win rate — labeled as such. */
export interface EvidenceDetail { value: number; forwardN: number; historicalN: number; source: "none" | "forward" | "historical" | "blended" }

export function computeSubscriberQuality(s: DeliverySubmission, evidence: StrategyEvidence | null, detail?: EvidenceDetail): { quality: number; components: Record<string, number> } {
  const completeness = s.requiredSignals > 0 ? (s.matchedSignals / s.requiredSignals) * Math.min(1, s.matchedSignals / 3) : 0;
  const earliness = s.fractionMove == null ? 0.5 : clamp01(1 - s.fractionMove);
  const spread = s.spreadPct == null ? 0.3 : clamp01(1 - s.spreadPct / 10);
  const oi = s.openInterest ?? 0;
  const liquidity = clamp01(Math.log10(1 + Math.max(0, oi)) / 4);
  const levelProximity = s.levelProximityPct == null ? 0.4 : clamp01(1 - s.levelProximityPct / 2);
  const strategyConfidence = clamp01(s.strategyScore);
  // Evidence: prefer the pre-blended scalar from `detail` (forward mirror + leak-free historical replay,
  // sample-gated); else the legacy forward-only path. Neutral 0.5 when there is no qualifying evidence.
  // Evidence is only 10% of the score, so it can NUDGE ranking but can NEVER carry delivery on its own —
  // the deterministic setup components (90%) decide whether a setup clears the subscriber bar.
  const evid = detail ? clamp01(detail.value) : (evidence && evidence.n >= 5 ? clamp01(evidence.winRate) : 0.5);
  const components: Record<string, number> = {
    signalCompleteness: +completeness.toFixed(4),
    earliness: +earliness.toFixed(4),
    spread: +spread.toFixed(4),
    liquidity: +liquidity.toFixed(4),
    levelProximity: +levelProximity.toFixed(4),
    strategyConfidence: +strategyConfidence.toFixed(4),
    evidence: +evid.toFixed(4),
  };
  if (detail) { components.evidenceForwardN = detail.forwardN; components.evidenceHistoricalN = detail.historicalN; }
  const quality = 0.22 * completeness + 0.18 * earliness + 0.15 * spread + 0.12 * liquidity + 0.11 * levelProximity + 0.12 * strategyConfidence + 0.10 * evid;
  return { quality: +quality.toFixed(4), components };
}

interface DDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }
const hasTable = (db: DDb, t: string) => {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(t)); } catch { return false; }
};

/** FORWARD live-mirror evidence — real delivered-alert outcomes (option return_pct sign). */
function strategyEvidenceOnDb(db: DDb | null, strategy: string): StrategyEvidence | null {
  if (!db || !hasTable(db, "options_paper_delivered")) return null;
  try {
    const r = db.prepare("SELECT COUNT(*) n, AVG(CASE WHEN return_pct > 0 THEN 1.0 ELSE 0.0 END) wr FROM options_paper_delivered WHERE strategy=? AND status='EXITED' AND return_pct IS NOT NULL").get(strategy) as any;
    return r && Number(r.n) > 0 ? { n: Number(r.n), winRate: Number(r.wr ?? 0) } : null;
  } catch { return null; }
}

/** HISTORICAL replay evidence — leak-free UNDERLYING-forward win rate from the 5-year replay lab
 *  (options_replay_candidates.fwd60_pct). This is underlying movement, NOT option P&L — used only as a
 *  modest, sample-gated prior on setup quality, never presented as option profitability. */
function historicalStrategyEvidenceOnDb(db: DDb | null, strategy: string): StrategyEvidence | null {
  if (!db || !hasTable(db, "options_replay_candidates")) return null;
  try {
    const r = db.prepare("SELECT COUNT(*) n, AVG(CASE WHEN fwd60_pct > 0 THEN 1.0 ELSE 0.0 END) wr FROM options_replay_candidates WHERE strategy=? AND fwd60_pct IS NOT NULL").get(strategy) as any;
    return r && Number(r.n) > 0 ? { n: Number(r.n), winRate: Number(r.wr ?? 0) } : null;
  } catch { return null; }
}

/**
 * Blend FORWARD (real delivered outcomes) and HISTORICAL (leak-free replay, underlying-forward) into one
 * evidence scalar with an honest hierarchy: forward is trusted more per-sample; historical is a
 * supplementary prior that only counts above a higher sample floor. When they conflict, forward
 * dominates (its per-sample weight is higher). No qualifying evidence → neutral 0.5 (source "none").
 */
export function blendEvidence(forward: StrategyEvidence | null, historical: StrategyEvidence | null, env: NodeJS.ProcessEnv = process.env): EvidenceDetail {
  const minFwd = Math.max(1, Number(env.OPTIONS_EVIDENCE_MIN_FORWARD ?? 5) || 5);
  const minHist = Math.max(1, Number(env.OPTIONS_EVIDENCE_MIN_HISTORICAL ?? 40) || 40);
  const useHist = env.OPTIONS_HISTORICAL_EVIDENCE_ENABLED !== "0"; // default ON; historical is self-gating (needs replay data)
  const parts: { w: number; v: number }[] = [];
  const fN = forward && forward.n >= minFwd ? forward.n : 0;
  const hN = useHist && historical && historical.n >= minHist ? historical.n : 0;
  if (fN > 0) parts.push({ w: Math.min(1, fN / 20) * 1.0, v: clamp01(forward!.winRate) });      // forward: full trust, saturates at n=20
  if (hN > 0) parts.push({ w: Math.min(1, hN / 200) * 0.6, v: clamp01(historical!.winRate) });   // historical: 0.6 trust, saturates at n=200
  if (parts.length === 0) return { value: 0.5, forwardN: forward?.n ?? 0, historicalN: historical?.n ?? 0, source: "none" };
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  const value = wsum > 0 ? parts.reduce((a, p) => a + p.w * p.v, 0) / wsum : 0.5;
  const source: EvidenceDetail["source"] = fN > 0 && hN > 0 ? "blended" : fN > 0 ? "forward" : "historical";
  return { value: +value.toFixed(4), forwardN: forward?.n ?? 0, historicalN: historical?.n ?? 0, source };
}

function recentDeliveredClusters(db: DDb | null, nowMs: number, windowMs: number): Set<string> {
  const out = new Set<string>();
  if (!db || !hasTable(db, "options_alerts") || windowMs <= 0) return out;
  try {
    for (const r of db.prepare("SELECT candidate_symbol, side FROM options_alerts WHERE state='SENT' AND sent_at_ms >= ?").all(nowMs - windowMs) as any[]) {
      out.add(clusterKey(String(r.candidate_symbol), String(r.side)));
    }
  } catch { /* isolated */ }
  return out;
}

export interface DecisionDeps {
  getDb?: () => any; now?: () => number;
  deliver?: (input: DeliveryInput) => Promise<{ state: string; alertId: string; sent: boolean; reason?: string | null }>;
}

function skipped(reason: string): Pick<DeliveryDecision, "deliveryAttempted" | "deliverySent" | "deliveryState" | "finalDeliveryOutcome" | "deliveryFailureCategory" | "finalDeliveryReason"> {
  return { deliveryAttempted: false, deliverySent: false, deliveryState: null, finalDeliveryOutcome: "SKIPPED", deliveryFailureCategory: null, finalDeliveryReason: reason };
}

function classifyDeliveryResult(r: { state: string; sent: boolean; reason?: string | null }) {
  const state = String(r.state ?? "");
  const reason = r.reason == null ? null : String(r.reason);
  const text = `${state} ${reason ?? ""}`.toLowerCase();
  if (r.sent && state === "SENT") return { finalDeliveryOutcome: "DELIVERED" as const, category: null, reason: reason ?? "delivered" };
  if (text.includes("kill_switch")) return { finalDeliveryOutcome: "BLOCKED_KILL_SWITCH" as const, category: "kill_switch", reason };
  if (state === "SEND_FAILED") {
    const category = /webhook|not configured|not set|missing/i.test(reason ?? "") ? "webhook_failure" : "discord_failure";
    return { finalDeliveryOutcome: category === "webhook_failure" ? "WEBHOOK_FAILURE" as const : "DISCORD_FAILURE" as const, category, reason };
  }
  if (state === "REJECTED" || state === "TOO_LATE" || state === "EXPIRED") return { finalDeliveryOutcome: "REJECTED" as const, category: state.toLowerCase(), reason };
  return { finalDeliveryOutcome: "DOWNSTREAM_ERROR" as const, category: "unexpected_delivery_state", reason: reason ?? state };
}

export async function decideDeliveryBatch(batch: DeliverySubmission[], deps: DecisionDeps = {}, env: NodeJS.ProcessEnv = process.env): Promise<DeliveryDecision[]> {
  if (batch.length === 0) return [];
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const cfg = decisionConfig(env);
  const session = sessionState(nowMs, env);
  const deliverBar = +(cfg.deliverBar + (session === "OPENING_DISCOVERY" ? cfg.openingBump : 0)).toFixed(4);

  let db: DDb | null = null;
  try { db = deps.getDb ? deps.getDb() : null; } catch { db = null; }

  // Evidence hierarchy per strategy (cached): FORWARD live-mirror outcomes + leak-free HISTORICAL replay
  // (underlying-forward), blended and sample-gated. This is how the 5-year replay data + accruing live
  // results make callouts better over time — a modest 10% nudge that can never carry delivery alone.
  const evidenceCache = new Map<string, EvidenceDetail>();
  const scored = batch.map((s) => {
    if (!evidenceCache.has(s.strategy)) {
      const blended = blendEvidence(strategyEvidenceOnDb(db, s.strategy), historicalStrategyEvidenceOnDb(db, s.strategy), env);
      evidenceCache.set(s.strategy, blended);
    }
    const q = computeSubscriberQuality(s, null, evidenceCache.get(s.strategy));
    return { s, ...q };
  });

  const rankable: (RankableCandidate & { i: number })[] = scored.map((x, i) => ({
    i,
    symbol: x.s.symbol,
    tier: x.s.tier,
    forming: x.s.fractionMove == null || x.s.fractionMove < 0.75,
    moveCompletedPct: x.s.fractionMove ?? 0.5,
    spreadPct: x.s.spreadPct ?? 999,
    liquidity: x.s.openInterest ?? 0,
    levelProximityPct: x.s.levelProximityPct ?? 999,
    extensionPct: 0,
    quality: x.quality,
  }));
  const ranked = rankCandidates(rankable);

  const recentClusters = recentDeliveredClusters(db, nowMs, cfg.correlationWindowMs);
  const takenClusters = new Set<string>();
  let selected = 0;
  const decisions: (DeliveryDecision & { sub: DeliverySubmission })[] = [];

  for (let rank = 0; rank < ranked.length; rank++) {
    const x = scored[ranked[rank].i];
    const ck = clusterKey(x.s.symbol, x.s.side);
    const base: DeliveryDecision & { sub: DeliverySubmission } = {
      sub: x.s,
      symbol: x.s.symbol,
      strategy: x.s.strategy,
      side: x.s.side,
      tier: x.s.tier,
      outcome: "RESEARCH_ONLY",
      reason: "",
      quality: x.quality,
      components: x.components,
      rank: rank + 1,
      batchSize: batch.length,
      clusterKey: ck,
      threshold: deliverBar,
      sessionState: session,
      wouldDeliverSolo: x.quality >= deliverBar && !recentClusters.has(ck),
      alertId: null,
      ...skipped("not_selected"),
    };

    if (x.s.researchOnly || x.s.side === "put") { base.reason = "research_only_put"; base.finalDeliveryReason = base.reason; decisions.push(base); continue; }
    if (x.quality < cfg.researchFloor) {
      base.outcome = "REJECT";
      base.reason = `below_research_floor (${x.quality} < ${cfg.researchFloor})`;
      base.finalDeliveryOutcome = "REJECTED";
      base.finalDeliveryReason = base.reason;
      decisions.push(base);
      continue;
    }
    if (x.quality < deliverBar) { base.reason = `below_subscriber_threshold (${x.quality} < ${deliverBar})`; base.finalDeliveryReason = base.reason; decisions.push(base); continue; }
    const excellent = x.quality >= cfg.excellentBar;
    if ((takenClusters.has(ck) || recentClusters.has(ck)) && !excellent) {
      base.reason = `withheld_correlation (cluster ${ck} already expressed; ${x.quality} < excellent ${cfg.excellentBar})`;
      base.finalDeliveryReason = base.reason;
      decisions.push(base);
      continue;
    }
    if (selected >= cfg.maxPerFlush && !excellent) {
      base.reason = `withheld_ranking (rank ${rank + 1}, ${selected} stronger candidates already delivered this flush)`;
      base.finalDeliveryReason = base.reason;
      decisions.push(base);
      continue;
    }
    base.outcome = "DELIVER_TO_DISCORD";
    base.reason = `subscriber_worthy: quality ${x.quality} >= bar ${deliverBar}${excellent ? " (independently excellent)" : ""}; rank ${rank + 1}/${batch.length}; cluster ${ck}`;
    base.finalDeliveryReason = "selected_for_delivery";
    takenClusters.add(ck);
    selected += 1;
    decisions.push(base);
  }

  const deliver = deps.deliver ?? ((input: DeliveryInput) => deliverOptionsCallout(input, { getDb: deps.getDb }, env));
  for (const d of decisions) {
    if (d.outcome !== "DELIVER_TO_DISCORD") continue;
    d.deliveryAttempted = true;
    try {
      const r = await deliver(d.sub.deliveryInput);
      d.alertId = r.alertId ?? null;
      d.deliveryState = r.state ?? null;
      d.deliverySent = Boolean(r.sent);
      const c = classifyDeliveryResult(r);
      d.finalDeliveryOutcome = c.finalDeliveryOutcome;
      d.deliveryFailureCategory = c.category;
      d.finalDeliveryReason = c.reason;
    } catch (err: any) {
      d.deliveryState = "THREW";
      d.finalDeliveryOutcome = "DOWNSTREAM_ERROR";
      d.deliveryFailureCategory = "downstream_error";
      d.finalDeliveryReason = String(err?.message ?? err).slice(0, 200);
    }
  }

  if (db && hasTable(db, "options_delivery_decisions")) {
    const batchId = `bd_${nowMs}`;
    const competing = decisions.slice(0, 8).map((d) => ({ symbol: d.symbol, strategy: d.strategy, quality: d.quality, outcome: d.outcome, finalDeliveryOutcome: d.finalDeliveryOutcome, reason: d.reason.slice(0, 80) }));
    for (const d of decisions) {
      try {
        db.prepare(
          `INSERT INTO options_delivery_decisions (batch_id, symbol, strategy, side, tier, outcome, reason, quality, rank, batch_size, components_json, cluster_key, threshold, session_state, alert_id, would_deliver_solo, competing_json, delivery_attempted, delivery_sent, delivery_state, final_delivery_outcome, delivery_failure_category, final_delivery_reason, delivery_attempted_at_ms, delivery_completed_at_ms, created_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          batchId, d.symbol, d.strategy, d.side, d.tier, d.outcome, d.reason, d.quality, d.rank, d.batchSize,
          JSON.stringify(d.components), d.clusterKey, d.threshold, d.sessionState, d.alertId, d.wouldDeliverSolo ? 1 : 0,
          JSON.stringify(competing.filter((c) => !(c.symbol === d.symbol && c.strategy === d.strategy))),
          d.deliveryAttempted ? 1 : 0, d.deliverySent ? 1 : 0, d.deliveryState, d.finalDeliveryOutcome,
          d.deliveryFailureCategory, d.finalDeliveryReason, d.deliveryAttempted ? nowMs : null, d.deliveryAttempted ? nowMs : null, nowMs,
        );
      } catch { /* isolated */ }
    }
  }

  return decisions.map(({ sub: _sub, ...rest }) => rest);
}

export function deliveryDecisionMetricsOnDb(db: DDb): Record<string, unknown> {
  if (!hasTable(db, "options_delivery_decisions")) return { available: false };
  const n = (sql: string, ...a: any[]) => { try { return Number((db.prepare(sql).get(...a) as any)?.n ?? 0); } catch { return 0; } };
  const avg = (sql: string) => { try { const v = (db.prepare(sql).get() as any)?.v; return v == null ? null : +Number(v).toFixed(4); } catch { return null; } };
  const byOutcome: Record<string, number> = {};
  try { for (const r of db.prepare("SELECT outcome, COUNT(*) c FROM options_delivery_decisions GROUP BY outcome").all() as any[]) byOutcome[r.outcome] = r.c; } catch { /* isolated */ }
  const byFinalDeliveryOutcome: Record<string, number> = {};
  try { for (const r of db.prepare("SELECT final_delivery_outcome s, COUNT(*) c FROM options_delivery_decisions GROUP BY final_delivery_outcome").all() as any[]) byFinalDeliveryOutcome[r.s ?? "unknown"] = r.c; } catch { /* isolated */ }
  return {
    available: true,
    candidatesRanked: n("SELECT COUNT(*) n FROM options_delivery_decisions"),
    byOutcome,
    byFinalDeliveryOutcome,
    selectedForDelivery: byOutcome.DELIVER_TO_DISCORD ?? 0,
    delivered: byFinalDeliveryOutcome.DELIVERED ?? 0,
    deliveryAttempted: n("SELECT COUNT(*) n FROM options_delivery_decisions WHERE delivery_attempted=1"),
    deliveryBlockedKillSwitch: byFinalDeliveryOutcome.BLOCKED_KILL_SWITCH ?? 0,
    deliveryDiscordFailures: byFinalDeliveryOutcome.DISCORD_FAILURE ?? 0,
    deliveryWebhookFailures: byFinalDeliveryOutcome.WEBHOOK_FAILURE ?? 0,
    deliveryDownstreamErrors: byFinalDeliveryOutcome.DOWNSTREAM_ERROR ?? 0,
    researchOnly: byOutcome.RESEARCH_ONLY ?? 0,
    rejected: byOutcome.REJECT ?? 0,
    avgQuality: avg("SELECT AVG(quality) v FROM options_delivery_decisions"),
    avgDeliveredQuality: avg("SELECT AVG(quality) v FROM options_delivery_decisions WHERE final_delivery_outcome='DELIVERED'"),
    withheldByRanking: n("SELECT COUNT(*) n FROM options_delivery_decisions WHERE reason LIKE 'withheld_ranking%'"),
    withheldByCorrelation: n("SELECT COUNT(*) n FROM options_delivery_decisions WHERE reason LIKE 'withheld_correlation%'"),
    withheldByThreshold: n("SELECT COUNT(*) n FROM options_delivery_decisions WHERE reason LIKE 'below_subscriber_threshold%'"),
    bySession: (() => {
      const m: Record<string, number> = {};
      try {
        for (const r of db.prepare("SELECT session_state s, COUNT(*) c FROM options_delivery_decisions WHERE final_delivery_outcome='DELIVERED' GROUP BY session_state").all() as any[]) m[r.s] = r.c;
      } catch { /* isolated */ }
      return m;
    })(),
  };
}
