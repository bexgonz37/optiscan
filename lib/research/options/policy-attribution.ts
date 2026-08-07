/**
 * Strategy and policy version attribution, frozen at creation.
 *
 * WHY THIS EXISTS
 *
 * Every performance number this system has produced was a POPULATION number. "lower_high
 * continuation PF 0.311" spans seven sessions and at least four deploys, during which the
 * published stop changed, `selectedContract.dte` stopped being hardcoded to 0, and the
 * duplicate-exclusion defect was fixed. Those are different systems sharing a strategy name.
 * Without a version stamped at the moment a case is created, no later analysis can separate
 * "the strategy is bad" from "the strategy was measured across a defect that has since been
 * fixed".
 *
 * THE RULE THAT MATTERS: never infer a historical version from current source.
 *
 * `UNKNOWN_LEGACY_VERSION` is a permanent, honest answer for every row created before this
 * module. Backfilling it from today's constants would assert that old rows ran today's code,
 * which is exactly the false claim that makes attribution worthless. `isLegacyAttribution()`
 * exists so a report can EXCLUDE those rows rather than silently average them in.
 *
 * PURE. No I/O, no clock, no env.
 */

/** Attribution we genuinely do not have. Never invented, never backfilled. */
export const UNKNOWN_LEGACY_VERSION = "UNKNOWN_LEGACY_VERSION";

/**
 * A LIVE row whose deploy could not name its own commit.
 *
 * Distinct from `UNKNOWN_LEGACY_VERSION` on purpose. "This row predates attribution" and
 * "this row was written today by a deploy that lost its git metadata" are different facts with
 * different remedies: the first is permanent history, the second is a fixable deployment
 * problem that must be visible while it is still happening. Collapsing them — which is what
 * `deploymentSha ?? UNKNOWN_LEGACY_VERSION` did — makes a broken deploy look like old data and
 * removes the only signal that would have caught it.
 */
export const RUNTIME_SHA_UNAVAILABLE = "RUNTIME_SHA_UNAVAILABLE";

/**
 * The live policy versions, bumped BY HAND when the corresponding behaviour changes.
 *
 * A version here is a claim that everything stamped with it behaved identically. Bump the
 * value in the same commit that changes the behaviour, or the claim becomes false and every
 * downstream cohort silently merges two systems.
 */
export const POLICY_VERSIONS = Object.freeze({
  /** Strategy catalog semantics — signals, applicability, preferred DTE. */
  strategyVersion: "1",
  /** `selectOptionsStrategy` tie-break + applicability ordering. */
  selectionEngineVersion: "2",
  /** `opportunity-ranking` weighted objective. */
  opportunityRankingVersion: "1",
  /** Contract choice among chain candidates. */
  contractRankingVersion: "1",
  /** `planPartitions` expiry bucketing. */
  dtePlannerVersion: "1",
  /** Entry-quality / freshness / chase re-check at delivery. */
  confirmationPolicyVersion: "1",
  /** Governing stop resolution: risk-model price vs -40% premium band. */
  stopPolicyVersion: "2",
  /** `decideOptionExit` — targets, stop, time stop, expiration handling. */
  exitPolicyVersion: "1",
} as const);

export type PolicyVersionKey = keyof typeof POLICY_VERSIONS;

/**
 * The complete attribution stamped onto a prospective record. Every field is a string so a
 * legacy row and a live row are the same shape and can sit in one column family.
 */
export interface PolicyAttribution {
  strategyId: string;
  strategyVersion: string;
  /** The measurement population this record belongs to, e.g. DELIVERED_ALERT_PAPER. */
  population: string;
  selectionEngineVersion: string;
  opportunityRankingVersion: string;
  contractRankingVersion: string;
  dtePlannerVersion: string;
  confirmationPolicyVersion: string;
  stopPolicyVersion: string;
  exitPolicyVersion: string;
  experimentId: string | null;
  cohortId: string | null;
  deploymentSha: string;
}

export interface AttributionInput {
  strategyId: string | null;
  population: string | null;
  experimentId?: string | null;
  cohortId?: string | null;
  deploymentSha?: string | null;
}

/**
 * Freeze the current policy versions onto a new record. Called ONCE at creation; the result
 * is never recomputed, because recomputing it later would stamp a case with the versions of
 * whatever code happened to be running when the report was generated.
 */
export function freezeAttribution(i: AttributionInput): PolicyAttribution {
  return {
    strategyId: i.strategyId ?? UNKNOWN_LEGACY_VERSION,
    strategyVersion: POLICY_VERSIONS.strategyVersion,
    population: i.population ?? UNKNOWN_LEGACY_VERSION,
    selectionEngineVersion: POLICY_VERSIONS.selectionEngineVersion,
    opportunityRankingVersion: POLICY_VERSIONS.opportunityRankingVersion,
    contractRankingVersion: POLICY_VERSIONS.contractRankingVersion,
    dtePlannerVersion: POLICY_VERSIONS.dtePlannerVersion,
    confirmationPolicyVersion: POLICY_VERSIONS.confirmationPolicyVersion,
    stopPolicyVersion: POLICY_VERSIONS.stopPolicyVersion,
    exitPolicyVersion: POLICY_VERSIONS.exitPolicyVersion,
    experimentId: i.experimentId ?? null,
    cohortId: i.cohortId ?? null,
    // NOT UNKNOWN_LEGACY_VERSION: this row is being created NOW. If the runtime could not name
    // its commit, say exactly that, so a report can separate "old data" from "bad deploy".
    deploymentSha: i.deploymentSha ?? RUNTIME_SHA_UNAVAILABLE,
  };
}

/** The attribution for a row that predates this module. Every version is honestly unknown. */
export function legacyAttribution(strategyId: string | null, population: string | null): PolicyAttribution {
  return {
    strategyId: strategyId ?? UNKNOWN_LEGACY_VERSION,
    strategyVersion: UNKNOWN_LEGACY_VERSION,
    population: population ?? UNKNOWN_LEGACY_VERSION,
    selectionEngineVersion: UNKNOWN_LEGACY_VERSION,
    opportunityRankingVersion: UNKNOWN_LEGACY_VERSION,
    contractRankingVersion: UNKNOWN_LEGACY_VERSION,
    dtePlannerVersion: UNKNOWN_LEGACY_VERSION,
    confirmationPolicyVersion: UNKNOWN_LEGACY_VERSION,
    stopPolicyVersion: UNKNOWN_LEGACY_VERSION,
    exitPolicyVersion: UNKNOWN_LEGACY_VERSION,
    experimentId: null,
    cohortId: null,
    deploymentSha: UNKNOWN_LEGACY_VERSION,
  };
}

/** True when any policy version is unknown — the row cannot support a per-version claim. */
export function isLegacyAttribution(a: Pick<PolicyAttribution, PolicyVersionKey>): boolean {
  return (Object.keys(POLICY_VERSIONS) as PolicyVersionKey[]).some(
    (k) => a[k] === UNKNOWN_LEGACY_VERSION,
  );
}

/**
 * True when the row has live policy versions but no commit identity. Such a row is usable for
 * per-policy analysis and NOT usable for per-deploy analysis, which is a narrower defect than
 * `isLegacyAttribution` and must not be reported as the same thing.
 */
export function isRuntimeShaUnavailable(a: Pick<PolicyAttribution, "deploymentSha">): boolean {
  return a.deploymentSha === RUNTIME_SHA_UNAVAILABLE;
}

export interface ShaAttributionCensus {
  total: number;
  observed: number;
  runtimeUnavailable: number;
  legacy: number;
  distinctShas: string[];
  /** True when at least one row was written by a deploy that could not name its commit. */
  hasDegradedRows: boolean;
}

/**
 * Count how rows are attributed, keeping the three states apart. `runtimeUnavailable > 0` is
 * an operational alarm about the CURRENT deployment path; `legacy > 0` is a permanent property
 * of old data. A census that summed them would say nothing actionable.
 */
export function censusShaAttribution(
  rows: readonly { deploymentSha?: string | null }[],
): ShaAttributionCensus {
  const distinct = new Set<string>();
  let observed = 0, runtimeUnavailable = 0, legacy = 0;
  for (const r of rows) {
    const v = r.deploymentSha ?? null;
    if (v === RUNTIME_SHA_UNAVAILABLE) runtimeUnavailable += 1;
    else if (v === UNKNOWN_LEGACY_VERSION || v == null) legacy += 1;
    else { observed += 1; distinct.add(v); }
  }
  return {
    total: rows.length, observed, runtimeUnavailable, legacy,
    distinctShas: [...distinct].sort(),
    hasDegradedRows: runtimeUnavailable > 0,
  };
}

/** Stable key for grouping outcomes by the exact system that produced them. */
export function attributionKey(a: PolicyAttribution): string {
  return [
    a.strategyId, a.strategyVersion, a.population,
    a.selectionEngineVersion, a.contractRankingVersion,
    a.confirmationPolicyVersion, a.stopPolicyVersion, a.exitPolicyVersion,
  ].join("|");
}
