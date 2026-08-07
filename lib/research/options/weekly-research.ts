/**
 * The weekly OptiScan research review, and the AI research budget report.
 *
 * WHY A SEPARATE WEEKLY PASS
 *
 * The nightly answers "what happened today" and can only advance an experiment as far as
 * PAPER_VALIDATION. Deciding whether a rule is working is a multi-session question: a single
 * session's admits and rejects are a handful of trades, and the failure mode this experiment
 * exists to avoid — rejecting the winners — is invisible until enough winners have occurred to
 * reject. So the verdict lives here, over the accumulated prospective sample, and its ceiling
 * is READY_FOR_HUMAN_REVIEW.
 *
 * ON THE BUDGET
 *
 * The AI budget is enforced by the EXISTING `costGateOnDb` in the nightly and weekly jobs;
 * this module does not add a second gate, it REPORTS the one that exists. The reporting matters
 * because exhaustion must stop optional reasoning and nothing else: `blockedByBudget` lists the
 * jobs a caller may skip, and it never contains the scanner, owner Discord, the paper mirror,
 * marks, lifecycle, grading, Evidence Learning capture, readiness, or the deterministic
 * experiment tracking above. Those run whether or not there is a dollar left.
 *
 * Impure (SQLite), testable OnDb core. Zero provider calls.
 */

import { buildProspectiveScoreboard, weeklyVerdict, type ProspectiveScoreboard, type WeeklyVerdict } from "./prospective-scoreboard.ts";
import { listShadowDecisionsOnDb, refreshShadowOutcomesOnDb, currentStatusOnDb, recordStatusOnDb, statusHistoryOnDb, type ShadowDb } from "./shadow-arm-store.ts";
import { listFindingsOnDb, type FindingsDb } from "./findings-store.ts";
import { LHC_SELECT_V1, checkFrozen, canTransition, type ExperimentStatus } from "./experiment-registry.ts";

export interface WeeklyDb extends ShadowDb, FindingsDb {}

function hasTable(db: WeeklyDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}

/**
 * The deterministic work the AI budget may never stop. Named explicitly so a future change
 * that starts gating one of these fails a test rather than a live session.
 */
export const BUDGET_EXEMPT_SUBSYSTEMS: readonly string[] = Object.freeze([
  "scanner",
  "owner_discord",
  "paper_mirror",
  "marks",
  "lifecycle",
  "grading",
  "evidence_learning_capture",
  "readiness",
  "deterministic_experiment_tracking",
]);

/** Optional AI reasoning — the only thing budget exhaustion is allowed to skip. */
export const BUDGET_OPTIONAL_JOBS: readonly string[] = Object.freeze([
  "nightly_diagnosis",
  "weekly_proposals",
  "advisory_chat",
  "asymmetry_explain",
  "research_analyzer",
]);

export interface AiBudgetReport {
  monthKey: string;
  nightlyRequests: number;
  weeklyRequests: number;
  otherRequests: number;
  dailyInputTokens: number;
  dailyOutputTokens: number;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  estimatedMonthlySpendUsd: number;
  monthlyBudgetUsd: number | null;
  budgetRemainingUsd: number | null;
  skippedOptionalJobs: number;
  skippedForBudget: number;
  /** Jobs a caller may skip when the budget is exhausted. */
  budgetMayStop: readonly string[];
  /** Subsystems that run regardless. Budget exhaustion must never reach these. */
  budgetMayNeverStop: readonly string[];
}

/**
 * Read the existing `ai_job_runs` ledger. Reports only; the enforcement gate is
 * `costGateOnDb`, which already runs pre-flight in the nightly and weekly jobs.
 */
export function buildAiBudgetReportOnDb(
  db: WeeklyDb,
  opts: { nowMs?: number; monthlyBudgetUsd?: number | null } = {},
): AiBudgetReport {
  const nowMs = opts.nowMs ?? Date.now();
  const monthKey = new Date(nowMs).toISOString().slice(0, 7);
  const dayStartMs = nowMs - 86_400_000;
  const empty: AiBudgetReport = {
    monthKey, nightlyRequests: 0, weeklyRequests: 0, otherRequests: 0,
    dailyInputTokens: 0, dailyOutputTokens: 0, monthlyInputTokens: 0, monthlyOutputTokens: 0,
    estimatedMonthlySpendUsd: 0,
    monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null,
    budgetRemainingUsd: opts.monthlyBudgetUsd ?? null,
    skippedOptionalJobs: 0, skippedForBudget: 0,
    budgetMayStop: BUDGET_OPTIONAL_JOBS, budgetMayNeverStop: BUDGET_EXEMPT_SUBSYSTEMS,
  };
  if (!hasTable(db, "ai_job_runs")) return empty;

  const n = (sql: string, ...a: unknown[]): number => {
    try { return Number((db.prepare(sql).get(...a) as any)?.v ?? 0); } catch { return 0; }
  };

  const monthlySpend = n("SELECT COALESCE(SUM(estimated_cost_usd),0) v FROM ai_job_runs WHERE month_key=?", monthKey);
  const budget = opts.monthlyBudgetUsd ?? null;

  return {
    monthKey,
    nightlyRequests: n("SELECT COUNT(*) v FROM ai_job_runs WHERE month_key=? AND job_type LIKE 'nightly%'", monthKey),
    weeklyRequests: n("SELECT COUNT(*) v FROM ai_job_runs WHERE month_key=? AND job_type LIKE 'weekly%'", monthKey),
    otherRequests: n(
      "SELECT COUNT(*) v FROM ai_job_runs WHERE month_key=? AND job_type NOT LIKE 'nightly%' AND job_type NOT LIKE 'weekly%'",
      monthKey,
    ),
    dailyInputTokens: n("SELECT COALESCE(SUM(input_tokens),0) v FROM ai_job_runs WHERE created_at_ms >= ?", dayStartMs),
    dailyOutputTokens: n("SELECT COALESCE(SUM(output_tokens),0) v FROM ai_job_runs WHERE created_at_ms >= ?", dayStartMs),
    monthlyInputTokens: n("SELECT COALESCE(SUM(input_tokens),0) v FROM ai_job_runs WHERE month_key=?", monthKey),
    monthlyOutputTokens: n("SELECT COALESCE(SUM(output_tokens),0) v FROM ai_job_runs WHERE month_key=?", monthKey),
    estimatedMonthlySpendUsd: Math.round(monthlySpend * 10000) / 10000,
    monthlyBudgetUsd: budget,
    budgetRemainingUsd: budget == null ? null : Math.round((budget - monthlySpend) * 10000) / 10000,
    skippedOptionalJobs: n("SELECT COUNT(*) v FROM ai_job_runs WHERE month_key=? AND status LIKE 'SKIPPED%'", monthKey),
    skippedForBudget: n("SELECT COUNT(*) v FROM ai_job_runs WHERE month_key=? AND error_category='budget'", monthKey),
    budgetMayStop: BUDGET_OPTIONAL_JOBS,
    budgetMayNeverStop: BUDGET_EXEMPT_SUBSYSTEMS,
  };
}

export interface WeeklyResearchResult {
  ran: boolean;
  weekKey: string;
  productionBehaviorChanged: false;
  experimentFrozen: boolean;
  experimentFrozenMessage: string;
  statusBefore: ExperimentStatus | null;
  statusAfter: ExperimentStatus | null;
  statusChanged: boolean;
  scoreboard: ProspectiveScoreboard;
  verdict: { verdict: WeeklyVerdict; reason: string };
  /** Per-session prospective detail — the rule must not be carried by one session. */
  perSession: {
    sessionDate: string; evaluated: number; baselineAdmits: number; experimentAdmits: number;
    closed: number; winnersRejected: number; lossesAvoided: number;
  }[];
  findings: number;
  budget: AiBudgetReport;
  /** Human-readable, and refuses to state a conclusion the sample cannot support. */
  report: string[];
}

/**
 * The weekly review.
 *
 * This is the ONLY place an experiment can reach PROMISING or READY_FOR_HUMAN_REVIEW, and it
 * does so from `weeklyVerdict`, which returns FAILED when V1 rejected winners without
 * improving profit factor and caps a tail-carried arm at PROMISING. A rule whose definition
 * changed is not advanced at all — its prospective sample mixes two rules.
 */
export function runWeeklyResearchOnDb(
  db: WeeklyDb,
  opts: { weekKey: string; nowMs?: number; monthlyBudgetUsd?: number | null },
): WeeklyResearchResult {
  const nowMs = opts.nowMs ?? Date.now();
  const frozen = checkFrozen();

  try { refreshShadowOutcomesOnDb(db); } catch { /* isolated */ }

  const rows = listShadowDecisionsOnDb(db, { experimentId: LHC_SELECT_V1.experimentId });
  const scoreboard = buildProspectiveScoreboard(rows);
  const verdict = weeklyVerdict(scoreboard);
  const statusBefore = currentStatusOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion);

  const perSession = [...new Set(rows.map((r) => r.sessionDate))].sort().map((sessionDate) => {
    const s = rows.filter((r) => r.sessionDate === sessionDate);
    const baselineOnly = s.filter((r) => r.arm === "BASELINE_ONLY");
    return {
      sessionDate,
      evaluated: s.length,
      baselineAdmits: s.filter((r) => r.baselineAdmitted).length,
      experimentAdmits: s.filter((r) => r.experimentAdmitted).length,
      closed: s.filter((r) => r.outcomeStatus === "CLOSED").length,
      winnersRejected: baselineOnly.filter((r) => r.outcomeStatus === "CLOSED" && (r.returnPct ?? 0) > 0).length,
      lossesAvoided: baselineOnly.filter((r) => r.outcomeStatus === "CLOSED" && r.returnPct != null && r.returnPct <= 0).length,
    };
  });

  // Advance at most ONE legal step toward the verdict's target.
  //
  // Reaching READY_FOR_HUMAN_REVIEW therefore requires the verdict to survive TWO consecutive
  // weekly reviews — PAPER_VALIDATION -> PROMISING one week, PROMISING -> READY the next. That
  // is deliberate: asking a human to look at a rule derived from 20 trades should cost more than
  // one good week, and a verdict is evidence, not permission to skip the ladder. Losing states
  // (FAILED, DEMOTED) are reachable in one step from anywhere that has evidence, so the
  // experiment can always fail faster than it can be promoted.
  let statusChanged = false;
  const target: ExperimentStatus | null =
    verdict.verdict === "FAILED" ? "FAILED"
    : verdict.verdict === "DEMOTE" ? "DEMOTED"
    : verdict.verdict === "PROMISING" ? "PROMISING"
    : verdict.verdict === "READY_FOR_HUMAN_REVIEW" ? "READY_FOR_HUMAN_REVIEW"
    : null;
  const step: ExperimentStatus | null = (() => {
    if (!target || !statusBefore) return null;
    // Already there: a repeated verdict is not a new event. Without this the intermediate hop
    // below would fire on READY_FOR_HUMAN_REVIEW and walk the experiment BACK to PROMISING,
    // oscillating between the two every week the verdict held.
    if (statusBefore === target) return null;
    if (canTransition(statusBefore, target)) return target;
    // One intermediate hop, and only FORWARD along the promotion ladder.
    if (target === "READY_FOR_HUMAN_REVIEW" && statusBefore === "PAPER_VALIDATION") return "PROMISING";
    return null;
  })();
  if (frozen.frozen && step) {
    try {
      const r = recordStatusOnDb(db, {
        experimentId: LHC_SELECT_V1.experimentId,
        experimentVersion: LHC_SELECT_V1.experimentVersion,
        status: step,
        reason: step === target
          ? verdict.reason
          : `${verdict.reason} (advancing one step to ${step}; ${target} requires the verdict to hold another week)`,
        evidence: {
          closedOutcomes: scoreboard.experiment.n,
          sessionsObserved: scoreboard.sessionsObserved,
          profitFactor: scoreboard.experiment.profitFactor,
          profitFactorExTopWinner: scoreboard.experimentExTopWinner.profitFactor,
          winnersRejected: scoreboard.winnersRejected.length,
          lossesAvoided: scoreboard.lossesAvoided.length,
        },
        actor: "deterministic",
      }, nowMs);
      statusChanged = r.recorded;
    } catch { /* isolated */ }
  }

  const budget = buildAiBudgetReportOnDb(db, { nowMs, monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null });
  const findings = (() => { try { return listFindingsOnDb(db, { strategy: "lower_high_continuation" }).length; } catch { return 0; } })();

  return {
    ran: true,
    weekKey: opts.weekKey,
    productionBehaviorChanged: false,
    experimentFrozen: frozen.frozen,
    experimentFrozenMessage: frozen.message,
    statusBefore,
    statusAfter: currentStatusOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion),
    statusChanged,
    scoreboard,
    verdict,
    perSession,
    findings,
    budget,
    report: formatWeeklyResearchReport({ scoreboard, verdict, perSession, budget, frozen }),
  };
}

function fmt(v: number | null): string { return v == null ? "n/a" : v.toFixed(3); }
function pct(v: number | null): string { return v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`; }

/** PURE. Every value comes from the deterministic scoreboard, never from a model. */
export function formatWeeklyResearchReport(i: {
  scoreboard: ProspectiveScoreboard;
  verdict: { verdict: WeeklyVerdict; reason: string };
  perSession: WeeklyResearchResult["perSession"];
  budget: AiBudgetReport;
  frozen: { frozen: boolean; message: string };
}): string[] {
  const s = i.scoreboard;
  const lines: string[] = [
    `**WEEKLY RESEARCH — ${s.experimentId} v${s.experimentVersion}**`,
  ];
  if (!i.frozen.frozen) lines.push(`⚠️ ${i.frozen.message}`);

  lines.push(
    `Independent prospective sessions: ${s.sessionsObserved}`,
    `Evaluated ${s.opportunitiesEvaluated} | baseline admitted ${s.baselineAdmits} | V1 admitted ${s.experimentAdmits}`,
    `Both admit ${s.bothAdmit} · baseline only ${s.baselineOnly} · V1 only ${s.experimentOnly} · both reject ${s.bothReject}`,
    `Closed ${s.closedOutcomes} | open ${s.openOutcomes} | ungradable ${s.ungradableOutcomes}`,
  );

  // Reported before anything flattering.
  lines.push(
    s.winnersRejected.length
      ? `⚠️ Winner rejection: ${s.winnersRejected.length} baseline winner(s) V1 threw away — ` +
        s.winnersRejected.map((w) => `${w.symbol} ${pct(w.returnPct)} [${w.blockedBy.join(",")}]`).join(", ")
      : `Winner rejection: 0 of ${s.winnersRetained.length + s.winnersRejected.length} baseline winner(s).`,
    `Losses avoided: ${s.lossesAvoided.length} | winners retained: ${s.winnersRetained.length} | ` +
      `V1-only winners recovered: ${s.experimentOnlyWinners.length} (cost: ${s.experimentOnlyLosses.length} loss(es))`,
    `Expectancy — baseline ${pct(s.baseline.expectancyPct)} vs V1 ${pct(s.experiment.expectancyPct)}`,
    `Profit factor — baseline ${fmt(s.baseline.profitFactor)} vs V1 ${fmt(s.experiment.profitFactor)}`,
    `Tail: top winner ${pct(s.tailDependence.topWinnerReturnPct)}, ` +
      `share of gross ${s.tailDependence.topWinnerShareOfGross == null ? "n/a" : `${(s.tailDependence.topWinnerShareOfGross * 100).toFixed(1)}%`}; ` +
      `PF without it ${fmt(s.tailDependence.profitFactorWithoutTopWinner)}; capped at +60% ${fmt(s.tailDependence.profitFactorCappedAt60)}`,
  );

  if (i.perSession.length) {
    lines.push(
      "Per session: " + i.perSession
        .map((p) => `${p.sessionDate} ${p.experimentAdmits}/${p.baselineAdmits} admits, ${p.closed} closed, ${p.winnersRejected}WR/${p.lossesAvoided}LA`)
        .join(" · "),
    );
  }

  lines.push(
    `Evidence quality: ${s.evidenceQuality.verdict} — ${s.evidenceQuality.verdictReason}`,
    `VERDICT: ${i.verdict.verdict} — ${i.verdict.reason}`,
    s.honestSummary,
  );

  lines.push(
    `AI budget: $${i.budget.estimatedMonthlySpendUsd.toFixed(2)} spent this month` +
      (i.budget.monthlyBudgetUsd != null ? ` of $${i.budget.monthlyBudgetUsd.toFixed(2)} (remaining $${(i.budget.budgetRemainingUsd ?? 0).toFixed(2)})` : "") +
      ` · nightly ${i.budget.nightlyRequests} · weekly ${i.budget.weeklyRequests} · skipped for budget ${i.budget.skippedForBudget}`,
    "Budget exhaustion stops optional AI reasoning only. Scanner, owner Discord, paper mirror, " +
      "marks, lifecycle, grading, Evidence Learning capture, readiness and deterministic experiment " +
      "tracking are never gated on it.",
  );

  return lines;
}

/**
 * The compact evidence block handed to the existing AI. Deliberately small: the AI receives
 * values that already exist and is asked to interpret them, never to produce a figure. The
 * caveats travel with the numbers.
 */
export function buildAiResearchContext(db: WeeklyDb, opts: { nowMs?: number } = {}): {
  experiment: Record<string, unknown>;
  scoreboard: Record<string, unknown>;
  findings: { findingId: string; statement: string; limitations: readonly string[]; mustNotBeSummarizedAs: string | null }[];
  instructions: string[];
} {
  const rows = listShadowDecisionsOnDb(db, { experimentId: LHC_SELECT_V1.experimentId });
  const s = buildProspectiveScoreboard(rows);
  const findings = (() => {
    try { return listFindingsOnDb(db, { strategy: "lower_high_continuation" }); } catch { return []; }
  })();

  return {
    experiment: {
      experimentId: LHC_SELECT_V1.experimentId,
      version: LHC_SELECT_V1.experimentVersion,
      status: currentStatusOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion),
      mode: LHC_SELECT_V1.mode,
      historicalResult: LHC_SELECT_V1.historicalResult,
      robustnessCaveats: LHC_SELECT_V1.robustnessCaveats,
      statusHistory: statusHistoryOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion),
    },
    scoreboard: {
      sessionsObserved: s.sessionsObserved,
      opportunitiesEvaluated: s.opportunitiesEvaluated,
      arms: { bothAdmit: s.bothAdmit, baselineOnly: s.baselineOnly, experimentOnly: s.experimentOnly, bothReject: s.bothReject },
      closedOutcomes: s.closedOutcomes,
      openOutcomes: s.openOutcomes,
      baseline: s.baseline,
      experiment: s.experiment,
      experimentExTopWinner: s.experimentExTopWinner,
      tailDependence: s.tailDependence,
      winnersRejected: s.winnersRejected,
      evidenceQuality: s.evidenceQuality,
      honestSummary: s.honestSummary,
    },
    findings: findings.map((f) => ({
      findingId: f.findingId,
      statement: f.statement,
      limitations: f.limitations,
      mustNotBeSummarizedAs: f.mustNotBeSummarizedAs,
    })),
    instructions: [
      "Every figure above is already computed. Do not produce a number that is not in this payload.",
      "Expectancy and profit factor are from CLOSED outcomes only. Open positions have no result.",
      "Never describe LHC_SELECT_V1 as working, validated, or ready. It is PROMISING and UNVALIDATED.",
      "If closedOutcomes is 0, there is no prospective result — say so rather than reporting the historical one as if it were prospective.",
      "Report winners rejected before losses avoided.",
      "You may propose SHADOW or PAPER_VALIDATION experiments. You may not change a live threshold, " +
        "select a live trade, alter subscriber readiness, approve a subscriber strategy, send an alert, " +
        "deploy code, or rewrite a historical outcome.",
    ],
  };
}
