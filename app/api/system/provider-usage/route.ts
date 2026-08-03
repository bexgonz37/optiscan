/**
 * Durable provider spend (Gate B6). Reads persisted accounting ONLY — this endpoint
 * makes zero provider requests, so it is safe to poll while the minute cap is saturated.
 *
 * The in-process meter is reported alongside as `liveMeter`, clearly labelled: it resets
 * on every deploy and is a gauge, not the meter of record.
 */
import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { getCallStats } from "@/lib/polygon-provider";
import {
  accountingTradingDate,
  buildProviderUsageReportOnDb,
  providerRequestsPerMinuteOnDb,
  topProviderSymbolsOnDb,
} from "@/lib/provider-accounting";
import { flushProviderAccounting } from "@/lib/provider-accounting-sink";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const nowMs = Date.now();
  const tradingDate = url.searchParams.get("date") || accountingTradingDate(nowMs);
  const windowMinutes = Math.min(
    Math.max(Number(url.searchParams.get("windowMinutes") ?? 60) || 60, 1),
    720,
  );

  // Land the in-flight minute first so the report is current. This writes buffered
  // counters — it does not make a provider call.
  flushProviderAccounting();

  const db = getDb();
  const report = buildProviderUsageReportOnDb(db, tradingDate);
  const perMinute = providerRequestsPerMinuteOnDb(db, nowMs - windowMinutes * 60_000, nowMs);
  const live = getCallStats(nowMs);

  const capUtilization = live.minuteCap > 0
    ? +((report.peakRequestsPerMinute / live.minuteCap) * 100).toFixed(1)
    : null;

  return NextResponse.json({
    ok: true,
    tradingDate,
    durable: report,
    capUtilizationPctAtPeak: capUtilization,
    minuteCap: live.minuteCap,
    dailyCap: live.dailyCap,
    recentMinutes: perMinute,
    topSymbols: topProviderSymbolsOnDb(db, tradingDate, 25),
    liveMeter: {
      note: "process-local gauge — resets on deploy/restart; `durable` is the meter of record",
      callsToday: live.callsToday,
      callsThisMinute: live.callsThisMinute,
      quotaMode: live.quotaMode,
      quotaExceededCount: live.quotaExceededCount,
    },
  });
}
