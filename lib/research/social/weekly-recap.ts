/**
 * weekly-recap.ts — PURE deterministic weekly social-performance recap.
 *
 * This module decides which callouts are eligible and computes every number. AI is
 * never involved in arithmetic or row selection (see weekly-recap-drafts.ts for the
 * wording layer, which is validated back against this report).
 *
 * MEASUREMENT HONESTY — the reason this file is deliberately verbose:
 *  - "Combined peak moves" is the SUM OF INDIVIDUAL CALLOUT PEAKS. It is not a
 *    portfolio return, an account return, or a realized result, and the labels here
 *    are the only ones callers may render.
 *  - Peak is the maximum return supported by VERIFIED EXECUTABLE evidence during the
 *    options session, computed on the SAME realOptionExit convention as the canonical
 *    exit so a peak can never sit below a realized exit. Never a midpoint-only, stale,
 *    or after-hours mark. A row whose exit cannot be proven is excluded, not patched.
 *  - "Combined tracked results" is the sum of CANONICAL exit returns. Open positions
 *    are reported separately and never folded in.
 *  - One row per thesis. A repeated signal, a replaced contract, and a lifecycle
 *    update are the same opportunity and are counted once.
 *  - Verified subscriber, research-only, and Watchlist observations are separate
 *    cohorts and are never summed together.
 *  - The system can verify what a callout did. It cannot prove that any person
 *    entered, exited, or captured it, so no output may claim that.
 */
import { isMarketHoliday } from "../../trading-session.ts";
import { parseOccContract } from "../../format-contract.ts";
import {
  reconcilePeakAndExit,
  type ExitEvidenceClass,
  type ReconMark,
} from "./peak-reconciliation.ts";

/** Labels are fixed. Callers must render these exact strings. */
export const LABEL_COMBINED_PEAK = "Combined peak moves";
export const LABEL_COMBINED_TRACKED = "Combined tracked results";

/**
 * Wording that must never appear in ANY form. There is no legitimate negated use of
 * these in a performance recap.
 */
export const FORBIDDEN_CLAIMS: Array<{ re: RegExp; why: string }> = [
  { re: /\bwe made\b/i, why: "claims the operator or audience realised the gain" },
  { re: /\bi gave you\b/i, why: "claims a personal hand-off of profit" },
  { re: /\b(?:followers|members|subscribers|you)\s+(?:made|earned|banked|captured|pocketed)\b/i, why: "claims an audience captured returns" },
  { re: /\bour members made\b/i, why: "claims members realised the gain" },
  { re: /\byou (?:would have )?(?:made|banked|earned)\b/i, why: "claims the reader realised the gain" },
  { re: /\bguaranteed\b/i, why: "implies assured performance" },
  { re: /\brisk[- ]free\b/i, why: "implies no risk" },
  { re: /\beveryone (?:got|made)\b/i, why: "claims universal capture" },
  { re: /\bentered at\b/i, why: "claims a reader's fill" },
  { re: /\bexited at\b/i, why: "claims a reader's fill" },
];

/**
 * Mislabels that are forbidden only when ASSERTED.
 *
 * The required disclosure is literally "not portfolio return", so a blanket ban on
 * the phrase would reject the very sentence that keeps the output honest. These are
 * checked negation-aware: denying the label is mandatory, applying it is prohibited.
 */
export const FORBIDDEN_MISLABELS: Array<{ re: RegExp; why: string }> = [
  { re: /\bportfolio (?:return|gain|growth)\b/i, why: "peak sums are not a portfolio return" },
  { re: /\baccount (?:return|gain|growth)\b/i, why: "peak sums are not an account return" },
  { re: /\btotal account\b/i, why: "peak sums are not an account total" },
  { re: /\brealized (?:return|gain)s?\b/i, why: "peaks are not realized results" },
];

/** Negation cues that turn a following label into a denial. */
const NEGATION_CUE = /\b(?:not|never|no|none|isn't|aren't|rather than|instead of|unlike|as opposed to|does not|do not|cannot|is not|are not)\b/i;

/** Sentence split for negation-scoped checks. */
function sentencesOf(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when the sentence ASSERTS the matched label rather than denying it. */
function assertsLabel(sentence: string, re: RegExp): boolean {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of sentence.matchAll(global)) {
    if (!NEGATION_CUE.test(sentence.slice(0, m.index ?? 0))) return true;
  }
  return false;
}

export type CalloutLane = "VERIFIED_SUBSCRIBER" | "RESEARCH_ONLY" | "WATCHLIST";
export type CalloutStatus = "CLOSED" | "OPEN";

export interface RecapEvidence {
  opportunityCaseId: string;
  paperTradeId: number | null;
  alertId: string;
  entryBid: number | null;
  entryAsk: number | null;
  entryQuoteTsMs: number | null;
  discordMessageId: string | null;
  peakSource: string;
  trackedSource: string;
  exitEvidence?: {
    matchedMarkAtMs: number | null;
    matchedBid: number | null;
    matchedAsk: number | null;
    matchedQuoteAgeMs: number | null;
    withinBidAsk: boolean | null;
    providerTimestampMs: number | null;
  };
  markCount: number | null;
}

export interface RecapCallout {
  lane: CalloutLane;
  alertId: string;
  opportunityCaseId: string;
  symbol: string;
  optionSymbol: string;
  contractLabel: string;
  side: "CALL" | "PUT";
  strike: number;
  expirationLabel: string;
  frozenEntry: number;
  /**
   * Maximum return supported by verified executable evidence, computed on the SAME
   * convention as the canonical exit so peak and tracked are comparable. Not realized.
   */
  peakPct: number | null;
  /** Canonical tracked exit return. Null while OPEN. */
  trackedPct: number | null;
  status: CalloutStatus;
  exitReason: string | null;
  openedAtMs: number;
  gaveBackProfit: boolean;
  setupReason: string | null;
  exitEvidenceClass: ExitEvidenceClass;
  /** canonicalPeakPct >= canonicalTrackedPct on verified evidence. */
  peakInvariantOk: boolean;
  /** Raw-bid peak, retained so the convention change stays auditable. */
  bidConventionPeakPct: number | null;
  evidence: RecapEvidence;
}

export interface RecapExclusion {
  alertId: string;
  symbol: string;
  reason: string;
  classification: string | null;
}

export interface LaneTotals {
  lane: CalloutLane;
  eligibleCallouts: number;
  closedCallouts: number;
  openCallouts: number;
  winners: number;
  losers: number;
  /** Positive canonical tracked results / eligible EXITED callouts. */
  winRatePct: number | null;
  combinedPeakMovePct: number | null;
  combinedTrackedResultPct: number | null;
  averageTrackedPct: number | null;
  bestPeak: { contractLabel: string; pct: number } | null;
  bestTracked: { contractLabel: string; pct: number } | null;
  largestLoss: { contractLabel: string; pct: number } | null;
  profitGivenBackCount: number;
}

export interface RecapWindow {
  startMs: number;
  endMs: number;
  startDay: string;
  endDay: string;
  tradingDays: string[];
  holidaysSkipped: string[];
  label: string;
  manualRange: boolean;
}

export interface WeeklySocialRecap {
  window: RecapWindow;
  generatedAtMs: number;
  verifiedSubscriber: LaneTotals;
  researchOnly: LaneTotals;
  watchlist: LaneTotals;
  callouts: { verifiedSubscriber: RecapCallout[]; researchOnly: RecapCallout[]; watchlist: RecapCallout[] };
  exclusions: RecapExclusion[];
  warnings: string[];
  lowSample: boolean;
  publishability: "PUBLISHABLE_POSITIVE" | "PUBLISHABLE_MIXED" | "TRANSPARENT_REPORT_ONLY" | "INSUFFICIENT_VERIFICATION" | "NO_ELIGIBLE_CALLOUTS";
  labels: { combinedPeak: string; combinedTracked: string };
  disclaimers: string[];
  /** Every number a wording layer is permitted to state. */
  allowedNumbers: string[];
  allowedSymbols: string[];
  safety: { autoPostEnabled: false; subscriberDeliveryEnabled: false; aiCalculatesNumbers: false };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

const ET_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
});

function etInfo(ms: number): { day: string; weekday: string } {
  const parts = ET_PARTS.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday") };
}

/** Midnight ET for an ET calendar day, as epoch ms. */
function etDayStartMs(day: string): number {
  // Probe both common US offsets and keep the one that round-trips to the same ET day.
  for (const offset of [4, 5]) {
    const guess = Date.parse(`${day}T0${offset}:00:00.000Z`);
    if (Number.isFinite(guess) && etInfo(guess).day === day) return guess;
  }
  return Date.parse(`${day}T05:00:00.000Z`);
}

function addDays(day: string, delta: number): string {
  const ms = Date.parse(`${day}T12:00:00.000Z`) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The most recently COMPLETED Monday-Friday ET trading week.
 *
 * A week is complete once its Friday session is over; asking mid-week returns the
 * previous week rather than a partial one, because a partial week would understate
 * or overstate whatever is still open.
 */
export function completedWeeklyWindow(nowMs: number): RecapWindow {
  const today = etInfo(nowMs);
  const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = WEEKDAY_INDEX[today.weekday] ?? 1;
  // Monday of the current ET week.
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  let monday = addDays(today.day, mondayOffset);
  // Before Saturday, this week's Friday has not completed — step back one week.
  // On Friday itself the session may still be running, so it is also not complete.
  if (dow >= 1 && dow <= 5) monday = addDays(monday, -7);
  return windowForRange(monday, addDays(monday, 4), false);
}

/** Explicit ET date range for historical review. */
export function windowForRange(
  startDay: string,
  endDay: string,
  manualRange = true,
): RecapWindow {
  const tradingDays: string[] = [];
  const holidaysSkipped: string[] = [];
  let cursor = startDay;
  let guard = 0;
  while (cursor <= endDay && guard < 400) {
    guard += 1;
    const info = etInfo(etDayStartMs(cursor));
    const isWeekend = info.weekday === "Sat" || info.weekday === "Sun";
    if (!isWeekend) {
      // isMarketHoliday reads MARKET_HOLIDAYS from the environment itself.
      if (isMarketHoliday(cursor)) holidaysSkipped.push(cursor);
      else tradingDays.push(cursor);
    }
    cursor = addDays(cursor, 1);
  }
  const startMs = etDayStartMs(startDay);
  // End bound is the start of the day AFTER endDay, so the whole final session counts.
  const endMs = etDayStartMs(addDays(endDay, 1));
  return {
    startMs,
    endMs,
    startDay,
    endDay,
    tradingDays,
    holidaysSkipped,
    label: `${startDay} to ${endDay} (ET)`,
    manualRange,
  };
}

/** One row as supplied by the caller, assembled from canonical diagnostics. */
export interface RecapInputRow {
  lane: CalloutLane;
  alertId: string;
  opportunityCaseId: string | null;
  symbol: string;
  optionSymbol: string | null;
  /** Thesis identity — replaced contracts under one thesis share this. */
  thesisKey: string | null;
  frozenEntry: number | null;
  entryBid: number | null;
  entryAsk: number | null;
  entryQuoteTsMs: number | null;
  discordMessageId: string | null;
  subscriberDelivered: boolean;
  paperStatus: string | null;
  paperTradeId: number | null;
  /** Canonical exit return (%). */
  trackedPct: number | null;
  exitReason: string | null;
  /** Bid-convention peak (%) from exit research. Reconciled before publication. */
  peakPct: number | null;
  /** Verified in-session marks, used to reconcile peak against the canonical exit. */
  marks?: ReconMark[];
  exitFill?: number | null;
  exitAtMs?: number | null;
  markCount: number | null;
  gaveBackProfit: boolean;
  verifiedPnlEligible: boolean;
  pnlClassification: string | null;
  pnlExclusionReasons: string[];
  openedAtMs: number | null;
  setupReason: string | null;
}

const DISQUALIFYING_CLASSIFICATIONS = new Set([
  "MISSING_MIRROR",
  "AUDIT_ONLY",
  "UNLINKED_DELIVERY",
  "INVALID_ENTRY",
  "INVALID_EXIT",
  "STALE_MARK",
  "DUPLICATE_POSITION",
]);

/** Human reason for each rejected row. Named so exclusions are never silent. */
function eligibilityFailure(row: RecapInputRow): string | null {
  if (!row.subscriberDelivered && row.lane === "VERIFIED_SUBSCRIBER") {
    return "no verified subscriber Discord opening proof";
  }
  if (row.lane === "VERIFIED_SUBSCRIBER" && !row.discordMessageId) {
    return "no Discord message id for the opening";
  }
  if (!row.optionSymbol || !parseOccContract(row.optionSymbol)) {
    return "no exact OCC contract";
  }
  if (!isNum(row.frozenEntry) || row.frozenEntry <= 0) return "no frozen entry";
  if (
    !isNum(row.entryBid) || row.entryBid <= 0
    || !isNum(row.entryAsk) || row.entryAsk < row.entryBid
    || !isNum(row.entryQuoteTsMs)
  ) {
    return "no valid entry bid/ask evidence";
  }
  if (!row.opportunityCaseId) return "no opportunity case";
  if (row.pnlClassification && DISQUALIFYING_CLASSIFICATIONS.has(row.pnlClassification)) {
    return `classification ${row.pnlClassification.replaceAll("_", " ").toLowerCase()}`;
  }
  if (!row.verifiedPnlEligible) {
    return row.pnlExclusionReasons.length
      ? `verification incomplete (${row.pnlExclusionReasons.join(", ")})`
      : "verification incomplete";
  }
  const closed = String(row.paperStatus ?? "").toUpperCase() === "EXITED";
  if (closed && !isNum(row.trackedPct)) return "no canonical tracked result";
  if (!isNum(row.peakPct)) return "no valid lifecycle or grading evidence for a verified peak";
  if (!isNum(row.openedAtMs)) return "no opening timestamp";
  return null;
}

function toCallout(row: RecapInputRow): RecapCallout | null {
  const parsed = parseOccContract(row.optionSymbol);
  if (!parsed) return null;
  const closed = String(row.paperStatus ?? "").toUpperCase() === "EXITED";
  // Reconcile the peak onto the executable convention so it is directly comparable
  // to the canonical exit, and record how well the exit itself is evidenced.
  const recon = reconcilePeakAndExit({
    frozenEntry: row.frozenEntry as number,
    marks: row.marks ?? [],
    exitFill: row.exitFill ?? null,
    exitAtMs: row.exitAtMs ?? null,
    trackedPct: closed ? row.trackedPct : null,
    status: closed ? "CLOSED" : "OPEN",
  });
  return {
    lane: row.lane,
    alertId: row.alertId,
    opportunityCaseId: row.opportunityCaseId as string,
    symbol: parsed.symbol,
    optionSymbol: row.optionSymbol as string,
    contractLabel: `${parsed.symbol} ${parsed.expirationLabel} $${Number(parsed.strike.toFixed(3))} ${parsed.side === "put" ? "Put" : "Call"}`,
    side: parsed.side === "put" ? "PUT" : "CALL",
    strike: parsed.strike,
    expirationLabel: parsed.expirationLabel,
    frozenEntry: row.frozenEntry as number,
    peakPct: recon.canonicalPeakPct != null ? round2(recon.canonicalPeakPct) : null,
    trackedPct: closed && isNum(row.trackedPct) ? round2(row.trackedPct) : null,
    status: closed ? "CLOSED" : "OPEN",
    exitReason: row.exitReason,
    openedAtMs: row.openedAtMs as number,
    gaveBackProfit: row.gaveBackProfit,
    setupReason: row.setupReason,
    exitEvidenceClass: recon.exitClass,
    peakInvariantOk: recon.invariantOk,
    bidConventionPeakPct: recon.highestVerifiedBidReturnPct,
    evidence: {
      opportunityCaseId: row.opportunityCaseId as string,
      paperTradeId: row.paperTradeId,
      alertId: row.alertId,
      entryBid: row.entryBid,
      entryAsk: row.entryAsk,
      entryQuoteTsMs: row.entryQuoteTsMs,
      discordMessageId: row.discordMessageId,
      // Executable convention (realOptionExit over verified in-session bid/ask), the
      // SAME convention as the canonical exit, so peak and tracked are comparable.
      peakSource: "options_paper_marks/reconcilePeakAndExit/executableReturnPct",
      trackedSource: "options_paper_trades/return_pct",
      exitEvidence: recon.exitEvidence,
      markCount: recon.validMarkCount,
    },
  };
}

function emptyTotals(lane: CalloutLane): LaneTotals {
  return {
    lane,
    eligibleCallouts: 0,
    closedCallouts: 0,
    openCallouts: 0,
    winners: 0,
    losers: 0,
    winRatePct: null,
    combinedPeakMovePct: null,
    combinedTrackedResultPct: null,
    averageTrackedPct: null,
    bestPeak: null,
    bestTracked: null,
    largestLoss: null,
    profitGivenBackCount: 0,
  };
}

function totalsFor(lane: CalloutLane, callouts: RecapCallout[], includeOpen: boolean): LaneTotals {
  const out = emptyTotals(lane);
  out.eligibleCallouts = callouts.length;
  const closed = callouts.filter((c) => c.status === "CLOSED");
  const open = callouts.filter((c) => c.status === "OPEN");
  out.closedCallouts = closed.length;
  out.openCallouts = open.length;

  // Peaks may include open positions only when the caller asks for it; the OPEN
  // count is always reported so the reader can see what is unresolved.
  const peakPool = includeOpen ? callouts : closed;
  const peaks = peakPool.map((c) => c.peakPct).filter(isNum);
  out.combinedPeakMovePct = peaks.length ? round2(peaks.reduce((a, b) => a + b, 0)) : null;

  // Tracked results are CLOSED only. An open position has no canonical exit.
  const tracked = closed.map((c) => c.trackedPct).filter(isNum);
  out.combinedTrackedResultPct = tracked.length ? round2(tracked.reduce((a, b) => a + b, 0)) : null;
  out.averageTrackedPct = tracked.length ? round2(tracked.reduce((a, b) => a + b, 0) / tracked.length) : null;
  out.winners = tracked.filter((t) => t > 0).length;
  out.losers = tracked.filter((t) => t <= 0).length;
  out.winRatePct = closed.length ? round2((out.winners / closed.length) * 100) : null;

  const bestPeakRow = [...peakPool].filter((c) => isNum(c.peakPct))
    .sort((a, b) => (b.peakPct as number) - (a.peakPct as number))[0];
  if (bestPeakRow) out.bestPeak = { contractLabel: bestPeakRow.contractLabel, pct: bestPeakRow.peakPct as number };

  const bestTrackedRow = [...closed].filter((c) => isNum(c.trackedPct))
    .sort((a, b) => (b.trackedPct as number) - (a.trackedPct as number))[0];
  if (bestTrackedRow) out.bestTracked = { contractLabel: bestTrackedRow.contractLabel, pct: bestTrackedRow.trackedPct as number };

  const worstRow = [...closed].filter((c) => isNum(c.trackedPct) && (c.trackedPct as number) < 0)
    .sort((a, b) => (a.trackedPct as number) - (b.trackedPct as number))[0];
  if (worstRow) out.largestLoss = { contractLabel: worstRow.contractLabel, pct: worstRow.trackedPct as number };

  out.profitGivenBackCount = closed.filter((c) => c.gaveBackProfit).length;
  return out;
}

/**
 * Collapse to ONE row per thesis.
 *
 * A repeated signal, a replaced contract, and a lifecycle update all belong to the
 * same opportunity. Keeping any of them as a second row would inflate both the
 * callout count and the combined sums, so the earliest opening for each thesis wins
 * and later rows are recorded as explicit exclusions.
 */
function dedupeByThesis(
  rows: RecapInputRow[],
  exclusions: RecapExclusion[],
): RecapInputRow[] {
  const byThesis = new Map<string, RecapInputRow>();
  const ordered = [...rows].sort((a, b) => (a.openedAtMs ?? 0) - (b.openedAtMs ?? 0));
  for (const row of ordered) {
    const key = row.opportunityCaseId ?? row.thesisKey ?? `alert:${row.alertId}`;
    const existing = byThesis.get(key);
    if (!existing) {
      byThesis.set(key, row);
      continue;
    }
    exclusions.push({
      alertId: row.alertId,
      symbol: row.symbol,
      reason: `same thesis as ${existing.alertId} (repeat signal, contract replacement, or lifecycle update counts once)`,
      classification: row.pnlClassification,
    });
  }
  return [...byThesis.values()];
}

export interface RecapOptions {
  window: RecapWindow;
  nowMs: number;
  verifiedSubscriberOnly?: boolean;
  includeOpenTrades?: boolean;
  includeWatchlist?: boolean;
  lowSampleThreshold?: number;
}

/** Build the deterministic weekly recap. Pure: no I/O, no AI, no randomness. */
export function buildWeeklySocialRecap(
  rows: RecapInputRow[],
  opts: RecapOptions,
): WeeklySocialRecap {
  const includeOpen = opts.includeOpenTrades === true;
  const lowSampleThreshold = opts.lowSampleThreshold ?? 5;
  const exclusions: RecapExclusion[] = [];

  // Window filter uses the OPENING timestamp, so a trade opened Friday and closed
  // the next Monday belongs to the week it was called.
  const inWindow = rows.filter((row) => {
    if (!isNum(row.openedAtMs)) {
      exclusions.push({ alertId: row.alertId, symbol: row.symbol, reason: "no opening timestamp", classification: row.pnlClassification });
      return false;
    }
    return row.openedAtMs >= opts.window.startMs && row.openedAtMs < opts.window.endMs;
  });

  const laneRows: Record<CalloutLane, RecapCallout[]> = {
    VERIFIED_SUBSCRIBER: [],
    RESEARCH_ONLY: [],
    WATCHLIST: [],
  };

  for (const lane of ["VERIFIED_SUBSCRIBER", "RESEARCH_ONLY", "WATCHLIST"] as CalloutLane[]) {
    if (lane === "RESEARCH_ONLY" && opts.verifiedSubscriberOnly) continue;
    if (lane === "WATCHLIST" && (opts.verifiedSubscriberOnly || opts.includeWatchlist === false)) continue;
    const ofLane = inWindow.filter((r) => r.lane === lane);
    const deduped = dedupeByThesis(ofLane, exclusions);
    for (const row of deduped) {
      const failure = eligibilityFailure(row);
      if (failure) {
        exclusions.push({ alertId: row.alertId, symbol: row.symbol, reason: failure, classification: row.pnlClassification });
        continue;
      }
      const callout = toCallout(row);
      if (!callout) {
        exclusions.push({ alertId: row.alertId, symbol: row.symbol, reason: "contract could not be parsed", classification: row.pnlClassification });
        continue;
      }
      // INVARIANT: a verified peak can never sit below a verified realized exit.
      // When the evidence cannot satisfy it, the row is incomplete — exclude it
      // rather than publish a mathematically impossible peak/tracked pair.
      if (!callout.peakInvariantOk || callout.peakPct == null) {
        exclusions.push({
          alertId: row.alertId,
          symbol: row.symbol,
          reason: `peak/tracked invariant unsatisfied on verified evidence (exit evidence: ${callout.exitEvidenceClass})`,
          classification: row.pnlClassification,
        });
        continue;
      }
      laneRows[lane].push(callout);
    }
    laneRows[lane].sort((a, b) => (b.peakPct ?? 0) - (a.peakPct ?? 0));
  }

  const verifiedSubscriber = totalsFor("VERIFIED_SUBSCRIBER", laneRows.VERIFIED_SUBSCRIBER, includeOpen);
  const researchOnly = totalsFor("RESEARCH_ONLY", laneRows.RESEARCH_ONLY, includeOpen);
  const watchlist = totalsFor("WATCHLIST", laneRows.WATCHLIST, includeOpen);

  const warnings: string[] = [];
  const lowSample = verifiedSubscriber.closedCallouts < lowSampleThreshold;
  if (lowSample) warnings.push("LOW SAMPLE — weekly percentages may not be representative.");
  if (exclusions.length > 0) {
    warnings.push(`${exclusions.length} callout${exclusions.length === 1 ? "" : "s"} excluded due to incomplete verification.`);
  }
  if (
    isNum(verifiedSubscriber.combinedTrackedResultPct)
    && verifiedSubscriber.combinedTrackedResultPct < 0
    && isNum(verifiedSubscriber.combinedPeakMovePct)
    && verifiedSubscriber.combinedPeakMovePct > 0
  ) {
    warnings.push("Several callouts moved favorably but the tracked exit policy gave back gains.");
  }
  if (verifiedSubscriber.openCallouts > 0 && !includeOpen) {
    warnings.push(`${verifiedSubscriber.openCallouts} open position${verifiedSubscriber.openCallouts === 1 ? "" : "s"} excluded from all totals.`);
  }
  if (opts.window.holidaysSkipped.length) {
    warnings.push(`Market holiday skipped: ${opts.window.holidaysSkipped.join(", ")}.`);
  }

  const publishability: WeeklySocialRecap["publishability"] = verifiedSubscriber.eligibleCallouts === 0
    ? "NO_ELIGIBLE_CALLOUTS"
    : exclusions.length > verifiedSubscriber.eligibleCallouts
      ? "INSUFFICIENT_VERIFICATION"
      : (verifiedSubscriber.combinedTrackedResultPct ?? 0) < 0
        ? "TRANSPARENT_REPORT_ONLY"
        : verifiedSubscriber.losers > 0
          ? "PUBLISHABLE_MIXED"
          : "PUBLISHABLE_POSITIVE";

  const all = [...laneRows.VERIFIED_SUBSCRIBER, ...laneRows.RESEARCH_ONLY, ...laneRows.WATCHLIST];
  const allowedNumbers = new Set<string>();
  const addNumber = (n: number | null | undefined) => {
    if (!isNum(n)) return;
    const abs = Math.abs(n);
    for (const digits of [0, 1, 2]) allowedNumbers.add(abs.toFixed(digits));
    allowedNumbers.add(String(abs));
    for (const f of [...allowedNumbers]) {
      if (f.includes(".")) allowedNumbers.add(f.replace(/\.?0+$/, ""));
    }
    const int = abs.toFixed(0);
    if (int.length > 3) allowedNumbers.add(int.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  };
  for (const totals of [verifiedSubscriber, researchOnly, watchlist]) {
    for (const n of [
      totals.eligibleCallouts, totals.closedCallouts, totals.openCallouts, totals.winners,
      totals.losers, totals.winRatePct, totals.combinedPeakMovePct, totals.combinedTrackedResultPct,
      totals.averageTrackedPct, totals.profitGivenBackCount,
      totals.bestPeak?.pct, totals.bestTracked?.pct, totals.largestLoss?.pct,
    ]) addNumber(n as number | null);
  }
  for (const c of all) {
    addNumber(c.peakPct);
    addNumber(c.trackedPct);
    addNumber(c.frozenEntry);
    addNumber(c.strike);
  }
  addNumber(exclusions.length);

  return {
    window: opts.window,
    generatedAtMs: opts.nowMs,
    verifiedSubscriber,
    researchOnly,
    watchlist,
    callouts: {
      verifiedSubscriber: laneRows.VERIFIED_SUBSCRIBER,
      researchOnly: laneRows.RESEARCH_ONLY,
      watchlist: laneRows.WATCHLIST,
    },
    exclusions,
    warnings,
    lowSample,
    publishability,
    labels: { combinedPeak: LABEL_COMBINED_PEAK, combinedTracked: LABEL_COMBINED_TRACKED },
    disclaimers: [
      "Past performance does not guarantee future results.",
      "Educational purposes only. Options involve substantial risk.",
      `${LABEL_COMBINED_PEAK} are the sum of individual callout peaks, not portfolio return.`,
      "Results use frozen posted entries and verified option bid marks. OptiScan can verify what a callout did; it cannot prove any person entered, exited, or captured it.",
    ],
    allowedNumbers: [...allowedNumbers],
    allowedSymbols: [...new Set(all.map((c) => c.symbol))],
    safety: { autoPostEnabled: false, subscriberDeliveryEnabled: false, aiCalculatesNumbers: false },
  };
}

/**
 * Screen generated wording for unsupported performance claims.
 *
 * Absolute claims are rejected outright. Mislabels are rejected only when asserted,
 * so the mandatory "not portfolio return" disclosure passes.
 */
export function screenRecapWording(text: string): { ok: boolean; violations: Array<{ phrase: string; why: string }> } {
  const violations: Array<{ phrase: string; why: string }> = [];
  const body = String(text ?? "");
  for (const { re, why } of FORBIDDEN_CLAIMS) {
    const m = re.exec(body);
    if (m) violations.push({ phrase: m[0], why });
  }
  for (const { re, why } of FORBIDDEN_MISLABELS) {
    for (const sentence of sentencesOf(body)) {
      if (!assertsLabel(sentence, re)) continue;
      const m = re.exec(sentence);
      if (m) { violations.push({ phrase: m[0], why }); break; }
    }
  }
  return { ok: violations.length === 0, violations };
}
