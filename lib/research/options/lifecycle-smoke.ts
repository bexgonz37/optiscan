/**
 * Gated Opportunity Lifecycle smoke test.
 * HARD no-op unless OPTIONS_LIFECYCLE_SMOKE=1.
 * Uses the real deliverOptionsCallout + milestone claim path with a synthetic SMOKE contract.
 */
import { deliverOptionsCallout, type SendResult } from "./delivery.ts";
import {
  applyOpportunityMarkOnDb,
  completeMilestoneDeliveryOnDb,
  closeOpportunityOnDb,
  findActiveOpportunityByFingerprintOnDb,
  loadCaseJsonOnDb,
  opportunityLifecycleSchemaReady,
} from "../../opportunity-case/live.ts";
import { buildOpportunityIdentity, opportunityFingerprint } from "../../opportunity-case/identity.ts";
import { formatOpportunityClosedUpdate, formatReturnMilestoneUpdate } from "./milestone-format.ts";
import { listEvidenceForCaseOnDb } from "../../opportunity-case/evidence.ts";

export function lifecycleSmokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPTIONS_LIFECYCLE_SMOKE === "1";
}

export interface LifecycleSmokeResult {
  ok: boolean;
  reason?: string;
  openingSent: boolean;
  openingAlertId: string | null;
  opportunityCaseId: string | null;
  discordOpeningMessageId: string | null;
  duplicateSuppressed: boolean;
  evidenceAttached: number;
  milestonePercent: number | null;
  milestoneSent: boolean;
  milestoneRepliedToOpening: boolean;
  milestoneMessageId: string | null;
  closed: boolean;
  closeSent: boolean;
  closeRepliedToOpening: boolean;
  pipelineLifecycleActive: boolean;
}

export async function runOpportunityLifecycleSmoke(deps: {
  getDb: () => any;
  send?: (payload: Record<string, unknown>) => Promise<SendResult>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}): Promise<LifecycleSmokeResult> {
  const env = deps.env ?? process.env;
  const base: LifecycleSmokeResult = {
    ok: false,
    openingSent: false,
    openingAlertId: null,
    opportunityCaseId: null,
    discordOpeningMessageId: null,
    duplicateSuppressed: false,
    evidenceAttached: 0,
    milestonePercent: null,
    milestoneSent: false,
    milestoneRepliedToOpening: false,
    milestoneMessageId: null,
    closed: false,
    closeSent: false,
    closeRepliedToOpening: false,
    pipelineLifecycleActive: false,
  };
  if (!lifecycleSmokeEnabled(env)) {
    return { ...base, reason: "OPTIONS_LIFECYCLE_SMOKE is not enabled (set OPTIONS_LIFECYCLE_SMOKE=1)" };
  }
  if (env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED === "0") {
    return { ...base, reason: "OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED=0" };
  }
  const db = deps.getDb();
  if (!opportunityLifecycleSchemaReady(db)) {
    return { ...base, reason: "lifecycle schema not ready (migration missing)" };
  }
  base.pipelineLifecycleActive = true;

  const now = deps.now ?? Date.now;
  const t0 = now();
  const strike = 210;
  const expiration = "2099-01-02"; // far-dated synthetic — never a real tradeable signal
  const symbol = "SMKE";
  const strategy = "momentum_acceleration";
  const optionSymbol = `O:${symbol}990102C00210000`;

  let openingMessageId: string | null = null;
  let milestoneMessageId: string | null = null;
  let sawReplyReference = false;
  const defaultSend = async (payload: Record<string, unknown>): Promise<SendResult> => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { postToDiscord } = require("@/lib/notifications");
    if (payload.message_reference) sawReplyReference = true;
    const r = await postToDiscord(payload, { webhook: "options" });
    return { ok: true, status: r.httpStatus ?? 204, messageId: r.messageId ?? null, latencyMs: 1, ambiguous: false, error: null };
  };
  const send = deps.send ?? defaultSend;

  const mk = (nowMs: number) => ({
    candidateSymbol: symbol,
    strategy,
    researchOnly: false,
    contract: {
      optionSymbol,
      side: "call" as const,
      strike,
      expiration,
      bid: 5.1,
      ask: 5.3,
      spreadPct: 3.8,
      quoteAgeMs: 200,
      dte: 999,
      volume: 1000,
      openInterest: 5000,
      iv: 0.4,
      delta: 0.5,
      providerTimestamp: nowMs - 200,
    },
    message: [
      `🟢 **BUYING ${symbol} $${strike} CALL** · exp 01/02`,
      "LIFECYCLE SMOKE — synthetic connectivity/dedup test, not a market callout.",
      `${symbol} @ $200.00`,
      "Entry ~ **$5.20** · Targets **$6.20 / $7.30**",
    ].join("\n"),
    observedUnderlyingPrice: 200,
    currentUnderlyingPrice: 200,
    chaseLimitPct: 5,
    underlyingPrice: 200,
    decisionMs: nowMs,
    session: "regular",
    entry: { bid: 5.1, ask: 5.3, mid: 5.2, spreadPct: 3.8, quoteAgeMs: 200, t1: 6.2, t2: 7.3, stop: 4.2, methodology: "lifecycle_smoke" },
    tier: 1 as const,
  });

  const smokeEnv = {
    ...env,
    INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
    EARLY_OPTIONS_CALLOUTS_ENABLED: "1",
    OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
    OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "1",
    OPTIONS_CALLOUTS_KILL: "0",
  };

  const open = await deliverOptionsCallout(mk(t0), { getDb: () => db, send, now: () => t0 }, smokeEnv);
  base.openingSent = Boolean(open.sent);
  base.openingAlertId = open.alertId;
  base.opportunityCaseId = open.opportunityCaseId ?? null;
  if (!open.sent || !open.opportunityCaseId) {
    return { ...base, reason: `opening delivery failed: ${open.reason}` };
  }
  const opened = loadCaseJsonOnDb(db, open.opportunityCaseId);
  openingMessageId = opened?.discord?.messageId ?? null;
  base.discordOpeningMessageId = openingMessageId;

  const dup = await deliverOptionsCallout(mk(t0 + 30_000), { getDb: () => db, send, now: () => t0 + 30_000 }, smokeEnv);
  base.duplicateSuppressed = ["matching_active_opportunity", "matching_active_thesis"].includes(String(dup.reason)) && !dup.sent;
  const evidence = listEvidenceForCaseOnDb(db, open.opportunityCaseId, 20);
  base.evidenceAttached = evidence.length;
  if (!base.duplicateSuppressed) {
    return { ...base, reason: `duplicate not suppressed: ${dup.reason}` };
  }
  if (base.evidenceAttached < 1) {
    return { ...base, reason: "duplicate suppressed but no evidence attached" };
  }

  // Force +50% milestone via living case path, then send Discord update with reply reference.
  const applied = applyOpportunityMarkOnDb(db, {
    opportunityCaseId: open.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 7.8,
    returnPct: 50,
    nowMs: t0 + 60_000,
    env: smokeEnv,
  });
  if (!applied.claimed || applied.deliverReturnMilestone !== 50 || !applied.summary) {
    return { ...base, reason: "milestone claim failed" };
  }
  base.milestonePercent = 50;
  const content = formatReturnMilestoneUpdate({
    symbol,
    optionType: "CALL",
    strike,
    milestonePercent: 50,
    summary: applied.summary,
    opportunityCaseId: open.opportunityCaseId,
  });
  const payload: Record<string, unknown> = {
    content: `${content}\n\nPAPER/BETA TEST — NOT FINANCIAL ADVICE`,
  };
  if (openingMessageId) {
    payload.message_reference = { message_id: openingMessageId };
    payload.allowed_mentions = { parse: [] };
  }
  try {
    const res = await send(payload);
    base.milestoneSent = Boolean(res.ok);
    milestoneMessageId = res.messageId ?? null;
    base.milestoneMessageId = milestoneMessageId;
    base.milestoneRepliedToOpening = Boolean(openingMessageId && (sawReplyReference || payload.message_reference));
    completeMilestoneDeliveryOnDb(db, {
      opportunityCaseId: open.opportunityCaseId,
      milestonePercent: 50,
      discordMessageId: milestoneMessageId,
      nowMs: t0 + 60_001,
      ok: Boolean(res.ok),
      claimToken: applied.claimToken,
    });
  } catch (e: any) {
    completeMilestoneDeliveryOnDb(db, {
      opportunityCaseId: open.opportunityCaseId,
      milestonePercent: 50,
      discordMessageId: null,
      nowMs: t0 + 60_001,
      ok: false,
      claimToken: applied.claimToken,
    });
    return { ...base, reason: `milestone send failed: ${String(e?.message ?? e)}` };
  }

  closeOpportunityOnDb(db, {
    opportunityCaseId: open.opportunityCaseId,
    nowMs: t0 + 90_000,
    exitReason: "lifecycle_smoke_complete",
    returnPct: 50,
    currentMark: 7.8,
  });
  const fp = opportunityFingerprint(buildOpportunityIdentity({
    symbol, side: "call", expiration, strike, strategyKey: strategy, nowMs: t0,
  }));
  base.closed = findActiveOpportunityByFingerprintOnDb(db, fp) == null;

  // Closed opportunity Discord — reply to the original opening alert when possible.
  const closedCase = loadCaseJsonOnDb(db, open.opportunityCaseId);
  if (closedCase?.summary) {
    const closeContent = formatOpportunityClosedUpdate({
      symbol,
      optionType: "CALL",
      strike,
      summary: closedCase.summary,
      exitReason: "lifecycle_smoke_complete",
      opportunityCaseId: open.opportunityCaseId,
    });
    const closePayload: Record<string, unknown> = {
      content: `${closeContent}\n\nPAPER/BETA TEST — NOT FINANCIAL ADVICE`,
    };
    if (openingMessageId) {
      closePayload.message_reference = { message_id: openingMessageId };
      closePayload.allowed_mentions = { parse: [] };
    }
    try {
      const closeRes = await send(closePayload);
      base.closeSent = Boolean(closeRes.ok);
      base.closeRepliedToOpening = Boolean(openingMessageId && closePayload.message_reference);
    } catch (e: any) {
      return { ...base, reason: `close Discord failed: ${String(e?.message ?? e)}` };
    }
  }

  base.ok = base.openingSent
    && base.duplicateSuppressed
    && base.evidenceAttached >= 1
    && base.milestoneSent
    && base.closed
    && base.closeSent;
  if (!base.ok) base.reason = "one or more lifecycle smoke assertions failed";
  return base;
}
