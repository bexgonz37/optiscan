/**
 * Persistence for Evidence Learning findings.
 *
 * A finding is UPSERTED by `finding_id`: the claim is stable, the numbers behind it are not,
 * so re-running the nightly refreshes the metrics without minting a duplicate claim. What
 * cannot be dropped in an update is `limitations_json` — the column is NOT NULL and the writer
 * refuses an empty array, because the failure mode this whole module exists to prevent is a
 * number surviving into a summary after its qualification was lost.
 *
 * Impure (SQLite), testable OnDb core.
 */

import { LHC_FINDINGS, type LearningFinding } from "./lhc-findings.ts";
import { COHORT_ID, COHORT_STRATEGY } from "./lower-high-cohort.ts";
import { POLICY_VERSIONS } from "./policy-attribution.ts";

export interface FindingsDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
}

const j = (v: unknown): string => JSON.stringify(v ?? null);

function hasTable(db: FindingsDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch { return false; }
}

/**
 * Write one finding. Throws on an empty `limitations` — that is a programming error, not a
 * data condition, and silently accepting it would let an unqualified claim reach the AI.
 */
export function upsertFindingOnDb(
  db: FindingsDb,
  f: LearningFinding,
  ctx: { deploymentSha?: string | null } = {},
  nowMs: number = Date.now(),
): { written: boolean; created: boolean } {
  if (!f.limitations.length) {
    throw new Error(`finding ${f.findingId} has no limitations; refusing to persist an unqualified claim`);
  }
  if (!hasTable(db, "options_learning_findings")) return { written: false, created: false };

  const existing = db.prepare("SELECT 1 FROM options_learning_findings WHERE finding_id=?").get(f.findingId);
  db.prepare(
    `INSERT INTO options_learning_findings
       (finding_id, strategy, strategy_version, population, evidence_cohort_id, sessions_json,
        sample_size, title, statement, baseline_metric_json, experimental_metric_json,
        evidence_strength, limitations_json, affected_opportunity_ids_json, recommended_experiment,
        experiment_id, experiment_status, must_not_be_summarized_as, deployment_sha,
        created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(finding_id) DO UPDATE SET
       strategy_version=excluded.strategy_version,
       sessions_json=excluded.sessions_json,
       sample_size=excluded.sample_size,
       statement=excluded.statement,
       baseline_metric_json=excluded.baseline_metric_json,
       experimental_metric_json=excluded.experimental_metric_json,
       evidence_strength=excluded.evidence_strength,
       limitations_json=excluded.limitations_json,
       affected_opportunity_ids_json=excluded.affected_opportunity_ids_json,
       experiment_status=excluded.experiment_status,
       must_not_be_summarized_as=excluded.must_not_be_summarized_as,
       deployment_sha=excluded.deployment_sha,
       updated_at_ms=excluded.updated_at_ms`,
  ).run(
    f.findingId, f.strategy, f.strategyVersion, f.population, f.evidenceCohortId, j(f.sessions),
    f.sampleSize, f.title, f.statement, j(f.baselineMetric), j(f.experimentalMetric),
    f.evidenceStrength, j(f.limitations), j(f.affectedOpportunityIds), f.recommendedExperiment,
    f.experimentId, f.experimentStatus, f.mustNotBeSummarizedAs, ctx.deploymentSha ?? null,
    nowMs, nowMs,
  );
  return { written: true, created: !existing };
}

/** Persist the frozen LHC findings. Idempotent; safe to run every night. */
export function seedLhcFindingsOnDb(
  db: FindingsDb,
  ctx: { deploymentSha?: string | null } = {},
  nowMs: number = Date.now(),
): { written: number; created: number } {
  let written = 0, created = 0;
  for (const f of LHC_FINDINGS) {
    try {
      const r = upsertFindingOnDb(db, f, ctx, nowMs);
      if (r.written) written += 1;
      if (r.created) created += 1;
    } catch { /* isolated per finding */ }
  }
  return { written, created };
}

/**
 * The namespace every AI-authored finding lives in.
 *
 * Deterministic findings (`LHC_…`) are the frozen record of an investigation; an AI conclusion is
 * an interpretation of a session. They share a table because the next night's context reads one
 * list, and they must never share an id — an AI finding that could overwrite
 * `LHC_SELECT_V1_TAIL_DEPENDENCE` could delete the sentence that keeps the experiment honest.
 */
export const AI_FINDING_PREFIX = "AI_NIGHTLY_";

export interface AiFindingInput {
  /** Stable slug for a recurring conclusion. Namespaced here, never by the caller. */
  key: string;
  sessionDate: string;
  title: string;
  statement: string;
  question: string;
  evidenceStrength: LearningFinding["evidenceStrength"];
  sampleSize: number;
  limitations: readonly string[];
  mustNotBeSummarizedAs: string | null;
  recommendedExperiment: string | null;
}

/**
 * Persist one AI-authored finding under the reserved namespace.
 *
 * Refuses an empty `limitations` (inherited from `upsertFindingOnDb`) and refuses any id that
 * would land outside the namespace. The id deliberately excludes the session date: a conclusion
 * the model reaches on three consecutive nights is ONE standing claim whose numbers move, not
 * three claims — the same reason the deterministic findings upsert.
 */
export function upsertAiFindingOnDb(
  db: FindingsDb,
  f: AiFindingInput,
  ctx: { deploymentSha?: string | null } = {},
  nowMs: number = Date.now(),
): { written: boolean; created: boolean; findingId: string } {
  const slug = String(f.key ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
  if (!slug) throw new Error("AI finding has no usable key");
  const findingId = `${AI_FINDING_PREFIX}${slug}`;
  if (!findingId.startsWith(AI_FINDING_PREFIX)) throw new Error(`refusing to write ${findingId} outside the AI namespace`);

  const r = upsertFindingOnDb(db, {
    findingId,
    strategy: COHORT_STRATEGY,
    // The AI reasons about the CURRENT system, so the live version is the honest stamp — but the
    // deploy that produced it is carried separately and may be RUNTIME_SHA_UNAVAILABLE.
    strategyVersion: POLICY_VERSIONS.strategyVersion,
    population: "DELIVERED_ALERT_PAPER",
    evidenceCohortId: COHORT_ID,
    sessions: [f.sessionDate],
    sampleSize: Math.max(0, Math.floor(f.sampleSize)),
    title: f.title,
    statement: f.statement,
    baselineMetric: null,
    experimentalMetric: null,
    evidenceStrength: f.evidenceStrength,
    limitations: [
      ...f.limitations,
      // Appended, never substituted: the provenance of the claim is itself a limitation.
      `AI-authored interpretation of the ${f.sessionDate} session, answering: ${f.question}. It is not a deterministic measurement.`,
    ],
    affectedOpportunityIds: [],
    recommendedExperiment: f.recommendedExperiment,
    experimentId: null,
    experimentStatus: null,
    mustNotBeSummarizedAs: f.mustNotBeSummarizedAs,
  }, ctx, nowMs);
  return { ...r, findingId };
}

export interface StoredFinding extends LearningFinding {
  deploymentSha: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

const parse = (s: unknown, fallback: any): any => {
  if (typeof s !== "string") return fallback;
  try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
};

export function listFindingsOnDb(
  db: FindingsDb,
  opts: { strategy?: string; limit?: number } = {},
): StoredFinding[] {
  if (!hasTable(db, "options_learning_findings")) return [];
  const sql = `SELECT * FROM options_learning_findings${opts.strategy ? " WHERE strategy=?" : ""}
               ORDER BY updated_at_ms DESC LIMIT ${Math.max(1, Math.min(opts.limit ?? 100, 500))}`;
  const args = opts.strategy ? [opts.strategy] : [];
  return (db.prepare(sql).all(...args) as any[]).map((r) => ({
    findingId: r.finding_id,
    strategy: r.strategy,
    strategyVersion: r.strategy_version,
    population: r.population,
    evidenceCohortId: r.evidence_cohort_id,
    sessions: parse(r.sessions_json, []),
    sampleSize: r.sample_size,
    title: r.title,
    statement: r.statement,
    baselineMetric: parse(r.baseline_metric_json, null),
    experimentalMetric: parse(r.experimental_metric_json, null),
    evidenceStrength: r.evidence_strength,
    limitations: parse(r.limitations_json, []),
    affectedOpportunityIds: parse(r.affected_opportunity_ids_json, []),
    recommendedExperiment: r.recommended_experiment ?? null,
    experimentId: r.experiment_id ?? null,
    experimentStatus: r.experiment_status ?? null,
    mustNotBeSummarizedAs: r.must_not_be_summarized_as ?? null,
    deploymentSha: r.deployment_sha ?? null,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
  }));
}

/**
 * Compact rendering for an AI prompt. Every finding carries its limitations and its banned
 * summary — the whole point is that the model cannot receive the number without the caveat.
 */
export function findingsForPrompt(findings: readonly LearningFinding[]): string {
  return findings.map((f) => [
    `FINDING ${f.findingId} [${f.evidenceStrength}, n=${f.sampleSize}]`,
    `  ${f.title}`,
    `  ${f.statement}`,
    `  LIMITATIONS: ${f.limitations.join(" | ")}`,
    f.mustNotBeSummarizedAs ? `  MUST NOT BE SUMMARIZED AS: ${f.mustNotBeSummarizedAs}` : null,
  ].filter(Boolean).join("\n")).join("\n\n");
}
