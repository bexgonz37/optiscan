/**
 * Runs the measurement → classification → readiness pipeline over real stored outcomes.
 *
 * This is the thing that turns "expectancy -7.2% across everything" into a per-version
 * verdict that can actually be acted on, and then records that verdict as a readiness
 * state. Zero provider calls; reads the paper-trade store and writes only readiness rows.
 *
 * It can DEMOTE on its own. It can never promote to SUBSCRIBER_APPROVED — see
 * strategy-readiness.ts for why that boundary is enforced in code rather than by habit.
 */
import {
  BY_STRATEGY_VERSION,
  DEFAULT_CLASSIFICATION,
  segmentAndClassify,
  type ClassificationConfig,
  type SegmentReport,
} from "./strategy-performance.ts";
import { loadOutcomeRowsOnDb, type PerfDb } from "./strategy-performance-loader.ts";
import {
  autoAssessOnDb,
  listReadinessOnDb,
  readinessSchemaReady,
  type AutoAssessResult,
  type ReadinessDb,
  type ReadinessRecord,
} from "./strategy-readiness.ts";

export interface AssessmentInput {
  nowMs: number;
  deploymentSha?: string | null;
  sinceMs?: number | null;
  /** Which paper lanes count. Defaults to the delivered subscriber mirror + research. */
  lanes?: string[] | null;
  config?: ClassificationConfig;
  /** When false, compute and report but write nothing. */
  persist?: boolean;
}

export interface AssessmentResult {
  ok: boolean;
  schemaReady: boolean;
  outcomesLoaded: number;
  segments: SegmentReport[];
  applied: AutoAssessResult[];
  quarantined: string[];
  readiness: ReadinessRecord[];
  note: string;
}

export function runReadinessAssessment(
  db: (PerfDb & ReadinessDb) | null,
  input: AssessmentInput,
): AssessmentResult {
  const empty: AssessmentResult = {
    ok: false, schemaReady: false, outcomesLoaded: 0,
    segments: [], applied: [], quarantined: [], readiness: [],
    note: "no database handle",
  };
  if (!db) return empty;

  const schemaReady = readinessSchemaReady(db);
  const rows = loadOutcomeRowsOnDb(db, {
    sinceMs: input.sinceMs ?? null,
    lanes: input.lanes ?? null,
    limit: 20_000,
  });

  const segments = segmentAndClassify(
    rows,
    BY_STRATEGY_VERSION,
    input.config ?? DEFAULT_CLASSIFICATION,
  );

  const applied: AutoAssessResult[] = [];
  const quarantined: string[] = [];
  if (schemaReady && input.persist !== false) {
    for (const s of segments) {
      // "unknown" strategy is the bucket for rows with no attribution at all; assessing it
      // would create a readiness row for a strategy that does not exist.
      if (!s.key.strategy || s.key.strategy === "unknown" || s.key.strategy === "*") continue;
      const r = autoAssessOnDb(db, {
        strategy: s.key.strategy,
        strategyVersion: s.key.strategyVersion === "*" ? "1" : s.key.strategyVersion,
        classification: s.classification,
        rationale: s.rationale,
        metrics: s.metrics,
        deploymentSha: input.deploymentSha ?? null,
        nowMs: input.nowMs,
      });
      applied.push(r);
      if (r.quarantined) quarantined.push(`${r.strategy}@${r.strategyVersion}`);
    }
  }

  return {
    ok: true,
    schemaReady,
    outcomesLoaded: rows.length,
    segments,
    applied,
    quarantined,
    readiness: schemaReady ? listReadinessOnDb(db) : [],
    note: schemaReady
      ? "Readiness reflects measured executable outcomes. SUBSCRIBER_APPROVED is unreachable automatically."
      : "Readiness schema unavailable; measurement reported but nothing persisted.",
  };
}
