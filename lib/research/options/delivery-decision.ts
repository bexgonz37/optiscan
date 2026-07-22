/**
 * lib/research/options/delivery-decision.ts — the PORTFOLIO-LEVEL DELIVERY DECISION layer.
 *
 *   ALL READY candidates (per scan cycle)
 *     → single calibrated quality score (built ONLY from signals the deterministic engine already computed)
 *     → cross-candidate ranking (REUSES rankCandidates from ranking.ts — tier precedence, earliness, spread…)
 *     → correlation clustering (SPY/QQQ/IWM/DIA = one index thesis; same symbol+side = one thesis)
 *     → DELIVER_TO_DISCORD | RESEARCH_ONLY | REJECT
 *
 * Philosophy: the scanner stays SENSITIVE (nothing here reduces detection; the research-lane shadow paper
 * is opened for every READY candidate regardless), Discord stays SELECTIVE (passing hard gates alone
 * NEVER guarantees delivery — a candidate must clear an absolute subscriber-quality bar AND win its
 * ranking/cluster). Multiple alerts are allowed when independently EXCELLENT; merely-acceptable setups
 * become research. Tier 0 keeps scan priority and ranking precedence but NO unlimited delivery.
 *
 * Every decision (delivered or withheld) is persisted with rank, quality, components, cluster, threshold,
 * competing candidates, and whether it would deliver with only one slot — so the engine can always answer
 * "why did this deserve interrupting a subscriber?". Winners still pass through deliverOptionsCallout,
 * which re-checks every hard execution gate (freshness/spread/chase/dedup/kill switch) unchanged.
 * HARD no-op unless OPTIONS_PORTFOLIO_DELIVERY_ENABLED=1 (delivery then behaves exactly as before).
 * No AI anywhere in this path; no real-money; bearish/put safeguards untouched.
 */
import { rankCandidates, type RankableCandidate } from "./ranking.ts";
import { deliverOptionsCallout, type DeliveryInput } from "./delivery.ts";
import { sessionState, type SessionState } from "./session-state.ts";
import { OPTIONS_TIER0 } from "./discovery.ts";

export interface DeliverySubmission {
  deliveryInput: DeliveryInput;    // the ready-to-send payload; hard gates re-checked downstream
  symbol: string; side: "call" | "put"; strategy: string; researchOnly: boolean;
  tier: 0 | 1 | 2;
  // quality inputs — every one already computed by the deterministic engine (no new signals invented)
  matchedSignals: number; requiredSignals: number; strategyScore: number;
  spreadPct: number | null; openInterest: number | null; volume: number | null;
  fractionMove: number | null;       // move-completed estimate (null = unknown)
  levelProximityPct: number | null;  // distance to the decision level
  nowMs: number;
}

export type DecisionOutcome = "DELIVER_TO_DISCORD" | "RESEARCH_ONLY" | "REJECT";
export interface DeliveryDecision {
  symbol: string; strategy: string; side: string; tier: number;
  outcome: DecisionOutcome; reason: string;
  quality: number; components: Record<string, number>;
  rank: number; batchSize: number; clusterKey: string;
  threshold: number; sessionState: SessionState; wouldDeliverSolo: boolean;
  alertId: string | null;
}

export interface DecisionConfig { deliverBar: number; openingBump: number; excellentBar: number; researchFloor: number; maxPerFlush: number; correlationWindowMs: number }
export function decisionConfig(env: NodeJS.ProcessEnv = process.env): DecisionConfig {
  const n = (v: string | undefined, d: number, lo: number, hi: number) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : d; };
  return {
    deliverBar: n(env.OPTIONS_QUALITY_DELIVER_BAR, 0.62, 0, 1),
    openingBump: n(env.OPTIONS_QUALITY_OPENING_BUMP, 0.06, 0, 0.3),      // stronger cross-signal quality at the open
    excellentBar: n(env.OPTIONS_QUALITY_EXCELLENT_BAR, 0.75, 0, 1),      // "independently excellent" may exceed caps/clusters
    researchFloor: n(env.OPTIONS_QUALITY_RESEARCH_FLOOR, 0.35, 0, 1),
    maxPerFlush: n(env.OPTIONS_MAX_DELIVER_PER_FLUSH, 2, 1, 10),
    correlationWindowMs: n(env.OPTIONS_CORRELATION_WINDOW_MS, 15 * 60_000, 0, 3_600_000),
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const TIER0_SET = new Set<string>([...OPTIONS_TIER0, "DIA"]);
/** Correlation cluster: the index complex (SPY/QQQ/IWM/DIA) is ONE market thesis per direction; single
 *  names cluster by symbol+direction. */
export function clusterKey(symbol: string, side: string): string {
  return TIER0_SET.has(symbol.toUpperCase()) ? `index:${side}` : `${symbol.toUpperCase()}:${side}`;
}

export interface StrategyEvidence { n: number; winRate: number }
/**
 * The single calibrated subscriber-quality score (0..1). A weighted composite of signals the engine
 * ALREADY computes — not a new arbitrary signal. signalCompleteness is evidence-weighted
 * (matched/required × min(1, matched/3)) so a thin 2-of-2 strategy cannot outrank a rich 3-of-4 one,
 * fixing the cross-strategy calibration bias found in the review.
 */
export function computeSubscriberQuality(s: DeliverySubmission, evidence: StrategyEvidence | null): { quality: number; components: Record<string, number> } {
  const completeness = s.requiredSignals > 0 ? (s.matchedSignals / s.requiredSignals) * Math.min(1, s.matchedSignals / 3) : 0;
  const earliness = s.fractionMove == null ? 0.5 : clamp01(1 - s.fractionMove);
  const spread = s.spreadPct == null ? 0.3 : clamp01(1 - s.spreadPct / 10);
  const oi = s.openInterest ?? 0;
  const liquidity = clamp01(Math.log10(1 + Math.max(0, oi)) / 4);
  const levelProximity = s.levelProximityPct == null ? 0.4 : clamp01(1 - s.levelProximityPct / 2);
  const strategyConfidence = clamp01(s.strategyScore);
  const evid = evidence && evidence.n >= 5 ? clamp01(evidence.winRate) : 0.5; // neutral until real forward evidence exists
  const components = { signalCompleteness: +completeness.toFixed(4), earliness: +earliness.toFixed(4), spread: +spread.toFixed(4), liquidity: +liquidity.toFixed(4), levelProximity: +levelProximity.toFixed(4), strategyConfidence: +strategyConfidence.toFixed(4), evidence: +evid.toFixed(4) };
  const quality = 0.22 * completeness + 0.18 * earliness + 0.15 * spread + 0.12 * liquidity + 0.11 * levelProximity + 0.12 * strategyConfidence + 0.10 * evid;
  return { quality: +quality.toFixed(4), components };
}

interface DDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }
const hasTable = (db: DDb, t: string) => { try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(t)); } catch { return false; } };

function strategyEvidenceOnDb(db: DDb | null, strategy: string): StrategyEvidence | null {
  if (!db || !hasTable(db, "options_paper_delivered")) return null;
  try {
    const r = db.prepare("SELECT COUNT(*) n, AVG(CASE WHEN return_pct > 0 THEN 1.0 ELSE 0.0 END) wr FROM options_paper_delivered WHERE strategy=? AND status='EXITED' AND return_pct IS NOT NULL").get(strategy) as any;
    return r && Number(r.n) > 0 ? { n: Number(r.n), winRate: Number(r.wr ?? 0) } : null;
  } catch { return null; }
}
function recentDeliveredClusters(db: DDb | null, nowMs: number, windowMs: number): Set<string> {
  const out = new Set<string>();
  if (!db || !hasTable(db, "options_alerts") || windowMs <= 0) return out;
  try {
    for (const r of db.prepare("SELECT candidate_symbol, side FROM options_alerts WHERE state='SENT' AND sent_at_ms >= ?").all(nowMs - windowMs) as any[]) out.add(clusterKey(String(r.candidate_symbol), String(r.side)));
  } catch { /* isolated */ }
  return out;
}

export interface DecisionDeps { getDb?: () => any; now?: () => number; deliver?: (input: DeliveryInput) => Promise<{ state: string; alertId: string; sent: boolean }> }

/**
 * Decide one batch: rank every candidate against every other, apply the subscriber bar / cluster rules /
 * flush cap, deliver only the winners, persist every decision with its full rationale. PURE decisioning
 * over injected deps; never throws into the monitor.
 */
export async function decideDeliveryBatch(batch: DeliverySubmission[], deps: DecisionDeps = {}, env: NodeJS.ProcessEnv = process.env): Promise<DeliveryDecision[]> {
  if (batch.length === 0) return [];
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const cfg = decisionConfig(env);
  const session = sessionState(nowMs, env);
  const deliverBar = +(cfg.deliverBar + (session === "OPENING_DISCOVERY" ? cfg.openingBump : 0)).toFixed(4);

  let db: DDb | null = null;
  try { db = deps.getDb ? deps.getDb() : null; } catch { db = null; }

  // 1. score every candidate with the single calibrated model (+ historical evidence where available)
  const evidenceCache = new Map<string, StrategyEvidence | null>();
  const scored = batch.map((s) => {
    if (!evidenceCache.has(s.strategy)) evidenceCache.set(s.strategy, strategyEvidenceOnDb(db, s.strategy));
    const q = computeSubscriberQuality(s, evidenceCache.get(s.strategy) ?? null);
    return { s, ...q };
  });

  // 2. cross-candidate ranking — REUSE the existing deterministic rankCandidates (tier precedence first,
  //    then forming / move-completed / spread / liquidity / level proximity / extension / quality).
  const rankable: (RankableCandidate & { i: number })[] = scored.map((x, i) => ({
    i, symbol: x.s.symbol, tier: x.s.tier, forming: x.s.fractionMove == null || x.s.fractionMove < 0.75,
    moveCompletedPct: x.s.fractionMove ?? 0.5, spreadPct: x.s.spreadPct ?? 999, liquidity: x.s.openInterest ?? 0,
    levelProximityPct: x.s.levelProximityPct ?? 999, extensionPct: 0, quality: x.quality,
  }));
  const ranked = rankCandidates(rankable);

  // 3. walk in rank order: absolute bar → correlation cluster → flush cap. Independently EXCELLENT
  //    candidates may exceed the cluster rule and the cap; merely-acceptable ones never do.
  const recentClusters = recentDeliveredClusters(db, nowMs, cfg.correlationWindowMs);
  const takenClusters = new Set<string>();
  let delivered = 0;
  const decisions: (DeliveryDecision & { sub: DeliverySubmission })[] = [];
  for (let rank = 0; rank < ranked.length; rank++) {
    const x = scored[ranked[rank].i];
    const ck = clusterKey(x.s.symbol, x.s.side);
    const base: DeliveryDecision & { sub: DeliverySubmission } = {
      sub: x.s, symbol: x.s.symbol, strategy: x.s.strategy, side: x.s.side, tier: x.s.tier,
      outcome: "RESEARCH_ONLY", reason: "", quality: x.quality, components: x.components,
      rank: rank + 1, batchSize: batch.length, clusterKey: ck, threshold: deliverBar, sessionState: session,
      wouldDeliverSolo: x.quality >= deliverBar && !recentClusters.has(ck), alertId: null,
    };
    if (x.s.researchOnly || x.s.side === "put") { base.reason = "research_only_put"; decisions.push(base); continue; }
    if (x.quality < cfg.researchFloor) { base.outcome = "REJECT"; base.reason = `below_research_floor (${x.quality} < ${cfg.researchFloor})`; decisions.push(base); continue; }
    if (x.quality < deliverBar) { base.reason = `below_subscriber_threshold (${x.quality} < ${deliverBar})`; decisions.push(base); continue; }
    const excellent = x.quality >= cfg.excellentBar;
    if ((takenClusters.has(ck) || recentClusters.has(ck)) && !excellent) { base.reason = `withheld_correlation (cluster ${ck} already expressed; ${x.quality} < excellent ${cfg.excellentBar})`; decisions.push(base); continue; }
    if (delivered >= cfg.maxPerFlush && !excellent) { base.reason = `withheld_ranking (rank ${rank + 1}, ${delivered} stronger candidates already delivered this flush)`; decisions.push(base); continue; }
    base.outcome = "DELIVER_TO_DISCORD";
    base.reason = `subscriber_worthy: quality ${x.quality} ≥ bar ${deliverBar}${excellent ? " (independently excellent)" : ""}; rank ${rank + 1}/${batch.length}; cluster ${ck}`;
    takenClusters.add(ck); delivered += 1;
    decisions.push(base);
  }

  // 4. deliver the winners through the UNCHANGED hard-gated delivery (freshness/spread/chase/dedup/kill
  //    switch all re-checked there). A delivery failure never affects the recorded decision rationale.
  const deliver = deps.deliver ?? ((input: DeliveryInput) => deliverOptionsCallout(input, { getDb: deps.getDb }, env));
  for (const d of decisions) {
    if (d.outcome !== "DELIVER_TO_DISCORD") continue;
    try { const r = await deliver(d.sub.deliveryInput); d.alertId = r.alertId ?? null; } catch { /* isolated — hard gates may reject; the decision record stands */ }
  }

  // 5. persist EVERY decision with competing-candidate context (why others were withheld).
  if (db && hasTable(db, "options_delivery_decisions")) {
    const batchId = `bd_${nowMs}`;
    const competing = decisions.slice(0, 8).map((d) => ({ symbol: d.symbol, strategy: d.strategy, quality: d.quality, outcome: d.outcome, reason: d.reason.slice(0, 80) }));
    for (const d of decisions) {
      try {
        db.prepare(
          `INSERT INTO options_delivery_decisions (batch_id, symbol, strategy, side, tier, outcome, reason, quality, rank, batch_size, components_json, cluster_key, threshold, session_state, alert_id, would_deliver_solo, competing_json, created_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(batchId, d.symbol, d.strategy, d.side, d.tier, d.outcome, d.reason, d.quality, d.rank, d.batchSize, JSON.stringify(d.components), d.clusterKey, d.threshold, d.sessionState, d.alertId, d.wouldDeliverSolo ? 1 : 0, JSON.stringify(competing.filter((c) => !(c.symbol === d.symbol && c.strategy === d.strategy))), nowMs);
      } catch { /* isolated */ }
    }
  }
  return decisions.map(({ sub: _sub, ...rest }) => rest);
}

/** Read-only decision observability for GET (never triggers work). */
export function deliveryDecisionMetricsOnDb(db: DDb): Record<string, unknown> {
  if (!hasTable(db, "options_delivery_decisions")) return { available: false };
  const n = (sql: string, ...a: any[]) => { try { return Number((db.prepare(sql).get(...a) as any)?.n ?? 0); } catch { return 0; } };
  const avg = (sql: string) => { try { const v = (db.prepare(sql).get() as any)?.v; return v == null ? null : +Number(v).toFixed(4); } catch { return null; } };
  const byOutcome: Record<string, number> = {};
  try { for (const r of db.prepare("SELECT outcome, COUNT(*) c FROM options_delivery_decisions GROUP BY outcome").all() as any[]) byOutcome[r.outcome] = r.c; } catch { /* */ }
  return {
    available: true,
    candidatesRanked: n("SELECT COUNT(*) n FROM options_delivery_decisions"),
    byOutcome,
    delivered: byOutcome.DELIVER_TO_DISCORD ?? 0,
    researchOnly: byOutcome.RESEARCH_ONLY ?? 0,
    rejected: byOutcome.REJECT ?? 0,
    avgQuality: avg("SELECT AVG(quality) v FROM options_delivery_decisions"),
    avgDeliveredQuality: avg("SELECT AVG(quality) v FROM options_delivery_decisions WHERE outcome='DELIVER_TO_DISCORD'"),
    withheldByRanking: n("SELECT COUNT(*) n FROM options_delivery_decisions WHERE reason LIKE 'withheld_ranking%'"),
    withheldByCorrelation: n("SELECT COUNT(*) n FROM options_delivery_decisions WHERE reason LIKE 'withheld_correlation%'"),
    withheldByThreshold: n("SELECT COUNT(*) n FROM options_delivery_decisions WHERE reason LIKE 'below_subscriber_threshold%'"),
    bySession: (() => { const m: Record<string, number> = {}; try { for (const r of db.prepare("SELECT session_state s, COUNT(*) c FROM options_delivery_decisions WHERE outcome='DELIVER_TO_DISCORD' GROUP BY session_state").all() as any[]) m[r.s] = r.c; } catch { /* */ } return m; })(),
  };
}
