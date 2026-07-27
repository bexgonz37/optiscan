/**
 * Grade Aggressive 0DTE Research opens — honors exit_policy_version; always EOD force-close.
 */

import { decideOptionExit, type GradeDeps, type OpenPosition, type RefreshedQuote } from "../grade.ts";
import { realOptionExit } from "../paper.ts";
import { applyZeroDteRealizedPnl } from "./ledger.ts";
import type { ExitPolicyVersion } from "./config.ts";

const occUnderlying = (occ: string) => occ.match(/^O:([A-Z]+)/)?.[1] ?? "";

export interface GradeResearchDb {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => unknown;
  };
}

function etMinutes(nowMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function isPastEodEt(nowMs: number): boolean {
  return etMinutes(nowMs) >= 15 * 60 + 55;
}

function toOpenPosition(row: Record<string, unknown>): OpenPosition {
  return {
    id: Number(row.id),
    option_symbol: String(row.option_symbol),
    side: (String(row.side ?? "call") === "put" ? "put" : "call"),
    strike: Number(row.strike ?? 0),
    expiration: String(row.expiration ?? ""),
    dte: Number(row.dte ?? 0),
    entry_fill: Number(row.entry_fill),
    result_class: String(row.result_class ?? "REAL_OPTION_PAPER"),
    strategy: String(row.strategy ?? row.strategy_family ?? ""),
    underlying_price: row.underlying_price != null ? Number(row.underlying_price) : null,
    target: row.target != null ? Number(row.target) : null,
    invalidation: row.invalidation != null ? Number(row.invalidation) : null,
    entered_at_ms: Number(row.entered_at_ms ?? row.created_at_ms ?? Date.now()),
    status: String(row.status ?? "ENTERED"),
    paper_kind: String(row.paper_kind ?? "ZERO_DTE_RESEARCH_PAPER"),
    alert_id: row.alert_id != null ? String(row.alert_id) : null,
  };
}

export async function gradeZeroDteResearchOnDb(
  db: GradeResearchDb,
  deps: GradeDeps,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Promise<{ graded: number; closed: number; marked: number }> {
  const rows = db.prepare(
    `SELECT * FROM options_paper_trades WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND status='ENTERED'`,
  ).all() as Record<string, unknown>[];
  let graded = 0;
  let closed = 0;
  let marked = 0;

  for (const row of rows) {
    graded += 1;
    const pos = toOpenPosition(row);
    let quote: RefreshedQuote | null = null;
    try {
      quote = await deps.getQuote(pos.option_symbol, occUnderlying(pos.option_symbol));
    } catch { quote = null; }

    const policy = String(row.exit_policy_version ?? "fixed_r") as ExitPolicyVersion;
    let exitReason: string | null = null;
    let exitFill: number | null = null;
    let returnPct: number | null = null;
    let pnl: number | null = null;

    if (isPastEodEt(nowMs)) {
      exitReason = "eod_force";
    } else if (policy === "time" && nowMs - pos.entered_at_ms >= 45 * 60_000) {
      exitReason = "time_stop";
    } else if (policy === "premium_loss" && quote?.bid != null && quote?.ask != null) {
      const ex = realOptionExit(pos.entry_fill, quote.bid, quote.ask);
      if (ex.returnPct <= -35) {
        exitReason = "premium_loss_stop";
        exitFill = ex.exitFill;
        returnPct = ex.returnPct;
        pnl = ex.pnl;
      }
    } else {
      const d = decideOptionExit(pos, quote, nowMs, undefined, env);
      if (d.action === "exit") {
        exitReason = d.reason;
        exitFill = d.exitFill;
        returnPct = d.returnPct;
        pnl = d.pnl;
      }
    }

    if (quote?.bid != null && quote?.ask != null) {
      const ex = realOptionExit(pos.entry_fill, quote.bid, quote.ask);
      const mfe = row.mfe_pct != null ? Math.max(Number(row.mfe_pct), ex.returnPct) : ex.returnPct;
      const mae = row.mae_pct != null ? Math.min(Number(row.mae_pct), ex.returnPct) : ex.returnPct;
      db.prepare(
        `UPDATE options_paper_trades SET last_mark_return_pct=?, mfe_pct=?, mae_pct=?, updated_at_ms=? WHERE id=?`,
      ).run(ex.returnPct, mfe, mae, nowMs, pos.id);
      try {
        db.prepare(
          `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, bid, ask, exit_fill, return_pct, quote_age_ms, created_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(pos.id, pos.option_symbol, nowMs, quote.bid, quote.ask, ex.exitFill, ex.returnPct, quote.quoteAgeMs ?? null, nowMs);
      } catch { /* unique/optional */ }
      marked += 1;
      if (exitReason && exitFill == null) {
        exitFill = ex.exitFill;
        returnPct = ex.returnPct;
        pnl = ex.pnl;
      }
    }

    if (exitReason && exitFill != null && returnPct != null && pnl != null) {
      db.prepare(
        `UPDATE options_paper_trades SET status='EXITED', exit_fill=?, pnl=?, return_pct=?, exit_reason=?, exit_at_ms=?, updated_at_ms=? WHERE id=?`,
      ).run(exitFill, pnl, returnPct, `${policy}:${exitReason}`, nowMs, nowMs, pos.id);
      applyZeroDteRealizedPnl(db, pnl, nowMs);
      closed += 1;
    }
  }
  return { graded, closed, marked };
}
