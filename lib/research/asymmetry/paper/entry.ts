/**
 * entry.ts — the deterministic paper-entry decision, and the writer that opens
 * a position from it.
 *
 *   decidePaperEntry()      [PURE — no db, no clock, no provider, no AI]
 *   openAsymmetryPaperTrade()  -> decidePaperEntry -> sizePaperPosition
 *                              -> openPaperPositionOnDb | recordPaperSkipOnDb
 *
 * ENTRY IS THE ASK. Not the mid, not the last, not a modelled fill. Paying the
 * full offer is the conservative direction for a long option and it matches the
 * convention `asymmetry_outcomes` already grades against, so a paper position
 * and its shadow case are measured from the same number.
 *
 * A rejection is always RECORDED, never silent, and never converted to a
 * position with missing values filled in as zero. "We could not verify a quote"
 * and "the quote was bad" are different rows with different reasons.
 *
 * NO AI. This module decides eligibility, contract, fill, and size with
 * readable rules over the values it is handed.
 */
import { isOptionsQuoteSession } from "../../../market-session-guard.ts";
import { tradingDay } from "../../../trading-session.ts";
import type { AsymmetryResearchState } from "../states.ts";
import {
  PAPER_ENTRY_STATES, PAPER_RULES_VERSION, paperPositionFingerprint,
  isPaperEntryState,
} from "./lane.ts";
import { resolveSizingConfig, sizePaperPosition, type SizingConfig } from "./sizing.ts";
import {
  openPaperPositionOnDb, recordPaperSkipOnDb, hasPaperPosition,
  type PaperStoreResult,
} from "./store.ts";

/** Maximum age of the quote used to open a position. */
export const MAX_ENTRY_QUOTE_AGE_MS = 60_000;
/** A spread wider than this is not executable enough to simulate honestly. */
export const MAX_ENTRY_SPREAD_PCT = 35;

export type PaperEntryRejection =
  | "PAPER_DISABLED"
  | "INELIGIBLE_STATE"
  | "UPDATE_ONLY_STATE"
  | "NO_EXACT_OCC"
  | "WRONG_OCC"
  | "NO_QUOTE"
  | "NO_ASK"
  | "STALE_QUOTE"
  | "FUTURE_QUOTE"
  | "WRONG_SESSION"
  | "CROSSED_MARKET"
  | "UNUSABLE_SPREAD"
  | "DUPLICATE_POSITION"
  | "NOT_SIZEABLE";

export interface PaperEntryQuote {
  optionSymbol: string;
  bid: number | null;
  ask: number | null;
  quoteAtMs: number | null;
  underlyingPrice: number | null;
}

export interface PaperEntryCandidate {
  sessionDate: string;
  caseFingerprint: string;
  symbol: string;
  direction: "CALL" | "PUT";
  optionSymbol: string;
  setupFamily: string | null;
  state: AsymmetryResearchState;
  evidenceJson: string | null;
  missingEvidence: string[];
}

export interface PaperEntryDecision {
  eligible: boolean;
  rejection: PaperEntryRejection | null;
  detail: string | null;
  positionFingerprint: string;
  /** The conservative simulated fill — the ask — when eligible. */
  entryFill: number | null;
  spreadPct: number | null;
}

const OCC = /^O:[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The whole entry rule, as one pure function. Given the same candidate, quote,
 * and clock it always returns the same decision — which is what makes a cohort
 * reproducible from stored rows months later.
 *
 * Note the ORDER: identity is checked before quality. A quote for the wrong
 * contract is a wrong-OCC fault regardless of how good the numbers look.
 */
export function decidePaperEntry(
  candidate: PaperEntryCandidate,
  quote: PaperEntryQuote | null,
  nowMs: number,
  opts: { alreadyHasPosition?: boolean } = {},
): PaperEntryDecision {
  const fingerprint = paperPositionFingerprint(candidate);
  const no = (rejection: PaperEntryRejection, detail: string | null = null): PaperEntryDecision => ({
    eligible: false, rejection, detail, positionFingerprint: fingerprint, entryFill: null, spreadPct: null,
  });

  // 1. Is this a state that may open a position at all?
  if (!isPaperEntryState(candidate.state)) {
    return candidate.state === "TRIGGERED"
      ? no("UPDATE_ONLY_STATE", "TRIGGERED may update an existing position but never opens one")
      : no("INELIGIBLE_STATE", `${candidate.state} is not one of ${PAPER_ENTRY_STATES.join(", ")}`);
  }

  // 2. Exact OCC only. A malformed or absent contract symbol can never be sized.
  if (!candidate.optionSymbol || !OCC.test(candidate.optionSymbol)) {
    return no("NO_EXACT_OCC", `not an exact OCC symbol: ${candidate.optionSymbol || "(absent)"}`);
  }

  // 3. One position per fingerprint. Checked here for a clean reason; the
  //    PRIMARY KEY is what actually guarantees it.
  if (opts.alreadyHasPosition) return no("DUPLICATE_POSITION", "a position already exists for this fingerprint");

  // 4. A quote must exist and be the RIGHT contract's quote.
  if (!quote) return no("NO_QUOTE", "no executable quote available");
  if (String(quote.optionSymbol ?? "").toUpperCase() !== candidate.optionSymbol.toUpperCase()) {
    return no("WRONG_OCC", `quote is for ${quote.optionSymbol}, expected ${candidate.optionSymbol}`);
  }

  // 5. Freshness and session. Evidence from the future or from the wrong
  //    session is refused outright rather than discounted.
  const at = num(quote.quoteAtMs);
  if (at == null) return no("NO_QUOTE", "quote carries no timestamp");
  if (at > nowMs) return no("FUTURE_QUOTE", `quote timestamp ${at} is after now ${nowMs}`);
  if (nowMs - at > MAX_ENTRY_QUOTE_AGE_MS) return no("STALE_QUOTE", `quote is ${nowMs - at}ms old`);
  if (!isOptionsQuoteSession(at)) return no("WRONG_SESSION", "quote is outside the options quote session");
  if (tradingDay(at) !== candidate.sessionDate) {
    return no("WRONG_SESSION", `quote day ${tradingDay(at)} != case session ${candidate.sessionDate}`);
  }

  // 6. Executable two-sided market.
  const bid = num(quote.bid);
  const ask = num(quote.ask);
  if (ask == null || ask <= 0) return no("NO_ASK", "no positive ask to pay");
  if (bid == null || bid <= 0) return no("NO_QUOTE", "no positive bid — a one-sided market is not executable");
  if (ask < bid) return no("CROSSED_MARKET", `ask ${ask} < bid ${bid}`);

  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? round2(((ask - bid) / mid) * 100) : null;
  if (spreadPct == null) return no("NO_QUOTE", "spread not computable");
  if (spreadPct > MAX_ENTRY_SPREAD_PCT) {
    return no("UNUSABLE_SPREAD", `${spreadPct}% exceeds the ${MAX_ENTRY_SPREAD_PCT}% ceiling`);
  }

  return {
    eligible: true, rejection: null, detail: null,
    positionFingerprint: fingerprint,
    entryFill: ask,   // conservative: pay the offer
    spreadPct,
  };
}

export interface OpenPaperTradeResult {
  opened: boolean;
  skipped: boolean;
  rejection: PaperEntryRejection | null;
  detail: string | null;
  positionFingerprint: string;
  entryFill: number | null;
  fixedRiskQty: number | null;
  error: string | null;
}

export interface OpenPaperTradeDeps {
  nowMs: number;
  env?: NodeJS.ProcessEnv;
  sizing?: SizingConfig;
  codeVersion?: string | null;
  /** The subscriber alert covering the same contract, when one already exists. */
  alertId?: string | null;
}

type EntryDb = Parameters<typeof hasPaperPosition>[0];

/**
 * Decide and, when eligible, open one simulated position. Never throws.
 * Flag-gated: with HIGH_ASYMMETRY_PAPER_ENABLED unset this records nothing at
 * all — not even a skip — because a disabled lane has no opinion to record.
 */
export function openAsymmetryPaperTrade(
  db: EntryDb,
  candidate: PaperEntryCandidate,
  quote: PaperEntryQuote | null,
  deps: OpenPaperTradeDeps,
): OpenPaperTradeResult {
  const out: OpenPaperTradeResult = {
    opened: false, skipped: false, rejection: null, detail: null,
    positionFingerprint: paperPositionFingerprint(candidate),
    entryFill: null, fixedRiskQty: null, error: null,
  };
  try {
    const env = deps.env ?? process.env;
    if (env.HIGH_ASYMMETRY_PAPER_ENABLED !== "1") {
      out.rejection = "PAPER_DISABLED";
      out.detail = "HIGH_ASYMMETRY_PAPER_ENABLED is not set";
      return out;
    }

    const already = hasPaperPosition(db, candidate.sessionDate, out.positionFingerprint);
    const decision = decidePaperEntry(candidate, quote, deps.nowMs, { alreadyHasPosition: already });
    out.rejection = decision.rejection;
    out.detail = decision.detail;

    if (!decision.eligible || decision.entryFill == null) {
      const res = recordPaperSkipOnDb(db, {
        sessionDate: candidate.sessionDate,
        positionFingerprint: out.positionFingerprint,
        reason: decision.rejection ?? "UNKNOWN",
        detail: decision.detail,
        stateAtSkip: candidate.state,
        nowMs: deps.nowMs,
      });
      out.skipped = true;
      if (res.error) out.error = res.error;
      return out;
    }

    const cfg = deps.sizing ?? resolveSizingConfig(env);
    const size = sizePaperPosition(decision.entryFill, cfg);
    out.entryFill = decision.entryFill;
    out.fixedRiskQty = size.fixedRiskQty;

    // A position that cannot be sized in the FIXED_RISK cohort is still a valid
    // FIXED_CONTRACT observation, so it is opened with the reason recorded
    // rather than discarded. The null propagates; it never becomes a zero.
    const stored: PaperStoreResult = openPaperPositionOnDb(db, {
      sessionDate: candidate.sessionDate,
      positionFingerprint: out.positionFingerprint,
      caseFingerprint: candidate.caseFingerprint,
      alertId: deps.alertId ?? null,
      symbol: candidate.symbol,
      direction: candidate.direction,
      optionSymbol: candidate.optionSymbol,
      setupFamily: candidate.setupFamily,
      stateAtEntry: candidate.state,
      entryAtMs: deps.nowMs,
      entryFill: decision.entryFill,
      entryBid: quote?.bid ?? null,
      entryAsk: quote?.ask ?? null,
      entrySpreadPct: decision.spreadPct,
      entryUnderlyingPrice: quote?.underlyingPrice ?? null,
      entryQuoteAtMs: quote?.quoteAtMs ?? null,
      evidenceJson: candidate.evidenceJson,
      missingEvidenceJson: JSON.stringify(candidate.missingEvidence ?? []),
      stopLossPct: cfg.stopLossPct,
      fixedRiskQty: size.fixedRiskQty,
      fixedRiskReason: size.fixedRiskReason,
      fixedRiskCostUsd: size.fixedRiskCostUsd,
      fixedRiskAtRiskUsd: size.fixedRiskAtRiskUsd,
      codeVersion: deps.codeVersion ?? null,
    }, deps.nowMs);

    if (stored.error) out.error = stored.error;
    if (stored.created) {
      out.opened = true;
    } else {
      // Lost the race, or a replayed tick. Both are duplicates, not failures.
      out.skipped = true;
      out.rejection = "DUPLICATE_POSITION";
      out.detail = "a position for this fingerprint already existed at insert time";
      recordPaperSkipOnDb(db, {
        sessionDate: candidate.sessionDate,
        positionFingerprint: out.positionFingerprint,
        reason: "DUPLICATE_POSITION",
        detail: out.detail,
        stateAtSkip: candidate.state,
        nowMs: deps.nowMs,
      });
    }
    return out;
  } catch (err: any) {
    // Paper entry is research. It is always the thing that gives way.
    out.error = String(err?.message ?? err);
    return out;
  }
}

export { PAPER_RULES_VERSION };
const round2 = (n: number): number => Math.round(n * 100) / 100;
