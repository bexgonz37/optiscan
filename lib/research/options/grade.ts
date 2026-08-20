/**
 * lib/research/options/grade.ts — AUTOMATIC outcome grading for the independent options scanner.
 * Real-option paper positions are OPENED by the monitor (loop.ts) but must also be CLOSED and graded
 * autonomously — no manual grading command. This module:
 *   • decideOptionExit()  — PURE exit rules on the OPTION price (target / stop / expiration / time-stop).
 *   • gradeOpenOptionPositionsOnDb() — refresh each open position's quote, apply the rules, persist EXIT.
 *   • startOptionsGrader() — in-process singleton loop (gated), restart-safe (open rows persist in the DB
 *     so grading simply resumes after a deploy/restart). A provider/DB error NEVER stops the loop.
 *
 * P&L is computed from the OPTION contract price (×100), never the underlying. Only REAL_OPTION_PAPER
 * rows are graded here; equity paper, modeled options, and underlying proxies stay in their own lanes
 * and are never combined. HARD no-op unless INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1 AND
 * REAL_OPTION_PAPER_ENABLED=1. This does NOT touch any strategy entry gate.
 */
import { researchFlags } from "../flags.ts";
import { realOptionExit } from "./paper.ts";
import { dualWriteAfterOptionsPaperExit } from "../../broker/dual-write.ts";
import type { BrokerDb } from "../../broker/audit.ts";
import {
  applyOpportunityMarkOnDb,
  closeOpportunityOnDb,
  completeMilestoneDeliveryOnDb,
  emitContentEventForCase,
  findOpportunityCaseIdByAlertOnDb,
  loadCaseJsonOnDb,
} from "../../opportunity-case/live.ts";
import { formatOpportunityClosedUpdate, formatReturnMilestoneUpdate } from "./milestone-format.ts";
import { assertSubscriberScanAllowed } from "../../market-session-guard.ts";
import { isMilestoneDiscordEligibleOnDb } from "../../opportunity-case/milestone-eligibility.ts";
import { validateLifecycleQuote } from "./lifecycle-session.ts";
import { OWNER_VALIDATION_PAPER_KIND } from "../../opportunity-case/owner-mirror-identity.ts";
// Statically imported on purpose. This is the authority that decides whether a lifecycle
// update may be sent at all, and a dynamic `require` here would fail open in exactly the
// environments (tests, any non-Next runtime) where the guard most needs to be provable.
// The module is pure SQL reads plus `tradingDay` — it pulls in no Next server bits.
import { ownerOpeningWasSentOnDb } from "../../notifications/owner-delivery-truth.ts";
import { withProviderConsumer } from "../../provider-context.ts";

export interface OpenPosition {
  id: number; option_symbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number;
  entry_fill: number; result_class: string; strategy: string; underlying_price: number | null;
  target: number | null; invalidation: number | null; entered_at_ms: number; status: string;
  paper_kind?: string | null; alert_id?: string | null;
}
export interface RefreshedQuote {
  bid: number | null;
  ask: number | null;
  quoteAgeMs: number | null;
  providerTimestamp?: number | null;
}

export interface GradeConfig { takeProfitPct: number; stopLossPct: number; maxHoldMs: number; maxQuoteAgeMs: number }
export function defaultGradeConfig(env: NodeJS.ProcessEnv = process.env): GradeConfig {
  const n = (v: string | undefined, d: number, min = 0) => { const x = Number(v); return Number.isFinite(x) && x >= min ? x : d; };
  return {
    takeProfitPct: n(env.OPTIONS_PAPER_TAKE_PROFIT_PCT, 60, 1),
    stopLossPct: n(env.OPTIONS_PAPER_STOP_LOSS_PCT, 40, 1),
    maxHoldMs: n(env.OPTIONS_PAPER_MAX_HOLD_MS, 172_800_000, 60_000), // 2 days; expiration usually fires first
    maxQuoteAgeMs: n(env.OPTIONS_GRADE_MAX_QUOTE_AGE_MS, 900_000, 1000),
  };
}

/** Options expire end-of-day on their expiration date. Approximate the cutoff as 20:00 UTC (≈ US market
 *  close during EDT) on that date — good enough for paper time accounting; documented as approximate. */
export function expirationCutoffMs(expiration: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  const t = Date.parse(`${expiration}T20:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

export type ExitReason = "target_hit" | "stop_hit" | "expiration" | "time_stop" | "expiration_no_quote";
export interface ExitDecision {
  action: "hold" | "exit"; reason: ExitReason | null;
  exitFill: number | null; pnl: number | null; returnPct: number | null; note: string;
}

export function subscriberExitMode(env: NodeJS.ProcessEnv = process.env): "targets_then_bands" | "bands_only" {
  const raw = String(env.OPTIONS_SUBSCRIBER_EXIT_MODE ?? "targets_then_bands").trim().toLowerCase();
  return raw === "bands_only" ? "bands_only" : "targets_then_bands";
}

/**
 * PURE exit decision on a single open position given the latest quote. Priority:
 * 1) Frozen T1/stop prices (subscriber-visible targets) when OPTIONS_SUBSCRIBER_EXIT_MODE=targets_then_bands
 * 2) Option return % bands (safety backstop)
 * 3) Expiration / time-stop
 */
export function decideOptionExit(pos: OpenPosition, quote: RefreshedQuote | null, nowMs: number, cfg: GradeConfig = defaultGradeConfig(), env: NodeJS.ProcessEnv = process.env): ExitDecision {
  const hold = (note: string): ExitDecision => ({ action: "hold", reason: null, exitFill: null, pnl: null, returnPct: null, note });
  const fresh = quote != null && quote.bid != null && quote.bid > 0 && quote.ask != null && quote.ask > 0
    && (quote.quoteAgeMs == null || quote.quoteAgeMs <= cfg.maxQuoteAgeMs);

  if (fresh) {
    const ex = realOptionExit(pos.entry_fill, quote!.bid as number, quote!.ask as number);
    const mode = subscriberExitMode(env);
    if (mode === "targets_then_bands") {
      if (pos.target != null && pos.target > 0 && ex.exitFill >= pos.target) {
        return { action: "exit", reason: "target_hit", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: `exit at frozen T1 ${pos.target} (mark ${ex.exitFill})` };
      }
      if (pos.invalidation != null && pos.invalidation > 0 && ex.exitFill <= pos.invalidation) {
        return { action: "exit", reason: "stop_hit", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: `exit at frozen stop ${pos.invalidation} (mark ${ex.exitFill})` };
      }
    }
    if (ex.returnPct >= cfg.takeProfitPct) return { action: "exit", reason: "target_hit", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: `option return ${ex.returnPct}% ≥ +${cfg.takeProfitPct}% safety band` };
    if (ex.returnPct <= -cfg.stopLossPct) return { action: "exit", reason: "stop_hit", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: `option return ${ex.returnPct}% ≤ -${cfg.stopLossPct}% safety band` };
  }

  // Expiration — closes regardless of quote availability (time, not price).
  const cutoff = expirationCutoffMs(pos.expiration);
  if (cutoff != null && nowMs >= cutoff) {
    if (fresh) { const ex = realOptionExit(pos.entry_fill, quote!.bid as number, quote!.ask as number); return { action: "exit", reason: "expiration", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: "closed at expiration on last quote" }; }
    return { action: "exit", reason: "expiration_no_quote", exitFill: null, pnl: null, returnPct: null, note: "expired with no usable quote — closed unpriced (pnl null, not fabricated)" };
  }

  // Time-stop — bound how long a paper position stays open.
  if (nowMs - pos.entered_at_ms >= cfg.maxHoldMs) {
    if (fresh) { const ex = realOptionExit(pos.entry_fill, quote!.bid as number, quote!.ask as number); return { action: "exit", reason: "time_stop", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: "max hold reached" }; }
    return hold("max hold reached but no fresh quote to price the exit — hold until a quote or expiration");
  }

  return hold(fresh ? "within target/stop band" : "no fresh quote and not yet expired/timed-out");
}

interface GradeDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }
export interface GradeDeps {
  /** Refresh the latest quote for an open OCC contract. Returns null when unavailable (kept open). */
  getQuote: (optionSymbol: string, underlyingSymbol: string) => Promise<RefreshedQuote | null>;
  now?: () => number;
  /** Optional Discord sender for milestone / close updates (tests inject; live uses options webhook). */
  sendMilestone?: (payload: Record<string, unknown>) => Promise<{ ok: boolean; messageId?: string | null }>;
}
export interface GradePassResult {
  examined: number;
  graded: number;
  held: number;
  errors: number;
  byReason: Record<string, number>;
  milestonesDelivered?: number;
  closesDelivered?: number;
  /** Close updates delivered on the OWNER_VALIDATION_PAPER lane. Counted separately. */
  ownerClosesDelivered?: number;
  /**
   * Owner exits that produced NO Discord update, by reason. An owner close that goes
   * unannounced because its opening was suppressed is correct behaviour and must still be
   * visible — a silent zero here and a silent zero from a broken resolver look identical.
   */
  ownerCloseSkips?: Record<string, number>;
}

const occUnderlying = (occ: string) => occ.match(/^O:([A-Z]+)/)?.[1] ?? "";
function hasTable(db: GradeDb, table: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); } catch { return false; }
}
function hasCol(db: GradeDb, table: string, col: string): boolean {
  try { return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col)); } catch { return false; }
}

function resolveOpeningDiscordMessageId(db: GradeDb, caseId: string, alertId?: string | null): string | null {
  try {
    const oc = loadCaseJsonOnDb(db as any, caseId);
    if (oc?.discord?.messageId) return String(oc.discord.messageId);
  } catch { /* optional */ }
  if (!alertId) return null;
  try {
    const row = db.prepare("SELECT discord_message_id FROM options_alerts WHERE alert_id=?").get(alertId) as { discord_message_id?: string } | undefined;
    return row?.discord_message_id ? String(row.discord_message_id) : null;
  } catch {
    return null;
  }
}

async function sendLifecycleDiscordUpdate(
  deps: GradeDeps,
  content: string,
  replyToMessageId: string | null,
): Promise<{ ok: boolean; messageId: string | null; replied: boolean }> {
  const payload: Record<string, unknown> = { content };
  if (replyToMessageId) {
    payload.message_reference = { message_id: replyToMessageId };
    payload.allowed_mentions = { parse: [] };
  }
  const sendOnce = async (body: Record<string, unknown>) => {
    if (deps.sendMilestone) {
      const r = await deps.sendMilestone(body);
      return { ok: Boolean(r.ok), messageId: r.messageId ?? null };
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { postToDiscord } = require("@/lib/notifications");
    const r = await postToDiscord(body, { webhook: "options" });
    return { ok: true, messageId: r.messageId ?? null };
  };
  try {
    const r = await sendOnce(payload);
    return { ...r, replied: Boolean(replyToMessageId && payload.message_reference) };
  } catch {
    if (!replyToMessageId) return { ok: false, messageId: null, replied: false };
    try {
      const r = await sendOnce({ content });
      return { ...r, replied: false };
    } catch {
      return { ok: false, messageId: null, replied: false };
    }
  }
}
function recordLifecycleSuppression(
  db: GradeDb,
  pos: OpenPosition,
  quote: RefreshedQuote | null,
  nowMs: number,
  reason: string,
): void {
  if (!hasTable(db, "options_lifecycle_observations")) return;
  try {
    db.prepare(
      `INSERT INTO options_lifecycle_observations
        (paper_trade_id, alert_id, option_symbol, event_type, decision, reason,
         quote_ts_ms, observed_at_ms, bid, ask, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      pos.id,
      pos.alert_id ?? null,
      pos.option_symbol,
      "RETURN_MILESTONE",
      "SUPPRESSED",
      reason,
      quote?.providerTimestamp ?? null,
      nowMs,
      quote?.bid ?? null,
      quote?.ask ?? null,
      nowMs,
    );
  } catch { /* audit failure never changes trade state */ }
}

function recordObservedMark(
  db: GradeDb,
  pos: OpenPosition,
  quote: RefreshedQuote,
  eventAtMs: number,
  observedAtMs: number,
): void {
  const mark = realOptionExit(pos.entry_fill, quote.bid as number, quote.ask as number);
  try {
    if (hasTable(db, "options_paper_marks")) {
      db.prepare(
        `INSERT OR IGNORE INTO options_paper_marks
          (trade_id, option_symbol, mark_at_ms, bid, ask, exit_fill, return_pct, quote_age_ms, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(pos.id, pos.option_symbol, eventAtMs, quote.bid, quote.ask, mark.exitFill, mark.returnPct, quote.quoteAgeMs ?? null, observedAtMs);
    }
    if (hasCol(db, "options_paper_trades", "mfe_pct") && hasTable(db, "options_paper_marks")) {
      // The aggregate is filtered on the MARK's own contract, not merely on trade_id.
      // Aggregating every mark under a trade id is exactly the shape that produced the
      // +185.4% case peak: a price observed on one contract, divided by an entry paid on
      // another. A mirror is normally single-contract, so this changes nothing in the
      // healthy case — which is the point. It removes the path, not a symptom.
      const mm = db.prepare(
        `SELECT MAX(return_pct) mfe, MIN(return_pct) mae
           FROM options_paper_marks
          WHERE trade_id=? AND UPPER(TRIM(option_symbol))=UPPER(TRIM(?))`,
      ).get(pos.id, pos.option_symbol) as any;
      db.prepare("UPDATE options_paper_trades SET last_mark_return_pct=?, mfe_pct=?, mae_pct=?, updated_at_ms=? WHERE id=?")
        .run(mark.returnPct, mm?.mfe ?? mark.returnPct, mm?.mae ?? mark.returnPct, observedAtMs, pos.id);
    }
  } catch { /* mark storage is observability-only; never affect grading */ }
}

async function maybeUpdateOpportunityLifecycle(
  db: GradeDb,
  pos: OpenPosition,
  quote: RefreshedQuote | null,
  nowMs: number,
  cfg: GradeConfig,
  deps: GradeDeps,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  if (env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED === "0") return 0;
  if (pos.paper_kind && pos.paper_kind !== "DELIVERED_ALERT_PAPER") return 0;
  if (!(pos.entry_fill > 0)) return 0;
  if (!quote) return 0;
  const validatedQuote = validateLifecycleQuote({
    bid: quote.bid,
    ask: quote.ask,
    providerTimestamp: quote.providerTimestamp,
    observedAtMs: nowMs,
    maxQuoteAgeMs: cfg.maxQuoteAgeMs,
    env,
  });
  if (!validatedQuote.valid || validatedQuote.eventAtMs == null) {
    recordLifecycleSuppression(
      db,
      pos,
      quote,
      nowMs,
      validatedQuote.reason ?? "MARKET_CLOSED_OR_EVENT_TIME_UNVERIFIED",
    );
    return 0;
  }
  try {
    let caseId = pos.alert_id ? findOpportunityCaseIdByAlertOnDb(db as any, pos.alert_id) : null;
    if (!caseId && pos.alert_id) {
      try {
        const row = db.prepare("SELECT opportunity_case_id FROM options_alerts WHERE alert_id=?").get(pos.alert_id) as { opportunity_case_id?: string } | undefined;
        caseId = row?.opportunity_case_id ? String(row.opportunity_case_id) : null;
      } catch { /* optional */ }
    }
    if (!caseId) return 0;

    const eligibility = isMilestoneDiscordEligibleOnDb(db as any, {
      alertId: pos.alert_id,
      opportunityCaseId: caseId,
      paperKind: pos.paper_kind ?? "DELIVERED_ALERT_PAPER",
      nowMs,
    }, env);
    if (!eligibility.eligible) return 0;

    const mark = realOptionExit(pos.entry_fill, quote!.bid as number, quote!.ask as number);
    const applied = applyOpportunityMarkOnDb(db as any, {
      opportunityCaseId: caseId,
      frozenEntry: pos.entry_fill,
      currentMark: mark.exitFill,
      returnPct: mark.returnPct,
      nowMs,
      eventAtMs: validatedQuote.eventAtMs,
      env,
      // The quote was refreshed for THIS position's contract, so the position's OCC is
      // the contract the mark was observed on. Naming it lets the case refuse the mark
      // outright if the case froze a different contract.
      markOptionSymbol: pos.option_symbol,
    });
    if (!applied.applied) {
      recordLifecycleSuppression(db, pos, quote, nowMs, `MARK_IDENTITY_REFUSED:${applied.rejectedReason}`);
      return 0;
    }
    if (!applied.claimed || applied.deliverReturnMilestone == null || !applied.summary) return 0;

    const content = formatReturnMilestoneUpdate({
      symbol: occUnderlying(pos.option_symbol) || "UNK",
      optionType: pos.side === "put" ? "PUT" : "CALL",
      strike: pos.strike,
      milestonePercent: applied.deliverReturnMilestone,
      summary: applied.summary,
      opportunityCaseId: caseId,
      eventAtMs: validatedQuote.eventAtMs,
      deliveredAtMs: nowMs,
      delayedDelivery: validatedQuote.delayedDelivery,
    });
    const replyToMessageId = resolveOpeningDiscordMessageId(db, caseId, pos.alert_id);
    const sent = await sendLifecycleDiscordUpdate(deps, content, replyToMessageId);
    completeMilestoneDeliveryOnDb(db as any, {
      opportunityCaseId: caseId,
      milestonePercent: applied.deliverReturnMilestone,
      discordMessageId: sent.messageId,
      nowMs,
      ok: sent.ok,
      claimToken: applied.claimToken,
    });
    try {
      emitContentEventForCase(db as any, caseId, "RETURN_MILESTONE", nowMs, {
        milestonePercent: applied.deliverReturnMilestone,
        label: `+${applied.deliverReturnMilestone}%`,
      });
    } catch { /* never block Discord */ }
    return sent.ok ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * OWNER LIFECYCLE IDENTITY — how an owner paper exit finds the callout it belongs to.
 *
 * The subscriber lane resolves everything through `alert_id`: the alert row carries the
 * Discord message id, the paper mirror carries the alert id, and `paper_kind` is
 * DELIVERED_ALERT_PAPER. An owner callout has NONE of that. It writes no `options_alerts`
 * row at all, so `options_paper_trades.alert_id` is null for every owner mirror ever made,
 * and every gate on this path — the `paper_kind !== 'DELIVERED_ALERT_PAPER'` guard, the
 * `pos.alert_id` requirement, `isMilestoneDiscordEligibleOnDb`'s alert lookup, and its
 * `delivery_decision === 'DELIVERED'` check against a case the owner path stamps
 * `research_only` — refuses it. Four independent refusals, all returning "not eligible",
 * which is why owner callouts have never received a single lifecycle update.
 *
 * The identity that DOES exist is the one `owner-mirror-identity.ts` documents: the mirror
 * records its Opportunity Case inside its own `feature_snapshot_json`. That is resolved
 * here, and then the case is checked against the DISCORD DELIVERY LEDGER, which is the only
 * thing that knows whether a message was actually posted.
 *
 * SUPPRESSED OPENING => NO LIFECYCLE UPDATE, EVER. The case says
 * `OWNER_ACTIONABLE_DELIVERED` even when nothing was sent (deliberately, so the opening
 * claim is not released), so the case is not consulted for this. Only `status='SENT'` in
 * `discord_deliveries` authorises an update, and a reply to a message that does not exist
 * is exactly the failure that gate prevents.
 */
interface OwnerLifecycleIdentity {
  eligible: boolean;
  reason: string;
  opportunityCaseId: string | null;
  /** The opening Discord message, when one exists. Threading target for the update. */
  openingMessageId: string | null;
}

function ownerCaseIdForPaperTrade(db: GradeDb, tradeId: number): string | null {
  try {
    const row = db.prepare(
      "SELECT feature_snapshot_json FROM options_paper_trades WHERE id=?",
    ).get(tradeId) as { feature_snapshot_json?: string } | undefined;
    const raw = row?.feature_snapshot_json;
    if (typeof raw !== "string" || !raw) return null;
    const snap = JSON.parse(raw);
    const id = snap && typeof snap === "object" ? snap.opportunityCaseId : null;
    const s = id == null ? "" : String(id).trim();
    return s.length ? s : null;
  } catch {
    return null;
  }
}

function resolveOwnerLifecycleIdentity(
  db: GradeDb,
  pos: OpenPosition,
  env: NodeJS.ProcessEnv,
): OwnerLifecycleIdentity {
  const none = (reason: string): OwnerLifecycleIdentity =>
    ({ eligible: false, reason, opportunityCaseId: null, openingMessageId: null });
  if (env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED === "0") return none("lifecycle_disabled");
  if (env.OWNER_LIFECYCLE_DISCORD_ENABLED === "0") return none("owner_lifecycle_discord_disabled");
  const caseId = ownerCaseIdForPaperTrade(db, pos.id);
  if (!caseId) return none("owner_mirror_names_no_case");

  // The delivery ledger is the ONLY authority consulted here. Not the case, not the
  // mirror, not the notify log — every one of those is written for a suppressed opening too.
  let sent = false;
  try {
    sent = Boolean(ownerOpeningWasSentOnDb(db as any, caseId));
  } catch {
    return { eligible: false, reason: "delivery_ledger_unreadable", opportunityCaseId: caseId, openingMessageId: null };
  }
  if (!sent) {
    return { eligible: false, reason: "opening_not_sent", opportunityCaseId: caseId, openingMessageId: null };
  }

  // The opening message id lives on the case (written by markOwnerActionableOpeningDelivered
  // from the real send result, so it is null exactly when nothing was posted). Its absence
  // does not block the update — the close still goes out, just not threaded.
  const openingMessageId = resolveOpeningDiscordMessageId(db, caseId, null);
  return { eligible: true, reason: "opening_sent", opportunityCaseId: caseId, openingMessageId };
}

async function maybeDeliverOpportunityClosedDiscord(
  db: GradeDb,
  pos: OpenPosition,
  caseId: string,
  exit: { reason: string | null; returnPct: number | null; exitFill: number | null },
  nowMs: number,
  deps: GradeDeps,
  opts: { lane?: string | null; replyToMessageId?: string | null } = {},
): Promise<boolean> {
  try {
    const oc = loadCaseJsonOnDb(db as any, caseId);
    // The frozen entry is the case's; when the case carries no summary the mirror's own
    // entry fill is used rather than skipping the close entirely — a real exit that goes
    // unannounced because a summary row is missing is the outcome this session exists to
    // remove. The entry convention is labelled in the message, never guessed at.
    const summary = oc?.summary ?? {
      frozenEntry: pos.entry_fill,
      currentMark: exit.exitFill,
      currentReturnPct: exit.returnPct,
      currentStatus: "CLOSED",
      active: false,
    };
    const content = formatOpportunityClosedUpdate({
      symbol: occUnderlying(pos.option_symbol) || "UNK",
      optionType: pos.side === "put" ? "PUT" : "CALL",
      strike: pos.strike,
      optionSymbol: pos.option_symbol,
      expiration: pos.expiration,
      lane: opts.lane ?? null,
      summary: {
        ...(summary as any),
        currentMark: exit.exitFill ?? (summary as any).currentMark,
        currentReturnPct: exit.returnPct ?? (summary as any).currentReturnPct,
        currentStatus: "CLOSED",
        active: false,
      },
      exitReason: exit.reason,
      opportunityCaseId: caseId,
    });
    const replyToMessageId = opts.replyToMessageId !== undefined
      ? opts.replyToMessageId
      : resolveOpeningDiscordMessageId(db, caseId, pos.alert_id);
    const sent = await sendLifecycleDiscordUpdate(deps, content, replyToMessageId);
    return sent.ok;
  } catch {
    return false;
  }
}

/** Grade all OPEN real-option paper positions once. Isolated per-row: a single failing quote never
 *  aborts the pass. Idempotent — only status='ENTERED' rows are examined, and an EXIT flips the status. */
export async function gradeOpenOptionPositionsOnDb(db: GradeDb, deps: GradeDeps, env: NodeJS.ProcessEnv = process.env, cfg: GradeConfig = defaultGradeConfig(env)): Promise<GradePassResult> {
  // Marking open subscriber positions is the second-highest provider priority after
  // scanner safety. The scope attributes every quote this pass fetches, however deep.
  return withProviderConsumer("options_paper_mark", () => gradeOpenOptionPositionsInner(db, deps, env, cfg));
}

async function gradeOpenOptionPositionsInner(db: GradeDb, deps: GradeDeps, env: NodeJS.ProcessEnv, cfg: GradeConfig): Promise<GradePassResult> {
  const now = deps.now ?? Date.now;
  const has = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_paper_trades'").get());
  if (!has) return { examined: 0, graded: 0, held: 0, errors: 0, byReason: {}, milestonesDelivered: 0, closesDelivered: 0 };
  let rows: OpenPosition[];
  try {
    rows = db.prepare("SELECT id, option_symbol, side, strike, expiration, dte, entry_fill, result_class, strategy, underlying_price, target, invalidation, entered_at_ms, status, paper_kind, alert_id FROM options_paper_trades WHERE status='ENTERED' AND result_class='REAL_OPTION_PAPER'").all() as OpenPosition[];
  } catch {
    rows = db.prepare("SELECT id, option_symbol, side, strike, expiration, dte, entry_fill, result_class, strategy, underlying_price, target, invalidation, entered_at_ms, status FROM options_paper_trades WHERE status='ENTERED' AND result_class='REAL_OPTION_PAPER'").all() as OpenPosition[];
  }
  const out: GradePassResult = { examined: rows.length, graded: 0, held: 0, errors: 0, byReason: {}, milestonesDelivered: 0, closesDelivered: 0 };
  const nowMsStart = now();
  const scanGuard = assertSubscriberScanAllowed(nowMsStart, env);
  for (const pos of rows) {
    const nowMs = now();
    let quote: RefreshedQuote | null = null;
    let validSessionQuote = false;
    let validSessionEventAtMs: number | null = null;
    try { quote = await deps.getQuote(pos.option_symbol, occUnderlying(pos.option_symbol)); }
    catch { out.errors += 1; quote = null; } // provider hiccup on one contract must not stop the pass
    if (quote) {
      const markValidation = validateLifecycleQuote({
        bid: quote.bid,
        ask: quote.ask,
        providerTimestamp: quote.providerTimestamp,
        observedAtMs: nowMs,
        maxQuoteAgeMs: cfg.maxQuoteAgeMs,
        env,
      });
      validSessionQuote = markValidation.valid;
      validSessionEventAtMs = markValidation.valid ? markValidation.eventAtMs : null;
      if (scanGuard.ok && markValidation.valid && markValidation.eventAtMs != null) {
        recordObservedMark(db, pos, quote, markValidation.eventAtMs, nowMs);
      }
    }
    try {
      out.milestonesDelivered = (out.milestonesDelivered ?? 0) + await maybeUpdateOpportunityLifecycle(db, pos, quote, nowMs, cfg, deps, env);
    } catch { /* lifecycle never blocks grading */ }
    const d = decideOptionExit(pos, validSessionQuote ? quote : null, nowMs, cfg);
    if (d.action !== "exit") { out.held += 1; continue; }
    try {
      db.prepare(
        "UPDATE options_paper_trades SET status='EXITED', exit_fill=?, pnl=?, return_pct=?, exit_reason=?, exit_at_ms=?, updated_at_ms=? WHERE id=? AND status='ENTERED'",
      ).run(d.exitFill, d.pnl, d.returnPct, d.reason, validSessionEventAtMs ?? nowMs, nowMs, pos.id);
      out.graded += 1; out.byReason[d.reason as string] = (out.byReason[d.reason as string] ?? 0) + 1;
      try {
        dualWriteAfterOptionsPaperExit(db as BrokerDb, pos.id);
      } catch { /* best-effort */ }
      if (
        validSessionQuote
        && validSessionEventAtMs != null
        && env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0"
        && (!pos.paper_kind || pos.paper_kind === "DELIVERED_ALERT_PAPER")
        && pos.alert_id
      ) {
        try {
          const caseId = findOpportunityCaseIdByAlertOnDb(db as any, pos.alert_id);
          if (caseId) {
            closeOpportunityOnDb(db as any, {
              opportunityCaseId: caseId,
              nowMs: validSessionEventAtMs,
              exitReason: d.reason,
              returnPct: d.returnPct,
              currentMark: d.exitFill,
              exitOptionSymbol: pos.option_symbol,
            });
            try {
              if (await maybeDeliverOpportunityClosedDiscord(db, pos, caseId, {
                reason: d.reason,
                returnPct: d.returnPct,
                exitFill: d.exitFill,
              }, validSessionEventAtMs, deps)) {
                out.closesDelivered = (out.closesDelivered ?? 0) + 1;
              }
            } catch { /* Discord close never blocks grading */ }
          }
        } catch { /* isolated */ }
      }
      // OWNER lane close. Deliberately separate from the block above rather than folded
      // into it:
      //   - it resolves its case through the mirror's feature snapshot, not `alert_id`,
      //     which is null for every owner mirror in existence;
      //   - it is authorised by the DISCORD DELIVERY LEDGER, not by the opportunity case;
      //   - it does NOT call `closeOpportunityOnDb`. That function releases the thesis
      //     claim and writes a reopen cooldown, which would change WHEN the next owner
      //     callout for the same thesis may fire. That is delivery-cadence behaviour and
      //     is out of scope for this session; the divergence is recorded as a known
      //     limitation rather than silently repaired here.
      if (pos.paper_kind === OWNER_VALIDATION_PAPER_KIND) {
        // The same event-time discipline the subscriber close obeys: no verified event
        // instant, no lifecycle message. An expiration or time-stop can close a position
        // without a fresh quote, and those exits are recorded as skips rather than
        // silently producing nothing — an unannounced close and a broken resolver are
        // indistinguishable from a zero.
        const skip = (reason: string) => {
          out.ownerCloseSkips = out.ownerCloseSkips ?? {};
          out.ownerCloseSkips[reason] = (out.ownerCloseSkips[reason] ?? 0) + 1;
        };
        if (!validSessionQuote || validSessionEventAtMs == null) {
          skip("event_time_unverified");
        } else {
          const identity = resolveOwnerLifecycleIdentity(db, pos, env);
          if (!identity.eligible || !identity.opportunityCaseId) {
            skip(identity.reason);
          } else {
            try {
              const delivered = await maybeDeliverOpportunityClosedDiscord(db, pos, identity.opportunityCaseId, {
                reason: d.reason,
                returnPct: d.returnPct,
                exitFill: d.exitFill,
              }, validSessionEventAtMs, deps, {
                lane: "OWNER_ONLY",
                replyToMessageId: identity.openingMessageId,
              });
              if (delivered) out.ownerClosesDelivered = (out.ownerClosesDelivered ?? 0) + 1;
              else skip("discord_send_failed");
            } catch {
              skip("discord_send_threw");
            }
          }
        }
      }
    } catch { out.errors += 1; }
  }
  return out;
}

/** Read-only grading backlog for observability (open positions + last grade cycle). */
export function readGradingBacklogOnDb(db: GradeDb): { openPositions: number; gradedTotal: number; lastGradeCycleMs: number | null } {
  const has = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_paper_trades'").get());
  if (!has) return { openPositions: 0, gradedTotal: 0, lastGradeCycleMs: null };
  const n = (sql: string) => Number((db.prepare(sql).get() as any)?.n ?? 0);
  return {
    openPositions: n("SELECT COUNT(*) n FROM options_paper_trades WHERE status='ENTERED' AND result_class='REAL_OPTION_PAPER'"),
    gradedTotal: n("SELECT COUNT(*) n FROM options_paper_trades WHERE status='EXITED' AND result_class='REAL_OPTION_PAPER'"),
    lastGradeCycleMs: (db.prepare("SELECT MAX(exit_at_ms) m FROM options_paper_trades WHERE status='EXITED'").get() as any)?.m ?? null,
  };
}

// ── in-process grader loop (singleton, gated, restart-safe) ─────────────────────────────────────
interface GraderState { running: boolean; timer: any; lastCycleMs: number | null; lastResult: GradePassResult | null; cycles: number; errors: number }
type G = typeof globalThis & { __optiscanOptionsGrader?: GraderState };
function gstate(): GraderState { const g = globalThis as G; return (g.__optiscanOptionsGrader ??= { running: false, timer: null, lastCycleMs: null, lastResult: null, cycles: 0, errors: 0 }); }

export function graderIntervalMs(env: NodeJS.ProcessEnv = process.env): number { const x = Number(env.OPTIONS_GRADE_INTERVAL_MS); return Number.isFinite(x) && x >= 5000 ? x : 30_000; }

export interface LiveGradeDeps extends GradeDeps { getDb: () => any; onCycle?: (r: GradePassResult, nowMs: number) => void }
/** Start the grader (singleton). HARD no-op unless both flags on. Errors are swallowed so a provider or
 *  DB failure never stops autonomous grading; the next tick simply retries. */
export function startOptionsGrader(deps: LiveGradeDeps, env: NodeJS.ProcessEnv = process.env): { started: boolean; reason: string } {
  const s = gstate();
  if (s.running) return { started: true, reason: "already running" };
  const f = researchFlags(env);
  if (!f.independentOptionsDiscovery || !f.realOptionPaper) return { started: false, reason: "grading disabled (needs INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1 and REAL_OPTION_PAPER_ENABLED=1)" };
  s.running = true;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const r = await gradeOpenOptionPositionsOnDb(deps.getDb(), deps, env);
      s.lastResult = r; s.lastCycleMs = (deps.now ?? Date.now)(); s.cycles += 1;
      deps.onCycle?.(r, s.lastCycleMs);
    } catch { s.errors += 1; /* never stop the loop */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, graderIntervalMs(env));
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  s.timer = timer;
  const stop = () => stopOptionsGrader();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { started: true, reason: "started" };
}
export function stopOptionsGrader(): void { const s = gstate(); if (s.timer) clearInterval(s.timer); s.timer = null; s.running = false; }
export function optionsGraderState(): { running: boolean; lastCycleMs: number | null; cycles: number; errors: number; lastResult: GradePassResult | null } {
  const s = gstate(); return { running: s.running, lastCycleMs: s.lastCycleMs, cycles: s.cycles, errors: s.errors, lastResult: s.lastResult };
}
export function __resetOptionsGraderForTest(): void { stopOptionsGrader(); delete (globalThis as G).__optiscanOptionsGrader; }
