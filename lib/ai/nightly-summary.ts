/**
 * ai/nightly-summary.ts — PURE deterministic nightly miss-diagnosis summary.
 *
 * The deterministic system computes ALL statistics here from real recorded rows;
 * the LLM only narrates the result. Nothing is fabricated: an empty bucket reports
 * 0/null, never an invented number. This module has no DB/network/model imports so
 * it is fully unit-testable and its output is the ONLY thing the narrator sees.
 *
 * Authoritative sources (persisted): graded paper-trade outcomes + paper
 * candidates. Best-effort sources (in-memory, may be null after a restart):
 * near-miss / alert-timing / crossing-rescue counts — surfaced honestly as
 * `available: false` when absent rather than guessed.
 */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One graded outcome joined with its paper trade (subset the summary needs). */
export interface OutcomeInput {
  strategy: string | null;
  direction: string | null;        // 'CALL' | 'PUT' | 'LONG'
  dteAtEntry: number | null;
  entrySession: string | null;
  entryTimeMs: number | null;
  terminalKind: string | null;
  grade: string;                   // WIN | LOSS | BREAKEVEN | UNGRADABLE
  gradingStatus: string;           // GRADED | UNGRADABLE
  returnPct: number | null;
  opportunityGrade: string | null; // HIT | NONE | UNGRADABLE
  peakFavorablePct: number | null;
}

/** One paper candidate row for the day (eligible/created/rejected). */
export interface CandidateInput {
  status: string;                  // ELIGIBLE | CREATED | REJECTED
  rejectReason: string | null;
  entryState: string | null;
  confidenceTier: string | null;
  direction: string | null;
}

/** Best-effort in-memory instrumentation (null when a restart cleared it). */
export interface LiveInstrumentation {
  available: boolean;
  actionableAlerts: number | null;
  nearMissCount: number | null;
  lateCalloutCount: number | null;
  crossingRescues: number | null;
  avgTriggerToDiscordMs: number | null;
}

/**
 * Pre-computed momentum-stock decision digest (from the persisted
 * momentum_diagnostics table). Structural type only — the impure summarizer lives
 * in lib/momentum-diagnostics.ts so this module stays DB-free and pure.
 */
export interface MomentumMissDigest {
  total: number;
  sent: number;
  rescued: number;
  nearMisses: number;
  rejected: number;
  extendedRejections: number;
  staleRejected: number;
  avgLatencyMs: number | null;
  /** Directional-safety counts (META fix): wrong-direction alerts held back. */
  deliveryRevalidationFailed?: number;
  directionSuppressed?: number;
  /** Post-trade alert-earliness rollup (§Part 6) — deterministic, hindsight-free. */
  earliness?: {
    graded: number;
    ungradable: number;
    counts: Record<string, number>;
    pctEarly: number | null;
    pctLateOrExhausted: number | null;
    medianOnsetToAlertMs: number | null;
    slowGrinderAlerts: number;
    fastRunnerAlerts: number;
  };
}

/** Pre-computed options-funnel digest (from the persisted options_diagnostics table). */
export interface OptionsFunnelDigest {
  cycles: number;
  setupsQualified: number;
  chainsFetched: number;
  canonical: number;
  emitted: number;
  delivered: number;
  emittedButUndelivered: number;
  configBlockedCycles: number;
  topDeliveryGateReason: string | null;
  diagnosis: string | null;
}

export interface NightlySummaryInput {
  tradingDay: string;
  periodStartMs: number | null;
  periodEndMs: number | null;
  outcomes: OutcomeInput[];
  candidates: CandidateInput[];
  live?: LiveInstrumentation | null;
  /** Deterministic momentum-stock diagnostics for the day (null when none recorded). */
  momentum?: MomentumMissDigest | null;
  /** Deterministic options-funnel diagnostics for the day (null when none recorded). */
  options?: OptionsFunnelDigest | null;
}

interface PerfBucket {
  n: number;
  wins: number;
  losses: number;
  breakeven: number;
  ungradable: number;
  winRate: number | null;          // over GRADED only
  breakevenRatePct: number | null; // over GRADED only
  avgReturnPct: number | null;     // over rows with a return
  opportunityHits: number;
  opportunityGradable: number;
  opportunityHitRate: number | null;
}

function newBucket(): { _ret: number[] } & PerfBucket {
  return { n: 0, wins: 0, losses: 0, breakeven: 0, ungradable: 0, winRate: null, breakevenRatePct: null, avgReturnPct: null, opportunityHits: 0, opportunityGradable: 0, opportunityHitRate: null, _ret: [] };
}

function addOutcome(b: ReturnType<typeof newBucket>, o: OutcomeInput): void {
  b.n += 1;
  const g = String(o.grade ?? "").toUpperCase();
  if (o.gradingStatus === "GRADED") {
    if (g === "WIN") b.wins += 1;
    else if (g === "LOSS") b.losses += 1;
    else if (g === "BREAKEVEN") b.breakeven += 1;
  }
  if (g === "UNGRADABLE" || o.gradingStatus !== "GRADED") b.ungradable += 1;
  if (isNum(o.returnPct)) b._ret.push(o.returnPct);
  const og = String(o.opportunityGrade ?? "").toUpperCase();
  if (og === "HIT" || og === "NONE") {
    b.opportunityGradable += 1;
    if (og === "HIT") b.opportunityHits += 1;
  }
}

function finalizeBucket(b: ReturnType<typeof newBucket>): PerfBucket {
  const graded = b.wins + b.losses + b.breakeven;
  const winRate = graded > 0 ? round1((b.wins / graded) * 100) : null;
  const breakevenRatePct = graded > 0 ? round1((b.breakeven / graded) * 100) : null;
  const avgReturnPct = b._ret.length ? round2(b._ret.reduce((a, c) => a + c, 0) / b._ret.length) : null;
  const opportunityHitRate = b.opportunityGradable > 0 ? round1((b.opportunityHits / b.opportunityGradable) * 100) : null;
  const { _ret, ...rest } = b;
  return { ...rest, winRate, breakevenRatePct, avgReturnPct, opportunityHitRate };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** ET hour (0-23) for a timestamp, or null. Pure via Intl (no SQLite). */
function etHour(ms: number | null): number | null {
  if (!isNum(ms)) return null;
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(ms));
  const n = Number(h) % 24;
  return Number.isFinite(n) ? n : null;
}

/** Coarse time-of-day bucket for an ET hour. */
function timeBucket(hour: number | null): string {
  if (hour == null) return "unknown";
  if (hour < 10) return "open_0930_1000";
  if (hour < 12) return "morning_1000_1200";
  if (hour < 14) return "midday_1200_1400";
  if (hour < 16) return "afternoon_1400_1600";
  return "extended";
}

const LIQUIDITY_RE = /spread|liquid|quote|nbbo|bid|ask|wide/i;
const CONTRACT_RE = /contract|occ|symbol|strike|expiration|incomplete|no valid contract|no_valid_contract/i;

export interface NightlySummary {
  version: number;
  tradingDay: string;
  periodStartMs: number | null;
  periodEndMs: number | null;
  counts: {
    outcomesGraded: number;
    outcomesUngradable: number;
    candidates: number;
    created: number;
    eligible: number;
    rejected: number;
    actionableAlerts: number | null;
    nearMisses: number | null;
    lateCallouts: number | null;
    crossingRescues: number | null;
    contractDataRejections: number;
    liquidityRejections: number;
  };
  rejectionReasons: Record<string, number>;
  waitWatchReasons: Record<string, number>;
  timing: { avgTriggerToDiscordMs: number | null; available: boolean };
  callsVsPuts: { call: PerfBucket; put: PerfBucket };
  zeroDteVsLonger: { zeroDte: PerfBucket; longer: PerfBucket };
  byStrategy: Record<string, PerfBucket>;
  byTimeOfDay: Record<string, PerfBucket>;
  realizedGrade: Record<string, number>;
  opportunityGrade: Record<string, number>;
  /** Signal was right (opportunity HIT) but the trade was managed to a non-win. */
  signalCorrectExitFailed: number;
  /** Both the signal and the trade failed (opportunity NONE and realized LOSS). */
  bothFailed: number;
  /** Deterministic patterns + the single prioritized issue for review. */
  patterns: string[];
  prioritizedIssue: string | null;
  dataGaps: string[];
  overall: PerfBucket;
  /** Momentum-stock miss digest (null when no diagnostics were recorded). */
  momentum: MomentumMissDigest | null;
  /** Options-funnel digest (null when no supervisor cycles were recorded). */
  options: OptionsFunnelDigest | null;
}

export const NIGHTLY_SUMMARY_VERSION = 1;

/** Compute the deterministic nightly summary. PURE — same input ⇒ same output. */
export function buildNightlySummary(input: NightlySummaryInput): NightlySummary {
  const overall = newBucket();
  const call = newBucket(), put = newBucket();
  const zeroDte = newBucket(), longer = newBucket();
  const byStrategy: Record<string, ReturnType<typeof newBucket>> = {};
  const byTimeOfDay: Record<string, ReturnType<typeof newBucket>> = {};
  const realizedGrade: Record<string, number> = {};
  const opportunityGrade: Record<string, number> = {};
  let signalCorrectExitFailed = 0;
  let bothFailed = 0;

  for (const o of input.outcomes) {
    addOutcome(overall, o);
    const dir = String(o.direction ?? "").toUpperCase();
    if (dir === "CALL") addOutcome(call, o);
    else if (dir === "PUT") addOutcome(put, o);
    if (isNum(o.dteAtEntry)) addOutcome(o.dteAtEntry === 0 ? zeroDte : longer, o);
    const strat = o.strategy || "unknown";
    (byStrategy[strat] ??= newBucket());
    addOutcome(byStrategy[strat], o);
    const tb = timeBucket(etHour(o.entryTimeMs));
    (byTimeOfDay[tb] ??= newBucket());
    addOutcome(byTimeOfDay[tb], o);

    const g = String(o.grade ?? "").toUpperCase() || "UNKNOWN";
    realizedGrade[g] = (realizedGrade[g] ?? 0) + 1;
    const og = String(o.opportunityGrade ?? "UNGRADABLE").toUpperCase();
    opportunityGrade[og] = (opportunityGrade[og] ?? 0) + 1;

    if (og === "HIT" && (g === "LOSS" || g === "BREAKEVEN")) signalCorrectExitFailed += 1;
    if (og === "NONE" && g === "LOSS") bothFailed += 1;
  }

  // Candidate rejections / wait-watch states.
  const rejectionReasons: Record<string, number> = {};
  const waitWatchReasons: Record<string, number> = {};
  let created = 0, eligible = 0, rejected = 0, contractDataRejections = 0, liquidityRejections = 0;
  for (const c of input.candidates) {
    const st = String(c.status ?? "").toUpperCase();
    if (st === "CREATED") created += 1;
    else if (st === "ELIGIBLE") eligible += 1;
    else if (st === "REJECTED") {
      rejected += 1;
      const reason = (c.rejectReason || "unspecified").slice(0, 80);
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
      if (CONTRACT_RE.test(reason)) contractDataRejections += 1;
      if (LIQUIDITY_RE.test(reason)) liquidityRejections += 1;
    }
    if (c.entryState && !["ACTIONABLE", "ACTIONABLE_NOW"].includes(String(c.entryState).toUpperCase())) {
      const es = String(c.entryState).toUpperCase();
      waitWatchReasons[es] = (waitWatchReasons[es] ?? 0) + 1;
    }
  }

  const live = input.live ?? null;
  const momentum = input.momentum ?? null;
  const options = input.options ?? null;
  const dataGaps: string[] = [];
  if (!live?.available) dataGaps.push("live near-miss / alert-timing / crossing-rescue instrumentation unavailable (in-memory; cleared on restart)");
  if (input.outcomes.length === 0) dataGaps.push("no graded paper-trade outcomes for this day");
  if (input.candidates.length === 0) dataGaps.push("no paper candidates recorded for this day");
  if (!momentum || momentum.total === 0) dataGaps.push("no momentum-stock diagnostics recorded (STOCK_CALLOUTS off, or no movers evaluated)");
  if (!options || options.cycles === 0) dataGaps.push("no options-funnel diagnostics recorded (SUPERVISOR_RUNTIME off, or no cycles ran)");

  // Deterministic patterns + one prioritized issue (the narrator explains these,
  // it does not choose them). Ordered by evidence weight.
  const patterns: string[] = [];
  const topReason = Object.entries(rejectionReasons).sort((a, b) => b[1] - a[1])[0];
  if (topReason && topReason[1] >= 2) patterns.push(`Most common rejection: "${topReason[0]}" (${topReason[1]}×).`);
  if (signalCorrectExitFailed >= 2) patterns.push(`${signalCorrectExitFailed} trades where the signal was right (opportunity HIT) but exit management gave it back.`);
  if (bothFailed >= 2) patterns.push(`${bothFailed} trades where both the signal and the trade failed.`);
  if (isNum(live?.crossingRescues) && (live!.crossingRescues as number) > 0) patterns.push(`${live!.crossingRescues} breakout-crossing rescues fired.`);
  if (contractDataRejections >= 1) patterns.push(`${contractDataRejections} callouts blocked by incomplete contract data.`);
  if (liquidityRejections >= 1) patterns.push(`${liquidityRejections} callouts blocked by liquidity/spread.`);
  // Options funnel — the config-gate case is the highest-signal "no alerts" cause.
  if (options && options.configBlockedCycles > 0) {
    patterns.push(`Options Discord delivery is DISABLED by config on ${options.configBlockedCycles} cycle(s): ${options.topDeliveryGateReason ?? "supervisor delivery off"} — ${options.emittedButUndelivered} emittable callout(s) were never sent.`);
  } else if (options && options.cycles > 0 && options.canonical === 0) {
    patterns.push(`${options.cycles} supervisor cycle(s) produced 0 canonical options callouts (candidates died at the agent/selector/entry-window stage).`);
  } else if (options && options.delivered > 0) {
    patterns.push(`${options.delivered} options callout(s) delivered across ${options.cycles} cycle(s).`);
  }
  // Momentum stock funnel.
  if (momentum && momentum.rescued > 0) patterns.push(`${momentum.rescued} momentum stock callout(s) were rescued by the crossing latch.`);
  if (momentum && momentum.nearMisses >= 2) patterns.push(`${momentum.nearMisses} momentum near-miss(es); ${momentum.extendedRejections} arrived already extended, ${momentum.staleRejected} on stale quotes.`);
  // Directional safety (META after-hours fix): the bullish invariant + delivery revalidation.
  if (momentum && ((momentum.directionSuppressed ?? 0) > 0 || (momentum.deliveryRevalidationFailed ?? 0) > 0)) {
    patterns.push(`Direction safety: ${momentum.directionSuppressed ?? 0} wrong-direction bullish setup(s) suppressed (${momentum.deliveryRevalidationFailed ?? 0} at delivery-time revalidation) — a stock must show current-session upward evidence, not a stale regular-session gain.`);
  }
  // Alert-earliness quality (§Part 6): how fresh were the alerts that actually sent?
  if (momentum?.earliness && momentum.earliness.graded > 0) {
    const e = momentum.earliness;
    patterns.push(`Alert earliness: ${e.pctEarly ?? 0}% EARLY, ${e.pctLateOrExhausted ?? 0}% LATE/EXHAUSTED across ${e.graded} graded alert(s); median acceleration-onset→alert ${e.medianOnsetToAlertMs != null ? Math.round(e.medianOnsetToAlertMs / 1000) + "s" : "n/a"} (fast-runner ${e.fastRunnerAlerts}, slow-grinder ${e.slowGrinderAlerts}).`);
    if ((e.pctLateOrExhausted ?? 0) >= 40) patterns.push(`WARNING: ${e.pctLateOrExhausted}% of momentum alerts landed LATE/EXHAUSTED — alerts are firing after the move rather than into fresh acceleration.`);
  }

  let prioritizedIssue: string | null = null;
  if (options && options.configBlockedCycles > 0 && options.emittedButUndelivered > 0) {
    // A silent, mis-configured delivery path outranks every downstream signal issue —
    // nothing else matters if actionable alerts physically cannot be sent.
    prioritizedIssue = "options_delivery_disabled";
  } else if (signalCorrectExitFailed >= 2 && signalCorrectExitFailed >= bothFailed) {
    prioritizedIssue = "exit_management";
  } else if (topReason && topReason[1] >= 3) {
    prioritizedIssue = LIQUIDITY_RE.test(topReason[0]) ? "liquidity" : CONTRACT_RE.test(topReason[0]) ? "contract_data" : "rejection_pattern";
  } else if (bothFailed >= 2) {
    prioritizedIssue = "signal_quality";
  } else if (isNum(live?.lateCalloutCount) && (live!.lateCalloutCount as number) >= 2) {
    prioritizedIssue = "late_callouts";
  } else if (momentum && momentum.nearMisses >= 3 && momentum.sent === 0) {
    prioritizedIssue = "momentum_misses";
  }

  return {
    version: NIGHTLY_SUMMARY_VERSION,
    tradingDay: input.tradingDay,
    periodStartMs: input.periodStartMs,
    periodEndMs: input.periodEndMs,
    counts: {
      outcomesGraded: overall.wins + overall.losses + overall.breakeven,
      outcomesUngradable: overall.ungradable,
      candidates: input.candidates.length,
      created, eligible, rejected,
      actionableAlerts: live?.actionableAlerts ?? null,
      nearMisses: live?.nearMissCount ?? null,
      lateCallouts: live?.lateCalloutCount ?? null,
      crossingRescues: live?.crossingRescues ?? null,
      contractDataRejections, liquidityRejections,
    },
    rejectionReasons,
    waitWatchReasons,
    timing: { avgTriggerToDiscordMs: live?.avgTriggerToDiscordMs ?? null, available: Boolean(live?.available) },
    callsVsPuts: { call: finalizeBucket(call), put: finalizeBucket(put) },
    zeroDteVsLonger: { zeroDte: finalizeBucket(zeroDte), longer: finalizeBucket(longer) },
    byStrategy: Object.fromEntries(Object.entries(byStrategy).map(([k, v]) => [k, finalizeBucket(v)])),
    byTimeOfDay: Object.fromEntries(Object.entries(byTimeOfDay).map(([k, v]) => [k, finalizeBucket(v)])),
    realizedGrade,
    opportunityGrade,
    signalCorrectExitFailed,
    bothFailed,
    patterns,
    prioritizedIssue,
    dataGaps,
    overall: finalizeBucket(overall),
    momentum,
    options,
  };
}
