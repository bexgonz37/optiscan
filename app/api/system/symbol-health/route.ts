import { NextRequest, NextResponse } from "next/server";
import { getSymbolFreshness } from "@/lib/data-freshness";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ticker = String(req.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ ok: false, error: "ticker is required" }, { status: 400 });
  return NextResponse.json({ ok: true, ...getSymbolFreshness(ticker) });
}
