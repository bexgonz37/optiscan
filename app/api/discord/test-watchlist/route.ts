import { NextRequest, NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { sendWatchlistTestMessage } from "@/lib/notifications/watchlist-test";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/discord/test-watchlist
 *
 * Authenticated Watchlist webhook wiring check only. Sends one plainly labeled,
 * non-executable message to DISCORD_WEBHOOK_WATCHLIST. It does not write alert,
 * trade, paper, content, readiness, scheduler, or watchlist-version state.
 */
export async function POST(req: NextRequest) {
  if (!checkApiToken(req)) return unauthorized();
  const result = await sendWatchlistTestMessage();
  return NextResponse.json(
    {
      ok: result.ok,
      sent: result.sent,
      messageId: result.messageId,
      httpStatus: result.httpStatus,
      error: result.error ?? null,
      route: "watchlist",
      stateChanged: false,
    },
    { status: result.ok ? 200 : 400 },
  );
}
