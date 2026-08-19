/**
 * research-command-center.ts — one deterministic read for the private research view.
 *
 * The owner should be able to open ONE page and understand where the system stands
 * without reading JSON. This assembles that page's evidence from the canonical
 * builders that already exist — the owner learning report, the historical cohort gate,
 * the frozen experiment's scoreboard, the exit-risk observations, the findings store
 * and PRE_MOVE_DISCOVERY_V2. Nothing here recomputes a statistic that a canonical
 * builder already owns, because two implementations of profit factor is how two
 * surfaces start disagreeing about one trade.
 *
 * ── The distinction the panel is built around ─────────────────────────────────
 *
 * OPENED TODAY and CLOSED TODAY are different populations and are never summed.
 * A callout opened on Monday and closed on Wednesday belongs to Monday's openings and
 * Wednesday's closes, and 42 of 74 owner callouts in production cross a session
 * boundary — so a single "today" number would be wrong for more than half the lane.
 * Today's win rate is computed over trades that CLOSED today, because a trade that has
 * not closed has no result to win or lose, and counting open positions at 0% prices an
 * unfinished trade as a scratch.
 *
 * ── What this module refuses to do ────────────────────────────────────────────
 *
 * It never labels owner-validation evidence as subscriber performance, never presents
 * a shadow experiment's arm as a live result, and never reports a rate without the
 * denominator underneath it. Every population carries its own label, date range,
 * session count and evidence state, because the same profit factor means opposite
 * things over 6 trades and over 60.
 *
 * Reads persisted evidence only. No provider call, no write, no send authority, and
 * nothing here is consulted by a scanner rule, threshold, ranking weight, contract
 * choice, target, stop, exit or subscriber decision.
 */
import { buildOwnerLearningReportOnDb, type OwnerLearningDb, type OwnerLearningRow } from "./owner-learning.ts";
import { buildOwnerSelectionStrengthScoreboardOnDb } from "./owner-selection-strength-scoreboard.ts";
import { buildCohortStatisticsOnDb } from "./cohort-probability.ts";
import { buildExitRiskObservationsOnDb } from "./exit-risk-loader.ts";
import { listFindingsOnDb } from "./findings-store.ts";
import { buildPreMoveV2Report } from "./pre-move-v2-report.ts";
import { OWNER_VALIDATION_PAPER_KIND } from "../../opportunity-case/owner-mirror-identity.ts";
import { tradingDay } from "../../trading-session.ts";

export const RESEARCH_COMMAND_CENTER_VERSION = "RESEARCH_COMMAND_CENTER_V1";

/** Every metric key here must exist in `lib/metric-glossary.ts`. A test pins that. */
export interface TodayPanel {
  sessionDate: string;
  /** Callouts whose Discord opening was sent today. */
  openedToday: number;
  /** Callouts that CLOSED today, whenever they were opened. A different population. */
  closedToday: number;
  /** Of those that closed today. Open trades have no result and are not counted. */
  wins: number;
  losses: number;
  /** Callouts still open right now, opened on any day. */
  openNow: number;

  winRate: number | null;
  expectancyPct: number | null;
  profitFactor: number | null;
  meanReturnPct: number | null;
  medianReturnPct: number | null;

  /** How many of today's closes were opened on an earlier session. */
  closedTodayOpenedEarlier: number;
  note: string;
}

export interface CurrentEdgePanel {
  population: string;
  sampleSize: number;
  independentSessions: number;
  dateRange: { from: string | null; to: string | null };
  evidenceState: string;
  /** The probabilities are gated separately and more strictly than the realized figures. */
  excursionEvidenceState: string;

  profitFactor: number | null;
  expectancyPct: number | null;
  medianReturnPct: number | null;
  winRate: number | null;
  profitFactorExBest: number | null;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  /** Expected excursion, from the cohort's VERIFIED excursion sample only. */
  expectedMfePct: number | null;
  expectedMaePct: number | null;

  probabilities: Record<string, { rate: number | null; reached: number; of: number }>;
  /** Stated on the panel itself so the figure cannot travel without it. */
  notSubscriberPerformance: true;
  limitations: string[];
}

export interface ShadowExperimentPanel {
  experimentId: string;
  experimentVersion: number;
  mode: string;
  definitionHash: string;
  definitionFrozen: boolean;
  prospectiveStartDate: string;

  status: string;
  statusReason: string;
  prospectiveClosedOutcomes: number;
  requiredClosedOutcomes: number;
  independentSessions: number;
  requiredIndependentSessions: number;

  baseline: { profitFactor: number | null; expectancyPct: number | null; medianReturnPct: number | null; winRate: number | null; sampleSize: number };
  shadow: { profitFactor: number | null; expectancyPct: number | null; medianReturnPct: number | null; winRate: number | null; sampleSize: number };

  winnerRetention: number | null;
  lossRejection: number | null;
  winnersRejected: number | null;
  profitFactorExBest: number | null;
  tailRobustness: string;

  /** Always true. Rendered as a banner, not as a footnote. */
  affectsLiveCallouts: false;
  authority: string;
  limitations: readonly string[];
}

export interface LearnedPanel {
  deterministicFindings: Array<{ key: string; title: string; statement: string; evidenceStrength: string; sampleSize: number | null; limitations: string[] }>;
  aiFindings: Array<{ key: string; title: string; statement: string; evidenceStrength: string; sampleSize: number | null; limitations: string[] }>;
  openQuestions: string[];
  insufficientEvidence: string[];
}

export interface RiskResearchPanel {
  cards: Array<{
    id: string;
    title: string;
    headline: string;
    detail: string;
    sampleSize: number | null;
    supported: boolean;
  }>;
  /** Stated explicitly: none of this is a rule, and none of it runs. */
  activeProfitProtectionPolicy: null;
  note: string;
}

/**
 * The readiness trajectory, grouped into the five things that are usually collapsed
 * into one "are we ready" question and answered as though they were.
 *
 * CHANGES NO READINESS RULE. Every threshold quoted here is read from the gate that
 * already owns it; nothing is redefined, relaxed or short-circuited, and no bucket can
 * be satisfied by anything on this page. A trading edge that looks good is not data
 * integrity, forward evidence is not operational readiness, and none of the five is
 * subscriber approval -- which remains a named human act taken elsewhere.
 */
export interface ReadinessTrajectoryPanel {
  buckets: Array<{
    id: "TRADING_EDGE" | "DATA_INTEGRITY" | "FORWARD_EVIDENCE" | "OPERATIONAL_READINESS" | "SUBSCRIBER_SETUP";
    title: string;
    facts: Array<{ label: string; value: string | number | null }>;
    blocking: string[];
  }>;
  /** Always false here. This panel cannot set it and no rule on this page can move it. */
  subscriberReady: false;
  humanApprovalRequired: true;
  note: string;
}

export interface ResearchCommandCenter {
  version: typeof RESEARCH_COMMAND_CENTER_VERSION;
  generatedAtMs: number;
  today: TodayPanel;
  currentEdge: CurrentEdgePanel;
  shadowExperiments: ShadowExperimentPanel[];
  learned: LearnedPanel;
  riskResearch: RiskResearchPanel;
  earlyDiscovery: ReturnType<typeof buildPreMoveV2Report>;
  /** V1's headline number, carried ONLY with the reason it cannot be read as earliness. */
  earlyDiscoveryV1Caveat: { stage: string; share: string; whyUnusable: string };
  readiness: ReadinessTrajectoryPanel;
  faults: string[];
}

const round = (v: number | null, p = 4): number | null => (v == null ? null : +v.toFixed(p));

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function profitFactor(returns: number[]): number | null {
  const gross = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const loss = Math.abs(returns.filter((r) => r <= 0).reduce((a, b) => a + b, 0));
  return loss > 0 ? round(gross / loss) : null;
}

/**
 * Today, split into the two populations that are usually collapsed into one.
 *
 * `openedToday` is keyed on the mirror's entry instant and `closedToday` on its exit
 * instant, both mapped through the Eastern trading-day helper rather than a UTC split —
 * a UTC boundary moves every post-20:00 ET entry into the next day, which silently
 * empties the last session of a report generated after the close.
 */
export function buildTodayPanel(rows: readonly OwnerLearningRow[], nowMs: number): TodayPanel {
  const today = tradingDay(nowMs);
  const dayOf = (ms: number | null): string | null => (ms == null ? null : tradingDay(ms));

  const openedToday = rows.filter((r) => dayOf(r.enteredAtMs) === today);
  const closedToday = rows.filter((r) => r.closedAtMs != null && dayOf(r.closedAtMs) === today);
  const openNow = rows.filter((r) => r.closedAtMs == null && r.realizedEvidence === "STILL_OPEN");

  // Results come from trades that CLOSED today. An open position has no result, and
  // counting it at 0% would price an unfinished trade as a scratch.
  const returns = closedToday
    .map((r) => r.realizedReturnPct)
    .filter((v): v is number => v != null);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);

  return {
    sessionDate: today,
    openedToday: openedToday.length,
    closedToday: closedToday.length,
    wins: wins.length,
    losses: losses.length,
    openNow: openNow.length,
    winRate: returns.length ? round(wins.length / returns.length) : null,
    expectancyPct: returns.length ? round(returns.reduce((a, b) => a + b, 0) / returns.length, 2) : null,
    profitFactor: profitFactor(returns),
    meanReturnPct: returns.length ? round(returns.reduce((a, b) => a + b, 0) / returns.length, 2) : null,
    medianReturnPct: round(median(returns), 2),
    closedTodayOpenedEarlier: closedToday.filter((r) => dayOf(r.enteredAtMs) !== today).length,
    note:
      "OPENED TODAY and CLOSED TODAY are different populations and are never summed. "
      + "Today's rates describe the trades that CLOSED today, whenever they were opened. "
      + "Open positions carry no result and are excluded rather than counted as scratches.",
  };
}

/** Build the whole panel set. Every section fails independently. */
export function buildResearchCommandCenterOnDb(
  db: OwnerLearningDb,
  opts: { nowMs?: number } = {},
): ResearchCommandCenter {
  const nowMs = opts.nowMs ?? Date.now();
  const faults: string[] = [];
  const safe = <T>(label: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (err: any) {
      faults.push(`${label}: ${String(err?.message ?? err).slice(0, 200)}`);
      return fallback;
    }
  };

  const learning = safe("ownerLearning", () => buildOwnerLearningReportOnDb(db, {}), null);
  const rows = learning?.rows ?? [];
  const stats = learning?.statistics ?? null;

  const today = safe("today", () => buildTodayPanel(rows, nowMs), {
    sessionDate: tradingDay(nowMs), openedToday: 0, closedToday: 0, wins: 0, losses: 0,
    openNow: 0, winRate: null, expectancyPct: null, profitFactor: null, meanReturnPct: null,
    medianReturnPct: null, closedTodayOpenedEarlier: 0,
    note: "owner learning unavailable",
  });

  // ── current edge ──────────────────────────────────────────────────────────
  const cohort = safe(
    "cohort",
    () => buildCohortStatisticsOnDb(db as any, { paperKind: OWNER_VALIDATION_PAPER_KIND } as any, {}),
    null,
  );
  const probs: CurrentEdgePanel["probabilities"] = {};
  for (const m of [10, 25, 50, 100]) {
    // `probability` is deliberately null unless the excursion sample clears BOTH floors.
    // The raw reached/of are still carried, so the panel can show "40/74, not yet
    // supported" rather than a bare blank that reads as "never happened".
    const p = cohort?.milestoneProbabilities?.find((x) => x.milestone === m) ?? null;
    probs[`P(+${m})`] = {
      rate: round(p?.probability ?? null),
      reached: p?.reached ?? 0,
      of: p?.of ?? 0,
    };
  }

  const currentEdge: CurrentEdgePanel = {
    population: stats?.lane ?? OWNER_VALIDATION_PAPER_KIND,
    sampleSize: stats?.closed ?? 0,
    independentSessions: stats?.sessionAudit?.independentSessions ?? stats?.sessions?.length ?? 0,
    dateRange: { from: stats?.dateRange?.from ?? null, to: stats?.dateRange?.to ?? null },
    // The REALIZED sample's verdict, because every headline figure on this panel is a
    // realized statistic. The excursion sample is a different, stricter gate and governs
    // only the probabilities below.
    evidenceState: cohort?.realizedSample?.verdict ?? "UNKNOWN",
    excursionEvidenceState: cohort?.excursionSample?.verdict ?? "UNKNOWN",
    profitFactor: stats?.profitFactor ?? null,
    expectancyPct: stats?.meanRealizedReturnPct ?? null,
    medianReturnPct: stats?.medianRealizedReturnPct ?? null,
    winRate: stats?.winRate ?? null,
    profitFactorExBest: stats?.profitFactorWithoutTopWinner ?? null,
    // From the COHORT, whose excursion figures are recomputed from same-contract marks.
    // The stored mfe_pct / mae_pct columns are wrong on 36 of 78 delivered cases and are
    // deliberately not read here.
    avgWinnerPct: cohort?.avgWinnerPct ?? null,
    avgLoserPct: cohort?.avgLoserPct ?? null,
    expectedMfePct: cohort?.expectedMfePct ?? null,
    expectedMaePct: cohort?.expectedMaePct ?? null,
    probabilities: probs,
    notSubscriberPerformance: true,
    limitations: [
      "OWNER VALIDATION / PAPER-TRACKED. These are the private callouts' own paper mirrors "
      + "on the exact contract called. NO SUBSCRIBER RECEIVED THESE TRADES and this is not "
      + "subscriber performance.",
      "Read the probabilities and the profit factor as two different claims. A lane that "
      + "touches +25% often and still returns a profit factor below 1 is a lane whose exit "
      + "gives back more than its selection captures.",
      ...(stats?.limitations ?? []),
    ],
  };

  // ── shadow experiments ────────────────────────────────────────────────────
  const shadowExperiments = safe<ShadowExperimentPanel[]>("shadow", () => {
    const sb = buildOwnerSelectionStrengthScoreboardOnDb(db as any, {});
    const sim = sb.prospective.simulation;
    const arm = (a: typeof sim.baseline) => ({
      profitFactor: a.profitFactor,
      expectancyPct: a.meanReturnPct,
      medianReturnPct: a.medianReturnPct,
      winRate: a.winRate,
      sampleSize: a.n,
    });
    return [{
      experimentId: sb.experimentId,
      experimentVersion: sb.experimentVersion,
      mode: sb.mode,
      definitionHash: sb.definitionFrozen.actual,
      definitionFrozen: sb.definitionFrozen.frozen,
      prospectiveStartDate: sb.frozen.prospectiveStartDate,
      status: sb.verdict,
      statusReason: sb.verdictReason,
      prospectiveClosedOutcomes: sb.evidence.closedOutcomes,
      requiredClosedOutcomes: sb.evidence.requiredClosedOutcomes,
      independentSessions: sb.evidence.independentSessions,
      requiredIndependentSessions: sb.evidence.requiredIndependentSessions,
      // BOTH arms are restricted to the rows the rule can decide. Measuring a shadow arm
      // against every closed callout compares two populations and calls the gap a rule.
      baseline: arm(sim.baseline),
      shadow: arm(sim.shadow),
      winnerRetention: sim.winnerRetentionRate,
      lossRejection: sim.lossRejectionRate,
      winnersRejected: sim.winnersRejected.length,
      profitFactorExBest: sim.shadow.profitFactorExBestWinner,
      tailRobustness: sim.shadow.profitFactorExBestWinner == null
        ? "not measurable yet"
        : `shadow profit factor without its single best winner; that winner is `
          + `${sim.shadow.bestWinnerShareOfGains == null ? "an unknown share" : `${Math.round(sim.shadow.bestWinnerShareOfGains * 100)}%`}`
          + " of the arm's gross gains",
      affectsLiveCallouts: false,
      authority: sb.authority,
      limitations: sb.limitations,
    }];
  }, []);

  // ── what OptiScan learned ─────────────────────────────────────────────────
  const learned = safe<LearnedPanel>("findings", () => {
    const all = listFindingsOnDb(db as any, { limit: 60 }) as any[];
    const shape = (f: any) => ({
      key: String(f.key ?? f.finding_key ?? ""),
      title: String(f.title ?? ""),
      statement: String(f.statement ?? ""),
      evidenceStrength: String(f.evidenceStrength ?? f.evidence_strength ?? "UNKNOWN"),
      sampleSize: f.sampleSize ?? f.sample_size ?? null,
      limitations: Array.isArray(f.limitations) ? f.limitations.map(String) : [],
    });
    const isAi = (f: any) => String(f.key ?? f.finding_key ?? "").startsWith("AI_NIGHTLY_");
    return {
      deterministicFindings: all.filter((f) => !isAi(f)).map(shape),
      aiFindings: all.filter(isAi).map(shape),
      openQuestions: [],
      insufficientEvidence: all
        .filter((f) => /INSUFFICIENT/i.test(String(f.evidenceStrength ?? f.evidence_strength ?? "")))
        .map((f) => String(f.title ?? f.key ?? "")),
    };
  }, { deterministicFindings: [], aiFindings: [], openQuestions: [], insufficientEvidence: [] });

  // ── risk research ─────────────────────────────────────────────────────────
  const riskResearch = safe<RiskResearchPanel>("riskResearch", () => {
    const exit = buildExitRiskObservationsOnDb(db, {});
    const byPath = stats?.byPathLabel ?? {};
    const closed = stats?.closed ?? 0;
    const cards: RiskResearchPanel["cards"] = [
      {
        id: "GOOD_MOVE_THEN_REVERSED",
        title: "Good move, then reversed",
        headline: `${byPath.GOOD_MOVE_THEN_REVERSED ?? 0} of ${closed} closed callouts`,
        detail: "Traded meaningfully in our favour and still closed non-positive. The population "
          + "any profit-protection question would be asked about — and no such rule exists or runs.",
        sampleSize: byPath.GOOD_MOVE_THEN_REVERSED ?? 0,
        supported: (byPath.GOOD_MOVE_THEN_REVERSED ?? 0) >= 8,
      },
      {
        id: "EVENTUAL_T1_WINNER",
        title: "Eventual Target 1 winner",
        headline: `${byPath.EVENTUAL_T1_WINNER ?? 0} of ${closed} closed callouts`,
        detail: "Reached Target 1 and kept it. Held apart from the reversals on purpose, so the "
          + "profit-protection question can be asked later without being begged now.",
        sampleSize: byPath.EVENTUAL_T1_WINNER ?? 0,
        supported: (byPath.EVENTUAL_T1_WINNER ?? 0) >= 8,
      },
      {
        id: "OVERNIGHT_HOLDS",
        title: "Overnight holds",
        headline: `${stats?.heldOvernight ?? 0} of ${closed} crossed a session boundary`,
        detail: "The two arms are OUTCOME-SELECTED, not randomly assigned: a trade exits same-day "
          + "BECAUSE it hit Target 1 or its stop intraday, and is held BECAUSE it did neither. The "
          + "gap between them measures that selection at least as much as it measures overnight risk.",
        sampleSize: stats?.heldOvernight ?? 0,
        supported: false,
      },
      {
        id: "STOP_LEAKAGE",
        title: "Stop leakage",
        headline: `${stats?.stopLeakage ?? 0} of ${closed} filled materially below the frozen stop`,
        detail: "The stop was not moved and nothing here proposes moving it. This measures the gap "
          + "between the level the callout named and the price the exit actually got.",
        sampleSize: stats?.stopLeakage ?? 0,
        supported: (stats?.stopLeakage ?? 0) >= 8,
      },
      {
        id: "OPENING_BELL_GAPS",
        title: "Opening-bell gaps",
        headline: `${stats?.overnightGaps ?? 0} of ${closed} carried a measured between-session gap`,
        detail: "Measured on the frozen contract's own marks across the session boundary. "
          + "Observation only — no cutoff time, flat-close rule or overnight policy exists.",
        sampleSize: stats?.overnightGaps ?? 0,
        supported: (stats?.overnightGaps ?? 0) >= 8,
      },
      {
        id: "PROFIT_PROTECTION",
        title: "Profit protection research",
        headline: exit.profitProtection ? "OBSERVATION ONLY — no policy exists" : "unavailable",
        detail: "No trailing stop, break-even stop, profit lock, sell-at-level or cutoff time "
          + "exists, is proposed, or is implied by anything on this page.",
        sampleSize: exit.calloutsConsidered ?? null,
        supported: false,
      },
    ];
    return {
      cards,
      activeProfitProtectionPolicy: null,
      note: "Every card is an observation. None is a rule, and none of them runs.",
    };
  }, {
    cards: [], activeProfitProtectionPolicy: null,
    note: "exit-risk observations unavailable",
  });

  const earlyDiscovery = safe("preMoveV2", () => buildPreMoveV2Report(db as any, {}), null as any);

  // ── readiness trajectory ──────────────────────────────────────────────────
  //
  // Reads the gates that already exist; defines no new one and relaxes none. Each
  // bucket lists what BLOCKS it, because "not ready" without a reason is a status
  // nobody can act on.
  const readiness = safe<ReadinessTrajectoryPanel>("readiness", () => {
    const shadow = shadowExperiments[0] ?? null;
    const v2 = earlyDiscovery;
    const edgeBlocking: string[] = [];
    if ((currentEdge.profitFactor ?? 0) <= 1) {
      edgeBlocking.push(
        `forward profit factor is ${currentEdge.profitFactor ?? "unavailable"} — at or below 1.0 the lane `
        + "does not yet return more than it gives back",
      );
    }
    if ((currentEdge.profitFactorExBest ?? 0) <= 1) {
      edgeBlocking.push(
        "profit factor without the single best winner is at or below 1.0 — the result depends on the tail",
      );
    }
    if (currentEdge.evidenceState !== "SUPPORTED") {
      edgeBlocking.push(`realized evidence is ${currentEdge.evidenceState}, not SUPPORTED`);
    }

    const integrityBlocking: string[] = [];
    const mirrorRate = stats?.mirrorRate ?? null;
    if (mirrorRate != null && mirrorRate < 1) {
      integrityBlocking.push(`exact-OCC mirror rate is ${mirrorRate}, not 1.00`);
    }
    if ((stats?.occMismatches ?? 0) > 0) {
      integrityBlocking.push(`${stats?.occMismatches} mirrors sit on a contract the case did not freeze`);
    }
    if ((stats?.ambiguousCases ?? 0) > 0) {
      integrityBlocking.push(`${stats?.ambiguousCases} cases are claimed by more than one mirror`);
    }
    if ((stats?.withoutTrajectoryEvidence ?? 0) > 0) {
      integrityBlocking.push(`${stats?.withoutTrajectoryEvidence} closed callouts have marks that cannot support a path verdict`);
    }

    const forwardBlocking: string[] = [];
    if (shadow && shadow.status === "INSUFFICIENT_EVIDENCE") {
      forwardBlocking.push(
        `${shadow.experimentId}: ${shadow.prospectiveClosedOutcomes}/${shadow.requiredClosedOutcomes} closed `
        + `prospective outcomes, ${shadow.independentSessions}/${shadow.requiredIndependentSessions} independent sessions`,
      );
    }
    if (v2 && v2.verdict !== "SUPPORTED") {
      forwardBlocking.push(`PRE_MOVE_DISCOVERY_V2: ${v2.verdictReason}`);
    }

    return {
      buckets: [
        {
          id: "TRADING_EDGE",
          title: "Trading edge",
          facts: [
            { label: "Forward profit factor", value: currentEdge.profitFactor },
            { label: "Expectancy", value: currentEdge.expectancyPct },
            { label: "Median return", value: currentEdge.medianReturnPct },
            { label: "PF ex-best", value: currentEdge.profitFactorExBest },
            { label: "Sample", value: currentEdge.sampleSize },
            { label: "Independent sessions", value: currentEdge.independentSessions },
            { label: "Experiment status", value: shadow?.status ?? "no experiment running" },
          ],
          blocking: edgeBlocking,
        },
        {
          id: "DATA_INTEGRITY",
          title: "Data integrity",
          facts: [
            { label: "Openings", value: stats?.openings ?? 0 },
            { label: "Exact mirrors", value: stats?.exactMirrors ?? 0 },
            { label: "Mirror rate", value: mirrorRate },
            { label: "OCC mismatches", value: stats?.occMismatches ?? 0 },
            { label: "Ambiguous cases", value: stats?.ambiguousCases ?? 0 },
            { label: "Closed without trajectory evidence", value: stats?.withoutTrajectoryEvidence ?? 0 },
          ],
          blocking: integrityBlocking,
        },
        {
          id: "FORWARD_EVIDENCE",
          title: "Forward evidence",
          facts: [
            { label: "Experiment", value: shadow?.experimentId ?? null },
            { label: "Prospective from", value: shadow?.prospectiveStartDate ?? null },
            { label: "Prospective closed outcomes", value: shadow?.prospectiveClosedOutcomes ?? 0 },
            { label: "Required", value: shadow?.requiredClosedOutcomes ?? null },
            { label: "Independent sessions", value: shadow?.independentSessions ?? 0 },
            { label: "PRE_MOVE V2 captured callouts", value: v2?.coverage?.capturedOwnerRows ?? 0 },
            { label: "PRE_MOVE V2 verdict", value: v2?.verdict ?? null },
          ],
          blocking: forwardBlocking,
        },
        {
          id: "OPERATIONAL_READINESS",
          title: "Operational readiness",
          facts: [
            { label: "Callouts opened today", value: today.openedToday },
            { label: "Callouts closed today", value: today.closedToday },
            { label: "Open now", value: today.openNow },
            { label: "Panels that failed to build", value: faults.length },
          ],
          blocking: faults.length ? [`${faults.length} research panel(s) could not be built`] : [],
        },
        {
          id: "SUBSCRIBER_SETUP",
          title: "Subscriber setup",
          facts: [
            { label: "Subscriber delivery", value: "NOT ENABLED" },
            { label: "Evidence population", value: "OWNER_VALIDATION_PAPER — no subscriber received these trades" },
            { label: "Approval", value: "requires a named human; no status on this page grants it" },
          ],
          blocking: [
            "Subscriber approval is a human act taken elsewhere. Nothing on this page, and no "
            + "experiment status it can reach, enables delivery.",
          ],
        },
      ],
      subscriberReady: false,
      humanApprovalRequired: true,
      note:
        "This panel CHANGES NO READINESS RULE. Every threshold quoted is read from the gate "
        + "that already owns it. A promising shadow experiment is not subscriber readiness, and "
        + "the five buckets are separate precisely because satisfying one says nothing about the "
        + "other four.",
    };
  }, {
    buckets: [], subscriberReady: false, humanApprovalRequired: true,
    note: "readiness trajectory unavailable",
  });

  return {
    version: RESEARCH_COMMAND_CENTER_VERSION,
    generatedAtMs: nowMs,
    today,
    currentEdge,
    shadowExperiments,
    learned,
    riskResearch,
    earlyDiscovery,
    readiness,
    earlyDiscoveryV1Caveat: {
      stage: "PRE_TRIGGER",
      share: "100% of gradable owner rows",
      whyUnusable:
        "V1 measures the move consumed between first detection and alert, a median 1,619 ms "
        + "window, and returns PRE_TRIGGER on trigger state before consulting magnitude at all. "
        + "It is measuring that detection and delivery happen on the same tick, not that the "
        + "callouts were early. Read PRE_MOVE_DISCOVERY_V2 instead, once it has evidence.",
    },
    faults,
  };
}
