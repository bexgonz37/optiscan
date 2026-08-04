import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { withProviderConsumer } from "@/lib/provider-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agents?ticker=SPY — run every relevant horizon agent for a ticker and
 * return the Supervisor's canonical set (one per ticker+direction+horizon) plus
 * every contributing agent result for audit. Risk + hard gates always outrank
 * agent agreement; no probability overrides a hard gate.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const ticker = new URL(req.url).searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker query parameter is required" }, { status: 400 });
  }
  const { runAgentsForTicker } = await import("@/lib/agents/runtime");
  const result = await withProviderConsumer("dashboard_api", () => runAgentsForTicker(ticker.toUpperCase()));
  return NextResponse.json({
    ok: true,
    ticker: result.ticker,
    session: result.session,
    chainAvailable: result.chainAvailable,
    canonical: result.supervised.canonical,
    contributors: result.supervised.all,
    audit: result.supervised.audit,
    marketContext: result.marketContext,
    qualityControl: result.qualityControl,
    disclaimer: "Research/paper agents. Puts are research-only. Nothing here guarantees a profitable trade.",
  });
}
