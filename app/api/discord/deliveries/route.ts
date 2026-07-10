import { NextRequest, NextResponse } from "next/server";
import { listDiscordDeliveries } from "@/lib/alert-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  const status = req.nextUrl.searchParams.get("status");
  return NextResponse.json({ ok: true, deliveries: listDiscordDeliveries(limit, status) });
}
