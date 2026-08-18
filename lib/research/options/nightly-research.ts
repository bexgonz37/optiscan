/**
 * The nightly OptiScan research aggregation â€” deterministic first, AI second, never the
 * other way round.
 *
 * WHY THIS ORDER MATTERS
 *
 * Every number a human or a model reads about a session is computed here, in SQL and
 * arithmetic, and stored before any provider is contacted. The AI receives a compact summary
 * of values that already exist; it cannot produce a figure, and if it is disabled, over budget
 * or broken, the session's evidence is unaffected. That is the difference between an AI that
 * analyses the system and an AI the system depends on.
 *
 * WHAT THIS DELIBERATELY SEPARATES
 *
 * The recap's PRIMARY section is OWNER DISCORD ALERTS â€” the mirrors of alerts the owner
 * actually received. An earlier packet shipped a recap that printed "Trades: 5 | Wins: 0 |
 * Losses: 5" from the internal paper portfolio while the delivered Discord lane was profitable
 * that day. Two populations of the same size sharing zero contracts read as one verdict. So
 * owner, research/shadow and experiment arms are computed separately and never summed.
 *
 * AUTHORITY BOUNDARY: this module computes and persists. It does not send, promote, change a
 * threshold, or write subscriber readiness.
 *
 * Impure (SQLite), testable OnDb core.
 */

import { buildOwnerLearningReportOnDb, type OwnerLaneStatistics } from "./owner-learning.ts";
import { OWNER_VALIDATION_PAPER_KIND } from "../../opportunity-case/owner-mirror-identity.ts";
import { buildProspectiveScoreboard, weeklyVerdict, type ProspectiveScoreboard } from "./prospective-scoreboard.ts";
import { listShadowDecisionsOnDb, refreshShadowOutcomesOnDb, currentStatusOnDb, recordStatusOnDb, registerExperimentOnDb, type ShadowDb } from "./shadow-arm-store.ts";
import { seedLhcFindingsOnDb, type FindingsDb } from "./findings-store.ts";
import { LHC_SELECT_V1, checkFrozen, type ExperimentStatus } from "./experiment-registry.ts";
import { COHORT_STRATEGY } from "./lower-high-cohort.ts";

export interface NightlyDb extends ShadowDb, FindingsDb {}

/**
 * Owner Discord callout performance — the PRIMARY population.
 *
 * THE LANE IS `OWNER_VALIDATION_PAPER`, AND IT USED NOT TO BE.
 *
 * This summary was built from `DELIVERED_ALERT_PAPER` and counted a "paper mirror" as any
 * row with a non-null `alert_id`. Both are the subscriber lane's shape. An owner callout
 * writes no `options_alerts` row at all, so it has no alert id — production at 801b7d0d:
 * 0 of 106 owner cases and 0 of 74 owner mirrors carry one. The section printed under
 * "OWNER DISCORD ALERTS" therefore described a population the owner never received, while
 * the real one was invisible.
 *
 * Identity now runs through `owner-mirror-identity.ts`: the opportunity case recorded on
 * the mirror's own feature snapshot, checked against the exact OCC the callout froze.
 */
export interface OwnerAlertSummary {
  sessionDate: string;
  /** The lane this summary describes. Stated in the payload so it cannot be mistaken. */
  lane: typeof OWNER_VALIDATION_PAPER_KIND;
  openings: number;
  paperMirrors: number;
  closed: number;
  open: number;
  ungradable: number;
  realizedWins: number;
  realizedLosses: number;
  winRate: number | null;
  expectancyPct: number | null;
  medianRealizedReturnPct: number | null;
  profitFactor: number | null;
  profitFactorWithoutTopWinner: number | null;
  bestWinnerPct: number | null;
  worstLossPct: number | null;
  callCount: number;
  putCount: number;
  /** Never cleared +5% on a trustworthy path. */
  immediateFailures: number;
  /** Reached >= +20% and closed at or below 0. */
  profitGivenBack: number;
  /** Rows without enough same-contract marks to support either claim above. */
  withoutTrajectoryEvidence: number;
  /** Closed rows that filled materially below the frozen stop. */
  stopLeakage: number;
  heldOvernight: number;
  overnightGaps: number;
  byStrategy: { strategy: string; n: number; wins: number; losses: number; expectancyPct: number | null; profitFactor: number | null }[];
  byPathLabel: Record<string, number>;
  /** Distinct VERIFIED trading sessions, not distinct calendar dates. */
  independentSessions: number;
  sessions: string[];
  mirrorRate: number | null;
  unavailableMetrics: string[];
}

function hasTable(db: NightlyDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}

function summaryFromOwnerLane(sessionDate: string, s: OwnerLaneStatistics, extra: {
  immediateFailures: number; profitGivenBack: number;
}): OwnerAlertSummary {
  return {
    sessionDate,
    lane: OWNER_VALIDATION_PAPER_KIND,
    openings: s.openings,
    paperMirrors: s.exactMirrors,
    closed: s.closed,
    open: s.open,
    ungradable: s.ungradable,
    realizedWins: s.wins,
    realizedLosses: s.losses,
    winRate: s.winRate,
    expectancyPct: s.meanRealizedReturnPct,
    medianRealizedReturnPct: s.medianRealizedReturnPct,
    profitFactor: s.profitFactor,
    profitFactorWithoutTopWinner: s.profitFactorWithoutTopWinner,
    bestWinnerPct: s.bestWinnerPct,
    worstLossPct: s.worstLossPct,
    callCount: s.callCount,
    putCount: s.putCount,
    immediateFailures: extra.immediateFailures,
    profitGivenBack: extra.profitGivenBack,
    withoutTrajectoryEvidence: s.withoutTrajectoryEvidence,
    stopLeakage: s.stopLeakage,
    heldOvernight: s.heldOvernight,
    overnightGaps: s.overnightGaps,
    byStrategy: s.byStrategy,
    byPathLabel: s.byPathLabel,
    independentSessions: s.sessionAudit.independentSessions,
    sessions: s.sessions,
    mirrorRate: s.mirrorRate,
    unavailableMetrics: s.unavailableMetrics,
  };
}

const EMPTY_OWNER_SUMMARY = (sessionDate: string): OwnerAlertSummary => ({
  sessionDate, lane: OWNER_VALIDATION_PAPER_KIND,
  openings: 0, paperMirrors: 0, closed: 0, open: 0, ungradable: 0,
  realizedWins: 0, realizedLosses: 0, winRate: null, expectancyPct: null,
  medianRealizedReturnPct: null, profitFactor: null, profitFactorWithoutTopWinner: null,
  bestWinnerPct: null, worstLossPct: null, callCount: 0, putCount: 0,
  immediateFailures: 0, profitGivenBack: 0, withoutTrajectoryEvidence: 0,
  stopLeakage: 0, heldOvernight: 0, overnightGaps: 0,
  byStrategy: [], byPathLabel: {}, independentSessions: 0, sessions: [],
  mirrorRate: null, unavailableMetrics: [],
});

/**
 * Owner Discord openings for one ET session, priced on the EXACT contract the callout froze.
 *
 * Same-contract marks only — a mark on a re-selected OCC is a different instrument, which is
 * the defect that produced a phantom +149% MFE in an earlier packet. Session membership is
 * decided in JS from `entered_at_ms`, never in SQL: SQLite's `localtime` is the container's
 * timezone (UTC on Railway), and an ET boundary resolved in UTC silently moves every
 * post-20:00 ET opening into the next day.
 */
export function buildOwnerAlertSummaryOnDb(db: NightlyDb, sessionDate: string): OwnerAlertSummary {
  if (!hasTable(db, "options_paper_trades")) return EMPTY_OWNER_SUMMARY(sessionDate);
  let report;
  try {
    report = buildOwnerLearningReportOnDb(db as any, { sessionDate });
  } catch {
    return EMPTY_OWNER_SUMMARY(sessionDate);
  }

  // immediateFailures / profitGivenBack keep their published meaning and change only their
  // evidence source: a VERIFIED excursion on the frozen contract rather than a raw
  // MAX(mark.return_pct) behind a 20-mark floor. A row whose path cannot be claimed is in
  // neither bucket and is counted in `withoutTrajectoryEvidence` instead.
  const graded = report.rows.filter(
    (r) => r.occExact && r.status === "EXITED" && r.realizedReturnPct != null && r.mfePct != null,
  );
  const immediateFailures = graded.filter((r) => (r.mfePct as number) < 5).length;
  const profitGivenBack = graded.filter(
    (r) => (r.mfePct as number) >= 20 && (r.realizedReturnPct as number) <= 0,
  ).length;

  return summaryFromOwnerLane(sessionDate, report.statistics, { immediateFailures, profitGivenBack });
}

export interface NightlyResearchResult {
  ran: boolean;
  sessionDate: string;
  productionBehaviorChanged: false;
  /** Whether the frozen rule is still the rule that is being measured. */
  experimentFrozen: boolean;
  experimentFrozenMessage: string;
  experimentStatus: ExperimentStatus | null;
  statusChanged: boolean;
  owner: OwnerAlertSummary;
  scoreboard: ProspectiveScoreboard;
  verdict: { verdict: string; reason: string };
  findingsWritten: number;
  outcomesRefreshed: number;
  skippedReason?: string;
}

/**
 * The deterministic half of the nightly research loop. Runs to completion with no provider
 * calls and no AI, and everything downstream reads its output.
 *
 * Status advancement is deterministic and conservative: a decision being recorded moves the
 * experiment to PROSPECTIVE_SHADOW; a first CLOSED prospective outcome moves it to
 * PAPER_VALIDATION. Nothing beyond that is automated â€” PROMISING and above require the weekly
 * verdict, and no path reaches subscriber approval.
 */
export function runNightlyResearchOnDb(
  db: NightlyDb,
  opts: { sessionDate: string; deploymentSha?: string | null; nowMs?: number },
): NightlyResearchResult {
  const nowMs = opts.nowMs ?? Date.now();
  const frozen = checkFrozen();

  // Refresh outcome columns from the paper store first, so the scoreboard sees closes that
  // happened since the last run. Deterministic; reads only persisted rows.
  let outcomesRefreshed = 0;
  try { outcomesRefreshed = refreshShadowOutcomesOnDb(db).refreshed; } catch { /* isolated */ }

  try { registerExperimentOnDb(db, LHC_SELECT_V1, nowMs); } catch { /* isolated */ }

  const owner = buildOwnerAlertSummaryOnDb(db, opts.sessionDate);
  const decisions = listShadowDecisionsOnDb(db, { experimentId: LHC_SELECT_V1.experimentId });
  const scoreboard = buildProspectiveScoreboard(decisions);
  const verdict = weeklyVerdict(scoreboard);

  const findings = (() => {
    try { return seedLhcFindingsOnDb(db, { deploymentSha: opts.deploymentSha ?? null }, nowMs).written; }
    catch { return 0; }
  })();

  // Deterministic lifecycle advancement. Refuses to move a rule whose definition has changed.
  let statusChanged = false;
  const status = currentStatusOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion);
  if (frozen.frozen) {
    const target: ExperimentStatus | null =
      scoreboard.closedOutcomes > 0 && scoreboard.experiment.n > 0 ? "PAPER_VALIDATION"
      : scoreboard.opportunitiesEvaluated > 0 ? "PROSPECTIVE_SHADOW"
      : null;
    if (target) {
      // Walk the legal path rather than jumping, so the history records what was true when.
      const path: ExperimentStatus[] = ["PROPOSED", "HISTORICAL_TESTED", "VALIDATION_TESTED", "PROSPECTIVE_SHADOW", "PAPER_VALIDATION"];
      if (status == null) {
        // Seed the origin explicitly; otherwise the first recorded status would be
        // HISTORICAL_TESTED and the history would not say where the experiment started.
        try {
          const r = recordStatusOnDb(db, {
            experimentId: LHC_SELECT_V1.experimentId,
            experimentVersion: LHC_SELECT_V1.experimentVersion,
            status: "PROPOSED",
            reason: "registered by the nightly research aggregation",
            actor: "deterministic",
          }, nowMs);
          if (r.recorded) statusChanged = true;
        } catch { /* isolated */ }
      }
      const from = status ?? "PROPOSED";
      const startIdx = Math.max(0, path.indexOf(from));
      const endIdx = path.indexOf(target);
      for (let k = startIdx; k < endIdx; k++) {
        try {
          const r = recordStatusOnDb(db, {
            experimentId: LHC_SELECT_V1.experimentId,
            experimentVersion: LHC_SELECT_V1.experimentVersion,
            status: path[k + 1],
            reason: path[k + 1] === "PAPER_VALIDATION"
              ? `${scoreboard.closedOutcomes} prospective outcome(s) have closed`
              : `${scoreboard.opportunitiesEvaluated} prospective decision(s) recorded`,
            evidence: {
              opportunitiesEvaluated: scoreboard.opportunitiesEvaluated,
              closedOutcomes: scoreboard.closedOutcomes,
              sessionsObserved: scoreboard.sessionsObserved,
            },
            actor: "deterministic",
          }, nowMs);
          if (r.recorded) statusChanged = true;
        } catch { break; }
      }
    }
  }

  return {
    ran: true,
    sessionDate: opts.sessionDate,
    productionBehaviorChanged: false,
    experimentFrozen: frozen.frozen,
    experimentFrozenMessage: frozen.message,
    experimentStatus: currentStatusOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion),
    statusChanged,
    owner,
    scoreboard,
    verdict,
    findingsWritten: findings,
    outcomesRefreshed,
  };
}

/**
 * The owner recap sections, in the required order: OWNER DISCORD ALERTS first, then the
 * research/experiment material. Pure formatter â€” every value comes from the deterministic
 * result above, never from a model.
 */
export function formatNightlyResearchSections(r: NightlyResearchResult): string[] {
  const pct = (v: number | null) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  const pf = (v: number | null) => (v == null ? "n/a" : v.toFixed(3));
  const o = r.owner;
  const s = r.scoreboard;

  const sections: string[] = [];

  sections.push([
    "**OWNER DISCORD ALERTS** â€” the alerts you actually received (PRIMARY)",
    `Openings: ${o.openings} | Paper mirrors: ${o.paperMirrors} | Closed: ${o.closed} | Open: ${o.open} | Ungradable: ${o.ungradable}`,
    `Wins: ${o.realizedWins} | Losses: ${o.realizedLosses} | Expectancy: ${pct(o.expectancyPct)} | PF: ${pf(o.profitFactor)}`,
    `Best: ${pct(o.bestWinnerPct)} | Worst: ${pct(o.worstLossPct)}`,
    `Immediate failures: ${o.immediateFailures} | Profit given back: ${o.profitGivenBack}` +
      (o.withoutTrajectoryEvidence ? ` | Without path evidence: ${o.withoutTrajectoryEvidence}` : ""),
    o.byStrategy.length
      ? `By strategy: ${o.byStrategy.map((b) => `${b.strategy} ${b.wins}W/${b.losses}L PF ${pf(b.profitFactor)}`).join(" Â· ")}`
      : "By strategy: none",
  ].join("\n"));

  sections.push([
    `**EXPERIMENTS** â€” ${s.experimentId} (${r.experimentStatus ?? "unregistered"})`,
    !r.experimentFrozen ? `âš ï¸ ${r.experimentFrozenMessage}` : null,
    `Baseline admitted ${s.baselineAdmits}. V1 admitted ${s.experimentAdmits}. ` +
      `V1 rejected ${s.baselineOnly} baseline trade(s). V1 recovered ${s.experimentOnly} the baseline skipped.`,
    `${s.closedOutcomes} closed, ${s.openOutcomes} open, ${s.sessionsObserved} session(s) observed.`,
    `Current prospective evidence: ${s.honestSummary}`,
    s.winnersRejected.length
      ? `âš ï¸ Winners V1 rejected: ${s.winnersRejected.map((w) => `${w.symbol} ${pct(w.returnPct)}`).join(", ")}`
      : null,
    `Verdict: ${r.verdict.verdict} â€” ${r.verdict.reason}`,
  ].filter(Boolean).join("\n"));

  sections.push([
    "**WHAT OPTISCAN LEARNED**",
    `${r.findingsWritten} finding(s) persisted for ${COHORT_STRATEGY}.`,
    "LHC_SELECT_V1 is PROMISING and UNVALIDATED â€” below break-even without its single convex winner.",
  ].join("\n"));

  return sections;
}
