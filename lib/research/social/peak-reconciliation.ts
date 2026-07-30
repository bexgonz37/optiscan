/**
 * peak-reconciliation.ts — PURE reconciliation of verified peak vs canonical exit.
 *
 * ROOT CAUSE THIS FIXES
 * The recap reported a peak that could be LOWER than the realized exit on 42 of 72
 * closed callouts. Both numbers were individually correct but used different price
 * conventions on the same quote:
 *   - peak came from exit-policy research, computed on the RAW BID
 *   - the canonical exit uses realOptionExit(), which fills at
 *     mid - (mid - bid) * 0.6  ==  bid + 0.2 * (ask - bid)  — strictly ABOVE bid
 * So on any wide spread the exit outran a bid-only peak. The gap tracked spread
 * width exactly (MSFT 7.48pp, SPY 0.13pp).
 *
 * THE FIX IS NOT max(peak, tracked).
 * That would paper over an unverified exit. Instead the peak is recomputed on the
 * SAME executable convention as the exit, from verified in-session marks, and the
 * exit is only allowed to raise the peak when its own quote evidence supports it.
 * A row whose exit cannot be proven is classified incomplete and dropped from public
 * drafts rather than published with an impossible peak/tracked pair.
 *
 * No canonical paper outcome is modified anywhere in this file.
 */
import { isOptionsQuoteSession } from "../../market-session-guard.ts";
import { realOptionExit } from "../options/paper.ts";

export type ExitEvidenceClass =
  | "VERIFIED_EXECUTABLE_EXIT"
  | "EXIT_WITH_VALID_QUOTE_CONTEXT"
  | "EXIT_ABOVE_RECORDED_BID_BUT_WITHIN_ASK"
  | "EXIT_WITHOUT_QUOTE_PROOF"
  | "STALE_EXIT"
  | "AFTER_HOURS_EXIT"
  | "INVALID_EXIT"
  | "INSUFFICIENT_EVIDENCE";

/** Exit classes whose quote evidence is strong enough to support the peak. */
const PROVEN_EXIT_CLASSES = new Set<ExitEvidenceClass>([
  "VERIFIED_EXECUTABLE_EXIT",
  "EXIT_ABOVE_RECORDED_BID_BUT_WITHIN_ASK",
]);

export interface ReconMark {
  markAtMs: number;
  bid: number | null;
  ask: number | null;
  quoteAgeMs: number | null;
  createdAtMs: number | null;
}

export interface ReconInput {
  frozenEntry: number;
  marks: ReconMark[];
  /** Canonical exit price and time from options_paper_trades. Null while open. */
  exitFill: number | null;
  exitAtMs: number | null;
  trackedPct: number | null;
  status: "CLOSED" | "OPEN";
  maxQuoteAgeMs?: number;
  /** How close a mark must sit to the exit to be contemporaneous. */
  exitMatchWindowMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ReconResult {
  exitClass: ExitEvidenceClass;
  /** Max return supported by verified executable evidence in-session. */
  canonicalPeakPct: number | null;
  canonicalTrackedPct: number | null;
  /** Highest raw-bid return, kept for transparency about the old convention. */
  highestVerifiedBidReturnPct: number | null;
  /** Highest executable (realOptionExit) return across verified marks. */
  highestExecutableReturnPct: number | null;
  exitEvidence: {
    matchedMarkAtMs: number | null;
    matchedBid: number | null;
    matchedAsk: number | null;
    matchedQuoteAgeMs: number | null;
    withinBidAsk: boolean | null;
    providerTimestampMs: number | null;
  };
  validMarkCount: number;
  invariantOk: boolean;
  /** False ⇒ the row must not appear in public performance drafts. */
  usableForPublicDrafts: boolean;
  reasons: string[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

interface ValidMark extends ReconMark {
  bid: number;
  ask: number;
  bidReturnPct: number;
  executableReturnPct: number;
  executableFill: number;
}

/** Marks that are executable evidence: real two-sided quote, fresh, in-session. */
function validMarks(input: ReconInput, maxQuoteAgeMs: number): ValidMark[] {
  const env = input.env ?? process.env;
  const out: ValidMark[] = [];
  for (const m of input.marks ?? []) {
    if (!isNum(m.markAtMs)) continue;
    if (!isNum(m.bid) || m.bid <= 0) continue;
    if (!isNum(m.ask) || m.ask < m.bid) continue;
    if (m.quoteAgeMs != null && (!isNum(m.quoteAgeMs) || m.quoteAgeMs < 0 || m.quoteAgeMs > maxQuoteAgeMs)) continue;
    // A mark stamped outside the options session is never executable evidence.
    if (!isOptionsQuoteSession(m.markAtMs, env)) continue;
    if (m.createdAtMs != null && isNum(m.createdAtMs)) {
      const delay = m.createdAtMs - m.markAtMs;
      if (delay < 0 || delay > maxQuoteAgeMs) continue;
    }
    const exec = realOptionExit(input.frozenEntry, m.bid, m.ask);
    out.push({
      ...m,
      bid: m.bid,
      ask: m.ask,
      bidReturnPct: round4(((m.bid - input.frozenEntry) / input.frozenEntry) * 100),
      executableReturnPct: exec.returnPct,
      executableFill: exec.exitFill,
    });
  }
  return out.sort((a, b) => a.markAtMs - b.markAtMs);
}

/**
 * Reconcile one callout's peak against its canonical exit.
 *
 * The peak is computed on the executable convention so it is directly comparable to
 * the tracked exit. The exit may only lift the peak when its own quote evidence
 * proves it was executable.
 */
export function reconcilePeakAndExit(input: ReconInput): ReconResult {
  const env = input.env ?? process.env;
  const maxQuoteAgeMs = Math.max(1_000, input.maxQuoteAgeMs ?? 900_000);
  const matchWindowMs = Math.max(1_000, input.exitMatchWindowMs ?? 120_000);
  const reasons: string[] = [];

  const base: ReconResult = {
    exitClass: "INSUFFICIENT_EVIDENCE",
    canonicalPeakPct: null,
    canonicalTrackedPct: isNum(input.trackedPct) ? round4(input.trackedPct) : null,
    highestVerifiedBidReturnPct: null,
    highestExecutableReturnPct: null,
    exitEvidence: {
      matchedMarkAtMs: null, matchedBid: null, matchedAsk: null,
      matchedQuoteAgeMs: null, withinBidAsk: null, providerTimestampMs: null,
    },
    validMarkCount: 0,
    invariantOk: false,
    usableForPublicDrafts: false,
    reasons,
  };

  if (!isNum(input.frozenEntry) || input.frozenEntry <= 0) {
    return { ...base, exitClass: "INVALID_EXIT", reasons: ["frozen entry is not a positive number"] };
  }

  const marks = validMarks(input, maxQuoteAgeMs);
  base.validMarkCount = marks.length;
  if (marks.length > 0) {
    base.highestVerifiedBidReturnPct = round4(Math.max(...marks.map((m) => m.bidReturnPct)));
    base.highestExecutableReturnPct = round4(Math.max(...marks.map((m) => m.executableReturnPct)));
  }

  // ---- OPEN positions: peak is whatever verified marks support. No exit to prove.
  if (input.status === "OPEN") {
    return {
      ...base,
      exitClass: marks.length ? "EXIT_WITH_VALID_QUOTE_CONTEXT" : "INSUFFICIENT_EVIDENCE",
      canonicalPeakPct: base.highestExecutableReturnPct,
      canonicalTrackedPct: null,
      invariantOk: true, // no tracked result to violate
      usableForPublicDrafts: marks.length > 0,
      reasons: marks.length ? ["open position; peak from verified marks only"] : ["no verified marks"],
    };
  }

  // ---- CLOSED positions.
  if (!isNum(input.exitFill) || input.exitFill <= 0 || !isNum(input.exitAtMs)) {
    return { ...base, exitClass: "INVALID_EXIT", reasons: ["closed trade without a usable exit price or time"] };
  }
  if (!isNum(input.trackedPct)) {
    return { ...base, exitClass: "INVALID_EXIT", reasons: ["closed trade without a canonical tracked return"] };
  }
  if (marks.length === 0) {
    return { ...base, exitClass: "INSUFFICIENT_EVIDENCE", reasons: ["no verified in-session marks"] };
  }
  if (!isOptionsQuoteSession(input.exitAtMs, env)) {
    return {
      ...base,
      exitClass: "AFTER_HOURS_EXIT",
      reasons: ["exit timestamp falls outside the options session; it cannot raise the peak"],
    };
  }

  // Contemporaneous marks around the exit.
  const near = marks
    .map((m) => ({ m, delta: Math.abs(m.markAtMs - (input.exitAtMs as number)) }))
    .filter((x) => x.delta <= matchWindowMs)
    .sort((a, b) => a.delta - b.delta);

  if (near.length === 0) {
    // Something was recorded, but nothing near the exit — the exit price is unproven.
    const anyStaleNear = (input.marks ?? []).some(
      (m) => isNum(m.markAtMs) && Math.abs(m.markAtMs - (input.exitAtMs as number)) <= matchWindowMs,
    );
    return {
      ...base,
      exitClass: anyStaleNear ? "STALE_EXIT" : "EXIT_WITHOUT_QUOTE_PROOF",
      reasons: [anyStaleNear
        ? "the only quotes near the exit failed freshness or session validation"
        : "no verified quote within the exit window"],
    };
  }

  const best = near[0].m;
  base.exitEvidence = {
    matchedMarkAtMs: best.markAtMs,
    matchedBid: best.bid,
    matchedAsk: best.ask,
    matchedQuoteAgeMs: best.quoteAgeMs ?? null,
    withinBidAsk: input.exitFill >= best.bid - 0.005 && input.exitFill <= best.ask + 0.005,
    providerTimestampMs: best.markAtMs,
  };

  // Does the canonical exit reproduce from this quote under the same convention?
  const reproduces = Math.abs(best.executableFill - (input.exitFill as number)) <= 0.01;
  const withinSpread = base.exitEvidence.withinBidAsk === true;

  let exitClass: ExitEvidenceClass;
  if (reproduces) {
    exitClass = "VERIFIED_EXECUTABLE_EXIT";
    reasons.push("canonical exit reproduces from a verified contemporaneous quote");
  } else if (withinSpread) {
    // Above the recorded bid but inside the quoted spread — still executable evidence.
    exitClass = "EXIT_ABOVE_RECORDED_BID_BUT_WITHIN_ASK";
    reasons.push("exit sits above the recorded bid but within the verified bid/ask");
  } else {
    exitClass = "EXIT_WITH_VALID_QUOTE_CONTEXT";
    reasons.push("a verified quote exists near the exit, but the exit price falls outside it");
  }

  const proven = PROVEN_EXIT_CLASSES.has(exitClass);
  const tracked = round4(input.trackedPct);
  const marksPeak = base.highestExecutableReturnPct as number;

  // The exit may only lift the peak when its own evidence supports it.
  const canonicalPeakPct = proven ? round4(Math.max(marksPeak, tracked)) : marksPeak;
  const invariantOk = canonicalPeakPct >= tracked - 1e-6;

  if (!proven && !invariantOk) {
    reasons.push("tracked exit exceeds every verified mark and the exit lacks quote proof");
  }

  return {
    ...base,
    exitClass,
    canonicalPeakPct,
    canonicalTrackedPct: tracked,
    invariantOk,
    // A row is publishable only when the invariant holds on verified evidence.
    usableForPublicDrafts: invariantOk,
    reasons,
  };
}
