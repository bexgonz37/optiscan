import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  const { performanceDashboard } = await import("@/lib/quant");
  return NextResponse.json({ ok: true, dashboard: performanceDashboard() });
}

