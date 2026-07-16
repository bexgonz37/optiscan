import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { buildStockFunnel, buildOptionsFunnel, buildTodayAudit } from "@/lib/live-funnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/funnel — the CURRENT-SESSION stock + options alert funnels.
 * The single place to look when a channel is sending zero alerts: it shows the
 * universe size, how broad the scan actually was, how many names survived each
 * gate, the classification breakdown, the top rejection reasons, and — crucially —
 * the exact config gate (blockedBy) when delivery is switched off. Read-only, no
 * secrets, no AI.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();

  const { loopState } = await import("@/lib/scanner-loop");
  const { supervisorTelemetry } = await import("@/lib/supervisor-cycle");
  const { buildConfigVisibility } = await import("@/lib/runtime-status");
  const { marketSession, tradingDay } = await import("@/lib/trading-session");
  const { discordWebhookConfigured, extendedStockNotifyEnabled } = await import("@/lib/notifications");
  const { momentumDiagnosticsForDay, summarizeMomentumDiagnostics } = await import("@/lib/momentum-diagnostics");
  const { optionsDiagnosticsForDay, summarizeOptionsDiagnostics } = await import("@/lib/options-diagnostics");

  const loop: any = loopState();
  const telemetry: any = supervisorTelemetry();
  const session = marketSession();
  // Readiness must be computed from the SAME DB-backed extras that
  // /api/runtime/status uses, or the two endpoints disagree in the same process
  // (the funnel previously read webhooks as "missing" and extended_stock_notify as
  // "off" because it passed no extras). Single source of truth: these three flags.
  const safe = <T,>(fn: () => T): T | false => { try { return fn(); } catch { return false; } };
  const { readiness } = buildConfigVisibility(process.env, {
    session,
    extendedStockNotify: safe(() => extendedStockNotifyEnabled()) === true,
    stockWebhookConfigured: safe(() => discordWebhookConfigured("stocks")) === true,
    optionsWebhookConfigured: safe(() => discordWebhookConfigured("options")) === true,
  });

  const stock = buildStockFunnel(
    Array.isArray(loop.tape) ? loop.tape : [],
    loop.discoveryStats ?? null,
    readiness.stockCallouts,
    readiness.premarketNotifications,
  );

  // Selected contracts from the last cycle's per-ticker canonical results.
  const selectedContracts: string[] = Array.isArray(telemetry.lastTickerLatencies)
    ? telemetry.lastTickerLatencies.filter((t: any) => (t?.canonical ?? 0) > 0).map((t: any) => String(t.ticker))
    : [];

  const options = buildOptionsFunnel(
    { lastCycleAtMs: telemetry.lastCycleAtMs ?? null, lastFunnel: telemetry.lastFunnel ?? null, lastSuppressedItems: telemetry.lastSuppressedItems ?? [] },
    selectedContracts,
    readiness.optionsCallouts,
  );

  // ── TODAY audit: aggregate the PERSISTED per-day diagnostics so the funnel can
  // distinguish "zero this cycle" from "zero all day", and show the last time each
  // channel actually delivered. All DB reads are wrapped so a missing table (fresh
  // deploy / legacy DB) degrades to an empty audit rather than a 500.
  const nowMs = Date.now();
  const day = tradingDay(nowMs);
  const stockRows = safe(() => momentumDiagnosticsForDay(day)) || [];
  const optionRows = safe(() => optionsDiagnosticsForDay(day)) || [];
  const stockSummary = Array.isArray(stockRows) && stockRows.length ? summarizeMomentumDiagnostics(stockRows) : null;
  const optionsSummary = Array.isArray(optionRows) && optionRows.length ? summarizeOptionsDiagnostics(optionRows) : null;
  const lastStockDeliveryMs = Array.isArray(stockRows)
    ? stockRows.reduce((mx: number | null, r: any) => {
        const t = typeof r?.discordDeliveredMs === "number" ? r.discordDeliveredMs : null;
        return t != null && (mx == null || t > mx) ? t : mx;
      }, null as number | null)
    : null;
  const lastOptionsDeliveryMs = Array.isArray(optionRows)
    ? optionRows.reduce((mx: number | null, r: any) => {
        const t = (r?.delivered ?? 0) > 0 && typeof r?.cycleAtMs === "number" ? r.cycleAtMs : null;
        return t != null && (mx == null || t > mx) ? t : mx;
      }, null as number | null)
    : null;

  const today = buildTodayAudit({
    tradingDay: day,
    nowMs,
    stockSummary: stockSummary as any,
    optionsSummary: optionsSummary as any,
    lastStockDeliveryMs,
    lastOptionsDeliveryMs,
  });

  return NextResponse.json({
    ok: true,
    session,
    generatedAtMs: nowMs,
    stock,
    options,
    today,
  });
}
