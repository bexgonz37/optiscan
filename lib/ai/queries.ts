/**
 * ai/queries.ts — impure gatherers that read ONLY already-recorded rows for a
 * trading day and shape them into the PURE nightly-summary inputs. No provider
 * call, no fabrication: authoritative numbers come from paper_trade_outcomes +
 * paper_candidates; near-miss counts are best-effort from the in-memory scanner
 * buffer (marked unavailable when a restart has cleared it).
 */
import { tradingDay } from "../trading-session.ts";
import type { OutcomeInput, CandidateInput, LiveInstrumentation } from "./nightly-summary.ts";

function lazyDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/db").getDb();
}

const LOOKBACK_MS = 3 * 24 * 3600_000; // generous window; filtered to the exact ET day in JS

/** Graded outcomes whose paper trade ENTERED on the given ET trading day. */
export function gatherOutcomesForDay(day: string, nowMs: number = Date.now(), db: any = lazyDb()): OutcomeInput[] {
  const rows = db.prepare(
    `SELECT o.strategy AS strategy, o.direction AS direction, o.dte_at_entry AS dte_at_entry,
            o.entry_session AS entry_session, o.entry_time_ms AS entry_time_ms, o.terminal_kind AS terminal_kind,
            o.grade AS grade, o.grading_status AS grading_status, o.return_pct AS return_pct,
            o.opportunity_grade AS opportunity_grade, o.peak_favorable_pct AS peak_favorable_pct
       FROM paper_trade_outcomes o
      WHERE o.entry_time_ms IS NOT NULL AND o.entry_time_ms >= ?
      ORDER BY o.entry_time_ms ASC`,
  ).all(nowMs - LOOKBACK_MS) as any[];
  return rows
    .filter((r) => tradingDay(Number(r.entry_time_ms)) === day)
    .map((r): OutcomeInput => ({
      strategy: r.strategy ?? null,
      direction: r.direction ?? null,
      dteAtEntry: r.dte_at_entry ?? null,
      entrySession: r.entry_session ?? null,
      entryTimeMs: r.entry_time_ms ?? null,
      terminalKind: r.terminal_kind ?? null,
      grade: r.grade ?? "UNGRADABLE",
      gradingStatus: r.grading_status ?? "UNGRADABLE",
      returnPct: r.return_pct ?? null,
      opportunityGrade: r.opportunity_grade ?? null,
      peakFavorablePct: r.peak_favorable_pct ?? null,
    }));
}

/** Paper candidates created on the given ET trading day (created/eligible/rejected). */
export function gatherCandidatesForDay(day: string, nowMs: number = Date.now(), db: any = lazyDb()): CandidateInput[] {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_candidates'").get();
  if (!has) return [];
  const rows = db.prepare(
    `SELECT status, reject_reason, entry_state, confidence_tier, direction, created_at_ms
       FROM paper_candidates WHERE created_at_ms >= ? ORDER BY created_at_ms ASC`,
  ).all(nowMs - LOOKBACK_MS) as any[];
  return rows
    .filter((r) => tradingDay(Number(r.created_at_ms)) === day)
    .map((r): CandidateInput => ({
      status: r.status ?? "",
      rejectReason: r.reject_reason ?? null,
      entryState: r.entry_state ?? null,
      confidenceTier: r.confidence_tier ?? null,
      direction: r.direction ?? null,
    }));
}

/** The set of ET trading-day strings ending at `nowMs`, inclusive, spanning `days`. */
export function recentTradingDays(nowMs: number, days: number): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < days; i++) set.add(tradingDay(nowMs - i * 24 * 3600_000));
  return set;
}

/** Graded outcomes whose entry ET day is in `daySet` (weekly aggregation). */
export function gatherOutcomesForDays(daySet: Set<string>, nowMs: number = Date.now(), db: any = lazyDb()): OutcomeInput[] {
  const rows = db.prepare(
    `SELECT o.strategy AS strategy, o.direction AS direction, o.dte_at_entry AS dte_at_entry,
            o.entry_session AS entry_session, o.entry_time_ms AS entry_time_ms, o.terminal_kind AS terminal_kind,
            o.grade AS grade, o.grading_status AS grading_status, o.return_pct AS return_pct,
            o.opportunity_grade AS opportunity_grade, o.peak_favorable_pct AS peak_favorable_pct
       FROM paper_trade_outcomes o
      WHERE o.entry_time_ms IS NOT NULL AND o.entry_time_ms >= ?
      ORDER BY o.entry_time_ms ASC`,
  ).all(nowMs - 9 * 24 * 3600_000) as any[];
  return rows
    .filter((r) => daySet.has(tradingDay(Number(r.entry_time_ms))))
    .map((r): OutcomeInput => ({
      strategy: r.strategy ?? null, direction: r.direction ?? null, dteAtEntry: r.dte_at_entry ?? null,
      entrySession: r.entry_session ?? null, entryTimeMs: r.entry_time_ms ?? null, terminalKind: r.terminal_kind ?? null,
      grade: r.grade ?? "UNGRADABLE", gradingStatus: r.grading_status ?? "UNGRADABLE", returnPct: r.return_pct ?? null,
      opportunityGrade: r.opportunity_grade ?? null, peakFavorablePct: r.peak_favorable_pct ?? null,
    }));
}

/** Paper candidates whose created ET day is in `daySet` (weekly aggregation). */
export function gatherCandidatesForDays(daySet: Set<string>, nowMs: number = Date.now(), db: any = lazyDb()): CandidateInput[] {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_candidates'").get();
  if (!has) return [];
  const rows = db.prepare(
    `SELECT status, reject_reason, entry_state, confidence_tier, direction, created_at_ms
       FROM paper_candidates WHERE created_at_ms >= ? ORDER BY created_at_ms ASC`,
  ).all(nowMs - 9 * 24 * 3600_000) as any[];
  return rows
    .filter((r) => daySet.has(tradingDay(Number(r.created_at_ms))))
    .map((r): CandidateInput => ({
      status: r.status ?? "", rejectReason: r.reject_reason ?? null, entryState: r.entry_state ?? null,
      confidenceTier: r.confidence_tier ?? null, direction: r.direction ?? null,
    }));
}

/**
 * Best-effort in-memory instrumentation for the day. near-miss counts come from
 * the scanner ring buffer; alert-timing/crossing-rescue latency are not persisted
 * so they are reported null (available reflects whether ANY live source was read).
 */
export function gatherLiveInstrumentation(day: string): LiveInstrumentation {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loopState } = require("@/lib/scanner-loop");
    const st: any = loopState();
    const nm: any[] = Array.isArray(st?.nearMisses) ? st.nearMisses : [];
    const forDay = nm.filter((e) => e?.t && tradingDay(Number(e.t)) === day).length;
    return {
      available: true,
      actionableAlerts: null,
      nearMissCount: forDay,
      lateCalloutCount: null,
      crossingRescues: null,
      avgTriggerToDiscordMs: null,
    };
  } catch {
    return { available: false, actionableAlerts: null, nearMissCount: null, lateCalloutCount: null, crossingRescues: null, avgTriggerToDiscordMs: null };
  }
}
