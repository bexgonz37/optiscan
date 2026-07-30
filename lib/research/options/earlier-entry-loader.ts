/** Read-only persisted cohort loader for earlier-entry shadow research. */
import { isOptionsQuoteSession } from "../../market-session-guard.ts";
import { etCloseMs, tradingDay } from "../../trading-session.ts";
import { analyzeEarlierEntries, type EarlierEntryTrade, type EarlierEntryMark, type EarlierEntryObservation } from "./earlier-entry-research.ts";

interface Db { prepare(sql: string): { all: (...args: any[]) => any[]; get: (...args: any[]) => any } }
export type EarlierEntryEligibility = "ELIGIBLE" | "MISSING_DISCORD_PROOF" | "MISSING_EXACT_OCC" | "MISSING_FROZEN_ENTRY" | "MISSING_PAPER_MIRROR" | "MISSING_MARKS" | "MISSING_PRE_ENTRY_TIMELINE" | "INVALID_SESSION" | "INVALID_QUOTE" | "INSUFFICIENT_EVIDENCE";

export interface LoadedEarlierEntryRecord {
  alertId: string; opportunityCaseId: string | null; paperTradeId: number | null; symbol: string;
  direction: string | null; optionSymbol: string | null; expiration: string | null; strike: number | null;
  optionType: string | null; strategyFamily: string | null; sessionDate: string; canonicalSendAtMs: number | null;
  discordDeliveredAtMs: number | null; frozenEntry: number | null; historicalMarks: EarlierEntryMark[];
  underlyingObservations: unknown[]; timelineEvidence: EarlierEntryObservation[]; missingEvidence: string[];
  eligibilityStatus: EarlierEntryEligibility;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const has = (db: Db, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

function etOpenMs(day: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  for (const offset of ["-04:00", "-05:00"]) {
    const ms = Date.parse(`${day}T09:30:00${offset}`);
    if (fmt.format(new Date(ms)) === "09:30") return ms;
  }
  return Date.parse(`${day}T09:30:00-05:00`);
}

function isFreshMark(mark: EarlierEntryMark, maxQuoteAgeMs: number, evaluationAtMs: number): boolean {
  return mark.atMs <= evaluationAtMs && isOptionsQuoteSession(mark.atMs)
    && mark.bid != null && mark.ask != null && mark.bid > 0 && mark.ask >= mark.bid
    && mark.quoteAgeMs != null && mark.quoteAgeMs >= 0 && mark.quoteAgeMs <= maxQuoteAgeMs;
}

/** Loads only the persisted facts needed by the pure earlier-entry engine. */
export function loadEarlierEntryCohortOnDb(db: Db, opts: { sessionDate?: string; evaluationAtMs?: number; maxQuoteAgeMs?: number } = {}) {
  const sessionDate = opts.sessionDate ?? tradingDay();
  if (!DAY.test(sessionDate)) throw new Error("sessionDate must be YYYY-MM-DD");
  const evaluationAtMs = opts.evaluationAtMs ?? Date.now();
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;
  const start = etOpenMs(sessionDate), end = etCloseMs(sessionDate);
  const warnings: string[] = [];
  if (!has(db, "options_alerts")) return { records: [], report: analyzeEarlierEntries([]), warnings: ["options_alerts unavailable"], sessionDate };
  if (!has(db, "options_paper_trades")) warnings.push("options_paper_trades unavailable");
  if (!has(db, "options_paper_marks")) warnings.push("options_paper_marks unavailable");
  if (!has(db, "options_candidates")) warnings.push("options_candidates unavailable; pre-entry timeline cannot be reconstructed");

  const alerts = db.prepare(`SELECT oa.alert_id, oa.candidate_symbol, oa.strategy, oa.option_symbol, oa.side,
      oa.entry_mid, oa.delivered_bid, oa.delivered_ask, oa.discord_message_id, oa.opportunity_case_id,
      oa.sent_at_ms, oa.created_at_ms, oa.paper_linked
    FROM options_alerts oa
    WHERE oa.state='SENT' AND COALESCE(oa.research_only,0)=0
      AND COALESCE(oa.sent_at_ms,oa.created_at_ms)>=? AND COALESCE(oa.sent_at_ms,oa.created_at_ms)<?
    ORDER BY COALESCE(oa.sent_at_ms,oa.created_at_ms) ASC`).all(start, end);

  const records: LoadedEarlierEntryRecord[] = alerts.map((alert: any) => {
    const sentAt = Number(alert.sent_at_ms ?? alert.created_at_ms);
    const missing: string[] = [];
    const optionSymbol = alert.option_symbol == null ? null : String(alert.option_symbol);
    if (!String(alert.discord_message_id ?? "").trim()) missing.push("Discord message proof");
    if (!String(alert.opportunity_case_id ?? "").trim()) missing.push("Opportunity case");
    if (!optionSymbol) missing.push("Exact OCC");
    if (!(Number(alert.entry_mid) > 0)) missing.push("Frozen entry");
    const paper = has(db, "options_paper_trades") && optionSymbol
      ? db.prepare("SELECT id, expiration, strike FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' AND option_symbol=? ORDER BY id DESC LIMIT 1").get(alert.alert_id, optionSymbol)
      : null;
    if (!paper) missing.push("Delivered-paper mirror");
    const rawMarks = paper && has(db, "options_paper_marks")
      ? db.prepare("SELECT mark_at_ms, option_symbol, bid, ask, quote_age_ms FROM options_paper_marks WHERE trade_id=? AND option_symbol=? ORDER BY mark_at_ms ASC").all(paper.id, optionSymbol)
      : [];
    const historicalMarks = rawMarks.map((mark: any) => ({ atMs: Number(mark.mark_at_ms), optionSymbol: String(mark.option_symbol), bid: mark.bid == null ? null : Number(mark.bid), ask: mark.ask == null ? null : Number(mark.ask), quoteAgeMs: mark.quote_age_ms == null ? null : Number(mark.quote_age_ms), source: "options_paper_marks" }))
      .filter((mark: EarlierEntryMark) => isFreshMark(mark, maxQuoteAgeMs, evaluationAtMs));
    if (!historicalMarks.length) missing.push("Fresh in-session exact-OCC marks");

    // Candidate instrumentation records timestamps and a midpoint, not a historical executable ask.
    // It is surfaced for audit but cannot become a shadow entry without bid/ask proof.
    const candidates = has(db, "options_candidates") && optionSymbol
      ? db.prepare("SELECT first_detected_at_ms, first_ready_at_ms, feature_snapshot_json FROM options_candidates WHERE symbol=? AND option_symbol=? AND created_at_ms<=? ORDER BY created_at_ms ASC LIMIT 20").all(alert.candidate_symbol, optionSymbol, sentAt)
      : [];
    const timelineEvidence: EarlierEntryObservation[] = [];
    if (!candidates.length) missing.push("Pre-entry timeline");
    else missing.push("Historical pre-entry bid/ask and structure/VWAP/momentum evidence");

    let eligibilityStatus: EarlierEntryEligibility = "ELIGIBLE";
    if (isNaN(sentAt) || !isOptionsQuoteSession(sentAt)) eligibilityStatus = "INVALID_SESSION";
    else if (!String(alert.discord_message_id ?? "").trim()) eligibilityStatus = "MISSING_DISCORD_PROOF";
    else if (!optionSymbol) eligibilityStatus = "MISSING_EXACT_OCC";
    else if (!(Number(alert.entry_mid) > 0)) eligibilityStatus = "MISSING_FROZEN_ENTRY";
    else if (!paper) eligibilityStatus = "MISSING_PAPER_MIRROR";
    else if (!historicalMarks.length) eligibilityStatus = "MISSING_MARKS";
    else if (!candidates.length) eligibilityStatus = "MISSING_PRE_ENTRY_TIMELINE";
    else eligibilityStatus = "INSUFFICIENT_EVIDENCE";

    return {
      alertId: String(alert.alert_id), opportunityCaseId: alert.opportunity_case_id ?? null, paperTradeId: paper?.id ?? null,
      symbol: String(alert.candidate_symbol), direction: alert.side === "put" ? "bearish" : "bullish", optionSymbol,
      expiration: paper?.expiration ?? null, strike: paper?.strike == null ? null : Number(paper.strike), optionType: alert.side ?? null,
      strategyFamily: alert.strategy ?? null, sessionDate, canonicalSendAtMs: Number.isFinite(sentAt) ? sentAt : null,
      discordDeliveredAtMs: Number.isFinite(sentAt) ? sentAt : null, frozenEntry: Number(alert.entry_mid) || null,
      historicalMarks, underlyingObservations: [], timelineEvidence, missingEvidence: missing, eligibilityStatus,
    };
  });
  const eligibleTrades: EarlierEntryTrade[] = records.filter((record) => record.eligibilityStatus === "ELIGIBLE").map((record) => ({
    alertId: record.alertId, optionSymbol: record.optionSymbol as string, canonicalSendAtMs: record.canonicalSendAtMs as number,
    canonicalAsk: null, observations: record.timelineEvidence, marks: record.historicalMarks,
  }));
  const report = analyzeEarlierEntries(eligibleTrades, { maxQuoteAgeMs });
  return { sessionDate, records, report, warnings, cohortSize: records.length, eligibleCount: eligibleTrades.length, excludedCount: records.length - eligibleTrades.length };
}
