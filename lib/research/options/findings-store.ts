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
