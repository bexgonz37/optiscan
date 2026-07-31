/**
 * live-intake.ts — the radar's admission decision for a live candidate.
 *
 * PURE. No I/O, no DB, no network, no clock beyond the caller-supplied `nowMs`.
 *
 * WHY THIS EXISTS, AND HOW IT DIFFERS FROM THE SUBSCRIBER PIPELINE
 *
 * The subscriber pipeline is deliberately conservative: it rejects on a long
 * list of conditions because a bad SEND costs a subscriber money. The radar has
 * the opposite job — observe a contract EARLY, before premium expands, and
 * record what was and was not knowable at that moment. Applying subscriber hard
 * gates here would reject exactly the early, incomplete candidates the radar
 * exists to study.
 *
 * So the rule is: BLOCK only on conditions that make the observation itself
 * unusable or unsafe, and LABEL everything else.
 *
 * HARD BLOCKERS (the observation cannot be trusted or is a duplicate):
 *   - no valid exact OCC / contract identity disagreement
 *   - no fresh executable quote
 *   - unusable spread or liquidity
 *   - future, stale, wrong-session, or after-hours evidence
 *   - duplicate active case for the same fingerprint
 *   - explicit invalidation
 *
 * LABELLED, NEVER BLOCKING (absence is a fact worth recording):
 *   - missing catalyst
 *   - missing sector or market alignment
 *   - missing IV / Greeks
 *   - missing relative volume or volume acceleration
 *   - missing compression state, level distances, prior move
 *
 * Nothing is defaulted to 0. A missing number stays null and carries a reason,
 * because 0 and "unsourced" are different facts and conflating them would
 * silently manufacture evidence.
 */
import { validateExecutableQuote, verifyOccIdentity, type QuoteRejection } from "./evidence.ts";

/** Conditions that make an observation unusable. Kept deliberately short. */
export type IntakeBlockReason =
  | "NO_EXACT_OCC"
  | "CONTRACT_IDENTITY_MISMATCH"
  | "NO_EXECUTABLE_QUOTE"
  | "UNUSABLE_SPREAD"
  | "UNUSABLE_LIQUIDITY"
  | "EVIDENCE_FROM_FUTURE"
  | "WRONG_SESSION"
  | "STALE_QUOTE"
  | "DUPLICATE_ACTIVE_CASE"
  | "EXPLICITLY_INVALIDATED";

/** Optional evidence that was absent. Recorded, never a block. */
export type IntakeLabel =
  | "NO_CATALYST"
  | "NO_MARKET_ALIGNMENT"
  | "NO_SECTOR_ALIGNMENT"
  | "NO_IMPLIED_VOLATILITY"
  | "NO_GREEKS"
  | "NO_RELATIVE_VOLUME"
  | "NO_VOLUME_ACCELERATION"
  | "NO_COMPRESSION_STATE"
  | "NO_LEVEL_DISTANCE"
  | "NO_PRIOR_MOVE"
  | "NO_VWAP_RELATIONSHIP"
  | "NO_OPEN_INTEREST"
  | "NO_OPTION_VOLUME";

export interface LiveIntakeInput {
  symbol: string;
  direction: "CALL" | "PUT";
  /** Exact OCC. Absence is a hard block — an unidentifiable contract is useless. */
  optionSymbol: string | null;
  /** Separately supplied identity, cross-checked against the OCC. */
  underlying: string | null;
  expiration: string | null;
  strike: number | null;
  right: "C" | "P" | null;

  observedAtMs: number;
  sessionDate: string;
  fingerprint: string;

  bid: number | null;
  ask: number | null;
  quoteAtMs: number | null;
  quoteAgeMs: number | null;

  optionVolume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;

  underlyingPrice: number | null;
  vwap: number | null;
  stockVolume: number | null;
  relativeVolume: number | null;
  volumeAcceleration: number | null;
  priorMovePct: number | null;
  compressionState: string | null;
  distanceToTriggerPct: number | null;
  roomToNextLevelPct: number | null;
  marketAlignment: string | null;
  sectorAlignment: string | null;
  catalyst: { label: string; source: string } | null;
  setupFamily: string | null;
  scannerVersion: string | null;

  /** True when this fingerprint already has an open case this session. */
  hasActiveCase: boolean;
  /** Caller-supplied explicit invalidation. */
  invalidated: boolean;

  nowMs: number;
}

export interface LiveIntakeDecision {
  admitted: boolean;
  blockedBy: IntakeBlockReason[];
  labels: IntakeLabel[];
  /** Derived, only when the quote is executable. Null otherwise — never 0. */
  mid: number | null;
  spreadPct: number | null;
  volumeOiRatio: number | null;
  vwapRelationship: "ABOVE" | "BELOW" | "AT" | null;
  /** Echoed identity, only when it verified. */
  optionSymbol: string | null;
  fingerprint: string;
  observedAtMs: number;
  /** Always false. Intake has no delivery authority of any kind. */
  subscriberSendCreated: false;
}

// Deliberately looser than the subscriber pipeline: these bound usability, not
// desirability. A wide-but-tradable spread is still a valid observation.
export const MAX_SPREAD_PCT = 35;
export const MAX_QUOTE_AGE_MS = 120_000;
export const MIN_OPEN_INTEREST = 1;
export const MIN_OPTION_VOLUME = 0;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Decide whether a live candidate is admissible as a radar observation.
 * Deterministic: identical input always yields an identical decision.
 */
export function decideLiveIntake(input: LiveIntakeInput): LiveIntakeDecision {
  const blockedBy: IntakeBlockReason[] = [];
  const labels: IntakeLabel[] = [];

  // ── Hard blockers ─────────────────────────────────────────────────────────
  if (input.invalidated) blockedBy.push("EXPLICITLY_INVALIDATED");
  if (input.hasActiveCase) blockedBy.push("DUPLICATE_ACTIVE_CASE");

  const occ = input.optionSymbol?.trim() ? input.optionSymbol.trim().toUpperCase() : null;
  let identityOk = false;
  if (!occ) {
    blockedBy.push("NO_EXACT_OCC");
  } else {
    const identity = verifyOccIdentity({
      occSymbol: occ,
      symbol: input.underlying,
      expiration: input.expiration,
      strike: input.strike,
      optionType: input.right === "C" ? "call" : input.right === "P" ? "put" : null,
    });
    identityOk = identity.ok;
    if (!identity.ok) blockedBy.push("CONTRACT_IDENTITY_MISMATCH");
  }

  const quote = validateExecutableQuote({
    occSymbol: occ,
    expectedOccSymbol: occ,
    atMs: input.observedAtMs,
    bid: input.bid,
    ask: input.ask,
    quoteTimestampMs: input.quoteAtMs,
    referenceAtMs: input.observedAtMs,
    maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
  });
  if (!quote.valid) {
    blockedBy.push(mapQuoteRejection(quote.reason ?? null));
  }

  const bid = isNum(input.bid) ? input.bid : null;
  const ask = isNum(input.ask) ? input.ask : null;
  const mid = quote.valid && bid != null && ask != null ? (bid + ask) / 2 : null;
  const spreadPct = mid != null && mid > 0 && bid != null && ask != null
    ? ((ask - bid) / mid) * 100
    : null;
  if (spreadPct != null && spreadPct > MAX_SPREAD_PCT) blockedBy.push("UNUSABLE_SPREAD");

  const oi = isNum(input.openInterest) ? input.openInterest : null;
  const vol = isNum(input.optionVolume) ? input.optionVolume : null;
  if (oi != null && oi < MIN_OPEN_INTEREST) blockedBy.push("UNUSABLE_LIQUIDITY");

  // ── Labels: absence recorded, never blocking ──────────────────────────────
  if (!input.catalyst || !input.catalyst.label?.trim() || !input.catalyst.source?.trim()) labels.push("NO_CATALYST");
  if (!input.marketAlignment?.trim()) labels.push("NO_MARKET_ALIGNMENT");
  if (!input.sectorAlignment?.trim()) labels.push("NO_SECTOR_ALIGNMENT");
  if (!isNum(input.impliedVolatility)) labels.push("NO_IMPLIED_VOLATILITY");
  if (!isNum(input.delta) && !isNum(input.gamma)) labels.push("NO_GREEKS");
  if (!isNum(input.relativeVolume)) labels.push("NO_RELATIVE_VOLUME");
  if (!isNum(input.volumeAcceleration)) labels.push("NO_VOLUME_ACCELERATION");
  if (!input.compressionState?.trim()) labels.push("NO_COMPRESSION_STATE");
  if (!isNum(input.distanceToTriggerPct) && !isNum(input.roomToNextLevelPct)) labels.push("NO_LEVEL_DISTANCE");
  if (!isNum(input.priorMovePct)) labels.push("NO_PRIOR_MOVE");
  if (!isNum(input.underlyingPrice) || !isNum(input.vwap)) labels.push("NO_VWAP_RELATIONSHIP");
  if (oi == null) labels.push("NO_OPEN_INTEREST");
  if (vol == null) labels.push("NO_OPTION_VOLUME");

  // ── Derived values. Undefined stays null, never 0. ────────────────────────
  const volumeOiRatio = vol != null && oi != null && oi > 0 ? vol / oi : null;
  const vwapRelationship = isNum(input.underlyingPrice) && isNum(input.vwap) && input.vwap > 0
    ? (input.underlyingPrice > input.vwap ? "ABOVE" : input.underlyingPrice < input.vwap ? "BELOW" : "AT")
    : null;

  return {
    admitted: blockedBy.length === 0,
    blockedBy,
    labels,
    mid: mid == null ? null : round2(mid),
    spreadPct: spreadPct == null ? null : round2(spreadPct),
    volumeOiRatio: volumeOiRatio == null ? null : round2(volumeOiRatio),
    vwapRelationship,
    optionSymbol: identityOk ? occ : null,
    fingerprint: input.fingerprint,
    observedAtMs: input.observedAtMs,
    subscriberSendCreated: false,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mapQuoteRejection(rejection: QuoteRejection | null): IntakeBlockReason {
  switch (rejection) {
    case "QUOTE_TIMESTAMP_IN_FUTURE": return "EVIDENCE_FROM_FUTURE";
    case "QUOTE_FROM_DIFFERENT_SESSION":
    case "QUOTE_OUTSIDE_OPTIONS_SESSION": return "WRONG_SESSION";
    case "QUOTE_STALE": return "STALE_QUOTE";
    case "QUOTE_WRONG_OCC": return "CONTRACT_IDENTITY_MISMATCH";
    default: return "NO_EXECUTABLE_QUOTE";
  }
}

/**
 * Lead-time arithmetic: how much earlier the radar saw a contract than the
 * subscriber pipeline, and what that earliness was worth in premium.
 *
 * Both are null when the comparison is not measurable. A subscriber alert that
 * never happened does NOT make the lead time zero or infinite — it makes it
 * unknown, which is a different and honest answer.
 */
export function computeLeadTime(input: {
  radarObservedAtMs: number | null;
  subscriberAlertAtMs: number | null;
  radarAsk: number | null;
  subscriberAsk: number | null;
}): { leadMs: number | null; premiumAvoidedPct: number | null } {
  const { radarObservedAtMs, subscriberAlertAtMs, radarAsk, subscriberAsk } = input;
  const leadMs = isNum(radarObservedAtMs) && isNum(subscriberAlertAtMs)
    ? subscriberAlertAtMs - radarObservedAtMs
    : null;
  const premiumAvoidedPct = isNum(radarAsk) && radarAsk > 0 && isNum(subscriberAsk) && subscriberAsk > 0
    ? round2(((subscriberAsk - radarAsk) / radarAsk) * 100)
    : null;
  return { leadMs, premiumAvoidedPct };
}
