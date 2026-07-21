/**
 * lib/research/options/paper.ts — REAL-OPTION paper execution for the independent Options scanner.
 * PURE builders + OnDb persist. Separate from equity paper (paper_trades). Calls and puts are BOTH
 * paper-traded and graded; puts stay RESEARCH_ONLY for public actionable output. Fills are executable
 * and CONSERVATIVE (never a naive mid when the spread/liquidity doesn't support it). P&L is computed
 * from the OPTION contract price, never the underlying. HARD no-op unless REAL_OPTION_PAPER_ENABLED=1.
 */
import { researchFlags } from "../flags.ts";
import { classifyPaperResult, realOptionEntryEligible, defaultRealOptionEntryGate, type PaperResultClass } from "./paper-class.ts";

export interface OptionQuote { optionSymbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number; bid: number | null; ask: number | null; volume: number | null; openInterest: number | null; iv: number | null; delta: number | null; quoteAgeMs: number | null; providerTimestamp: number | null }

export interface RealOptionEntry {
  ok: boolean; rejections: string[];
  optionSymbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number;
  bid: number; ask: number; mid: number; spreadPct: number; entryFill: number;   // conservative executable fill
  volume: number | null; openInterest: number | null; iv: number | null; delta: number | null;
  underlyingPrice: number; strategy: string; target: number | null; invalidation: number | null;
  provenance: string; class: PaperResultClass;
}

/** Conservative long-option entry: pay toward the ASK (fraction of the spread), scaled by width — a
 *  wide/illiquid contract fills worse. Never a naive mid. Returns the executable fill. */
export function conservativeEntryFill(bid: number, ask: number, opts: { slipFraction?: number } = {}): number {
  const mid = (bid + ask) / 2;
  const slip = Math.min(1, Math.max(0, opts.slipFraction ?? 0.6)); // 60% of the way from mid → ask
  return +(mid + (ask - mid) * slip).toFixed(4);
}

export interface BuildEntryInput { quote: OptionQuote; underlyingPrice: number; strategy: string; target?: number | null; invalidation?: number | null; provenance?: string }
export function buildRealOptionEntry(input: BuildEntryInput, env: NodeJS.ProcessEnv = process.env): RealOptionEntry {
  const q = input.quote;
  const gate = realOptionEntryEligible({ optionSymbol: q.optionSymbol, bid: q.bid, ask: q.ask, spreadPct: spreadPct(q.bid, q.ask), quoteAgeMs: q.quoteAgeMs, openInterest: q.openInterest, volume: q.volume }, defaultRealOptionEntryGate(env));
  const bid = q.bid ?? 0, ask = q.ask ?? 0, mid = +(((bid + ask) / 2)).toFixed(4);
  const sp = spreadPct(q.bid, q.ask) ?? 0;
  const entryFill = gate.ok ? conservativeEntryFill(bid, ask) : mid;
  const cls = classifyPaperResult({ optionSymbol: q.optionSymbol, entryBid: q.bid, entryAsk: q.ask, pnlBasis: "option", outcomeKind: "REAL" });
  return {
    ok: gate.ok, rejections: gate.rejections,
    optionSymbol: q.optionSymbol, side: q.side, strike: q.strike, expiration: q.expiration, dte: q.dte,
    bid, ask, mid, spreadPct: +sp.toFixed(3), entryFill,
    volume: q.volume, openInterest: q.openInterest, iv: q.iv, delta: q.delta,
    underlyingPrice: input.underlyingPrice, strategy: input.strategy, target: input.target ?? null, invalidation: input.invalidation ?? null,
    provenance: input.provenance ?? "polygon:v3/snapshot/options", class: cls.class,
  };
}

/** Exit at a conservative marketable price (sell toward the BID) and compute option P&L (×100). */
export function realOptionExit(entryFill: number, exitBid: number, exitAsk: number, contracts = 1): { exitFill: number; pnlPerContract: number; pnl: number; returnPct: number } {
  const mid = (exitBid + exitAsk) / 2;
  const exitFill = +(mid - (mid - exitBid) * 0.6).toFixed(4); // 60% toward the bid (conservative sell)
  const pnlPerContract = +((exitFill - entryFill) * 100).toFixed(4);
  return { exitFill, pnlPerContract, pnl: +(pnlPerContract * contracts).toFixed(4), returnPct: entryFill > 0 ? +(((exitFill - entryFill) / entryFill) * 100).toFixed(4) : 0 };
}

function spreadPct(bid: number | null, ask: number | null): number | null { if (bid == null || ask == null) return null; const mid = (bid + ask) / 2; return mid > 0 ? ((ask - bid) / mid) * 100 : null; }

interface PaperDb { prepare(sql: string): { run: (...a: any[]) => { changes: number } } }
/** Persist a real-option paper entry (idempotent per option_symbol+entry time). Flag-gated OnDb. */
export function persistRealOptionPaperOnDb(db: PaperDb, e: RealOptionEntry, nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT INTO options_paper_trades (option_symbol, side, strike, expiration, dte, result_class, bid, ask, mid, spread_pct, entry_fill, volume, open_interest, iv, delta, underlying_price, strategy, target, invalidation, provenance, status, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(e.optionSymbol, e.side, e.strike, e.expiration, e.dte, e.class, e.bid, e.ask, e.mid, e.spreadPct, e.entryFill, e.volume, e.openInterest, e.iv, e.delta, e.underlyingPrice, e.strategy, e.target, e.invalidation, e.provenance, "ENTERED", nowMs, nowMs);
}

interface GateDb { prepare(sql: string): { get: (...a: any[]) => any } }
export interface OpenPaperGateCfg { bucketMs: number; maxConcurrent: number; maxPerSymbol: number }
export function defaultOpenPaperGate(env: NodeJS.ProcessEnv = process.env): OpenPaperGateCfg {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return { bucketMs: n(env.OPTIONS_PAPER_DEDUP_BUCKET_MS, 60_000), maxConcurrent: n(env.OPTIONS_PAPER_MAX_CONCURRENT, 20), maxPerSymbol: n(env.OPTIONS_PAPER_MAX_PER_SYMBOL, 2) };
}
const occSym = (occ: string) => occ.match(/^O:([A-Z]+)/)?.[1] ?? "";

/** Guard a real-option paper entry: dedup (symbol+strategy+contract+time-bucket), max concurrent open
 *  positions, and per-symbol exposure. Pure over the DB (read-only). */
export function canOpenRealOptionPaper(db: GateDb, i: { optionSymbol: string; strategy: string; nowMs: number }, cfg: OpenPaperGateCfg = defaultOpenPaperGate()): { ok: boolean; reason: string | null } {
  const bucketStart = i.nowMs - (i.nowMs % cfg.bucketMs);
  const dup = db.prepare("SELECT 1 FROM options_paper_trades WHERE option_symbol=? AND strategy=? AND created_at_ms >= ? LIMIT 1").get(i.optionSymbol, i.strategy, bucketStart);
  if (dup) return { ok: false, reason: "duplicate_in_time_bucket" };
  const openN = Number((db.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE status='ENTERED'").get() as any)?.n ?? 0);
  if (openN >= cfg.maxConcurrent) return { ok: false, reason: "max_concurrent_positions" };
  const sym = occSym(i.optionSymbol);
  const symN = Number((db.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE status='ENTERED' AND option_symbol LIKE ?").get(`O:${sym}%`) as any)?.n ?? 0);
  if (symN >= cfg.maxPerSymbol) return { ok: false, reason: "per_symbol_exposure" };
  return { ok: true, reason: null };
}

/** Live hook: build + persist a real-option paper entry. HARD no-op unless REAL_OPTION_PAPER_ENABLED=1. */
export function recordRealOptionPaper(input: BuildEntryInput, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { recorded: boolean; reason: string | null; entry: RealOptionEntry | null } {
  if (!researchFlags(env).realOptionPaper) return { recorded: false, reason: "REAL_OPTION_PAPER_ENABLED!=1", entry: null };
  const entry = buildRealOptionEntry(input, env);
  if (!entry.ok) return { recorded: false, reason: `entry gate: ${entry.rejections.join(",")}`, entry };
  try { persistRealOptionPaperOnDb(require("@/lib/db").getDb(), entry, nowMs); return { recorded: true, reason: null, entry }; } // eslint-disable-line @typescript-eslint/no-require-imports
  catch (e: any) { return { recorded: false, reason: `isolated: ${String(e?.message ?? e).slice(0, 100)}`, entry }; }
}
