/** Pure, advisory-only replay of loss-protection policies. */
import { isOptionsQuoteSession } from "../../market-session-guard.ts";

export type LossProtectionClassification = "THESIS_FAILED_IMMEDIATELY" | "BAD_ENTRY" | "LATE_ENTRY" | "PREMIUM_CHASE" | "EARLY_WEAKNESS_IGNORED" | "PROFIT_GIVEN_BACK" | "STOP_TOO_WIDE" | "EXIT_TOO_SLOW" | "THETA_DECAY" | "LIQUIDITY_OR_MARK_ERROR" | "NORMAL_VOLATILITY" | "UNKNOWN";
export interface LossMark { atMs: number; bid: number | null; ask: number | null; quoteAgeMs: number | null; weakening?: boolean | null }
export interface LossTrade { tradeId: number; side: "call" | "put" | string; dte: number | null; strategyFamily: string | null; timeOfDay: string | null; entryAsk: number; enteredAtMs: number; canonicalReturnPct: number | null; marks: LossMark[] }
export interface LossPolicyResult { policy: string; returnPct: number | null; exitAtMs: number | null; evidenceValid: boolean; reason: string }
export interface LossTradeReport { tradeId: number; classification: LossProtectionClassification; thresholds: Record<string, number | null>; mfePct: number | null; maePct: number | null; everProfitable: boolean; policies: LossPolicyResult[] }

function valid(m: LossMark, start: number, maxAge: number) { return m.atMs >= start && isOptionsQuoteSession(m.atMs) && m.bid != null && m.ask != null && m.bid > 0 && m.ask >= m.bid && m.quoteAgeMs != null && m.quoteAgeMs >= 0 && m.quoteAgeMs <= maxAge; }
function ret(entry: number, bid: number) { return Math.round((((bid - entry) / entry) * 100) * 10000) / 10000; }
function firstAt(rows: Array<LossMark & { returnPct: number }>, threshold: number, requireWeakening: boolean) {
  let consecutive = 0;
  for (const row of rows) { const hit = row.returnPct <= threshold && (!requireWeakening || row.weakening === true); consecutive = hit ? consecutive + 1 : 0; if (requireWeakening ? consecutive >= 2 : hit) return row; }
  return null;
}
function classify(rows: Array<LossMark & { returnPct: number }>, canonical: number | null): LossProtectionClassification {
  if (!rows.length || canonical == null) return "LIQUIDITY_OR_MARK_ERROR";
  const mfe = Math.max(...rows.map((r) => r.returnPct));
  if (mfe >= 10 && canonical <= 0) return "PROFIT_GIVEN_BACK";
  if (rows.some((r) => r.returnPct <= -10 && r.weakening) && !firstAt(rows, -10, true)) return "NORMAL_VOLATILITY";
  if (firstAt(rows, -10, true)) return "EARLY_WEAKNESS_IGNORED";
  if (rows.find((r) => r.atMs <= rows[0].atMs + 3 * 60_000 && r.returnPct <= -20)) return "THESIS_FAILED_IMMEDIATELY";
  return "BAD_ENTRY";
}

export function analyzeLossProtection(trades: LossTrade[], opts: { maxQuoteAgeMs?: number } = {}) {
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;
  const reports: LossTradeReport[] = trades.map((trade) => {
    const marks = trade.marks.filter((m) => valid(m, trade.enteredAtMs, maxQuoteAgeMs)).map((m) => ({ ...m, returnPct: ret(trade.entryAsk, m.bid as number) })).sort((a, b) => a.atMs - b.atMs);
    const thresholds: Record<string, number | null> = {};
    for (const threshold of [-5, -10, -15, -20, -25, -30]) thresholds[String(threshold)] = firstAt(marks, threshold, false)?.atMs ?? null;
    const fallback: LossPolicyResult = { policy: "Current policy", returnPct: trade.canonicalReturnPct, exitAtMs: null, evidenceValid: trade.canonicalReturnPct != null, reason: "canonical outcome" };
    const policies = [fallback,
      ...[-10, -15, -20, -25, -30].map((threshold) => { const hit = firstAt(marks, threshold, false); return { policy: `Hard loss ${threshold}%`, returnPct: hit?.returnPct ?? fallback.returnPct, exitAtMs: hit?.atMs ?? null, evidenceValid: Boolean(hit), reason: hit ? "first verified bid threshold" : "threshold not reached" }; }),
      ...[-5, -10, -15, -20].map((threshold) => { const hit = firstAt(marks, threshold, true); return { policy: `Weakness exit ${threshold}%`, returnPct: hit?.returnPct ?? fallback.returnPct, exitAtMs: hit?.atMs ?? null, evidenceValid: Boolean(hit), reason: hit ? "two consecutive weakening observations with verified bids" : "deterministic weakening not confirmed" }; }),
    ];
    const returns = marks.map((m) => m.returnPct);
    return { tradeId: trade.tradeId, classification: classify(marks, trade.canonicalReturnPct), thresholds, mfePct: returns.length ? Math.max(...returns) : null, maePct: returns.length ? Math.min(...returns) : null, everProfitable: returns.some((r) => r > 0), policies };
  });
  return { advisoryOnly: true as const, productionBehaviorChanged: false as const, trades: reports, limitations: ["Shadow policies cannot overwrite canonical outcomes.", "Weakness exits require two consecutive timestamped weakening observations and fresh executable bid/ask.", "No policy result changes live stops or exits."] };
}
