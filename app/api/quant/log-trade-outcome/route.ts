import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const { getDb } = await import("@/lib/db");
  const { inferSetupType, refreshSetupStatistics } = await import("@/lib/quant");
  const ticker = String(body?.ticker ?? "").toUpperCase().trim();
  if (!ticker) return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  const setupType = String(body?.setupType ?? body?.setup_type ?? inferSetupType(body));
  const assetClass = body?.assetClass === "stock" || body?.asset_class === "stock" ? "stock" : "options";
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO trade_outcomes (
       alert_id, historical_alert_id, paper_trade_id, journal_id, ticker, asset_class,
       setup_type, side, option_symbol, entry_price, exit_price, quantity, entry_time,
       exit_time, hold_minutes, pnl, return_pct, mfe_pct, mae_pct, market_regime,
       session, entry_reason, exit_reason, source
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    body?.alertId ?? body?.alert_id ?? null,
    body?.historicalAlertId ?? body?.historical_alert_id ?? null,
    body?.paperTradeId ?? body?.paper_trade_id ?? null,
    body?.journalId ?? body?.journal_id ?? null,
    ticker,
    assetClass,
    setupType,
    body?.side ?? null,
    body?.optionSymbol ?? body?.option_symbol ?? null,
    body?.entryPrice ?? body?.entry_price ?? null,
    body?.exitPrice ?? body?.exit_price ?? null,
    body?.quantity ?? null,
    body?.entryTime ?? body?.entry_time ?? null,
    body?.exitTime ?? body?.exit_time ?? null,
    body?.holdMinutes ?? body?.hold_minutes ?? null,
    body?.pnl ?? null,
    body?.returnPct ?? body?.return_pct ?? null,
    body?.mfePct ?? body?.mfe_pct ?? null,
    body?.maePct ?? body?.mae_pct ?? null,
    body?.marketRegime ?? body?.market_regime ?? null,
    body?.session ?? null,
    body?.entryReason ?? body?.entry_reason ?? null,
    body?.exitReason ?? body?.exit_reason ?? null,
    body?.source ?? "manual",
  );
  const stats = refreshSetupStatistics();
  return NextResponse.json({ ok: true, id: info.lastInsertRowid, stats });
}

