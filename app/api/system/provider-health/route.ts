import { NextResponse } from "next/server";
import { getCallStats, hasPolygon } from "@/lib/polygon-provider";
import { getProviderHealth } from "@/lib/data-freshness";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    provider_configured: hasPolygon(),
    ...getProviderHealth(getCallStats()),
  });
}
