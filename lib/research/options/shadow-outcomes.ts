/**
 * options/shadow-outcomes.ts — forward outcome grading for shadow soak candidates.
 * Isolated from DELIVERED_ALERT_PAPER, opportunity cases, claims, and social drafts.
 */
import { assertSubscriberScanAllowed } from "../../market-session-guard.ts";
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

const HORIZONS_MS = [
  ["return_1m", 60_000],
  ["return_5m", 5 * 60_000],
  ["return_15m", 15 * 60_000],
  ["return_30m", 30 * 60_000],
  ["return_60m", 60 * 60_000],
] as const;

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
  entry_quality_verdict: string | null;
  entry_quality_dimensions_json: string | null;
  session_guard_state: string | null;
  decision_at_ms: number;
  return_1m: number | null;
  return_5m: number | null;
  return_15m: number | null;
  return_30m: number | null;
  return_60m: number | null;
  mfe_pct: number | null;
  mae_pct: number | null;
  t1_hit: number | null;
  t2_hit: number | null;
  stop_hit: number | null;
  underlying_direction_correct: number | null;
  data_status: ShadowDataStatus;
  marks_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ShadowOutcomeDeps {
  getDb?: () => OutcomeDb;
  fetchOptionQuote?: (optionSymbol: string) => Promise<{ bid: number | null; ask: number | null; quoteAgeMs: number | null } | null>;
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
  const optMid = d.entry?.mid ?? ((d.contract.bid ?? 0) + (d.contract.ask ?? 0)) / 2;
  try {
    const existing = db.prepare(
      "SELECT id FROM options_shadow_outcomes WHERE shadow_decision_id=? LIMIT 1",
    ).get(shadowDecisionId) as { id: number } | undefined;
    if (existing?.id) return;
    db.prepare(
      `INSERT INTO options_shadow_outcomes (
        shadow_decision_id, candidate_symbol, strategy, side, trading_session_date, path, would_send,
        option_symbol, frozen_entry, frozen_t1, frozen_t2, frozen_stop, underlying_at_decision,
        option_at_decision, entry_quality_verdict, entry_quality_dimensions_json, session_guard_state,
        decision_at_ms, data_status, created_at_ms, updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      result.entryQuality?.composite.primaryVerdict ?? null,
      result.entryQuality ? JSON.stringify(result.entryQuality.dimensions) : null,
      result.sessionState,
      nowMs,
      "PENDING",
      nowMs,
      nowMs,
    );
  } catch { /* isolated */ }
}

export async function gradeShadowOutcomesOnDb(
  db: OutcomeDb,
  deps: ShadowOutcomeDeps = {},
  env: NodeJS.ProcessEnv = process.env,
  nowMs = deps.now?.() ?? Date.now(),
): Promise<{ updated: number; pending: number }> {
  if (!hasTable(db, "options_shadow_outcomes")) return { updated: 0, pending: 0 };
  const scanGuard = assertSubscriberScanAllowed(nowMs, env);
  const scanMode = String(env.MARKET_SESSION_GUARD ?? "shadow").toLowerCase();
  const canRefreshQuotes = scanGuard.ok || scanMode === "shadow" || scanMode === "0";

  let updated = 0;
  let pending = 0;
  const rows = db.prepare(
    "SELECT * FROM options_shadow_outcomes WHERE data_status IN ('PENDING','OK') ORDER BY decision_at_ms ASC LIMIT 50",
  ).all() as ShadowOutcomeRow[];

  for (const row of rows) {
    const ageMs = nowMs - row.decision_at_ms;
    const maxHorizon = 60 * 60_000;
    if (ageMs < 60_000) {
      pending += 1;
      continue;
    }

    let quote: { bid: number | null; ask: number | null; quoteAgeMs: number | null } | null = null;
    let underlyingNow: number | null = null;

    if (canRefreshQuotes && deps.fetchOptionQuote && row.option_symbol) {
      try { quote = await deps.fetchOptionQuote(row.option_symbol); } catch { quote = null; }
    }
    if (canRefreshQuotes && deps.fetchUnderlying) {
      try { underlyingNow = await deps.fetchUnderlying(row.candidate_symbol); } catch { underlyingNow = null; }
    }

    const entry = row.frozen_entry;
    const mark = quote && quote.bid != null && quote.ask != null ? (quote.bid + quote.ask) / 2 : null;
    const returnNow = entry != null && mark != null ? optionReturnPct(entry, mark) : null;

    const marks: Record<string, number | null> = row.marks_json ? JSON.parse(row.marks_json) : {};
    if (returnNow != null) marks[`r_${Math.floor(ageMs / 60_000)}m`] = returnNow;

    const updates: Record<string, number | null> = {};
    for (const [col, horizonMs] of HORIZONS_MS) {
      if (ageMs >= horizonMs && row[col as keyof ShadowOutcomeRow] == null && returnNow != null) {
        updates[col] = returnNow;
      }
    }

    let mfe = row.mfe_pct;
    let mae = row.mae_pct;
    if (returnNow != null) {
      mfe = mfe == null ? returnNow : Math.max(mfe, returnNow);
      mae = mae == null ? returnNow : Math.min(mae, returnNow);
    }

    let dataStatus: ShadowDataStatus = row.data_status;
    if (!canRefreshQuotes && ageMs > maxHorizon) dataStatus = "SESSION_CLOSED";
    else if (ageMs > maxHorizon && returnNow == null) dataStatus = "MISSING";
    else if (quote?.quoteAgeMs != null && quote.quoteAgeMs > 900_000) dataStatus = "STALE";
    else if (Object.keys(updates).length > 0 || returnNow != null) dataStatus = ageMs >= maxHorizon ? "OK" : "PENDING";
    else if (ageMs >= maxHorizon) dataStatus = "MISSING";

    const t1Hit = row.frozen_t1 != null && mark != null && mark >= row.frozen_t1 ? 1 : row.t1_hit;
    const t2Hit = row.frozen_t2 != null && mark != null && mark >= row.frozen_t2 ? 1 : row.t2_hit;
    const stopHit = row.frozen_stop != null && mark != null && mark <= row.frozen_stop ? 1 : row.stop_hit;
    const dirCorrect = underlyingNow != null && row.underlying_at_decision != null
      ? ((row.side === "put"
        ? underlyingNow < row.underlying_at_decision
        : underlyingNow > row.underlying_at_decision) ? 1 : 0)
      : row.underlying_direction_correct;

    try {
      db.prepare(
        `UPDATE options_shadow_outcomes SET
          return_1m=COALESCE(?, return_1m),
          return_5m=COALESCE(?, return_5m),
          return_15m=COALESCE(?, return_15m),
          return_30m=COALESCE(?, return_30m),
          return_60m=COALESCE(?, return_60m),
          mfe_pct=?, mae_pct=?, t1_hit=?, t2_hit=?, stop_hit=?, underlying_direction_correct=?,
          data_status=?, marks_json=?, updated_at_ms=?
         WHERE id=?`,
      ).run(
        updates.return_1m ?? null,
        updates.return_5m ?? null,
        updates.return_15m ?? null,
        updates.return_30m ?? null,
        updates.return_60m ?? null,
        mfe,
        mae,
        t1Hit,
        t2Hit,
        stopHit,
        dirCorrect,
        dataStatus,
        JSON.stringify(marks),
        nowMs,
        row.id,
      );
      updated += 1;
      if (dataStatus === "PENDING") pending += 1;
    } catch { /* isolated */ }
  }

  return { updated, pending };
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
      const missing = outcomes.filter((o) => o.data_status === "MISSING" || o.data_status === "STALE").length;
      out.missingDataPct = outcomes.length ? +(missing / outcomes.length * 100).toFixed(1) : 0;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readInstrumentationFallbackInserts } = require("../../db-legacy-columns.ts") as typeof import("../../db-legacy-columns.ts");
      out.instrumentationFallbackInserts = readInstrumentationFallbackInserts();
    } catch { /* optional */ }
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
