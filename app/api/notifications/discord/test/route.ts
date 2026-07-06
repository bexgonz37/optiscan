import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { sendDiscordTest } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/notifications/discord/test — sends one public-safe test message.
 * Refuses when Discord is disabled (default) or the webhook env is missing. */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  const result = await sendDiscordTest();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
