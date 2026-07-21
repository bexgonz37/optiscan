/**
 * lib/research/options/report.ts — the DISTINCT Options Opportunity report (Options product). Kept
 * SEPARATE from the Stock Momentum Radar report and never blended. Splits performance by strategy /
 * symbol / CALL vs PUT / DTE band / core-vs-broad / session, and by paper-result CLASS. Read-only.
 */
import { tenorBand } from "./strategy-catalog.ts";
import { OPTIONS_TIER1 } from "./discovery.ts";

interface RepDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] } }
const has = (db: RepDb, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
const TIER1 = new Set(OPTIONS_TIER1 as readonly string[]);

export interface OptionsReport {
  status: "COLLECTING_DATA" | "HAS_SAMPLE";
  candidates: { total: number; byState: Record<string, number> };
  callouts: { ready: number; tooLate: number; rejected: number; expired: number };
  paper: { total: number; byClass: Record<string, number>; realOptionPaper: number };
  performance: { byStrategy: Record<string, PerfBucket>; bySide: Record<string, PerfBucket>; byDte: Record<string, PerfBucket>; byUniverse: Record<string, PerfBucket> };
  note: string;
}
export interface PerfBucket { n: number; winRate: number | null; expectancyPct: number | null }

function perf(rows: { return_pct: number | null }[]): PerfBucket {
  const graded = rows.filter((r) => r.return_pct != null);
  if (graded.length === 0) return { n: rows.length, winRate: null, expectancyPct: null };
  const wins = graded.filter((r) => (r.return_pct as number) > 0).length;
  const exp = graded.reduce((a, r) => a + (r.return_pct as number), 0) / graded.length;
  return { n: rows.length, winRate: +(wins / graded.length).toFixed(4), expectancyPct: +exp.toFixed(4) };
}

export function readOptionsReportOnDb(db: RepDb): OptionsReport {
  const n = (sql: string) => Number((db.prepare(sql).get() as any)?.n ?? 0);
  const byState: Record<string, number> = {};
  if (has(db, "options_candidates")) for (const r of db.prepare("SELECT state, COUNT(*) c FROM options_candidates GROUP BY state").all() as any[]) byState[r.state] = r.c;
  const candTotal = has(db, "options_candidates") ? n("SELECT COUNT(*) n FROM options_candidates") : 0;

  const paperRows = has(db, "options_paper_trades") ? (db.prepare("SELECT option_symbol, side, dte, strategy, result_class, return_pct FROM options_paper_trades").all() as any[]) : [];
  const byClass: Record<string, number> = {};
  for (const r of paperRows) byClass[r.result_class] = (byClass[r.result_class] ?? 0) + 1;
  const group = (key: (r: any) => string) => { const m: Record<string, any[]> = {}; for (const r of paperRows) { const k = key(r); (m[k] ??= []).push(r); } return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, perf(v)])); };
  const symOf = (occ: string) => (occ.match(/^O:([A-Z]+)/)?.[1] ?? "");

  return {
    status: candTotal + paperRows.length > 0 ? "HAS_SAMPLE" : "COLLECTING_DATA",
    candidates: { total: candTotal, byState },
    callouts: { ready: byState.READY ?? 0, tooLate: byState.TOO_LATE ?? 0, rejected: byState.REJECTED ?? 0, expired: byState.EXPIRED ?? 0 },
    paper: { total: paperRows.length, byClass, realOptionPaper: byClass.REAL_OPTION_PAPER ?? 0 },
    performance: {
      byStrategy: group((r) => r.strategy ?? "unknown"),
      bySide: group((r) => r.side ?? "unknown"),
      byDte: group((r) => tenorBand(Number(r.dte) || 0)),
      byUniverse: group((r) => (TIER1.has(symOf(r.option_symbol)) ? "core" : "broad")),
    },
    note: "OPTIONS product only — SEPARATE from the Stock Momentum Radar. Real-option vs modeled outcomes are labeled by result_class and never combined. Puts RESEARCH_ONLY; no real-money execution.",
  };
}
