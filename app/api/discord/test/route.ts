import { NextRequest, NextResponse } from "next/server";
import { sendDiscordTest } from "@/lib/notifications";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/discord/test — send an EXPLICIT test line to the options or stocks
 * webhook to prove the channel is wired. It sends a plainly-labeled test message
 * ("OptiScan <kind> test: ... Not financial advice."), never a fabricated actionable
 * trade callout, so it cannot be mistaken for a real signal in the paid channel.
 * Auth-gated (x-scan-token) so the webhook cannot be spammed by an unauthenticated
 * caller. Body: { "kind": "options" | "stocks" } (defaults to options).
 */
export async function POST(req: NextRequest) {
  if (!checkApiToken(req)) return unauthorized();
  let kind: "options" | "stocks" = "options";
  try {
    const body = await req.json();
    if (body?.kind === "stocks") kind = "stocks";
  } catch { /* default options */ }
  const result = await sendDiscordTest(kind);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
