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

  // Gate B7 measurement scope. A trading date that spans a deploy mixes the session
  // before a change with the session after it, which is exactly the evidence a
  // before/after question cannot use. `?deployment=<sha7>` or `?sinceMs=`/`?untilMs=`
  // narrows the report to a window that means something.
  // An ABSENT param must stay absent: `Number(null)` is 0 and 0 is finite, so
  // parsing before checking presence would silently bound every unscoped read to
  // `minute_bucket_ms <= 0` and report an empty day.
  const numParam = (name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw == null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const scope = {
    deploymentId: url.searchParams.get("deployment") || undefined,
    sinceMs: numParam("sinceMs"),
    untilMs: numParam("untilMs"),
  };

  const db = getDb();
  const report = buildProviderUsageReportOnDb(db, tradingDate, scope);
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
    // Gate B7 — the live partition, so an operator can read who holds what directly.
    // `getCallStats` has always computed this; the route dropped it, which left the
    // reserve exactly as unreadable as the dead grader reserve it replaced.
    minuteBudget: live.minuteBudget,
    liveMeter: {
      note: "process-local gauge — resets on deploy/restart; `durable` is the meter of record",
      callsToday: live.callsToday,
      callsThisMinute: live.callsThisMinute,
      quotaMode: live.quotaMode,
      quotaExceededCount: live.quotaExceededCount,
    },
  });
}
