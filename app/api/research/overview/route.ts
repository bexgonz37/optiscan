import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/overview — READ-ONLY operational view of the rebuilt multi-lane
 * research architecture (Phase 8). Token-gated by the SAME shared auth as the rest of
 * the dashboard (no weaker parallel path). It NEVER mutates state, runs agents, enrolls
 * experiments, creates trades, runs replay, executes AI, changes flags, or calls a
 * provider — it only aggregates PERSISTED state + current flag configuration, and the
 * response is scrubbed of any secret-bearing key.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const { buildResearchOverviewOnDb } = await import("@/lib/research/overview");
  try {
    const overview = buildResearchOverviewOnDb(getDb());
    return NextResponse.json({ ok: true, overview });
  } catch (err: any) {
    // Fail safely: never leak a secret-bearing stack; report a bounded error.
    return NextResponse.json({ ok: false, error: String(err?.message ?? "overview failed").slice(0, 160) }, { status: 500 });
  }
}
