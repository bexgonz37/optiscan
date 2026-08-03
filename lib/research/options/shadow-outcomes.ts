/**
 * options/shadow-outcomes.ts — forward outcome grading for shadow soak candidates.
 * Isolated from DELIVERED_ALERT_PAPER, opportunity cases, claims, and social drafts.
 */
import { assertSubscriberScanAllowed } from "../../market-session-guard.ts";
import { withProviderConsumer } from "../../provider-context.ts";
import { tradingDay } from "../../trading-session.ts";
import type { ShadowDecisionInput, ShadowDecisionResult } from "./shadow-runner.ts";

type OutcomeDb = {
  prepare: (sql: string) => {
    run: (...a: unknown[]) => unknown;
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
};

export type ShadowDataStatus = "PENDING" | "OK" | "MISSING" | "STALE" | "SESSION_CLOSED";

const HORIZONS = [
  { returnCol: "return_1m", optionCol: "option_return_1m", underlyingCol: "underlying_return_1m", ms: 60_000 },
  { returnCol: "return_5m", optionCol: "option_return_5m", underlyingCol: "underlying_return_5m", ms: 5 * 60_000 },
  { returnCol: "return_15m", optionCol: "option_return_15m", underlyingCol: "underlying_return_15m", ms: 15 * 60_000 },
  { returnCol: "return_30m", optionCol: "option_return_30m", underlyingCol: "underlying_return_30m", ms: 30 * 60_000 },
  { returnCol: "return_60m", optionCol: "option_return_60m", underlyingCol: "underlying_return_60m", ms: 60 * 60_000 },
] as const;

const MAX_HORIZON_MS = 60 * 60_000;
const GRADEABLE_PATHS = new Set(["proposed", "independent"]);

export interface ShadowOutcomeRow {
  id: number;
  shadow_decision_id: number | null;
  candidate_symbol: string;
  strategy: string | null;
  side: string | null;
  trading_session_date: string;
  path: string;
  would_send: number;
  option_symbol: string | null;
  frozen_entry: number | null;
  frozen_t1: number | null;
  frozen_t2: number | null;
  frozen_stop: number | null;
  underlying_at_decision: number | null;
  option_at_decision: number | null;
  bid_at_decision: number | null;
  ask_at_decision: number | null;
  spread_pct_at_decision: number | null;
  dte_at_decision: number | null;
  strike_at_decision: number | null;
  expiration_at_decision: string | null;
  quality_score: number | null;
  block_reasons_json: string | null;
  entry_quality_verdict: string | null;
  entry_quality_dimensions_json: string | null;
  session_guard_state: string | null;
  decision_at_ms: number;
  return_1m: number | null;
  return_5m: number | null;
  return_15m: number | null;
  return_30m: number | null;
  return_60m: number | null;
  underlying_return_1m: number | null;
  underlying_return_5m: number | null;
  underlying_return_15m: number | null;
  underlying_return_30m: number | null;
  underlying_return_60m: number | null;
  option_return_1m: number | null;
  option_return_5m: number | null;
  option_return_15m: number | null;
  option_return_30m: number | null;
  option_return_60m: number | null;
  mfe_pct: number | null;
  mae_pct: number | null;
  mfe_at_ms: number | null;
  mae_at_ms: number | null;
  t1_hit: number | null;
  t2_hit: number | null;
  stop_hit: number | null;
  underlying_direction_correct: number | null;
  missing_data_reason: string | null;
  final_result: string | null;
  data_status: ShadowDataStatus;
  marks_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ShadowOutcomeDeps {
  getDb?: () => OutcomeDb;
  fetchOptionQuote?: (
    optionSymbol: string,
    underlyingSymbol: string,
  ) => Promise<{ bid: number | null; ask: number | null; quoteAgeMs: number | null } | null>;
  fetchUnderlying?: (symbol: string) => Promise<number | null>;
  now?: () => number;
}

function hasTable(db: OutcomeDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function optionReturnPct(entry: number, mark: number): number | null {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(mark)) return null;
  return +(((mark / entry) - 1) * 100).toFixed(4);
}

function underlyingReturnPct(entry: number, now: number): number | null {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(now)) return null;
  return +(((now - entry) / entry) * 100).toFixed(4);
}

function gradeMaxQuoteAgeMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.SHADOW_GRADE_MAX_QUOTE_AGE_MS ?? env.OPTIONS_GRADE_MAX_QUOTE_AGE_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 900_000;
}

function gradeRowCap(env: NodeJS.ProcessEnv): number {
  const n = Number(env.SHADOW_OUTCOME_GRADE_MAX_ROWS);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : 25;
}

function qualityScoreFromResult(result: ShadowDecisionResult): number | null {
  const d = result.entryQuality?.dimensions;
  if (!d) return null;
  const vals = Object.values(d).map((x) => x?.score).filter((x): x is number => Number.isFinite(x));
  return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
}

export function upsertShadowOutcomeFromDecision(
  db: OutcomeDb,
  shadowDecisionId: number,
  input: ShadowDecisionInput,
  result: ShadowDecisionResult,
  _env: NodeJS.ProcessEnv = process.env,
): void {
  if (!hasTable(db, "options_shadow_outcomes")) return;
  const d = input.deliveryInput;
  if (!d) return;
  const nowMs = input.nowMs ?? Date.now();
  const bid = d.contract.bid ?? null;
  const ask = d.contract.ask ?? null;
  const optMid = d.entry?.mid ?? ((bid ?? 0) + (ask ?? 0)) / 2;
  try {
    const existing = db.prepare(
      "SELECT id FROM options_shadow_outcomes WHERE shadow_decision_id=? LIMIT 1",
    ).get(shadowDecisionId) as { id: number } | undefined;
    if (existing?.id) return;
    db.prepare(
      `INSERT INTO options_shadow_outcomes (
        shadow_decision_id, candidate_symbol, strategy, side, trading_session_date, path, would_send,
        option_symbol, frozen_entry, frozen_t1, frozen_t2, frozen_stop, underlying_at_decision,
        option_at_decision, bid_at_decision, ask_at_decision, spread_pct_at_decision, dte_at_decision,
        strike_at_decision, expiration_at_decision, quality_score, block_reasons_json,
        entry_quality_verdict, entry_quality_dimensions_json, session_guard_state,
        decision_at_ms, data_status, created_at_ms, updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      shadowDecisionId,
      input.symbol,
      input.strategy,
      input.side,
      tradingDay(nowMs),
      input.path,
      result.wouldSend ? 1 : 0,
      d.contract.optionSymbol,
      optMid,
      d.entry?.t1 ?? null,
      d.entry?.t2 ?? null,
      d.entry?.stop ?? null,
      d.currentUnderlyingPrice,
      optMid,
      bid,
      ask,
      d.contract.spreadPct ?? null,
      d.contract.dte ?? null,
      d.contract.strike ?? null,
      d.contract.expiration ?? null,
      qualityScoreFromResult(result),
      JSON.stringify(result.blockReasons ?? []),
      result.entryQuality?.composite.primaryVerdict ?? result.entryQuality?.verdict ?? null,
      result.entryQuality ? JSON.stringify(result.entryQuality.dimensions) : null,
      result.sessionState,
      nowMs,
      "PENDING",
      nowMs,
      nowMs,
    );
  } catch { /* isolated */ }
}

/** Shadow grader must never write live subscriber artifacts. Exported for tests. */
export function assertShadowGraderIsolation(db: OutcomeDb): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const forbiddenWrites = [
    "options_alerts",
    "options_paper_trades",
    "opportunity_cases",
    "opportunity_milestones",
    "subscriber_claims",
    "social_drafts",
  ];
  for (const table of forbiddenWrites) {
    if (hasTable(db, table)) violations.push(`forbidden_table_present:${table}`);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Forward-mark shadow outcomes. Research lane — isolated from delivered-alert paper.
 *
 * Attributed to `options_shadow_mark` (Gate B5) because it shares `buildLiveGradeDeps().getQuote`
 * with the subscriber grader and would otherwise be billed as, or hidden inside, subscriber
 * marking. It is deliberately a `research` category so Gate B7 can starve it before any live lane.
 */
export async function gradeShadowOutcomesOnDb(
  db: OutcomeDb,
  deps: ShadowOutcomeDeps = {},
  env: NodeJS.ProcessEnv = process.env,
  nowMs = deps.now?.() ?? Date.now(),
): Promise<{ updated: number; pending: number; skipped: number }> {
  return withProviderConsumer("options_shadow_mark", () => gradeShadowOutcomesInner(db, deps, env, nowMs));
}

async function gradeShadowOutcomesInner(
  db: OutcomeDb,
  deps: ShadowOutcomeDeps,
  env: NodeJS.ProcessEnv,
  nowMs: number,
): Promise<{ updated: number; pending: number; skipped: number }> {
  if (!hasTable(db, "options_shadow_outcomes")) return { updated: 0, pending: 0, skipped: 0 };
  const scanGuard = assertSubscriberScanAllowed(nowMs, env);
  const scanMode = String(env.MARKET_SESSION_GUARD ?? "shadow").toLowerCase();
  const canRefreshQuotes = scanGuard.ok || scanMode === "shadow" || scanMode === "0";
  const maxQuoteAgeMs = gradeMaxQuoteAgeMs(env);
  const rowCap = gradeRowCap(env);

  let updated = 0;
  let pending = 0;
  let skipped = 0;
  const rows = db.prepare(
    `SELECT * FROM options_shadow_outcomes
     WHERE data_status IN ('PENDING','OK')
       AND path IN ('proposed','independent')
       AND option_symbol IS NOT NULL
     ORDER BY decision_at_ms ASC
     LIMIT ?`,
  ).all(rowCap) as ShadowOutcomeRow[];

  for (const row of rows) {
    if (!GRADEABLE_PATHS.has(row.path) || !row.option_symbol) {
      skipped += 1;
      continue;
    }

    const ageMs = nowMs - row.decision_at_ms;
    if (ageMs < 60_000) {
      pending += 1;
      continue;
    }

    let quote: { bid: number | null; ask: number | null; quoteAgeMs: number | null } | null = null;
    let underlyingNow: number | null = null;

    if (canRefreshQuotes && deps.fetchOptionQuote && row.option_symbol) {
      try {
        quote = await deps.fetchOptionQuote(row.option_symbol, row.candidate_symbol);
      } catch {
        quote = null;
      }
    }
    if (canRefreshQuotes && deps.fetchUnderlying) {
      try {
        underlyingNow = await deps.fetchUnderlying(row.candidate_symbol);
      } catch {
        underlyingNow = null;
      }
    }

    const entry = row.frozen_entry;
    const freshQuote = quote != null
      && quote.bid != null && quote.bid > 0
      && quote.ask != null && quote.ask > 0
      && (quote.quoteAgeMs == null || quote.quoteAgeMs <= maxQuoteAgeMs);
    const mark = freshQuote ? (quote!.bid! + quote!.ask!) / 2 : null;
    const optionReturnNow = entry != null && mark != null ? optionReturnPct(entry, mark) : null;
    const underlyingReturnNow = row.underlying_at_decision != null && underlyingNow != null
      ? underlyingReturnPct(row.underlying_at_decision, underlyingNow)
      : null;

    const updates: Record<string, number | null> = {};
    for (const h of HORIZONS) {
      const existing = row[h.returnCol as keyof ShadowOutcomeRow];
      if (ageMs >= h.ms && existing == null && optionReturnNow != null) {
        updates[h.returnCol] = optionReturnNow;
        updates[h.optionCol] = optionReturnNow;
        if (underlyingReturnNow != null) updates[h.underlyingCol] = underlyingReturnNow;
      }
    }

    let mfe = row.mfe_pct;
    let mae = row.mae_pct;
    let mfeAtMs = row.mfe_at_ms;
    let maeAtMs = row.mae_at_ms;
    if (optionReturnNow != null) {
      if (mfe == null || optionReturnNow > mfe) {
        mfe = optionReturnNow;
        mfeAtMs = nowMs;
      }
      if (mae == null || optionReturnNow < mae) {
        mae = optionReturnNow;
        maeAtMs = nowMs;
      }
    }

    let dataStatus: ShadowDataStatus = row.data_status;
    let missingDataReason = row.missing_data_reason;
    let finalResult = row.final_result;

    if (!canRefreshQuotes) {
      if (ageMs >= MAX_HORIZON_MS) {
        dataStatus = "SESSION_CLOSED";
        missingDataReason = "SESSION_CLOSED";
        finalResult = finalResult ?? "INCOMPLETE";
      }
    } else if (!freshQuote) {
      if (ageMs >= MAX_HORIZON_MS && row.return_60m == null) {
        dataStatus = "MISSING";
        missingDataReason = "QUOTE_UNAVAILABLE";
        finalResult = finalResult ?? "INCOMPLETE";
      }
    } else if (quote?.quoteAgeMs != null && quote.quoteAgeMs > maxQuoteAgeMs) {
      dataStatus = "STALE";
      missingDataReason = "STALE_QUOTE";
    } else if (Object.keys(updates).length > 0 || optionReturnNow != null) {
      dataStatus = ageMs >= MAX_HORIZON_MS && row.return_60m != null ? "OK" : "PENDING";
      if (ageMs >= MAX_HORIZON_MS) {
        finalResult = row.return_60m != null || updates.return_60m != null ? "COMPLETE" : "INCOMPLETE";
        if (row.return_60m != null || updates.return_60m != null) dataStatus = "OK";
      }
    } else if (ageMs >= MAX_HORIZON_MS) {
      dataStatus = row.return_60m != null ? "OK" : "MISSING";
      missingDataReason = row.return_60m != null ? missingDataReason : (missingDataReason ?? "QUOTE_UNAVAILABLE");
      finalResult = row.return_60m != null ? "COMPLETE" : "INCOMPLETE";
    }

    const t1Hit = row.frozen_t1 != null && mark != null && mark >= row.frozen_t1 ? 1 : row.t1_hit;
    const t2Hit = row.frozen_t2 != null && mark != null && mark >= row.frozen_t2 ? 1 : row.t2_hit;
    const stopHit = row.frozen_stop != null && mark != null && mark <= row.frozen_stop ? 1 : row.stop_hit;
    const dirCorrect = underlyingNow != null && row.underlying_at_decision != null
      ? ((row.side === "put"
        ? underlyingNow < row.underlying_at_decision
        : underlyingNow > row.underlying_at_decision) ? 1 : 0)
      : row.underlying_direction_correct;

    const marks: Record<string, unknown> = row.marks_json ? JSON.parse(row.marks_json) : {};
    if (optionReturnNow != null) marks[`r_${Math.floor(ageMs / 60_000)}m`] = optionReturnNow;

    try {
      db.prepare(
        `UPDATE options_shadow_outcomes SET
          return_1m=COALESCE(?, return_1m),
          return_5m=COALESCE(?, return_5m),
          return_15m=COALESCE(?, return_15m),
          return_30m=COALESCE(?, return_30m),
          return_60m=COALESCE(?, return_60m),
          option_return_1m=COALESCE(?, option_return_1m),
          option_return_5m=COALESCE(?, option_return_5m),
          option_return_15m=COALESCE(?, option_return_15m),
          option_return_30m=COALESCE(?, option_return_30m),
          option_return_60m=COALESCE(?, option_return_60m),
          underlying_return_1m=COALESCE(?, underlying_return_1m),
          underlying_return_5m=COALESCE(?, underlying_return_5m),
          underlying_return_15m=COALESCE(?, underlying_return_15m),
          underlying_return_30m=COALESCE(?, underlying_return_30m),
          underlying_return_60m=COALESCE(?, underlying_return_60m),
          mfe_pct=?, mae_pct=?, mfe_at_ms=?, mae_at_ms=?,
          t1_hit=?, t2_hit=?, stop_hit=?, underlying_direction_correct=?,
          missing_data_reason=?, final_result=?, data_status=?, marks_json=?, updated_at_ms=?
         WHERE id=?`,
      ).run(
        updates.return_1m ?? null,
        updates.return_5m ?? null,
        updates.return_15m ?? null,
        updates.return_30m ?? null,
        updates.return_60m ?? null,
        updates.option_return_1m ?? null,
        updates.option_return_5m ?? null,
        updates.option_return_15m ?? null,
        updates.option_return_30m ?? null,
        updates.option_return_60m ?? null,
        updates.underlying_return_1m ?? null,
        updates.underlying_return_5m ?? null,
        updates.underlying_return_15m ?? null,
        updates.underlying_return_30m ?? null,
        updates.underlying_return_60m ?? null,
        mfe,
        mae,
        mfeAtMs,
        maeAtMs,
        t1Hit,
        t2Hit,
        stopHit,
        dirCorrect,
        missingDataReason,
        finalResult,
        dataStatus,
        JSON.stringify(marks),
        nowMs,
        row.id,
      );
      updated += 1;
      if (dataStatus === "PENDING") pending += 1;
    } catch { /* isolated */ }
  }

  return { updated, pending, skipped };
}

let graderTimer: ReturnType<typeof setInterval> | null = null;

export function startShadowOutcomeGrader(deps: ShadowOutcomeDeps = {}, env: NodeJS.ProcessEnv = process.env): { started: boolean } {
  if (graderTimer) return { started: true };
  if (env.SUBSCRIBER_SHADOW_MODE !== "1" && env.ENTRY_QUALITY_GATE !== "shadow" && env.MARKET_SESSION_GUARD !== "shadow") {
    return { started: false };
  }
  const intervalMs = Math.max(30_000, Number(env.SHADOW_OUTCOME_GRADE_INTERVAL_MS) || 120_000);
  const tick = () => {
    try {
      const db = deps.getDb?.();
      if (!db) return;
      void gradeShadowOutcomesOnDb(db, deps, env);
    } catch { /* isolated */ }
  };
  graderTimer = setInterval(tick, intervalMs);
  if (typeof graderTimer.unref === "function") graderTimer.unref();
  tick();
  return { started: true };
}

export interface ShadowSoakAggregate {
  tradingDays: number;
  totalDecisions: number;
  observedOnly: number;
  wouldSend: number;
  wouldBlock: number;
  actuallyDelivered: number;
  allowedWinRate60m: number | null;
  blockedWinRate60m: number | null;
  allowedExpectancy60m: number | null;
  blockedExpectancy60m: number | null;
  severeLossesPrevented: number;
  largeWinnersBlocked: number;
  missingDataPct: number;
  byVerdict: Record<string, number>;
  bySessionState: Record<string, number>;
  supervisorWouldSend: number;
  independentWouldSend: number;
  instrumentationFallbackInserts: number;
  liveDelivery?: LiveDeliveryMetrics;
}

export interface LiveDeliveryMetrics {
  alertsSent24h: number;
  alertsBlocked24h: number;
  blockReasons: Record<string, number>;
  avgDetectionToDiscordMs: number | null;
  supervisorSendAttempts24h: number;
  legacySendAttempts24h: number;
  batchingLateBlocks: number;
}

export function buildLiveDeliveryMetrics(db: OutcomeDb, nowMs = Date.now()): LiveDeliveryMetrics {
  const out: LiveDeliveryMetrics = {
    alertsSent24h: 0,
    alertsBlocked24h: 0,
    blockReasons: {},
    avgDetectionToDiscordMs: null,
    supervisorSendAttempts24h: 0,
    legacySendAttempts24h: 0,
    batchingLateBlocks: 0,
  };
  const since = nowMs - 24 * 60 * 60_000;
  try {
    if (hasTable(db, "options_alerts")) {
      out.alertsSent24h = Number((db.prepare("SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND sent_at_ms >= ?").get(since) as { n: number })?.n ?? 0);
      const blocked = db.prepare(
        "SELECT failure_reason r, COUNT(*) c FROM options_alerts WHERE state IN ('REJECTED','TOO_LATE') AND updated_at_ms >= ? GROUP BY failure_reason",
      ).all(since) as { r: string | null; c: number }[];
      for (const row of blocked) {
        const reason = row.r ?? "unknown";
        out.alertsBlocked24h += row.c;
        out.blockReasons[reason] = (out.blockReasons[reason] ?? 0) + row.c;
        if (/STALE_READY|LATE_ENTRY|CHASED|MOVE_ALREADY|batch wait/i.test(reason)) out.batchingLateBlocks += row.c;
      }
      const latencies = (db.prepare(
        `SELECT ai.delivery_latency_ms l FROM options_alert_instrumentation ai
         JOIN options_alerts oa ON oa.alert_id = ai.alert_id
         WHERE oa.state='SENT' AND oa.sent_at_ms >= ? AND ai.delivery_latency_ms IS NOT NULL`,
      ).all(since) as { l: number }[]).map((r) => r.l);
      if (latencies.length) out.avgDetectionToDiscordMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    }
    if (hasTable(db, "options_shadow_decisions")) {
      out.supervisorSendAttempts24h = Number((db.prepare(
        "SELECT COUNT(*) n FROM options_shadow_decisions WHERE path='supervisor' AND would_send=1 AND created_at_ms >= ?",
      ).get(since) as { n: number })?.n ?? 0);
    }
  } catch { /* isolated */ }
  return out;
}

export function buildShadowSoakAggregate(db: OutcomeDb, _env: NodeJS.ProcessEnv = process.env, days = 7): ShadowSoakAggregate {
  const out: ShadowSoakAggregate = {
    tradingDays: 0,
    totalDecisions: 0,
    observedOnly: 0,
    wouldSend: 0,
    wouldBlock: 0,
    actuallyDelivered: 0,
    allowedWinRate60m: null,
    blockedWinRate60m: null,
    allowedExpectancy60m: null,
    blockedExpectancy60m: null,
    severeLossesPrevented: 0,
    largeWinnersBlocked: 0,
    missingDataPct: 0,
    byVerdict: {},
    bySessionState: {},
    supervisorWouldSend: 0,
    independentWouldSend: 0,
    instrumentationFallbackInserts: 0,
  };
  try {
    if (!hasTable(db, "options_shadow_decisions")) return out;
    const sinceDay = db.prepare(
      "SELECT DISTINCT trading_session_date d FROM options_shadow_decisions ORDER BY d DESC LIMIT ?",
    ).all(days) as { d: string }[];
    out.tradingDays = sinceDay.length;
    if (sinceDay.length === 0) return out;

    const dayList = sinceDay.map((r) => r.d);
    const placeholders = dayList.map(() => "?").join(",");
    const decisions = db.prepare(
      `SELECT path, would_send, actually_delivered, actual_action, would_allow_session, entry_quality_verdict, session_guard_state
       FROM options_shadow_decisions WHERE trading_session_date IN (${placeholders})`,
    ).all(...dayList) as {
      path: string;
      would_send: number;
      actually_delivered: number | null;
      actual_action: string | null;
      would_allow_session: number | null;
      entry_quality_verdict: string | null;
      session_guard_state: string | null;
    }[];

    out.totalDecisions = decisions.length;
    for (const d of decisions) {
      if (d.would_send) out.wouldSend += 1;
      else out.wouldBlock += 1;
      if (d.actual_action === "OBSERVE_ONLY") out.observedOnly += 1;
      if (d.actually_delivered) out.actuallyDelivered += 1;
      if (d.path === "supervisor" && d.would_send) out.supervisorWouldSend += 1;
      if (d.path === "independent" && d.would_send) out.independentWouldSend += 1;
      const v = d.entry_quality_verdict ?? "unknown";
      out.byVerdict[v] = (out.byVerdict[v] ?? 0) + 1;
      const s = d.session_guard_state ?? "unknown";
      out.bySessionState[s] = (out.bySessionState[s] ?? 0) + 1;
    }

    if (hasTable(db, "options_shadow_outcomes")) {
      const outcomes = db.prepare(
        `SELECT would_send, return_60m, data_status FROM options_shadow_outcomes WHERE trading_session_date IN (${placeholders})`,
      ).all(...dayList) as { would_send: number; return_60m: number | null; data_status: string }[];

      const allowed = outcomes.filter((o) => o.would_send && o.return_60m != null);
      const blocked = outcomes.filter((o) => !o.would_send && o.return_60m != null);
      const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      const winRate = (xs: number[]) => xs.length ? xs.filter((x) => x > 0).length / xs.length : null;

      out.allowedExpectancy60m = avg(allowed.map((o) => o.return_60m!));
      out.blockedExpectancy60m = avg(blocked.map((o) => o.return_60m!));
      out.allowedWinRate60m = winRate(allowed.map((o) => o.return_60m!));
      out.blockedWinRate60m = winRate(blocked.map((o) => o.return_60m!));
      out.severeLossesPrevented = blocked.filter((o) => (o.return_60m ?? 0) <= -25).length;
      out.largeWinnersBlocked = blocked.filter((o) => (o.return_60m ?? 0) >= 20).length;
      const missing = outcomes.filter((o) => o.data_status === "MISSING" || o.data_status === "STALE" || o.data_status === "SESSION_CLOSED").length;
      out.missingDataPct = outcomes.length ? +(missing / outcomes.length * 100).toFixed(1) : 0;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readInstrumentationFallbackInserts } = require("../../db-legacy-columns.ts") as typeof import("../../db-legacy-columns.ts");
      out.instrumentationFallbackInserts = readInstrumentationFallbackInserts();
    } catch { /* optional */ }
    out.liveDelivery = buildLiveDeliveryMetrics(db);
  } catch { /* isolated */ }
  return out;
}

export function getShadowOutcomeDetail(db: OutcomeDb, id: number): Record<string, unknown> | null {
  try {
    if (!hasTable(db, "options_shadow_outcomes")) return null;
    const row = db.prepare("SELECT * FROM options_shadow_outcomes WHERE id=?").get(id) as ShadowOutcomeRow | undefined;
    if (!row) return null;
    let decision: Record<string, unknown> | null = null;
    if (row.shadow_decision_id && hasTable(db, "options_shadow_decisions")) {
      decision = db.prepare("SELECT * FROM options_shadow_decisions WHERE id=?").get(row.shadow_decision_id) as Record<string, unknown> | null;
    }
    return {
      outcome: row,
      decision,
      dimensions: row.entry_quality_dimensions_json ? JSON.parse(row.entry_quality_dimensions_json) : null,
      marks: row.marks_json ? JSON.parse(row.marks_json) : null,
    };
  } catch {
    return null;
  }
}
