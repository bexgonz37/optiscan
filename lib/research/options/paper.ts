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

interface PaperDb { prepare(sql: string): { get?: (...a: any[]) => any; run: (...a: any[]) => { changes: number } } }

/** Audience classification — the STRUCTURAL separator for the AI Research Lab data foundation.
 *  DELIVERED_ALERT_PAPER is the exact mirror of a delivered Discord alert; RESEARCH_ONLY_PAPER is a
 *  shadow/experiment subscribers never see. They are never combined in any statistic. */
export type PaperKind = "DELIVERED_ALERT_PAPER" | "RESEARCH_ONLY_PAPER";
export interface PaperPersistExtra {
  session?: string | null; coreBroad?: string | null; featureSnapshotJson?: string;
  paperKind?: PaperKind; alertId?: string | null; entrySource?: string; experimentId?: string | null; experimentVariant?: string | null;
}

const PAPER_COLS = "option_symbol, side, strike, expiration, dte, result_class, bid, ask, mid, spread_pct, entry_fill, volume, open_interest, iv, delta, underlying_price, strategy, target, invalidation, provenance, status, session, core_broad, feature_snapshot_json, paper_kind, alert_id, entry_source, experiment_id, experiment_variant, entered_at_ms, created_at_ms, updated_at_ms";
const PAPER_PLACEHOLDERS = PAPER_COLS.split(",").map(() => "?").join(","); // exactly one ? per column
const paperVals = (e: RealOptionEntry, extra: PaperPersistExtra, kind: PaperKind, entrySource: string, nowMs: number): any[] => [
  e.optionSymbol, e.side, e.strike, e.expiration, e.dte, e.class, e.bid, e.ask, e.mid, e.spreadPct, e.entryFill, e.volume, e.openInterest, e.iv, e.delta, e.underlyingPrice, e.strategy, e.target, e.invalidation, e.provenance, "ENTERED", extra.session ?? null, extra.coreBroad ?? null, extra.featureSnapshotJson ?? null, kind, extra.alertId ?? null, entrySource, extra.experimentId ?? null, extra.experimentVariant ?? null, nowMs, nowMs, nowMs,
];

/** Persist a real-option paper entry with the decision-time context. FAIL-SAFE: defaults to
 *  RESEARCH_ONLY_PAPER — a trade is NEVER counted as a delivered subscriber mirror unless a caller
 *  explicitly says so (see persistDeliveredMirrorOnDb). Flag-gated OnDb. */
export function persistRealOptionPaperOnDb(db: PaperDb, e: RealOptionEntry, nowMs: number = Date.now(), extra: PaperPersistExtra = {}): void {
  const kind: PaperKind = extra.paperKind ?? "RESEARCH_ONLY_PAPER";
  const entrySource = extra.entrySource ?? (kind === "DELIVERED_ALERT_PAPER" ? "discord_delivery" : "monitor_shadow");
  db.prepare(`INSERT INTO options_paper_trades (${PAPER_COLS}) VALUES (${PAPER_PLACEHOLDERS})`).run(...paperVals(e, extra, kind, entrySource, nowMs));
}

/**
 * Create the ONE mirror of a delivered Discord alert. IDEMPOTENT by alert_id: calling it again for the
 * same alert never creates a second DELIVERED_ALERT_PAPER row — so every delivered alert has exactly
 * one linked mirror. Uses the SAME decision timestamp + quote as the alert (no hindsight, no improved
 * entry). Returns whether a mirror now exists (inserted or already existed).
 */
export function persistDeliveredMirrorOnDb(db: PaperDb, e: RealOptionEntry, decisionMs: number, alertId: string, extra: PaperPersistExtra = {}): { inserted: boolean; existed: boolean } {
  const existed = Boolean(db.prepare?.("SELECT 1 FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' LIMIT 1").get?.(alertId));
  if (existed) return { inserted: false, existed: true };
  const vals = paperVals(e, { ...extra, alertId }, "DELIVERED_ALERT_PAPER", "discord_delivery", decisionMs);
  // INSERT ... WHERE NOT EXISTS guards a concurrent double-create even past the read check above.
  const r = db.prepare(
    `INSERT INTO options_paper_trades (${PAPER_COLS}) SELECT ${PAPER_PLACEHOLDERS} WHERE NOT EXISTS (SELECT 1 FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER')`,
  ).run(...vals, alertId);
  return { inserted: (r.changes ?? 0) > 0, existed: false };
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
