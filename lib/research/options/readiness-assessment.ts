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
  setReadinessOnDb,
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

export interface GoverningSegment {
  strategy: string;
  strategyVersion: string;
  classification: SegmentReport["classification"];
  rationale: string;
  metrics: SegmentReport["metrics"];
  /** True when the only evidence comes from a lane subscribers never see. */
  researchOnlyEvidence: boolean;
}

const DELIVERED_LANE = "DELIVERED_ALERT_PAPER";

/**
 * Collapse per-lane segments to ONE governing verdict per strategy/version.
 *
 * This exists because of a real defect the first production run exposed. Readiness is
 * keyed on strategy@version, but segmentation is per LANE, so two rows collided and the
 * last write won. Measured on production evidence, the same strategies perform wildly
 * differently by lane:
 *
 *     pullback_continuation   delivered -35.7%  |  research  +0.50%   (36.2pp gap)
 *     momentum_acceleration   delivered -33.2%  |  research +16.74%   (49.9pp gap)
 *     reversal_bounce         delivered -32.9%  |  research  +6.49%   (39.4pp gap)
 *     lower_high_continuation delivered -27.8%  |  research +35.99%   (63.8pp gap)
 *
 * The research row was overwriting the delivered row, which promoted
 * pullback_continuation to SUBSCRIBER_CANDIDATE while it was losing 35.7% on the alerts
 * subscribers actually received. Exactly backwards.
 *
 * DELIVERED_ALERT_PAPER is the subscriber's real experience and therefore governs. Where
 * both lanes exist and disagree, the WORSE verdict is taken: a strategy is not rehabilitated
 * by performing better somewhere nobody is trading it.
 */
export function governingSegments(segments: SegmentReport[]): GoverningSegment[] {
  const byKey = new Map<string, SegmentReport[]>();
  for (const s of segments) {
    const strategy = s.key.strategy;
    if (!strategy || strategy === "unknown" || strategy === "*") continue;
    const version = s.key.strategyVersion === "*" ? "1" : s.key.strategyVersion;
    const k = `${strategy}@${version}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(s);
  }

  const severity: Record<string, number> = {
    NEGATIVE_EXPECTANCY: 0, DEGRADED: 1, DATA_CONTAMINATED: 2, INSUFFICIENT_EVIDENCE: 3,
    UNPROVEN: 4, PROMISING_INSUFFICIENT_SAMPLE: 5, FORWARD_VALIDATED: 6,
  };

  const out: GoverningSegment[] = [];
  for (const [k, group] of byKey) {
    const [strategy, strategyVersion] = k.split("@");
    const delivered = group.filter((s) => s.key.lane === DELIVERED_LANE);
    // Prefer the delivered lane; among candidates take the least favourable verdict.
    const pool = delivered.length ? delivered : group;
    const worst = pool.reduce((a, b) =>
      (severity[a.classification] ?? 9) <= (severity[b.classification] ?? 9) ? a : b);
    out.push({
      strategy,
      strategyVersion,
      classification: worst.classification,
      rationale: delivered.length
        ? `${worst.rationale} [governed by ${DELIVERED_LANE}]`
        : `${worst.rationale} [research-lane evidence only]`,
      metrics: worst.metrics,
      researchOnlyEvidence: delivered.length === 0,
    });
  }
  return out;
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
    for (const g of governingSegments(segments)) {
      const r = autoAssessOnDb(db, {
        strategy: g.strategy,
        strategyVersion: g.strategyVersion,
        classification: g.classification,
        rationale: g.rationale,
        metrics: g.metrics,
        deploymentSha: input.deploymentSha ?? null,
        nowMs: input.nowMs,
      });
      // Research evidence describes a lane subscribers never see. It can inform, and it
      // can demote, but it must not carry a strategy toward subscriber standing.
      const capped = g.researchOnlyEvidence && r.appliedState === "SUBSCRIBER_CANDIDATE";
      if (capped) {
        setReadinessOnDb(db, {
          strategy: g.strategy,
          strategyVersion: g.strategyVersion,
          state: "PAPER_VALIDATION",
          reason: `research-lane evidence only — capped below subscriber candidacy; ${g.rationale}`,
          classification: g.classification,
          metrics: g.metrics,
          actor: "system:auto-assess",
          deploymentSha: input.deploymentSha ?? null,
          nowMs: input.nowMs,
        });
        applied.push({ ...r, appliedState: "PAPER_VALIDATION", reason: `capped: research-lane evidence only` });
      } else {
        applied.push(r);
      }
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
