import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TICKERS = ["SPY", "QQQ"];

/**
 * GET /api/callouts?tickers=SPY,QQQ — canonical Supervisor callouts across the
 * options horizons + momentum stock. One callout per deduplicated opportunity/
 * horizon; puts are RESEARCH_ONLY; no banned/guarantee language; Discord payloads
 * are preview-ready (auto-send gated by AGENT_CALLOUT_DISCORD).
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const url = new URL(req.url);
  const tickers = (url.searchParams.get("tickers") ?? "")
    .split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  const list = tickers.length ? tickers.slice(0, 8) : DEFAULT_TICKERS;

  const { buildCalloutsForTickers } = await import("@/lib/callouts/runtime");
  const result = await buildCalloutsForTickers(list);

  return NextResponse.json({
    ok: true,
    tickers: list,
    callouts: result.bundles.map((b) => ({ ...b.callout, emission: b.decision, discord: b.discord })),
    discordAutoSend: result.discordAutoSend,
    note: result.note,
    disclaimer: "Research/paper callouts. Puts are research-only. Outcomes are uncertain and never assured.",
  });
}
