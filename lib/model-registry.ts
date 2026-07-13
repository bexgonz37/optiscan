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
import type { ModelStateName, ExperimentalMeta } from "./model-experimental.ts";

export const MODEL_NAME = "setup-winprob-logit";

export type ModelStatus =
  | "INACTIVE_INSUFFICIENT_DATA"
  | "ACTIVE_CHAMPION";

/** Phase 8: the three explicit, user-facing model states. */
export type { ModelStateName } from "./model-experimental.ts";

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

/** Phase 8: relaxed EXPERIMENTAL thresholds (research-only, never production). */
export function defaultExperimentalThresholds(env: NodeJS.ProcessEnv = process.env): ActivationThresholds {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minGraded: n(env.MODEL_EXP_MIN_GRADED, 30),
    minWins: n(env.MODEL_EXP_MIN_WINS, 8),
    minLosses: n(env.MODEL_EXP_MIN_LOSSES, 8),
    minHoldout: n(env.MODEL_EXP_MIN_HOLDOUT, 10),
    minCoverage: n(env.MODEL_EXP_MIN_COVERAGE, 0.9),
    maxEce: n(env.MODEL_EXP_MAX_ECE, 0.25),
  };
}

export type ModelTier = "VALIDATED" | "EXPERIMENTAL" | "NONE";

/** Decide the highest tier the current data can support. */
export function checkActivationTier(
  rows: TrainingRow[],
  validated = defaultActivationThresholds(),
  experimental = defaultExperimentalThresholds(),
): { tier: ModelTier; validated: ActivationReport; experimental: ActivationReport } {
  const v = checkActivation(rows, validated);
  const e = checkActivation(rows, experimental);
  const tier: ModelTier = v.ok ? "VALIDATED" : e.ok ? "EXPERIMENTAL" : "NONE";
  return { tier, validated: v, experimental: e };
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
  state: ModelStateName;
  tier: ModelTier;
  activation: ActivationReport;
  promoted: boolean;
  modelVersion: number | null;
  holdoutMetrics: EvaluationMetrics | null;
  message: string;
}

/** Latest VALIDATED (production) champion, if any. */
function currentChampion(db: any): any | null {
  return db.prepare("SELECT * FROM model_registry WHERE model_name=? AND status='CHAMPION' ORDER BY model_version DESC LIMIT 1").get(MODEL_NAME) ?? null;
}

/** Latest EXPERIMENTAL (research-only) champion, if any. */
function currentExperimentalChampion(db: any): any | null {
  return db.prepare("SELECT * FROM model_registry WHERE model_name=? AND status='EXPERIMENTAL_CHAMPION' ORDER BY model_version DESC LIMIT 1").get(MODEL_NAME) ?? null;
}

/**
 * The active model row and its tier. A VALIDATED champion always supersedes an
 * EXPERIMENTAL one; if only an experimental champion exists we serve it but flag
 * it research-only; otherwise there is no active model.
 */
function activeModel(db: any): { row: any; tier: ModelTier } | null {
  const validated = currentChampion(db);
  if (validated) return { row: validated, tier: "VALIDATED" };
  const experimental = currentExperimentalChampion(db);
  if (experimental) return { row: experimental, tier: "EXPERIMENTAL" };
  return null;
}

function nextVersion(db: any): number {
  const r = db.prepare("SELECT COALESCE(MAX(model_version),0) AS m FROM model_registry WHERE model_name=?").get(MODEL_NAME) as any;
  return Number(r?.m ?? 0) + 1;
}

/** Map an internal tier + champion presence to the three user-facing states. */
function stateFor(tier: ModelTier | null): ModelStateName {
  if (tier === "VALIDATED") return "ACTIVE_VALIDATED";
  if (tier === "EXPERIMENTAL") return "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY";
  return "INACTIVE_NO_TRAINABLE_DATA";
}

/**
 * Train a challenger, evaluate on a chronological holdout, promote if it wins.
 *
 * Two promotion tracks (Phase 8):
 *   • VALIDATED tier (strict thresholds) → status CHAMPION. This is the only
 *     tier whose probabilities are treated as validated.
 *   • EXPERIMENTAL tier (relaxed thresholds, real two-class data) → status
 *     EXPERIMENTAL_CHAMPION. Research-only: it never displaces a validated
 *     champion, never creates ACTIONABLE, never bypasses a gate.
 * Neither track can enable bearish actionability or live execution.
 */
export interface TierOverrides {
  validated?: ActivationThresholds;
  experimental?: ActivationThresholds;
}

export function trainAndEvaluateOnDb(db: any, nowMs: number, overrides: TierOverrides = {}): TrainResult {
  const rows = trainingRowsOnDb(db);
  const validatedThresholds = overrides.validated ?? defaultActivationThresholds();
  const experimentalThresholds = overrides.experimental ?? defaultExperimentalThresholds();
  const tierReport = checkActivationTier(rows, validatedThresholds, experimentalThresholds);
  const tier = tierReport.tier;

  if (tier === "NONE") {
    return {
      status: "INACTIVE_INSUFFICIENT_DATA",
      state: "INACTIVE_NO_TRAINABLE_DATA",
      tier,
      activation: tierReport.validated,
      promoted: false,
      modelVersion: null,
      holdoutMetrics: null,
      message: `Model inactive — no trainable data. ${tierReport.experimental.reasons.join("; ")}.`,
    };
  }

  const isValidatedTier = tier === "VALIDATED";
  const thresholds = isValidatedTier ? validatedThresholds : experimentalThresholds;
  const activation = isValidatedTier ? tierReport.validated : tierReport.experimental;

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
  const prior = isValidatedTier ? currentChampion(db) : currentExperimentalChampion(db);
  const priorMetrics: EvaluationMetrics | null = prior?.metrics_json ? safeParse(prior.metrics_json) as any : null;

  // Promotion gates: beats naive base-rate, calibrated (tier-appropriate ECE
  // ceiling), both classes present out of sample, and improves on the prior
  // champion of the SAME tier.
  const beatsBaseRate = metrics.brier != null && metrics.baseRateBrier != null && metrics.brier < metrics.baseRateBrier;
  const calibrated = metrics.ece != null && metrics.ece <= thresholds.maxEce;
  const bothClasses = metrics.bothClassesPresent;
  const improvesPrior = !priorMetrics || (metrics.brier != null && priorMetrics.brier != null
    && metrics.brier < priorMetrics.brier - 1e-6
    && (metrics.logLoss == null || priorMetrics.logLoss == null || metrics.logLoss <= priorMetrics.logLoss + 1e-6));

  const promote = beatsBaseRate && calibrated && bothClasses && improvesPrior;

  const version = nextVersion(db);
  const promotedStatus = isValidatedTier ? "CHAMPION" : "EXPERIMENTAL_CHAMPION";
  const status = promote ? promotedStatus : "REJECTED";
  const dbTier = isValidatedTier ? "VALIDATED" : "EXPERIMENTAL";
  const info = db.prepare(
    `INSERT INTO model_registry
       (model_name, model_version, feature_schema_version, status, tier, config_json, model_json, metrics_json,
        training_watermark, n_train, base_rate, trained_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    MODEL_NAME, version, FEATURE_SCHEMA_VERSION, status, dbTier,
    JSON.stringify(model.config), serializeModel(model), JSON.stringify(metrics),
    watermark, model.nTrain, model.baseRate, nowMs,
  );
  db.prepare("INSERT INTO model_evaluations (model_registry_id, eval_kind, metrics_json, created_at_ms) VALUES (?,?,?,?)")
    .run(Number(info.lastInsertRowid), "holdout", JSON.stringify(metrics), nowMs);

  if (promote) {
    if (prior) {
      // Retire the prior champion of this tier (kept for rollback, never deleted).
      db.prepare("UPDATE model_registry SET status='RETIRED' WHERE id=?").run(prior.id);
    }
    if (isValidatedTier) {
      // A validated champion supersedes any standing experimental champion.
      db.prepare("UPDATE model_registry SET status='RETIRED' WHERE model_name=? AND status='EXPERIMENTAL_CHAMPION'").run(MODEL_NAME);
    }
  }

  const promotedState = stateFor(promote ? tier : (activeModel(db)?.tier ?? null));

  return {
    status: promote && isValidatedTier ? "ACTIVE_CHAMPION" : "INACTIVE_INSUFFICIENT_DATA",
    state: promotedState,
    tier,
    activation,
    promoted: promote,
    modelVersion: version,
    holdoutMetrics: metrics,
    message: promote
      ? `Challenger v${version} promoted to ${isValidatedTier ? "validated champion" : "experimental champion (RESEARCH ONLY)"} (Brier ${metrics.brier} < base ${metrics.baseRateBrier}, ECE ${metrics.ece}).`
      : `Challenger v${version} rejected — did not beat the base-rate/calibration/prior gates. Model remains ${activeModel(db) ? "on the previous champion" : "inactive"}.`,
  };
}

export interface ModelStatusReport {
  status: ModelStatus;
  state: ModelStateName;
  tier: ModelTier;
  modelName: string;
  championVersion: number | null;
  featureSchemaVersion: number;
  metrics: EvaluationMetrics | null;
  trainedAtMs: number | null;
  experimental: ExperimentalMeta | null;
  message: string;
}

/** Build ExperimentalMeta from live rows + the active champion row. */
function buildExperimentalMeta(db: any, rows: TrainingRow[], row: any | null): ExperimentalMeta {
  const validated = checkActivation(rows, defaultActivationThresholds());
  const metrics: EvaluationMetrics | null = row?.metrics_json ? safeParse(row.metrics_json) as any : null;
  return {
    trainingSample: validated.graded,
    wins: validated.wins,
    losses: validated.losses,
    holdout: validated.holdout,
    modelVersion: row?.model_version ?? null,
    brier: metrics?.brier ?? null,
    ece: metrics?.ece ?? null,
    coverage: +validated.coverage.toFixed(4),
    reasonNotValidated: validated.ok ? null : validated.reasons.join("; "),
  };
}

export function modelStatusOnDb(db: any): ModelStatusReport {
  const rows = trainingRowsOnDb(db);
  const active = activeModel(db);
  if (!active) {
    return {
      status: "INACTIVE_INSUFFICIENT_DATA",
      state: "INACTIVE_NO_TRAINABLE_DATA",
      tier: "NONE",
      modelName: MODEL_NAME,
      championVersion: null,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      metrics: null,
      trainedAtMs: null,
      experimental: buildExperimentalMeta(db, rows, null),
      message: "Model inactive — no champion. Insufficient trustworthy outcomes to train and validate one.",
    };
  }
  const { row, tier } = active;
  const state = stateFor(tier);
  return {
    status: tier === "VALIDATED" ? "ACTIVE_CHAMPION" : "INACTIVE_INSUFFICIENT_DATA",
    state,
    tier,
    modelName: MODEL_NAME,
    championVersion: row.model_version,
    featureSchemaVersion: row.feature_schema_version,
    metrics: row.metrics_json ? safeParse(row.metrics_json) as any : null,
    trainedAtMs: row.trained_at_ms,
    experimental: buildExperimentalMeta(db, rows, row),
    message: tier === "VALIDATED"
      ? `Validated champion v${row.model_version} active for paper/research scoring only.`
      : `Experimental champion v${row.model_version} — EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY. Not a validated probability.`,
  };
}

export interface PredictResult {
  proba: number | null;
  modelVersion: number | null;
  status: ModelStatus;
  state: ModelStateName;
  tier: ModelTier;
  experimental: boolean;
}

/**
 * Predict for one setup — ONLY when a champion (validated or experimental)
 * exists. Returns null proba (⇒ "Model inactive") otherwise; never a placeholder
 * or a heuristic dressed up as a probability. An experimental prediction is
 * flagged research-only and never authorizes a trade or bypasses any gate.
 */
export function predictForOnDb(db: any, input: FeatureInput): PredictResult {
  const inactive: PredictResult = { proba: null, modelVersion: null, status: "INACTIVE_INSUFFICIENT_DATA", state: "INACTIVE_NO_TRAINABLE_DATA", tier: "NONE", experimental: false };
  const active = activeModel(db);
  if (!active) return inactive;
  const { row, tier } = active;
  let model: LogisticModel;
  try { model = deserializeModel(row.model_json); } catch { return inactive; }
  if (model.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
    // Feature schema moved under the model ⇒ do not emit a stale-schema probability.
    return { ...inactive, modelVersion: row.model_version };
  }
  const proba = predictProba(model, extractFeatures(input).values);
  const isValidated = tier === "VALIDATED";
  return {
    proba: +proba.toFixed(4),
    modelVersion: row.model_version,
    status: isValidated ? "ACTIVE_CHAMPION" : "INACTIVE_INSUFFICIENT_DATA",
    state: stateFor(tier),
    tier,
    experimental: !isValidated,
  };
}

// ── Public wrappers (lazy @/lib/db) ──────────────────────────────────────────

function lazyDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

export function trainAndEvaluate(nowMs: number = Date.now()): TrainResult {
  try { return trainAndEvaluateOnDb(lazyDb(), nowMs); } catch (err: any) {
    return { status: "INACTIVE_INSUFFICIENT_DATA", state: "INACTIVE_NO_TRAINABLE_DATA", tier: "NONE", activation: checkActivation([]), promoted: false, modelVersion: null, holdoutMetrics: null, message: `training unavailable: ${err?.message}` };
  }
}

export function modelStatus(): ModelStatusReport {
  try { return modelStatusOnDb(lazyDb()); } catch (err: any) {
    return { status: "INACTIVE_INSUFFICIENT_DATA", state: "INACTIVE_NO_TRAINABLE_DATA", tier: "NONE", modelName: MODEL_NAME, championVersion: null, featureSchemaVersion: FEATURE_SCHEMA_VERSION, metrics: null, trainedAtMs: null, experimental: null, message: `status unavailable: ${err?.message}` };
  }
}

export function predictFor(input: FeatureInput): PredictResult {
  try { return predictForOnDb(lazyDb(), input); } catch { return { proba: null, modelVersion: null, status: "INACTIVE_INSUFFICIENT_DATA", state: "INACTIVE_NO_TRAINABLE_DATA", tier: "NONE", experimental: false }; }
}
