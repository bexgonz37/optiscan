import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { listSubscribersOnDb, subscriberOpsSummary } from "@/lib/billing/subscribers-store";
import { billingEnabled } from "@/lib/billing/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  return NextResponse.json({
    ok: true,
    billingEnabled: billingEnabled(),
    summary: subscriberOpsSummary(db),
    subscribers: listSubscribersOnDb(db, 100),
  });
}
