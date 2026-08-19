/**
 * Portfolio-level delivery decision layer.
 *
 * Intent is stored separately from final delivery outcome:
 * - outcome: deterministic portfolio decision intent.
 * - finalDeliveryOutcome: what actually happened after hard-gated delivery ran.
 */
import { rankCandidates, type RankableCandidate } from "./ranking.ts";
import { deliverOptionsCallout, type DeliveryInput } from "./delivery.ts";
import { markOptionsDeliveryDecisionOnDb } from "./latency-telemetry.ts";
import { sessionState, type SessionState } from "./session-state.ts";
import { OPTIONS_TIER0 } from "./discovery.ts";
import { assertOptionsOpeningSession, assertSubscriberDeliveryAllowed, evaluateMarketSessionGuard, isSameTradingSession } from "../../market-session-guard.ts";
import { evaluateEntryQuality, entryQualityFromDelivery } from "../../entry-quality-gate.ts";
import { markCandidatesBatchEntered } from "./instrumentation.ts";
import { recordProposedShadowFromDelivery } from "./shadow-runner.ts";
import { buildShadowRecord, isShadowEligible } from "./prospective-shadow.ts";
import { LHC_SELECT_V1 } from "./experiment-registry.ts";
import { deployInfo } from "../../build-info.ts";
import {
  registerExperimentOnDb, recordShadowDecisionOnDb, linkPaperTradeOnDb,
  currentStatusOnDb, recordStatusOnDb, type ShadowDb,
} from "./shadow-arm-store.ts";
import {
  evaluateBearishAuthority,
  formatBearishOwnerReview,
  type BearishAuthorityDecision,
} from "./bearish-authority.ts";
import { openBearishResearchPaperOnDb } from "./bearish-research-paper.ts";
import { openOwnerValidationPaperOnDb } from "./owner-validation-paper.ts";
import { formatPrivateLiveAlert } from "./format.ts";
import { subscriberEligibility } from "./strategy-readiness.ts";
import {
  attachEvidenceToOpportunityOnDb,
  claimOpportunityOpenOnDb,
  markOwnerActionableOpeningDeliveredOnDb,
  recordOwnerMirrorOutcomeOnDb,
  releaseOpportunityOpeningClaimOnDb,
} from "../../opportunity-case/live.ts";
import { recordPreMoveAlertOnDb } from "./pre-move-store.ts";
import { recordPreMoveV2AlertOnDb } from "./pre-move-v2-store.ts";
import { preMoveCaseIdForFingerprint } from "../../opportunity-case/owner-mirror-identity.ts";

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
    deliverBar: n(env.OPTIONS_QUALITY_DELIVER_BAR, 0.70, 0, 1),
    openingBump: n(env.OPTIONS_QUALITY_OPENING_BUMP, 0.06, 0, 0.3),
    excellentBar: n(env.OPTIONS_QUALITY_EXCELLENT_BAR, 0.78, 0, 1),
    researchFloor: n(env.OPTIONS_QUALITY_RESEARCH_FLOOR, 0.35, 0, 1),
    maxPerFlush: n(env.OPTIONS_MAX_DELIVER_PER_FLUSH, 1, 1, 10),
    correlationWindowMs: n(env.OPTIONS_CORRELATION_WINDOW_MS, 15 * 60_000, 0, 3_600_000),
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const TIER0_SET = new Set<string>([...OPTIONS_TIER0, "DIA"]);

/**
 * The strategy version a submission was produced by. The catalog does not yet version
 * strategies individually, so "1" is the single live version — named explicitly rather
 * than left implicit, so readiness records key on something stable and a future real
 * version bump is a one-line change here.
 */
export const CURRENT_STRATEGY_VERSION = "1";
const strategyVersionOf = (_s: DeliverySubmission): string => CURRENT_STRATEGY_VERSION;

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
  ownerPostOverride?: (content: string) => Promise<{
    ok: boolean;
    reason?: string;
    messageId?: string | null;
    deliveryId?: string | null;
  }>;
}

function skipped(reason: string): Pick<DeliveryDecision, "deliveryAttempted" | "deliverySent" | "deliveryState" | "finalDeliveryOutcome" | "deliveryFailureCategory" | "finalDeliveryReason"> {
  return { deliveryAttempted: false, deliverySent: false, deliveryState: null, finalDeliveryOutcome: "SKIPPED", deliveryFailureCategory: null, finalDeliveryReason: reason };
}

export interface OwnerOpeningResult {
  sent: boolean;
  reason: string;
  opportunityCaseId: string | null;
  /** The canonical mirror on the SAME exact OCC. Null means the opening left no evidence. */
  paperTradeId?: number | null;
  paperReason?: string;
}

/**
 * Emit an owner-private opening for a candidate the deterministic pipeline qualified but
 * subscribers will not receive.
 *
 * Side-agnostic on purpose. Owner Discord openings were historically carried by the same
 * DELIVER_TO_DISCORD path subscribers used, so when the readiness gate closed that path it
 * silenced the owner on BOTH lanes at once. Restoring only puts would leave qualified calls
 * invisible for the same reason.
 */
async function sendOwnerPrivateOpening(
  db: DDb,
  s: DeliverySubmission,
  opts: {
    side: "call" | "put";
    direction: "bullish" | "bearish";
    quality: number;
    nowMs: number;
    env: NodeJS.ProcessEnv;
    buildContent: (claim: { opportunityCaseId: string; baseUrl: string }) => string;
    why: string | null;
    readinessState?: string | null;
    postOverride?: DecisionDeps["ownerPostOverride"];
  },
): Promise<OwnerOpeningResult> {
  const { side, direction, quality, nowMs, env } = opts;
  let claimedCaseId: string | null = null;
  try {
    const { sendOwnerResearchNotify } = await import("../../notifications/owner-research-notify.ts");
    const d = s.deliveryInput;
    const claim = claimOpportunityOpenOnDb(db as any, {
      symbol: s.symbol,
      side,
      expiration: d.contract.expiration,
      strike: d.contract.strike,
      strategyKey: s.strategy,
      nowMs,
      direction,
      quality,
      frozenEntry: d.entry?.mid ?? null,
      frozenTrade: d.entry
        ? {
            entryMid: d.entry.mid,
            targetT1: d.entry.t1,
            targetT2: d.entry.t2,
            stop: d.entry.stop,
            bid: d.entry.bid,
            ask: d.entry.ask,
            spreadPct: d.entry.spreadPct,
            methodology: d.entry.methodology,
          }
        : null,
      optionSymbol: d.contract.optionSymbol,
      openingSource: "owner_actionable",
      contractSnapshot: {
        bid: d.contract.bid,
        ask: d.contract.ask,
        spreadPct: d.contract.spreadPct,
        delta: d.contract.delta,
        openInterest: d.contract.openInterest,
        volume: d.contract.volume,
      },
      why: opts.why,
    });
    if (!claim.claimed) {
      if (claim.existing) {
        attachEvidenceToOpportunityOnDb(db as any, {
          opportunityCaseId: claim.opportunityCaseId,
          nowMs,
          source: "owner_intraday_actionable",
          signalType: "thesis_repeat_owner_signal",
          score: quality,
          details: {
            opportunityFingerprint: claim.fingerprint,
            thesisFingerprint: claim.thesisFingerprint,
            optionSymbol: d.contract.optionSymbol,
            strategy: s.strategy,
          },
          strengthen: true,
          currentMark: d.contract.bid,
          markOptionSymbol: d.contract.optionSymbol,
        });
        return {
          sent: false,
          reason: claim.reason,
          opportunityCaseId: claim.opportunityCaseId,
        };
      }
      return {
        sent: false,
        reason: `owner_thesis_claim_failed:${claim.reason}`,
        opportunityCaseId: claim.opportunityCaseId,
      };
    }
    claimedCaseId = claim.opportunityCaseId;
    const baseUrl = String(env.PUBLIC_APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
    const content = opts.buildContent({ opportunityCaseId: claim.opportunityCaseId, baseUrl });
    const sent = await sendOwnerResearchNotify({
      db: db as any,
      kind: "intraday_actionable",
      content,
      symbol: `${claim.thesisFingerprint}:OPENING`,
      idempotencyKey: `owner:options:${claim.thesisFingerprint}:OPENING`,
      opportunityCaseId: claim.opportunityCaseId,
      thesisFingerprint: claim.thesisFingerprint,
      lifecycleState: "OPENING",
      // Every opening on this path is owner-private and NOT subscriber-approved —
      // both callers are the readiness-gate rejection and the bearish owner review.
      // A subscriber-grade callout never reaches sendOwnerPrivateOpening.
      researchObservation: true,
      env: { ...env, OWNER_RESEARCH_DISCORD_ENABLED: "1", OWNER_RESEARCH_INTRADAY_ENABLED: "1" } as NodeJS.ProcessEnv,
      nowMs,
      postOverride: opts.postOverride,
    });
    if (!sent.sent) {
      releaseOpportunityOpeningClaimOnDb(db as any, claim.opportunityCaseId);
      return { sent: false, reason: sent.reason, opportunityCaseId: claim.opportunityCaseId };
    }
    markOwnerActionableOpeningDeliveredOnDb(db as any, {
      opportunityCaseId: claim.opportunityCaseId,
      discordMessageId: sent.messageId ?? null,
      nowMs,
      quality,
    });
    // An owner opening without a mirror on the SAME exact OCC produces no forward evidence,
    // which is the failure this lane exists to avoid. Isolated: the alert is already sent and
    // a mirror failure must never retract it, but it is reported so the gap stays visible.
    let paper: { opened: boolean; reason: string; paperTradeId: number | null } = {
      opened: false, reason: "not_attempted", paperTradeId: null,
    };
    try {
      paper = openOwnerValidationPaperOnDb(db as any, {
        deliveryInput: s.deliveryInput,
        quality,
        nowMs,
        opportunityCaseId: claim.opportunityCaseId,
        thesisFingerprint: claim.thesisFingerprint,
        readinessState: opts.readinessState ?? null,
        ownerReason: opts.why,
      }, env);
    } catch (err: any) {
      paper = { opened: false, reason: String(err?.message ?? err).slice(0, 120), paperTradeId: null };
    }
    // The reason used to be returned and then discarded, so a missing mirror was
    // visible but not diagnosable. Persist it against the case the audit already reads.
    recordOwnerMirrorOutcomeOnDb(db as any, {
      opportunityCaseId: claim.opportunityCaseId,
      opened: paper.opened,
      reason: paper.reason,
      paperTradeId: paper.paperTradeId,
      nowMs,
    });
    // PRE_MOVE_DISCOVERY_V1: the owner has now actually been notified, so this is the
    // moment lead time is measured from and the moment the row becomes the OWNER lane.
    // It runs AFTER the send, never before — a row claiming an alert that was not
    // delivered would make every lead time measured against it a fiction. Isolated for
    // the same reason as the mirror: the alert is out and no measurement may retract it.
    try {
      recordPreMoveAlertOnDb(db as any, {
        opportunityCaseId: claim.opportunityCaseId,
        // The observation row is written by the scanner under the PENDING audit case, a
        // different `opportunity_cases` row from the one this claim just minted. Keyed on
        // the claim id alone, this promotion matched zero rows for its entire life — the
        // OWNER lane was permanently empty and every lead time unmeasurable. The pending
        // id is a pure function of the fingerprint both rows carry, so it is derived here
        // rather than stored. Additive: it writes only to the audit table, after the send.
        preMoveCaseId: preMoveCaseIdForFingerprint(claim.fingerprint),
        ownerNotifiedAtMs: nowMs,
        underlyingAtAlert: s.deliveryInput.underlyingPrice ?? s.deliveryInput.currentUnderlyingPrice ?? null,
        // The ask at alert is what the owner would have paid, matching the ask recorded
        // at detection. Comparing a frozen mid against a detection ask would report an
        // expansion that is really just half a spread.
        optionAtAlert: s.deliveryInput.contract?.ask ?? null,
        lane: "OWNER",
      });
    } catch { /* isolated */ }
    // PRE_MOVE_DISCOVERY_V2: the alert-instant snapshot, taken HERE because here is the
    // only moment it is true. V2's denominator is the session's high-to-low range, and
    // the V1 row keeps that range as a running MAX/MIN for the whole life of the case —
    // reading it later would let the rest of the day enlarge the denominator of a
    // decision made now, and every callout would look earlier the longer its session
    // ran. Write-once, measurement only, and isolated for the same reason as the mirror:
    // the alert is already out and no measurement may retract it.
    try {
      const fs = (s.deliveryInput.featureSnapshot as { underlying?: Record<string, unknown> } | null)?.underlying ?? {};
      const fnum = (v: unknown): number | null => {
        const x = Number(v);
        return v == null || v === "" || !Number.isFinite(x) ? null : x;
      };
      const isCall = s.deliveryInput.contract.side === "call";
      // Direction-specific, exactly as the V1 capture site derives it: a call waits on
      // resistance above, a put on support below. One level for both would report every
      // put as pre-trigger.
      const brokeFavorably = isCall ? fs.hodBreak : fs.lodBreak;
      recordPreMoveV2AlertOnDb(db as any, {
        opportunityCaseId: claim.opportunityCaseId,
        preMoveCaseId: preMoveCaseIdForFingerprint(claim.fingerprint),
        side: isCall ? "CALL" : "PUT",
        ownerNotifiedAtMs: nowMs,
        underlyingAtAlert: s.deliveryInput.underlyingPrice ?? s.deliveryInput.currentUnderlyingPrice ?? null,
        sessionHighAtAlert: fnum(fs.hod),
        sessionLowAtAlert: fnum(fs.lod),
        sessionOpenAtAlert: fnum(fs.sessionOpen) ?? fnum(fs.open),
        vwapAtAlert: fnum(fs.vwap),
        triggerLevelAtAlert: isCall ? fnum(fs.nearestResistance) : fnum(fs.nearestSupport),
        triggerTakenAtAlert: brokeFavorably == null ? null : brokeFavorably === true,
        optionAtAlert: s.deliveryInput.contract?.ask ?? null,
        optionAtFirstDetection: s.deliveryInput.optionAtFirstDetection ?? null,
        underlyingAtFirstDetection: s.deliveryInput.underlyingAtFirstDetection ?? null,
        firstSetupObservedAtMs: s.deliveryInput.firstDetectedAtMs ?? null,
        firstFullConfirmationAtMs: s.deliveryInput.firstReadyAtMs ?? null,
        // The frozen premiums the owner was actually shown. Never a later, better level:
        // a target time measured against an improved entry is a target the callout never
        // set.
        entryPremium: s.deliveryInput.entry?.mid ?? null,
        target1Premium: s.deliveryInput.entry?.t1 ?? null,
        target2Premium: s.deliveryInput.entry?.t2 ?? null,
        stopPremium: s.deliveryInput.entry?.stop ?? null,
      });
    } catch { /* isolated */ }
    return {
      sent: true,
      reason: "sent",
      opportunityCaseId: claim.opportunityCaseId,
      paperTradeId: paper.paperTradeId,
      paperReason: paper.reason,
    };
  } catch (error: any) {
    if (claimedCaseId) {
      try {
        releaseOpportunityOpeningClaimOnDb(db as any, claimedCaseId);
      } catch { /* isolated */ }
    }
    return {
      sent: false,
      reason: `owner_review_failed:${String(error?.message ?? error).slice(0, 120)}`,
      opportunityCaseId: claimedCaseId,
    };
  }
}

export async function maybeSendBearishOwnerReview(
  db: DDb | null,
  s: DeliverySubmission,
  decision: BearishAuthorityDecision,
  quality: number,
  threshold: number,
  nowMs: number,
  env: NodeJS.ProcessEnv,
  postOverride?: DecisionDeps["ownerPostOverride"],
): Promise<OwnerOpeningResult> {
  if (!db || !shouldSendBearishOwnerReview(decision, env)) {
    return { sent: false, reason: "owner_review_not_enabled", opportunityCaseId: null };
  }
  return sendOwnerPrivateOpening(db, s, {
    side: "put",
    direction: "bearish",
    quality,
    nowMs,
    env,
    why: decision.reasons[0] ?? null,
    readinessState: decision.state,
    postOverride,
    buildContent: ({ baseUrl }) => formatBearishOwnerReview({
      symbol: s.symbol,
      side: "put",
      strategy: s.strategy,
      researchOnly: s.researchOnly,
      quality,
      threshold,
      matchedSignals: s.matchedSignals,
      requiredSignals: s.requiredSignals,
      strategyScore: s.strategyScore,
      fractionMove: s.fractionMove,
      deliveryInput: s.deliveryInput,
      nowMs,
    }, decision, `${baseUrl}/alerts?tab=history`),
  });
}

/**
 * The owner opening for a candidate the readiness gate — and only the readiness gate — refused.
 *
 * By the time this runs the candidate has cleared session, research floor, late-phase, the
 * subscriber quality bar, correlation, ranking and entry quality. The single remaining reason
 * it is not being delivered is that the strategy/version is not SUBSCRIBER_APPROVED, which is
 * a statement about SUBSCRIBERS. It must not also cost the owner the observation.
 */
export async function maybeSendReadinessGatedOwnerOpening(
  db: DDb | null,
  s: DeliverySubmission,
  quality: number,
  readinessState: string,
  nowMs: number,
  env: NodeJS.ProcessEnv,
  postOverride?: DecisionDeps["ownerPostOverride"],
): Promise<OwnerOpeningResult> {
  if (!db || env.OWNER_RESEARCH_DISCORD_ENABLED !== "1") {
    return { sent: false, reason: "owner_research_discord_not_enabled", opportunityCaseId: null };
  }
  const c = s.deliveryInput.contract;
  const e = s.deliveryInput.entry;
  return sendOwnerPrivateOpening(db, s, {
    side: s.side,
    direction: s.side === "put" ? "bearish" : "bullish",
    quality,
    nowMs,
    env,
    why: `readiness_gate:NOT_SUBSCRIBER_APPROVED:${readinessState}`,
    readinessState,
    postOverride,
    buildContent: ({ opportunityCaseId, baseUrl }) => formatPrivateLiveAlert({
      lane: "OWNER_ONLY",
      readinessState,
      symbol: s.symbol,
      side: s.side,
      strike: c.strike,
      expiration: c.expiration,
      entryMid: e?.mid ?? ((c.bid ?? 0) + (c.ask ?? 0)) / 2,
      t1: e?.t1 ?? 0,
      t2: e?.t2 ?? 0,
      stop: e?.stop ?? 0,
      strategyKey: s.strategy,
      dte: c.dte ?? null,
      optionSymbol: c.optionSymbol,
      bid: c.bid,
      ask: c.ask,
      opportunityCaseId,
      detailUrl: `${baseUrl}/alerts?tab=history`,
    }),
  });
}

export function shouldSendBearishOwnerReview(
  decision: Pick<BearishAuthorityDecision, "state">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.BEARISH_OWNER_ALERTS_ENABLED === "1" && decision.state === "BEARISH_READY";
}

function classifyDeliveryResult(r: { state: string; sent: boolean; reason?: string | null }) {
  const state = String(r.state ?? "");
  const reason = r.reason == null ? null : String(r.reason);
  const text = `${state} ${reason ?? ""}`.toLowerCase();
  if (r.sent && state === "SENT") return { finalDeliveryOutcome: "DELIVERED" as const, category: null, reason: reason ?? "delivered" };
  if (text.includes("kill_switch")) return { finalDeliveryOutcome: "BLOCKED_KILL_SWITCH" as const, category: "kill_switch", reason };
  if (state === "SEND_RECONCILE_REQUIRED") {
    return { finalDeliveryOutcome: "DOWNSTREAM_ERROR" as const, category: "paper_reconciliation", reason };
  }
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

  const strictOpeningSession = assertOptionsOpeningSession(nowMs, env);
  if (!strictOpeningSession.ok) {
    return batch.map((s, i) => ({
      symbol: s.symbol,
      strategy: s.strategy,
      side: s.side,
      tier: s.tier,
      outcome: "REJECT" as const,
      reason: `session_guard:${strictOpeningSession.guard.state}`,
      quality: 0,
      components: {},
      rank: i + 1,
      batchSize: batch.length,
      clusterKey: clusterKey(s.symbol, s.side),
      threshold: deliverBar,
      sessionState: session,
      wouldDeliverSolo: false,
      alertId: null,
      deliveryAttempted: false,
      deliverySent: false,
      deliveryState: null,
      finalDeliveryOutcome: "REJECTED" as const,
      deliveryFailureCategory: "session_guard",
      finalDeliveryReason: "Options market closed; candidate remains eligible for next-session Watchlist research.",
    }));
  }
  const sessionGuard = assertSubscriberDeliveryAllowed(nowMs, env);
  const guardMode = String(env.MARKET_SESSION_GUARD ?? "shadow").toLowerCase();
  const marketGuard = evaluateMarketSessionGuard(nowMs, env);
  const minutesToSessionClose = Math.round((marketGuard.regularCloseMs - nowMs) / 60000);
  if (!sessionGuard.ok && guardMode !== "shadow" && guardMode !== "0") {
    return batch.map((s, i) => ({
      symbol: s.symbol,
      strategy: s.strategy,
      side: s.side,
      tier: s.tier,
      outcome: "REJECT" as const,
      reason: `session_guard:${sessionGuard.guard.state}`,
      quality: 0,
      components: {},
      rank: i + 1,
      batchSize: batch.length,
      clusterKey: clusterKey(s.symbol, s.side),
      threshold: deliverBar,
      sessionState: session,
      wouldDeliverSolo: false,
      alertId: null,
      deliveryAttempted: false,
      deliverySent: false,
      deliveryState: null,
      finalDeliveryOutcome: "REJECTED" as const,
      deliveryFailureCategory: "session_guard",
      finalDeliveryReason: sessionGuard.guard.reason,
    }));
  }

  let db: DDb | null = null;
  try { db = deps.getDb ? deps.getDb() : null; } catch { db = null; }
  if (db) markCandidatesBatchEntered(db, batch.map((s) => s.symbol), nowMs);

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
    forming: x.s.fractionMove == null || x.s.fractionMove <= 0.4,
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
    const candidateSession = x.s.deliveryInput.tradingSessionDate ?? null;
    if (candidateSession && !isSameTradingSession(candidateSession, nowMs)) {
      decisions.push({
        sub: x.s,
        symbol: x.s.symbol,
        strategy: x.s.strategy,
        side: x.s.side,
        tier: x.s.tier,
        outcome: "REJECT",
        reason: "EXPIRED_TRADING_SESSION",
        quality: x.quality,
        components: x.components,
        rank: rank + 1,
        batchSize: batch.length,
        clusterKey: ck,
        threshold: deliverBar,
        sessionState: session,
        wouldDeliverSolo: false,
        alertId: null,
        deliveryAttempted: false,
        deliverySent: false,
        deliveryState: null,
        finalDeliveryOutcome: "REJECTED",
        deliveryFailureCategory: "expired_trading_session",
        finalDeliveryReason: `candidate session ${candidateSession} != current session`,
      });
      continue;
    }
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

    // Resolved BEFORE the bearish branch: the bearish authority must not call a candidate
    // BEARISH_SEND when the readiness gate is going to refuse it, because SEND skips the
    // owner path and the refusal would then silence every channel at once.
    const readiness = subscriberEligibility(db as any, x.s.strategy, strategyVersionOf(x.s), env);

    if (x.s.side === "put") {
      const auth = evaluateBearishAuthority({
        symbol: x.s.symbol,
        side: "put",
        strategy: x.s.strategy,
        researchOnly: x.s.researchOnly,
        subscriberApproved: readiness.allowed,
        quality: x.quality,
        threshold: deliverBar,
        matchedSignals: x.s.matchedSignals,
        requiredSignals: x.s.requiredSignals,
        strategyScore: x.s.strategyScore,
        fractionMove: x.s.fractionMove,
        deliveryInput: x.s.deliveryInput,
        nowMs,
      }, env);
      await maybeSendBearishOwnerReview(
        db,
        x.s,
        auth,
        x.quality,
        deliverBar,
        nowMs,
        env,
        deps.ownerPostOverride,
      );
      if (!auth.maySubscriberSend) {
        if (db) {
          try {
            openBearishResearchPaperOnDb(db as any, {
              deliveryInput: x.s.deliveryInput,
              authority: auth,
              quality: x.quality,
              nowMs,
            }, env);
          } catch { /* research paper must never affect delivery */ }
        }
        base.reason = auth.reasonCode;
        base.finalDeliveryReason = `${auth.state}: ${auth.blockers.join("; ") || auth.reasons.join("; ") || auth.reasonCode}`;
        if (auth.state === "BEARISH_BLOCK") {
          base.outcome = "REJECT";
          base.finalDeliveryOutcome = "REJECTED";
          base.deliveryFailureCategory = "bearish_authority";
        }
        decisions.push(base);
        continue;
      }
    } else if (x.s.researchOnly) { base.reason = "research_only"; base.finalDeliveryReason = base.reason; decisions.push(base); continue; }
    if (x.quality < cfg.researchFloor) {
      base.outcome = "REJECT";
      base.reason = `below_research_floor (${x.quality} < ${cfg.researchFloor})`;
      base.finalDeliveryOutcome = "REJECTED";
      base.finalDeliveryReason = base.reason;
      decisions.push(base);
      continue;
    }
    if (x.s.fractionMove != null && x.s.fractionMove >= 0.75) {
      base.reason = `late_phase_fraction_move (${x.s.fractionMove} >= 0.75)`;
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
    const eqInput = entryQualityFromDelivery({
      side: x.s.side,
      dte: x.s.deliveryInput.contract.dte ?? null,
      underlyingNow: x.s.deliveryInput.currentUnderlyingPrice,
      optionNow: x.s.deliveryInput.entry?.mid ?? ((x.s.deliveryInput.contract.bid ?? 0) + (x.s.deliveryInput.contract.ask ?? 0)) / 2,
      observedUnderlyingPrice: x.s.deliveryInput.observedUnderlyingPrice,
      contract: x.s.deliveryInput.contract,
      entry: x.s.deliveryInput.entry ?? null,
      firstDetectedAtMs: x.s.deliveryInput.firstDetectedAtMs,
      underlyingAtFirstDetection: x.s.deliveryInput.underlyingAtFirstDetection,
      optionAtFirstDetection: x.s.deliveryInput.optionAtFirstDetection,
      featureSnapshot: x.s.deliveryInput.featureSnapshot ?? null,
      minutesToSessionClose,
      sessionState: session,
      nowMs,
    }, nowMs, env);
    const eq = evaluateEntryQuality(eqInput, env);
    if (db) {
      recordProposedShadowFromDelivery(db, x.s.deliveryInput, {
        firstDetectedAtMs: x.s.deliveryInput.firstDetectedAtMs,
        underlyingAtFirstDetection: x.s.deliveryInput.underlyingAtFirstDetection,
        optionAtFirstDetection: x.s.deliveryInput.optionAtFirstDetection,
        featureSnapshot: x.s.deliveryInput.featureSnapshot,
      }, env);
    }
    if (eq.composite.subscriberAction === "BLOCK" && String(env.ENTRY_QUALITY_GATE ?? "shadow").toLowerCase() === "enforce") {
      base.outcome = "REJECT";
      base.reason = `entry_quality:${eq.composite.primaryVerdict}`;
      base.finalDeliveryOutcome = "REJECTED";
      base.finalDeliveryReason = eq.composite.reasons.join("; ") || eq.composite.primaryVerdict;
      decisions.push(base);
      continue;
    }
    // Subscriber eligibility must be EXPLICIT. Clearing a quality bar says a setup looked
    // good right now; it says nothing about whether this strategy VERSION has ever been
    // worth sending. The audited population (expectancy -7.2%, profit factor 0.49) is what
    // implied eligibility produced. Fails closed: an unassessed version is RESEARCH_ONLY.
    if (!readiness.allowed) {
      base.reason = `readiness_gate:${readiness.reasonCode}`;
      base.finalDeliveryReason = `strategy ${x.s.strategy} is ${readiness.state}; subscriber openings require SUBSCRIBER_APPROVED`;
      // Subscribers stay gated; the owner still gets the observation. Puts never arrive here
      // — an unapproved put is BEARISH_READY and was already mirrored above — so this is the
      // call lane, which had no owner path of its own once DELIVER_TO_DISCORD closed.
      const owner = await maybeSendReadinessGatedOwnerOpening(
        db,
        x.s,
        x.quality,
        readiness.state,
        nowMs,
        env,
        deps.ownerPostOverride,
      );
      if (owner.sent) base.finalDeliveryReason += "; owner opening delivered";
      decisions.push(base);
      continue;
    }
    base.outcome = "DELIVER_TO_DISCORD";
    base.reason = `subscriber_worthy: quality ${x.quality} >= bar ${deliverBar}${excellent ? " (independently excellent)" : ""}; rank ${rank + 1}/${batch.length}; cluster ${ck}; readiness ${readiness.state}`;
    base.finalDeliveryReason = "selected_for_delivery";
    takenClusters.add(ck);
    selected += 1;
    decisions.push(base);
  }

  if (db) {
    try {
      for (const d of decisions) {
        const traceId = d.sub.deliveryInput.latencyTrace?.traceId;
        if (traceId) markOptionsDeliveryDecisionOnDb(db, traceId, nowMs, d.finalDeliveryOutcome, d.alertId);
      }
    } catch { /* telemetry must never alter ranking or delivery */ }
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

  if (db) {
    try {
      for (const d of decisions) {
        const traceId = d.sub.deliveryInput.latencyTrace?.traceId;
        if (traceId) markOptionsDeliveryDecisionOnDb(db, traceId, nowMs, d.finalDeliveryOutcome, d.alertId);
      }
    } catch { /* telemetry must never alter a completed delivery */ }
  }

  // PROSPECTIVE SHADOW ARM — LHC_SELECT_V1 evaluated on the SAME opportunities the baseline
  // just decided, recorded before any outcome exists. Reads `decisions`; changes nothing in
  // them. Fully isolated: a failure here must never affect a delivery that already happened.
  if (db) {
    try { recordShadowArmForBatch(db, decisions, nowMs); } catch { /* isolated */ }
  }

  if (db && hasTable(db, "options_delivery_decisions")) {
    const batchId = `bd_${nowMs}`;
    const competing = decisions.slice(0, 8).map((d) => ({ symbol: d.symbol, strategy: d.strategy, quality: d.quality, outcome: d.outcome, finalDeliveryOutcome: d.finalDeliveryOutcome, reason: d.reason.slice(0, 80) }));
    for (const d of decisions) {
      const latencyMs = d.sub.deliveryInput.firstDetectedAtMs ? nowMs - d.sub.deliveryInput.firstDetectedAtMs : null;
      const eqInput = entryQualityFromDelivery({
        side: d.sub.side,
        dte: d.sub.deliveryInput.contract.dte ?? null,
        underlyingNow: d.sub.deliveryInput.currentUnderlyingPrice,
        optionNow: d.sub.deliveryInput.entry?.mid ?? ((d.sub.deliveryInput.contract.bid ?? 0) + (d.sub.deliveryInput.contract.ask ?? 0)) / 2,
        observedUnderlyingPrice: d.sub.deliveryInput.observedUnderlyingPrice,
        contract: d.sub.deliveryInput.contract,
        entry: d.sub.deliveryInput.entry ?? null,
        firstDetectedAtMs: d.sub.deliveryInput.firstDetectedAtMs,
        underlyingAtFirstDetection: d.sub.deliveryInput.underlyingAtFirstDetection,
        optionAtFirstDetection: d.sub.deliveryInput.optionAtFirstDetection,
        featureSnapshot: d.sub.deliveryInput.featureSnapshot ?? null,
        minutesToSessionClose,
        sessionState: d.sessionState,
        nowMs,
      }, nowMs, env);
      const eq = evaluateEntryQuality(eqInput, env);
      try {
        db.prepare(
          `INSERT INTO options_delivery_decisions (batch_id, symbol, strategy, side, tier, outcome, reason, quality, rank, batch_size, components_json, cluster_key, threshold, session_state, alert_id, would_deliver_solo, competing_json, delivery_attempted, delivery_sent, delivery_state, final_delivery_outcome, delivery_failure_category, final_delivery_reason, delivery_attempted_at_ms, delivery_completed_at_ms, entry_quality_verdict, delivery_latency_ms, batch_entered_at_ms, created_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          batchId, d.symbol, d.strategy, d.side, d.tier, d.outcome, d.reason, d.quality, d.rank, d.batchSize,
          JSON.stringify(d.components), d.clusterKey, d.threshold, d.sessionState, d.alertId, d.wouldDeliverSolo ? 1 : 0,
          JSON.stringify(competing.filter((c) => !(c.symbol === d.symbol && c.strategy === d.strategy))),
          d.deliveryAttempted ? 1 : 0, d.deliverySent ? 1 : 0, d.deliveryState, d.finalDeliveryOutcome,
          d.deliveryFailureCategory, d.finalDeliveryReason, d.deliveryAttempted ? nowMs : null, d.deliveryAttempted ? nowMs : null,
          eq.composite.primaryVerdict, latencyMs, nowMs, nowMs,
        );
      } catch {
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
  }

  return decisions.map(({ sub: _sub, ...rest }) => rest);
}

/**
 * Record the prospective shadow arm for every `lower_high_continuation` candidate in this
 * batch.
 *
 * The baseline decision is READ, never influenced: `outcome === "DELIVER_TO_DISCORD"` is what
 * the portfolio layer already chose, and the experiment's verdict is written beside it. Rows
 * where BOTH arms reject are written too — without them the denominator is only the trades
 * somebody already liked, and "losses avoided" becomes unmeasurable.
 *
 * Isolated per row: one malformed candidate must not cost the rest of the batch its evidence.
 */
function recordShadowArmForBatch(
  db: DDb,
  decisions: readonly (DeliveryDecision & { sub: DeliverySubmission })[],
  nowMs: number,
): void {
  const eligible = decisions.filter((d) => isShadowEligible(d.strategy));
  if (!eligible.length) return;

  // Register the frozen experiment on first use. A hash conflict means the rule changed under
  // a live sample; the row is refused rather than overwritten, and nothing is recorded against
  // an experiment whose identity is in doubt.
  const reg = registerExperimentOnDb(db as unknown as ShadowDb, LHC_SELECT_V1, nowMs);
  if (!reg.ok) return;
  if (currentStatusOnDb(db as unknown as ShadowDb, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion) == null) {
    try {
      recordStatusOnDb(db as unknown as ShadowDb, {
        experimentId: LHC_SELECT_V1.experimentId,
        experimentVersion: LHC_SELECT_V1.experimentVersion,
        status: "PROPOSED",
        reason: "registered by the prospective shadow arm on first eligible candidate",
        actor: "deterministic",
      }, nowMs);
    } catch { /* isolated */ }
  }

  // Statically imported: a lazy `require` that fails to resolve would silently stamp every row
  // in the batch RUNTIME_SHA_UNAVAILABLE, turning a resolution bug into what looks like a
  // deployment problem.
  const sha = (() => { try { return deployInfo().commit ?? null; } catch { return null; } })();

  for (const d of eligible) {
    try {
      const i = d.sub.deliveryInput;
      const c = i.contract;
      const record = buildShadowRecord({
        symbol: d.symbol,
        strategy: d.strategy,
        side: d.sub.side,
        direction: d.sub.side === "put" ? "bearish" : "bullish",
        optionSymbol: c.optionSymbol,
        strike: c.strike ?? null,
        expiration: c.expiration ?? null,
        dte: c.dte ?? null,
        bid: c.bid ?? null,
        ask: c.ask ?? null,
        spreadPct: d.sub.spreadPct ?? c.spreadPct ?? null,
        volume: c.volume ?? null,
        openInterest: c.openInterest ?? null,
        iv: c.iv ?? null,
        delta: c.delta ?? null,
        underlyingPrice: i.underlyingPrice ?? null,
        baselineOutcome: d.outcome,
        baselineAdmitted: d.outcome === "DELIVER_TO_DISCORD",
        baselineReason: d.reason,
        baselineQuality: d.quality,
        opportunityCaseId: null,
        alertId: d.alertId,
        sessionState: d.sessionState,
        nowMs,
        decisionMs: i.decisionMs ?? null,
        firstDetectedAtMs: i.firstDetectedAtMs ?? null,
        firstReadyAtMs: i.firstReadyAtMs ?? null,
        underlyingAtFirstDetection: i.underlyingAtFirstDetection ?? null,
        optionAtFirstDetection: i.optionAtFirstDetection ?? null,
        featureSnapshot: i.featureSnapshot ?? null,
      }, { deploymentSha: sha, population: "DELIVERED_ALERT_PAPER" });

      const { decisionKey: key } = recordShadowDecisionOnDb(db as unknown as ShadowDb, record, nowMs);

      // Link the canonical mirror when the baseline actually opened one, so the SAME contract
      // trajectory serves both arms and no duplicate provider work is created.
      if (d.deliverySent && d.alertId) {
        try {
          const row = db.prepare("SELECT paper_trade_id FROM options_alerts WHERE alert_id=?").get(d.alertId) as any;
          if (row?.paper_trade_id != null) {
            linkPaperTradeOnDb(db as unknown as ShadowDb, key, Number(row.paper_trade_id), nowMs);
          }
        } catch { /* isolated */ }
      }
    } catch { /* isolated per row */ }
  }
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
