import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/research/explain — "Explain this" for the private research view.
 *
 * There is ONE chatbot. This route does not add a second: it resolves a stable
 * identifier into deterministic evidence and then asks the EXISTING Ask OptiScan path
 * to narrate it. The answer is judged by the same validator, metered against the same
 * $20/month combined cap, and carries the same ADVISORY_ONLY authority.
 *
 * Body: { kind: "METRIC" | "CASE" | "EXPERIMENT" | "COHORT", id: string, population?: string }
 *
 * ── The ordering is the design ────────────────────────────────────────────────
 *
 * The DETERMINISTIC answer is built first and returned unconditionally. AI narration
 * is additive and is attempted only afterwards. When the monthly budget is exhausted,
 * the key is absent, the provider is down, or the answer fails validation, the
 * response still carries the definition, the facts, the sample, the sessions and the
 * limitations — and says the narration is unavailable. The page never breaks, and a
 * panel that showed nothing without the model would be a panel whose numbers were
 * never really deterministic.
 *
 * Identity is PASSED, never reconstructed. A trade is named by its case id; nothing
 * here resolves a callout from ticker text.
 *
 * Owner only. No provider market-data call, no write to any trading table, no send
 * authority, and nothing here is consulted by a scanner rule, threshold, ranking
 * weight, contract choice, target, stop, exit or subscriber decision.
 */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const body = await req.json().catch(() => ({}));
    const kind = String((body as any)?.kind ?? "").toUpperCase();
    const id = String((body as any)?.id ?? "").trim();
    const population = (body as any)?.population ? String((body as any).population) : null;
    if (!id) return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });
    if (id.length > 200) return NextResponse.json({ ok: false, error: "id_too_long" }, { status: 400 });

    const { getDb } = await import("@/lib/db");
    const { buildResearchCommandCenterOnDb } = await import("@/lib/research/options/research-command-center");
    const { buildOwnerLearningReportOnDb } = await import("@/lib/research/options/owner-learning");
    const { buildExplainTarget, explainQuestionFor } = await import("@/lib/ai/explain-target");
    const db = getDb();

    // ── deterministic first, always ─────────────────────────────────────────
    const cc = buildResearchCommandCenterOnDb(db as any, {});
    let ownerRows: unknown[] = [];
    try { ownerRows = buildOwnerLearningReportOnDb(db as any, {}).rows; } catch { ownerRows = []; }

    const target = buildExplainTarget(
      { kind: kind as any, id, population },
      {
        currentEdge: cc.currentEdge,
        shadowExperiments: cc.shadowExperiments,
        ownerRows: ownerRows as any[],
      },
    );

    const deterministic = {
      target,
      // Restated at the top level so a consumer cannot render the facts without them.
      hasLiveAuthority: false as const,
      mustNotBeReadAs: target.mustNotBeReadAs,
    };

    if (!target.resolved) {
      // A refusal is a complete answer. No model call is made for one — paying to narrate
      // "this id does not exist" is the clearest possible waste of the monthly cap.
      return NextResponse.json({
        ok: true,
        deterministic,
        ai: {
          available: false,
          reason: "TARGET_UNRESOLVED",
          message: "No AI explanation: the target could not be resolved.",
          answer: null,
        },
        safety: { aiAuthority: "ADVISORY_ONLY", productionBehaviorChanged: false },
      });
    }

    // ── AI narration, additive ──────────────────────────────────────────────
    let ai: Record<string, unknown> = {
      available: false,
      reason: "AI_UNAVAILABLE",
      message: "AI EXPLANATION UNAVAILABLE — the deterministic evidence above is complete.",
      answer: null,
    };
    try {
      const { aiConfig } = await import("@/lib/ai/config");
      const { combinedCostGateOnDb } = await import("@/lib/ai/monthly-budget");
      const cfg = aiConfig(process.env);
      // No third argument: the signature is (db, cfg, nowMs, reserveUsd), and passing 0
      // for nowMs would compute the month key for 1970-01 -- a bucket the ledger has
      // never written to -- so the gate would read zero spend and always allow.
      const gate = combinedCostGateOnDb(db as any, cfg);

      if (!cfg.enabled) {
        ai = {
          available: false, reason: "AI_DISABLED",
          message: "AI EXPLANATION UNAVAILABLE — AI narration is disabled.",
          answer: null,
        };
      } else if (!gate.allowed) {
        // The exact message the brief asks for, and the deterministic block above is
        // returned alongside it rather than instead of it.
        ai = {
          available: false,
          reason: "BUDGET_EXHAUSTED",
          message: "AI EXPLANATION UNAVAILABLE — MONTHLY AI BUDGET EXHAUSTED.",
          answer: null,
          spendUsd: gate.spendUsd,
          hardLimitUsd: gate.hardLimitUsd,
        };
      } else {
        const { answerAdvisoryChat } = await import("@/lib/ai/advisory-chat");
        const { loadCanonicalReport, loadSupplementalEvidence } = await import("@/lib/ai/advisory-chat-sources");
        const report = loadCanonicalReport(db);
        const supplemental = loadSupplementalEvidence(db, process.env);
        // The resolved target joins the SAME supplemental block every other answer reads,
        // so its facts enter the same registry the validator checks against.
        (supplemental as any).explainTarget = {
          kind: target.kind, id: target.id, resolved: target.resolved, title: target.title,
          population: target.population, sampleSize: target.sampleSize,
          independentSessions: target.independentSessions, evidenceState: target.evidenceState,
          facts: target.facts, limitations: target.limitations,
          mustNotBeReadAs: target.mustNotBeReadAs,
        };
        const answer = await answerAdvisoryChat({
          question: explainQuestionFor(target),
          mode: "EXPLAIN",
          report,
          supplemental,
        });
        ai = answer.degraded
          ? {
            available: false,
            reason: answer.validationStatus ?? "AI_UNAVAILABLE",
            message: answer.validationStatus === "REJECTED_VALIDATION"
              ? "AI EXPLANATION UNAVAILABLE — the narration failed validation and was discarded."
              : "AI EXPLANATION UNAVAILABLE — the deterministic evidence above is complete.",
            answer: null,
            validationFailures: answer.validationFailures,
          }
          : {
            available: true,
            reason: null,
            message: null,
            answer: answer.answer,
            citedEvidenceIds: answer.citedEvidenceIds,
            evidence: answer.evidence.filter((e) => answer.citedEvidenceIds.includes(e.id)),
            caveats: answer.caveats,
            model: answer.model,
          };
      }
    } catch {
      // Any failure in the AI layer leaves `ai` at its unavailable default. The
      // deterministic block is already built and is returned regardless.
    }

    return NextResponse.json({
      ok: true,
      deterministic,
      ai,
      safety: {
        aiAuthority: "ADVISORY_ONLY",
        productionBehaviorChanged: false,
        audience: "OWNER_ONLY",
        note: "Explanation only. Nothing described here has live authority.",
      },
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
