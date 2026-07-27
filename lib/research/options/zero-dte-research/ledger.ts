/**
 * Lightweight cash ledger for Aggressive 0DTE Research when Broker V2 is off.
 */

import { zeroDteResearchConfig } from "./config.ts";

export interface LedgerDb {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    run: (...a: unknown[]) => unknown;
  };
}

export function ensureZeroDteAccountState(db: LedgerDb, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): {
  equityUsd: number;
  cashUsd: number;
  startingBalanceUsd: number;
} {
  const cfg = zeroDteResearchConfig(env);
  const row = db.prepare(`SELECT equity_usd, cash_usd, starting_balance_usd FROM paper_0dte_account_state WHERE id=1`).get() as
    | { equity_usd: number; cash_usd: number; starting_balance_usd: number }
    | undefined;
  if (row) {
    return {
      equityUsd: Number(row.equity_usd),
      cashUsd: Number(row.cash_usd),
      startingBalanceUsd: Number(row.starting_balance_usd),
    };
  }
  db.prepare(
    `INSERT INTO paper_0dte_account_state (id, equity_usd, cash_usd, starting_balance_usd, updated_at_ms)
     VALUES (1, ?, ?, ?, ?)`,
  ).run(cfg.startingBalanceUsd, cfg.startingBalanceUsd, cfg.startingBalanceUsd, nowMs);
  return {
    equityUsd: cfg.startingBalanceUsd,
    cashUsd: cfg.startingBalanceUsd,
    startingBalanceUsd: cfg.startingBalanceUsd,
  };
}

/** Mark-to-market equity = cash + open unrealized (premium P&L dollars). */
export function recomputeZeroDteEquity(db: LedgerDb, nowMs = Date.now()): number {
  const state = ensureZeroDteAccountState(db, process.env, nowMs);
  const open = db.prepare(
    `SELECT COALESCE(SUM(entry_fill * 100 * COALESCE(last_mark_return_pct,0) / 100.0), 0) u
       FROM options_paper_trades
      WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND status='ENTERED'`,
  ).get() as { u?: number };
  const equity = +(state.cashUsd + Number(open?.u ?? 0)).toFixed(2);
  db.prepare(`UPDATE paper_0dte_account_state SET equity_usd=?, updated_at_ms=? WHERE id=1`).run(equity, nowMs);
  return equity;
}

/** Apply realized option P&L dollars to cash after exit. */
export function applyZeroDteRealizedPnl(db: LedgerDb, pnlDollars: number, nowMs = Date.now()): void {
  const state = ensureZeroDteAccountState(db, process.env, nowMs);
  const cash = +(state.cashUsd + pnlDollars).toFixed(2);
  db.prepare(`UPDATE paper_0dte_account_state SET cash_usd=?, equity_usd=?, updated_at_ms=? WHERE id=1`)
    .run(cash, cash, nowMs);
  recomputeZeroDteEquity(db, nowMs);
}
