/**
 * owner-learning.ts — OWNER_VALIDATION_PAPER as a first-class learning population.
 *
 * The owner lane is the forward-validation population the private callouts actually
 * produce: a Discord opening, one paper mirror on the EXACT contract that was called, a
 * dense same-contract mark series, and a realized close. It is the population most
 * relevant to whether the callouts work, and until this module it had no lane of its own
 * anywhere in the research stack — `buildOwnerAlertSummaryOnDb` reported
 * DELIVERED_ALERT_PAPER under an "OWNER DISCORD ALERTS" heading, and the cohort engine
 * could not give an owner trade a session date at all.
 *
 * ── What is measured here, and what is refused ───────────────────────────────
 *
 * REALIZED performance needs one thing: a closed mirror on the frozen contract with its
 * own return. TRAJECTORY claims — every label below that says something about the path —
 * need a mark series dense enough to have seen the extremes, and are withheld as
 * PATH_UNKNOWN otherwise. A trade can be a VERIFIED realized winner with an unknown path,
 * and saying so is the whole point of keeping the two apart.
 *
 * Nothing here reads `summary.maxReturnPct`, `mfe_pct` or `mae_pct` off a stored row.
 * 36 of 78 delivered cases carry a peak the frozen contract never printed, and a single
 * fallback to that field would put a phantom number into every label at once. Every
 * trajectory value is recomputed from marks whose OWN `option_symbol` is the frozen OCC.
 *
 * ── Labels are measurements, not opinions ────────────────────────────────────
 *
 * Each label is a deterministic function of stored evidence with a stated threshold. A
 * narrator may interpret them. Nothing may invent one, and no label is a signal: this
 * module is read by research and by nothing that selects, ranks, sizes, targets, stops or
 * exits a trade.
 *
 * SHADOW / RESEARCH ONLY. No provider call, no quota spend, no send authority, no writes.
 */

import {
  loadOwnerMirrorPopulationOnDb,
  OWNER_VALIDATION_PAPER_KIND,
  type MirrorIdentityDb,
  type OwnerMirrorRecord,
} from "../../opportunity-case/owner-mirror-identity.ts";
import { excursionForPaperTradeOnDb, type ExcursionEvidenceState } from "../../opportunity-case/excursion.ts";
import { countIndependentSessions, type IndependentSessionCount } from "../historical/trading-sessions.ts";
import { tradingDay } from "../../trading-session.ts";

export const OWNER_LEARNING_VERSION = "OWNER_LEARNING_V1" as const;

export interface OwnerLearningDb extends MirrorIdentityDb {}

// ── thresholds ───────────────────────────────────────────────────────────────
// Stated as named constants because every one of them is an editorial choice and a
// label whose threshold is buried in an expression cannot be argued with.

/** Below this peak the contract never meaningfully traded above the entry. */
export const WORKED_AT_ALL_PCT = 5;
/** At or above this peak the trade genuinely offered profit before whatever came next. */
export const GOOD_MOVE_PCT = 20;
/** Exit worse than the frozen stop by more than this share of the stop is leakage. */
export const STOP_LEAKAGE_TOLERANCE_PCT = 5;
/** A between-session jump of at least this many points of return is a gap, not drift. */
export const OVERNIGHT_GAP_PCT = 10;
/** Minutes after 09:30 ET that still count as the opening bell. */
export const OPENING_BELL_MINUTES = 15;
/** Milestones whose first touch after entry is timed. */
export const OWNER_MILESTONES = [10, 25, 50, 100] as const;

// ── evidence-gated labels ────────────────────────────────────────────────────

/**
 * The trajectory verdict. Mutually exclusive, and PATH_UNKNOWN whenever the marks cannot
 * support any of the others — never a default of "never worked", which is the flattering
 * direction for a scanner and the damning one for a trade.
 */
export type OwnerPathLabel =
  /** Peak below +5%: the contract never traded meaningfully above the entry. */
  | "NEVER_WORKED"
  /** Peak +5..+20%, closed at or below break-even. */
  | "WORKED_SMALL_THEN_FAILED"
  /** Peak >= +20%, Target 1 never reached, closed at or below break-even. */
  | "GOOD_MOVE_THEN_REVERSED"
  /** Target 1 reached and the trade closed profitable. */
  | "EVENTUAL_T1_WINNER"
  /** Closed profitable without a proven Target 1 touch. */
  | "WORKED_AND_HELD"
  /** Reached Target 1 and still closed at or below break-even. */
  | "T1_HIT_THEN_LOST"
  /** Too few same-contract marks, or no close yet, to claim any of the above. */
  | "PATH_UNKNOWN";

export type OwnerTradeFlag =
  | "TARGET_1_HIT"
  | "TARGET_2_HIT"
  | "STOP_LEAKAGE"
  | "OVERNIGHT_GAP"
  | "SAME_DAY_EXIT"
  | "HELD_OVERNIGHT"
  | "OPENING_BELL_EXIT"
  | "STILL_OPEN";

export interface OwnerStopEvidence {
  /** The stop the callout froze. Never recomputed. */
  stopLevel: number | null;
  exitFill: number | null;
  /** (exit − stop) / stop, in percent. Negative = filled below the intended stop. */
  stopSlippagePct: number | null;
  /** True when the exit landed materially below the frozen stop. */
  materialStopBreach: boolean;
  /** True when entry and exit sit on different trading sessions. */
  crossedSessionBoundary: boolean;
  /** Largest between-session jump in same-contract return, in points. Null if unmeasured. */
  overnightGapPct: number | null;
  /** True when the exit landed inside the opening bell window. */
  openingBellExit: boolean;
  /** Why a value above is null, when it is. */
  limitations: string[];
}

export interface OwnerLearningRow {
  /** The claim case — the row that owns the delivery and the frozen trade. */
  opportunityCaseId: string;
  /** The pending audit case — the row that owns the PRE_MOVE evidence. Derived. */
  preMoveCaseId: string | null;
  paperTradeId: number;
  symbol: string | null;
  optionSymbol: string | null;
  /** The contract the callout froze. Authoritative for every figure on this row. */
  frozenOptionSymbol: string | null;
  /** True only when the mirror sits on the exact contract that was called. */
  occExact: boolean;
  side: "CALL" | "PUT" | null;
  strategyKey: string | null;
  setupFamily: string | null;
  dte: number | null;

  sessionDate: string | null;
  enteredAtMs: number | null;
  closedAtMs: number | null;
  exitSessionDate: string | null;
  status: string | null;
  exitReason: string | null;

  entryFill: number | null;
  targetT1: number | null;
  targetT2: number | null;
  stop: number | null;

  realizedReturnPct: number | null;
  realizedEvidence: OwnerMirrorRecord["realizedEvidence"];

  excursionState: ExcursionEvidenceState;
  mfePct: number | null;
  maePct: number | null;
  marksOnContract: number;
  /** Exact-contract marks exist, i.e. the trade was actually observable. */
  exactContractMarksAvailable: boolean;

  /** ms from entry to the FIRST same-contract touch of each milestone. Null = never. */
  msToMilestone: Record<string, number | null>;

  pathLabel: OwnerPathLabel;
  flags: OwnerTradeFlag[];
  stopEvidence: OwnerStopEvidence;

  /** Pre-callout features, research only. Null where the evidence was never captured. */
  selection: {
    /**
     * The delivery-time QUALITY score on a 0–100 scale. Research only — reads no gate.
     *
     * Deliberately not called `selStrength`. An earlier audit reported a selection
     * strength taking values of exactly 100 (n~34) and below 75 (n~13); no field of that
     * name is persisted in this repository, and the owner lane's stored quality spans
     * 70–86 in production. Whatever that audit measured, it was not this column, and
     * renaming this one into it would launder an unreproducible finding into a
     * reproducible-looking one.
     */
    deliveryQualityScore: number | null;
    readinessState: string | null;
    ownerReason: string | null;
    discoveryStage: string | null;
    rewardRemainingBand: string | null;
    rewardRemainingFraction: number | null;
    moveConsumedFraction: number | null;
    premiumExpansionConsumedPct: number | null;
    spreadPct: number | null;
    delta: number | null;
    openInterest: number | null;
    contractVolume: number | null;
    /** Fields the capture site never recorded for this trade. Absent, not zero. */
    unavailable: string[];
  };

  /** Refusals attached to this row, so a missing value is legible where it is missing. */
  limitations: string[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function hasTable(db: OwnerLearningDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name));
  } catch {
    return false;
  }
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

const round = (v: number | null, p = 4): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? round(s[m]) : round((s[m - 1] + s[m]) / 2);
}

const mean = (xs: number[]): number | null =>
  xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 4) : null;

/** Minutes past midnight ET, for the opening-bell window. */
function etMinutes(atMs: number): number | null {
  try {
    const s = new Date(atMs).toLocaleString("en-US", {
      timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit",
    });
    const [h, m] = s.split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  } catch {
    return null;
  }
}

interface MarkRow {
  atMs: number | null;
  returnPct: number | null;
  exitFill: number | null;
}

/** Same-contract marks only. A mark on a re-selected strike is a different instrument. */
function marksForTrade(db: OwnerLearningDb, tradeId: number, occ: string | null): MarkRow[] {
  if (!occ || !hasTable(db, "options_paper_marks")) return [];
  try {
    return ((db.prepare(
      `SELECT mark_at_ms, return_pct, exit_fill FROM options_paper_marks
        WHERE trade_id=? AND UPPER(TRIM(option_symbol))=UPPER(TRIM(?))
        ORDER BY mark_at_ms ASC`,
    ).all?.(tradeId, occ) ?? []) as Record<string, any>[]).map((r) => ({
      atMs: num(r.mark_at_ms),
      returnPct: num(r.return_pct),
      exitFill: num(r.exit_fill),
    }));
  } catch {
    return [];
  }
}

/** The PRE_MOVE row for a callout, found through the PENDING audit case id. */
function preMoveFeaturesFor(
  db: OwnerLearningDb,
  preMoveCaseId: string | null,
  claimCaseId: string,
): Record<string, any> | null {
  if (!hasTable(db, "opportunity_pre_move_discovery")) return null;
  const ids = [preMoveCaseId, claimCaseId].filter((v): v is string => !!v);
  for (const id of ids) {
    try {
      const row = db.prepare(
        `SELECT discovery_stage, reward_remaining_band, reward_remaining_fraction,
                move_consumed_fraction, premium_expansion_consumed_pct,
                spread_pct, delta, open_interest, contract_volume, dte, lane,
                owner_notified_at_ms, first_detected_at_ms
           FROM opportunity_pre_move_discovery WHERE opportunity_case_id=?`,
      ).get?.(id) as Record<string, any> | undefined;
      if (row) return row;
    } catch {
      return null;
    }
  }
  return null;
}

// ── the per-trade learning row ───────────────────────────────────────────────

/**
 * Turn one resolved owner mirror into a measured learning row.
 *
 * Exported so the labelling can be tested against a fixture directly, without a database
 * shaped like production behind it.
 */
export function buildOwnerLearningRow(
  db: OwnerLearningDb,
  mirror: OwnerMirrorRecord,
): OwnerLearningRow {
  const limitations: string[] = [];
  const occ = mirror.optionSymbol;
  const excursion = excursionForPaperTradeOnDb(db as any, mirror.paperTradeId, occ);
  const marks = marksForTrade(db, mirror.paperTradeId, occ);
  const pre = preMoveFeaturesFor(db, mirror.preMoveCaseId, mirror.opportunityCaseId);

  const sessionDate = mirror.enteredAtMs == null ? null : tradingDay(mirror.enteredAtMs);
  const exitSessionDate = mirror.closedAtMs == null ? null : tradingDay(mirror.closedAtMs);
  const closed = mirror.status === "EXITED";
  const realized = mirror.realizedReturnPct;

  if (!mirror.occExact) {
    limitations.push(
      "the mirror is not on the contract the callout froze, so no trajectory or realized "
      + "figure on this row may be attributed to the callout",
    );
  }

  // ── milestones, timed from ENTRY on the frozen contract's own marks ────────
  const msToMilestone: Record<string, number | null> = {};
  const entryMs = mirror.enteredAtMs;
  for (const m of OWNER_MILESTONES) {
    const key = String(m);
    if (entryMs == null || !marks.length) { msToMilestone[key] = null; continue; }
    const hit = marks.find((k) => k.returnPct != null && k.returnPct >= m && k.atMs != null && k.atMs >= entryMs);
    msToMilestone[key] = hit?.atMs != null ? hit.atMs - entryMs : null;
  }

  // ── target touches, on PRICE rather than return ───────────────────────────
  // The frozen targets are prices. Deriving them from the return series would need the
  // entry fill to reproduce exactly, and a rounding difference would silently reclassify
  // a trade. The mark's own `exit_fill` is the price that was actually observed.
  const touched = (level: number | null): boolean =>
    level != null && marks.some((k) => k.exitFill != null && k.exitFill >= level);
  const t1Hit = touched(mirror.targetT1);
  const t2Hit = touched(mirror.targetT2);
  if (mirror.targetT1 == null) limitations.push("the callout froze no Target 1, so a Target 1 touch cannot be decided");

  // ── trajectory verdict ────────────────────────────────────────────────────
  const pathEvidence = excursion.state === "VERIFIED_EXCURSION" && excursion.mfePct != null;
  const mfe = pathEvidence ? excursion.mfePct : null;
  let pathLabel: OwnerPathLabel = "PATH_UNKNOWN";
  if (!closed) {
    limitations.push("the position has not closed, so no path verdict is available yet");
  } else if (realized == null) {
    limitations.push("the position closed without a realized return, so no path verdict is available");
  } else if (!pathEvidence) {
    limitations.push(
      `${excursion.marksOnContract} same-contract mark(s) — too few to claim a peak, so the path verdict is withheld`,
    );
  } else if (t1Hit) {
    pathLabel = realized > 0 ? "EVENTUAL_T1_WINNER" : "T1_HIT_THEN_LOST";
  } else if (realized > 0) {
    pathLabel = "WORKED_AND_HELD";
  } else if ((mfe as number) < WORKED_AT_ALL_PCT) {
    pathLabel = "NEVER_WORKED";
  } else if ((mfe as number) < GOOD_MOVE_PCT) {
    pathLabel = "WORKED_SMALL_THEN_FAILED";
  } else {
    pathLabel = "GOOD_MOVE_THEN_REVERSED";
  }

  // ── stop and session evidence ─────────────────────────────────────────────
  const stopLimitations: string[] = [];
  const exitFill = closed ? mirror.exitFill : null;
  const stop = mirror.stop;
  const stopSlippagePct = stop != null && stop > 0 && exitFill != null
    ? round(((exitFill - stop) / stop) * 100, 2)
    : null;
  if (stop == null) stopLimitations.push("the callout froze no stop");
  if (closed && exitFill == null) stopLimitations.push("the closed mirror records no exit fill");

  const crossedSessionBoundary = sessionDate != null && exitSessionDate != null && sessionDate !== exitSessionDate;
  const overnightGapPct = largestBetweenSessionJump(marks);
  if (crossedSessionBoundary && overnightGapPct == null) {
    stopLimitations.push("the trade crossed a session boundary but has no mark on both sides of it");
  }
  const openingBellExit = (() => {
    if (mirror.closedAtMs == null) return false;
    const m = etMinutes(mirror.closedAtMs);
    return m != null && m >= 9 * 60 + 30 && m <= 9 * 60 + 30 + OPENING_BELL_MINUTES;
  })();
  const materialStopBreach = stopSlippagePct != null && stopSlippagePct < -STOP_LEAKAGE_TOLERANCE_PCT;

  const stopEvidence: OwnerStopEvidence = {
    stopLevel: stop,
    exitFill,
    stopSlippagePct,
    materialStopBreach,
    crossedSessionBoundary,
    overnightGapPct,
    openingBellExit,
    limitations: stopLimitations,
  };

  const flags: OwnerTradeFlag[] = [];
  if (t1Hit) flags.push("TARGET_1_HIT");
  if (t2Hit) flags.push("TARGET_2_HIT");
  if (materialStopBreach) flags.push("STOP_LEAKAGE");
  if (overnightGapPct != null && Math.abs(overnightGapPct) >= OVERNIGHT_GAP_PCT) flags.push("OVERNIGHT_GAP");
  if (closed && crossedSessionBoundary) flags.push("HELD_OVERNIGHT");
  if (closed && !crossedSessionBoundary && sessionDate != null) flags.push("SAME_DAY_EXIT");
  if (openingBellExit) flags.push("OPENING_BELL_EXIT");
  if (!closed) flags.push("STILL_OPEN");

  // ── pre-callout features, research only ───────────────────────────────────
  const selection = {
    deliveryQualityScore: mirror.deliveryQualityScore,
    readinessState: mirror.readinessState,
    ownerReason: mirror.ownerReason,
    discoveryStage: str(pre?.discovery_stage),
    rewardRemainingBand: str(pre?.reward_remaining_band),
    rewardRemainingFraction: num(pre?.reward_remaining_fraction),
    moveConsumedFraction: num(pre?.move_consumed_fraction),
    premiumExpansionConsumedPct: num(pre?.premium_expansion_consumed_pct),
    spreadPct: num(pre?.spread_pct),
    delta: num(pre?.delta),
    openInterest: num(pre?.open_interest),
    contractVolume: num(pre?.contract_volume),
    unavailable: [] as string[],
  };
  selection.unavailable = Object.entries(selection)
    .filter(([k, v]) => k !== "unavailable" && v == null)
    .map(([k]) => k)
    .sort();
  if (pre == null) {
    limitations.push(
      "no PRE_MOVE discovery row was found for this callout under either its claim case or its "
      + "derived pending audit case, so no pre-callout feature is available",
    );
  }

  return {
    opportunityCaseId: mirror.opportunityCaseId,
    preMoveCaseId: mirror.preMoveCaseId,
    paperTradeId: mirror.paperTradeId,
    symbol: mirror.symbol,
    optionSymbol: occ,
    frozenOptionSymbol: mirror.frozenOptionSymbol,
    occExact: mirror.occExact,
    side: mirror.side,
    strategyKey: mirror.strategyKey,
    setupFamily: mirror.setupFamily,
    dte: mirror.dte,
    sessionDate,
    enteredAtMs: mirror.enteredAtMs,
    closedAtMs: mirror.closedAtMs,
    exitSessionDate,
    status: mirror.status,
    exitReason: mirror.exitReason,
    entryFill: mirror.entryFill,
    targetT1: mirror.targetT1,
    targetT2: mirror.targetT2,
    stop: mirror.stop,
    realizedReturnPct: realized,
    realizedEvidence: mirror.realizedEvidence,
    excursionState: excursion.state,
    mfePct: mfe,
    maePct: pathEvidence ? excursion.maePct : null,
    marksOnContract: excursion.marksOnContract,
    exactContractMarksAvailable: mirror.exactContractMarksAvailable,
    msToMilestone,
    pathLabel,
    flags,
    stopEvidence,
    selection,
    limitations,
  };
}

/**
 * The largest jump in same-contract return ACROSS a session boundary.
 *
 * Measured between the last mark of one trading day and the first mark of the next, which
 * is the only place an overnight gap can show up in a mark series. Consecutive marks
 * inside one session are drift, however large, and are deliberately not counted here.
 */
export function largestBetweenSessionJump(marks: readonly MarkRow[]): number | null {
  const usable = marks.filter((m) => m.atMs != null && m.returnPct != null);
  if (usable.length < 2) return null;
  let biggest: number | null = null;
  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1];
    const cur = usable[i];
    if (tradingDay(prev.atMs as number) === tradingDay(cur.atMs as number)) continue;
    const jump = (cur.returnPct as number) - (prev.returnPct as number);
    if (biggest == null || Math.abs(jump) > Math.abs(biggest)) biggest = round(jump, 4);
  }
  return biggest;
}

// ── the lane summary ─────────────────────────────────────────────────────────

export interface OwnerLaneStatistics {
  version: typeof OWNER_LEARNING_VERSION;
  lane: typeof OWNER_VALIDATION_PAPER_KIND;
  /** Null when the summary covers the whole lane rather than one session. */
  sessionDate: string | null;

  openings: number;
  exactMirrors: number;
  occMismatches: number;
  missingCaseIdentity: number;
  ambiguousCases: number;
  /** exactMirrors / openings, over the mirrors this summary could see. */
  mirrorRate: number | null;

  closed: number;
  open: number;
  ungradable: number;
  wins: number;
  losses: number;
  winRate: number | null;
  meanRealizedReturnPct: number | null;
  medianRealizedReturnPct: number | null;
  profitFactor: number | null;
  /** Profit factor with the single best winner removed. Tail-dependence check. */
  profitFactorWithoutTopWinner: number | null;
  bestWinnerPct: number | null;
  worstLossPct: number | null;
  callCount: number;
  putCount: number;

  sessions: string[];
  sessionAudit: IndependentSessionCount;
  dateRange: { from: string | null; to: string | null };

  byStrategy: Array<{
    strategy: string; n: number; wins: number; losses: number;
    expectancyPct: number | null; profitFactor: number | null;
  }>;
  byPathLabel: Record<string, number>;
  byFlag: Record<string, number>;
  /** Closed rows whose marks could not support a path verdict. */
  withoutTrajectoryEvidence: number;
  /** Closed rows that filled materially below the frozen stop. */
  stopLeakage: number;
  /** Closed rows that crossed a session boundary. */
  heldOvernight: number;
  /** Closed rows with a measured between-session gap at or beyond the threshold. */
  overnightGaps: number;

  unavailableMetrics: string[];
  limitations: string[];
}

function stats(returns: number[]): {
  expectancyPct: number | null; profitFactor: number | null; profitFactorWithoutTopWinner: number | null;
} {
  if (!returns.length) return { expectancyPct: null, profitFactor: null, profitFactorWithoutTopWinner: null };
  const w = returns.filter((x) => x > 0);
  const l = returns.filter((x) => x <= 0);
  const gross = w.reduce((s, x) => s + x, 0);
  const lossSum = -l.reduce((s, x) => s + x, 0);
  return {
    expectancyPct: mean(returns),
    profitFactor: lossSum > 0 ? round(gross / lossSum, 4) : null,
    // One winner is not too few to answer this — it is the starkest answer. A lane
    // carried entirely by a single trade reports 0, and 0 is the finding.
    profitFactorWithoutTopWinner: w.length && lossSum > 0
      ? round((gross - Math.max(...w)) / lossSum, 4)
      : null,
  };
}

export interface OwnerLearningReport {
  version: typeof OWNER_LEARNING_VERSION;
  statistics: OwnerLaneStatistics;
  rows: OwnerLearningRow[];
  note: string;
}

/**
 * The owner lane, measured.
 *
 * `sessionDate` narrows to one ET trading session; omit it for the whole forward record.
 * Session membership is decided in JS from `entered_at_ms`, never in SQL: SQLite's
 * `localtime` is the container's timezone (UTC on Railway), and an ET boundary resolved
 * in UTC moves every post-20:00 ET opening into the next day.
 */
export function buildOwnerLearningReportOnDb(
  db: OwnerLearningDb,
  opts: { sessionDate?: string | null; sinceMs?: number | null; limit?: number } = {},
): OwnerLearningReport {
  const population = loadOwnerMirrorPopulationOnDb(db, { sinceMs: opts.sinceMs ?? null, limit: opts.limit });
  const sessionDate = opts.sessionDate ?? null;

  const inScope = population.mirrors.filter((m) => {
    if (sessionDate == null) return true;
    return m.enteredAtMs != null && tradingDay(m.enteredAtMs) === sessionDate;
  });

  const rows = inScope.map((m) => buildOwnerLearningRow(db, m));

  // Only mirrors on the exact called contract may contribute a performance figure. An OCC
  // mismatch is counted and reported, never priced.
  const exact = rows.filter((r) => r.occExact);
  const closedRows = exact.filter((r) => r.status === "EXITED" && r.realizedReturnPct != null);
  const returns = closedRows.map((r) => r.realizedReturnPct as number);
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const { expectancyPct, profitFactor, profitFactorWithoutTopWinner } = stats(returns);

  const sessionDates = exact.map((r) => r.sessionDate);
  const sessionAudit = countIndependentSessions(sessionDates);

  const byStrategyMap = new Map<string, number[]>();
  for (const r of closedRows) {
    const k = r.strategyKey ?? r.setupFamily ?? "unknown";
    byStrategyMap.set(k, [...(byStrategyMap.get(k) ?? []), r.realizedReturnPct as number]);
  }

  const byPathLabel: Record<string, number> = {};
  for (const r of exact) byPathLabel[r.pathLabel] = (byPathLabel[r.pathLabel] ?? 0) + 1;
  const byFlag: Record<string, number> = {};
  for (const r of exact) for (const f of r.flags) byFlag[f] = (byFlag[f] ?? 0) + 1;

  const metrics = {
    winRate: returns.length ? round(wins.length / returns.length, 4) : null,
    meanRealizedReturnPct: expectancyPct,
    medianRealizedReturnPct: median(returns),
    profitFactor,
    profitFactorWithoutTopWinner,
    bestWinnerPct: wins.length ? round(Math.max(...wins), 4) : null,
    worstLossPct: losses.length ? round(Math.min(...losses), 4) : null,
    mirrorRate: inScope.length ? round(exact.length / inScope.length, 4) : null,
  };

  const statistics: OwnerLaneStatistics = {
    version: OWNER_LEARNING_VERSION,
    lane: OWNER_VALIDATION_PAPER_KIND,
    sessionDate,
    openings: inScope.length,
    exactMirrors: exact.length,
    occMismatches: inScope.length - exact.length,
    missingCaseIdentity: population.withoutCaseIdentity,
    ambiguousCases: population.ambiguousCaseIds.length,
    closed: closedRows.length,
    open: exact.filter((r) => r.status !== "EXITED").length,
    ungradable: exact.filter((r) => r.status === "EXITED" && r.realizedReturnPct == null).length,
    wins: wins.length,
    losses: losses.length,
    callCount: exact.filter((r) => r.side === "CALL").length,
    putCount: exact.filter((r) => r.side === "PUT").length,
    sessions: sessionAudit.sessions,
    sessionAudit,
    dateRange: {
      from: sessionAudit.sessions[0] ?? null,
      to: sessionAudit.sessions[sessionAudit.sessions.length - 1] ?? null,
    },
    byStrategy: [...byStrategyMap.entries()].map(([strategy, rs]) => {
      const s = stats(rs);
      return {
        strategy, n: rs.length,
        wins: rs.filter((x) => x > 0).length,
        losses: rs.filter((x) => x <= 0).length,
        expectancyPct: s.expectancyPct,
        profitFactor: s.profitFactor,
      };
    }).sort((a, b) => b.n - a.n),
    byPathLabel,
    byFlag,
    withoutTrajectoryEvidence: closedRows.filter((r) => r.pathLabel === "PATH_UNKNOWN").length,
    stopLeakage: exact.filter((r) => r.stopEvidence.materialStopBreach).length,
    heldOvernight: exact.filter((r) => r.flags.includes("HELD_OVERNIGHT")).length,
    overnightGaps: exact.filter((r) => r.flags.includes("OVERNIGHT_GAP")).length,
    ...metrics,
    unavailableMetrics: Object.entries(metrics).filter(([, v]) => v == null).map(([k]) => k).sort(),
    limitations: [
      `Single lane: ${OWNER_VALIDATION_PAPER_KIND}. Never pooled with DELIVERED_ALERT_PAPER, `
      + "RESEARCH_ONLY_PAPER, BEARISH_RESEARCH_PAPER or any experiment arm — those are disjoint "
      + "populations with different gates and audiences.",
      "Realized figures admit closed mirrors on the EXACT called contract only. Trajectory labels "
      + "additionally require a same-contract mark series dense enough to claim an extreme; where it "
      + "is not, the verdict is PATH_UNKNOWN and never a default.",
      "No stored maxReturnPct / mfe_pct / mae_pct is read anywhere in this report.",
      "A null figure means the sample could not support it. It never means zero.",
      "RESEARCH ONLY. No gate, threshold, ranking weight, contract selection, target, stop, exit or "
      + "subscriber decision reads anything here.",
      ...(sessionAudit.warnings ?? []),
    ],
  };

  return {
    version: OWNER_LEARNING_VERSION,
    statistics,
    rows,
    note:
      "Owner callouts write no options_alerts row and therefore have no alert_id. Identity runs "
      + "through the opportunity case recorded on the mirror's own feature snapshot, and the "
      + "PRE_MOVE evidence through the pending audit case derived from the shared opportunity "
      + "fingerprint. Both are resolved by lib/opportunity-case/owner-mirror-identity.ts.",
  };
}

// ── the contrast block ───────────────────────────────────────────────────────

export interface OwnerIdentityCensus {
  lane: typeof OWNER_VALIDATION_PAPER_KIND;
  /** Owner mirrors examined. */
  mirrors: number;
  /** Owner mirrors carrying `options_paper_trades.alert_id`. Expected: 0. */
  mirrorsWithAlertId: number;
  /** Owner cases named by a mirror. */
  cases: number;
  /** Those carrying `opportunity_cases.alert_id`. Expected: 0. */
  casesWithAlertId: number;
  /** Owner mirrors whose feature snapshot names a case — the link that DOES exist. */
  mirrorsWithCaseIdentity: number;
  /** Owner cases whose derived pending audit case actually exists. */
  casesWithPendingAuditCase: number;
  verdict: "ALERT_ID_IDENTITY_UNAVAILABLE" | "ALERT_ID_IDENTITY_PRESENT";
  note: string;
}

/**
 * The census that proves the root defect, measurable at any deployment.
 *
 * A consumer resolving owner evidence through `alert_id` does not error — it returns the
 * empty set, which is indistinguishable from "no owner trades happened". This counts both
 * links side by side so the difference is a number rather than an argument.
 */
export function censusOwnerIdentityOnDb(
  db: OwnerLearningDb,
  opts: { sinceMs?: number | null; limit?: number } = {},
): OwnerIdentityCensus {
  const population = loadOwnerMirrorPopulationOnDb(db, { sinceMs: opts.sinceMs ?? null, limit: opts.limit });
  const caseIds = [...new Set(population.mirrors.map((m) => m.opportunityCaseId))];

  let mirrorsWithAlertId = 0;
  try {
    const r = db.prepare(
      "SELECT COUNT(*) n FROM options_paper_trades WHERE paper_kind=? AND alert_id IS NOT NULL",
    ).get?.(OWNER_VALIDATION_PAPER_KIND) as any;
    mirrorsWithAlertId = Number(r?.n ?? 0);
  } catch { /* isolated */ }

  let casesWithAlertId = 0;
  let casesWithPendingAuditCase = 0;
  for (const id of caseIds) {
    try {
      const c = db.prepare("SELECT alert_id FROM opportunity_cases WHERE opportunity_id=?").get?.(id) as any;
      if (c?.alert_id != null) casesWithAlertId += 1;
    } catch { /* isolated */ }
  }
  for (const pending of new Set(population.mirrors.map((m) => m.preMoveCaseId).filter((v): v is string => !!v))) {
    try {
      const c = db.prepare("SELECT 1 x FROM opportunity_cases WHERE opportunity_id=?").get?.(pending) as any;
      if (c) casesWithPendingAuditCase += 1;
    } catch { /* isolated */ }
  }

  return {
    lane: OWNER_VALIDATION_PAPER_KIND,
    mirrors: population.mirrors.length,
    mirrorsWithAlertId,
    cases: caseIds.length,
    casesWithAlertId,
    mirrorsWithCaseIdentity: population.mirrors.length,
    casesWithPendingAuditCase,
    verdict: mirrorsWithAlertId === 0 && casesWithAlertId === 0
      ? "ALERT_ID_IDENTITY_UNAVAILABLE"
      : "ALERT_ID_IDENTITY_PRESENT",
    note:
      "An owner callout writes no options_alerts row, so alert_id is null on both sides of the "
      + "relationship. Any consumer joining owner evidence through it returns the empty set and "
      + "reports it as zero trades. `mirrorsWithCaseIdentity` is the link that does exist.",
  };
}

export interface DeliveredLaneContrast {
  lane: "DELIVERED_ALERT_PAPER";
  sessionDate: string;
  openings: number;
  /** Rows with a non-null alert_id — what "paper mirrors" used to mean here. */
  mirrorsByAlertId: number;
  mirrorRateByAlertId: number | null;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  expectancyPct: number | null;
  profitFactor: number | null;
  note: string;
}

/**
 * The DELIVERED_ALERT_PAPER figures for a session, reported as themselves.
 *
 * This is exactly what `buildOwnerAlertSummaryOnDb` used to return under the heading
 * "OWNER DISCORD ALERTS": a different lane, with a mirror count that meant "has an
 * alert id". It is kept — clearly labelled, in its own shape, under its own name — so the
 * before/after of the identity repair is a measurement rather than a claim, and so nobody
 * reading the two side by side can mistake one for the other again.
 *
 * It is NOT the owner lane and must never be presented as one.
 */
export function buildDeliveredLaneContrastOnDb(
  db: OwnerLearningDb,
  sessionDate: string,
): DeliveredLaneContrast {
  const empty: DeliveredLaneContrast = {
    lane: "DELIVERED_ALERT_PAPER", sessionDate, openings: 0, mirrorsByAlertId: 0,
    mirrorRateByAlertId: null, closed: 0, open: 0, wins: 0, losses: 0,
    expectancyPct: null, profitFactor: null,
    note: "the subscriber-mirror lane, reported for contrast only",
  };
  if (!hasTable(db, "options_paper_trades")) return empty;
  let rows: Record<string, any>[] = [];
  try {
    const all = (db.prepare(
      `SELECT id, status, return_pct, alert_id, entered_at_ms
         FROM options_paper_trades
        WHERE paper_kind='DELIVERED_ALERT_PAPER' AND entered_at_ms IS NOT NULL`,
    ).all?.() ?? []) as Record<string, any>[];
    rows = all.filter((r) => tradingDay(Number(r.entered_at_ms)) === sessionDate);
  } catch {
    return empty;
  }
  const closed = rows.filter((r) => r.status === "EXITED" && r.return_pct != null);
  const returns = closed.map((r) => Number(r.return_pct));
  const s = stats(returns);
  const mirrors = rows.filter((r) => r.alert_id != null).length;
  return {
    lane: "DELIVERED_ALERT_PAPER",
    sessionDate,
    openings: rows.length,
    mirrorsByAlertId: mirrors,
    mirrorRateByAlertId: rows.length ? round(mirrors / rows.length, 4) : null,
    closed: closed.length,
    open: rows.filter((r) => r.status !== "EXITED").length,
    wins: returns.filter((x) => x > 0).length,
    losses: returns.filter((x) => x <= 0).length,
    expectancyPct: s.expectancyPct,
    profitFactor: s.profitFactor,
    note:
      "DELIVERED_ALERT_PAPER — the subscriber mirror lane. This is the population the owner "
      + "summary reported before the identity repair, under a heading that said OWNER. Reported "
      + "here for contrast only; it is a different audience and must never be pooled with, or "
      + "quoted as, owner callout performance.",
  };
}
