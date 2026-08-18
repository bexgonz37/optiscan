/**
 * pre-move-v2-report.ts — the deterministic research read of PRE_MOVE_DISCOVERY_V2.
 *
 * Answers the early-winner questions the owner actually asks, and refuses to answer
 * them when the prospective sample cannot support an answer:
 *
 *   - Which eventual winners were found before the trigger, at confirmation, during
 *     early expansion, or after the move matured?
 *   - How much of the day's favourable move was consumed before the callout?
 *   - How much option premium expansion was consumed before it?
 *   - How long after the callout until +10, +25, Target 1, Target 2?
 *   - How much reward remained?
 *   - Did lower-strength pre-trigger setups simply never start?
 *   - Is there an evidence-supported earliest useful confirmation point?
 *
 * NONE OF THESE ANSWERS MAY CHANGE DELIVERY, and nothing in this session uses them to.
 * They exist so a later decision argues with a number instead of a memory.
 *
 * ── Two traps this report is built around ─────────────────────────────────────
 *
 * 1. A STAGE HISTOGRAM OVER 4 ROWS IS NOT A DISTRIBUTION. The V2 population starts
 *    empty by construction and grows one callout at a time. Every rate here is
 *    reported beside its denominator, and the report carries an explicit evidence
 *    verdict that stays INSUFFICIENT_EVIDENCE until the floors below are met. The
 *    floors are the same ones the owner probability gate uses — 20 closed outcomes
 *    across 5 independent sessions — because a stage-conditional claim needs at least
 *    what an unconditional one needs.
 *
 * 2. PER-STAGE CLAIMS NEED PER-STAGE SAMPLES. A lane can clear a global floor while
 *    one stage holds three trades, and "TOO_LATE callouts win 0% of the time" off
 *    three rows is the kind of sentence that survives into a decision. Each stage
 *    therefore carries its own `supported` flag, and an unsupported stage reports its
 *    numbers with `supported: false` rather than being hidden — a hidden stage reads
 *    as a stage with no trades.
 *
 * Reads persisted evidence only. No provider call, no write, no send authority.
 */
import {
  DISCOVERY_STAGES_V2,
  PRE_MOVE_DISCOVERY_V2_VERSION,
  measureDiscoveryOutcomeV2,
  checkDiscoveryV2Frozen,
  type DiscoveryStageV2,
} from "./pre-move-discovery-v2.ts";
import {
  listPreMoveV2RowsOnDb,
  preMoveV2CoverageOnDb,
  type PreMoveV2Db,
  type PreMoveV2Row,
} from "./pre-move-v2-store.ts";
import {
  loadOwnerMirrorPopulationOnDb,
  type OwnerMirrorPopulation,
  type OwnerMirrorRecord,
} from "../../opportunity-case/owner-mirror-identity.ts";

export const PRE_MOVE_V2_REPORT_VERSION = "PRE_MOVE_V2_REPORT_V1";

/**
 * Evidence floors. Identical to the owner probability gate's, and deliberately not
 * lower: a claim conditioned on a discovery stage is a narrower claim than the
 * unconditional one, so it cannot honestly need less evidence.
 */
export const PRE_MOVE_V2_EVIDENCE_FLOORS = Object.freeze({
  minClosedOutcomes: 20,
  minIndependentSessions: 5,
  /** Below this a single stage's numbers are reported but never described as a finding. */
  minPerStageOutcomes: 8,
});

export type PreMoveV2Verdict = "INSUFFICIENT_EVIDENCE" | "SUPPORTED";

const med = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const round = (v: number | null, p = 4): number | null => (v == null ? null : +v.toFixed(p));

/**
 * A calendar date is not a trading session, so a well-formed weekend string must not
 * clear an independence floor unchallenged. Same rule the cohort gate applies.
 */
function countIndependentSessions(dates: Array<string | null>): number {
  const valid = new Set<string>();
  for (const d of dates) {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const t = Date.parse(`${d}T12:00:00Z`);
    if (!Number.isFinite(t)) continue;
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    valid.add(d);
  }
  return valid.size;
}

export interface PreMoveV2StageStats {
  stage: DiscoveryStageV2;
  /** Rows classified into this stage, closed or not. */
  rows: number;
  /** Rows with a realized outcome. The denominator for every rate below. */
  closedOutcomes: number;
  winners: number;
  losers: number;
  winRate: number | null;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  profitFactor: number | null;

  medianMoveConsumedFraction: number | null;
  medianRewardRemainingFraction: number | null;
  /** Null across the board when detection and callout were the same observation. */
  medianPremiumExpansionConsumedPct: number | null;

  medianMsToPlus10: number | null;
  medianMsToPlus25: number | null;
  medianMsToTarget1: number | null;
  medianMsToTarget2: number | null;
  reachedPlus10: number;
  reachedPlus25: number;
  reachedTarget1: number;

  /** Trades that never traded above the callout price. The "never started" count. */
  neverConfirmed: number;
  neverConfirmedMeasurable: number;

  /**
   * False when this stage holds too few closed outcomes to describe. The numbers are
   * still reported: hiding a thin stage makes it read as a stage with no trades.
   */
  supported: boolean;
}

export interface PreMoveV2Report {
  version: typeof PRE_MOVE_V2_REPORT_VERSION;
  discoveryVersion: typeof PRE_MOVE_DISCOVERY_V2_VERSION;
  definitionFrozen: ReturnType<typeof checkDiscoveryV2Frozen>;
  coverage: ReturnType<typeof preMoveV2CoverageOnDb>;

  population: {
    label: string;
    rows: number;
    closedOutcomes: number;
    independentSessions: number;
    firstSessionDate: string | null;
    lastSessionDate: string | null;
  };
  verdict: PreMoveV2Verdict;
  verdictReason: string;

  byStage: PreMoveV2StageStats[];
  /** Of the eventual winners, how many were found at each stage. Counts, not rates. */
  winnersByStage: Record<string, number>;
  /** Of the eventual losers, likewise. Reported together so neither is read alone. */
  losersByStage: Record<string, number>;

  questions: Array<{ question: string; answer: string; supported: boolean }>;
  limitations: string[];
  note: string;
}

interface JoinedRow {
  row: PreMoveV2Row;
  mirror: OwnerMirrorRecord | null;
  realizedReturnPct: number | null;
  outcome: ReturnType<typeof measureDiscoveryOutcomeV2> | null;
}

function marksFor(
  db: PreMoveV2Db,
  tradeId: number,
  occ: string | null,
): Array<{ atMs: number | null; returnPct: number | null; premium: number | null }> {
  if (!occ) return [];
  try {
    return ((db.prepare(
      // `exit_fill` is the realizable premium at the mark and is the same series
      // `return_pct` is derived from, so a target time and a return can never disagree
      // about what the contract was worth. There is no `mark_price` column.
      `SELECT mark_at_ms, return_pct, exit_fill FROM options_paper_marks
        WHERE trade_id=? AND UPPER(TRIM(option_symbol))=UPPER(TRIM(?))
        ORDER BY mark_at_ms ASC`,
    ).all?.(tradeId, occ) ?? []) as any[]).map((r) => ({
      atMs: r.mark_at_ms == null ? null : Number(r.mark_at_ms),
      returnPct: r.return_pct == null ? null : Number(r.return_pct),
      premium: r.exit_fill == null ? null : Number(r.exit_fill),
    }));
  } catch {
    return [];
  }
}

function statsFor(stage: DiscoveryStageV2, joined: JoinedRow[]): PreMoveV2StageStats {
  const mine = joined.filter((j) => j.row.stage === stage);
  const closed = mine.filter((j) => j.realizedReturnPct != null);
  const returns = closed.map((j) => j.realizedReturnPct as number);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const msList = (pick: (o: NonNullable<JoinedRow["outcome"]>) => number | null): number[] =>
    mine.map((j) => (j.outcome ? pick(j.outcome) : null)).filter((v): v is number => v != null);

  const ms10 = msList((o) => o.msToPlus10);
  const ms25 = msList((o) => o.msToPlus25);
  const msT1 = msList((o) => o.msToTarget1);
  const msT2 = msList((o) => o.msToTarget2);

  const neverMeasurable = mine.filter((j) => j.outcome?.neverConfirmed != null);

  const nums = (pick: (r: PreMoveV2Row) => number | null): number[] =>
    mine.map((j) => pick(j.row)).filter((v): v is number => v != null);

  return {
    stage,
    rows: mine.length,
    closedOutcomes: closed.length,
    winners: wins.length,
    losers: losses.length,
    winRate: closed.length ? round(wins.length / closed.length) : null,
    meanReturnPct: returns.length ? round(returns.reduce((a, b) => a + b, 0) / returns.length, 2) : null,
    medianReturnPct: round(med(returns), 2),
    profitFactor: grossLoss > 0 ? round(gross / grossLoss) : null,
    medianMoveConsumedFraction: round(med(nums((r) => r.sessionMoveConsumedFraction))),
    medianRewardRemainingFraction: round(med(nums((r) => r.rewardRemainingFraction))),
    medianPremiumExpansionConsumedPct: round(med(nums((r) => r.premiumExpansionConsumedPct)), 2),
    medianMsToPlus10: med(ms10),
    medianMsToPlus25: med(ms25),
    medianMsToTarget1: med(msT1),
    medianMsToTarget2: med(msT2),
    reachedPlus10: ms10.length,
    reachedPlus25: ms25.length,
    reachedTarget1: msT1.length,
    neverConfirmed: neverMeasurable.filter((j) => j.outcome?.neverConfirmed === true).length,
    neverConfirmedMeasurable: neverMeasurable.length,
    supported: closed.length >= PRE_MOVE_V2_EVIDENCE_FLOORS.minPerStageOutcomes,
  };
}

/**
 * Build the V2 research read over the OWNER lane.
 *
 * Owner membership is proven by the exact-OCC mirror the callout left, never by the
 * `lane` column, which is stamped at capture time before anyone knows an owner will be
 * notified. A mirror on a contract the case did not freeze is refused rather than
 * priced: a different strike's return is not this decision's return.
 */
export function buildPreMoveV2Report(
  db: PreMoveV2Db,
  opts: { sinceMs?: number | null } = {},
): PreMoveV2Report {
  const coverage = preMoveV2CoverageOnDb(db);
  const rows = listPreMoveV2RowsOnDb(db, { sinceMs: opts.sinceMs ?? null });
  let population: OwnerMirrorPopulation;
  try {
    population = loadOwnerMirrorPopulationOnDb(db as any, { sinceMs: opts.sinceMs ?? null });
  } catch {
    population = { version: "OWNER_MIRROR_IDENTITY_V1" as any, mirrors: [], withoutCaseIdentity: 0, ambiguousCaseIds: [], byCaseId: new Map() };
  }

  const joined: JoinedRow[] = rows.map((row) => {
    const m = population.byCaseId.get(row.opportunityCaseId) ?? null;
    const mirror = m && m.occExact ? m : null;
    if (!mirror) return { row, mirror: null, realizedReturnPct: null, outcome: null };
    const marks = marksFor(db, mirror.paperTradeId, mirror.optionSymbol);
    const outcome = measureDiscoveryOutcomeV2({
      classification: {
        version: PRE_MOVE_DISCOVERY_V2_VERSION,
        stage: (row.stage ?? "UNGRADABLE") as DiscoveryStageV2,
        side: row.side ?? "PUT",
        triggerState: row.triggerState ?? "UNKNOWN",
        sessionMoveConsumedFraction: row.sessionMoveConsumedFraction,
        rewardRemainingFraction: row.rewardRemainingFraction,
        underlyingMoveConsumedPct: row.underlyingMoveConsumedPct,
        premiumExpansionConsumedPct: row.premiumExpansionConsumedPct,
        distanceToTriggerPct: row.distanceToTriggerPct,
        extensionFromVwapPct: row.extensionFromVwapPct,
        timeline: {
          firstSetupObservedAtMs: row.firstSetupObservedAtMs,
          firstPartialConfirmationAtMs: row.firstPartialConfirmationAtMs,
          firstFullConfirmationAtMs: row.firstFullConfirmationAtMs,
          ownerCalloutAtMs: row.ownerCalloutAtMs,
          firstExpansionAtMs: row.firstExpansionAtMs,
        },
        setupToCalloutMs: null,
        fullConfirmationToCalloutMs: null,
        missingInputs: row.missingFields,
        reason: row.reason ?? "",
      },
      calloutAtMs: row.ownerCalloutAtMs ?? mirror.enteredAtMs,
      marks,
      entryPremium: row.entryPremium ?? mirror.entryFill,
      // The frozen targets, taken from the capture where it has them and from the case
      // otherwise. Never a recomputed level: a target time measured against a target the
      // callout never set is not this callout's lead time.
      target1Premium: row.target1Premium ?? mirror.targetT1,
      target2Premium: row.target2Premium ?? mirror.targetT2,
      realizedReturnPct: mirror.realizedReturnPct,
      excursionVerified: marks.length > 0,
    });
    return { row, mirror, realizedReturnPct: mirror.realizedReturnPct, outcome };
  });

  const closed = joined.filter((j) => j.realizedReturnPct != null);
  const sessionDates = joined.map((j) => j.row.sessionDate);
  const validDates = sessionDates.filter((d): d is string => Boolean(d) && /^\d{4}-\d{2}-\d{2}$/.test(d as string)).sort();
  const independentSessions = countIndependentSessions(sessionDates);

  const enoughOutcomes = closed.length >= PRE_MOVE_V2_EVIDENCE_FLOORS.minClosedOutcomes;
  const enoughSessions = independentSessions >= PRE_MOVE_V2_EVIDENCE_FLOORS.minIndependentSessions;
  const verdict: PreMoveV2Verdict = enoughOutcomes && enoughSessions ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE";

  const byStage = DISCOVERY_STAGES_V2.map((s) => statsFor(s, joined));

  const winnersByStage: Record<string, number> = {};
  const losersByStage: Record<string, number> = {};
  for (const s of DISCOVERY_STAGES_V2) { winnersByStage[s] = 0; losersByStage[s] = 0; }
  for (const j of closed) {
    const s = j.row.stage ?? "UNGRADABLE";
    if ((j.realizedReturnPct as number) > 0) winnersByStage[s] = (winnersByStage[s] ?? 0) + 1;
    else losersByStage[s] = (losersByStage[s] ?? 0) + 1;
  }

  const insufficient = (q: string): { question: string; answer: string; supported: boolean } => ({
    question: q,
    answer:
      `INSUFFICIENT_EVIDENCE — ${closed.length} of ${PRE_MOVE_V2_EVIDENCE_FLOORS.minClosedOutcomes} closed `
      + `prospective outcomes across ${independentSessions} of ${PRE_MOVE_V2_EVIDENCE_FLOORS.minIndependentSessions} `
      + "independent sessions. V2 captures only forward, so this fills one callout at a time.",
    supported: false,
  });

  const stageOf = (s: DiscoveryStageV2) => byStage.find((x) => x.stage === s)!;
  const fmtMin = (ms: number | null): string => (ms == null ? "unavailable" : `${Math.round(ms / 60_000)} min`);

  const questions = verdict === "SUPPORTED"
    ? [
      {
        question: "Which eventual winners were found before the trigger, at confirmation, during early expansion, or after the move matured?",
        answer: DISCOVERY_STAGES_V2
          .filter((s) => (winnersByStage[s] ?? 0) > 0 || (losersByStage[s] ?? 0) > 0)
          .map((s) => `${s}: ${winnersByStage[s] ?? 0}W/${losersByStage[s] ?? 0}L`)
          .join(" · ") || "no closed outcomes yet",
        supported: true,
      },
      {
        question: "How much of the day's favourable move was consumed before the callout?",
        answer: byStage.filter((s) => s.rows > 0 && s.medianMoveConsumedFraction != null)
          .map((s) => `${s.stage}: median ${Math.round((s.medianMoveConsumedFraction as number) * 100)}% spent (n=${s.rows})`)
          .join(" · "),
        supported: true,
      },
      {
        question: "How long after the callout until +10 and +25?",
        answer: byStage.filter((s) => s.reachedPlus10 > 0 || s.reachedPlus25 > 0)
          .map((s) => `${s.stage}: +10 ${fmtMin(s.medianMsToPlus10)} (${s.reachedPlus10}/${s.rows}), +25 ${fmtMin(s.medianMsToPlus25)} (${s.reachedPlus25}/${s.rows})`)
          .join(" · "),
        supported: true,
      },
      {
        question: "Did lower-stage pre-trigger setups simply never start?",
        answer: (() => {
          const p = stageOf("PRE_TRIGGER_WATCH");
          if (p.neverConfirmedMeasurable === 0) return "no measurable PRE_TRIGGER_WATCH outcomes yet";
          return `${p.neverConfirmed} of ${p.neverConfirmedMeasurable} PRE_TRIGGER_WATCH callouts never traded above the callout price`
            + (p.supported ? "" : " — below the per-stage floor, reported but not a finding");
        })(),
        supported: stageOf("PRE_TRIGGER_WATCH").supported,
      },
      {
        question: "Is there an evidence-supported earliest useful confirmation point?",
        answer:
          "Not answered by this report. Comparing stages tells you which stage the winners "
          + "came from, not which stage a rule should wait for — the stages are outcome-"
          + "correlated observations of callouts that were all delivered, not arms of a trial.",
        supported: false,
      },
    ]
    : [
      "Which eventual winners were found before the trigger, at confirmation, during early expansion, or after the move matured?",
      "How much of the day's favourable move was consumed before the callout?",
      "How long after the callout until +10 and +25?",
      "Did lower-stage pre-trigger setups simply never start?",
      "Is there an evidence-supported earliest useful confirmation point?",
    ].map(insufficient);

  return {
    version: PRE_MOVE_V2_REPORT_VERSION,
    discoveryVersion: PRE_MOVE_DISCOVERY_V2_VERSION,
    definitionFrozen: checkDiscoveryV2Frozen(),
    coverage,
    population: {
      label: "OWNER_VALIDATION_PAPER callouts with a PRE_MOVE_DISCOVERY_V2 alert-instant capture",
      rows: rows.length,
      closedOutcomes: closed.length,
      independentSessions,
      firstSessionDate: validDates[0] ?? null,
      lastSessionDate: validDates[validDates.length - 1] ?? null,
    },
    verdict,
    verdictReason: verdict === "SUPPORTED"
      ? `${closed.length} closed prospective outcomes across ${independentSessions} independent sessions.`
      : `${closed.length}/${PRE_MOVE_V2_EVIDENCE_FLOORS.minClosedOutcomes} closed outcomes, `
        + `${independentSessions}/${PRE_MOVE_V2_EVIDENCE_FLOORS.minIndependentSessions} independent sessions. `
        + "Nothing here is a finding yet.",
    byStage,
    winnersByStage,
    losersByStage,
    questions,
    limitations: [
      "PROSPECTIVE ONLY. Rows written before the V2 capture site went live carry no "
      + "alert-instant session snapshot and are excluded from this population entirely — "
      + "not counted as UNGRADABLE, which would dilute every rate with trades V2 never saw.",
      "V1 is untouched. Its rows keep their V1 stage, and a V1/V2 disagreement on the same "
      + "callout is expected: they measure different things against different denominators.",
      "The stage is a decision-time observation of a callout that WAS delivered. Stages are "
      + "not arms of a trial and a stage's win rate is not what a rule waiting for that stage "
      + "would have earned.",
      "The denominator is the session's range AS OF THE CALLOUT. A day that later extended "
      + "further does not retroactively make the callout earlier, and that is deliberate.",
      "premiumExpansionConsumedPct is null whenever detection and callout were the same "
      + "observation. Null means unmeasured, never 0%.",
    ],
    note:
      "MEASUREMENT ONLY. No gate, threshold, ranking weight, contract choice, target, stop, "
      + "exit or subscriber decision reads any number in this report.",
  };
}
