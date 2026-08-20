import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/analog — the Historical Analog Engine, RESEARCH ONLY.
 *
 * Answers, for one stored SetupEpisode: what happened in sufficiently similar setups that
 * had ALREADY FINISHED RESOLVING before this episode's decision time?
 *
 *   ?episode=<episode_key>   the query episode (required for a cohort answer)
 *   ?class=<evidence class>  default HISTORICAL_UNDERLYING_ONLY — the only populated one
 *   ?horizon=5d              label horizon
 *   ?k=30 &perSymbolCap=5    retrieval bounds
 *   ?evaluate=1              also run the chronological out-of-sample evaluation
 *   ?limit=20000             corpus read cap
 *
 * With no `episode` it returns the INVENTORY: what evidence exists per class, and the
 * feature-vector contract. That is the honest default, because the first question about
 * this engine is not "what does it predict" but "what is it made of".
 *
 * ── Authority ────────────────────────────────────────────────────────────────
 *
 * Everything here is RESEARCH_ONLY / NOT_CALIBRATED_FOR_LIVE_AUTHORITY. Nothing on this
 * route is read by the scanner, strategy selection, contract selection, targets, stops,
 * exits, delivery eligibility, Discord routing or subscriber readiness. It is not on the
 * callout path: the scanner never calls it, and it issues no provider request, spends no
 * quota and writes nothing.
 *
 * ── Why the option probability is usually missing ────────────────────────────
 *
 * `optionOutcomes` is null for every class without exact option evidence, and the reason
 * is stated in `refused`. In production today that is every available class: the corpus is
 * 11,679 REAL_UNDERLYING labels and zero option outcomes. An underlying move is not an
 * option return, and this route will not convert one into the other.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const started = Date.now();

    const { getDb } = await import("@/lib/db");
    const { loadAnalogCorpusOnDb, analogCorpusInventoryOnDb } = await import("@/lib/research/analog/corpus.ts");
    const { describeAnalogFeatureVector } = await import("@/lib/research/analog/feature-vector.ts");
    const { ALL_EVIDENCE_CLASSES, evidenceClassSpec, isAnalogEvidenceClass } =
      await import("@/lib/research/analog/evidence-class.ts");
    const { retrieveAnalogs } = await import("@/lib/research/analog/retrieval.ts");
    const { availableOutcomeDistributions } = await import("@/lib/research/analog/cohort-outcomes.ts");
    const { evaluateAnalogRetrieval } = await import("@/lib/research/analog/analog-evaluation.ts");

    const db = getDb();
    const authority = {
      mode: "RESEARCH_ONLY",
      calibration: "NOT_CALIBRATED_FOR_LIVE_AUTHORITY",
      note:
        "Advisory research output. It does not influence scanner authority, strategy thresholds, " +
        "contract selection, targets, stops, exits, delivery eligibility, Discord routing or subscriber readiness.",
    };

    const clsParam = url.searchParams.get("class") ?? "HISTORICAL_UNDERLYING_ONLY";
    if (!isAnalogEvidenceClass(clsParam)) {
      return NextResponse.json(
        { ok: false, error: `unknown evidence class ${clsParam}`, evidenceClasses: ALL_EVIDENCE_CLASSES },
        { status: 400 },
      );
    }
    const horizon = url.searchParams.get("horizon") ?? undefined;
    const limit = clampInt(url.searchParams.get("limit"), 20_000, 100, 50_000);
    const episodeKey = url.searchParams.get("episode");

    const taxonomy = ALL_EVIDENCE_CLASSES.map((c) => evidenceClassSpec(c));

    // ── inventory / corpus-level evaluation (no query episode) ───────────────
    if (!episodeKey) {
      const wantEval = url.searchParams.get("evaluate") === "1";
      // The evaluation is a corpus-level question ("does retrieval predict anything?"),
      // not an episode-level one, so it must be answerable without naming an episode.
      const corpus = wantEval ? loadAnalogCorpusOnDb(db as any, { evidenceClass: clsParam, horizon, limit }) : null;
      return NextResponse.json({
        ok: true,
        authority,
        inventory: analogCorpusInventoryOnDb(db as any),
        evidenceClasses: taxonomy,
        featureVector: describeAnalogFeatureVector(),
        corpus: corpus ? corpusSummary(corpus) : null,
        sampleEpisodeKeys: corpus ? corpus.members.slice(-5).map((m) => m.id) : undefined,
        evaluation: corpus
          ? evaluateAnalogRetrieval(corpus.members, {
              maxQueries: clampInt(url.searchParams.get("maxQueries"), 200, 20, 2000),
            })
          : null,
        latencyMs: Date.now() - started,
        note: "Pass ?episode=<episode_key> for an analog cohort. &evaluate=1 runs the chronological out-of-sample report.",
      });
    }

    const corpus = loadAnalogCorpusOnDb(db as any, { evidenceClass: clsParam, horizon, limit });
    const member = corpus.members.find((m) => m.id === episodeKey);
    if (!member) {
      return NextResponse.json({
        ok: true,
        authority,
        episode: episodeKey,
        evidenceClass: clsParam,
        found: false,
        reason:
          `no ${clsParam} corpus member with episode_key=${episodeKey}` +
          (horizon ? ` at horizon ${horizon}` : "") +
          ". The episode may exist without a label of this class, or its vector may lack a comparability key.",
        corpus: corpusSummary(corpus),
        latencyMs: Date.now() - started,
      });
    }

    const retrieval = retrieveAnalogs(
      { id: member.id, symbol: member.symbol, t0Ms: member.t0Ms, vector: member.vector },
      corpus.members,
      {
        k: clampInt(url.searchParams.get("k"), 30, 1, 200),
        perSymbolCap: clampInt(url.searchParams.get("perSymbolCap"), 5, 1, 50),
      },
    );
    const outcomes = availableOutcomeDistributions({ retrieval, evidenceClass: clsParam });

    const evaluation = url.searchParams.get("evaluate") === "1"
      ? evaluateAnalogRetrieval(corpus.members, { maxQueries: clampInt(url.searchParams.get("maxQueries"), 400, 20, 2000) })
      : null;

    return NextResponse.json({
      ok: true,
      authority,
      episode: {
        episodeKey: member.id,
        symbol: member.symbol,
        t0Ms: member.t0Ms,
        tradingDay: member.tradingDay,
        evidenceClass: member.evidenceClass,
        featureVector: {
          version: member.vector.version,
          values: member.vector.values,
          available: member.vector.available,
          unavailable: member.vector.unavailable,
        },
        realizedOutcome: member.outcome,
      },
      corpus: corpusSummary(corpus),
      retrieval: {
        version: retrieval.retrievalVersion,
        featureVectorVersion: retrieval.featureVectorVersion,
        analogCount: retrieval.retrievedCount,
        eligibleCount: retrieval.eligibleCount,
        labeledCount: retrieval.labeledCount,
        composition: retrieval.composition,
        meanFeatureCoverage: retrieval.meanCoverage,
        exclusions: retrieval.exclusions,
        topAnalogs: retrieval.analogs.slice(0, 20),
      },
      underlyingOutcomes: outcomes.underlying,
      optionOutcomes: outcomes.option,
      refused: outcomes.refused,
      evidenceClassSpec: evidenceClassSpec(clsParam),
      featureVector: describeAnalogFeatureVector(),
      evaluation,
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    return jsonFromRouteError(err, { route: "research/analog" });
  }
}

function corpusSummary(c: { corpusVersion: string; evidenceClass: string; horizon: string | null; members: unknown[]; rowsRead: number; droppedIncomparable: number; censoredCount: number; truncated: boolean; note: string | null }) {
  return {
    version: c.corpusVersion,
    evidenceClass: c.evidenceClass,
    horizon: c.horizon,
    members: c.members.length,
    rowsRead: c.rowsRead,
    droppedIncomparable: c.droppedIncomparable,
    censored: c.censoredCount,
    truncated: c.truncated,
    note: c.note,
  };
}

function clampInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
