/**
 * cohort-v2.ts — HISTORICAL_COHORT_V2. Empirical estimates over historical winner
 * events, with robustness attached to every result.
 *
 * ── Why a new version instead of editing V1 ──────────────────────────────────
 *
 * V1 measures the LOCAL paper record: `options_paper_trades` mirrors and their marks.
 * V2 measures the HISTORICAL replay record: exact-OCC winner events reconstructed from
 * stored NBBO under a time fence. Same vocabulary, different populations, different
 * entry conventions.
 *
 * Silently widening V1 to consume both would produce a number that means neither, and
 * nobody reading it later could tell which record it came from. So V2 is its own
 * version, its own cohort id, and its own module. V1's semantics are untouched.
 *
 * ── What V2 inherits deliberately ────────────────────────────────────────────
 *
 * The two floors (trades AND independent sessions), the counts-without-rates rule, and
 * lane separation. Those were not V1 conveniences; they are the properties that stop a
 * small or pooled sample becoming a probability, and re-deriving them differently here
 * would create two standards of evidence in one system.
 *
 * ── Robustness is not optional ───────────────────────────────────────────────
 *
 * Every result carries best-winner-excluded and capped variants, per-session spread and
 * concentration. This lane rides a convex tail: a cohort whose profit factor collapses
 * without its single best event is a different claim from one that survives, and
 * reporting only the headline hides exactly the cohorts most likely to be noise.
 *
 * SHADOW ONLY. No gate, threshold, ranking weight, stop, exit or subscriber decision
 * reads anything here.
 */
import { FORWARD_MILESTONES } from "./replay.ts";
import { countIndependentSessions, type IndependentSessionCount } from "./trading-sessions.ts";
import type { WinnerEvent } from "./winner-events.ts";

export const HISTORICAL_COHORT_V2_VERSION = "HISTORICAL_COHORT_V2" as const;

/** Same floors as V1, deliberately. Two standards of evidence is worse than one. */
export const V2_MIN_EVENTS = 20;
export const V2_MIN_SESSIONS = 5;

/** Return level above which a single event is treated as tail rather than typical. */
export const V2_TAIL_PCT = 100;
/** Cap applied for the capped-return robustness variant. */
export const V2_RETURN_CAP_PCT = 100;

export type V2Lane = "OWNER_VALIDATION" | "SUBSCRIBER" | "RESEARCH" | "EXPERIMENT" | "LEGACY" | "REPLAY_HISTORICAL";

export interface CohortV2Key {
  /** The population. Never omitted: pooling lanes is the defect V1 already had once. */
  lane: V2Lane;
  strategyKey?: string | null;
  side?: "call" | "put" | null;
  regime?: string | null;
  discoveryStage?: string | null;
  dteBucket?: string | null;
  /** Replay version the members were derived under. Part of identity. */
  replayVersion?: string | null;
}

export interface CohortV2Member {
  eventId: string;
  occ: string;
  symbol: string;
  sessionDate: string | null;
  side: "call" | "put" | null;
  strategyKey?: string | null;
  regime?: string | null;
  discoveryStage?: string | null;
  dteBucket?: string | null;
  /** Realized-equivalent outcome: the post-entry MFE is NOT this. */
  finalReturnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  msToMilestone: Record<string, number | null>;
  peakMilestone: number | null;
  /**
   * Post-entry quotes on THIS contract.
   *
   * The milestone denominator depends on it. A contract with zero post-entry quotes is
   * not a contract that failed to reach +25% — it is a contract nobody watched, and
   * counting it as a miss biases every probability downward by exactly the size of the
   * coverage gap.
   */
  postEntryQuotes: number | null;
  evidenceQuality: WinnerEvent["evidenceQuality"];
}

export interface EvidenceFloorResult {
  verdict: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  events: number;
  /**
   * VERIFIED trading sessions — never `new Set(dates).size`.
   *
   * A calendar date is not a trading session. Counting distinct strings lets a weekend, a
   * market holiday or a corrupt epoch clear an independence floor, and by the time the
   * value reaches a floor it is just a number that cannot be questioned.
   */
  independentSessions: number;
  minEvents: number;
  minSessions: number;
  reason: string;
  /** The calendar audit behind `independentSessions`, including what was rejected. */
  sessionAudit: IndependentSessionCount;
}

export interface RobustnessReport {
  /** Profit factor with the single best event removed. Null when unsupported. */
  profitFactorExBest: number | null;
  /** Profit factor with every return capped. Bounds one enormous winner's influence. */
  profitFactorCapped: number | null;
  cappedAtPct: number;
  /** Expectancy with the best event removed. */
  expectancyExBest: number | null;
  /** Per-session expectancy, so one exceptional day is visible as one day. */
  perSessionExpectancy: Array<{ sessionDate: string; events: number; expectancyPct: number | null }>;
  sessionsPositive: number;
  sessionsNegative: number;
  /** Share of gross profit contributed by the single best event. */
  bestEventShareOfGross: number | null;
  /** Largest share of the cohort held by one symbol / strategy / regime. */
  symbolConcentration: number | null;
  strategyConcentration: number | null;
  regimeConcentration: number | null;
  tailFrequency: number | null;
  /** True when the headline survives removing the best event. */
  survivesBestExcluded: boolean | null;
  warnings: string[];
}

export interface MilestoneEstimate {
  milestone: number;
  reached: number;
  /** Denominator: members that COULD have witnessed this milestone. Never total members. */
  of: number;
  /** Members excluded from the denominator for having no post-entry quote at all. */
  excludedNoWitness: number;
  probability: number | null;
  /**
   * What kind of statement this row is.
   *
   *   OBSERVED             — the milestone was reached at least once.
   *   OBSERVED_ZERO        — witnesses existed and NONE reached it. A real finding.
   *   EVIDENCE_UNAVAILABLE — nothing could witness it. Not a finding about the setup.
   *
   * The two zeros are the distinction this field exists for. A reported `probability: 0`
   * is meaningless without knowing which one produced it, and "+100% never happens" and
   * "we have never been able to look" are opposite claims that print identically.
   */
  observation: "OBSERVED" | "OBSERVED_ZERO" | "EVIDENCE_UNAVAILABLE";
  /**
   * One-sided 95% Wilson upper bound on the true rate.
   *
   * 0 of 19 is not evidence that the rate is zero; it is evidence the rate is below
   * roughly 17%. Publishing the point estimate alone turns a thin sample into an
   * impossibility claim, which is how +50/+100 get written off.
   */
  upperBound95: number | null;
  medianMsToReach: number | null;
  verdict: EvidenceFloorResult["verdict"];
  note: string;
}

export interface CohortV2Result {
  version: typeof HISTORICAL_COHORT_V2_VERSION;
  cohortId: string;
  key: CohortV2Key;
  lane: V2Lane;
  dateRange: { from: string | null; to: string | null };
  sessions: string[];

  floors: EvidenceFloorResult;
  /** Only members whose evidence supports an extreme. Milestones use all members. */
  extremeSample: EvidenceFloorResult;

  milestones: MilestoneEstimate[];
  /** Reached NO milestone and drew down past the threshold. */
  pStopBeforeFirstMilestone: number | null;

  expectedMfePct: number | null;
  expectedMaePct: number | null;
  expectedReturnPct: number | null;
  medianReturnPct: number | null;
  profitFactor: number | null;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  winRate: number | null;
  medianMsToPeak: number | null;

  robustness: RobustnessReport;

  priceConvention: string;
  replayVersion: string | null;
  dataQualityCoverage: Record<WinnerEvent["evidenceQuality"], number>;
  limitations: string[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? +s[m].toFixed(4) : +(((s[m - 1] + s[m]) / 2).toFixed(4));
}

const mean = (xs: number[]): number | null =>
  xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4) : null;

/**
 * One-sided 95% Wilson upper bound on a binomial rate.
 *
 * Wilson rather than the normal approximation because the interesting cases here are
 * exactly the ones the normal approximation breaks on: k = 0 and small n. Wald would
 * return a zero-width interval at 0/19 and confirm the very error this bound exists to
 * prevent.
 */
function wilsonUpper95(k: number, n: number): number | null {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const z = 1.959964;
  const z2 = z * z;
  const p = k / n;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return +Math.min(1, centre + half).toFixed(4);
}

/**
 * Can this member testify about milestones at all?
 *
 * A contract with no post-entry quote observed nothing. Treating its silence as "did not
 * reach" is the coverage-gap-as-evidence error, applied one row at a time.
 */
function canWitnessMilestones(m: CohortV2Member): boolean {
  if (m.postEntryQuotes != null) return m.postEntryQuotes > 0;
  // Older members predate the field. UNSUPPORTED is precisely "zero post-entry quotes".
  return m.evidenceQuality !== "UNSUPPORTED";
}

function profitFactor(returns: number[]): number | null {
  const win = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const loss = Math.abs(returns.filter((r) => r <= 0).reduce((a, b) => a + b, 0));
  return loss > 0 ? +(win / loss).toFixed(4) : null;
}

/**
 * Evaluate a floor against events and a bag of SESSION DATES.
 *
 * Takes the dates rather than a pre-counted number on purpose: a caller that hands over a
 * count has already made the decision this function exists to make, and the calendar
 * check would be one refactor away from being skipped.
 */
function floors(
  events: number,
  sessionDates: ReadonlyArray<string | null | undefined>,
  what: string,
): EvidenceFloorResult {
  const audit = countIndependentSessions(sessionDates);
  const sessions = audit.independentSessions;
  const ok = events >= V2_MIN_EVENTS && sessions >= V2_MIN_SESSIONS;
  const rejectedNote = audit.rejected.length
    ? ` (${audit.rejected.length} non-trading date(s) excluded: `
      + `${audit.rejected.map((r) => `${r.date}:${r.reason}`).join(", ")})`
    : "";
  return {
    verdict: ok ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
    events,
    independentSessions: sessions,
    minEvents: V2_MIN_EVENTS,
    minSessions: V2_MIN_SESSIONS,
    reason: ok
      ? `${events} ${what} over ${sessions} independent trading sessions${rejectedNote}`
      : `needs >= ${V2_MIN_EVENTS} ${what} over >= ${V2_MIN_SESSIONS} trading sessions; `
        + `has ${events} over ${sessions}${rejectedNote}`,
    sessionAudit: audit,
  };
}

export function cohortV2IdFor(key: CohortV2Key): string {
  const parts = Object.entries(key)
    .filter(([, v]) => v != null && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`);
  return `${HISTORICAL_COHORT_V2_VERSION}:${parts.join("|")}`;
}

/** Largest share held by any single value of `pick`. Null when nothing is labelled. */
function concentration(members: readonly CohortV2Member[], pick: (m: CohortV2Member) => string | null | undefined): number | null {
  const counts = new Map<string, number>();
  let labelled = 0;
  for (const m of members) {
    const v = pick(m);
    if (v == null || v === "") continue;
    labelled += 1;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (!labelled) return null;
  return +(Math.max(...counts.values()) / labelled).toFixed(4);
}

/**
 * A member's realized-equivalent return.
 *
 * The LAST observed value, not the peak. Using MFE here would report the best moment of
 * every trade as its outcome, which is how a backtest reaches a profit factor no
 * account has ever produced.
 */
function returnOf(m: CohortV2Member): number | null {
  return m.finalReturnPct;
}

/**
 * Robustness for a set of returns.
 *
 * Computed even when the floors fail. The counts and shapes are true statements about
 * whatever sample exists, and a reader deciding whether to keep collecting needs to see
 * that a 6-event cohort is 90% one symbol.
 */
export function robustnessFor(members: readonly CohortV2Member[]): RobustnessReport {
  const warnings: string[] = [];
  const withReturn = members.filter((m) => returnOf(m) != null);
  const returns = withReturn.map((m) => returnOf(m) as number);

  const pf = profitFactor(returns);
  const best = returns.length ? Math.max(...returns) : null;
  const exBestReturns = best == null
    ? []
    : (() => {
      const i = returns.indexOf(best);
      return returns.filter((_, idx) => idx !== i);
    })();
  const pfExBest = exBestReturns.length ? profitFactor(exBestReturns) : null;
  const capped = returns.map((r) => Math.min(r, V2_RETURN_CAP_PCT));
  const pfCapped = capped.length ? profitFactor(capped) : null;

  const grossWin = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const bestShare = best != null && best > 0 && grossWin > 0 ? +(best / grossWin).toFixed(4) : null;

  const bySession = new Map<string, number[]>();
  for (const m of withReturn) {
    const key = m.sessionDate ?? "UNKNOWN";
    const list = bySession.get(key) ?? [];
    list.push(returnOf(m) as number);
    bySession.set(key, list);
  }
  const perSessionExpectancy = [...bySession.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([sessionDate, rs]) => ({ sessionDate, events: rs.length, expectancyPct: mean(rs) }));
  const sessionsPositive = perSessionExpectancy.filter((s) => (s.expectancyPct ?? 0) > 0).length;
  const sessionsNegative = perSessionExpectancy.filter((s) => (s.expectancyPct ?? 0) <= 0).length;

  const symbolConcentration = concentration(members, (m) => m.symbol);
  const strategyConcentration = concentration(members, (m) => m.strategyKey);
  const regimeConcentration = concentration(members, (m) => m.regime);
  const tailFrequency = returns.length
    ? +(returns.filter((r) => r >= V2_TAIL_PCT).length / returns.length).toFixed(4)
    : null;

  const survives = pf != null && pfExBest != null ? pfExBest > 1 && pf > 1 : null;

  if (bestShare != null && bestShare >= 0.5) {
    warnings.push(`one event supplies ${Math.round(bestShare * 100)}% of gross profit — this is a tail, not an edge`);
  }
  if (pf != null && pfExBest != null && pf > 1 && pfExBest <= 1) {
    warnings.push("profit factor falls to <= 1 without the single best event");
  }
  if (symbolConcentration != null && symbolConcentration >= 0.5) {
    warnings.push(`${Math.round(symbolConcentration * 100)}% of the cohort is one symbol`);
  }
  if (perSessionExpectancy.length && sessionsPositive <= 1 && perSessionExpectancy.length > 2) {
    warnings.push("positive expectancy comes from at most one session");
  }

  return {
    profitFactorExBest: pfExBest,
    profitFactorCapped: pfCapped,
    cappedAtPct: V2_RETURN_CAP_PCT,
    expectancyExBest: exBestReturns.length ? mean(exBestReturns) : null,
    perSessionExpectancy,
    sessionsPositive,
    sessionsNegative,
    bestEventShareOfGross: bestShare,
    symbolConcentration,
    strategyConcentration,
    regimeConcentration,
    tailFrequency,
    survivesBestExcluded: survives,
    warnings,
  };
}

export function selectCohortV2(members: readonly CohortV2Member[], key: CohortV2Key): CohortV2Member[] {
  return members.filter((m) => {
    // A null in the key means "do not cut on this", never "match rows whose value is
    // missing" — otherwise a cohort of rows with ABSENT data reads as a cohort sharing
    // a property.
    if (key.side != null && m.side !== key.side) return false;
    if (key.strategyKey != null && m.strategyKey !== key.strategyKey) return false;
    if (key.regime != null && m.regime !== key.regime) return false;
    if (key.discoveryStage != null && m.discoveryStage !== key.discoveryStage) return false;
    if (key.dteBucket != null && m.dteBucket !== key.dteBucket) return false;
    return true;
  });
}

/**
 * Compute the cohort.
 *
 * Two samples are tracked separately and gated separately. MILESTONES use every member
 * with a milestone map, because "it touched +25% at this moment" is an observation that
 * survives thin coverage. EXTREMES use only members whose evidence supports one, because
 * a maximum asserts the gaps held nothing larger.
 */
export function computeCohortV2(
  members: readonly CohortV2Member[],
  key: CohortV2Key,
  opts: { replayVersion?: string | null } = {},
): CohortV2Result {
  const floorResult = floors(members.length, members.map((m) => m.sessionDate), "historical events");
  // The reported sessions are the VERIFIED ones, so `sessions` and the floor can never
  // disagree about what counted.
  const sessions = floorResult.sessionAudit.sessions;

  const extremeMembers = members.filter((m) => m.evidenceQuality === "VERIFIED" && m.mfePct != null);
  const extremeFloors = floors(extremeMembers.length, extremeMembers.map((m) => m.sessionDate), "verified extremes");

  // Only members that could witness a milestone form its denominator.
  const witnesses = members.filter(canWitnessMilestones);
  const excludedNoWitness = members.length - witnesses.length;

  const milestones: MilestoneEstimate[] = FORWARD_MILESTONES.map((m) => {
    const times = witnesses
      .map((x) => x.msToMilestone[String(m)])
      .filter((v): v is number => v != null);
    const reached = times.length;
    const of = witnesses.length;

    const observation: MilestoneEstimate["observation"] = of === 0
      ? "EVIDENCE_UNAVAILABLE"
      : reached > 0 ? "OBSERVED" : "OBSERVED_ZERO";

    // A point estimate is published only when the floors hold AND something could witness.
    const probability = floorResult.verdict === "SUPPORTED" && of > 0
      ? +(reached / of).toFixed(4)
      : null;
    const upper = of > 0 ? wilsonUpper95(reached, of) : null;

    const note = observation === "EVIDENCE_UNAVAILABLE"
      ? "no member had a post-entry quote; this milestone was never observable and this row "
        + "is NOT evidence the milestone is unreachable"
      : observation === "OBSERVED_ZERO"
        ? `${of} witnessed member(s) and none reached +${m}%. An observed zero, not a `
          + `probability of zero: the true rate is only bounded below ${upper != null ? `${(upper * 100).toFixed(1)}%` : "an unknown ceiling"}`
        : `${reached} of ${of} witnessed member(s) reached +${m}%`;

    return {
      milestone: m,
      reached,
      of,
      excludedNoWitness,
      probability,
      observation,
      upperBound95: upper,
      medianMsToReach: median(times),
      verdict: floorResult.verdict,
      note,
    };
  });

  const supported = <T>(f: EvidenceFloorResult, v: T): T | null => (f.verdict === "SUPPORTED" ? v : null);

  const withReturn = members.filter((m) => returnOf(m) != null);
  const returns = withReturn.map((m) => returnOf(m) as number);
  const winners = returns.filter((r) => r > 0);
  const losers = returns.filter((r) => r <= 0);

  // "Stopped before doing anything": reached no milestone at all and finished negative.
  // Witnesses only, and only members whose outcome is actually known — `returnOf(m) ?? 0`
  // would score every unmeasured member as a non-positive outcome and inflate this.
  const stopCandidates = witnesses.filter((m) => returnOf(m) != null);
  const stopped = stopCandidates.filter(
    (m) => FORWARD_MILESTONES.every((x) => m.msToMilestone[String(x)] == null) && (returnOf(m) as number) <= 0,
  ).length;

  const peakTimes = witnesses
    .map((m) => {
      const hit = [...FORWARD_MILESTONES]
        .reverse()
        .map((x) => m.msToMilestone[String(x)])
        .find((v) => v != null);
      return hit ?? null;
    })
    .filter((v): v is number => v != null);

  const quality: Record<WinnerEvent["evidenceQuality"], number> = { VERIFIED: 0, THIN: 0, UNSUPPORTED: 0 };
  for (const m of members) quality[m.evidenceQuality] += 1;

  const robustness = robustnessFor(members);

  return {
    version: HISTORICAL_COHORT_V2_VERSION,
    cohortId: cohortV2IdFor({ ...key, replayVersion: opts.replayVersion ?? key.replayVersion ?? null }),
    key,
    lane: key.lane,
    dateRange: { from: sessions[0] ?? null, to: sessions[sessions.length - 1] ?? null },
    sessions,
    floors: floorResult,
    extremeSample: extremeFloors,
    milestones,
    pStopBeforeFirstMilestone: supported(
      floorResult,
      stopCandidates.length ? +(stopped / stopCandidates.length).toFixed(4) : null,
    ),
    expectedMfePct: supported(extremeFloors, mean(extremeMembers.map((m) => m.mfePct as number))),
    expectedMaePct: supported(extremeFloors, mean(extremeMembers.filter((m) => m.maePct != null).map((m) => m.maePct as number))),
    expectedReturnPct: supported(floorResult, mean(returns)),
    medianReturnPct: supported(floorResult, median(returns)),
    profitFactor: supported(floorResult, profitFactor(returns)),
    avgWinnerPct: supported(floorResult, mean(winners)),
    avgLoserPct: supported(floorResult, mean(losers)),
    winRate: supported(floorResult, returns.length ? +(winners.length / returns.length).toFixed(4) : null),
    medianMsToPeak: supported(floorResult, median(peakTimes)),
    robustness,
    priceConvention:
      "entry = ASK at the replay instant (a buyer crosses); later observations = MID. "
      + "Final return is the LAST observed value, never the peak.",
    replayVersion: opts.replayVersion ?? key.replayVersion ?? null,
    dataQualityCoverage: quality,
    limitations: [
      "SHADOW ONLY. No gate, threshold, ranking weight, stop, exit or subscriber decision reads this.",
      `Lane is ${key.lane} and is part of the cohort identity. Lanes are never pooled.`,
      "Milestone TIMES admit every member; EXTREMES admit only VERIFIED evidence. The two samples "
      + "are gated separately and reported separately.",
      "A null statistic means the sample did not clear the floors. It never means zero.",
      "Robustness is computed even when the floors fail: a 6-event cohort that is 90% one symbol is "
      + "worth seeing before more collection is planned.",
      "Historical replay can only initialize a hypothesis. Forward evidence alone can validate one.",
    ],
  };
}

/** Adapt winner events into cohort members. Metadata the event lacks stays null. */
export function membersFromWinnerEvents(
  events: readonly WinnerEvent[],
  enrich: (e: WinnerEvent) => Partial<Pick<CohortV2Member, "strategyKey" | "regime" | "discoveryStage" | "dteBucket" | "finalReturnPct">> = () => ({}),
): CohortV2Member[] {
  return events.map((e) => {
    const extra = enrich(e) ?? {};
    return {
      eventId: e.eventId,
      occ: e.occ,
      symbol: e.symbol,
      sessionDate: e.sessionDate,
      side: e.side,
      strategyKey: extra.strategyKey ?? null,
      regime: extra.regime ?? null,
      discoveryStage: extra.discoveryStage ?? null,
      dteBucket: extra.dteBucket ?? null,
      // Absent unless the caller supplies it: an event knows its extremes, not where it
      // was eventually closed, and inferring one from the other is the peak-as-outcome
      // error this module refuses.
      finalReturnPct: extra.finalReturnPct ?? null,
      mfePct: e.mfePct,
      maePct: e.maePct,
      msToMilestone: e.msToMilestone,
      peakMilestone: e.peakMilestone,
      postEntryQuotes: e.quotesUsed ?? null,
      evidenceQuality: e.evidenceQuality,
    };
  });
}
