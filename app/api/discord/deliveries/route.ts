import { NextRequest, NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { listDiscordDeliveries } from "@/lib/alert-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  const status = req.nextUrl.searchParams.get("status");
  return NextResponse.json({ ok: true, deliveries: listDiscordDeliveries(limit, status) });
}
