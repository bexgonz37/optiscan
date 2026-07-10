import { NextResponse } from "next/server";
import { marketSession, tradingDay, minutesToClose, isOptionsSession, isStockSession } from "@/lib/trading-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const now = Date.now();
  const exchangeTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(now));
  return NextResponse.json({
    ok: true,
    application_time: new Date(now).toISOString(),
    exchange_time: exchangeTime,
    trading_day: tradingDay(now),
    market_session: marketSession(now),
    options_actionable: isOptionsSession(now),
    stock_momentum_actionable: isStockSession(now) || marketSession(now) === "regular",
    minutes_to_close: minutesToClose(now),
  });
}
