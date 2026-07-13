/**
 * learning-store.ts — the bounded, auditable continuous-learning loop (Phase 7).
 *
 * Reuses the Phase-4 registry for training/evaluation and the pure Phase-7 policy
 * + drift modules. It NEVER changes source code, thresholds, risk limits, sizing,
 * entry/exit rules, sessions, bearish status, or execution permissions — it only
 * gates a bounded retrain, records every attempt, monitors drift, and flags a
 * degraded champion warning-only (rollback preserved; hard gates never bypassed).
 *
 * The `*OnDb` core takes a better-sqlite3 handle so it is unit-testable; public
 * wrappers resolve `@/lib/db` lazily.
 */
import { shouldRetrain, defaultRetrainPolicy, type RetrainPolicy } from "./learning/retrain-policy.ts";
import { classifyDrift, isDegraded, defaultDriftThresholds, type DriftInputs, type DriftThresholds } from "./learning/drift.ts";
import {
  trainingRowsOnDb, trainAndEvaluateOnDb, modelStatusOnDb, MODEL_NAME,
} from "./model-registry.ts";
import { extractFeatures, featureCoverage } from "./model-features.ts";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function num(db: any, sql: string, ...p: unknown[]): number {
  try { return Number((db.prepare(sql).get(...p) as any)?.n ?? 0); } catch { return 0; }
}

function safeParse(raw: string | null | undefined): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Frequencies from the recent decision log (best-effort; null when unavailable). */
function pipelineFrequencies(db: any): { staleFreq: number | null; rejectFreq: number | null } {
  try {
    const total = num(db, "SELECT COUNT(*) AS n FROM (SELECT id FROM paper_decisions ORDER BY id DESC LIMIT 200)");
    if (!total) return { staleFreq: null, rejectFreq: null };
    const stale = num(db, "SELECT COUNT(*) AS n FROM (SELECT id, decision FROM paper_decisions ORDER BY id DESC LIMIT 200) WHERE decision='data_stale_refused'");
    const reject = num(db, "SELECT COUNT(*) AS n FROM (SELECT id, decision FROM paper_decisions ORDER BY id DESC LIMIT 200) WHERE decision='entry_rejected'");
    return { staleFreq: stale / total, rejectFreq: reject / total };
  } catch {
    return { staleFreq: null, rejectFreq: null };
  }
}

export interface LearningCycleResult {
  retrained: boolean;
  retrainDecision: { retrain: boolean; reasons: string[] };
  trainResult: any | null;
  driftState: string;
  driftReasons: string[];
  championHealth: string | null;
  watermark: number;
  newGraded: number;
}

/** Run ONE bounded learning cycle: decide retrain, train if allowed, monitor drift. */
export function runLearningCycleOnDb(
  db: any,
  nowMs: number,
  opts: { policy?: RetrainPolicy; thresholds?: DriftThresholds } = {},
): LearningCycleResult {
  const policy = opts.policy ?? defaultRetrainPolicy();
  const thresholds = opts.thresholds ?? defaultDriftThresholds();

  const rows = trainingRowsOnDb(db);
  const wins = rows.filter((r) => r.label === 1).length;
  const losses = rows.length - wins;
  const coverage = rows.length ? rows.reduce((s, r) => s + r.coverage, 0) / rows.length : 0;
  const currentWatermark = num(db, "SELECT COALESCE(MAX(id),0) AS n FROM paper_trade_outcomes");

  const lastRun: any = db.prepare("SELECT * FROM learning_runs WHERE kind IN ('PROMOTION','REJECTION') ORDER BY id DESC LIMIT 1").get();
  const lastTrainedWatermark = Number(lastRun?.watermark ?? 0);
  const lastAttemptMs = lastRun?.created_at_ms ?? null;
  const newGraded = num(db, "SELECT COUNT(*) AS n FROM paper_trade_outcomes WHERE id > ? AND grading_status='GRADED'", lastTrainedWatermark);

  const retrainDecision = shouldRetrain(
    { currentWatermark, lastTrainedWatermark, lastAttemptMs, newGradedSinceWatermark: newGraded, wins, losses, coverage, nowMs },
    policy,
  );

  let trainResult: any | null = null;
  let retrained = false;
  if (retrainDecision.retrain) {
    trainResult = trainAndEvaluateOnDb(db, nowMs);
    retrained = true;
    db.prepare("INSERT INTO learning_runs (kind, watermark, new_graded, decision_json, result_json, created_at_ms) VALUES (?,?,?,?,?,?)")
      .run(trainResult.promoted ? "PROMOTION" : "REJECTION", currentWatermark, newGraded, JSON.stringify(retrainDecision), JSON.stringify(trainResult), nowMs);
  } else {
    db.prepare("INSERT INTO learning_runs (kind, watermark, new_graded, decision_json, created_at_ms) VALUES (?,?,?,?,?)")
      .run("SKIPPED", currentWatermark, newGraded, JSON.stringify(retrainDecision), nowMs);
  }

  // ── Drift monitoring ──
  const champ: any = db.prepare(`SELECT * FROM model_registry WHERE model_name=? AND status='CHAMPION' ORDER BY model_version DESC LIMIT 1`).get(MODEL_NAME);
  const prevChamp: any = db.prepare(`SELECT * FROM model_registry WHERE model_name=? AND status='RETIRED' ORDER BY model_version DESC LIMIT 1`).get(MODEL_NAME);
  const curM = safeParse(champ?.metrics_json);
  const baseM = safeParse(prevChamp?.metrics_json);
  const freqs = pipelineFrequencies(db);

  const driftInputs: DriftInputs = {
    gradedSample: rows.length,
    coverage: rows.length ? coverage : null,
    staleDataFreq: freqs.staleFreq,
    contractRejectFreq: freqs.rejectFreq,
    modelAgeMs: champ?.trained_at_ms ? nowMs - Number(champ.trained_at_ms) : null,
    baseWinRate: baseM?.baseRate ?? null,
    curWinRate: curM?.confusion?.accuracy ?? null,
    baseBrier: baseM?.brier ?? null,
    curBrier: curM?.brier ?? null,
    baseEce: baseM?.ece ?? null,
    curEce: curM?.ece ?? null,
  };
  const drift = classifyDrift(driftInputs, thresholds);
  db.prepare("INSERT INTO drift_snapshots (drift_state, metrics_json, reasons_json, created_at_ms) VALUES (?,?,?,?)")
    .run(drift.state, JSON.stringify(driftInputs), JSON.stringify(drift.reasons), nowMs);

  let championHealth: string | null = null;
  if (champ) {
    championHealth = isDegraded(drift.state) ? "WARNING" : "HEALTHY";
    db.prepare("UPDATE model_registry SET health=? WHERE id=?").run(championHealth, champ.id);
  }

  return {
    retrained,
    retrainDecision,
    trainResult,
    driftState: drift.state,
    driftReasons: drift.reasons,
    championHealth,
    watermark: currentWatermark,
    newGraded,
  };
}

/** Deterministic, human-reviewable recommendations (never auto-applied). */
export function recommendationsOnDb(db: any): string[] {
  const recs: string[] = [];
  const graded = num(db, "SELECT COUNT(*) AS n FROM paper_trade_outcomes WHERE grading_status='GRADED'");
  const ungradable = num(db, "SELECT COUNT(*) AS n FROM paper_trade_outcomes WHERE grading_status='UNGRADABLE'");
  if (graded < 200) recs.push(`Collect more graded outcomes — ${graded}/200 toward a validated model.`);
  if (ungradable > 0 && ungradable >= graded * 0.05) recs.push(`Investigate data quality — ${ungradable} ungradable outcomes.`);
  const latestDrift: any = db.prepare("SELECT drift_state FROM drift_snapshots ORDER BY id DESC LIMIT 1").get();
  if (latestDrift?.drift_state === "MODEL_STALE") recs.push("Champion is stale — review and retrain when data allows.");
  if (latestDrift?.drift_state === "PERFORMANCE_DRIFT" || latestDrift?.drift_state === "DEGRADED") recs.push("Model performance/calibration degraded — treat probabilities as warning-only pending human review.");
  if (!recs.length) recs.push("No action required. Continue collecting authoritative outcomes.");
  return recs;
}

export interface LearningStatus {
  modelStatus: any;
  latestDrift: { state: string; reasons: string[]; atMs: number } | null;
  recentRuns: any[];
  counts: { graded: number; ungradable: number; outcomes: number };
  recommendations: string[];
}

export function learningStatusOnDb(db: any): LearningStatus {
  const modelStatus = modelStatusOnDb(db);
  const dr: any = db.prepare("SELECT * FROM drift_snapshots ORDER BY id DESC LIMIT 1").get();
  const runs = db.prepare("SELECT id, kind, watermark, new_graded, drift_state, created_at_ms FROM learning_runs ORDER BY id DESC LIMIT 20").all();
  return {
    modelStatus,
    latestDrift: dr ? { state: dr.drift_state, reasons: safeParse(dr.reasons_json) ?? [], atMs: dr.created_at_ms } : null,
    recentRuns: runs,
    counts: {
      graded: num(db, "SELECT COUNT(*) AS n FROM paper_trade_outcomes WHERE grading_status='GRADED'"),
      ungradable: num(db, "SELECT COUNT(*) AS n FROM paper_trade_outcomes WHERE grading_status='UNGRADABLE'"),
      outcomes: num(db, "SELECT COUNT(*) AS n FROM paper_trade_outcomes"),
    },
    recommendations: recommendationsOnDb(db),
  };
}

// ── Public wrappers ──────────────────────────────────────────────────────────

function lazyDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

export function runLearningCycle(nowMs: number = Date.now()): LearningCycleResult {
  try { return runLearningCycleOnDb(lazyDb(), nowMs); }
  catch (err: any) {
    return { retrained: false, retrainDecision: { retrain: false, reasons: [`unavailable: ${err?.message}`] }, trainResult: null, driftState: "INSUFFICIENT_DATA", driftReasons: [], championHealth: null, watermark: 0, newGraded: 0 };
  }
}

export function learningStatus(): LearningStatus {
  try { return learningStatusOnDb(lazyDb()); }
  catch (err: any) {
    return { modelStatus: { status: "INACTIVE_INSUFFICIENT_DATA", message: `unavailable: ${err?.message}` }, latestDrift: null, recentRuns: [], counts: { graded: 0, ungradable: 0, outcomes: 0 }, recommendations: ["Learning status unavailable."] };
  }
}
