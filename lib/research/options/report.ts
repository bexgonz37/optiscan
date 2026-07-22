/**
 * lib/research/options/report.ts — the DISTINCT Options Opportunity report (Options product). Kept
 * SEPARATE from the Stock Momentum Radar report and never blended.
 *
 * AI Research Lab data foundation: SUBSCRIBER performance is computed ONLY from DELIVERED_ALERT_PAPER
 * (the exact mirror of alerts that were actually delivered), read through the `options_paper_delivered`
 * VIEW so a research/experimental trade physically cannot enter subscriber statistics. Research trades
 * are reported separately from the `options_paper_research` VIEW and are NEVER combined with subscriber
 * numbers. Legacy pre-foundation rows are quarantined (in neither view). Read-only.
 */
import { tenorBand } from "./strategy-catalog.ts";
import { OPTIONS_TIER1 } from "./discovery.ts";

interface RepDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] } }
const exists = (db: RepDb, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
const TIER1 = new Set(OPTIONS_TIER1 as readonly string[]);

export interface PerfBucket { n: number; winRate: number | null; expectancyPct: number | null }
export interface SubscriberPerformance {
  source: "DELIVERED_ALERT_PAPER";
  total: number; open: number; closed: number; byClass: Record<string, number>;
  winRate: number | null; avgReturnPct: number | null; expectancyPct: number | null; maxDrawdownPct: number | null;
  byStrategy: Record<string, PerfBucket>; bySide: Record<string, PerfBucket>; byDte: Record<string, PerfBucket>; byUniverse: Record<string, PerfBucket>;
}
export interface OptionsReport {
  status: "COLLECTING_DATA" | "HAS_SAMPLE";
  candidates: { total: number; byState: Record<string, number> };
  callouts: { ready: number; tooLate: number; rejected: number; expired: number };
  subscriberPerformance: SubscriberPerformance;              // DELIVERED_ALERT_PAPER only
  researchPaper: { source: "RESEARCH_ONLY_PAPER"; total: number; open: number; closed: number };
  legacyQuarantined: number;                                 // pre-foundation rows in NEITHER lane
  note: string;
}

function perf(rows: { return_pct: number | null }[]): PerfBucket {
  const graded = rows.filter((r) => r.return_pct != null);
  if (graded.length === 0) return { n: rows.length, winRate: null, expectancyPct: null };
  const wins = graded.filter((r) => (r.return_pct as number) > 0).length;
  const exp = graded.reduce((a, r) => a + (r.return_pct as number), 0) / graded.length;
  return { n: rows.length, winRate: +(wins / graded.length).toFixed(4), expectancyPct: +exp.toFixed(4) };
}
const symOf = (occ: string) => (occ.match(/^O:([A-Z]+)/)?.[1] ?? "");

/** Read subscriber-facing rows — DELIVERED_ALERT_PAPER ONLY, via the enforcement view when present. */
function deliveredRows(db: RepDb): any[] {
  if (exists(db, "options_paper_delivered")) return db.prepare("SELECT option_symbol, side, dte, strategy, result_class, status, return_pct FROM options_paper_delivered").all() as any[];
  // Fallback (a table without the view but with the column): still filter to delivered — never all rows.
  if (exists(db, "options_paper_trades")) { try { return db.prepare("SELECT option_symbol, side, dte, strategy, result_class, status, return_pct FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER'").all() as any[]; } catch { return []; } }
  return [];
}
function researchCount(db: RepDb): { total: number; open: number; closed: number } {
  const q = (sql: string) => { try { return Number((db.prepare(sql).get() as any)?.n ?? 0); } catch { return 0; } };
  if (exists(db, "options_paper_research")) return { total: q("SELECT COUNT(*) n FROM options_paper_research"), open: q("SELECT COUNT(*) n FROM options_paper_research WHERE status='ENTERED'"), closed: q("SELECT COUNT(*) n FROM options_paper_research WHERE status='EXITED'") };
  return { total: 0, open: 0, closed: 0 };
}

export function readOptionsReportOnDb(db: RepDb): OptionsReport {
  const n = (sql: string) => Number((db.prepare(sql).get() as any)?.n ?? 0);
  const byState: Record<string, number> = {};
  if (exists(db, "options_candidates")) for (const r of db.prepare("SELECT state, COUNT(*) c FROM options_candidates GROUP BY state").all() as any[]) byState[r.state] = r.c;
  const candTotal = exists(db, "options_candidates") ? n("SELECT COUNT(*) n FROM options_candidates") : 0;

  const delivered = deliveredRows(db);
  const closed = delivered.filter((r) => r.return_pct != null);
  const byClass: Record<string, number> = {};
  for (const r of delivered) byClass[r.result_class] = (byClass[r.result_class] ?? 0) + 1;
  const group = (rows: any[], key: (r: any) => string) => { const m: Record<string, any[]> = {}; for (const r of rows) { const k = key(r); (m[k] ??= []).push(r); } return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, perf(v)])); };
  const returns = closed.map((r) => r.return_pct as number);
  const wins = returns.filter((x) => x > 0).length;
  const avgReturn = returns.length ? +(returns.reduce((a, x) => a + x, 0) / returns.length).toFixed(4) : null;
  // Max drawdown of the cumulative closed-trade return curve (equity-curve peak-to-trough, in return pts).
  let peak = 0, cum = 0, maxDd = 0;
  for (const r of returns) { cum += r; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDd) maxDd = dd; }

  const subscriberPerformance: SubscriberPerformance = {
    source: "DELIVERED_ALERT_PAPER",
    total: delivered.length, open: delivered.filter((r) => r.status === "ENTERED").length, closed: closed.length, byClass,
    winRate: closed.length ? +(wins / closed.length).toFixed(4) : null,
    avgReturnPct: avgReturn, expectancyPct: avgReturn, maxDrawdownPct: returns.length ? +maxDd.toFixed(4) : null,
    byStrategy: group(delivered, (r) => r.strategy ?? "unknown"),
    bySide: group(delivered, (r) => r.side ?? "unknown"),
    byDte: group(delivered, (r) => tenorBand(Number(r.dte) || 0)),
    byUniverse: group(delivered, (r) => (TIER1.has(symOf(r.option_symbol)) ? "core" : "broad")),
  };
  const research = researchCount(db);
  const legacyQuarantined = exists(db, "options_paper_trades") ? (() => { try { return n("SELECT COUNT(*) n FROM options_paper_trades WHERE paper_kind='LEGACY_UNCLASSIFIED'"); } catch { return 0; } })() : 0;

  return {
    status: candTotal + delivered.length + research.total > 0 ? "HAS_SAMPLE" : "COLLECTING_DATA",
    candidates: { total: candTotal, byState },
    callouts: { ready: byState.READY ?? 0, tooLate: byState.TOO_LATE ?? 0, rejected: byState.REJECTED ?? 0, expired: byState.EXPIRED ?? 0 },
    subscriberPerformance,
    researchPaper: { source: "RESEARCH_ONLY_PAPER", total: research.total, open: research.open, closed: research.closed },
    legacyQuarantined,
    note: "OPTIONS product only — SEPARATE from the Stock Momentum Radar. Subscriber performance uses ONLY DELIVERED_ALERT_PAPER (the exact mirror of delivered alerts); RESEARCH_ONLY_PAPER is reported separately and NEVER blended. Puts RESEARCH_ONLY; no real-money execution; no profitability claim.",
  };
}
