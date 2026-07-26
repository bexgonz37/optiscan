import { NextRequest, NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { retryFailedDiscordDeliveries } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  let limit = 25;
  try {
    const body = await req.json();
    if (Number.isFinite(Number(body?.limit))) limit = Number(body.limit);
  } catch { /* default */ }
  return NextResponse.json({ ok: true, ...(await retryFailedDiscordDeliveries(limit)) });
}
