/**
 * Owner-only intraday actionable mirror — fires after a genuine subscriber SEND.
 * Additive recap webhook only; never alters subscriber delivery or readiness.
 */
import { tradingDay } from "../trading-session.ts";
import { resolveOperatingMode } from "../dashboard/operating-mode.ts";
import { buildOpportunityIdentity, opportunityFingerprint } from "../opportunity-case/identity.ts";
import {
  formatIntradayActionable,
  type IntradayActionableInput,
  sendOwnerResearchNotify,
} from "./owner-research-notify.ts";
import type { DeliveryInput } from "../research/options/delivery.ts";

export interface IntradayMirrorInput {
  db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown }; exec: (sql: string) => unknown };
  delivery: DeliveryInput;
  alertId: string;
  opportunityCaseId?: string | null;
  opportunityFingerprint?: string | null;
  actionableReason: string;
  invalidation: string;
  setupFamily?: string | null;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test hook — defaults to recap webhook post. */
  postRecap?: (content: string) => Promise<{ ok: boolean; reason?: string }>;
}

export interface IntradayMirrorResult {
  mirrored: boolean;
  skipped: boolean;
  reason: string;
}

function intradayMirrorEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OWNER_RESEARCH_DISCORD_ENABLED === "1" && env.OWNER_RESEARCH_INTRADAY_ENABLED === "1";
}

function ownerActionableWebhook(env: NodeJS.ProcessEnv): string {
  return String(env.DISCORD_WEBHOOK_OWNER_ACTIONABLE ?? "").trim();
}

function optionsWebhook(env: NodeJS.ProcessEnv): string {
  return String(env.DISCORD_WEBHOOK_OPTIONS ?? env.DISCORD_WEBHOOK_URL ?? "").trim();
}

export function intradayMirrorDedupKey(
  fingerprint: string,
  optionSymbol: string,
  lifecycle: "send" | "contract_changed" | "confirmation_strengthened" | "milestone" | "thesis_weakening" | "exit" = "send",
): string {
  return `${fingerprint}|${optionSymbol}|${lifecycle}`;
}

export function buildIntradayActionablePayload(opts: {
  delivery: DeliveryInput;
  actionableReason: string;
  invalidation: string;
  setupFamily?: string | null;
  opportunityCaseId?: string | null;
  label?: "LIVE" | "TEST";
  baseUrl?: string | null;
}): IntradayActionableInput {
  const c = opts.delivery.contract;
  const entry = opts.delivery.entry;
  const bid = c.bid;
  const ask = c.ask;
  const entryZone =
    bid != null && ask != null && bid > 0 && ask > 0
      ? `$${bid.toFixed(2)}–$${ask.toFixed(2)}`
      : entry?.mid != null
        ? `$${entry.mid.toFixed(2)}`
        : null;
  const quoteFreshness =
    c.quoteAgeMs == null
      ? "fresh"
      : c.quoteAgeMs <= (opts.delivery.maxQuoteAgeMs ?? 15_000)
        ? `fresh · ${Math.round(c.quoteAgeMs / 1000)}s`
        : `stale · ${Math.round(c.quoteAgeMs / 1000)}s`;
  const confRaw = opts.delivery.featureSnapshot?.confidence ?? opts.delivery.featureSnapshot?.contractScore;
  const confidence = typeof confRaw === "number" && Number.isFinite(confRaw) ? Math.round(confRaw) : null;
  const base = String(opts.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const detailUrl = opts.opportunityCaseId
    ? (base ? `${base}/intelligence/${encodeURIComponent(opts.opportunityCaseId)}` : `/intelligence/${encodeURIComponent(opts.opportunityCaseId)}`)
    : base
      ? `${base}/`
      : "/";

  return {
    label: opts.label ?? "LIVE",
    symbol: opts.delivery.candidateSymbol,
    side: c.side,
    contract: c.optionSymbol,
    expiration: c.expiration,
    strike: c.strike,
    entryZone,
    bid,
    ask,
    t1: entry?.t1 ?? null,
    t2: entry?.t2 ?? null,
    stop: entry?.stop ?? null,
    confidence,
    setupFamily: opts.setupFamily ?? opts.delivery.strategy,
    triggerConfirmed: opts.actionableReason,
    actionableReason: opts.actionableReason,
    mainRisk: opts.invalidation || "Honor stop if structure fails.",
    quoteFreshness,
    detailUrl,
  };
}

export function shouldMirrorIntradayActionable(
  opts: Pick<IntradayMirrorInput, "delivery" | "nowMs" | "env" | "opportunityFingerprint"> & { fingerprint?: string | null },
): { ok: boolean; reason: string; fingerprint: string | null; operatingMode: string | null } {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();
  if (!intradayMirrorEnabled(env)) {
    return { ok: false, reason: "OWNER_RESEARCH_INTRADAY_ENABLED!=1", fingerprint: null, operatingMode: null };
  }

  const operating = resolveOperatingMode({ nowMs, dbOk: true });
  if (operating.mode !== "REGULAR_SESSION_LIVE") {
    return { ok: false, reason: `session_gate:${operating.mode}`, fingerprint: null, operatingMode: operating.mode };
  }

  const c = opts.delivery.contract;
  if (!c.optionSymbol) return { ok: false, reason: "missing_contract", fingerprint: null, operatingMode: operating.mode };
  if (c.bid == null || c.bid <= 0 || c.ask == null || c.ask <= 0) {
    return { ok: false, reason: "missing_fresh_bid_ask", fingerprint: null, operatingMode: operating.mode };
  }
  const maxAge = opts.delivery.maxQuoteAgeMs ?? 15_000;
  if (c.quoteAgeMs != null && c.quoteAgeMs > maxAge) {
    return { ok: false, reason: "stale_quote", fingerprint: null, operatingMode: operating.mode };
  }

  const fingerprint = opts.opportunityFingerprint
    ?? opts.fingerprint
    ?? opportunityFingerprint(buildOpportunityIdentity({
      symbol: opts.delivery.candidateSymbol,
      side: c.side,
      expiration: c.expiration,
      strike: c.strike,
      strategyKey: opts.delivery.strategy,
      nowMs,
      direction: c.side === "put" ? "bearish" : "bullish",
    }));

  return { ok: true, reason: "ok", fingerprint, operatingMode: operating.mode };
}

/**
 * Mirror a successful subscriber SEND to the owner recap channel.
 * Never throws — failures are logged via return reason only.
 */
export async function mirrorOwnerIntradayOnSent(opts: IntradayMirrorInput): Promise<IntradayMirrorResult> {
  try {
    const env = opts.env ?? process.env;
    const nowMs = opts.nowMs ?? Date.now();
    const gate = shouldMirrorIntradayActionable(opts);
    if (!gate.ok || !gate.fingerprint) {
      return { mirrored: false, skipped: true, reason: gate.reason };
    }
    if (!ownerActionableWebhook(env)) {
      return { mirrored: false, skipped: true, reason: "DISCORD_WEBHOOK_OWNER_ACTIONABLE not configured" };
    }
    if (ownerActionableWebhook(env) === optionsWebhook(env)) {
      return { mirrored: false, skipped: true, reason: "owner_actionable_same_as_options" };
    }

    const dedupKey = intradayMirrorDedupKey(gate.fingerprint, opts.delivery.contract.optionSymbol, "send");
    const content = formatIntradayActionable(buildIntradayActionablePayload({
      delivery: opts.delivery,
      actionableReason: opts.actionableReason,
      invalidation: opts.invalidation,
      setupFamily: opts.setupFamily ?? opts.delivery.strategy,
      opportunityCaseId: opts.opportunityCaseId,
      label: "LIVE",
    }));

    const notify = await sendOwnerResearchNotify({
      db: opts.db,
      kind: "intraday_actionable",
      content,
      symbol: dedupKey,
      env,
      nowMs,
      postOverride: opts.postRecap
        ? async (body) => {
            const res = await opts.postRecap!(body);
            return { ok: res.ok, reason: res.reason };
          }
        : undefined,
    });
    return {
      mirrored: notify.sent,
      skipped: notify.skipped,
      reason: notify.reason,
    };
  } catch (err: any) {
    return { mirrored: false, skipped: false, reason: String(err?.message ?? err).slice(0, 160) };
  }
}
