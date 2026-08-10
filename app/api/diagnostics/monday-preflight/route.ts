import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/monday-preflight — would the measurement chain hold if the
 * market opened right now?
 *
 * NOT a market prediction. It makes no claim about any trade or about the session. It
 * checks the infrastructure that has to be sound before any of the day's evidence is
 * worth reading: the scanner is ticking, owner alerts will leave a mirror, marks can
 * be tied to a frozen contract, the recap can execute against the schema production
 * actually has, LHC_SELECT_V1 is still frozen, and subscriber distribution is still
 * blocked.
 *
 * Every check that cannot inspect its subsystem reports UNKNOWN. "We did not check"
 * and "it is fine" look identical on a dashboard and are not the same thing — which is
 * exactly how a wedged loop kept reporting healthy for five and a half hours.
 *
 * Zero provider calls, zero quota spend, no send authority, no writes.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { buildMondayPreflight } = await import("@/lib/research/options/monday-preflight");
    const { ownerResearchIntradayEnabled } = await import("@/lib/notifications/owner-research-notify");
    const { ownerValidationPaperEnabled } = await import("@/lib/research/options/owner-validation-paper");
    const db = getDb();
    const env = process.env;

    let loop: Record<string, unknown> | null = null;
    try {
      const { scannerLoopHealth } = await import("@/lib/scanner-loop");
      loop = scannerLoopHealth() as unknown as Record<string, unknown>;
    } catch { /* an uninspectable loop reports UNKNOWN, never PASS */ }

    let readiness: { state?: string; blockingGates?: number; subscriberActive?: number } | null = null;
    try {
      const { evaluateSubscriberReadiness } = await import("@/lib/research/subscriber-readiness");
      const r = evaluateSubscriberReadiness(db as any, env);
      readiness = {
        state: r.status,
        blockingGates: r.blockingGates.length,
        subscriberActive: Number(r.metrics?.subscriberActive ?? 0),
      };
    } catch { /* isolated */ }

    let lhc: { frozen: boolean; expectedHash: string; actualHash: string; shadowOnly: boolean } | null = null;
    try {
      const { checkFrozen, LHC_SELECT_V1 } = await import("@/lib/research/options/experiment-registry");
      const c = checkFrozen();
      lhc = {
        frozen: c.frozen,
        expectedHash: c.expected,
        actualHash: c.actual,
        // SHADOW_PAPER_ONLY is the only non-live mode. Anything else means the arm can
        // reach a subscriber, which is a different posture entirely.
        shadowOnly: LHC_SELECT_V1.mode === "SHADOW_PAPER_ONLY",
      };
    } catch { /* isolated */ }

    const preflight = buildMondayPreflight(db as any, {
      loop: loop as any,
      readiness,
      lhc,
      ownerRoutingEnabled: ownerResearchIntradayEnabled(env),
      ownerMirrorEnabled: ownerValidationPaperEnabled(env),
      env,
    });

    return NextResponse.json({ ok: true, ...preflight });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
