import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { getCallStats } from "@/lib/polygon-provider";
import { getSystemDataHealth } from "@/lib/data-freshness";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  return NextResponse.json({ ok: true, ...getSystemDataHealth(getCallStats()) });
}
