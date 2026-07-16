import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { buildStockFunnel, buildOptionsFunnel } from "@/lib/live-funnel";

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
  const { marketSession } = await import("@/lib/trading-session");

  const loop: any = loopState();
  const telemetry: any = supervisorTelemetry();
  const session = marketSession();
  const { readiness } = buildConfigVisibility(process.env, { session });

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
    { lastCycleAtMs: telemetry.lastCycleAtMs ?? null, lastFunnel: telemetry.lastFunnel ?? null },
    selectedContracts,
    readiness.optionsCallouts,
  );

  return NextResponse.json({
    ok: true,
    session,
    generatedAtMs: Date.now(),
    stock,
    options,
  });
}
