/**
 * What the FIRST real RTH session must prove about the prospective arm — checked against what
 * is actually persisted, not against what the code is supposed to do.
 *
 * WHY THIS IS NOT A TEST FILE
 *
 * Every invariant here is already covered by unit tests. Unit tests prove the code is capable
 * of writing the row; they cannot prove that the deployed process, against the live schema,
 * with real market inputs, actually did. The gap between those two is where this system has
 * lost evidence before: the confirmation columns existed and were degenerate, the paper mirror
 * existed and missed four rows, the SHA column existed and one deploy wrote null into it.
 *
 * THE RULE THAT MAKES THIS USEFUL: a check with no rows to inspect reports NOT_YET_OBSERVED,
 * never PASS. A readiness board that goes green on an empty table is worse than no board — it
 * is the same failure as reporting `PF 0` when the truth is `PF unavailable`.
 *
 * PURE. Takes persisted rows and reports; touches no database, clock, env or provider.
 */

import { HINDSIGHT_DENYLIST } from "./pre-entry-features.ts";
import { RUNTIME_SHA_UNAVAILABLE, UNKNOWN_LEGACY_VERSION } from "./policy-attribution.ts";
import { LHC_SELECT_V1 } from "./experiment-registry.ts";
import type { ShadowDecisionRow } from "./shadow-arm-store.ts";

/**
 * PASS            the rows exist and satisfy the invariant
 * FAIL            the rows exist and violate it — the session's evidence is compromised
 * NOT_YET_OBSERVED no row has exercised this yet; nothing is claimed either way
 */
export type ReadinessState = "PASS" | "FAIL" | "NOT_YET_OBSERVED";

export interface ReadinessCheck {
  id: string;
  /** What the first session has to demonstrate, in one sentence. */
  requirement: string;
  state: ReadinessState;
  /** How many rows the check could actually inspect. Zero means nothing was proven. */
  observed: number;
  detail: string;
  /** Decision keys that violated the invariant, capped so a diagnostic stays readable. */
  offenders: string[];
}

export interface FirstRthReadiness {
  /** True only when every check is PASS. NOT_YET_OBSERVED does not count as ready. */
  allProven: boolean;
  /** True when nothing has been recorded yet — the expected state before the first session. */
  awaitingFirstSession: boolean;
  decisionsInspected: number;
  sessionScope: string | null;
  checks: ReadinessCheck[];
  summary: string;
}

export interface ReadinessInputs {
  frozen: { frozen: boolean; message: string };
  shaAttribution: { state: string; degraded: boolean; message: string };
  sessionDate: string | null;
}

const CAP = 10;

function check(
  id: string,
  requirement: string,
  rows: readonly ShadowDecisionRow[],
  predicate: (r: ShadowDecisionRow) => boolean,
  detailFor: (ok: number, bad: string[]) => string,
): ReadinessCheck {
  if (!rows.length) {
    return {
      id, requirement, state: "NOT_YET_OBSERVED", observed: 0,
      detail: "no prospective decision has been recorded yet; nothing is claimed",
      offenders: [],
    };
  }
  const bad = rows.filter((r) => !predicate(r)).map((r) => r.decisionKey);
  return {
    id, requirement,
    state: bad.length ? "FAIL" : "PASS",
    observed: rows.length,
    detail: detailFor(rows.length - bad.length, bad),
    offenders: bad.slice(0, CAP),
  };
}

/** `O:AAPL260807P00272500`, with the provider prefix optional. */
const isOcc = (s: unknown): boolean => typeof s === "string" && /^(O:)?[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(s);

/** A confirmation capture is populated when it carries a per-field provenance map. */
function confirmationPopulated(r: ShadowDecisionRow): boolean {
  const c = r.confirmation as Record<string, unknown> | null;
  if (!c || typeof c !== "object") return false;
  const q = c.fieldQuality as Record<string, unknown> | undefined;
  if (!q || typeof q !== "object" || !Object.keys(q).length) return false;
  // Every declared basis must be one of the three legal values. A field that is present with
  // a value but no basis is exactly the ambiguity this capture exists to remove.
  return Object.values(q).every((v) => v === "OBSERVED" || v === "DERIVED" || v === "UNAVAILABLE");
}

/**
 * No unavailable value was written as 0. Checked on the derived cost fields, because those are
 * the ones a naive implementation zero-fills, and a zero there is a real measurement.
 */
function noZeroForUnavailable(r: ShadowDecisionRow): boolean {
  const c = (r.confirmation ?? {}) as Record<string, unknown>;
  const q = (c.fieldQuality ?? {}) as Record<string, unknown>;
  for (const [k, basis] of Object.entries(q)) {
    if (basis === "UNAVAILABLE" && c[k] != null) return false;
  }
  return true;
}

function attributionComplete(r: ShadowDecisionRow): boolean {
  const a = (r.attribution ?? {}) as Record<string, unknown>;
  const required = [
    "strategyVersion", "selectionEngineVersion", "contractRankingVersion", "dtePlannerVersion",
    "confirmationPolicyVersion", "stopPolicyVersion", "exitPolicyVersion",
  ];
  return required.every((k) => typeof a[k] === "string" && a[k] !== "" && a[k] !== UNKNOWN_LEGACY_VERSION);
}

/**
 * Assemble the board.
 *
 * `rows` are the persisted prospective decisions. Passing an empty array is the normal state
 * the night before the first session and yields `awaitingFirstSession: true` with every check
 * honestly NOT_YET_OBSERVED.
 */
export function buildFirstRthReadiness(
  rows: readonly ShadowDecisionRow[],
  inputs: ReadinessInputs,
): FirstRthReadiness {
  const checks: ReadinessCheck[] = [];

  checks.push(check(
    "baseline_decision_recorded",
    "Every evaluated lower_high_continuation opportunity carries the baseline's own decision.",
    rows,
    (r) => typeof r.baselineOutcome === "string" && r.baselineOutcome.length > 0,
    (ok, bad) => `${ok} row(s) carry a baseline outcome; ${bad.length} do not`,
  ));

  checks.push(check(
    "experiment_decision_recorded",
    "Every evaluated opportunity also carries an LHC_SELECT_V1 decision and its reason.",
    rows,
    (r) => typeof r.experimentReason === "string" && r.experimentReason.length > 0
      && (r.experimentAdmitted || r.experimentBlockedBy.length > 0),
    (ok, bad) => `${ok} row(s) carry an admit or a named rejection; ${bad.length} do not`,
  ));

  // The authority invariant, stated as data rather than as a promise: a row where the arms
  // DISAGREE and the baseline still delivered is direct evidence that V1 changed nothing.
  const disagreements = rows.filter((r) => r.baselineAdmitted !== r.experimentAdmitted);
  const baselineOverruled = disagreements.filter(
    (r) => r.baselineAdmitted && r.baselineOutcome !== "DELIVER_TO_DISCORD",
  );
  checks.push(
    rows.length === 0
      ? {
        id: "experiment_cannot_influence_baseline", requirement:
          "Where the arms disagree, the baseline's delivery stands unchanged.",
        state: "NOT_YET_OBSERVED", observed: 0,
        detail: "no prospective decision has been recorded yet; nothing is claimed",
        offenders: [],
      }
      : {
        id: "experiment_cannot_influence_baseline",
        requirement: "Where the arms disagree, the baseline's delivery stands unchanged.",
        state: baselineOverruled.length ? "FAIL" : disagreements.length ? "PASS" : "NOT_YET_OBSERVED",
        observed: disagreements.length,
        detail: baselineOverruled.length
          ? `${baselineOverruled.length} admitted baseline row(s) did not deliver — V1 may have leaked into authority`
          : disagreements.length
            ? `${disagreements.length} disagreement(s); every admitted baseline row still delivered`
            : "the arms have not yet disagreed, so non-influence is untested",
        offenders: baselineOverruled.map((r) => r.decisionKey).slice(0, CAP),
      },
  );

  checks.push(check(
    "pre_entry_inputs_only",
    "No denylisted lifetime/outcome field appears in the feature vector V1 decided on.",
    rows,
    (r) => {
      const f = (r.features ?? {}) as Record<string, unknown>;
      return !HINDSIGHT_DENYLIST.some((k) => k in f);
    },
    (ok, bad) => `${ok} feature vector(s) clean of ${HINDSIGHT_DENYLIST.length} denylisted field(s); ${bad.length} contaminated`,
  ));

  checks.push(check(
    "exact_occ_frozen",
    "The exact OCC symbol the decision was made about is recorded, not a re-derived one.",
    rows,
    (r) => isOcc(r.optionSymbol),
    (ok, bad) => `${ok} row(s) carry a well-formed OCC; ${bad.length} do not`,
  ));

  checks.push(check(
    "experiment_version_frozen",
    "Every row is stamped with the registered experiment id and version.",
    rows,
    (r) => r.experimentId === LHC_SELECT_V1.experimentId
      && Number(r.experimentVersion) === LHC_SELECT_V1.experimentVersion,
    (ok, bad) => `${ok} row(s) stamped ${LHC_SELECT_V1.experimentId}@${LHC_SELECT_V1.experimentVersion}; ${bad.length} not`,
  ));

  checks.push(check(
    "confirmation_fields_populate",
    "Confirmation-cost capture is present with a per-field OBSERVED/DERIVED/UNAVAILABLE basis.",
    rows,
    confirmationPopulated,
    (ok, bad) => `${ok} row(s) carry a complete field-quality map; ${bad.length} do not`,
  ));

  checks.push(check(
    "unavailable_is_never_zero",
    "No field marked UNAVAILABLE carries a value — absence is never written as 0.",
    rows,
    noZeroForUnavailable,
    (ok, bad) => `${ok} row(s) keep UNAVAILABLE fields null; ${bad.length} coerced one to a value`,
  ));

  checks.push(check(
    "policy_attribution_populated",
    "Strategy, selection, contract-rank, DTE, confirmation, stop and exit versions are all stamped.",
    rows,
    attributionComplete,
    (ok, bad) => `${ok} row(s) fully attributed; ${bad.length} missing or legacy on at least one version`,
  ));

  // Deployment SHA is checked BOTH ways: what the running process can see now, and what the
  // rows actually recorded. The first predicts tomorrow; the second reports yesterday.
  const shaRows = rows.filter((r) => {
    const v = (r.attribution as any)?.deploymentSha;
    return typeof v === "string" && v !== RUNTIME_SHA_UNAVAILABLE && v !== UNKNOWN_LEGACY_VERSION;
  });
  checks.push({
    id: "deployment_sha_resolvable_now",
    requirement: "The running process can name its own commit, so rows written next session are attributable.",
    state: inputs.shaAttribution.degraded ? "FAIL" : "PASS",
    observed: 1,
    detail: inputs.shaAttribution.message,
    offenders: [],
  });
  checks.push(check(
    "deployment_sha_recorded",
    "Recorded rows name the deploy that produced them.",
    rows,
    (r) => {
      const v = (r.attribution as any)?.deploymentSha;
      return typeof v === "string" && v !== RUNTIME_SHA_UNAVAILABLE && v !== UNKNOWN_LEGACY_VERSION;
    },
    (ok, bad) => `${ok} row(s) name a commit; ${bad.length} are RUNTIME_SHA_UNAVAILABLE or legacy`,
  ));

  // Owner alerting: the arm is only measuring anything if the baseline lane is still live.
  const baselineAdmits = rows.filter((r) => r.baselineAdmitted);
  checks.push({
    id: "owner_baseline_alerts_continue",
    requirement: "The baseline owner path is still admitting and delivering during the experiment.",
    state: rows.length === 0 ? "NOT_YET_OBSERVED" : baselineAdmits.length ? "PASS" : "NOT_YET_OBSERVED",
    observed: baselineAdmits.length,
    detail: rows.length === 0
      ? "no prospective decision has been recorded yet; nothing is claimed"
      : baselineAdmits.length
        ? `${baselineAdmits.length} baseline admit(s) recorded alongside the shadow arm`
        : `${rows.length} decision(s) recorded, none admitted by the baseline — the lane produced no owner alert`,
    offenders: [],
  });

  checks.push({
    id: "experiment_definition_unchanged",
    requirement: "The gate definitions being measured are the ones that were frozen.",
    state: inputs.frozen.frozen ? "PASS" : "FAIL",
    observed: 1,
    detail: inputs.frozen.message,
    offenders: [],
  });

  const awaitingFirstSession = rows.length === 0;
  const failing = checks.filter((c) => c.state === "FAIL");
  const pending = checks.filter((c) => c.state === "NOT_YET_OBSERVED");

  return {
    allProven: checks.every((c) => c.state === "PASS"),
    awaitingFirstSession,
    decisionsInspected: rows.length,
    sessionScope: inputs.sessionDate,
    checks,
    summary: failing.length
      ? `${failing.length} readiness check(s) FAILED: ${failing.map((c) => c.id).join(", ")}. ` +
        "The prospective sample recorded under these conditions cannot be trusted."
      : awaitingFirstSession
        ? "No prospective decision exists yet. Every check is NOT_YET_OBSERVED — this board proves " +
          "nothing until the first real RTH session writes rows, and it deliberately does not go " +
          "green on an empty table."
        : pending.length
          ? `${checks.length - pending.length} check(s) proven by live rows; ${pending.length} still ` +
            `unexercised (${pending.map((c) => c.id).join(", ")}).`
          : "Every first-session invariant is proven by persisted rows.",
  };
}
