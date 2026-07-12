import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/market/context — the deterministic, versioned Market Context (Phase 3).
 * Built from the existing scanner tape (no new provider calls). Every dimension
 * is UNKNOWN unless real, fresh SPY/QQQ data supports it. Read-only aside from
 * persisting the snapshot actually used.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { recordMarketContext } = await import("@/lib/market-context-store");
  const { context, snapshotId } = recordMarketContext();
  return NextResponse.json({
    ok: true,
    context,
    snapshotId,
    note: "UNKNOWN dimensions reflect missing/stale data and are never treated as directional confirmation.",
  });
}
