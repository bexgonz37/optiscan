import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { tradingDay } from "@/lib/trading-session";
import { buildOptionsSessionAuditOnDb } from "@/lib/research/options/session-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only ET-session funnel and proof reconciliation. */
export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  const requested = new URL(req.url).searchParams.get("date") ?? tradingDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    return NextResponse.json({ ok: false, error: "date must be YYYY-MM-DD in US/Eastern" }, { status: 400 });
  }
  try {
    ensureServerBoot();
    const { getDb } = await import("@/lib/db");
    return NextResponse.json({ ok: true, audit: buildOptionsSessionAuditOnDb(getDb(), requested) });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: String((err as Error)?.message ?? err) }, { status: 500 });
  }
}
