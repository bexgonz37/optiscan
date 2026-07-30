import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { loadLossProtectionCohortOnDb } from "@/lib/research/options/loss-protection-loader";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) { const denied = requireApiToken(req); if (denied) return denied; const date = new URL(req.url).searchParams.get("date") ?? undefined; try { ensureServerBoot(); const { getDb } = await import("@/lib/db"); return NextResponse.json({ ok: true, ...loadLossProtectionCohortOnDb(getDb(), { sessionDate: date }) }); } catch (err: unknown) { return NextResponse.json({ ok: false, error: String((err as Error)?.message ?? err), productionBehaviorChanged: false }, { status: 500 }); } }
