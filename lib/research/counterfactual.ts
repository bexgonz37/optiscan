/**
 * lib/research/counterfactual.ts — truthful counterfactual grading + gate/strategy
 * analytics (Phase 5). Impure (SQLite) with pure/OnDb functions for testing.
 *
 * HONESTY — two SEPARATE concepts, never conflated:
 *   • executable_counterfactual  — only when a defensible real entry price/path existed;
 *     carries P&L (return, win). Requires defensibleEntry=true.
 *   • market_movement_observation — records what the underlying/contract later did and
 *     whether a price target was factually reached. NEVER trade P&L; win stays null.
 *
 * Analytics read the structured setup_gate_results + real outcomes (paper_trades fills,
 * executable counterfactuals, factual target-reached observations). They NEVER auto-alter
 * production thresholds — they only report.
 */

interface CfDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } };
}

const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

export interface CounterfactualInput {
  setupId: string;
  setupTier?: string | null;
  strategyAgent?: string | null;
  lane?: string | null;
  ticker?: string | null;
  horizon?: string | null;
  session?: string | null;
  regime?: string | null;
  gateResults?: unknown;
}

/**
 * Record an EXECUTABLE counterfactual — REQUIRES a defensible real entry (price + path).
 * Throws if no defensible entry, so a non-executable case can never be mislabeled as a
 * filled winner/loser. Idempotent per (setup, kind).
 */
export function recordExecutableCounterfactualOnDb(
  db: CfDb,
  input: CounterfactualInput & { entryPrice: number; exitPrice: number; reachedTarget: boolean },
  nowMs: number = Date.now(),
): { recorded: boolean } {
  if (!(input.entryPrice > 0) || !Number.isFinite(input.exitPrice)) {
    throw new Error("executable counterfactual requires a defensible real entry price and exit path");
  }
  const returnPct = ((input.exitPrice - input.entryPrice) / input.entryPrice) * 100;
  const win = returnPct > 0 ? 1 : 0;
  const info = db.prepare(
    `INSERT OR IGNORE INTO counterfactual_outcomes
      (setup_id, kind, setup_tier, strategy_agent, lane, ticker, horizon, session, regime,
       entry_price, exit_price, return_pct, win, reached_target, underlying_move_pct, contract_move_pct, observation_note,
       defensible_entry, gate_results_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?)`,
  ).run(
    input.setupId, "executable_counterfactual", input.setupTier ?? null, input.strategyAgent ?? null, input.lane ?? null,
    input.ticker ?? null, input.horizon ?? null, input.session ?? null, input.regime ?? null,
    input.entryPrice, input.exitPrice, +returnPct.toFixed(4), win, input.reachedTarget ? 1 : 0,
    null, null, null, 1, j(input.gateResults), nowMs,
  );
  return { recorded: info.changes > 0 };
}

/**
 * Record a MARKET-MOVEMENT OBSERVATION — a factual note about what price later did.
 * NEVER trade P&L: win stays null, defensible_entry=0. `reachedTarget` is a market fact
 * (did the underlying/contract reach a defined level), not a filled outcome.
 */
export function recordMarketObservationOnDb(
  db: CfDb,
  input: CounterfactualInput & { underlyingMovePct?: number | null; contractMovePct?: number | null; reachedTarget: boolean; note?: string | null },
  nowMs: number = Date.now(),
): { recorded: boolean } {
  const info = db.prepare(
    `INSERT OR IGNORE INTO counterfactual_outcomes
      (setup_id, kind, setup_tier, strategy_agent, lane, ticker, horizon, session, regime,
       entry_price, exit_price, return_pct, win, reached_target, underlying_move_pct, contract_move_pct, observation_note,
       defensible_entry, gate_results_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?)`,
  ).run(
    input.setupId, "market_movement_observation", input.setupTier ?? null, input.strategyAgent ?? null, input.lane ?? null,
    input.ticker ?? null, input.horizon ?? null, input.session ?? null, input.regime ?? null,
    null, null, null, null, input.reachedTarget ? 1 : 0,
    input.underlyingMovePct ?? null, input.contractMovePct ?? null, input.note ?? null, 0, j(input.gateResults), nowMs,
  );
  return { recorded: info.changes > 0 };
}

export interface KnownOutcome {
  known: boolean;
  reachedTarget: boolean | null;
  /** Trade P&L win only when a real/executable fill exists; null for pure observations. */
  win: boolean | null;
  source: "paper_fill" | "executable_counterfactual" | "market_observation" | "none";
}

/** The best-known factual outcome for a setup — prefers a real fill, then an executable
 *  counterfactual, then a factual target-reached observation. */
export function knownOutcomeOnDb(db: CfDb, setupId: string): KnownOutcome {
  const t = db.prepare(
    `SELECT entry_price, exit_price, option_symbol, option_type FROM paper_trades
     WHERE setup_id=? AND status='EXITED' AND entry_price IS NOT NULL AND exit_price IS NOT NULL LIMIT 1`,
  ).get(setupId) as any;
  if (t) {
    const mult = t.option_symbol ? 100 : 1;
    const dir = !t.option_symbol && t.option_type === "put" ? -1 : 1;
    const win = (t.exit_price - t.entry_price) * dir * mult > 0;
    return { known: true, reachedTarget: win, win, source: "paper_fill" };
  }
  const ex = db.prepare("SELECT win, reached_target FROM counterfactual_outcomes WHERE setup_id=? AND kind='executable_counterfactual' LIMIT 1").get(setupId) as any;
  if (ex) return { known: true, reachedTarget: ex.reached_target === 1, win: ex.win === 1, source: "executable_counterfactual" };
  const ob = db.prepare("SELECT reached_target FROM counterfactual_outcomes WHERE setup_id=? AND kind='market_movement_observation' LIMIT 1").get(setupId) as any;
  if (ob && ob.reached_target != null) return { known: true, reachedTarget: ob.reached_target === 1, win: null, source: "market_observation" };
  return { known: false, reachedTarget: null, win: null, source: "none" };
}

export interface GateEffectivenessRow {
  gate: string;
  rejected: number;                 // setups this gate failed
  rejectedWithKnownOutcome: number;
  eventualWinnersRejected: number;  // failed this gate but later reached target (false negative)
  eventualLosersBlocked: number;    // failed this gate and did NOT reach target (correct block)
  falseNegativeRatePct: number | null;
  correctBlockRatePct: number | null;
  insufficientSample: boolean;
}

/**
 * Gate effectiveness: for each named gate, how often rejecting it blocked an eventual
 * loser vs an eventual winner. Eventual winner/loser use the FACTUAL reached-target
 * signal (distinct from filled P&L). Small samples are flagged, never silently ranked.
 */
export function gateEffectivenessOnDb(db: CfDb, opts: { minSample?: number } = {}): GateEffectivenessRow[] {
  const minSample = opts.minSample ?? 20;
  const failed = db.prepare("SELECT gate_name, setup_id FROM setup_gate_results WHERE passed=0").all() as any[];
  const byGate = new Map<string, string[]>();
  for (const r of failed) {
    if (!byGate.has(r.gate_name)) byGate.set(r.gate_name, []);
    byGate.get(r.gate_name)!.push(r.setup_id);
  }
  const rows: GateEffectivenessRow[] = [];
  for (const [gate, setupIds] of byGate) {
    let known = 0, winnersRejected = 0, losersBlocked = 0;
    for (const sid of setupIds) {
      const o = knownOutcomeOnDb(db, sid);
      if (!o.known || o.reachedTarget == null) continue;
      known += 1;
      if (o.reachedTarget) winnersRejected += 1; else losersBlocked += 1;
    }
    rows.push({
      gate, rejected: setupIds.length, rejectedWithKnownOutcome: known,
      eventualWinnersRejected: winnersRejected, eventualLosersBlocked: losersBlocked,
      falseNegativeRatePct: known ? +((winnersRejected / known) * 100).toFixed(1) : null,
      correctBlockRatePct: known ? +((losersBlocked / known) * 100).toFixed(1) : null,
      insufficientSample: known < minSample,
    });
  }
  return rows.sort((a, b) => (a.gate < b.gate ? -1 : a.gate > b.gate ? 1 : 0));
}

export interface StrategyAnalyticsRow {
  strategyAgent: string;
  strategyVersion: number | null;
  enrolled: number;
  filled: number;
  observedUnfilled: number;
  graded: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  profitFactor: number | null;
  insufficientSample: boolean;
}

/** Per-agent (and version) research analytics from enrollments + reused paper_trades fills. */
export function strategyAnalyticsOnDb(db: CfDb, opts: { minSample?: number } = {}): StrategyAnalyticsRow[] {
  const minSample = opts.minSample ?? 20;
  const agents = db.prepare(
    "SELECT DISTINCT strategy_agent, strategy_version FROM research_enrollments WHERE strategy_agent IS NOT NULL",
  ).all() as any[];
  const rows: StrategyAnalyticsRow[] = [];
  for (const a of agents) {
    const agent = a.strategy_agent as string;
    const ver = a.strategy_version as number | null;
    const enrolled = num(db, "SELECT COUNT(*) n FROM research_enrollments WHERE strategy_agent=?", agent);
    const filled = num(db, "SELECT COUNT(*) n FROM research_enrollments WHERE strategy_agent=? AND fill_status='FILLED'", agent);
    const observedUnfilled = num(db, "SELECT COUNT(*) n FROM research_enrollments WHERE strategy_agent=? AND fill_status='OBSERVED_UNFILLED'", agent);
    const graded = db.prepare(
      `SELECT entry_price, exit_price, option_symbol, option_type FROM paper_trades
       WHERE strategy_agent=? AND status='EXITED' AND entry_price IS NOT NULL AND exit_price IS NOT NULL`,
    ).all(agent) as any[];
    const returns = graded.map((t) => {
      const mult = t.option_symbol ? 100 : 1;
      const dir = !t.option_symbol && t.option_type === "put" ? -1 : 1;
      return ((t.exit_price - t.entry_price) * dir * mult) / (t.entry_price * mult) * 100;
    });
    const wins = returns.filter((r) => r > 0).length;
    const losses = returns.filter((r) => r <= 0).length;
    const grossWin = returns.filter((r) => r > 0).reduce((s, r) => s + r, 0);
    const grossLoss = Math.abs(returns.filter((r) => r <= 0).reduce((s, r) => s + r, 0));
    rows.push({
      strategyAgent: agent, strategyVersion: ver, enrolled, filled, observedUnfilled,
      graded: returns.length, wins, losses,
      winRatePct: returns.length ? +((wins / returns.length) * 100).toFixed(1) : null,
      avgReturnPct: returns.length ? +(returns.reduce((s, r) => s + r, 0) / returns.length).toFixed(2) : null,
      medianReturnPct: returns.length ? +median(returns).toFixed(2) : null,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
      insufficientSample: returns.length < minSample,
    });
  }
  return rows.sort((a, b) => (a.strategyAgent < b.strategyAgent ? -1 : a.strategyAgent > b.strategyAgent ? 1 : 0));
}

function num(db: CfDb, sql: string, ...a: any[]): number {
  return Number((db.prepare(sql).get(...a) as any)?.n ?? 0);
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
