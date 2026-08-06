/**
 * Deterministic readiness state for every strategy/version, and the authority that
 * moves it.
 *
 * WHY THIS EXISTS
 *
 * Subscriber eligibility was IMPLIED: a strategy reached subscribers because it happened
 * to win selection and clear a quality bar, not because anything had ever established it
 * was worth sending. The audited population (expectancy -7.2%, profit factor 0.49) is what
 * that produces. Readiness is now explicit, persisted, and required.
 *
 * THE AUTHORITY BOUNDARY
 *
 * This module can DEMOTE automatically — protecting subscribers is allowed to be
 * automatic. It can never PROMOTE to a subscriber-facing state automatically:
 * `SUBSCRIBER_APPROVED` is reachable only through `recordHumanApproval`, which requires a
 * named human actor. Evidence can make a version a CANDIDATE; only a person can approve it.
 */
import type {
  SegmentMetrics,
  StrategyClassification,
} from "./strategy-performance.ts";
import { isQuarantined } from "./strategy-performance.ts";

export type ReadinessState =
  | "RESEARCH_ONLY"
  | "SHADOW"
  | "PAPER_VALIDATION"
  | "OWNER_WATCH"
  | "OWNER_ACTIONABLE"
  | "SUBSCRIBER_CANDIDATE"
  | "SUBSCRIBER_APPROVED"
  | "DEMOTED";

/** The ONLY state that authorises a subscriber-style opening alert. */
export const SUBSCRIBER_AUTHORISED: ReadinessState = "SUBSCRIBER_APPROVED";

export function maySendSubscriberOpening(state: ReadinessState | null | undefined): boolean {
  return state === SUBSCRIBER_AUTHORISED;
}

export interface ReadinessDb {
  prepare(sql: string): {
    get(...a: unknown[]): unknown;
    all(...a: unknown[]): unknown[];
    run(...a: unknown[]): { changes?: number };
  };
}

export interface ReadinessRecord {
  strategy: string;
  strategyVersion: string;
  state: ReadinessState;
  classification: StrategyClassification | null;
  reason: string;
  sampleSize: number | null;
  expectancyPct: number | null;
  profitFactor: number | null;
  evidenceSnapshotJson: string | null;
  actor: string;
  deploymentSha: string | null;
  updatedAtMs: number;
}

export interface ReadinessTransition {
  strategy: string;
  strategyVersion: string;
  priorState: ReadinessState | null;
  newState: ReadinessState;
  reason: string;
  classification: StrategyClassification | null;
  sampleSize: number | null;
  metricsJson: string | null;
  evidenceSnapshotJson: string | null;
  actor: string;
  deploymentSha: string | null;
  atMs: number;
}

function hasTable(db: ReadinessDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export function readinessSchemaReady(db: ReadinessDb): boolean {
  return hasTable(db, "strategy_readiness_state") && hasTable(db, "strategy_readiness_transitions");
}

const KEY = (strategy: string, version: string) => `${strategy}@${version}`;

export function readReadinessOnDb(
  db: ReadinessDb,
  strategy: string,
  strategyVersion: string,
): ReadinessRecord | null {
  if (!readinessSchemaReady(db)) return null;
  try {
    const r = db.prepare(
      `SELECT strategy, strategy_version, state, classification, reason, sample_size,
              expectancy_pct, profit_factor, evidence_snapshot_json, actor, deployment_sha, updated_at_ms
         FROM strategy_readiness_state WHERE strategy_key=?`,
    ).get(KEY(strategy, strategyVersion)) as any;
    if (!r) return null;
    return {
      strategy: String(r.strategy),
      strategyVersion: String(r.strategy_version),
      state: String(r.state) as ReadinessState,
      classification: r.classification == null ? null : String(r.classification) as StrategyClassification,
      reason: String(r.reason ?? ""),
      sampleSize: r.sample_size == null ? null : Number(r.sample_size),
      expectancyPct: r.expectancy_pct == null ? null : Number(r.expectancy_pct),
      profitFactor: r.profit_factor == null ? null : Number(r.profit_factor),
      evidenceSnapshotJson: r.evidence_snapshot_json == null ? null : String(r.evidence_snapshot_json),
      actor: String(r.actor ?? "system"),
      deploymentSha: r.deployment_sha == null ? null : String(r.deployment_sha),
      updatedAtMs: Number(r.updated_at_ms ?? 0),
    };
  } catch {
    return null;
  }
}

export function listReadinessOnDb(db: ReadinessDb): ReadinessRecord[] {
  if (!readinessSchemaReady(db)) return [];
  try {
    const rows = db.prepare(
      `SELECT strategy, strategy_version, state, classification, reason, sample_size,
              expectancy_pct, profit_factor, evidence_snapshot_json, actor, deployment_sha, updated_at_ms
         FROM strategy_readiness_state ORDER BY strategy, strategy_version`,
    ).all() as any[];
    return rows.map((r) => ({
      strategy: String(r.strategy),
      strategyVersion: String(r.strategy_version),
      state: String(r.state) as ReadinessState,
      classification: r.classification == null ? null : String(r.classification) as StrategyClassification,
      reason: String(r.reason ?? ""),
      sampleSize: r.sample_size == null ? null : Number(r.sample_size),
      expectancyPct: r.expectancy_pct == null ? null : Number(r.expectancy_pct),
      profitFactor: r.profit_factor == null ? null : Number(r.profit_factor),
      evidenceSnapshotJson: r.evidence_snapshot_json == null ? null : String(r.evidence_snapshot_json),
      actor: String(r.actor ?? "system"),
      deploymentSha: r.deployment_sha == null ? null : String(r.deployment_sha),
      updatedAtMs: Number(r.updated_at_ms ?? 0),
    }));
  } catch {
    return [];
  }
}

/**
 * The DEFAULT state for anything never assessed.
 *
 * Deliberately RESEARCH_ONLY, not SHADOW: a strategy nobody has measured has not earned
 * even shadow standing, and — critically — an unknown strategy must never be treated as
 * subscriber-eligible by omission. Absence of a record is absence of permission.
 */
export const DEFAULT_READINESS_STATE: ReadinessState = "RESEARCH_ONLY";

export function effectiveReadinessState(record: ReadinessRecord | null): ReadinessState {
  return record?.state ?? DEFAULT_READINESS_STATE;
}

function writeTransition(db: ReadinessDb, t: ReadinessTransition): void {
  db.prepare(
    `INSERT INTO strategy_readiness_transitions
       (strategy_key, strategy, strategy_version, prior_state, new_state, reason, classification,
        sample_size, metrics_json, evidence_snapshot_json, actor, deployment_sha, at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    KEY(t.strategy, t.strategyVersion), t.strategy, t.strategyVersion,
    t.priorState, t.newState, t.reason, t.classification,
    t.sampleSize, t.metricsJson, t.evidenceSnapshotJson, t.actor, t.deploymentSha, t.atMs,
  );
}

export interface SetReadinessInput {
  strategy: string;
  strategyVersion: string;
  state: ReadinessState;
  reason: string;
  classification?: StrategyClassification | null;
  metrics?: SegmentMetrics | null;
  evidenceSnapshot?: unknown;
  actor: string;
  deploymentSha?: string | null;
  nowMs: number;
}

/**
 * Persist a state and its transition. Every promotion and demotion is journalled with the
 * evidence that motivated it, so a later reader can audit not just WHAT changed but on
 * what basis.
 */
export function setReadinessOnDb(
  db: ReadinessDb,
  input: SetReadinessInput,
): { ok: boolean; priorState: ReadinessState | null; newState: ReadinessState; reason: string } {
  if (!readinessSchemaReady(db)) {
    return { ok: false, priorState: null, newState: input.state, reason: "READINESS_SCHEMA_UNAVAILABLE" };
  }
  const prior = readReadinessOnDb(db, input.strategy, input.strategyVersion);
  const priorState = prior?.state ?? null;
  const metricsJson = input.metrics ? JSON.stringify(input.metrics) : null;
  const evidenceJson = input.evidenceSnapshot === undefined ? null : JSON.stringify(input.evidenceSnapshot);
  try {
    db.prepare(
      `INSERT INTO strategy_readiness_state
         (strategy_key, strategy, strategy_version, state, classification, reason, sample_size,
          expectancy_pct, profit_factor, evidence_snapshot_json, actor, deployment_sha,
          created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(strategy_key) DO UPDATE SET
         state=excluded.state, classification=excluded.classification, reason=excluded.reason,
         sample_size=excluded.sample_size, expectancy_pct=excluded.expectancy_pct,
         profit_factor=excluded.profit_factor, evidence_snapshot_json=excluded.evidence_snapshot_json,
         actor=excluded.actor, deployment_sha=excluded.deployment_sha, updated_at_ms=excluded.updated_at_ms`,
    ).run(
      KEY(input.strategy, input.strategyVersion), input.strategy, input.strategyVersion,
      input.state, input.classification ?? null, input.reason,
      input.metrics?.pricedSampleSize ?? null,
      input.metrics?.expectancyPct ?? null,
      input.metrics?.profitFactor ?? null,
      evidenceJson, input.actor, input.deploymentSha ?? null,
      input.nowMs, input.nowMs,
    );
    writeTransition(db, {
      strategy: input.strategy,
      strategyVersion: input.strategyVersion,
      priorState,
      newState: input.state,
      reason: input.reason,
      classification: input.classification ?? null,
      sampleSize: input.metrics?.pricedSampleSize ?? null,
      metricsJson,
      evidenceSnapshotJson: evidenceJson,
      actor: input.actor,
      deploymentSha: input.deploymentSha ?? null,
      atMs: input.nowMs,
    });
    return { ok: true, priorState, newState: input.state, reason: input.reason };
  } catch (err: any) {
    return {
      ok: false,
      priorState,
      newState: input.state,
      reason: `READINESS_WRITE_FAILED:${String(err?.message ?? err).slice(0, 120)}`,
    };
  }
}

/**
 * The state a classification maps to when the machine acts on its own.
 *
 * Note what is NOT here: nothing maps to SUBSCRIBER_APPROVED. The best an automatic
 * assessment can do is make something a CANDIDATE.
 */
export function autoStateForClassification(c: StrategyClassification): ReadinessState {
  switch (c) {
    case "NEGATIVE_EXPECTANCY": return "DEMOTED";
    case "DEGRADED": return "DEMOTED";
    case "DATA_CONTAMINATED": return "RESEARCH_ONLY";
    case "INSUFFICIENT_EVIDENCE": return "RESEARCH_ONLY";
    case "UNPROVEN": return "SHADOW";
    case "PROMISING_INSUFFICIENT_SAMPLE": return "PAPER_VALIDATION";
    case "FORWARD_VALIDATED": return "SUBSCRIBER_CANDIDATE";
    default: return "RESEARCH_ONLY";
  }
}

export interface AutoAssessInput {
  strategy: string;
  strategyVersion: string;
  classification: StrategyClassification;
  rationale: string;
  metrics: SegmentMetrics;
  deploymentSha?: string | null;
  nowMs: number;
}

export interface AutoAssessResult {
  strategy: string;
  strategyVersion: string;
  priorState: ReadinessState;
  proposedState: ReadinessState;
  appliedState: ReadinessState;
  applied: boolean;
  quarantined: boolean;
  reason: string;
}

/**
 * Apply an automatic assessment.
 *
 * Two rules keep this safe:
 *   1. It never writes SUBSCRIBER_APPROVED, whatever the evidence says.
 *   2. It never downgrades a human's SUBSCRIBER_APPROVED except into DEMOTED, and only
 *      when the classification is genuinely bad. A merely thin sample must not silently
 *      revoke an approval a person made deliberately.
 */
export function autoAssessOnDb(
  db: ReadinessDb,
  input: AutoAssessInput,
): AutoAssessResult {
  const prior = readReadinessOnDb(db, input.strategy, input.strategyVersion);
  const priorState = effectiveReadinessState(prior);
  const proposed = autoStateForClassification(input.classification);
  const quarantined = isQuarantined(input.classification);

  let appliedState = proposed;
  let apply = true;
  let reason = `auto:${input.classification} — ${input.rationale}`;

  if (priorState === "SUBSCRIBER_APPROVED") {
    if (quarantined) {
      appliedState = "DEMOTED";
      reason = `auto-demotion from SUBSCRIBER_APPROVED: ${input.classification} — ${input.rationale}`;
    } else {
      // Evidence that is not actively bad does not overturn a human decision.
      apply = false;
      appliedState = priorState;
      reason = `human approval retained; ${input.classification} is not a demotion trigger — ${input.rationale}`;
    }
  }

  if (apply) {
    const w = setReadinessOnDb(db, {
      strategy: input.strategy,
      strategyVersion: input.strategyVersion,
      state: appliedState,
      reason,
      classification: input.classification,
      metrics: input.metrics,
      evidenceSnapshot: { classification: input.classification, rationale: input.rationale, metrics: input.metrics },
      actor: "system:auto-assess",
      deploymentSha: input.deploymentSha ?? null,
      nowMs: input.nowMs,
    });
    if (!w.ok) {
      return {
        strategy: input.strategy, strategyVersion: input.strategyVersion,
        priorState, proposedState: proposed, appliedState: priorState,
        applied: false, quarantined, reason: w.reason,
      };
    }
  }

  return {
    strategy: input.strategy, strategyVersion: input.strategyVersion,
    priorState, proposedState: proposed, appliedState,
    applied: apply, quarantined, reason,
  };
}

/**
 * The ONLY route to SUBSCRIBER_APPROVED. Requires a named human actor — an empty or
 * system-looking actor is refused, so the audit trail cannot be forged by omission.
 */
export function recordHumanApproval(
  db: ReadinessDb,
  input: {
    strategy: string;
    strategyVersion: string;
    actor: string;
    reason: string;
    evidenceSnapshot?: unknown;
    deploymentSha?: string | null;
    nowMs: number;
  },
): { ok: boolean; reason: string } {
  const actor = String(input.actor ?? "").trim();
  if (!actor || /^system\b/i.test(actor)) {
    return { ok: false, reason: "HUMAN_APPROVAL_REQUIRES_NAMED_ACTOR" };
  }
  if (!String(input.reason ?? "").trim()) {
    return { ok: false, reason: "HUMAN_APPROVAL_REQUIRES_REASON" };
  }
  const w = setReadinessOnDb(db, {
    strategy: input.strategy,
    strategyVersion: input.strategyVersion,
    state: "SUBSCRIBER_APPROVED",
    reason: `human approval by ${actor}: ${input.reason}`,
    classification: null,
    metrics: null,
    evidenceSnapshot: input.evidenceSnapshot,
    actor,
    deploymentSha: input.deploymentSha ?? null,
    nowMs: input.nowMs,
  });
  return { ok: w.ok, reason: w.reason };
}

/**
 * The gate the delivery path calls.
 *
 * Fails CLOSED: no schema, no record, or an unreadable state all deny. A strategy is
 * subscriber-eligible only when something affirmatively says so.
 */
export function subscriberEligibility(
  db: ReadinessDb | null,
  strategy: string,
  strategyVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): { allowed: boolean; state: ReadinessState; reasonCode: string; enforced: boolean } {
  // The gate is enforcing by default. `shadow` reports without blocking so the refusal
  // rate can be measured before it changes what subscribers receive.
  const mode = String(env.STRATEGY_READINESS_MODE ?? "").trim().toLowerCase();
  const enforced = mode !== "shadow" && mode !== "off";
  if (!db) {
    return { allowed: !enforced, state: DEFAULT_READINESS_STATE, reasonCode: "READINESS_NO_DB", enforced };
  }
  if (!readinessSchemaReady(db)) {
    return { allowed: !enforced, state: DEFAULT_READINESS_STATE, reasonCode: "READINESS_SCHEMA_UNAVAILABLE", enforced };
  }
  const record = readReadinessOnDb(db, strategy, strategyVersion);
  const state = effectiveReadinessState(record);
  const allowed = maySendSubscriberOpening(state);
  return {
    allowed: allowed || !enforced,
    state,
    reasonCode: allowed ? "SUBSCRIBER_APPROVED" : `NOT_SUBSCRIBER_APPROVED:${state}`,
    enforced,
  };
}
