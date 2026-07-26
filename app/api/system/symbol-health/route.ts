import { NextRequest, NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { getSymbolFreshness } from "@/lib/data-freshness";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  const ticker = String(req.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ ok: false, error: "ticker is required" }, { status: 400 });
  return NextResponse.json({ ok: true, ...getSymbolFreshness(ticker) });
}
