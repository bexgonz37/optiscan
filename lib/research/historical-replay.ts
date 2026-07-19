/**
 * lib/research/historical-replay.ts — bounded, point-in-time historical replay
 * (Phase 7). The pure replay core is deterministic and has NO look-ahead: a signal at
 * bar i uses only bars[0..i]; the fill happens at the NEXT bar's open; a trade closed
 * at bar j depends only on bars[0..j] (future bars can never change a closed trade).
 *
 * STOCK replay is executable (real OHLCV). OPTIONS replay is NOT executable here —
 * only OHLCV can exist historically, so it is recorded as a CONTRACT-PRICE OBSERVATION,
 * never a simulated fill, and the run is marked INACTIVE_MISSING_PROVIDER when the
 * provider cannot supply the required historical option fields.
 */
import { researchFlags } from "./flags.ts";
import { optionsReplayBlocker, type Bar } from "./replay-provider.ts";

export interface ReplayConfig {
  /** Enter when the last bar's return ≥ this %. */
  entryThresholdPct: number;
  /** Max bars to hold before a time exit. */
  holdBars: number;
  stopPct: number;
  targetPct: number;
  slippageBps: number;
  feePerTrade: number;
}

export function defaultReplayConfig(): ReplayConfig {
  return { entryThresholdPct: 1, holdBars: 10, stopPct: 5, targetPct: 8, slippageBps: 5, feePerTrade: 0 };
}

export interface ReplayTrade {
  symbol: string;
  entryTsMs: number;
  exitTsMs: number;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  mfePct: number;
  maePct: number;
  barsUsed: number;
  exitReason: "stop" | "target" | "time";
}

/**
 * Deterministic stock replay with next-bar entry and no look-ahead. Pure.
 * Slippage is applied at fill; fees are folded into the realized return.
 */
export function replayStockPure(symbol: string, bars: Bar[], cfg: ReplayConfig = defaultReplayConfig()): ReplayTrade[] {
  const trades: ReplayTrade[] = [];
  const slip = cfg.slippageBps / 10_000;
  const n = bars.length;
  let i = 1; // need bars[i-1] for the signal
  while (i < n - 1) {
    // SIGNAL at bar i uses ONLY bars[i-1], bars[i] (past + current) — never the future.
    const prev = bars[i - 1], cur = bars[i];
    const move = prev.c > 0 ? ((cur.c - prev.c) / prev.c) * 100 : 0;
    if (move < cfg.entryThresholdPct) { i += 1; continue; }

    // FILL at the NEXT bar's open (realistic; the signal bar is already closed).
    const entryBar = i + 1;
    const entryPrice = bars[entryBar].o * (1 + slip);
    const stopPrice = entryPrice * (1 - cfg.stopPct / 100);
    const targetPrice = entryPrice * (1 + cfg.targetPct / 100);

    let exitBar = entryBar;
    let exitPrice = bars[entryBar].c;
    let exitReason: ReplayTrade["exitReason"] = "time";
    let hi = bars[entryBar].h, lo = bars[entryBar].l;
    const lastAllowed = Math.min(entryBar + cfg.holdBars, n - 1);
    for (let j = entryBar; j <= lastAllowed; j++) {
      hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l);
      if (bars[j].l <= stopPrice) { exitBar = j; exitPrice = stopPrice; exitReason = "stop"; break; }
      if (bars[j].h >= targetPrice) { exitBar = j; exitPrice = targetPrice; exitReason = "target"; break; }
      if (j === lastAllowed) { exitBar = j; exitPrice = bars[j].c; exitReason = "time"; }
    }
    const grossRet = ((exitPrice - entryPrice) / entryPrice) * 100;
    const feeRet = entryPrice > 0 ? (cfg.feePerTrade / entryPrice) * 100 : 0;
    trades.push({
      symbol, entryTsMs: bars[entryBar].t, exitTsMs: bars[exitBar].t, entryPrice: +entryPrice.toFixed(4), exitPrice: +exitPrice.toFixed(4),
      returnPct: +(grossRet - feeRet).toFixed(3),
      mfePct: +(((hi - entryPrice) / entryPrice) * 100).toFixed(3),
      maePct: +(((lo - entryPrice) / entryPrice) * 100).toFixed(3),
      barsUsed: exitBar - entryBar + 1, exitReason,
    });
    i = exitBar + 1; // continue strictly after the closed trade (no overlap, no look-back leakage)
  }
  return trades;
}

/** Deterministic, reproducible experiment id from the replay definition (stable hash). */
export function experimentIdFor(input: { symbols: string[]; from: string; to: string; timespan: string; strategyVersion: number; config: ReplayConfig }): string {
  const canonical = JSON.stringify({
    symbols: [...input.symbols].map((s) => s.toUpperCase()).sort(),
    from: input.from, to: input.to, timespan: input.timespan, strategyVersion: input.strategyVersion, config: input.config,
  });
  return `replay_${djb2(canonical)}`;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

interface ReplayDb {
  prepare(sql: string): { get: (...a: any[]) => any; run: (...a: any[]) => { changes: number } };
}

export interface ReplayRunResult {
  runId: string;
  experimentId: string;
  status: string;
  symbolsDone: number;
  outcomes: number;
  skippedReason: string | null;
}

/**
 * Run a bounded STOCK replay on an explicit db. Idempotent + resumable: already-done
 * symbols (from the checkpoint) are skipped, and outcomes are UNIQUE(run,symbol,entry)
 * so a re-run never duplicates. Bars are supplied by the caller (fetched once).
 */
export function runStockReplayOnDb(
  db: ReplayDb,
  opts: { runId: string; symbolBars: Record<string, Bar[]>; from: string; to: string; timespan: string; strategyVersion: number; config?: ReplayConfig; providerCallBudget?: number; nowMs?: number },
): ReplayRunResult {
  const nowMs = opts.nowMs ?? Date.now();
  const cfg = opts.config ?? defaultReplayConfig();
  const symbols = Object.keys(opts.symbolBars);
  const experimentId = experimentIdFor({ symbols, from: opts.from, to: opts.to, timespan: opts.timespan, strategyVersion: opts.strategyVersion, config: cfg });

  db.prepare(
    `INSERT OR IGNORE INTO replay_runs (run_id, experiment_id, asset_class, symbols_json, date_from, date_to, timespan, strategy_version, config_json, status, checkpoint_json, provider_call_budget, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(opts.runId, experimentId, "stock", JSON.stringify(symbols), opts.from, opts.to, opts.timespan, opts.strategyVersion, JSON.stringify(cfg), "RUNNING", JSON.stringify({ done: [] }), opts.providerCallBudget ?? 0, nowMs, nowMs);

  const runRow = db.prepare("SELECT checkpoint_json FROM replay_runs WHERE run_id=?").get(opts.runId) as any;
  const done = new Set<string>(JSON.parse(runRow?.checkpoint_json ?? '{"done":[]}').done ?? []);

  let outcomes = 0;
  for (const symbol of symbols) {
    if (done.has(symbol)) continue;
    for (const t of replayStockPure(symbol, opts.symbolBars[symbol], cfg)) {
      const info = db.prepare(
        `INSERT OR IGNORE INTO replay_outcomes (run_id, experiment_id, symbol, asset_class, strategy_version, kind, entry_ts_ms, exit_ts_ms, entry_price, exit_price, return_pct, mfe_pct, mae_pct, bars_used, slippage_bps, fees, exit_reason, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(opts.runId, experimentId, symbol, "stock", opts.strategyVersion, "executable_stock", t.entryTsMs, t.exitTsMs, t.entryPrice, t.exitPrice, t.returnPct, t.mfePct, t.maePct, t.barsUsed, cfg.slippageBps, cfg.feePerTrade, t.exitReason, nowMs);
      outcomes += info.changes;
    }
    done.add(symbol);
    db.prepare("UPDATE replay_runs SET checkpoint_json=?, updated_at_ms=? WHERE run_id=?").run(JSON.stringify({ done: [...done] }), nowMs, opts.runId);
  }
  db.prepare("UPDATE replay_runs SET status='COMPLETED', updated_at_ms=? WHERE run_id=?").run(nowMs, opts.runId);
  return { runId: opts.runId, experimentId, status: "COMPLETED", symbolsDone: done.size, outcomes, skippedReason: null };
}

/**
 * Record an OPTIONS replay run as INACTIVE — the provider cannot truthfully supply the
 * required historical option fields, so no executable simulation is produced (only the
 * blocker is documented). Contract-price observations, when OHLCV exists, would be
 * recorded with kind='contract_price_observation' and NEVER as a fill.
 */
export function recordInactiveOptionsReplayOnDb(
  db: ReplayDb,
  opts: { runId: string; symbols: string[]; from: string; to: string; timespan: string; strategyVersion: number; nowMs?: number },
): ReplayRunResult {
  const nowMs = opts.nowMs ?? Date.now();
  const blocker = optionsReplayBlocker();
  const experimentId = experimentIdFor({ symbols: opts.symbols, from: opts.from, to: opts.to, timespan: opts.timespan, strategyVersion: opts.strategyVersion, config: defaultReplayConfig() });
  db.prepare(
    `INSERT OR IGNORE INTO replay_runs (run_id, experiment_id, asset_class, symbols_json, date_from, date_to, timespan, strategy_version, config_json, status, provider_limitations, provider_call_budget, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(opts.runId, experimentId, "option", JSON.stringify(opts.symbols), opts.from, opts.to, opts.timespan, opts.strategyVersion, null, "INACTIVE_MISSING_PROVIDER", blocker, 0, nowMs, nowMs);
  return { runId: opts.runId, experimentId, status: "INACTIVE_MISSING_PROVIDER", symbolsDone: 0, outcomes: 0, skippedReason: blocker };
}

// ── live wrapper (flag-gated; NOT auto-wired into the cycle) ──────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveDb = () => require("@/lib/db").getDb();

/**
 * Live replay driver. HARD no-op unless HISTORICAL_REPLAY_ENABLED=1. Options runs are
 * always recorded INACTIVE_MISSING_PROVIDER (no fabricated historical option data).
 */
export async function runHistoricalReplay(
  opts: { assetClass: "stock" | "option"; symbols: string[]; from: string; to: string; timespan?: string; strategyVersion?: number; providerCallBudget?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReplayRunResult> {
  const runId = `replay_${Date.now()}`;
  const timespan = opts.timespan ?? "minute";
  const strategyVersion = opts.strategyVersion ?? 1;
  if (!researchFlags(env).historicalReplay) {
    return { runId, experimentId: "", status: "SKIPPED", symbolsDone: 0, outcomes: 0, skippedReason: "HISTORICAL_REPLAY_ENABLED!=1" };
  }
  const db = liveDb() as ReplayDb;
  if (opts.assetClass === "option") {
    return recordInactiveOptionsReplayOnDb(db, { runId, symbols: opts.symbols, from: opts.from, to: opts.to, timespan, strategyVersion });
  }
  try {
    const { fetchHistoricalStockBars } = await import("./replay-provider.ts");
    const budget = opts.providerCallBudget ?? opts.symbols.length;
    const symbolBars: Record<string, Bar[]> = {};
    let calls = 0;
    for (const s of opts.symbols) {
      if (calls >= budget) break; // provider-call budget cap
      const r = await fetchHistoricalStockBars(s, { from: opts.from, to: opts.to, timespan }, env);
      calls += r.providerCalls;
      symbolBars[s] = r.bars;
    }
    return runStockReplayOnDb(db, { runId, symbolBars, from: opts.from, to: opts.to, timespan, strategyVersion, providerCallBudget: budget });
  } catch (err: any) {
    return { runId, experimentId: "", status: "ERROR", symbolsDone: 0, outcomes: 0, skippedReason: `replay error (isolated): ${err?.message ?? String(err)}` };
  }
}
