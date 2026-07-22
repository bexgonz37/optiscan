/**
 * lib/research/options/grade.ts — AUTOMATIC outcome grading for the independent options scanner.
 * Real-option paper positions are OPENED by the monitor (loop.ts) but must also be CLOSED and graded
 * autonomously — no manual grading command. This module:
 *   • decideOptionExit()  — PURE exit rules on the OPTION price (target / stop / expiration / time-stop).
 *   • gradeOpenOptionPositionsOnDb() — refresh each open position's quote, apply the rules, persist EXIT.
 *   • startOptionsGrader() — in-process singleton loop (gated), restart-safe (open rows persist in the DB
 *     so grading simply resumes after a deploy/restart). A provider/DB error NEVER stops the loop.
 *
 * P&L is computed from the OPTION contract price (×100), never the underlying. Only REAL_OPTION_PAPER
 * rows are graded here; equity paper, modeled options, and underlying proxies stay in their own lanes
 * and are never combined. HARD no-op unless INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1 AND
 * REAL_OPTION_PAPER_ENABLED=1. This does NOT touch any strategy entry gate.
 */
import { researchFlags } from "../flags.ts";
import { realOptionExit } from "./paper.ts";

export interface OpenPosition {
  id: number; option_symbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number;
  entry_fill: number; result_class: string; strategy: string; underlying_price: number | null;
  target: number | null; invalidation: number | null; entered_at_ms: number; status: string;
}
export interface RefreshedQuote { bid: number | null; ask: number | null; quoteAgeMs: number | null }

export interface GradeConfig { takeProfitPct: number; stopLossPct: number; maxHoldMs: number; maxQuoteAgeMs: number }
export function defaultGradeConfig(env: NodeJS.ProcessEnv = process.env): GradeConfig {
  const n = (v: string | undefined, d: number, min = 0) => { const x = Number(v); return Number.isFinite(x) && x >= min ? x : d; };
  return {
    takeProfitPct: n(env.OPTIONS_PAPER_TAKE_PROFIT_PCT, 60, 1),
    stopLossPct: n(env.OPTIONS_PAPER_STOP_LOSS_PCT, 40, 1),
    maxHoldMs: n(env.OPTIONS_PAPER_MAX_HOLD_MS, 172_800_000, 60_000), // 2 days; expiration usually fires first
    maxQuoteAgeMs: n(env.OPTIONS_GRADE_MAX_QUOTE_AGE_MS, 900_000, 1000),
  };
}

/** Options expire end-of-day on their expiration date. Approximate the cutoff as 20:00 UTC (≈ US market
 *  close during EDT) on that date — good enough for paper time accounting; documented as approximate. */
export function expirationCutoffMs(expiration: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  const t = Date.parse(`${expiration}T20:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

export type ExitReason = "target_hit" | "stop_hit" | "expiration" | "time_stop" | "expiration_no_quote";
export interface ExitDecision {
  action: "hold" | "exit"; reason: ExitReason | null;
  exitFill: number | null; pnl: number | null; returnPct: number | null; note: string;
}

/**
 * PURE exit decision on a single open position given the latest quote. Priority: a fresh quote hitting
 * target/stop closes at a real price; otherwise expiration/time-stop close on time. When a position
 * expires without any usable quote, it is closed HONESTLY with pnl=null (we do not fabricate a price).
 */
export function decideOptionExit(pos: OpenPosition, quote: RefreshedQuote | null, nowMs: number, cfg: GradeConfig = defaultGradeConfig()): ExitDecision {
  const hold = (note: string): ExitDecision => ({ action: "hold", reason: null, exitFill: null, pnl: null, returnPct: null, note });
  const fresh = quote != null && quote.bid != null && quote.bid > 0 && quote.ask != null && quote.ask > 0
    && (quote.quoteAgeMs == null || quote.quoteAgeMs <= cfg.maxQuoteAgeMs);

  // With a fresh two-sided quote, evaluate a price-based target/stop first (closes at a REAL exit fill).
  if (fresh) {
    const ex = realOptionExit(pos.entry_fill, quote!.bid as number, quote!.ask as number);
    if (ex.returnPct >= cfg.takeProfitPct) return { action: "exit", reason: "target_hit", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: `option return ${ex.returnPct}% ≥ +${cfg.takeProfitPct}%` };
    if (ex.returnPct <= -cfg.stopLossPct) return { action: "exit", reason: "stop_hit", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: `option return ${ex.returnPct}% ≤ -${cfg.stopLossPct}%` };
  }

  // Expiration — closes regardless of quote availability (time, not price).
  const cutoff = expirationCutoffMs(pos.expiration);
  if (cutoff != null && nowMs >= cutoff) {
    if (fresh) { const ex = realOptionExit(pos.entry_fill, quote!.bid as number, quote!.ask as number); return { action: "exit", reason: "expiration", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: "closed at expiration on last quote" }; }
    return { action: "exit", reason: "expiration_no_quote", exitFill: null, pnl: null, returnPct: null, note: "expired with no usable quote — closed unpriced (pnl null, not fabricated)" };
  }

  // Time-stop — bound how long a paper position stays open.
  if (nowMs - pos.entered_at_ms >= cfg.maxHoldMs) {
    if (fresh) { const ex = realOptionExit(pos.entry_fill, quote!.bid as number, quote!.ask as number); return { action: "exit", reason: "time_stop", exitFill: ex.exitFill, pnl: ex.pnl, returnPct: ex.returnPct, note: "max hold reached" }; }
    return hold("max hold reached but no fresh quote to price the exit — hold until a quote or expiration");
  }

  return hold(fresh ? "within target/stop band" : "no fresh quote and not yet expired/timed-out");
}

interface GradeDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }
export interface GradeDeps {
  /** Refresh the latest quote for an open OCC contract. Returns null when unavailable (kept open). */
  getQuote: (optionSymbol: string, underlyingSymbol: string) => Promise<RefreshedQuote | null>;
  now?: () => number;
}
export interface GradePassResult { examined: number; graded: number; held: number; errors: number; byReason: Record<string, number> }

const occUnderlying = (occ: string) => occ.match(/^O:([A-Z]+)/)?.[1] ?? "";

/** Grade all OPEN real-option paper positions once. Isolated per-row: a single failing quote never
 *  aborts the pass. Idempotent — only status='ENTERED' rows are examined, and an EXIT flips the status. */
export async function gradeOpenOptionPositionsOnDb(db: GradeDb, deps: GradeDeps, env: NodeJS.ProcessEnv = process.env, cfg: GradeConfig = defaultGradeConfig(env)): Promise<GradePassResult> {
  const now = deps.now ?? Date.now;
  const has = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_paper_trades'").get());
  if (!has) return { examined: 0, graded: 0, held: 0, errors: 0, byReason: {} };
  const rows = db.prepare("SELECT id, option_symbol, side, strike, expiration, dte, entry_fill, result_class, strategy, underlying_price, target, invalidation, entered_at_ms, status FROM options_paper_trades WHERE status='ENTERED' AND result_class='REAL_OPTION_PAPER'").all() as OpenPosition[];
  const out: GradePassResult = { examined: rows.length, graded: 0, held: 0, errors: 0, byReason: {} };
  for (const pos of rows) {
    const nowMs = now();
    let quote: RefreshedQuote | null = null;
    try { quote = await deps.getQuote(pos.option_symbol, occUnderlying(pos.option_symbol)); }
    catch { out.errors += 1; quote = null; } // provider hiccup on one contract must not stop the pass
    const d = decideOptionExit(pos, quote, nowMs, cfg);
    if (d.action !== "exit") { out.held += 1; continue; }
    try {
      db.prepare(
        "UPDATE options_paper_trades SET status='EXITED', exit_fill=?, pnl=?, return_pct=?, exit_reason=?, exit_at_ms=?, updated_at_ms=? WHERE id=? AND status='ENTERED'",
      ).run(d.exitFill, d.pnl, d.returnPct, d.reason, nowMs, nowMs, pos.id);
      out.graded += 1; out.byReason[d.reason as string] = (out.byReason[d.reason as string] ?? 0) + 1;
    } catch { out.errors += 1; }
  }
  return out;
}

/** Read-only grading backlog for observability (open positions + last grade cycle). */
export function readGradingBacklogOnDb(db: GradeDb): { openPositions: number; gradedTotal: number; lastGradeCycleMs: number | null } {
  const has = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_paper_trades'").get());
  if (!has) return { openPositions: 0, gradedTotal: 0, lastGradeCycleMs: null };
  const n = (sql: string) => Number((db.prepare(sql).get() as any)?.n ?? 0);
  return {
    openPositions: n("SELECT COUNT(*) n FROM options_paper_trades WHERE status='ENTERED' AND result_class='REAL_OPTION_PAPER'"),
    gradedTotal: n("SELECT COUNT(*) n FROM options_paper_trades WHERE status='EXITED' AND result_class='REAL_OPTION_PAPER'"),
    lastGradeCycleMs: (db.prepare("SELECT MAX(exit_at_ms) m FROM options_paper_trades WHERE status='EXITED'").get() as any)?.m ?? null,
  };
}

// ── in-process grader loop (singleton, gated, restart-safe) ─────────────────────────────────────
interface GraderState { running: boolean; timer: any; lastCycleMs: number | null; lastResult: GradePassResult | null; cycles: number; errors: number }
type G = typeof globalThis & { __optiscanOptionsGrader?: GraderState };
function gstate(): GraderState { const g = globalThis as G; return (g.__optiscanOptionsGrader ??= { running: false, timer: null, lastCycleMs: null, lastResult: null, cycles: 0, errors: 0 }); }

export function graderIntervalMs(env: NodeJS.ProcessEnv = process.env): number { const x = Number(env.OPTIONS_GRADE_INTERVAL_MS); return Number.isFinite(x) && x >= 5000 ? x : 30_000; }

export interface LiveGradeDeps extends GradeDeps { getDb: () => any; onCycle?: (r: GradePassResult, nowMs: number) => void }
/** Start the grader (singleton). HARD no-op unless both flags on. Errors are swallowed so a provider or
 *  DB failure never stops autonomous grading; the next tick simply retries. */
export function startOptionsGrader(deps: LiveGradeDeps, env: NodeJS.ProcessEnv = process.env): { started: boolean; reason: string } {
  const s = gstate();
  if (s.running) return { started: true, reason: "already running" };
  const f = researchFlags(env);
  if (!f.independentOptionsDiscovery || !f.realOptionPaper) return { started: false, reason: "grading disabled (needs INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1 and REAL_OPTION_PAPER_ENABLED=1)" };
  s.running = true;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const r = await gradeOpenOptionPositionsOnDb(deps.getDb(), deps, env);
      s.lastResult = r; s.lastCycleMs = (deps.now ?? Date.now)(); s.cycles += 1;
      deps.onCycle?.(r, s.lastCycleMs);
    } catch { s.errors += 1; /* never stop the loop */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, graderIntervalMs(env));
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  s.timer = timer;
  const stop = () => stopOptionsGrader();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { started: true, reason: "started" };
}
export function stopOptionsGrader(): void { const s = gstate(); if (s.timer) clearInterval(s.timer); s.timer = null; s.running = false; }
export function optionsGraderState(): { running: boolean; lastCycleMs: number | null; cycles: number; errors: number; lastResult: GradePassResult | null } {
  const s = gstate(); return { running: s.running, lastCycleMs: s.lastCycleMs, cycles: s.cycles, errors: s.errors, lastResult: s.lastResult };
}
export function __resetOptionsGraderForTest(): void { stopOptionsGrader(); delete (globalThis as G).__optiscanOptionsGrader; }
