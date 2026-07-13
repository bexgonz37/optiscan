import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/model/status — probability-model readiness (Phase 4). Reports the
 * champion (if any), its out-of-sample metrics, and the activation shortfall when
 * inactive. A model is a calibrated EVIDENCE score only; it never authorizes a
 * trade, and no probability is shown while the model is inactive.
 *
 * ?train=1 triggers a gated train/evaluate pass (idempotent; promotes only on
 * passing every gate). Read-only otherwise.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { modelStatus, trainAndEvaluate, checkActivation, trainingRowsOnDb } = await import("@/lib/model-registry");

  const url = new URL(req.url);
  let train = null;
  if (url.searchParams.get("train") === "1") {
    const { syncPaperOutcomes } = await import("@/lib/outcome-store");
    syncPaperOutcomes();
    train = trainAndEvaluate();
  }

  const status = modelStatus();
  return NextResponse.json({
    ok: true,
    status,
    train,
    disclaimer: "Probability is a calibrated evidence score for paper/research only. It never authorizes a trade, overrides a safety gate, or guarantees an outcome. An ACTIVE_EXPERIMENTAL_RESEARCH_ONLY state is EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY and is not a validated probability.",
  });
}
