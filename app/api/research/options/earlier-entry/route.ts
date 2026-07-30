import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { loadEarlierEntryCohortOnDb } from "@/lib/research/options/earlier-entry-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  try {
    ensureServerBoot();
    const { getDb } = await import("@/lib/db");
    const cohort = loadEarlierEntryCohortOnDb(getDb(), { sessionDate: date });
    return NextResponse.json({ ok: true, ...cohort, productionBehaviorChanged: false });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: String((err as Error)?.message ?? err), productionBehaviorChanged: false }, { status: 500 });
  }
}
