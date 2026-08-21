import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";
import { intParam } from "@/lib/query-params";

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
 *   ?breadth=1               per-symbol/session/horizon corpus breadth + the durable bar store
 *   ?vectorVersion=...       force a feature-vector version (a corpus is single-version)
 *   ?limit=20000             corpus read cap
 *
 * POST /api/research/analog?action=seed-from-store widens the corpus from bars this
 * database ALREADY HOLDS. It issues no provider request and spends nothing. It is a DRY RUN
 * unless `commit=1` is passed, and nothing schedules it — see `local-replay.ts`.
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
    const { loadAnalogCorpusOnDb, analogCorpusInventoryOnDb, analogCorpusBreadthOnDb } =
      await import("@/lib/research/analog/corpus.ts");
    const { describeAnalogFeatureVector } = await import("@/lib/research/analog/feature-vector.ts");
    const { describeAnalogFeatureVectorV2 } = await import("@/lib/research/analog/feature-vector-v2.ts");
    const { knownVectorVersions } = await import("@/lib/research/analog/comparability.ts");
    const { storedBarInventoryOnDb } = await import("@/lib/research/analog/local-replay.ts");
    const { BASELINE_SPECS } = await import("@/lib/research/analog/baselines.ts");
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
    const limit = intParam(url.searchParams, "limit", 20_000, 100, 50_000);
    const episodeKey = url.searchParams.get("episode");
    // Omitted means "the version this class is stored in" — see corpus.ts. It is a
    // parameter rather than a constant because a corpus is single-version by design.
    const vectorVersion = url.searchParams.get("vectorVersion") ?? undefined;
    const loadOpts = { evidenceClass: clsParam, horizon, limit, vectorVersion };

    const taxonomy = ALL_EVIDENCE_CLASSES.map((c) => evidenceClassSpec(c));

    // ── inventory / corpus-level evaluation (no query episode) ───────────────
    if (!episodeKey) {
      const wantEval = url.searchParams.get("evaluate") === "1";
      // The evaluation is a corpus-level question ("does retrieval predict anything?"),
      // not an episode-level one, so it must be answerable without naming an episode.
      const wantBreadth = url.searchParams.get("breadth") === "1";
      const corpus = wantEval ? loadAnalogCorpusOnDb(db as any, loadOpts) : null;
      return NextResponse.json({
        ok: true,
        authority,
        inventory: analogCorpusInventoryOnDb(db as any),
        // Per-symbol / per-session / per-horizon breadth, plus the durable bar store that
        // can widen it without a provider call. Off by default: both are aggregate scans.
        breadth: wantBreadth ? analogCorpusBreadthOnDb(db as any, { evidenceClass: clsParam }) : null,
        storedBars: wantBreadth ? storedBarInventoryOnDb(db as any) : null,
        evidenceClasses: taxonomy,
        featureVector: describeAnalogFeatureVector(),
        featureVectorV2: describeAnalogFeatureVectorV2(),
        vectorVersions: knownVectorVersions(),
        baselines: BASELINE_SPECS,
        corpus: corpus ? corpusSummary(corpus) : null,
        sampleEpisodeKeys: corpus ? corpus.members.slice(-5).map((m) => m.id) : undefined,
        evaluation: corpus
          ? evaluateAnalogRetrieval(corpus.members, {
              maxQueries: intParam(url.searchParams, "maxQueries", 200, 20, 2000),
            })
          : null,
        latencyMs: Date.now() - started,
        note: "Pass ?episode=<episode_key> for an analog cohort. &evaluate=1 runs the chronological out-of-sample report.",
      });
    }

    const corpus = loadAnalogCorpusOnDb(db as any, loadOpts);
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
        k: intParam(url.searchParams, "k", 30, 1, 200),
        perSymbolCap: intParam(url.searchParams, "perSymbolCap", 5, 1, 50),
      },
    );
    const outcomes = availableOutcomeDistributions({ retrieval, evidenceClass: clsParam });

    const evaluation = url.searchParams.get("evaluate") === "1"
      ? evaluateAnalogRetrieval(corpus.members, { maxQueries: intParam(url.searchParams, "maxQueries", 400, 20, 2000) })
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

function corpusSummary(c: {
  corpusVersion: string; evidenceClass: string; horizon: string | null; vectorVersion: string;
  members: unknown[]; rowsRead: number; droppedIncomparable: number; droppedByVectorVersion: number;
  droppedUnusableTimestamps: number; censoredCount: number; truncated: boolean; note: string | null;
}) {
  return {
    version: c.corpusVersion,
    evidenceClass: c.evidenceClass,
    horizon: c.horizon,
    featureVectorVersion: c.vectorVersion,
    members: c.members.length,
    rowsRead: c.rowsRead,
    droppedIncomparable: c.droppedIncomparable,
    droppedByVectorVersion: c.droppedByVectorVersion,
    droppedUnusableTimestamps: c.droppedUnusableTimestamps,
    censored: c.censoredCount,
    truncated: c.truncated,
    note: c.note,
  };
}

/**
 * POST /api/research/analog?action=seed-from-store
 *
 * Replay `historical_underlying_bars` into the canonical episode + label tables through the
 * SAME `seedEpisodesPure` the provider-backed lane uses. Zero provider calls, zero spend,
 * idempotent (deterministic `episode_key` + INSERT OR IGNORE), and nothing on the live path
 * calls it — it exists to be invoked deliberately.
 *
 *   ?commit=1        actually write. Omitted ⇒ DRY RUN, which is the default on purpose.
 *   ?symbols=A,B     restrict the symbol set
 *   ?timeframe=1m    bar granularity; the seeder's windows are BAR COUNTS, so this matters
 *   ?maxSymbols=50   bound per invocation
 *
 * This does not change any evidence class. Rows written here are HISTORICAL_UNDERLYING_ONLY,
 * exactly like the rest of the replay corpus, and there is no option leg in this source.
 */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const started = Date.now();
    const action = url.searchParams.get("action");
    if (action !== "seed-from-store") {
      return NextResponse.json(
        { ok: false, error: `unknown action ${String(action)}`, actions: ["seed-from-store"] },
        { status: 400 },
      );
    }
    const { getDb } = await import("@/lib/db");
    const { seedAnalogCorpusFromStoreOnDb, storedBarInventoryOnDb } =
      await import("@/lib/research/analog/local-replay.ts");
    const db = getDb();
    const symbolsParam = url.searchParams.get("symbols");
    const result = seedAnalogCorpusFromStoreOnDb(db as any, {
      symbols: symbolsParam ? symbolsParam.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      timeframe: url.searchParams.get("timeframe") ?? "1m",
      dryRun: url.searchParams.get("commit") !== "1",
      maxSymbols: intParam(url.searchParams, "maxSymbols", 50, 1, 100),
      maxBarsPerSymbol: intParam(url.searchParams, "maxBars", 50_000, 100, 200_000),
    });
    return NextResponse.json({
      ok: true,
      authority: {
        mode: "RESEARCH_ONLY",
        calibration: "NOT_CALIBRATED_FOR_LIVE_AUTHORITY",
        note:
          "Widens the research corpus only. It changes no threshold, no contract selection, no delivery " +
          "eligibility and no subscriber state, and it issues no provider request.",
      },
      storedBars: storedBarInventoryOnDb(db as any),
      result,
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    return jsonFromRouteError(err, { route: "research/analog:seed-from-store" });
  }
}
