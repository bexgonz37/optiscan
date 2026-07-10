import { NextRequest, NextResponse } from "next/server";
import { retryFailedDiscordDeliveries } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let limit = 25;
  try {
    const body = await req.json();
    if (Number.isFinite(Number(body?.limit))) limit = Number(body.limit);
  } catch { /* default */ }
  return NextResponse.json({ ok: true, ...(await retryFailedDiscordDeliveries(limit)) });
}
