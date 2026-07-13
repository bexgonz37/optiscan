import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/runtime/status — read-only aggregate of the live runtime: worker/lease
 * ownership + heartbeats, scanner + supervisor cycle telemetry, Discord delivery
 * ledger counts, learning/drift state, model readiness (incl. outcomes still
 * needed for experimental/validated activation), and the improvement-agent mode +
 * pending proposals. Never exposes secrets or webhook URLs.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { buildRuntimeStatus } = await import("@/lib/runtime-status");
  return NextResponse.json({ ok: true, status: buildRuntimeStatus() });
}
