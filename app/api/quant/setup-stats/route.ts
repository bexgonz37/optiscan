import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  const { refreshSetupStatistics, listSetupStats } = await import("@/lib/quant");
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const stats = refresh ? refreshSetupStatistics() : listSetupStats();
  return NextResponse.json({
    ok: true,
    stats,
    disclaimer: "This is historical/statistical analysis, not financial advice.",
  });
}

