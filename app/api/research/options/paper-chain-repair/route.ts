import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only: provable-only paper chain link repair (never fabricates cases). */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { repairProvablePaperChainLinksOnDb } = await import("@/lib/research/options/paper-chain-repair");
    const db = getDb();
    const result = repairProvablePaperChainLinksOnDb(db as Parameters<typeof repairProvablePaperChainLinksOnDb>[0], process.env);
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
