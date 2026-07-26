import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { buildPaidBetaReadinessReport } from "@/lib/research/paid-beta-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const report = buildPaidBetaReadinessReport(getDb());
  return NextResponse.json({ ok: true, report });
}
