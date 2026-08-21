/**
 * optionability.ts — DOES THIS SYMBOL HAVE OPTIONS AT ALL, and what did a
 * zero-contract answer actually mean.
 *
 * WHY THIS EXISTS, in one measurement.
 *
 * From the provider audit on 2026-08-21:
 *
 *   total provider requests                          ~140,438
 *   quota blocks                                      ~11,449
 *   option snapshot chains, share of all usage           44.5%
 *   measured contract-selection attempts                1,888
 *   attempts returning NO_CONTRACTS_RETURNED              802  across 194 symbols
 *   served option-chain PAGES that returned 0 contracts 3,208
 *
 * 802 of 1,888 attempts — 42% — bought nothing. Meanwhile MRNA had a bullish
 * CALL at score 1.0 with research_only 0 and its chain fetch was refused with
 * PROVIDER_QUOTA_EXCEEDED. The capacity to serve MRNA existed; it had already
 * been spent asking symbols that were never going to answer.
 *
 * THE MISTAKE THIS MODULE REFUSES TO MAKE. The cheap fix — "it returned zero, so
 * stop asking" — is wrong, and wrong in the expensive direction: a symbol
 * incorrectly marked NOT_OPTIONABLE is invisible FOREVER, and nothing downstream
 * can recover it. The 802 do not share one cause. A zero-contract response can
 * mean the symbol has no options, or that WE asked for a 7-day window on a
 * monthly-only name, or that our own page budget ran out before the range, or
 * that the provider was rate-limiting us at that instant. Only the first is a
 * fact about the symbol. The rest are facts about the REQUEST.
 *
 * So the state is TRI-STATE and UNKNOWN IS ELIGIBLE:
 *
 *   OPTIONABLE      contracts have been seen. Cheap to keep, never expires by
 *                   itself.
 *   NOT_OPTIONABLE  positively established, by authoritative reference evidence
 *                   or by corroboration across separate sessions. The ONLY state
 *                   that suppresses spend.
 *   UNKNOWN         everything else, including every symbol never asked about.
 *                   Fully eligible. Costs a chain request when promoted, which
 *                   is the correct price for not yet knowing.
 *
 * A quota refusal, a timeout, a truncated page budget, a provider error, or one
 * empty narrow-DTE window can NEVER produce NOT_OPTIONABLE. Those say nothing
 * about the symbol, and the code enforces it rather than documenting it.
 *
 * PURE. No clock (the caller passes `nowMs`), no I/O, no env read. The registry
 * is an explicit value the caller owns and persists.
 */
import type { ChainFetchOutcome, ChainFetchOutcomeCode } from "./loop.ts";
import type { ContractTerminalReason } from "./contract-discovery.ts";

/* ---------------------------------------------------------------------------
 * PHASE 7 — ZERO-CONTRACT CLASSIFICATION
 * -------------------------------------------------------------------------*/

/**
 * Why an attempt came back with no contracts.
 *
 * The 802 were being counted as one number. They are not one thing, and the
 * share that is safely eliminable is only the share that is genuinely about the
 * symbol rather than about the request.
 */
export type ZeroContractCause =
  /** The symbol genuinely has no listed options. A fact about the SYMBOL. */
  | "NOT_OPTIONABLE"
  /** Options exist, but not in the DTE window WE asked for. A fact about the REQUEST. */
  | "NO_CONTRACTS_IN_REQUESTED_DTE"
  /** Provider answered successfully with an empty body. Ambiguous — never conclusive alone. */
  | "PROVIDER_EMPTY_RESPONSE"
  /** Our page budget or the provider truncated before the range was reached. */
  | "PROVIDER_INCOMPLETE"
  /** No contract-reference evidence exists yet for this symbol either way. */
  | "REFERENCE_UNKNOWN"
  /**
   * The provider refused on quota. Its OWN cause, not a member of `OTHER`.
   *
   * MRNA died here — bullish CALL, score 1.0, research_only 0 — and while quota
   * shared a bucket with timeouts and missing config, the one refusal that means
   * "we ran out of lane, not out of market" was unattributable. A capacity
   * failure and a transport failure need different fixes, so they need different
   * names.
   */
  | "PROVIDER_QUOTA_EXCEEDED"
  /**
   * A USABLE CHAIN ARRIVED and the selector found nothing inside the band.
   *
   * Categorically different from every cause above it: those are all statements
   * that the request failed, this is a statement that the request SUCCEEDED and
   * the market had nothing to offer. Conflating the two is what let the operator
   * be told "no eligible contract in delta/DTE band" about a chain that was
   * never received.
   */
  | "NO_ELIGIBLE_CONTRACT"
  /** A usable chain arrived and every candidate failed spread/OI/volume/two-sided. */
  | "LIQUIDITY_REJECTION"
  /** Timeout, config, transport. Says nothing at all about the symbol. */
  | "OTHER";

export interface ZeroContractClassification {
  cause: ZeroContractCause;
  /** True only when this observation may move a symbol toward NOT_OPTIONABLE. */
  countsAsEvidence: boolean;
  /** True when the spend was avoidable given what was already known. */
  wasAvoidable: boolean;
  reason: string;
}

/**
 * Was the requested window broad enough that "nothing came back" is meaningful?
 *
 * A 0-7 DTE ask on a monthly-only name returns nothing and proves nothing. Only
 * a wide window failing to produce a single contract is evidence about the
 * symbol, and even then only as corroboration.
 */
const BROAD_DTE_SPAN = 30;

export function classifyZeroContract(
  outcome: Pick<ChainFetchOutcome, "outcome" | "contracts" | "truncated" | "requestedDteMin" | "requestedDteMax" | "pagesRequested" | "pagesReceived">,
  opts: { referenceKnownOptionable?: boolean | null } = {},
): ZeroContractClassification {
  const code: ChainFetchOutcomeCode = outcome.outcome;
  const n = outcome.contracts?.length ?? 0;

  if (n > 0) {
    return { cause: "REFERENCE_UNKNOWN", countsAsEvidence: false, wasAvoidable: false, reason: "contracts were returned; not a zero-contract outcome" };
  }

  // Anything that is a fact about the transport, the quota or our own budget is
  // definitionally not evidence about the symbol.
  if (code === "PROVIDER_QUOTA_EXCEEDED") {
    return {
      cause: "PROVIDER_QUOTA_EXCEEDED", countsAsEvidence: false, wasAvoidable: false,
      reason: "the lane ran out of budget before the market was asked — a fact about us, not the symbol",
    };
  }
  if (code === "PROVIDER_TIMEOUT" || code === "PROVIDER_FAILURE"
    || code === "PROVIDER_CONFIGURATION_MISSING") {
    return {
      cause: "OTHER", countsAsEvidence: false, wasAvoidable: false,
      reason: `${code} is a fact about the request path, not about the symbol`,
    };
  }
  if (code === "PROVIDER_INVALID_RESPONSE") {
    return { cause: "PROVIDER_EMPTY_RESPONSE", countsAsEvidence: false, wasAvoidable: false, reason: "provider response could not be parsed" };
  }
  if (code === "CHAIN_TRUNCATED_BEFORE_RANGE" || outcome.truncated
    || (outcome.pagesReceived ?? 0) < (outcome.pagesRequested ?? 0)) {
    return {
      cause: "PROVIDER_INCOMPLETE", countsAsEvidence: false, wasAvoidable: false,
      reason: "our own page budget ran out before the range — an artifact of the request",
    };
  }
  if (code === "RANGE_NOT_FETCHED") {
    return { cause: "OTHER", countsAsEvidence: false, wasAvoidable: false, reason: "range was never requested" };
  }

  // A clean, complete, empty answer. Whether it is evidence depends entirely on
  // how wide a net was cast.
  const dteMin = outcome.requestedDteMin;
  const dteMax = outcome.requestedDteMax;
  const span = dteMin != null && dteMax != null ? dteMax - dteMin : null;
  const broad = span != null && span >= BROAD_DTE_SPAN;

  if (opts.referenceKnownOptionable === true) {
    return {
      cause: "NO_CONTRACTS_IN_REQUESTED_DTE", countsAsEvidence: false, wasAvoidable: true,
      reason: "reference says this symbol has options, so an empty window is about the window",
    };
  }
  if (opts.referenceKnownOptionable === false) {
    return {
      cause: "NOT_OPTIONABLE", countsAsEvidence: true, wasAvoidable: true,
      reason: "contract reference positively reports no listed options",
    };
  }
  if (!broad) {
    return {
      cause: "NO_CONTRACTS_IN_REQUESTED_DTE", countsAsEvidence: false, wasAvoidable: false,
      reason: `requested DTE span ${span ?? "unknown"} is too narrow for an empty result to mean anything`,
    };
  }
  return {
    cause: "PROVIDER_EMPTY_RESPONSE", countsAsEvidence: true, wasAvoidable: false,
    reason: `complete empty answer across a ${span}-day window — corroborating evidence, not proof`,
  };
}

/* ---------------------------------------------------------------------------
 * PHASE 6 — THE TRI-STATE REGISTRY
 * -------------------------------------------------------------------------*/

export type OptionabilityState = "OPTIONABLE" | "NOT_OPTIONABLE" | "UNKNOWN";

export type OptionabilitySource =
  /** Contracts were actually received. The strongest positive evidence. */
  | "CHAIN_CONTRACTS_SEEN"
  /** An authoritative contract-reference lookup. The only single-shot negative. */
  | "CONTRACT_REFERENCE"
  /** Repeated clean empty answers across separate sessions. */
  | "CORROBORATED_EMPTY"
  /** Nothing has been established. */
  | "NONE";

export interface OptionabilityRecord {
  symbol: string;
  state: OptionabilityState;
  source: OptionabilitySource;
  lastVerifiedAtMs: number | null;
  reason: string;
  /** Distinct sessions that produced a clean, broad, empty answer. */
  corroboratingEmptyDays: string[];
  /** Observations that were explicitly NOT allowed to count. Kept for audit. */
  inconclusiveObservations: number;
}

export interface OptionabilityConfig {
  /**
   * Distinct SESSIONS of clean broad-window empty answers before a symbol may be
   * called NOT_OPTIONABLE without reference evidence.
   *
   * Distinct sessions, not distinct attempts: 802 attempts inside one bad
   * afternoon is one observation repeated, and repeating a measurement does not
   * make it more true. Two separate days of a wide window returning nothing is
   * a genuinely different claim.
   */
  corroborationDays: number;
  /**
   * How long a NOT_OPTIONABLE verdict is trusted before the symbol returns to
   * UNKNOWN and is retried. Options get listed on names that did not have them;
   * a permanent verdict would make that permanently invisible.
   */
  notOptionableTtlMs: number;
}

export const DEFAULT_OPTIONABILITY: Readonly<OptionabilityConfig> = Object.freeze({
  corroborationDays: 2,
  notOptionableTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
});

export function optionabilityConfig(env: NodeJS.ProcessEnv = process.env): OptionabilityConfig {
  const n = (v: string | undefined, d: number, min: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= min ? x : d;
  };
  return {
    corroborationDays: n(env.OPTIONS_OPTIONABILITY_CORROBORATION_DAYS, DEFAULT_OPTIONABILITY.corroborationDays, 1),
    notOptionableTtlMs: n(env.OPTIONS_OPTIONABILITY_TTL_MS, DEFAULT_OPTIONABILITY.notOptionableTtlMs, 60_000),
  };
}

export function unknownRecord(symbol: string): OptionabilityRecord {
  return {
    symbol: String(symbol).toUpperCase(),
    state: "UNKNOWN",
    source: "NONE",
    lastVerifiedAtMs: null,
    reason: "never established",
    corroboratingEmptyDays: [],
    inconclusiveObservations: 0,
  };
}

/**
 * Fold ONE observation into a symbol record.
 *
 * The rules, in the order they bind:
 *
 *  1. Contracts seen -> OPTIONABLE, always, and any accumulated negative
 *     evidence is DISCARDED. One real contract disproves every empty answer
 *     that preceded it, and keeping the counter would let a symbol drift back
 *     to NOT_OPTIONABLE on noise after it has been proven to have options.
 *  2. Authoritative reference -> believed either way, immediately.
 *  3. Clean broad empty -> counted once per SESSION, and only reaches
 *     NOT_OPTIONABLE at the corroboration threshold.
 *  4. Everything else -> recorded as inconclusive and changes no state.
 */
export function applyOptionabilityObservation(
  prior: OptionabilityRecord,
  obs: {
    classification: ZeroContractClassification;
    contractsSeen: number;
    /** Session date key (e.g. "2026-08-21"), so repeats within a day cannot corroborate. */
    sessionDay: string;
    nowMs: number;
  },
  cfg: OptionabilityConfig = DEFAULT_OPTIONABILITY,
): OptionabilityRecord {
  const base = { ...prior, symbol: prior.symbol.toUpperCase() };

  if (obs.contractsSeen > 0) {
    return {
      ...base,
      state: "OPTIONABLE",
      source: "CHAIN_CONTRACTS_SEEN",
      lastVerifiedAtMs: obs.nowMs,
      reason: `${obs.contractsSeen} contracts received`,
      corroboratingEmptyDays: [], // one real contract disproves every empty answer before it
    };
  }

  const c = obs.classification;

  if (c.cause === "NOT_OPTIONABLE" && c.countsAsEvidence) {
    return {
      ...base,
      state: "NOT_OPTIONABLE",
      source: "CONTRACT_REFERENCE",
      lastVerifiedAtMs: obs.nowMs,
      reason: c.reason,
    };
  }

  if (c.cause === "PROVIDER_EMPTY_RESPONSE" && c.countsAsEvidence) {
    const days = base.corroboratingEmptyDays.includes(obs.sessionDay)
      ? base.corroboratingEmptyDays
      : [...base.corroboratingEmptyDays, obs.sessionDay];
    const enough = days.length >= cfg.corroborationDays;
    return {
      ...base,
      state: enough ? "NOT_OPTIONABLE" : base.state,
      source: enough ? "CORROBORATED_EMPTY" : base.source,
      lastVerifiedAtMs: enough ? obs.nowMs : base.lastVerifiedAtMs,
      reason: enough
        ? `clean wide-window empty answers on ${days.length} separate sessions`
        : `empty on ${days.length}/${cfg.corroborationDays} sessions — still UNKNOWN, still eligible`,
      corroboratingEmptyDays: days,
    };
  }

  // Quota, timeout, truncation, narrow window, parse failure. Recorded, never acted on.
  return { ...base, inconclusiveObservations: base.inconclusiveObservations + 1 };
}

/**
 * Should a chain request be spent on this symbol?
 *
 * ONLY a live, in-TTL NOT_OPTIONABLE verdict suppresses spend. UNKNOWN spends,
 * because not knowing is not a reason to be blind — it is the reason to look.
 */
export function shouldSpendChainRequest(
  rec: OptionabilityRecord | undefined,
  nowMs: number,
  cfg: OptionabilityConfig = DEFAULT_OPTIONABILITY,
): { spend: boolean; reason: string } {
  if (!rec || rec.state !== "NOT_OPTIONABLE") {
    return { spend: true, reason: rec ? `state ${rec.state} is eligible` : "no record — UNKNOWN is eligible" };
  }
  const age = rec.lastVerifiedAtMs == null ? Infinity : nowMs - rec.lastVerifiedAtMs;
  if (age > cfg.notOptionableTtlMs) {
    return { spend: true, reason: `NOT_OPTIONABLE verdict is ${Math.round(age / 86_400_000)}d old — re-verifying` };
  }
  return { spend: false, reason: `${rec.state} via ${rec.source}: ${rec.reason}` };
}

/**
 * A NOT_OPTIONABLE record that has aged past its TTL, expressed as UNKNOWN.
 * Lets a caller sweep the registry back to eligibility without special-casing
 * the TTL at every read site.
 */
export function expireIfStale(
  rec: OptionabilityRecord,
  nowMs: number,
  cfg: OptionabilityConfig = DEFAULT_OPTIONABILITY,
): OptionabilityRecord {
  if (rec.state !== "NOT_OPTIONABLE") return rec;
  const age = rec.lastVerifiedAtMs == null ? Infinity : nowMs - rec.lastVerifiedAtMs;
  if (age <= cfg.notOptionableTtlMs) return rec;
  return {
    ...unknownRecord(rec.symbol),
    reason: `previous NOT_OPTIONABLE (${rec.source}) expired after ${Math.round(age / 86_400_000)}d`,
    inconclusiveObservations: rec.inconclusiveObservations,
  };
}

/* ---------------------------------------------------------------------------
 * PHASE B — THE WHOLE ATTEMPT, NOT ONLY THE FETCH
 * -------------------------------------------------------------------------*/

/**
 * Every cause at zero. The single place the cause list is enumerated at runtime,
 * so adding a cause cannot leave a counter silently missing a key.
 */
export const ZERO_CONTRACT_CAUSE_ZEROES: Readonly<Record<ZeroContractCause, number>> = Object.freeze({
  NOT_OPTIONABLE: 0,
  NO_CONTRACTS_IN_REQUESTED_DTE: 0,
  PROVIDER_EMPTY_RESPONSE: 0,
  PROVIDER_INCOMPLETE: 0,
  REFERENCE_UNKNOWN: 0,
  PROVIDER_QUOTA_EXCEEDED: 0,
  NO_ELIGIBLE_CONTRACT: 0,
  LIQUIDITY_REJECTION: 0,
  OTHER: 0,
});

/** A fresh mutable counter over every cause. */
export function emptyZeroContractCounters(): Record<ZeroContractCause, number> {
  return { ...ZERO_CONTRACT_CAUSE_ZEROES };
}

/**
 * WHERE a cause comes from. The distinction Phase B exists to enforce.
 *
 * `PROVIDER` means the market was never successfully asked. `SELECTOR` means it
 * was asked, it answered with a usable chain, and our own bands found nothing
 * inside it. `SYMBOL` means the answer was about the instrument.
 *
 * A provider failure reported as a selector failure is the specific lie this
 * taxonomy makes unrepresentable: it tells the operator to widen a delta band
 * when the actual fix is to stop starving the lane.
 */
export type ZeroContractOrigin =
  /** The market was never successfully asked. Quota, transport, truncation. */
  | "PROVIDER"
  /**
   * We asked a question too specific for the answer to be informative — an
   * empty 0-7 DTE window on a monthly-only name. Distinct from SELECTOR, which
   * requires contracts to have arrived and been rejected: here nothing was
   * rejected, because nothing was returned to reject.
   */
  | "REQUEST"
  /** A usable chain arrived and OUR bands rejected every contract in it. */
  | "SELECTOR"
  /** The answer was about the instrument. */
  | "SYMBOL";

const ORIGIN_BY_CAUSE: Readonly<Record<ZeroContractCause, ZeroContractOrigin>> = Object.freeze({
  NOT_OPTIONABLE: "SYMBOL",
  NO_CONTRACTS_IN_REQUESTED_DTE: "REQUEST",
  PROVIDER_EMPTY_RESPONSE: "PROVIDER",
  PROVIDER_INCOMPLETE: "PROVIDER",
  REFERENCE_UNKNOWN: "SYMBOL",
  PROVIDER_QUOTA_EXCEEDED: "PROVIDER",
  NO_ELIGIBLE_CONTRACT: "SELECTOR",
  LIQUIDITY_REJECTION: "SELECTOR",
  OTHER: "PROVIDER",
});

export function zeroContractOrigin(cause: ZeroContractCause): ZeroContractOrigin {
  return ORIGIN_BY_CAUSE[cause] ?? "PROVIDER";
}

/**
 * The cause for an attempt that got a USABLE CHAIN and still selected nothing.
 *
 * `classifyZeroContract` answers only the fetch half. This answers the other
 * half, from the funnel's own terminal reason, and it is the half that produces
 * `NO_ELIGIBLE_CONTRACT` and `LIQUIDITY_REJECTION`. Those two may ONLY be
 * reached from here — from a reason that could not have been assigned without
 * contracts in hand — which is what makes "no eligible contract in the delta
 * band" unable to describe a chain that never arrived.
 *
 * Returns null for a terminal reason that is not a zero-contract selector
 * outcome (a selection, or a provider fault the fetch classifier already owns).
 */
export function selectorZeroContractCause(
  reason: ContractTerminalReason | null | undefined,
): ZeroContractCause | null {
  switch (reason) {
    case "NO_CONTRACT_IN_DTE_RANGE":
    case "NO_CONTRACT_IN_DELTA_RANGE":
    case "NO_CONTRACT_IN_MONEYNESS_RANGE":
    case "CONTRACT_RANKING_EMPTY":
    case "NO_CALLS_RETURNED":
    case "NO_PUTS_RETURNED":
    case "WRONG_SIDE_RETURNED":
      return "NO_ELIGIBLE_CONTRACT";
    case "LIQUIDITY_REJECTED":
    case "SPREAD_REJECTED":
    case "PREMIUM_REJECTED":
    case "NO_TWO_SIDED_MARKET":
      return "LIQUIDITY_REJECTION";
    default:
      return null;
  }
}

/**
 * One cause for one whole chain attempt, fetch and selection together.
 *
 * ORDER IS THE POINT. The fetch is classified FIRST, and a selector reason is
 * consulted only when the fetch actually delivered contracts. A funnel row can
 * carry a stale or default terminal reason alongside a quota refusal; reading
 * the selector first would let `PROVIDER_QUOTA_EXCEEDED` be overwritten by
 * `NO_ELIGIBLE_CONTRACT`, which is precisely the masquerade being prevented.
 */
export function classifyChainAttempt(
  outcome: Parameters<typeof classifyZeroContract>[0],
  opts: {
    referenceKnownOptionable?: boolean | null;
    terminalReason?: ContractTerminalReason | null;
    contractSelected?: boolean;
  } = {},
): ZeroContractClassification & { origin: ZeroContractOrigin } {
  const contractsReturned = outcome.contracts?.length ?? 0;

  if (contractsReturned === 0) {
    const c = classifyZeroContract(outcome, opts);
    return { ...c, origin: zeroContractOrigin(c.cause) };
  }

  if (opts.contractSelected) {
    return {
      cause: "REFERENCE_UNKNOWN", countsAsEvidence: false, wasAvoidable: false,
      origin: "SYMBOL",
      reason: "a contract was selected; this attempt has no zero-contract cause",
    };
  }

  const selector = selectorZeroContractCause(opts.terminalReason ?? null);
  if (selector) {
    return {
      cause: selector, countsAsEvidence: false, wasAvoidable: false,
      origin: "SELECTOR",
      reason: `${contractsReturned} contracts were received and ${opts.terminalReason} rejected every one — a fact about our bands, not about the provider`,
    };
  }

  return {
    cause: "REFERENCE_UNKNOWN", countsAsEvidence: false, wasAvoidable: false,
    origin: "SYMBOL",
    reason: `${contractsReturned} contracts received; terminal reason ${opts.terminalReason ?? "unset"} is not a zero-contract outcome`,
  };
}

/** Per-cause totals, for measuring which share of the 802 is safely eliminable. */
export function summarizeZeroContractCauses(
  classifications: readonly ZeroContractClassification[],
): { total: number; byCause: Record<ZeroContractCause, number>; avoidable: number; eliminableShare: number } {
  const byCause: Record<ZeroContractCause, number> = { ...ZERO_CONTRACT_CAUSE_ZEROES };
  let avoidable = 0;
  for (const c of classifications) {
    byCause[c.cause] += 1;
    if (c.wasAvoidable) avoidable += 1;
  }
  const total = classifications.length;
  return { total, byCause, avoidable, eliminableShare: total > 0 ? +(avoidable / total).toFixed(4) : 0 };
}
