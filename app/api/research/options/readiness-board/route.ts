import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The single owner surface for readiness, quarantine, ranking and the learning loop.
 *
 * Read-only and ZERO provider calls: every number comes from already-persisted evidence.
 * `?persist=1` runs the auto-assessment and writes readiness rows (still never reaching
 * SUBSCRIBER_APPROVED, which requires a named human). Without it the assessment is
 * computed and returned but nothing is written.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const persist = url.searchParams.get("persist") === "1";
    const daysRaw = Number(url.searchParams.get("days"));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(90, daysRaw) : 30;
    const nowMs = Date.now();

    const { getDb } = await import("@/lib/db");
    const { runReadinessAssessment } = await import("@/lib/research/options/readiness-assessment");
    const { deployInfo } = await import("@/lib/build-info");
    const { listReadinessOnDb, readinessSchemaReady, DEFAULT_READINESS_STATE, SUBSCRIBER_AUTHORISED } =
      await import("@/lib/research/options/strategy-readiness");
    const { RANKING_VERSION, COMPONENT_WEIGHTS, PENALTY_WEIGHTS } =
      await import("@/lib/research/options/opportunity-ranking");
    const { DEFAULT_CLASSIFICATION, isQuarantined } =
      await import("@/lib/research/options/strategy-performance");
    const { detectPatterns, proposeExperiments } =
      await import("@/lib/research/options/learning-evidence");
    const { OPTIONS_STRATEGIES } = await import("@/lib/research/options/strategy-catalog");
    const { planPartitions } = await import("@/lib/research/options/contract-discovery");
    const { directionalAuthorityMode } = await import("@/lib/opportunity-case/directional-authority");
    const { DISCOVERY_VERSION, SELECTION_VERSION } =
      await import("@/lib/research/options/contract-discovery");

    const db = getDb();
    const deploy = deployInfo();
    const assessment = runReadinessAssessment(db as any, {
      nowMs,
      deploymentSha: deploy.commit,
      sinceMs: nowMs - days * 86_400_000,
      persist,
    });

    // Which strategies can no market state ever select? Decidable, so computed rather
    // than remembered. Mirrors tests/strategy-selection-reachability.test.mjs.
    const unselectable: { strategy: string; dominatedBy: string[] }[] = [];
    for (let i = 0; i < OPTIONS_STRATEGIES.length; i++) {
      const s = OPTIONS_STRATEGIES[i];
      const mine = new Set(s.earlySignals);
      const dominatedBy: string[] = [];
      for (let j = 0; j < i; j++) {
        const t = OPTIONS_STRATEGIES[j];
        if (!t.earlySignals.length) continue;
        if (!t.earlySignals.every((sig) => mine.has(sig))) continue;
        if (t.earlySignals.length < s.earlySignals.length) continue;
        if (s.symbolScope === "index" && t.symbolScope !== "index") continue;
        dominatedBy.push(t.key);
      }
      if (dominatedBy.length) unselectable.push({ strategy: s.key, dominatedBy });
    }

    // 0DTE partition planning, computed from the catalog, so the owner can see WHICH
    // strategies would actually request a same-day chain.
    const zeroDtePlanning = OPTIONS_STRATEGIES
      .filter((s) => s.preferredDte.includes("0dte"))
      .map((s) => {
        const parts = planPartitions(s.side === "put" ? "put" : "call", s.key);
        return {
          strategy: s.key,
          symbolScope: s.symbolScope ?? "any",
          selectable: !unselectable.some((u) => u.strategy === s.key),
          partitionsPlanned: parts.map((p) => p.label),
          plansZeroDte: parts.some((p) => p.dteMin === 0 && p.dteMax === 0),
        };
      });

    const patterns = detectPatterns({
      outcomes: [],
      segments: assessment.segments,
      unselectableStrategies: unselectable,
    });
    const experiments = proposeExperiments(patterns);

    const readiness = readinessSchemaReady(db as any) ? listReadinessOnDb(db as any) : [];
    const byState: Record<string, number> = {};
    for (const r of readiness) byState[r.state] = (byState[r.state] ?? 0) + 1;

    return NextResponse.json(
      {
        ok: true,
        readOnly: true,
        providerCallsIssued: 0,
        note: "Persisted evidence only. No provider call, no quota spend, no send authority.",
        generatedAtMs: nowMs,
        deployment: { commit: deploy.commit, commitShort: deploy.commitShort, branch: deploy.branch },

        gates: {
          immediateAlertsPaused: process.env.HIGH_ASYMMETRY_IMMEDIATE_ALERTS_ENABLED !== "1",
          directionalAuthorityMode: directionalAuthorityMode(),
          strategyReadinessMode: String(process.env.STRATEGY_READINESS_MODE ?? "enforce"),
          indexStrategyActionable: process.env.INDEX_STRATEGY_ACTIONABLE_ENABLED === "1",
          paper0dteResearchEnabled: process.env.PAPER_0DTE_RESEARCH_ENABLED === "1",
          subscriberAuthorisedState: SUBSCRIBER_AUTHORISED,
          defaultStateWhenUnassessed: DEFAULT_READINESS_STATE,
        },

        versions: {
          ranking: RANKING_VERSION,
          discovery: DISCOVERY_VERSION,
          selection: SELECTION_VERSION,
        },

        assessment: {
          persisted: persist,
          schemaReady: assessment.schemaReady,
          outcomesLoaded: assessment.outcomesLoaded,
          windowDays: days,
          classificationConfig: DEFAULT_CLASSIFICATION,
          note: assessment.note,
        },

        strategyPerformance: assessment.segments.map((s) => ({
          lane: s.key.lane,
          strategy: s.key.strategy,
          strategyVersion: s.key.strategyVersion,
          selectionVersion: s.key.selectionVersion,
          classification: s.classification,
          rationale: s.rationale,
          quarantined: isQuarantined(s.classification),
          metrics: s.metrics,
        })),

        readiness: {
          byState,
          subscriberApproved: readiness.filter((r) => r.state === "SUBSCRIBER_APPROVED")
            .map((r) => `${r.strategy}@${r.strategyVersion}`),
          subscriberCandidates: readiness.filter((r) => r.state === "SUBSCRIBER_CANDIDATE")
            .map((r) => `${r.strategy}@${r.strategyVersion}`),
          demoted: readiness.filter((r) => r.state === "DEMOTED")
            .map((r) => `${r.strategy}@${r.strategyVersion}`),
          records: readiness,
        },

        quarantined: assessment.quarantined,

        strategyReachability: {
          catalogSize: OPTIONS_STRATEGIES.length,
          unselectable,
          note: "Unselectable is decidable: an earlier catalog entry's signal set being a subset makes a strategy unreachable at every market state.",
        },

        zeroDtePlanning,

        ranking: {
          version: RANKING_VERSION,
          componentWeights: COMPONENT_WEIGHTS,
          penaltyWeights: PENALTY_WEIGHTS,
        },

        learning: {
          patterns,
          experiments,
          aiAuthority: {
            may: ["summarise evidence", "identify repeated patterns", "propose bounded experiments", "explain trade-offs"],
            mayNot: ["choose the authoritative live trade", "change thresholds silently", "promote a strategy", "send subscriber alerts", "deploy code", "rewrite historical outcomes"],
          },
        },
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
