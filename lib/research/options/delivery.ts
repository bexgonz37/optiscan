/**
 * lib/research/options/delivery.ts — GATED private-beta options Discord delivery. One message per
 * play, honest send states, idempotent, isolated. HARD no-op unless BOTH
 * INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1 AND EARLY_OPTIONS_CALLOUTS_ENABLED=1 (and no kill switch).
 * A Discord failure NEVER blocks the monitor. Qualified puts can become actionable only after
 * bearish authority, final delivery validation, and explicit subscriber rollout flags pass.
 * Nothing here executes real money; the message carries a PAPER/BETA label.
 */
import { researchFlags } from "../flags.ts";
import {
  buildRealOptionEntry,
  finalizeDeliveredPaperReservationOnDb,
  reconcileDeliveredPaperSendFailureOnDb,
  reserveDeliveredPaperOnDb,
  type DeliveredPaperReservation,
  type OptionQuote,
} from "./paper.ts";
import { sessionState, openingWindowAllows, defaultOpeningLimit } from "./session-state.ts";
import type { FrozenEntry } from "./callout.ts";
import { OPTIONS_TIER0 } from "./discovery.ts";
import { assertOptionsOpeningSession, assertSubscriberDeliveryAllowed, isSameTradingSession } from "../../market-session-guard.ts";
import { evaluateEntryQuality, entryQualityFromDelivery } from "../../entry-quality-gate.ts";
import { persistAlertInstrumentation, type AlertInstrumentation } from "./instrumentation.ts";
import { recordProposedShadowFromDelivery } from "./shadow-runner.ts";
import { revalidateBeforeDiscordSend } from "./final-delivery-revalidation.ts";
import { formatPrivateLiveAlert } from "./format.ts";
import { tradingDay } from "../../trading-session.ts";
import { evaluateBearishAuthority } from "./bearish-authority.ts";
import {
  attachEvidenceToOpportunityOnDb,
  claimOpportunityOpenOnDb,
  findActiveOpportunityByFingerprintOnDb,
  loadCaseJsonOnDb,
  logSuppressionOnDb,
  markOpportunityOpenedDeliveredOnDb,
  opportunityLifecycleSchemaReady,
  releaseOpportunityOpeningClaimOnDb,
} from "../../opportunity-case/live.ts";
import { buildOpportunityIdentity, opportunityFingerprint } from "../../opportunity-case/identity.ts";
import {
  findActiveThesisOnDb,
  recordContractCandidateOnDb,
} from "../../opportunity-case/thesis-live.ts";
import {
  buildOpportunityThesisIdentity,
  opportunityThesisFingerprint,
} from "../../opportunity-case/thesis-identity.ts";
import { quoteFreshness } from "../../quote-freshness.ts";

export type DeliveryState = "READY" | "SEND_ATTEMPTED" | "SENT" | "SEND_FAILED" | "SEND_RECONCILE_REQUIRED" | "TOO_LATE" | "REJECTED" | "EXPIRED";

export const BETA_LABEL = "PAPER/BETA TEST — NOT FINANCIAL ADVICE";

function djb2(s: string): string { let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
/** Deterministic idempotency key: symbol|strategy|contract|time-bucket. */
export function optionsAlertId(symbol: string, strategy: string, optionSymbol: string, nowMs: number, bucketMs = 300_000): string {
  return `oa_${djb2([symbol.toUpperCase(), strategy, optionSymbol, Math.floor(nowMs / bucketMs)].join("|"))}`;
}

export interface DeliveryContract {
  optionSymbol: string; side: "call" | "put"; strike: number; expiration: string; bid: number | null; ask: number | null; spreadPct: number | null; quoteAgeMs: number | null;
  // carried so the DELIVERED_ALERT_PAPER mirror is built from the EXACT delivered quote (no hindsight).
  dte?: number | null; volume?: number | null; openInterest?: number | null; iv?: number | null; delta?: number | null; providerTimestamp?: number | null;
}
export interface DeliveryInput {
  candidateSymbol: string; strategy: string; researchOnly: boolean;
  contract: DeliveryContract;
  message: string;                 // the pre-formatted single callout (from callout.ts)
  observedUnderlyingPrice: number; currentUnderlyingPrice: number; chaseLimitPct: number;
  underlyingPrice: number;         // delivered underlying snapshot
  decisionMs?: number;             // the setup decision timestamp — the mirror's entry time (no later/improved entry)
  session?: string | null;
  entry?: FrozenEntry | null;      // the frozen midpoint + deterministic targets shown to the subscriber
  tier?: 0 | 1 | 2;
  paperOptionSymbol?: string | null; // when real-option paper linked — MUST match contract.optionSymbol
  maxSpreadPct?: number; maxQuoteAgeMs?: number;
  tradingSessionDate?: string | null;
  firstDetectedAtMs?: number | null;
  underlyingAtFirstDetection?: number | null;
  optionAtFirstDetection?: number | null;
  firstReadyAtMs?: number | null;
  readyExpiresAtMs?: number | null;
  featureSnapshot?: Record<string, unknown> | null;
}

export interface SendResult { ok: boolean; status: number | null; messageId: string | null; latencyMs: number; ambiguous: boolean; error: string | null }
export interface DeliveryDeps {
  getDb?: () => any;
  send?: (payload: Record<string, unknown>) => Promise<SendResult>;
  now?: () => number;
  maxRetries?: number;
  /** Optional pre-send refresh of underlying/option quotes. Failures must not throw into delivery. */
  refreshBeforeSend?: (input: DeliveryInput, nowMs: number) => Promise<DeliveryInput> | DeliveryInput;
}
export interface DeliveryOutcome {
  state: DeliveryState;
  alertId: string;
  sent: boolean;
  reason: string;
  paperLinked: boolean;
  opportunityCaseId?: string | null;
  suppressedDuplicate?: boolean;
}

interface DDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }
const liveDb = () => require("@/lib/db").getDb(); // eslint-disable-line @typescript-eslint/no-require-imports

/**
 * Age the Stage-2 quote to wall-clock now, and optionally refresh underlying via deps.
 * Never throws — returns the original input on failure.
 */
export async function refreshDeliveryQuotes(
  input: DeliveryInput,
  nowMs: number,
  deps: DeliveryDeps = {},
): Promise<DeliveryInput> {
  let current = input;
  try {
    if (deps.refreshBeforeSend) {
      const refreshed = await deps.refreshBeforeSend(input, nowMs);
      if (refreshed) current = refreshed;
    }
  } catch { /* isolated */ }
  const c = current.contract;
  // Only recompute age from an absolute provider timestamp. Do not invent aging from decisionMs —
  // that falsely stale-rejects legitimate re-attempts that carry a fresh Stage-2 age snapshot.
  const freshness = quoteFreshness(c.providerTimestamp, nowMs);
  return {
    ...current,
    contract: { ...c, quoteAgeMs: freshness.ageMs },
  };
}

/** Default sender: the existing approved options webhook. Never logs the URL. Timeout → ambiguous. */
async function defaultSend(payload: Record<string, unknown>): Promise<SendResult> {
  const t0 = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { postToDiscord } = require("@/lib/notifications");
    const r = await postToDiscord(payload, { webhook: "options" });
    return { ok: true, status: r.httpStatus ?? 204, messageId: r.messageId ?? null, latencyMs: Date.now() - t0, ambiguous: false, error: null };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const ambiguous = /timeout|aborted|ETIMEDOUT/i.test(msg); // response unknown ⇒ do NOT auto-retry
    return { ok: false, status: null, messageId: null, latencyMs: Date.now() - t0, ambiguous, error: msg.slice(0, 160) };
  }
}

/**
 * Reserve the ONE linked subscriber mirror before Discord. The reservation cannot enter delivered
 * performance until Discord proof exists and finalization promotes it to ENTERED.
 */
function reserveDeliveredMirror(
  db: DDb,
  i: DeliveryInput,
  alertId: string,
  thesisFingerprint: string | null,
  env: NodeJS.ProcessEnv,
): DeliveredPaperReservation {
  try {
    if (!researchFlags(env).realOptionPaper) {
      return { ok: false, paperTradeId: null, state: "FAILED", reason: "REAL_OPTION_PAPER_ENABLED!=1" };
    }
    const c = i.contract;
    const decisionMs = i.decisionMs ?? Date.now();
    const q: OptionQuote = { optionSymbol: c.optionSymbol, side: c.side, strike: c.strike, expiration: c.expiration, dte: c.dte ?? 0, bid: c.bid, ask: c.ask, volume: c.volume ?? null, openInterest: c.openInterest ?? null, iv: c.iv ?? null, delta: c.delta ?? null, quoteAgeMs: c.quoteAgeMs, providerTimestamp: c.providerTimestamp ?? null };
    const built = buildRealOptionEntry({ quote: q, underlyingPrice: i.underlyingPrice, strategy: i.strategy }, env);
    if (!built.ok) {
      return {
        ok: false,
        paperTradeId: null,
        state: "FAILED",
        reason: `paper_entry_gate:${built.rejections.join(",")}`,
      };
    }
    // The mirror uses the EXACT frozen midpoint + deterministic targets the subscriber saw — never a
    // later/improved entry. entryFill = the displayed midpoint; target = T1; invalidation = Stop.
    const entry = i.entry ? { ...built, entryFill: i.entry.mid, target: i.entry.t1, invalidation: i.entry.stop } : built;
    return reserveDeliveredPaperOnDb(db, entry, decisionMs, alertId, {
      session: i.session ?? null,
      featureSnapshotJson: i.entry ? JSON.stringify({ targetMethodology: i.entry.methodology, frozen: i.entry }) : undefined,
      thesisFingerprint,
    });
  } catch (err: any) {
    return {
      ok: false,
      paperTradeId: null,
      state: "FAILED",
      reason: `paper_reservation_failed:${String(err?.message ?? err).slice(0, 140)}`,
    };
  }
}

function persist(db: DDb, alertId: string, i: DeliveryInput, state: DeliveryState, extra: Record<string, unknown>, nowMs: number): void {
  const e = i.entry ?? null;
  const freshness = quoteFreshness(i.contract.providerTimestamp, nowMs);
  const quoteTimestampMs = freshness.valid && freshness.ageMs != null
    ? nowMs - freshness.ageMs
    : null;
  db.prepare(
    `INSERT INTO options_alerts (alert_id, candidate_symbol, strategy, option_symbol, side, research_only, state, message_hash, message, delivered_bid, delivered_ask, delivered_underlying, paper_linked, discord_status, latency_ms, retry_count, failure_reason, attempted_at_ms, sent_at_ms, session_state, entry_mid, delivered_spread_pct, quote_ts_ms, target_t1, target_t2, target_stop, target_method, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(alert_id) DO UPDATE SET state=excluded.state, discord_status=excluded.discord_status, latency_ms=excluded.latency_ms, retry_count=excluded.retry_count, failure_reason=excluded.failure_reason, attempted_at_ms=COALESCE(options_alerts.attempted_at_ms, excluded.attempted_at_ms), sent_at_ms=COALESCE(excluded.sent_at_ms, options_alerts.sent_at_ms), paper_linked=excluded.paper_linked, session_state=COALESCE(excluded.session_state, options_alerts.session_state), entry_mid=COALESCE(excluded.entry_mid, options_alerts.entry_mid), delivered_spread_pct=COALESCE(excluded.delivered_spread_pct, options_alerts.delivered_spread_pct), quote_ts_ms=COALESCE(excluded.quote_ts_ms, options_alerts.quote_ts_ms), target_t1=COALESCE(excluded.target_t1, options_alerts.target_t1), target_t2=COALESCE(excluded.target_t2, options_alerts.target_t2), target_stop=COALESCE(excluded.target_stop, options_alerts.target_stop), target_method=COALESCE(excluded.target_method, options_alerts.target_method), updated_at_ms=excluded.updated_at_ms`,
  ).run(
    alertId, i.candidateSymbol, i.strategy, i.contract.optionSymbol, i.contract.side, i.researchOnly ? 1 : 0, state,
    djb2(i.message), i.message, i.contract.bid, i.contract.ask, i.underlyingPrice,
    extra.paperLinked != null ? (extra.paperLinked ? 1 : 0) : ((i.paperOptionSymbol && i.paperOptionSymbol === i.contract.optionSymbol) ? 1 : 0),
    extra.status ?? null, extra.latencyMs ?? null, extra.retryCount ?? 0, extra.failureReason ?? null,
    extra.attemptedAtMs ?? null, extra.sentAtMs ?? null,
    extra.sessionState ?? null, e?.mid ?? null, e?.spreadPct ?? null, quoteTimestampMs,
    e?.t1 ?? null, e?.t2 ?? null, e?.stop ?? null, e?.methodology ?? null,
    nowMs, nowMs,
  );
}

function persistPaperReservationLink(
  db: DDb,
  alertId: string,
  reservation: DeliveredPaperReservation,
  state: string,
): void {
  db.prepare(
    `UPDATE options_alerts
        SET paper_trade_id=?, paper_reservation_state=?
      WHERE alert_id=?`,
  ).run(reservation.paperTradeId, state, alertId);
}

/**
 * Gated single-callout delivery. Re-checks freshness/spread/chase at delivery time; dedups by
 * alertId (no second message, no duplicate after an ambiguous timeout); when opportunity lifecycle
 * is enabled, also enforces one active Opportunity Case per fingerprint. Writes SENT only after a
 * successful Discord response. Never throws into the caller.
 */
export async function deliverOptionsCallout(input: DeliveryInput, deps: DeliveryDeps = {}, env: NodeJS.ProcessEnv = process.env): Promise<DeliveryOutcome> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const f = researchFlags(env);
  let alertId = optionsAlertId(input.candidateSymbol, input.strategy, input.contract.optionSymbol, nowMs);
  const base = (
    state: DeliveryState,
    sent: boolean,
    reason: string,
    paperLinked = false,
    extra: { opportunityCaseId?: string | null; suppressedDuplicate?: boolean } = {},
  ): DeliveryOutcome => ({ state, alertId, sent, reason, paperLinked, ...extra });

  // FLAGS + kill switch — ZERO webhook sends unless both flags on and not killed.
  if (!f.independentOptionsDiscovery || !f.earlyOptionsCallouts) return base("READY", false, "callouts_disabled");
  if (env.OPTIONS_PORTFOLIO_DELIVERY_ENABLED !== "1") return base("REJECTED", false, "portfolio_delivery_required");
  if (env.OPTIONS_CALLOUTS_KILL === "1") return base("REJECTED", false, "kill_switch_engaged");
  try {
    const { validateSubscriberConfig, shouldBlockIndependentDelivery } = require("../../subscriber-config-validator.ts") as typeof import("../../subscriber-config-validator.ts");
    const cfgVal = validateSubscriberConfig(env);
    if (shouldBlockIndependentDelivery(cfgVal, env)) return base("REJECTED", false, `subscriber_config:${cfgVal.fatal.join("; ")}`);
  } catch { /* validator optional in tests */ }
  // Puts require the bearish authority path before any actionable subscriber delivery.
  if (input.contract.side === "put") {
    const auth = evaluateBearishAuthority({
      symbol: input.candidateSymbol,
      side: "put",
      strategy: input.strategy,
      researchOnly: input.researchOnly,
      deliveryInput: input,
      nowMs,
    }, env);
    if (!auth.maySubscriberSend) {
      const reason = `${auth.reasonCode}: ${auth.blockers.join("; ") || auth.reasons.join("; ") || auth.state}`;
      try { persist((deps.getDb ?? liveDb)(), alertId, input, "REJECTED", { failureReason: reason }, nowMs); } catch { /* isolated */ }
      return base("REJECTED", false, reason);
    }
  } else if (input.researchOnly) {
    try { persist((deps.getDb ?? liveDb)(), alertId, input, "REJECTED", { failureReason: "research_only_suppressed" }, nowMs); } catch { /* isolated */ }
    return base("REJECTED", false, "research_only_suppressed");
  }

  const strictOpeningSession = assertOptionsOpeningSession(nowMs, env);
  if (!strictOpeningSession.ok) {
    return finalize(
      deps,
      input,
      alertId,
      "REJECTED",
      `session_guard:${strictOpeningSession.guard.state}`,
      nowMs,
      strictOpeningSession.guard.optionsSessionState,
    );
  }
  const sessionGuard = assertSubscriberDeliveryAllowed(nowMs, env);
  if (!sessionGuard.ok) {
    return finalize(deps, input, alertId, "REJECTED", `session_guard:${sessionGuard.guard.state}`, nowMs, sessionGuard.guard.optionsSessionState);
  }

  const candidateSession = input.tradingSessionDate ?? tradingDay(input.firstDetectedAtMs ?? nowMs);
  if (!isSameTradingSession(candidateSession, nowMs)) {
    return finalize(deps, input, alertId, "REJECTED", "EXPIRED_TRADING_SESSION", nowMs, sessionGuard.guard.optionsSessionState);
  }

  const dbEarly = (deps.getDb ?? liveDb)();
  const shadow = recordProposedShadowFromDelivery(dbEarly, input, {
    firstDetectedAtMs: input.firstDetectedAtMs,
    underlyingAtFirstDetection: input.underlyingAtFirstDetection,
    optionAtFirstDetection: input.optionAtFirstDetection,
    featureSnapshot: input.featureSnapshot,
  }, env);
  if (shadow.entryQuality && shadow.entryQuality.composite.subscriberAction === "BLOCK" && String(env.ENTRY_QUALITY_GATE ?? "shadow").toLowerCase() === "enforce") {
    const inst: AlertInstrumentation = {
      entryQualityVerdict: shadow.entryQuality.composite.primaryVerdict,
      entryQualityReasonsJson: JSON.stringify(shadow.entryQuality.composite.reasons),
      tradingSessionDate: tradingDay(nowMs),
    };
    try { persistAlertInstrumentation(dbEarly, alertId, inst); } catch { /* isolated */ }
    return finalize(deps, input, alertId, "REJECTED", `entry_quality:${shadow.entryQuality.composite.primaryVerdict}`, nowMs, sessionGuard.guard.optionsSessionState);
  }

  // Re-verify freshness / spread / chase at DELIVERY time.
  const maxSpread = input.maxSpreadPct ?? 10, maxAge = input.maxQuoteAgeMs ?? 15_000;
  if (input.contract.bid == null || input.contract.bid <= 0) return finalize(deps, input, alertId, "REJECTED", "zero_bid", nowMs);
  if (input.contract.spreadPct != null && input.contract.spreadPct > maxSpread) return finalize(deps, input, alertId, "REJECTED", "spread_too_wide", nowMs);
  if (input.contract.quoteAgeMs != null && input.contract.quoteAgeMs > maxAge) return finalize(deps, input, alertId, "TOO_LATE", "stale_quote", nowMs);
  const bullish = input.contract.side === "call";
  const favMovePct = input.observedUnderlyingPrice > 0 ? ((input.currentUnderlyingPrice - input.observedUnderlyingPrice) / input.observedUnderlyingPrice) * 100 * (bullish ? 1 : -1) : 0;
  if (favMovePct > input.chaseLimitPct) return finalize(deps, input, alertId, "TOO_LATE", "chase_exceeded", nowMs);

  const db = (deps.getDb ?? liveDb)();
  const state = sessionState(nowMs, env);
  let livingCaseId: string | null = null;
  let livingFingerprint: string | null = null;
  let livingThesisFingerprint: string | null = null;

  const lifecycleReady = env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0" && opportunityLifecycleSchemaReady(db);
  if (env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED === "1" && !lifecycleReady) {
    return finalize(
      deps,
      input,
      alertId,
      "REJECTED",
      "opportunity_thesis_schema_unavailable",
      nowMs,
      state,
    );
  }

  // Early active-opportunity suppress (before alertId bucket short-circuit) so repeats across
  // the same 5-minute alert_id still attach evidence and never look like a fresh SENT.
  if (lifecycleReady) {
    try {
      livingFingerprint = opportunityFingerprint(buildOpportunityIdentity({
        symbol: input.candidateSymbol,
        side: input.contract.side,
        expiration: input.contract.expiration,
        strike: input.contract.strike,
        strategyKey: input.strategy,
        nowMs,
        direction: input.contract.side === "put" ? "bearish" : "bullish",
      }));
      livingThesisFingerprint = opportunityThesisFingerprint(buildOpportunityThesisIdentity({
        symbol: input.candidateSymbol,
        side: input.contract.side,
        nowMs,
        direction: input.contract.side === "put" ? "bearish" : "bullish",
      }));
      const activeThesis = findActiveThesisOnDb(db, livingThesisFingerprint);
      if (activeThesis) {
        livingCaseId = activeThesis.opportunityCaseId;
        recordContractCandidateOnDb(db, {
          opportunityCaseId: activeThesis.opportunityCaseId,
          thesisFingerprint: livingThesisFingerprint,
          opportunityFingerprint: livingFingerprint,
          optionSymbol: input.contract.optionSymbol,
          side: input.contract.side,
          strike: input.contract.strike,
          expiration: input.contract.expiration,
          strategyKey: input.strategy,
          observedAtMs: nowMs,
          bid: input.contract.bid,
          ask: input.contract.ask,
          spreadPct: input.contract.spreadPct,
          delta: input.contract.delta,
          openInterest: input.contract.openInterest,
          volume: input.contract.volume,
          reason: "preferred_contract_reselected",
        });
        attachEvidenceToOpportunityOnDb(db, {
          opportunityCaseId: activeThesis.opportunityCaseId,
          nowMs,
          source: "options_delivery",
          signalType: "thesis_repeat_contract_candidate",
          score: null,
          details: {
            strategy: input.strategy,
            optionSymbol: input.contract.optionSymbol,
            opportunityFingerprint: livingFingerprint,
            thesisFingerprint: livingThesisFingerprint,
            alertId,
          },
          currentMark: input.contract.bid,
        });
        const oc = loadCaseJsonOnDb(db, activeThesis.opportunityCaseId);
        logSuppressionOnDb(db, {
          symbol: input.candidateSymbol,
          strategy: input.strategy,
          fingerprint: livingThesisFingerprint,
          existingOpportunityCaseId: activeThesis.opportunityCaseId,
          reason: "MATCHING_ACTIVE_THESIS",
          decision: "SUPPRESSED_DUPLICATE_OPENING",
          latestReturnPercent: oc?.summary?.currentReturnPct ?? null,
          nextUndeliveredMilestone: oc?.summary?.nextUndeliveredReturnMilestone ?? null,
          details: { opportunityFingerprint: livingFingerprint, optionSymbol: input.contract.optionSymbol },
          nowMs,
        });
        return finalize(deps, input, alertId, "REJECTED", "matching_active_thesis", nowMs, state, {
          opportunityCaseId: activeThesis.opportunityCaseId,
          suppressedDuplicate: true,
        });
      }
      const active = findActiveOpportunityByFingerprintOnDb(db, livingFingerprint);
      if (active) {
        livingCaseId = active.opportunityCaseId;
        try {
          attachEvidenceToOpportunityOnDb(db, {
            opportunityCaseId: active.opportunityCaseId,
            nowMs,
            source: "options_delivery",
            signalType: "duplicate_opening_suppressed",
            score: null,
            details: { strategy: input.strategy, optionSymbol: input.contract.optionSymbol, alertId },
            currentMark: input.contract.bid,
          });
          const oc = loadCaseJsonOnDb(db, active.opportunityCaseId);
          logSuppressionOnDb(db, {
            symbol: input.candidateSymbol,
            strategy: input.strategy,
            fingerprint: livingFingerprint,
            existingOpportunityCaseId: active.opportunityCaseId,
            reason: "MATCHING_ACTIVE_OPPORTUNITY",
            decision: "SUPPRESSED_DUPLICATE",
            latestReturnPercent: oc?.summary?.currentReturnPct ?? null,
            nextUndeliveredMilestone: oc?.summary?.nextUndeliveredReturnMilestone ?? null,
            nowMs,
          });
        } catch { /* isolated */ }
        return finalize(deps, input, alertId, "REJECTED", "matching_active_opportunity", nowMs, state, {
          opportunityCaseId: active.opportunityCaseId,
          suppressedDuplicate: true,
        });
      }
    } catch { /* schema optional */ }
  }

  // SETUP dedup (rolling, per symbol+side+strategy — NOT a global cooldown).
  // When the living Opportunity Case lifecycle schema is ready, fingerprint claim below is the authority
  // (exact contract/session identity). The coarse rolling guard is retained as a fallback otherwise.
  if (!lifecycleReady) {
    const setupDedupMs = Number(env.OPTIONS_SETUP_DEDUP_MS);
    const dedupWindow = Number.isFinite(setupDedupMs) && setupDedupMs > 0 ? setupDedupMs : 20 * 60_000;
    try {
      // exclude THIS alert_id: the identical event falls through to the precise alertId dedup below.
      const dup = db.prepare("SELECT 1 FROM options_alerts WHERE candidate_symbol=? AND side=? AND strategy=? AND state='SENT' AND sent_at_ms >= ? AND alert_id != ? LIMIT 1").get(input.candidateSymbol, input.contract.side, input.strategy, nowMs - dedupWindow, alertId);
      if (dup) return finalize(deps, input, alertId, "REJECTED", "duplicate_setup", nowMs, state);
    } catch { /* table lazily created */ }
  }

  // OPENING-BELL anti-spam: a ROLLING-window limit (releases naturally, never a fixed cooldown). Tier 0
  // is exempt from the cap so a stronger SPY/QQQ/IWM setup is never crowded out by broad opening noise.
  const isTier0 = OPTIONS_TIER0.includes(input.candidateSymbol.toUpperCase() as any) || input.tier === 0;
  if (state === "OPENING_DISCOVERY" && !isTier0) {
    try {
      const recent = (db.prepare("SELECT sent_at_ms FROM options_alerts WHERE state='SENT' AND sent_at_ms IS NOT NULL").all() as any[]).map((r) => Number(r.sent_at_ms));
      if (!openingWindowAllows(recent, nowMs, defaultOpeningLimit(env))) return finalize(deps, input, alertId, "REJECTED", "opening_window_rate_limited", nowMs, state);
    } catch { /* isolated */ }
  }
  // Dedup / no-duplicate-after-ambiguous-timeout: an existing SENT or SEND_ATTEMPTED row wins.
  // With lifecycle enabled, true duplicates are already suppressed by active fingerprint above.
  // A SENT row in the same 5-minute bucket after the opportunity closed must not permanently block re-entry.
  let existing: any = null;
  try { existing = db.prepare("SELECT state, retry_count FROM options_alerts WHERE alert_id=?").get(alertId); } catch { /* table may be created lazily by caller */ }
  if (existing && (existing.state === "SENT" || existing.state === "SEND_ATTEMPTED")) {
    if (lifecycleReady && existing.state === "SENT") {
      // Re-entry after close: mint a fresh alert id so the old 5-minute bucket cannot block forever.
      alertId = optionsAlertId(input.candidateSymbol, input.strategy, input.contract.optionSymbol, nowMs, 1);
      try { existing = db.prepare("SELECT state, retry_count FROM options_alerts WHERE alert_id=?").get(alertId); } catch { existing = null; }
    } else {
      return base(existing.state, false, "duplicate_suppressed", true);
    }
  }
  if (existing && (existing.state === "SENT" || existing.state === "SEND_ATTEMPTED")) return base(existing.state, false, "duplicate_suppressed", true);
  const maxRetries = deps.maxRetries ?? 1;
  const priorRetries = existing?.retry_count ?? 0;
  if (existing && existing.state === "SEND_FAILED" && priorRetries >= maxRetries) return base("SEND_FAILED", false, "retry_ceiling_reached");

  // Living Opportunity Case claim — immediately before send so failed gates never orphan an active row.
  // Kill switch / missing schema: OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED=0 or unmigrated DB → legacy dedup.
  if (lifecycleReady) {
    try {
      const claim = claimOpportunityOpenOnDb(db, {
        symbol: input.candidateSymbol,
        side: input.contract.side,
        expiration: input.contract.expiration,
        strike: input.contract.strike,
        strategyKey: input.strategy,
        nowMs,
        direction: input.contract.side === "put" ? "bearish" : "bullish",
        frozenEntry: input.entry?.mid ?? null,
        frozenTrade: input.entry
          ? {
              entryMid: input.entry.mid,
              targetT1: input.entry.t1,
              targetT2: input.entry.t2,
              stop: input.entry.stop,
              bid: input.entry.bid,
              ask: input.entry.ask,
              spreadPct: input.entry.spreadPct,
              methodology: input.entry.methodology,
            }
          : null,
        optionSymbol: input.contract.optionSymbol,
        alertId,
        openingSource: "canonical",
        contractSnapshot: {
          bid: input.contract.bid,
          ask: input.contract.ask,
          spreadPct: input.contract.spreadPct,
          delta: input.contract.delta,
          openInterest: input.contract.openInterest,
          volume: input.contract.volume,
        },
        why: input.message?.split("\n")[1] ?? null,
      });
      livingFingerprint = claim.fingerprint;
      livingThesisFingerprint = claim.thesisFingerprint;
      if (!claim.claimed && claim.existing) {
        livingCaseId = claim.opportunityCaseId;
        try {
          attachEvidenceToOpportunityOnDb(db, {
            opportunityCaseId: claim.opportunityCaseId,
            nowMs,
            source: "options_delivery",
            signalType: "duplicate_opening_suppressed",
            score: null,
            details: { strategy: input.strategy, optionSymbol: input.contract.optionSymbol, alertId },
            currentMark: input.contract.bid,
          });
          const oc = loadCaseJsonOnDb(db, claim.opportunityCaseId);
          logSuppressionOnDb(db, {
            symbol: input.candidateSymbol,
            strategy: input.strategy,
            fingerprint: claim.fingerprint,
            existingOpportunityCaseId: claim.opportunityCaseId,
            reason: "MATCHING_ACTIVE_OPPORTUNITY",
            decision: "SUPPRESSED_DUPLICATE",
            latestReturnPercent: oc?.summary?.currentReturnPct ?? null,
            nextUndeliveredMilestone: oc?.summary?.nextUndeliveredReturnMilestone ?? null,
            nowMs,
          });
        } catch { /* isolated */ }
        return finalize(
          deps,
          input,
          alertId,
          "REJECTED",
          claim.reason === "MATCHING_ACTIVE_THESIS" ? "matching_active_thesis" : "matching_active_opportunity",
          nowMs,
          state,
          {
          opportunityCaseId: claim.opportunityCaseId,
          suppressedDuplicate: true,
          },
        );
      }
      if (!claim.claimed) {
        return finalize(
          deps,
          input,
          alertId,
          "REJECTED",
          `opportunity_claim_failed:${claim.reason}`,
          nowMs,
          state,
          { opportunityCaseId: claim.opportunityCaseId },
        );
      }
      if (claim.claimed) livingCaseId = claim.opportunityCaseId;
    } catch { /* lifecycle helpers optional when schema not migrated */ }
  }

  const finalInput = await refreshDeliveryQuotes(input, nowMs, deps);
  const finalGate = revalidateBeforeDiscordSend({
    deliveryInput: finalInput,
    nowMs,
    firstReadyAtMs: finalInput.firstReadyAtMs,
    readyExpiresAtMs: finalInput.readyExpiresAtMs,
  }, env);
  if (!finalGate.allowed && finalGate.rejectionCode) {
    const inst: AlertInstrumentation = {
      entryQualityVerdict: finalGate.rejectionCode,
      entryQualityReasonsJson: JSON.stringify(finalGate.reasons),
      tradingSessionDate: tradingDay(nowMs),
      firstDetectedAtMs: finalInput.firstDetectedAtMs,
      underlyingAtFirstDetection: finalInput.underlyingAtFirstDetection,
      optionAtFirstDetection: finalInput.optionAtFirstDetection,
      underlyingAtDelivery: finalInput.currentUnderlyingPrice,
      optionAtDelivery: finalInput.entry?.mid ?? null,
      deliveryLatencyMs: finalInput.firstDetectedAtMs ? nowMs - finalInput.firstDetectedAtMs : null,
      evidenceSnapshotJson: JSON.stringify({ finalGate: finalGate.metrics, dimensions: finalGate.entryQuality.dimensions }),
    };
    try { persistAlertInstrumentation(dbEarly, alertId, inst); } catch { /* isolated */ }
    if (livingCaseId && env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0") {
      try {
        releaseOpportunityOpeningClaimOnDb(db, livingCaseId);
      } catch { /* isolated */ }
    }
    const rejectState = finalGate.rejectionCode === "QUOTE_STALE" || finalGate.rejectionCode === "STALE_READY_CANDIDATE" ? "TOO_LATE" as const : "REJECTED" as const;
    return finalize(deps, finalInput, alertId, rejectState, finalGate.rejectionCode, nowMs, state);
  }

  const paperReservation = reserveDeliveredMirror(
    db,
    finalInput,
    alertId,
    livingThesisFingerprint,
    env,
  );
  if (!paperReservation.ok || !paperReservation.paperTradeId) {
    if (livingCaseId && env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0") {
      try {
        releaseOpportunityOpeningClaimOnDb(db, livingCaseId);
      } catch { /* isolated */ }
    }
    return finalize(
      deps,
      finalInput,
      alertId,
      "REJECTED",
      `paper_reservation_failed:${paperReservation.reason ?? "unknown"}`,
      nowMs,
      state,
      { opportunityCaseId: livingCaseId },
    );
  }

  const appBaseUrl = String(env.PUBLIC_APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  const liveMessage = finalInput.entry
    ? formatPrivateLiveAlert({
      symbol: finalInput.candidateSymbol,
      side: finalInput.contract.side,
      strike: finalInput.contract.strike,
      expiration: finalInput.contract.expiration,
      entryMid: finalInput.entry.mid,
      t1: finalInput.entry.t1,
      t2: finalInput.entry.t2,
      stop: finalInput.entry.stop,
      strategyKey: finalInput.strategy,
      underlyingPrice: finalInput.currentUnderlyingPrice,
      dte: finalInput.contract.dte ?? null,
      optionSymbol: finalInput.contract.optionSymbol,
      timingClass: finalGate.timingClass === "EARLY" ? "EARLY" : "TIMELY",
      actionableReason: finalGate.actionableReason,
      invalidation: finalGate.invalidation,
      bid: finalInput.contract.bid,
      ask: finalInput.contract.ask,
      spreadPct: finalInput.contract.spreadPct,
      volume: finalInput.contract.volume,
      openInterest: finalInput.contract.openInterest,
      delta: finalInput.contract.delta,
      quoteAgeMs: finalInput.contract.quoteAgeMs,
      confidence: Math.min(
        finalGate.entryQuality.dimensions.setupQuality.score,
        finalGate.entryQuality.dimensions.contractQuality.score,
        finalGate.entryQuality.dimensions.marketAlignment.score,
        finalGate.entryQuality.dimensions.entryEarliness.score,
        finalGate.entryQuality.dimensions.remainingOpportunity.score,
        finalGate.entryQuality.dimensions.sessionRisk.score,
      ),
      detailUrl: livingCaseId
        ? `${appBaseUrl}/intelligence/${encodeURIComponent(livingCaseId)}`
        : `${appBaseUrl}/alerts?tab=history`,
    })
    : finalInput.message;

  // Claim the slot as SEND_ATTEMPTED BEFORE sending, so a concurrent/duplicate call dedups.
  try {
    persist(
      db,
      alertId,
      { ...finalInput, message: liveMessage },
      "SEND_ATTEMPTED",
      { attemptedAtMs: nowMs, retryCount: priorRetries, sessionState: state, paperLinked: false },
      nowMs,
    );
    persistPaperReservationLink(db, alertId, paperReservation, paperReservation.state);
  } catch {
    reconcileDeliveredPaperSendFailureOnDb(
      db,
      paperReservation,
      nowMs,
      false,
      "alert_link_persist_failed",
    );
    if (livingCaseId && env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0") {
      try { releaseOpportunityOpeningClaimOnDb(db, livingCaseId); } catch { /* isolated */ }
    }
    return finalize(
      deps,
      finalInput,
      alertId,
      "REJECTED",
      "paper_link_persist_failed",
      nowMs,
      state,
      { opportunityCaseId: livingCaseId },
    );
  }
  try {
    if (livingCaseId || livingFingerprint || livingThesisFingerprint) {
      db.prepare(
        `UPDATE options_alerts
            SET opportunity_case_id=?, opportunity_fingerprint=?, thesis_fingerprint=?,
                paper_trade_id=?, paper_reservation_state=?
          WHERE alert_id=?`,
      ).run(
        livingCaseId,
        livingFingerprint,
        livingThesisFingerprint,
        paperReservation.paperTradeId,
        paperReservation.state,
        alertId,
      );
    }
  } catch { /* columns optional */ }

  const payload = { content: finalInput.entry ? liveMessage : `${liveMessage}\n\n${BETA_LABEL}` };
  const send = deps.send ?? defaultSend;
  let attempt = priorRetries, res: SendResult;
  for (;;) {
    res = await send(payload);
    if (res.ok || res.ambiguous || attempt >= maxRetries) break; // never retry an ambiguous timeout
    attempt += 1;
    await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** attempt))); // bounded backoff
  }
  if (res.ok) {
    // Discord accepted the opening. Finalize the already-linked reservation before the alert can
    // become SENT or enter delivered performance.
    const sentAt = now();
    const linked = finalizeDeliveredPaperReservationOnDb(db, paperReservation, sentAt);
    if (!linked) {
      try {
        persist(
          db,
          alertId,
          finalInput,
          "SEND_RECONCILE_REQUIRED",
          {
            status: res.status,
            latencyMs: res.latencyMs,
            retryCount: maxRetries,
            attemptedAtMs: nowMs,
            failureReason: "paper_finalize_failed_after_discord",
            paperLinked: false,
            sessionState: state,
          },
          sentAt,
        );
        persistPaperReservationLink(db, alertId, paperReservation, "RECONCILIATION_REQUIRED");
        db.prepare(
          `UPDATE options_alerts
              SET discord_message_id=?,
                  opportunity_case_id=COALESCE(opportunity_case_id, ?),
                  opportunity_fingerprint=COALESCE(opportunity_fingerprint, ?),
                  thesis_fingerprint=COALESCE(thesis_fingerprint, ?)
            WHERE alert_id=?`,
        ).run(res.messageId ?? null, livingCaseId, livingFingerprint, livingThesisFingerprint, alertId);
      } catch { /* durable SEND_ATTEMPTED row and paper reservation remain for reconciliation */ }
      try {
        db.prepare(
          `INSERT INTO discord_send_attempts (alert_id, opportunity_case_id, kind, ambiguous, discord_message_id, error, created_at_ms)
           VALUES (?,?,?,?,?,?,?)`,
        ).run(
          alertId,
          livingCaseId,
          "opening",
          0,
          res.messageId ?? null,
          "paper_finalize_failed_after_discord",
          sentAt,
        );
      } catch { /* optional table */ }
      return base(
        "SEND_RECONCILE_REQUIRED",
        true,
        "paper_finalize_failed_after_discord",
        false,
        { opportunityCaseId: livingCaseId },
      );
    }
    const optMid = finalInput.entry?.mid ?? ((finalInput.contract.bid ?? 0) + (finalInput.contract.ask ?? 0)) / 2;
    const latencyMs = finalInput.firstDetectedAtMs ? sentAt - finalInput.firstDetectedAtMs : null;
    try {
      persistAlertInstrumentation(db, alertId, {
        firstDetectedAtMs: finalInput.firstDetectedAtMs,
        underlyingAtFirstDetection: finalInput.underlyingAtFirstDetection,
        optionAtFirstDetection: finalInput.optionAtFirstDetection,
        underlyingAtDelivery: finalInput.currentUnderlyingPrice,
        optionAtDelivery: optMid,
        evidenceSnapshotJson: finalInput.featureSnapshot ? JSON.stringify(finalInput.featureSnapshot) : null,
        sessionStateAtDelivery: state,
        deliveryLatencyMs: latencyMs,
        entryQualityVerdict: finalGate.timingClass,
        entryQualityReasonsJson: JSON.stringify({ reasons: finalGate.reasons, actionable: finalGate.actionableReason, invalidation: finalGate.invalidation }),
        tradingSessionDate: tradingDay(nowMs),
        deliveredAtMs: sentAt,
      });
    } catch { /* isolated */ }
    try {
      persist(db, alertId, finalInput, "SENT", { status: res.status, latencyMs: res.latencyMs, retryCount: attempt, sentAtMs: sentAt, attemptedAtMs: nowMs, paperLinked: true, sessionState: state }, now());
      persistPaperReservationLink(db, alertId, paperReservation, "FINALIZED");
    } catch { /* the delivered row remains linked by alert_id for reconciliation */ }
    try {
      db.prepare(
        `UPDATE options_alerts
         SET discord_message_id=?,
             opportunity_case_id=COALESCE(opportunity_case_id, ?),
             opportunity_fingerprint=COALESCE(opportunity_fingerprint, ?),
             thesis_fingerprint=COALESCE(thesis_fingerprint, ?)
         WHERE alert_id=?`,
      ).run(res.messageId ?? null, livingCaseId, livingFingerprint, livingThesisFingerprint, alertId);
    } catch { /* optional columns */ }
    if (livingCaseId && env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0") {
      try {
        markOpportunityOpenedDeliveredOnDb(db, {
          opportunityCaseId: livingCaseId,
          alertId,
          discordMessageId: res.messageId ?? null,
          frozenEntry: finalInput.entry?.mid ?? null,
          nowMs: now(),
        });
      } catch { /* content/summary failures never block SENT */ }
    } else if (env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0" && lifecycleReady && !livingCaseId) {
      console.error(`[options-delivery] SENT without opportunity case for ${alertId} — grader/readiness will be incomplete`);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { mirrorOwnerIntradayOnSent } = require("@/lib/notifications/owner-intraday-mirror");
      void mirrorOwnerIntradayOnSent({
        db,
        delivery: finalInput,
        alertId,
        opportunityCaseId: livingCaseId,
        opportunityFingerprint: livingFingerprint,
        actionableReason: finalGate.actionableReason,
        invalidation: finalGate.invalidation,
        setupFamily: finalInput.strategy,
        nowMs: now(),
        env,
      }).catch((err: any) => {
        console.warn(`[owner-intraday-mirror] ${String(err?.message ?? err).slice(0, 120)}`);
      });
    } catch { /* isolated — owner recap must never affect subscriber SENT */ }
    return base("SENT", true, "delivered", true, { opportunityCaseId: livingCaseId });
  }
  reconcileDeliveredPaperSendFailureOnDb(
    db,
    paperReservation,
    now(),
    Boolean(res.ambiguous),
    res.error ?? "send_failed",
  );
  try {
    persistPaperReservationLink(
      db,
      alertId,
      paperReservation,
      res.ambiguous ? "PENDING_RECONCILIATION" : "ABORTED",
    );
  } catch { /* alert failure persistence below remains authoritative */ }
  // An AMBIGUOUS timeout may have been delivered — exhaust retries so NO later call can resend it.
  const finalRetryCount = res.ambiguous ? maxRetries : attempt;
  try { persist(db, alertId, finalInput, "SEND_FAILED", { status: res.status, latencyMs: res.latencyMs, retryCount: finalRetryCount, failureReason: res.ambiguous ? `ambiguous_timeout: ${res.error}` : res.error, paperLinked: false, sessionState: state }, now()); } catch { /* isolated */ }
  if (res.ambiguous) {
    try {
      db.prepare(
        `INSERT INTO discord_send_attempts (alert_id, opportunity_case_id, kind, ambiguous, discord_message_id, error, created_at_ms)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(alertId, livingCaseId, "opening", 1, null, res.error ?? "ambiguous_timeout", now());
    } catch { /* optional table */ }
  }
  // Clear send failure (not ambiguous): release the active opportunity claim so a later retry can open.
  // Ambiguous timeouts keep the claim — Discord may already have the message.
  if (!res.ambiguous && livingCaseId && env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0") {
    try {
      releaseOpportunityOpeningClaimOnDb(db, livingCaseId);
    } catch { /* isolated */ }
  }
  return base("SEND_FAILED", false, res.ambiguous ? "ambiguous_timeout_no_retry" : "send_failed", false, { opportunityCaseId: livingCaseId });
}

function finalize(
  deps: DeliveryDeps,
  input: DeliveryInput,
  alertId: string,
  state: DeliveryState,
  reason: string,
  nowMs: number,
  sessionSt?: string,
  extra: { opportunityCaseId?: string | null; suppressedDuplicate?: boolean } = {},
): DeliveryOutcome {
  try { persist((deps.getDb ?? liveDb)(), alertId, input, state, { failureReason: reason, paperLinked: false, sessionState: sessionSt }, nowMs); } catch { /* isolated */ }
  return { state, alertId, sent: false, reason, paperLinked: false, ...extra };
}

/** Operator transport test: verify DISCORD_WEBHOOK_OPTIONS + send a synthetic connectivity message.
 *  NO ticker/contract/entry; creates NO paper trade and NO performance record. */
export async function optionsWebhookTransportTest(deps: { send?: (p: Record<string, unknown>) => Promise<SendResult>; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; configured: boolean; status: number | null; latencyMs: number; error: string | null }> {
  const env = deps.env ?? process.env;
  const configured = Boolean(String(env.DISCORD_WEBHOOK_OPTIONS ?? "").trim());
  if (!configured) return { ok: false, configured: false, status: null, latencyMs: 0, error: "DISCORD_WEBHOOK_OPTIONS not set" };
  const send = deps.send ?? defaultSend;
  const res = await send({ content: `OptiScan options webhook transport test — connectivity only, not a market callout. ${BETA_LABEL}` });
  return { ok: res.ok, configured: true, status: res.status, latencyMs: res.latencyMs, error: res.error };
}

/** Milestone connectivity test — threaded reply labeled TEST ONLY; no paper/alert rows. */
export async function optionsMilestoneConnectivityTest(deps: {
  send?: (p: Record<string, unknown>) => Promise<SendResult>;
  env?: NodeJS.ProcessEnv;
  replyToMessageId?: string | null;
} = {}): Promise<{ ok: boolean; configured: boolean; status: number | null; latencyMs: number; error: string | null; replied: boolean }> {
  const env = deps.env ?? process.env;
  const configured = Boolean(String(env.DISCORD_WEBHOOK_OPTIONS ?? "").trim());
  if (!configured) return { ok: false, configured: false, status: null, latencyMs: 0, error: "DISCORD_WEBHOOK_OPTIONS not set", replied: false };
  const send = deps.send ?? defaultSend;
  const content = `TEST ONLY — NOT A TRADE\nMilestone connectivity check (return ladder / closed / report card path). ${BETA_LABEL}`;
  const payload: Record<string, unknown> = { content };
  if (deps.replyToMessageId) {
    payload.message_reference = { message_id: deps.replyToMessageId };
    payload.allowed_mentions = { parse: [] };
  }
  const res = await send(payload);
  return {
    ok: res.ok,
    configured: true,
    status: res.status,
    latencyMs: res.latencyMs,
    error: res.error,
    replied: Boolean(deps.replyToMessageId),
  };
}

/** Read-only delivery metrics (never includes the webhook secret). */
export function readDeliveryMetricsOnDb(db: DDb): Record<string, unknown> {
  const has = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_alerts'").get());
  if (!has) return { enabled: false, ready: 0, sendAttempts: 0, sent: 0, sendFailed: 0, tooLate: 0, rejected: 0, duplicatesSuppressed: 0, retries: 0, putsSuppressed: 0, linkedPaper: 0, latencyMs: { p50: null, p95: null }, latestSentAtMs: null, latestFailureReason: null };
  const n = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any)?.n ?? 0);
  const lat = (db.prepare("SELECT latency_ms FROM options_alerts WHERE state='SENT' AND latency_ms IS NOT NULL ORDER BY latency_ms").all() as any[]).map((r) => r.latency_ms);
  const p = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil(q * lat.length) - 1)] : null);
  return {
    enabled: true,
    ready: n("SELECT COUNT(*) n FROM options_alerts WHERE state='READY'"),
    sendAttempts: n("SELECT COUNT(*) n FROM options_alerts WHERE state IN ('SEND_ATTEMPTED','SENT','SEND_FAILED')"),
    sent: n("SELECT COUNT(*) n FROM options_alerts WHERE state='SENT'"),
    sendFailed: n("SELECT COUNT(*) n FROM options_alerts WHERE state='SEND_FAILED'"),
    tooLate: n("SELECT COUNT(*) n FROM options_alerts WHERE state='TOO_LATE'"),
    rejected: n("SELECT COUNT(*) n FROM options_alerts WHERE state='REJECTED'"),
    retries: n("SELECT COALESCE(SUM(retry_count),0) n FROM options_alerts"),
    putsSuppressed: n("SELECT COUNT(*) n FROM options_alerts WHERE research_only=1 AND state='REJECTED'"),
    linkedPaper: n("SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND paper_linked=1"),
    latencyMs: { p50: p(0.5), p95: p(0.95) },
    latestSentAtMs: (db.prepare("SELECT MAX(sent_at_ms) m FROM options_alerts WHERE state='SENT'").get() as any)?.m ?? null,
    latestFailureReason: (db.prepare("SELECT failure_reason FROM options_alerts WHERE state='SEND_FAILED' ORDER BY updated_at_ms DESC LIMIT 1").get() as any)?.failure_reason ?? null,
    // Compact-alert observability. alertsMissingTargets MUST stay 0 — every SENT alert carries T1/T2/Stop.
    ...(() => {
      try {
        const bySession: Record<string, number> = {};
        for (const r of db.prepare("SELECT session_state ss, COUNT(*) c FROM options_alerts WHERE state='SENT' AND session_state IS NOT NULL GROUP BY session_state").all() as any[]) bySession[r.ss] = r.c;
        const mids = (db.prepare("SELECT entry_mid FROM options_alerts WHERE state='SENT' AND entry_mid IS NOT NULL ORDER BY entry_mid").all() as any[]).map((r) => r.entry_mid);
        const q = (f: number) => (mids.length ? mids[Math.min(mids.length - 1, Math.ceil(f * mids.length) - 1)] : null);
        return {
          sentBySessionState: bySession,
          entryMid: { n: mids.length, p50: q(0.5), min: mids[0] ?? null, max: mids[mids.length - 1] ?? null },
          alertsMissingTargets: n("SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND (target_t1 IS NULL OR target_t2 IS NULL OR target_stop IS NULL)"),
          openingRateLimited: n("SELECT COUNT(*) n FROM options_alerts WHERE failure_reason='opening_window_rate_limited'"),
          duplicateSetupsSuppressed: n("SELECT COUNT(*) n FROM options_alerts WHERE failure_reason='duplicate_setup'"),
        };
      } catch { return { sentBySessionState: {}, entryMid: { n: 0, p50: null, min: null, max: null }, alertsMissingTargets: 0, openingRateLimited: 0, duplicateSetupsSuppressed: 0 }; }
    })(),
  };
}
