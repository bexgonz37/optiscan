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
    deploymentSha: i.deploymentSha ?? UNKNOWN_LEGACY_VERSION,
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

/** Stable key for grouping outcomes by the exact system that produced them. */
export function attributionKey(a: PolicyAttribution): string {
  return [
    a.strategyId, a.strategyVersion, a.population,
    a.selectionEngineVersion, a.contractRankingVersion,
    a.confirmationPolicyVersion, a.stopPolicyVersion, a.exitPolicyVersion,
  ].join("|");
}
