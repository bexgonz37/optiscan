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

import { buildProspectiveScoreboard, weeklyVerdict, type ProspectiveScoreboard } from "./prospective-scoreboard.ts";
import { listShadowDecisionsOnDb, refreshShadowOutcomesOnDb, currentStatusOnDb, recordStatusOnDb, registerExperimentOnDb, type ShadowDb } from "./shadow-arm-store.ts";
import { seedLhcFindingsOnDb, type FindingsDb } from "./findings-store.ts";
import { LHC_SELECT_V1, checkFrozen, type ExperimentStatus } from "./experiment-registry.ts";
import { COHORT_STRATEGY } from "./lower-high-cohort.ts";

export interface NightlyDb extends ShadowDb, FindingsDb {}

/** Owner Discord alert performance â€” the PRIMARY population. Closed outcomes only. */
export interface OwnerAlertSummary {
  sessionDate: string;
  openings: number;
  paperMirrors: number;
  closed: number;
  open: number;
  ungradable: number;
  realizedWins: number;
  realizedLosses: number;
  expectancyPct: number | null;
  profitFactor: number | null;
  bestWinnerPct: number | null;
  worstLossPct: number | null;
  /** Never cleared +5% on a trustworthy path. */
  immediateFailures: number;
  /** Reached >= +20% and closed at or below 0. */
  profitGivenBack: number;
  /** Rows without enough same-contract marks to support either claim above. */
  withoutTrajectoryEvidence: number;
  byStrategy: { strategy: string; n: number; wins: number; losses: number; expectancyPct: number | null; profitFactor: number | null }[];
  mirrorRate: number | null;
}

const MIN_MARKS = 20;

function hasTable(db: NightlyDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}

function stats(returns: number[]): { expectancyPct: number | null; profitFactor: number | null } {
  if (!returns.length) return { expectancyPct: null, profitFactor: null };
  const w = returns.filter((x) => x > 0);
  const l = returns.filter((x) => x <= 0);
  const gross = w.reduce((s, x) => s + x, 0);
  const lossSum = -l.reduce((s, x) => s + x, 0);
  return {
    expectancyPct: returns.reduce((s, x) => s + x, 0) / returns.length,
    profitFactor: lossSum > 0 ? gross / lossSum : null,
  };
}

/**
 * Owner Discord openings for one ET session, priced on the EXACT contract the alert froze.
 * Same-contract marks only â€” a mark on a re-selected OCC is a different instrument, which is
 * the defect that produced a phantom +149% MFE in an earlier packet.
 */
export function buildOwnerAlertSummaryOnDb(db: NightlyDb, sessionDate: string): OwnerAlertSummary {
  const empty: OwnerAlertSummary = {
    sessionDate, openings: 0, paperMirrors: 0, closed: 0, open: 0, ungradable: 0,
    realizedWins: 0, realizedLosses: 0, expectancyPct: null, profitFactor: null,
    bestWinnerPct: null, worstLossPct: null, immediateFailures: 0, profitGivenBack: 0,
    withoutTrajectoryEvidence: 0, byStrategy: [], mirrorRate: null,
  };
  if (!hasTable(db, "options_paper_trades")) return empty;

  // Session membership is decided in JS, not SQL: SQLite's `localtime` is the container's
  // timezone (UTC on Railway), and an ET session boundary resolved in UTC silently moves every
  // post-20:00 ET opening into the next day.
  let rows: any[] = [];
  try {
    const all = db.prepare(
      `SELECT t.id, t.strategy, t.status, t.return_pct, t.option_symbol, t.alert_id, t.entered_at_ms,
              (SELECT COUNT(*) FROM options_paper_marks m WHERE m.trade_id=t.id AND m.option_symbol=t.option_symbol) marks,
              (SELECT MAX(m.return_pct) FROM options_paper_marks m WHERE m.trade_id=t.id AND m.option_symbol=t.option_symbol) peak
         FROM options_paper_trades t
        WHERE t.paper_kind='DELIVERED_ALERT_PAPER' AND t.entered_at_ms IS NOT NULL`,
    ).all() as any[];
    rows = all.filter(
      (r) => new Date(r.entered_at_ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === sessionDate,
    );
  } catch { return empty; }

  const closedRows = rows.filter((r) => r.status === "EXITED" && r.return_pct != null);
  const returns = closedRows.map((r) => Number(r.return_pct));
  const { expectancyPct, profitFactor } = stats(returns);
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);

  const trustworthy = closedRows.filter((r) => Number(r.marks ?? 0) >= MIN_MARKS && r.peak != null);
  const byStrategyMap = new Map<string, number[]>();
  for (const r of closedRows) {
    const k = r.strategy ?? "unknown";
    const list = byStrategyMap.get(k) ?? [];
    list.push(Number(r.return_pct));
    byStrategyMap.set(k, list);
  }

  return {
    sessionDate,
    openings: rows.length,
    paperMirrors: rows.filter((r) => r.alert_id != null).length,
    closed: closedRows.length,
    open: rows.filter((r) => r.status !== "EXITED").length,
    ungradable: rows.filter((r) => r.status === "EXITED" && r.return_pct == null).length,
    realizedWins: wins.length,
    realizedLosses: losses.length,
    expectancyPct,
    profitFactor,
    bestWinnerPct: wins.length ? Math.max(...wins) : null,
    worstLossPct: losses.length ? Math.min(...losses) : null,
    immediateFailures: trustworthy.filter((r) => Number(r.peak) < 5).length,
    profitGivenBack: trustworthy.filter((r) => Number(r.peak) >= 20 && Number(r.return_pct) <= 0).length,
    withoutTrajectoryEvidence: closedRows.length - trustworthy.length,
    byStrategy: [...byStrategyMap.entries()].map(([strategy, rs]) => ({
      strategy, n: rs.length,
      wins: rs.filter((x) => x > 0).length,
      losses: rs.filter((x) => x <= 0).length,
      ...stats(rs),
    })).sort((a, b) => b.n - a.n),
    mirrorRate: rows.length ? rows.filter((r) => r.alert_id != null).length / rows.length : null,
  };
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
