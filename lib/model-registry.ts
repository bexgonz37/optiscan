/**
 * model-registry.ts — probability-model lifecycle (Phase 4).
 *
 * Assembles a leak-free training set from graded outcomes + frozen fingerprint
 * dimensions + entry-time numerics, enforces conservative ACTIVATION GATES, does
 * temporal (never random) train/holdout evaluation, and promotes a challenger to
 * champion ONLY when it beats the naive base-rate model out of sample and stays
 * calibrated. When the data is insufficient the status is INACTIVE_INSUFFICIENT_DATA
 * and NO probability is emitted (never a placeholder percentage).
 *
 * A model is a calibrated EVIDENCE score for paper/research scoring — it cannot
 * enable live execution, bearish actionability, or change any hard gate.
 *
 * The `*OnDb` core takes a better-sqlite3 handle so it is unit-testable; public
 * wrappers resolve `@/lib/db` lazily.
 */
import { extractFeatures, featureNames, featureCoverage, FEATURE_SCHEMA_VERSION, type FeatureInput } from "./model-features.ts";
import { trainLogistic, predictProba, serializeModel, deserializeModel, defaultLogisticConfig, type LogisticModel } from "./logistic-model.ts";
import { evaluate, chronologicalSplit, type EvaluationMetrics } from "./model-evaluation.ts";

export const MODEL_NAME = "setup-winprob-logit";

export type ModelStatus =
  | "INACTIVE_INSUFFICIENT_DATA"
  | "ACTIVE_CHAMPION";

export interface ActivationThresholds {
  minGraded: number;
  minWins: number;
  minLosses: number;
  minHoldout: number;
  minCoverage: number;
  maxEce: number;
}

export function defaultActivationThresholds(env: NodeJS.ProcessEnv = process.env): ActivationThresholds {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minGraded: n(env.MODEL_MIN_GRADED, 200),
    minWins: n(env.MODEL_MIN_WINS, 40),
    minLosses: n(env.MODEL_MIN_LOSSES, 40),
    minHoldout: n(env.MODEL_MIN_HOLDOUT, 50),
    minCoverage: n(env.MODEL_MIN_COVERAGE, 0.95),
    maxEce: n(env.MODEL_MAX_ECE, 0.15),
  };
}

interface TrainingRow { input: FeatureInput; label: number; coverage: number }

function safeParse(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try { const o = JSON.parse(raw); return o && typeof o === "object" ? o : {}; } catch { return {}; }
}

/** Assemble the chronologically-ordered, leak-free training rows. */
export function trainingRowsOnDb(db: any): TrainingRow[] {
  const rows = db.prepare(
    `SELECT o.grade, o.exit_time_ms, o.strategy, o.direction, o.instrument_type,
            f.dimensions_json AS dims_json,
            p.entry_delta, p.entry_spread_pct, p.rel_vol_entry, p.entry_iv, p.selection_score, p.dte_at_entry
     FROM paper_trade_outcomes o
     LEFT JOIN setup_fingerprints f ON f.fingerprint_id = o.fingerprint_id
     LEFT JOIN paper_trades p ON p.id = o.paper_trade_id
     WHERE o.grading_status='GRADED'
     ORDER BY o.exit_time_ms ASC, o.id ASC`,
  ).all() as any[];
  return rows.map((r) => {
    const d = safeParse(r.dims_json);
    const input: FeatureInput = {
      strategy: r.strategy ?? d.strategy ?? null,
      direction: r.direction ?? d.direction ?? null,
      session: d.session ?? null,
      todBucket: d.todBucket ?? null,
      dteBucket: d.dteBucket ?? null,
      deltaBand: d.deltaBand ?? null,
      spreadBand: d.spreadBand ?? null,
      relVolBucket: d.relVolBucket ?? null,
      vwapState: d.vwapState ?? null,
      moveClassification: d.moveClassification ?? null,
      instrument: r.instrument_type ?? d.instrument ?? null,
      dteAtEntry: r.dte_at_entry ?? null,
      entryDelta: r.entry_delta ?? null,
      entrySpreadPct: r.entry_spread_pct ?? null,
      relVol: r.rel_vol_entry ?? null,
      entryIv: r.entry_iv ?? null,
      selectionScore: r.selection_score ?? null,
    };
    const fv = extractFeatures(input);
    return { input, label: r.grade === "WIN" ? 1 : 0, coverage: featureCoverage(fv) };
  });
}

export interface ActivationReport {
  ok: boolean;
  graded: number;
  wins: number;
  losses: number;
  holdout: number;
  coverage: number;
  reasons: string[];
  required: ActivationThresholds;
}

export function checkActivation(rows: TrainingRow[], t = defaultActivationThresholds()): ActivationReport {
  const graded = rows.length;
  const wins = rows.filter((r) => r.label === 1).length;
  const losses = graded - wins;
  const holdout = Math.floor(graded * 0.2);
  const coverage = graded ? rows.reduce((s, r) => s + r.coverage, 0) / graded : 0;
  const reasons: string[] = [];
  if (graded < t.minGraded) reasons.push(`need ${t.minGraded} graded outcomes (have ${graded})`);
  if (wins < t.minWins) reasons.push(`need ${t.minWins} wins (have ${wins})`);
  if (losses < t.minLosses) reasons.push(`need ${t.minLosses} losses (have ${losses})`);
  if (holdout < t.minHoldout) reasons.push(`need ${t.minHoldout} holdout outcomes (have ${holdout})`);
  if (coverage < t.minCoverage) reasons.push(`need ${Math.round(t.minCoverage * 100)}% feature coverage (have ${Math.round(coverage * 100)}%)`);
  return { ok: reasons.length === 0, graded, wins, losses, holdout, coverage: +coverage.toFixed(4), reasons, required: t };
}

export interface TrainResult {
  status: ModelStatus;
  activation: ActivationReport;
  promoted: boolean;
  modelVersion: number | null;
  holdoutMetrics: EvaluationMetrics | null;
  message: string;
}

function currentChampion(db: any): any | null {
  return db.prepare("SELECT * FROM model_registry WHERE model_name=? AND status='CHAMPION' ORDER BY model_version DESC LIMIT 1").get(MODEL_NAME) ?? null;
}

function nextVersion(db: any): number {
  const r = db.prepare("SELECT COALESCE(MAX(model_version),0) AS m FROM model_registry WHERE model_name=?").get(MODEL_NAME) as any;
  return Number(r?.m ?? 0) + 1;
}

/** Train a challenger, evaluate on a chronological holdout, promote if it wins. */
export function trainAndEvaluateOnDb(db: any, nowMs: number, thresholds = defaultActivationThresholds()): TrainResult {
  const rows = trainingRowsOnDb(db);
  const activation = checkActivation(rows, thresholds);
  if (!activation.ok) {
    return {
      status: "INACTIVE_INSUFFICIENT_DATA",
      activation,
      promoted: false,
      modelVersion: null,
      holdoutMetrics: null,
      message: `Model inactive — insufficient trustworthy outcomes. ${activation.reasons.join("; ")}.`,
    };
  }

  const { train, val, test } = chronologicalSplit(rows, 0.6, 0.2);
  const fit = [...train, ...val];
  const names = featureNames();
  const X = fit.map((r) => extractFeatures(r.input).values);
  const y = fit.map((r) => r.label);
  const model = trainLogistic(X, y, names, FEATURE_SCHEMA_VERSION, defaultLogisticConfig());

  const yTest = test.map((r) => r.label);
  const pTest = test.map((r) => predictProba(model, extractFeatures(r.input).values));
  const metrics = evaluate(yTest, pTest);

  const watermark = Number((db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM paper_trade_outcomes").get() as any)?.m ?? 0);
  const champ = currentChampion(db);
  const champMetrics: EvaluationMetrics | null = champ?.metrics_json ? safeParse(champ.metrics_json) as any : null;

  // Promotion gates: beats naive base-rate, calibrated, and (vs champion) no worse.
  const beatsBaseRate = metrics.brier != null && metrics.baseRateBrier != null && metrics.brier < metrics.baseRateBrier;
  const calibrated = metrics.ece != null && metrics.ece <= thresholds.maxEce;
  const bothClasses = metrics.bothClassesPresent;
  const improvesChampion = !champMetrics || (metrics.brier != null && champMetrics.brier != null
    && metrics.brier < champMetrics.brier - 1e-6
    && (metrics.logLoss == null || champMetrics.logLoss == null || metrics.logLoss <= champMetrics.logLoss + 1e-6));

  const promote = beatsBaseRate && calibrated && bothClasses && improvesChampion;

  const version = nextVersion(db);
  const status = promote ? "CHAMPION" : "REJECTED";
  const info = db.prepare(
    `INSERT INTO model_registry
       (model_name, model_version, feature_schema_version, status, config_json, model_json, metrics_json,
        training_watermark, n_train, base_rate, trained_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    MODEL_NAME, version, FEATURE_SCHEMA_VERSION, status,
    JSON.stringify(model.config), serializeModel(model), JSON.stringify(metrics),
    watermark, model.nTrain, model.baseRate, nowMs,
  );
  db.prepare("INSERT INTO model_evaluations (model_registry_id, eval_kind, metrics_json, created_at_ms) VALUES (?,?,?,?)")
    .run(Number(info.lastInsertRowid), "holdout", JSON.stringify(metrics), nowMs);

  if (promote && champ) {
    // Demote the previous champion (kept for rollback, never deleted).
    db.prepare("UPDATE model_registry SET status='RETIRED' WHERE id=?").run(champ.id);
  }

  return {
    status: promote ? "ACTIVE_CHAMPION" : "INACTIVE_INSUFFICIENT_DATA",
    activation,
    promoted: promote,
    modelVersion: version,
    holdoutMetrics: metrics,
    message: promote
      ? `Challenger v${version} promoted to champion (Brier ${metrics.brier} < base ${metrics.baseRateBrier}, ECE ${metrics.ece}).`
      : `Challenger v${version} rejected — did not beat the base-rate/calibration/champion gates. Model remains inactive.`,
  };
}

export interface ModelStatusReport {
  status: ModelStatus;
  modelName: string;
  championVersion: number | null;
  featureSchemaVersion: number;
  metrics: EvaluationMetrics | null;
  trainedAtMs: number | null;
  message: string;
}

export function modelStatusOnDb(db: any): ModelStatusReport {
  const champ = currentChampion(db);
  if (!champ) {
    return {
      status: "INACTIVE_INSUFFICIENT_DATA",
      modelName: MODEL_NAME,
      championVersion: null,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      metrics: null,
      trainedAtMs: null,
      message: "Model inactive — no champion. Insufficient trustworthy outcomes to train and validate one.",
    };
  }
  return {
    status: "ACTIVE_CHAMPION",
    modelName: MODEL_NAME,
    championVersion: champ.model_version,
    featureSchemaVersion: champ.feature_schema_version,
    metrics: champ.metrics_json ? safeParse(champ.metrics_json) as any : null,
    trainedAtMs: champ.trained_at_ms,
    message: `Champion v${champ.model_version} active for paper/research scoring only.`,
  };
}

/**
 * Predict for one setup — ONLY when a validated champion exists. Returns null
 * (⇒ "Model inactive") otherwise; never a placeholder or a heuristic dressed up
 * as a probability. Never authorizes a trade.
 */
export function predictForOnDb(db: any, input: FeatureInput): { proba: number | null; modelVersion: number | null; status: ModelStatus } {
  const champ = currentChampion(db);
  if (!champ) return { proba: null, modelVersion: null, status: "INACTIVE_INSUFFICIENT_DATA" };
  let model: LogisticModel;
  try { model = deserializeModel(champ.model_json); } catch { return { proba: null, modelVersion: null, status: "INACTIVE_INSUFFICIENT_DATA" }; }
  if (model.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
    // Feature schema moved under the model ⇒ do not emit a stale-schema probability.
    return { proba: null, modelVersion: champ.model_version, status: "INACTIVE_INSUFFICIENT_DATA" };
  }
  const proba = predictProba(model, extractFeatures(input).values);
  return { proba: +proba.toFixed(4), modelVersion: champ.model_version, status: "ACTIVE_CHAMPION" };
}

// ── Public wrappers (lazy @/lib/db) ──────────────────────────────────────────

function lazyDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

export function trainAndEvaluate(nowMs: number = Date.now()): TrainResult {
  try { return trainAndEvaluateOnDb(lazyDb(), nowMs); } catch (err: any) {
    return { status: "INACTIVE_INSUFFICIENT_DATA", activation: checkActivation([]), promoted: false, modelVersion: null, holdoutMetrics: null, message: `training unavailable: ${err?.message}` };
  }
}

export function modelStatus(): ModelStatusReport {
  try { return modelStatusOnDb(lazyDb()); } catch (err: any) {
    return { status: "INACTIVE_INSUFFICIENT_DATA", modelName: MODEL_NAME, championVersion: null, featureSchemaVersion: FEATURE_SCHEMA_VERSION, metrics: null, trainedAtMs: null, message: `status unavailable: ${err?.message}` };
  }
}

export function predictFor(input: FeatureInput): { proba: number | null; modelVersion: number | null; status: ModelStatus } {
  try { return predictForOnDb(lazyDb(), input); } catch { return { proba: null, modelVersion: null, status: "INACTIVE_INSUFFICIENT_DATA" }; }
}
