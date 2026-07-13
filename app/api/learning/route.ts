import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/learning — continuous-learning + drift status (Phase 7). `?run=1`
 * executes ONE bounded learning cycle (gated retrain + drift snapshot). The loop
 * never changes source code, thresholds, or trading rules; a degraded model is
 * flagged warning-only. Read-only otherwise.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { runLearningCycle, learningStatus } = await import("@/lib/learning-store");
  const { syncPaperOutcomes } = await import("@/lib/outcome-store");
  const { refreshStatistics } = await import("@/lib/statistics-store");

  let cycle = null;
  if (new URL(req.url).searchParams.get("run") === "1") {
    syncPaperOutcomes();
    refreshStatistics();
    cycle = runLearningCycle();
  }
  return NextResponse.json({
    ok: true,
    cycle,
    status: learningStatus(),
    disclaimer: "Bounded, versioned, reversible learning. Recommendations require human review; no code or trading rule is changed automatically.",
  });
}
