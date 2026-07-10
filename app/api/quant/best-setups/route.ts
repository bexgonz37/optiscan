import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  const { bestSetupPlan, refreshSetupStatistics } = await import("@/lib/quant");
  if (new URL(req.url).searchParams.get("refresh") === "1") refreshSetupStatistics();
  return NextResponse.json({ ok: true, plan: bestSetupPlan() });
}

