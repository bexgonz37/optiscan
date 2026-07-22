/**
 * lib/research/options/delivery.ts — GATED private-beta options Discord delivery. One message per
 * play, honest send states, idempotent, isolated. HARD no-op unless BOTH
 * INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1 AND EARLY_OPTIONS_CALLOUTS_ENABLED=1 (and no kill switch).
 * A Discord failure NEVER blocks the monitor. Puts are RESEARCH_ONLY and are NOT sent as actionable
 * callouts. Nothing here executes real money; the message carries a PAPER/BETA label.
 */
import { researchFlags } from "../flags.ts";
import { buildRealOptionEntry, persistDeliveredMirrorOnDb, type OptionQuote } from "./paper.ts";
import { sessionState, openingWindowAllows, defaultOpeningLimit } from "./session-state.ts";
import type { FrozenEntry } from "./callout.ts";
import { OPTIONS_TIER0 } from "./discovery.ts";

export type DeliveryState = "READY" | "SEND_ATTEMPTED" | "SENT" | "SEND_FAILED" | "TOO_LATE" | "REJECTED" | "EXPIRED";

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
}

export interface SendResult { ok: boolean; status: number | null; messageId: string | null; latencyMs: number; ambiguous: boolean; error: string | null }
export interface DeliveryDeps { getDb?: () => any; send?: (payload: Record<string, unknown>) => Promise<SendResult>; now?: () => number; maxRetries?: number }
export interface DeliveryOutcome { state: DeliveryState; alertId: string; sent: boolean; reason: string; paperLinked: boolean }

interface DDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }
const liveDb = () => require("@/lib/db").getDb(); // eslint-disable-line @typescript-eslint/no-require-imports

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
 * Create the ONE DELIVERED_ALERT_PAPER mirror for an alert that actually SENT — the exact contract,
 * quote, underlying, strategy, decision timestamp, and alert_id the subscriber received. Idempotent
 * (persistDeliveredMirrorOnDb dedups by alert_id). Gated on REAL_OPTION_PAPER_ENABLED. Isolated: a
 * mirror failure does NOT change the honest SENT state — it only leaves paper_linked=0 (surfaced),
 * and the idempotent writer allows a later retry. Returns whether the mirror now exists (linked).
 */
function createDeliveredMirror(db: DDb, i: DeliveryInput, alertId: string, env: NodeJS.ProcessEnv): boolean {
  try {
    if (!researchFlags(env).realOptionPaper) return false;
    const c = i.contract;
    const decisionMs = i.decisionMs ?? Date.now();
    const q: OptionQuote = { optionSymbol: c.optionSymbol, side: c.side, strike: c.strike, expiration: c.expiration, dte: c.dte ?? 0, bid: c.bid, ask: c.ask, volume: c.volume ?? null, openInterest: c.openInterest ?? null, iv: c.iv ?? null, delta: c.delta ?? null, quoteAgeMs: c.quoteAgeMs, providerTimestamp: c.providerTimestamp ?? null };
    const built = buildRealOptionEntry({ quote: q, underlyingPrice: i.underlyingPrice, strategy: i.strategy }, env);
    // The mirror uses the EXACT frozen midpoint + deterministic targets the subscriber saw — never a
    // later/improved entry. entryFill = the displayed midpoint; target = T1; invalidation = Stop.
    const entry = i.entry ? { ...built, entryFill: i.entry.mid, target: i.entry.t1, invalidation: i.entry.stop } : built;
    const r = persistDeliveredMirrorOnDb(db, entry, decisionMs, alertId, { session: i.session ?? null, featureSnapshotJson: i.entry ? JSON.stringify({ targetMethodology: i.entry.methodology, frozen: i.entry }) : undefined });
    return r.inserted || r.existed;
  } catch { return false; }
}

function persist(db: DDb, alertId: string, i: DeliveryInput, state: DeliveryState, extra: Record<string, unknown>, nowMs: number): void {
  const e = i.entry ?? null;
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
    extra.sessionState ?? null, e?.mid ?? null, e?.spreadPct ?? null, i.contract.providerTimestamp ?? null,
    e?.t1 ?? null, e?.t2 ?? null, e?.stop ?? null, e?.methodology ?? null,
    nowMs, nowMs,
  );
}

/**
 * Gated single-callout delivery. Re-checks freshness/spread/chase at delivery time; dedups by
 * alertId (no second message, no duplicate after an ambiguous timeout); writes SENT only after a
 * successful Discord response. Never throws into the caller.
 */
export async function deliverOptionsCallout(input: DeliveryInput, deps: DeliveryDeps = {}, env: NodeJS.ProcessEnv = process.env): Promise<DeliveryOutcome> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const f = researchFlags(env);
  const alertId = optionsAlertId(input.candidateSymbol, input.strategy, input.contract.optionSymbol, nowMs);
  const base = (state: DeliveryState, sent: boolean, reason: string, paperLinked = false): DeliveryOutcome => ({ state, alertId, sent, reason, paperLinked });

  // FLAGS + kill switch — ZERO webhook sends unless both flags on and not killed.
  if (!f.independentOptionsDiscovery || !f.earlyOptionsCallouts) return base("READY", false, "callouts_disabled");
  if (env.OPTIONS_PORTFOLIO_DELIVERY_ENABLED !== "1") return base("REJECTED", false, "portfolio_delivery_required");
  if (env.OPTIONS_CALLOUTS_KILL === "1") return base("REJECTED", false, "kill_switch_engaged");
  // Puts are RESEARCH_ONLY → never sent as actionable callouts (suppressed, reported).
  if (input.researchOnly || input.contract.side === "put") { try { persist((deps.getDb ?? liveDb)(), alertId, input, "REJECTED", { failureReason: "research_only_put_suppressed" }, nowMs); } catch { /* isolated */ } return base("REJECTED", false, "research_only_put_suppressed"); }

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

  // SETUP dedup (rolling, per symbol+side+strategy — NOT a global cooldown): a new expiration/strike or
  // minor score change on the SAME setup is not a new alert. A genuinely different strategy is a new key.
  const setupDedupMs = Number(env.OPTIONS_SETUP_DEDUP_MS);
  const dedupWindow = Number.isFinite(setupDedupMs) && setupDedupMs > 0 ? setupDedupMs : 20 * 60_000;
  try {
    // exclude THIS alert_id: the identical event falls through to the precise alertId dedup below.
    const dup = db.prepare("SELECT 1 FROM options_alerts WHERE candidate_symbol=? AND side=? AND strategy=? AND state='SENT' AND sent_at_ms >= ? AND alert_id != ? LIMIT 1").get(input.candidateSymbol, input.contract.side, input.strategy, nowMs - dedupWindow, alertId);
    if (dup) return finalize(deps, input, alertId, "REJECTED", "duplicate_setup", nowMs, state);
  } catch { /* table lazily created */ }

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
  let existing: any = null;
  try { existing = db.prepare("SELECT state, retry_count FROM options_alerts WHERE alert_id=?").get(alertId); } catch { /* table may be created lazily by caller */ }
  if (existing && (existing.state === "SENT" || existing.state === "SEND_ATTEMPTED")) return base(existing.state, false, "duplicate_suppressed", true);
  const maxRetries = deps.maxRetries ?? 1;
  const priorRetries = existing?.retry_count ?? 0;
  if (existing && existing.state === "SEND_FAILED" && priorRetries >= maxRetries) return base("SEND_FAILED", false, "retry_ceiling_reached");

  // Claim the slot as SEND_ATTEMPTED BEFORE sending, so a concurrent/duplicate call dedups.
  try { persist(db, alertId, input, "SEND_ATTEMPTED", { attemptedAtMs: nowMs, retryCount: priorRetries, sessionState: state }, nowMs); } catch { /* isolated */ }

  const payload = { content: `${input.message}\n\n${BETA_LABEL}` };
  const send = deps.send ?? defaultSend;
  let attempt = priorRetries, res: SendResult;
  for (;;) {
    res = await send(payload);
    if (res.ok || res.ambiguous || attempt >= maxRetries) break; // never retry an ambiguous timeout
    attempt += 1;
    await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** attempt))); // bounded backoff
  }
  if (res.ok) {
    // Alert delivered → create the ONE linked DELIVERED_ALERT_PAPER mirror (idempotent, same contract/
    // quote/underlying/strategy/decision-timestamp/alert_id). Never blocks or alters the SENT outcome;
    // a mirror failure just leaves paper_linked=0 (surfaced) and can be retried idempotently later.
    const linked = createDeliveredMirror(db, input, alertId, env);
    try { persist(db, alertId, input, "SENT", { status: res.status, latencyMs: res.latencyMs, retryCount: attempt, sentAtMs: now(), attemptedAtMs: nowMs, paperLinked: linked, sessionState: state }, now()); } catch { /* isolated */ }
    return base("SENT", true, "delivered", linked);
  }
  const paperLinked = Boolean(input.paperOptionSymbol && input.paperOptionSymbol === input.contract.optionSymbol);
  // An AMBIGUOUS timeout may have been delivered — exhaust retries so NO later call can resend it.
  const finalRetryCount = res.ambiguous ? maxRetries : attempt;
  try { persist(db, alertId, input, "SEND_FAILED", { status: res.status, latencyMs: res.latencyMs, retryCount: finalRetryCount, failureReason: res.ambiguous ? `ambiguous_timeout: ${res.error}` : res.error, sessionState: state }, now()); } catch { /* isolated */ }
  return base("SEND_FAILED", false, res.ambiguous ? "ambiguous_timeout_no_retry" : "send_failed", paperLinked);
}

function finalize(deps: DeliveryDeps, input: DeliveryInput, alertId: string, state: DeliveryState, reason: string, nowMs: number, sessionSt?: string): DeliveryOutcome {
  try { persist((deps.getDb ?? liveDb)(), alertId, input, state, { failureReason: reason, sessionState: sessionSt }, nowMs); } catch { /* isolated */ }
  return { state, alertId, sent: false, reason, paperLinked: false };
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
