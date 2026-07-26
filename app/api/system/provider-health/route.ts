import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { getCallStats, hasPolygon } from "@/lib/polygon-provider";
import { getProviderHealth } from "@/lib/data-freshness";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  return NextResponse.json({
    ok: true,
    provider_configured: hasPolygon(),
    ...getProviderHealth(getCallStats()),
  });
}
