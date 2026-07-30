/** Read-only cohort loader for advisory loss-protection research. */
import { etCloseMs, tradingDay } from "../../trading-session.ts";
import { aggregateLossProtection } from "./loss-protection-aggregation.ts";
import type { ExitResearchTrade } from "./exit-policy-research.ts";
import type { LossTrade } from "./loss-protection-research.ts";
interface Db { prepare(sql: string): { all: (...args: any[]) => any[]; get: (...args: any[]) => any } }
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const has = (db: Db, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
function etOpenMs(day: string) { return Date.parse(`${day}T09:30:00-04:00`); }

/** Loads verified delivered-paper facts only; it never writes, grades, or changes exits. */
export function loadLossProtectionCohortOnDb(db: Db, opts: { sessionDate?: string; minimumSupportedSample?: number } = {}) {
  const sessionDate = opts.sessionDate ?? tradingDay();
  if (!DAY.test(sessionDate)) throw new Error("sessionDate must be YYYY-MM-DD");
  const warnings: string[] = [], exclusions: Array<{ tradeId: number | null; reason: string }> = [];
  if (!has(db, "options_paper_trades")) return { sessionDate, cohortSize: 0, eligibleCount: 0, excludedCount: 1, exclusions: [{ tradeId: null, reason: "options_paper_trades unavailable" }], warnings, report: aggregateLossProtection({ exitTrades: [], lossTrades: [] }), advisoryOnly: true as const, productionBehaviorChanged: false as const };
  if (!has(db, "options_paper_marks")) warnings.push("options_paper_marks unavailable");
  const rows = db.prepare(`SELECT p.*, a.discord_message_id, a.state alert_state FROM options_paper_trades p LEFT JOIN options_alerts a ON a.alert_id=p.alert_id WHERE p.paper_kind='DELIVERED_ALERT_PAPER' AND p.entered_at_ms>=? AND p.entered_at_ms<? ORDER BY p.entered_at_ms ASC`).all(etOpenMs(sessionDate), etCloseMs(sessionDate));
  const exitTrades: ExitResearchTrade[] = [], lossTrades: LossTrade[] = [];
  for (const p of rows) {
    const id = Number(p.id), entry = Number(p.entry_fill), occ = String(p.option_symbol ?? "");
    if (p.alert_state !== "SENT" || !String(p.discord_message_id ?? "").trim()) { exclusions.push({ tradeId: id, reason: "missing_discord_delivery_proof" }); continue; }
    if (!(entry > 0) || !occ) { exclusions.push({ tradeId: id, reason: "missing_exact_occ_or_frozen_entry" }); continue; }
    const marks = has(db, "options_paper_marks") ? db.prepare("SELECT mark_at_ms,bid,ask,quote_age_ms,created_at_ms FROM options_paper_marks WHERE trade_id=? AND option_symbol=? ORDER BY mark_at_ms ASC").all(id, occ).map((m: any) => ({ markAtMs: Number(m.mark_at_ms), atMs: Number(m.mark_at_ms), bid: m.bid == null ? null : Number(m.bid), ask: m.ask == null ? null : Number(m.ask), quoteAgeMs: m.quote_age_ms == null ? null : Number(m.quote_age_ms), createdAtMs: m.created_at_ms == null ? null : Number(m.created_at_ms) })) : [];
    if (!marks.length) { exclusions.push({ tradeId: id, reason: "missing_exact_occ_marks" }); continue; }
    const canonical = p.return_pct == null ? null : Number(p.return_pct);
    const base = { tradeId: id, side: String(p.side ?? "unknown"), dte: p.dte == null ? null : Number(p.dte), strategyFamily: p.strategy ?? null, timeOfDay: null, entryAsk: entry, enteredAtMs: Number(p.entered_at_ms), canonicalReturnPct: Number.isFinite(canonical) ? canonical : null };
    lossTrades.push({ ...base, marks: marks.map((m: any) => ({ atMs: m.atMs, bid: m.bid, ask: m.ask, quoteAgeMs: m.quoteAgeMs })) });
    exitTrades.push({ ...base, alertId: p.alert_id == null ? null : String(p.alert_id), symbol: "UNKNOWN", optionSymbol: occ, marketRegime: null, timeBucket: null, entryQuality: null, entryFill: entry, targetT1: null, targetT2: null, stop: null, status: String(p.status ?? "UNKNOWN"), exitFill: p.exit_fill == null ? null : Number(p.exit_fill), exitAtMs: p.exit_at_ms == null ? null : Number(p.exit_at_ms), exitReason: p.exit_reason ?? null, marks });
  }
  return { sessionDate, cohortSize: rows.length, eligibleCount: exitTrades.length, excludedCount: exclusions.length, exclusions, warnings, report: aggregateLossProtection({ exitTrades, lossTrades, minimumSupportedSample: opts.minimumSupportedSample }), advisoryOnly: true as const, productionBehaviorChanged: false as const };
}
