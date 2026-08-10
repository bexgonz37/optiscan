/**
 * The compact structured evidence handed to the nightly and weekly AI jobs.
 *
 * WHY IT IS BUILT ONCE, HERE
 *
 * The nightly narrator and the weekly proposer were reading two different pictures of the same
 * session: the narrator saw a generic performance summary with no experiment in it at all, and
 * the weekly saw the experiment but not the owner lane. Two models reasoning from two partial
 * views of one night produce two verdicts, and the operator has no way to tell which one was
 * looking at less. So the context is assembled once and both jobs receive the same object.
 *
 * THE ONE INVARIANT EVERYTHING ELSE SERVES: NO DATA IS NOT ZERO.
 *
 * `profitFactor: null` means the metric could not be computed. `profitFactor: 0` would mean the
 * lane made nothing and lost something — a real, terrible result. A model that renders the first
 * as the second has invented the worst possible finding out of an empty table, and this system
 * currently HAS an empty table: zero prospective decisions have been recorded. Every section
 * therefore carries `unavailableMetrics`, naming the fields whose null means "not measured", and
 * `readingRules` states the distinction in the payload itself rather than trusting the prompt to
 * remember it.
 *
 * TOKEN DISCIPLINE
 *
 * Deterministic aggregates only. Individual rows appear in `anomalies`, capped, and only when
 * something is actually anomalous. Growth in this payload is growth in every nightly bill.
 *
 * Impure (SQLite reads), testable OnDb core. Zero provider calls.
 */

import { buildProspectiveScoreboard } from "./prospective-scoreboard.ts";
import { listShadowDecisionsOnDb, currentStatusOnDb, statusHistoryOnDb, type ShadowDb, type ShadowDecisionRow } from "./shadow-arm-store.ts";
import { listFindingsOnDb, type FindingsDb } from "./findings-store.ts";
import { LHC_SELECT_V1, checkFrozen } from "./experiment-registry.ts";
import { buildOwnerAlertSummaryOnDb, type NightlyDb } from "./nightly-research.ts";
import { censusShaAttribution, POLICY_VERSIONS } from "./policy-attribution.ts";
import { buildPreMoveNightlyReport, type PreMoveNightlyReport } from "./pre-move-nightly.ts";

export interface ResearchContextDb extends ShadowDb, FindingsDb, NightlyDb {}

/** Cap on individual rows in any anomaly list. Aggregates first; detail only where it earns it. */
const ANOMALY_CAP = 8;

function hasTable(db: ResearchContextDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}

/** Names of the fields in `o` that are null, so a reader can tell absence from a measured zero. */
function unavailable(o: Record<string, unknown>): string[] {
  return Object.entries(o).filter(([, v]) => v == null).map(([k]) => k).sort();
}

const median = (v: number[]): number | null => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const round = (v: number | null, p = 4): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p;

// ── owner Discord ───────────────────────────────────────────────────────────────────────────

export interface OwnerLaneContext {
  sessionDate: string;
  sampleSize: number;
  openings: number;
  paperMirrors: number;
  closed: number;
  open: number;
  ungradable: number;
  wins: number;
  losses: number;
  expectancyPct: number | null;
  profitFactor: number | null;
  bestWinnerPct: number | null;
  worstLossPct: number | null;
  immediateFailures: number;
  profitGivenBack: number;
  withoutTrajectoryEvidence: number;
  mirrorRate: number | null;
  byStrategy: { strategy: string; n: number; wins: number; losses: number; expectancyPct: number | null; profitFactor: number | null }[];
  byPolicyVersion: { key: string; n: number; wins: number; losses: number; expectancyPct: number | null }[];
  unavailableMetrics: string[];
  note: string;
}

/**
 * Per-version performance for the owner lane.
 *
 * Reads the prospective decisions, which are the ONLY rows carrying a frozen attribution. The
 * historical paper trades have no version stamp and are deliberately not guessed at: an empty
 * list here means "no attributed outcome has closed yet", which is the honest answer while the
 * arm is new.
 */
function ownerByPolicyVersion(rows: readonly ShadowDecisionRow[]): OwnerLaneContext["byPolicyVersion"] {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.baselineAdmitted || r.outcomeStatus !== "CLOSED" || r.returnPct == null) continue;
    const a = (r.attribution ?? {}) as Record<string, unknown>;
    const key = [
      `strategy@${a.strategyVersion ?? "?"}`,
      `select@${a.selectionEngineVersion ?? "?"}`,
      `stop@${a.stopPolicyVersion ?? "?"}`,
      `exit@${a.exitPolicyVersion ?? "?"}`,
    ].join(" ");
    groups.set(key, [...(groups.get(key) ?? []), r.returnPct]);
  }
  return [...groups.entries()].map(([key, v]) => ({
    key,
    n: v.length,
    wins: v.filter((x) => x > 0).length,
    losses: v.filter((x) => x <= 0).length,
    expectancyPct: round(v.reduce((s, x) => s + x, 0) / v.length, 2),
  })).sort((a, b) => b.n - a.n);
}

export function buildOwnerLaneContext(
  db: ResearchContextDb,
  sessionDate: string,
  decisions: readonly ShadowDecisionRow[],
): OwnerLaneContext {
  const o = buildOwnerAlertSummaryOnDb(db, sessionDate);
  const metrics = {
    expectancyPct: round(o.expectancyPct, 2),
    profitFactor: round(o.profitFactor, 3),
    bestWinnerPct: round(o.bestWinnerPct, 2),
    worstLossPct: round(o.worstLossPct, 2),
    mirrorRate: round(o.mirrorRate, 3),
  };
  return {
    sessionDate,
    sampleSize: o.closed,
    openings: o.openings,
    paperMirrors: o.paperMirrors,
    closed: o.closed,
    open: o.open,
    ungradable: o.ungradable,
    wins: o.realizedWins,
    losses: o.realizedLosses,
    ...metrics,
    immediateFailures: o.immediateFailures,
    profitGivenBack: o.profitGivenBack,
    withoutTrajectoryEvidence: o.withoutTrajectoryEvidence,
    byStrategy: o.byStrategy.map((b) => ({ ...b, expectancyPct: round(b.expectancyPct, 2), profitFactor: round(b.profitFactor, 3) })),
    byPolicyVersion: ownerByPolicyVersion(decisions),
    unavailableMetrics: unavailable(metrics),
    note: o.closed === 0
      ? "No owner opening CLOSED in this session. Expectancy and profit factor are UNAVAILABLE, not zero."
      : "Closed owner Discord openings, priced on the exact contract the alert froze. " +
        "immediateFailures and profitGivenBack are counted only where the same-contract mark series supports the claim.",
  };
}

// ── confirmation cost ───────────────────────────────────────────────────────────────────────

export interface ConfirmationCostContext {
  sampleSize: number;
  medianConfirmationDelayMs: number | null;
  medianQueueDelayMs: number | null;
  medianDeliveryDelayMs: number | null;
  medianPremiumExpansionPct: number | null;
  medianUnderlyingMoveBeforeEntryPct: number | null;
  medianRewardRemainingAtEntry: number | null;
  /** How many rows carry each provenance, per field. OBSERVED/DERIVED/UNAVAILABLE. */
  fieldQualityBasis: Record<string, Record<string, number>>;
  unavailableMetrics: string[];
  note: string;
}

const CONFIRMATION_METRICS = [
  ["medianConfirmationDelayMs", "confirmationDelayMs"],
  ["medianQueueDelayMs", "queueDelayMs"],
  ["medianDeliveryDelayMs", "deliveryDelayMs"],
  ["medianPremiumExpansionPct", "premiumExpansionPct"],
  ["medianUnderlyingMoveBeforeEntryPct", "underlyingMoveBeforeEntryPct"],
  ["medianRewardRemainingAtEntry", "rewardRemainingAtEntry"],
] as const;

/**
 * What waiting for confirmation cost, aggregated.
 *
 * Only rows whose `fieldQuality` marks a field OBSERVED or DERIVED contribute to that field's
 * median. A row that never measured the delay must not pull the median toward zero — that is
 * the exact substitution that made the historical cohort unable to answer this question.
 */
export function buildConfirmationCostContext(rows: readonly ShadowDecisionRow[]): ConfirmationCostContext {
  const basis: Record<string, Record<string, number>> = {};
  const values = new Map<string, number[]>();

  for (const r of rows) {
    const c = (r.confirmation ?? {}) as Record<string, unknown>;
    const q = (c.fieldQuality ?? {}) as Record<string, unknown>;
    for (const [, field] of CONFIRMATION_METRICS) {
      const b = String(q[field] ?? "UNAVAILABLE");
      basis[field] = { ...(basis[field] ?? {}), [b]: (basis[field]?.[b] ?? 0) + 1 };
      const v = c[field];
      if ((b === "OBSERVED" || b === "DERIVED") && typeof v === "number" && Number.isFinite(v)) {
        values.set(field, [...(values.get(field) ?? []), v]);
      }
    }
  }

  const metrics = Object.fromEntries(
    CONFIRMATION_METRICS.map(([out, field]) => [out, round(median(values.get(field) ?? []), 3)]),
  ) as Record<(typeof CONFIRMATION_METRICS)[number][0], number | null>;

  return {
    sampleSize: rows.length,
    ...metrics,
    fieldQualityBasis: basis,
    unavailableMetrics: unavailable(metrics),
    note: rows.length === 0
      ? "No prospective decision has been recorded, so confirmation cost is UNAVAILABLE — not zero, and not 'confirmation was instant'."
      : "Medians are computed only over rows whose field-quality basis is OBSERVED or DERIVED. " +
        "A null median means no row measured that field; it does not mean the cost was zero.",
  };
}

// ── the experiment ──────────────────────────────────────────────────────────────────────────

export interface ExperimentContext {
  experimentId: string;
  version: number;
  mode: string;
  status: string | null;
  frozen: boolean;
  frozenMessage: string;
  definitionHash: string;
  prospectiveStartDate: string;
  historicalResult: Record<string, unknown>;
  robustnessCaveats: readonly string[];
  wouldBeDisprovenBy: string;
  statusHistory: { status: string; previousStatus: string | null; reason: string; actor: string; createdAtMs: number }[];
  scoreboard: Record<string, unknown>;
  perSession: { sessionDate: string; evaluated: number; baselineAdmits: number; experimentAdmits: number; closed: number; winnersRejected: number; lossesAvoided: number }[];
  unavailableMetrics: string[];
  evidenceLimitations: string[];
}

// ── research / shadow lane ──────────────────────────────────────────────────────────────────

export interface ResearchLaneContext {
  versusOwnerLane: {
    baselineExpectancyPct: number | null;
    experimentExpectancyPct: number | null;
    baselineProfitFactor: number | null;
    experimentProfitFactor: number | null;
    closedOutcomes: number;
  };
  interestingMisses: { symbol: string; optionSymbol: string; sessionDate: string; returnPct: number | null; blockedBy: string[] }[];
  recoveredOpportunities: { symbol: string; optionSymbol: string; sessionDate: string; returnPct: number | null }[];
  rejectedWinners: { symbol: string; optionSymbol: string; sessionDate: string; returnPct: number | null; blockedBy: string[] }[];
  costOfRecovery: number;
  unavailableMetrics: string[];
  note: string;
}

// ── system + data quality ───────────────────────────────────────────────────────────────────

export interface SystemQualityContext {
  schemaTablesPresent: string[];
  schemaTablesMissing: string[];
  policyVersions: Record<string, string>;
  shaCensus: ReturnType<typeof censusShaAttribution>;
  decisionsWithUnavailableGates: number;
  unavailableGateCounts: Record<string, number>;
  trajectoryTrustworthy: number;
  trajectoryUntrustworthy: number;
  note: string;
}

export interface MissedOpportunityContext {
  available: boolean;
  sessionDate: string;
  cases: number;
  byRootCause: Record<string, number>;
  byRecoverability: Record<string, number>;
  medianExecutableReturnPct: number | null;
  unavailableMetrics: string[];
  note: string;
}

const REQUIRED_TABLES = [
  "options_experiment_registry", "options_experiment_status", "options_experiment_decisions",
  "options_learning_findings", "options_paper_trades", "options_paper_marks", "options_alerts",
];

function buildMissedOpportunityContext(db: ResearchContextDb, sessionDate: string): MissedOpportunityContext {
  if (!hasTable(db, "missed_opportunity_cases")) {
    return {
      available: false, sessionDate, cases: 0, byRootCause: {}, byRecoverability: {},
      medianExecutableReturnPct: null, unavailableMetrics: ["medianExecutableReturnPct"],
      note: "The missed-opportunity store is not present in this database. Absent, not empty.",
    };
  }
  let rows: any[] = [];
  try {
    rows = db.prepare(
      "SELECT root_cause, recoverability, executable_return_pct FROM missed_opportunity_cases WHERE session_date=?",
    ).all(sessionDate) as any[];
  } catch { /* isolated; reported as unavailable below */ }

  const byRootCause: Record<string, number> = {};
  const byRecoverability: Record<string, number> = {};
  const returns: number[] = [];
  for (const r of rows) {
    byRootCause[r.root_cause ?? "unknown"] = (byRootCause[r.root_cause ?? "unknown"] ?? 0) + 1;
    byRecoverability[r.recoverability ?? "unknown"] = (byRecoverability[r.recoverability ?? "unknown"] ?? 0) + 1;
    if (typeof r.executable_return_pct === "number") returns.push(r.executable_return_pct);
  }
  const medianExecutableReturnPct = round(median(returns), 2);
  return {
    available: true, sessionDate, cases: rows.length, byRootCause, byRecoverability,
    medianExecutableReturnPct,
    unavailableMetrics: medianExecutableReturnPct == null ? ["medianExecutableReturnPct"] : [],
    note: rows.length === 0
      ? "No missed-opportunity case was recorded for this session. That is a count of zero cases, not an unmeasured metric."
      : "Executable return is what could actually have been filled, not the headline move.",
  };
}

// ── the whole context ───────────────────────────────────────────────────────────────────────

export interface AiResearchContext {
  contextVersion: string;
  sessionDate: string | null;
  /** Stated in the payload so the rule survives prompt edits. */
  readingRules: string[];
  ownerDiscord: OwnerLaneContext | null;
  experiment: ExperimentContext;
  confirmationCost: ConfirmationCostContext;
  researchLane: ResearchLaneContext;
  missedOpportunities: MissedOpportunityContext | null;
  /** Pre-move discovery, per lane. Null when the store is unavailable, never {} . */
  preMove: PreMoveNightlyReport | null;
  systemQuality: SystemQualityContext;
  findings: { findingId: string; statement: string; evidenceStrength: string; sampleSize: number; limitations: readonly string[]; mustNotBeSummarizedAs: string | null }[];
  instructions: string[];
}

export const AI_RESEARCH_CONTEXT_VERSION = "ai-research-context-v1";

/**
 * The rules that make the numbers readable. Carried IN the payload, because a prompt is edited
 * far more often than a payload contract and the distinction between "unavailable" and "zero"
 * must not depend on which edit came last.
 */
export const READING_RULES: readonly string[] = Object.freeze([
  "null means NOT MEASURED. It never means zero. 'profitFactor: null' must be reported as 'profit factor unavailable', never as 'profit factor 0'.",
  "Each section lists its own `unavailableMetrics`. A metric named there has no value and no conclusion may rest on it.",
  "A count of 0 (openings, closed, cases) IS a measured zero and may be reported as zero.",
  "Expectancy and profit factor are computed from CLOSED outcomes only. Open positions have no result.",
  "A positive peak (MFE) is never a win. Only a realized return is a result.",
  "`sampleSize: 0` means the section is describing an empty population; say that rather than describing its metrics.",
]);

const AUTHORITY_INSTRUCTIONS: readonly string[] = Object.freeze([
  "Every figure above is already computed. Do not produce a number that is not in this payload.",
  "Expectancy and profit factor are from CLOSED outcomes only. Open positions have no result.",
  "Never describe LHC_SELECT_V1 as working, validated, proven or ready. It is PROMISING and UNVALIDATED.",
  "If closedOutcomes is 0, there is no prospective result — say so rather than reporting the historical one as if it were prospective.",
  "Report winners rejected before losses avoided.",
  "Carry each finding's limitations with its number. A finding quoted without its limitation is a misquote.",
  "A null metric is UNAVAILABLE and must never be rendered as 0.",
  "You may propose SHADOW or PAPER_VALIDATION experiments. You may not change a live threshold, " +
    "select a live trade, alter subscriber readiness, approve a subscriber strategy, send an alert, " +
    "deploy code, or rewrite a historical outcome.",
]);

/**
 * Build the full context.
 *
 * `sessionDate` scopes the owner lane and the missed-opportunity block; the experiment sections
 * are cumulative by design, because a one-session view of a multi-session question is what this
 * whole arm exists to avoid.
 */
export function buildAiResearchContextOnDb(
  db: ResearchContextDb,
  opts: { sessionDate?: string | null; nowMs?: number } = {},
): AiResearchContext {
  const sessionDate = opts.sessionDate ?? null;
  const rows = (() => {
    try { return listShadowDecisionsOnDb(db, { experimentId: LHC_SELECT_V1.experimentId }); }
    catch { return [] as ShadowDecisionRow[]; }
  })();
  const s = buildProspectiveScoreboard(rows);
  const frozen = checkFrozen();

  const findings = (() => {
    try { return listFindingsOnDb(db, { strategy: "lower_high_continuation" }); } catch { return []; }
  })();

  const perSession = s.sessions.map((sessionDateKey) => {
    const inSession = rows.filter((r) => r.sessionDate === sessionDateKey);
    const baselineOnly = inSession.filter((r) => r.arm === "BASELINE_ONLY");
    return {
      sessionDate: sessionDateKey,
      evaluated: inSession.length,
      baselineAdmits: inSession.filter((r) => r.baselineAdmitted).length,
      experimentAdmits: inSession.filter((r) => r.experimentAdmitted).length,
      closed: inSession.filter((r) => r.outcomeStatus === "CLOSED").length,
      winnersRejected: baselineOnly.filter((r) => r.outcomeStatus === "CLOSED" && (r.returnPct ?? 0) > 0).length,
      lossesAvoided: baselineOnly.filter((r) => r.outcomeStatus === "CLOSED" && r.returnPct != null && r.returnPct <= 0).length,
    };
  });

  const experimentMetrics = {
    experimentExpectancyPct: s.experiment.expectancyPct,
    experimentProfitFactor: s.experiment.profitFactor,
    experimentMedianReturnPct: s.experiment.medianReturnPct,
    experimentAvgWinnerPct: s.experiment.avgWinnerPct,
    experimentAvgLoserPct: s.experiment.avgLoserPct,
    baselineExpectancyPct: s.baseline.expectancyPct,
    baselineProfitFactor: s.baseline.profitFactor,
    profitFactorWithoutTopWinner: s.tailDependence.profitFactorWithoutTopWinner,
    profitFactorCappedAt60: s.tailDependence.profitFactorCappedAt60,
  };

  const experiment: ExperimentContext = {
    experimentId: LHC_SELECT_V1.experimentId,
    version: LHC_SELECT_V1.experimentVersion,
    mode: LHC_SELECT_V1.mode,
    status: (() => { try { return currentStatusOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion); } catch { return null; } })(),
    frozen: frozen.frozen,
    frozenMessage: frozen.message,
    definitionHash: LHC_SELECT_V1.definitionHash,
    prospectiveStartDate: LHC_SELECT_V1.prospectiveStartDate,
    historicalResult: LHC_SELECT_V1.historicalResult as unknown as Record<string, unknown>,
    robustnessCaveats: LHC_SELECT_V1.robustnessCaveats,
    wouldBeDisprovenBy: LHC_SELECT_V1.wouldBeDisprovenBy,
    statusHistory: (() => { try { return statusHistoryOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion); } catch { return []; } })(),
    scoreboard: {
      sessionsObserved: s.sessionsObserved,
      sessions: s.sessions,
      opportunitiesEvaluated: s.opportunitiesEvaluated,
      baselineAdmits: s.baselineAdmits,
      experimentAdmits: s.experimentAdmits,
      arms: { bothAdmit: s.bothAdmit, baselineOnly: s.baselineOnly, experimentOnly: s.experimentOnly, bothReject: s.bothReject },
      closedOutcomes: s.closedOutcomes,
      openOutcomes: s.openOutcomes,
      ungradableOutcomes: s.ungradableOutcomes,
      baseline: s.baseline,
      experiment: s.experiment,
      experimentExTopWinner: s.experimentExTopWinner,
      tailDependence: s.tailDependence,
      winnersRetained: s.winnersRetained.length,
      winnersRejected: s.winnersRejected,
      lossesAvoided: s.lossesAvoided.length,
      evidenceQuality: s.evidenceQuality,
      honestSummary: s.honestSummary,
      mustNotBeSummarizedAs: s.mustNotBeSummarizedAs,
    },
    perSession,
    unavailableMetrics: unavailable(experimentMetrics),
    evidenceLimitations: [
      ...LHC_SELECT_V1.robustnessCaveats,
      s.evidenceQuality.verdictReason,
      s.closedOutcomes === 0
        ? "ZERO prospective outcomes have closed. Every performance figure for this experiment is HISTORICAL and was measured on the cohort the rule was read from."
        : `${s.closedOutcomes} prospective outcome(s) closed over ${s.sessionsObserved} session(s).`,
    ],
  };

  const laneMetrics = {
    baselineExpectancyPct: s.baseline.expectancyPct,
    experimentExpectancyPct: s.experiment.expectancyPct,
    baselineProfitFactor: s.baseline.profitFactor,
    experimentProfitFactor: s.experiment.profitFactor,
  };
  const brief = (c: { symbol: string; optionSymbol: string; sessionDate: string; returnPct: number | null }) =>
    ({ symbol: c.symbol, optionSymbol: c.optionSymbol, sessionDate: c.sessionDate, returnPct: round(c.returnPct, 2) });

  const researchLane: ResearchLaneContext = {
    versusOwnerLane: { ...laneMetrics, closedOutcomes: s.closedOutcomes },
    // A rejected winner is the case AGAINST the rule and is listed first in this object for the
    // same reason it is reported first in prose.
    rejectedWinners: s.winnersRejected.slice(0, ANOMALY_CAP).map((c) => ({ ...brief(c), blockedBy: c.blockedBy })),
    interestingMisses: s.lossesAvoided.slice(0, ANOMALY_CAP).map((c) => ({ ...brief(c), blockedBy: c.blockedBy })),
    recoveredOpportunities: s.experimentOnlyWinners.slice(0, ANOMALY_CAP).map(brief),
    costOfRecovery: s.experimentOnlyLosses.length,
    unavailableMetrics: unavailable(laneMetrics),
    note: s.closedOutcomes === 0
      ? "The research lane has produced no closed prospective outcome. There is nothing to compare against the owner lane yet."
      : "interestingMisses are baseline LOSSES the experiment rejected; rejectedWinners are baseline WINNERS it rejected.",
  };

  const systemQuality: SystemQualityContext = {
    schemaTablesPresent: REQUIRED_TABLES.filter((t) => hasTable(db, t)),
    schemaTablesMissing: REQUIRED_TABLES.filter((t) => !hasTable(db, t)),
    policyVersions: { ...POLICY_VERSIONS },
    shaCensus: censusShaAttribution(rows.map((r) => ({ deploymentSha: (r.attribution as any)?.deploymentSha ?? null }))),
    decisionsWithUnavailableGates: s.evidenceQuality.decisionsWithUnavailableGates,
    unavailableGateCounts: s.evidenceQuality.unavailableGateCounts,
    trajectoryTrustworthy: s.evidenceQuality.trajectoryTrustworthy,
    trajectoryUntrustworthy: s.evidenceQuality.trajectoryUntrustworthy,
    note: "shaCensus.runtimeUnavailable counts rows written by a deploy that could not name its commit — " +
      "an operational problem with the CURRENT deployment path, distinct from `legacy`, which is permanent history.",
  };

  return {
    contextVersion: AI_RESEARCH_CONTEXT_VERSION,
    sessionDate,
    readingRules: [...READING_RULES],
    ownerDiscord: sessionDate ? buildOwnerLaneContext(db, sessionDate, rows) : null,
    experiment,
    confirmationCost: buildConfirmationCostContext(rows),
    researchLane,
    missedOpportunities: sessionDate ? buildMissedOpportunityContext(db, sessionDate) : null,
    // PRE_MOVE_DISCOVERY_V1, lane-separated. This is what lets the nightly ask "did we
    // find it before it ran" instead of only "did it work" — two questions that a good
    // realized return can answer identically while meaning opposite things about the
    // scanner. Isolated: the pre-move store is newer than every other section here and
    // its absence must not cost the nightly the rest of its context.
    preMove: (() => {
      try { return buildPreMoveNightlyReport(db as any, { sinceMs: null }); }
      catch { return null; }
    })(),
    systemQuality,
    findings: findings.map((f) => ({
      findingId: f.findingId,
      statement: f.statement,
      evidenceStrength: f.evidenceStrength,
      sampleSize: f.sampleSize,
      limitations: f.limitations,
      mustNotBeSummarizedAs: f.mustNotBeSummarizedAs,
    })),
    instructions: [...AUTHORITY_INSTRUCTIONS],
  };
}

/**
 * The questions the nightly analysis must answer from the context above. Exported so the prompt,
 * the response schema and the tests all name the same list rather than three drifting copies.
 */
export const NIGHTLY_ANALYSIS_QUESTIONS: readonly string[] = Object.freeze([
  "Which owner alerts worked in this session, and what did the winners share?",
  "Which owner alerts never worked — never traded above entry — and what did they share?",
  "Which trades worked and then gave the profit back?",
  "Did LHC_SELECT_V1 reject baseline losers?",
  "Did LHC_SELECT_V1 reject any baseline winners?",
  "Did LHC_SELECT_V1 recover anything the baseline rejected, and at what cost?",
  "Are confirmation delays consuming the edge before entry?",
  "Are contract-quality differences repeating across sessions?",
  "Is any strategy or policy version degrading?",
  "What evidence is still too weak to act on?",
  "Is a new bounded shadow or paper experiment justified by tonight's evidence?",
]);
