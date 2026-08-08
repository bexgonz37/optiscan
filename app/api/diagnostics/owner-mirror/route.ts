import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/owner-mirror — does every delivered owner opening leave exactly
 * one paper mirror on the exact contract it alerted?
 *
 * The three owner openings of 2026-08-07 predate the mirror fix and have no forward
 * paper evidence at all. They are reported as missing and are never reconstructed.
 * The `prospective` block is the only one that judges the fix: it covers openings
 * delivered after it shipped, and its target is a mirror rate of 1.
 *
 *   ?days=N   window (default 30)
 *   ?limit=N  cap (default 200)
 *
 * Read-only. No provider call, no quota spend, no send authority.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 30)));
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? 200)));

    const { getDb } = await import("@/lib/db");
    const { auditOwnerMirrorsOnDb } = await import("@/lib/research/options/owner-mirror-audit");

    const nowMs = Date.now();
    const audit = auditOwnerMirrorsOnDb(getDb() as any, {
      sinceMs: nowMs - days * 86_400_000,
      nowMs,
      limit,
    });

    return NextResponse.json({ ok: true, scope: { days, limit }, audit });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
