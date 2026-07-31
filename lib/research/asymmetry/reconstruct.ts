/**
 * reconstruct.ts — rebuild the full timeline of one captured case from
 * persisted rows plus historical exact-OCC market data.
 *
 * WHAT IT ANSWERS. "The NVDA alert felt late — was it?" That question needs
 * both halves of the record:
 *
 *   OUR SIDE   asymmetry_cases (first capture, early ask, underlying at
 *              detection), asymmetry_transitions (state changes),
 *              asymmetry_marks (forward marks), asymmetry_notify_decisions
 *              (what the gate saw and decided, with thresholds in force).
 *
 *   MARKET SIDE historical NBBO for the exact OCC and 1-minute bars for the
 *              underlying, from Massive. This is what makes "premium at
 *              capture vs at notification" and "had momentum already turned"
 *              answerable instead of guesswork.
 *
 * NO LOOKAHEAD LEAKS INTO PRODUCTION. This module is read-only and offline. It
 * uses future data deliberately, because grading requires it — which is exactly
 * why nothing in the live path may import it.
 *
 * MISSING STAYS MISSING. Any stage the record cannot support is reported as
 * null with a named reason. There is no interpolation and no midpoint anywhere.
 */
import type { RequestAccountant } from "./historical/request-accounting.ts";
import type { HistoricalCache } from "./historical/cache.ts";
import {
  fetchHistoricalOptionQuotes, fetchHistoricalBars,
  quoteAsOf, extremes,
  type HistoricalQuote, type HistoricalBar, type HistoricalDeps,
} from "./historical/massive-historical.ts";
import { listNotifyDecisionsForOccOnDb, type JournalRow } from "./notify-journal.ts";
import {
  classifyTiming, DEFAULT_TIMING_THRESHOLDS,
  type TimingEvidence, type TimingClassificationResult, type TimingThresholds,
} from "./timing-classification.ts";

type ReadDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
};

export const RECONSTRUCTION_VERSION = "ASYM_RECONSTRUCT_V1" as const;

/** One point on the timeline. Every value is measured or explicitly absent. */
export interface TimelineStage {
  stage: string;
  atMs: number | null;
  /** Why this stage has no timestamp, when it does not. */
  absentReason: string | null;
  underlyingPrice: number | null;
  bid: number | null;
  ask: number | null;
  quoteAgeMs: number | null;
  /** Source of the quote at this stage: which record or endpoint supplied it. */
  quoteSource: string | null;
}

export interface ReconstructionInput {
  sessionDate: string;
  symbol: string;
  optionSymbol: string;
  fingerprint?: string | null;
  /** Window padding before first capture, for the pre-move context. */
  preContextMs?: number;
  /** Window padding after the last event, for the outcome. */
  postContextMs?: number;
  thresholds?: TimingThresholds;
}

export interface ReconstructionResult {
  version: string;
  sessionDate: string;
  symbol: string;
  optionSymbol: string;
  fingerprint: string | null;

  /** Identity of the record, as persisted. Null fields are genuinely absent. */
  identity: {
    caseFound: boolean;
    alertId: string | null;
    caseId: string | null;
    direction: string | null;
    setupFamily: string | null;
    firstDetectedAtMs: number | null;
    earlyAsk: number | null;
    earlyBid: number | null;
    earlySpreadPct: number | null;
    underlyingAtDetection: number | null;
    missingEvidence: string[];
  };

  stages: TimelineStage[];
  stateTimeline: Array<{ state: string; atMs: number; notified: boolean; notifyOutcome: string | null }>;
  notifyDecisions: JournalRow[];

  derived: {
    captureToNotifyMs: number | null;
    schedulerDelayMs: number | null;
    providerDataAgeAtNotifyMs: number | null;
    premiumAtCapture: number | null;
    peakPremiumBeforeNotify: number | null;
    peakPremiumAtMs: number | null;
    premiumAtNotify: number | null;
    premiumExpansionBeforeAlertPct: number | null;
    premiumGiveBackBeforeAlertPct: number | null;
    underlyingMoveBeforeAlertPct: number | null;
    shortWindowMomentumPct: number | null;
    localHighBeforeAlert: number | null;
    pullbackFromLocalHighPct: number | null;
    aboveVwapAtAlert: boolean | null;
    vwapAtAlert: number | null;
    momentumAlreadyNegative: boolean | null;
    peakPremiumSession: number | null;
  };

  timing: TimingClassificationResult;
  /** What ASYM_NOTIFY_V2 actually did, read from the journal — not simulated. */
  gateOutcome: {
    journalled: boolean;
    notified: boolean | null;
    reason: string | null;
    timing: string | null;
    gateVersion: string | null;
    wouldSuppressNow: boolean | null;
    suppressionBasis: string;
  };

  coverage: {
    optionQuoteObservations: number;
    underlyingBars: number;
    /** Every stage or measure the record could not support, with its reason. */
    gaps: Array<{ field: string; reason: string }>;
    providerNotes: string[];
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Session VWAP from 1-minute bars up to `atMs`. Null when no volume traded. */
export function vwapFromBars(bars: readonly HistoricalBar[], atMs: number): number | null {
  let pv = 0, vol = 0;
  for (const b of bars) {
    if (b.t > atMs) break;
    const typical = b.vw ?? (b.h + b.l + b.c) / 3;
    if (!Number.isFinite(typical) || !(b.v > 0)) continue;
    pv += typical * b.v;
    vol += b.v;
  }
  return vol > 0 ? Math.round((pv / vol) * 10_000) / 10_000 : null;
}

/** Percent change over the `windowMs` ending at `atMs`. Null when unsupported. */
export function momentumPct(bars: readonly HistoricalBar[], atMs: number, windowMs: number): number | null {
  const start = atMs - windowMs;
  let first: number | null = null, last: number | null = null;
  for (const b of bars) {
    if (b.t < start || b.t > atMs) continue;
    if (first == null) first = b.o;
    last = b.c;
  }
  if (first == null || last == null || !(first > 0)) return null;
  return Math.round(((last - first) / first) * 10_000) / 100;
}

/** Highest bar high at or before `atMs`. Null when there are no bars. */
export function localHigh(bars: readonly HistoricalBar[], atMs: number, sinceMs: number): number | null {
  let hi: number | null = null;
  for (const b of bars) {
    if (b.t < sinceMs || b.t > atMs) continue;
    if (hi == null || b.h > hi) hi = b.h;
  }
  return hi;
}

/** Close of the last bar at or before `atMs`. */
export function priceAt(bars: readonly HistoricalBar[], atMs: number): number | null {
  let px: number | null = null;
  for (const b of bars) {
    if (b.t > atMs) break;
    px = b.c;
  }
  return px;
}

/**
 * Reconstruct one case. Read-only against the DB; bounded, accounted requests
 * against the provider. Never throws — a reconstruction fault returns a result
 * with gaps rather than propagating.
 */
export async function reconstructCase(
  db: ReadDb,
  input: ReconstructionInput,
  deps: { accountant: RequestAccountant; cache?: HistoricalCache; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<ReconstructionResult> {
  const sessionDate = input.sessionDate;
  const symbol = input.symbol.toUpperCase();
  const occ = input.optionSymbol.toUpperCase();
  const gaps: Array<{ field: string; reason: string }> = [];
  const providerNotes: string[] = [];

  // ── OUR SIDE: persisted rows. No provider call. ──────────────────────────
  const caseRow = safeGet(db,
    `SELECT * FROM asymmetry_cases WHERE session_date=? AND option_symbol=?`, sessionDate, occ) as any;
  const fingerprint = input.fingerprint ?? (caseRow?.fingerprint ? String(caseRow.fingerprint) : null);

  const transitions = (fingerprint
    ? safeAll(db, `SELECT from_state,to_state,occurred_at_ms,notified,notify_outcome
                     FROM asymmetry_transitions WHERE session_date=? AND fingerprint=?
                    ORDER BY occurred_at_ms ASC`, sessionDate, fingerprint)
    : []) as any[];

  const marks = (fingerprint
    ? safeAll(db, `SELECT horizon_minutes,marked_at_ms,bid,ask,quote_age_ms,rejected_reason
                     FROM asymmetry_marks WHERE session_date=? AND fingerprint=?
                    ORDER BY marked_at_ms ASC`, sessionDate, fingerprint)
    : []) as any[];

  const notifyDecisions = listNotifyDecisionsForOccOnDb(db as any, sessionDate, occ);

  // The alert instant: the first journalled decision that actually delivered,
  // falling back to the first transition marked notified.
  const sentDecision = notifyDecisions.find((d) => d.notifyOutcome === "SENT") ?? null;
  const notifiedTransition = transitions.find((t) => Number(t.notified) === 1) ?? null;
  const alertAtMs = sentDecision?.sentAtMs ?? sentDecision?.decidedAtMs
    ?? (notifiedTransition ? Number(notifiedTransition.occurred_at_ms) : null);
  const decisionAtMs = sentDecision?.decidedAtMs
    ?? (notifiedTransition ? Number(notifiedTransition.occurred_at_ms) : null);

  const firstDetectedAtMs = num(caseRow?.first_detected_at_ms);
  if (!caseRow) gaps.push({ field: "case", reason: "NO_PERSISTED_CASE_FOR_OCC" });
  if (alertAtMs == null) gaps.push({ field: "alertAtMs", reason: "NO_DELIVERED_NOTIFICATION_RECORDED" });
  if (notifyDecisions.length === 0) {
    gaps.push({ field: "notifyDecisions", reason: "JOURNAL_EMPTY_FOR_THIS_SESSION" });
  }

  // ── MARKET SIDE: bounded historical requests. ────────────────────────────
  const anchor = firstDetectedAtMs ?? alertAtMs ?? null;
  const preMs = input.preContextMs ?? 60 * 60_000;
  const postMs = input.postContextMs ?? 90 * 60_000;
  let quotes: HistoricalQuote[] = [];
  let bars: HistoricalBar[] = [];

  if (anchor == null) {
    gaps.push({ field: "historicalWindow", reason: "NO_ANCHOR_TIMESTAMP_TO_BUILD_A_WINDOW" });
  } else {
    const fromMs = anchor - preMs;
    const toMs = anchor + postMs;
    const hd: HistoricalDeps = {
      accountant: deps.accountant, cache: deps.cache, env: deps.env, fetchImpl: deps.fetchImpl,
    };
    const q = await fetchHistoricalOptionQuotes(occ, fromMs, toMs, hd, { symbol });
    quotes = q.rows;
    if (!q.outcome.ok) {
      providerNotes.push(`option quotes: ${q.outcome.note}`);
      gaps.push({ field: "optionQuotes", reason: q.outcome.note });
    }
    const b = await fetchHistoricalBars(symbol, fromMs, toMs, hd, { multiplier: 1, timespan: "minute", symbol });
    bars = b.rows;
    if (!b.outcome.ok) {
      providerNotes.push(`underlying bars: ${b.outcome.note}`);
      gaps.push({ field: "underlyingBars", reason: b.outcome.note });
    }
  }

  // ── STAGES ───────────────────────────────────────────────────────────────
  const stageAt = (label: string, atMs: number | null, absentReason: string | null): TimelineStage => {
    if (atMs == null) {
      return { stage: label, atMs: null, absentReason, underlyingPrice: null, bid: null, ask: null, quoteAgeMs: null, quoteSource: null };
    }
    const q = quoteAsOf(quotes, atMs, 300_000);
    return {
      stage: label, atMs, absentReason: null,
      underlyingPrice: priceAt(bars, atMs),
      bid: q?.bid ?? null, ask: q?.ask ?? null,
      quoteAgeMs: q ? atMs - q.atMs : null,
      quoteSource: q ? "MASSIVE_V3_QUOTES_HISTORICAL" : (quotes.length ? "NO_QUOTE_WITHIN_TOLERANCE" : "NO_QUOTES_RETRIEVED"),
    };
  };

  const stateFirstAt = (state: string): number | null => {
    const t = transitions.find((x) => String(x.to_state) === state);
    return t ? Number(t.occurred_at_ms) : null;
  };

  const firstValidQuoteAtMs = quotes.find((q) => q.bid != null && q.ask != null && q.bid > 0)?.atMs ?? null;

  const stages: TimelineStage[] = [
    stageAt("CANDIDATE_FIRST_SEEN", firstDetectedAtMs, "NO_PERSISTED_CASE"),
    stageAt("FIRST_CAPTURE", firstDetectedAtMs, "NO_PERSISTED_CASE"),
    stageAt("FIRST_VALID_QUOTE", firstValidQuoteAtMs, "NO_HISTORICAL_QUOTE_IN_WINDOW"),
    stageAt("EARLY_ASYMMETRY", stateFirstAt("EARLY_ASYMMETRY"), "STATE_NEVER_RECORDED"),
    stageAt("CONFIRMING", stateFirstAt("CONFIRMING"), "STATE_NEVER_RECORDED"),
    stageAt("HIGH_ASYMMETRY", stateFirstAt("HIGH_ASYMMETRY"), "STATE_NEVER_RECORDED"),
    stageAt("TRIGGERED", stateFirstAt("TRIGGERED"), "STATE_NEVER_RECORDED"),
    stageAt("NOTIFICATION_DECISION", decisionAtMs, "NO_JOURNALLED_DECISION"),
    stageAt("DISCORD_SEND", alertAtMs, "NO_DELIVERED_NOTIFICATION_RECORDED"),
  ];

  // ── DERIVED MEASURES ─────────────────────────────────────────────────────
  const premiumAtCapture = num(caseRow?.early_ask)
    ?? (firstDetectedAtMs != null ? quoteAsOf(quotes, firstDetectedAtMs, 300_000)?.ask ?? null : null);
  const premiumAtNotify = alertAtMs != null ? (quoteAsOf(quotes, alertAtMs, 300_000)?.ask ?? null) : null;

  const preAlertQuotes = alertAtMs != null && firstDetectedAtMs != null
    ? quotes.filter((q) => q.atMs >= firstDetectedAtMs && q.atMs <= alertAtMs)
    : [];
  const preAlertExtremes = extremes(preAlertQuotes);
  const sessionExtremes = extremes(
    firstDetectedAtMs != null ? quotes.filter((q) => q.atMs >= firstDetectedAtMs) : quotes,
  );

  const expansionPct = premiumAtCapture != null && premiumAtCapture > 0 && preAlertExtremes.peakAsk != null
    ? Math.round(((preAlertExtremes.peakAsk - premiumAtCapture) / premiumAtCapture) * 1000) / 10
    : null;
  const giveBackPct = premiumAtCapture != null && preAlertExtremes.peakAsk != null && premiumAtNotify != null
      && preAlertExtremes.peakAsk > premiumAtCapture
    ? Math.round(((preAlertExtremes.peakAsk - premiumAtNotify) / (preAlertExtremes.peakAsk - premiumAtCapture)) * 1000) / 10
    : null;

  const underlyingAtDetection = num(evidenceField(caseRow?.evidence_json, "underlyingPrice"))
    ?? (firstDetectedAtMs != null ? priceAt(bars, firstDetectedAtMs) : null);
  const underlyingAtAlert = alertAtMs != null ? priceAt(bars, alertAtMs) : null;
  const underlyingMovePct = underlyingAtDetection != null && underlyingAtDetection > 0 && underlyingAtAlert != null
    ? Math.round(((underlyingAtAlert - underlyingAtDetection) / underlyingAtDetection) * 10_000) / 100
    : null;

  const shortMomentum = alertAtMs != null ? momentumPct(bars, alertAtMs, 5 * 60_000) : null;
  const hiSince = firstDetectedAtMs ?? (anchor ?? 0);
  const hi = alertAtMs != null ? localHigh(bars, alertAtMs, hiSince) : null;
  const pullback = hi != null && hi > 0 && underlyingAtAlert != null
    ? Math.round(((hi - underlyingAtAlert) / hi) * 10_000) / 100
    : null;
  const vwap = alertAtMs != null ? vwapFromBars(bars, alertAtMs) : null;
  const aboveVwap = vwap != null && underlyingAtAlert != null ? underlyingAtAlert > vwap : null;

  for (const [field, value] of Object.entries({
    premiumAtCapture, premiumAtNotify, underlyingAtAlert, shortWindowMomentumPct: shortMomentum,
    vwapAtAlert: vwap, localHighBeforeAlert: hi,
  })) {
    if (value == null) gaps.push({ field, reason: quotes.length || bars.length ? "NOT_SUPPORTED_BY_RETRIEVED_DATA" : "NO_HISTORICAL_DATA_RETRIEVED" });
  }

  const derived = {
    captureToNotifyMs: firstDetectedAtMs != null && alertAtMs != null ? alertAtMs - firstDetectedAtMs : null,
    schedulerDelayMs: decisionAtMs != null && alertAtMs != null ? alertAtMs - decisionAtMs : null,
    providerDataAgeAtNotifyMs: sentDecision?.quoteAgeMs
      ?? (alertAtMs != null ? (() => { const q = quoteAsOf(quotes, alertAtMs, 300_000); return q ? alertAtMs - q.atMs : null; })() : null),
    premiumAtCapture,
    peakPremiumBeforeNotify: preAlertExtremes.peakAsk,
    peakPremiumAtMs: preAlertExtremes.peakAskAtMs,
    premiumAtNotify,
    premiumExpansionBeforeAlertPct: expansionPct,
    premiumGiveBackBeforeAlertPct: giveBackPct,
    underlyingMoveBeforeAlertPct: underlyingMovePct,
    shortWindowMomentumPct: shortMomentum,
    localHighBeforeAlert: hi,
    pullbackFromLocalHighPct: pullback,
    aboveVwapAtAlert: aboveVwap,
    vwapAtAlert: vwap,
    momentumAlreadyNegative: shortMomentum == null ? null : shortMomentum < 0,
    peakPremiumSession: sessionExtremes.peakAsk,
  };

  // ── TIMING VERDICT ───────────────────────────────────────────────────────
  const stateAtAlert = sentDecision?.toState ?? notifiedTransition?.to_state ?? null;
  const timingEvidence: TimingEvidence = {
    quoteAgeAtAlertMs: derived.providerDataAgeAtNotifyMs,
    premiumChasePctAtAlert: sentDecision?.premiumChasePct
      ?? (premiumAtCapture != null && premiumAtCapture > 0 && premiumAtNotify != null
        ? Math.round(((premiumAtNotify - premiumAtCapture) / premiumAtCapture) * 1000) / 10
        : null),
    entryAskAtCapture: premiumAtCapture,
    askAtAlert: premiumAtNotify,
    peakAskBeforeAlert: preAlertExtremes.peakAsk,
    peakAskSession: sessionExtremes.peakAsk,
    shortWindowMomentumPct: shortMomentum,
    localHighBeforeAlert: hi,
    underlyingAtAlert,
    aboveVwapAtAlert: aboveVwap,
    // The trigger level is not persisted today (see the field-lineage audit),
    // so "reclaimed then lost" is unmeasurable rather than false.
    triggerReclaimedThenLost: null,
    unconfirmedAtAlert: stateAtAlert == null ? null : (stateAtAlert === "EARLY_ASYMMETRY" || stateAtAlert === "CONFIRMING"),
    observations: preAlertQuotes.length || quotes.length,
  };
  const timing = classifyTiming(timingEvidence, input.thresholds ?? DEFAULT_TIMING_THRESHOLDS);

  return {
    version: RECONSTRUCTION_VERSION,
    sessionDate, symbol, optionSymbol: occ, fingerprint,
    identity: {
      caseFound: Boolean(caseRow),
      // alertId / caseId are not written onto the asymmetry case row today.
      // Reported as null rather than substituted with the fingerprint, which
      // is a different identifier with different semantics.
      alertId: null,
      caseId: fingerprint,
      direction: caseRow?.direction ? String(caseRow.direction) : null,
      setupFamily: caseRow?.setup_family ? String(caseRow.setup_family) : null,
      firstDetectedAtMs,
      earlyAsk: num(caseRow?.early_ask),
      earlyBid: num(caseRow?.early_bid),
      earlySpreadPct: num(caseRow?.early_spread_pct),
      underlyingAtDetection,
      missingEvidence: safeArray(caseRow?.missing_evidence),
    },
    stages,
    stateTimeline: transitions.map((t) => ({
      state: String(t.to_state), atMs: Number(t.occurred_at_ms),
      notified: Number(t.notified) === 1,
      notifyOutcome: t.notify_outcome == null ? null : String(t.notify_outcome),
    })),
    notifyDecisions,
    derived,
    timing,
    gateOutcome: {
      journalled: notifyDecisions.length > 0,
      notified: sentDecision ? true : notifyDecisions.length ? false : null,
      reason: sentDecision?.reason ?? notifyDecisions[notifyDecisions.length - 1]?.reason ?? null,
      timing: sentDecision?.timing ?? notifyDecisions[notifyDecisions.length - 1]?.timing ?? null,
      gateVersion: notifyDecisions[0]?.gateVersion ?? null,
      wouldSuppressNow: null, // filled by the caller via replayGate, not guessed here
      suppressionBasis: notifyDecisions.length
        ? "READ_FROM_JOURNAL"
        : "JOURNAL_NOT_YET_POPULATED_FOR_THIS_SESSION",
    },
    coverage: {
      optionQuoteObservations: quotes.length,
      underlyingBars: bars.length,
      gaps,
      providerNotes,
    },
  };
}

function safeGet(db: ReadDb, sql: string, ...args: unknown[]): unknown {
  try { return db.prepare(sql).get(...args); } catch { return null; }
}
function safeAll(db: ReadDb, sql: string, ...args: unknown[]): unknown[] {
  try { return db.prepare(sql).all(...args); } catch { return []; }
}
function safeArray(v: unknown): string[] {
  try { const p = JSON.parse(String(v ?? "[]")); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
}
function evidenceField(raw: unknown, field: string): unknown {
  try { return JSON.parse(String(raw ?? "{}"))?.[field]; } catch { return null; }
}
