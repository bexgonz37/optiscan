import { NextResponse } from "next/server";
import { getCallStats } from "@/lib/polygon-provider";
import { getSystemDataHealth } from "@/lib/data-freshness";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, ...getSystemDataHealth(getCallStats()) });
}
