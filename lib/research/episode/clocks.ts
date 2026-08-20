/**
 * lib/research/episode/clocks.ts — the canonical FOUR-CLOCK model for one options evaluation.
 *
 * ── Why this module exists ────────────────────────────────────────────────────
 *
 * Production on 2026-08-20 rejected 62 of 738 EpisodeV2 builds as
 * ZONE_A_FUTURE_TIMESTAMP. The measured `quote_timestamp_ms - observed_at_ms`
 * distribution was continuous through zero (min 1ms, p50 311ms, p95 2,059ms,
 * max 3,564ms, nothing beyond 5s). A genuine future-dated exchange print does
 * not look like that. A pipeline that captures its local reference clock BEFORE
 * doing seconds of work does.
 *
 * The live path captures one local instant `n0` at the top of the per-symbol
 * scan and then spends real wall-clock on `getBars()`, feature computation,
 * strategy scoring and `getChain()` before it ever sees a quote. Comparing an
 * exchange event time against that earlier `n0` asks "did the exchange print
 * this quote before I started looking?" — which is not the leakage question.
 * The leakage question is "did this quote exist before I fixed my decision?"
 *
 * Those are different clocks and different instants, so this module keeps FOUR
 * of them and never collapses one into another.
 *
 * ── The four clocks ───────────────────────────────────────────────────────────
 *
 *   observationStartedAtMs   LOCAL. Date.now() when this scanner evaluation began.
 *                            Monitor `n0`, before bars/strategy/chain.
 *
 *   decisionAtMs             LOCAL. The instant disposition was fixed and no later
 *                            market evidence may legitimately enter Zone A.
 *
 *   quoteEventAtMs           PROVIDER/EXCHANGE/SIP. The event time of the selected
 *                            NBBO. A foreign clock. Never rewritten, never clamped.
 *
 *   quoteReceivedAtMs        LOCAL. When the chain response carrying that quote
 *                            completed. Null when unmeasured — never fabricated.
 *
 * ── Rules that must not be relaxed ────────────────────────────────────────────
 *
 * No Math.min / Math.max / clamp is applied to any of the four. A signed
 * difference stays signed: negative is evidence, not an error, and turning it
 * into 0 or null is exactly the move that hid this defect for months.
 *
 * `observationStartedAtMs`, `decisionAtMs` and `quoteReceivedAtMs` share one
 * local monotonic-ish clock and may be differenced meaningfully. `quoteEventAtMs`
 * belongs to a FOREIGN clock; any difference involving it also carries the
 * unknown offset between the two clocks. Those relations are labelled
 * MIXED_CLOCK below and must never be reported as network or transport latency.
 *
 * This module is PURE: no I/O, no provider calls, no writes, no Date.now().
 */

/** The four distinct instants. Any may be null when genuinely unmeasured. */
export interface DecisionClocks {
  /** LOCAL: scanner evaluation start (monitor n0). */
  observationStartedAtMs: number | null;
  /** LOCAL: disposition fixed; nothing later may enter Zone A. */
  decisionAtMs: number | null;
  /** FOREIGN (provider/exchange/SIP): selected NBBO event time. */
  quoteEventAtMs: number | null;
  /** LOCAL: chain/provider response carrying the selected quote completed. */
  quoteReceivedAtMs: number | null;
}

/**
 * Where the provider's quote event falls relative to OUR local decision window.
 *
 * This classification is DIAGNOSTIC ONLY in Phase 2A. It does not decide whether
 * an episode is accepted; the pre-existing Zone-A rule still does that, unchanged,
 * so the two can be compared on the same live traffic.
 */
export type TimestampRelation =
  | "BEFORE_OR_AT_OBSERVATION_START"
  | "BETWEEN_OBSERVATION_AND_DECISION"
  | "AFTER_DECISION"
  | "INSUFFICIENT_TIMESTAMP_EVIDENCE";

export const TIMESTAMP_RELATIONS: readonly TimestampRelation[] = [
  "BEFORE_OR_AT_OBSERVATION_START",
  "BETWEEN_OBSERVATION_AND_DECISION",
  "AFTER_DECISION",
  "INSUFFICIENT_TIMESTAMP_EVIDENCE",
] as const;

/**
 * A clock instant, or null.
 *
 * null/undefined are rejected BEFORE the Number() coercion on purpose:
 * `Number(null)` is 0, which is finite, so a coerce-first version silently turns
 * a missing clock into the Unix epoch — a 56-year-old quote that every signed
 * relation would then report as a real measurement.
 */
function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The ONE canonical signed quote-age calculation: `referenceMs - quoteEventAtMs`.
 *
 * Positive means the quote event precedes the reference instant (the ordinary
 * case: the quote is that many ms old). Negative means the quote event carries a
 * timestamp AFTER the reference instant — which is the entire phenomenon under
 * investigation and therefore must survive to the caller intact.
 *
 * Null is returned ONLY when an input is missing or non-finite. Never because
 * the answer came out negative. There is deliberately no Math.max here.
 */
export function signedQuoteAgeAt(
  referenceMs: number | null | undefined,
  quoteEventAtMs: number | null | undefined,
): number | null {
  const ref = finite(referenceMs);
  const quote = finite(quoteEventAtMs);
  if (ref == null || quote == null) return null;
  return ref - quote;
}

/**
 * Classify the quote event against the local observation/decision window.
 *
 * Requires the quote event AND both local bounds. With any of them missing the
 * honest answer is INSUFFICIENT_TIMESTAMP_EVIDENCE — not a guess, and not a
 * silent fallback to a different reference clock.
 *
 * Boundaries: `<= observationStart` is BEFORE_OR_AT_OBSERVATION_START, and
 * `<= decision` is BETWEEN_OBSERVATION_AND_DECISION, so a quote landing exactly
 * on the decision instant is inside the window, not after it.
 */
export function classifyTimestampRelation(clocks: Partial<DecisionClocks>): TimestampRelation {
  const quote = finite(clocks.quoteEventAtMs);
  const start = finite(clocks.observationStartedAtMs);
  const decision = finite(clocks.decisionAtMs);
  if (quote == null || start == null || decision == null) return "INSUFFICIENT_TIMESTAMP_EVIDENCE";
  // A decision that precedes its own observation start is incoherent evidence,
  // not a usable window. Say so rather than classifying against a broken bound.
  if (decision < start) return "INSUFFICIENT_TIMESTAMP_EVIDENCE";
  if (quote <= start) return "BEFORE_OR_AT_OBSERVATION_START";
  if (quote <= decision) return "BETWEEN_OBSERVATION_AND_DECISION";
  return "AFTER_DECISION";
}

/**
 * Signed relations derived from the four clocks. Every field keeps its sign and
 * is null only when an input clock is absent.
 */
export interface DecisionClockRelations {
  /** quoteEventAtMs - observationStartedAtMs. MIXED_CLOCK. >0 is the 2026-08-20 population. */
  quoteEventAfterObservationStartMs: number | null;
  /** decisionAtMs - quoteEventAtMs. MIXED_CLOCK. The freshness that actually matters. */
  quoteAgeAtDecisionMs: number | null;
  /** observationStartedAtMs - quoteEventAtMs. MIXED_CLOCK. What the legacy path measures. */
  quoteAgeAtObservationStartMs: number | null;
  /**
   * quoteReceivedAtMs - quoteEventAtMs. MIXED_CLOCK.
   *
   * Deliberately NOT called transport or network latency. It spans a foreign
   * exchange clock and our local clock, so it contains the unknown offset
   * between them in addition to any real transport time. It is only usable as a
   * relation, and only when the chain completion instant was genuinely measured.
   */
  quoteEventToChainResponseCompletedMs: number | null;
  /** decisionAtMs - observationStartedAtMs. LOCAL-only, so this one is a true elapsed duration. */
  observationStartToDecisionMs: number | null;
  /** decisionAtMs - quoteReceivedAtMs. LOCAL-only, a true elapsed duration. */
  chainResponseCompletedToDecisionMs: number | null;
}

/** Which relations mix a foreign clock with ours, so no consumer can read them as latency. */
export const MIXED_CLOCK_RELATIONS = [
  "quoteEventAfterObservationStartMs",
  "quoteAgeAtDecisionMs",
  "quoteAgeAtObservationStartMs",
  "quoteEventToChainResponseCompletedMs",
] as const;

/** Relations measured entirely on the local clock, and therefore true elapsed durations. */
export const LOCAL_CLOCK_RELATIONS = [
  "observationStartToDecisionMs",
  "chainResponseCompletedToDecisionMs",
] as const;

export function decisionClockRelations(clocks: Partial<DecisionClocks>): DecisionClockRelations {
  const start = finite(clocks.observationStartedAtMs);
  const decision = finite(clocks.decisionAtMs);
  const quote = finite(clocks.quoteEventAtMs);
  const received = finite(clocks.quoteReceivedAtMs);
  return {
    quoteEventAfterObservationStartMs: signedQuoteAgeAt(quote, start),
    quoteAgeAtDecisionMs: signedQuoteAgeAt(decision, quote),
    quoteAgeAtObservationStartMs: signedQuoteAgeAt(start, quote),
    quoteEventToChainResponseCompletedMs: signedQuoteAgeAt(received, quote),
    observationStartToDecisionMs: start == null || decision == null ? null : decision - start,
    chainResponseCompletedToDecisionMs: received == null || decision == null ? null : decision - received,
  };
}

/** The complete decision-clock evidence block carried on an episode. */
export interface DecisionClockEvidence extends DecisionClocks {
  relations: DecisionClockRelations;
  timestampRelation: TimestampRelation;
  /** Names the clock each field belongs to so no later reader has to infer it. */
  clockDomains: {
    observationStartedAtMs: "LOCAL";
    decisionAtMs: "LOCAL";
    quoteEventAtMs: "PROVIDER_EXCHANGE_SIP";
    quoteReceivedAtMs: "LOCAL";
  };
  mixedClockRelations: readonly string[];
  localClockRelations: readonly string[];
  /** Phase 2A: this evidence is observed, never enforced. */
  authority: "DIAGNOSTIC_ONLY";
}

export function decisionClockEvidence(clocks: Partial<DecisionClocks>): DecisionClockEvidence {
  return {
    observationStartedAtMs: finite(clocks.observationStartedAtMs),
    decisionAtMs: finite(clocks.decisionAtMs),
    quoteEventAtMs: finite(clocks.quoteEventAtMs),
    quoteReceivedAtMs: finite(clocks.quoteReceivedAtMs),
    relations: decisionClockRelations(clocks),
    timestampRelation: classifyTimestampRelation(clocks),
    clockDomains: {
      observationStartedAtMs: "LOCAL",
      decisionAtMs: "LOCAL",
      quoteEventAtMs: "PROVIDER_EXCHANGE_SIP",
      quoteReceivedAtMs: "LOCAL",
    },
    mixedClockRelations: MIXED_CLOCK_RELATIONS,
    localClockRelations: LOCAL_CLOCK_RELATIONS,
    authority: "DIAGNOSTIC_ONLY",
  };
}

/**
 * Fixed, signed, symmetric-ish millisecond buckets.
 *
 * Bounded on purpose: this is process-lifetime health, so it must be a constant
 * number of integers regardless of traffic. One DB row per timestamp event would
 * be an unbounded write on the live scan path, which is precisely what this
 * histogram exists to avoid.
 *
 * `0` gets its own bucket because "exactly equal" is a materially different
 * observation from "1ms apart" when the question is clock alignment.
 */
export const SIGNED_MS_BUCKETS = [
  { key: "<=-5000", min: Number.NEGATIVE_INFINITY, max: -5000 },
  { key: "-4999..-2001", min: -4999, max: -2001 },
  { key: "-2000..-1001", min: -2000, max: -1001 },
  { key: "-1000..-501", min: -1000, max: -501 },
  { key: "-500..-251", min: -500, max: -251 },
  { key: "-250..-101", min: -250, max: -101 },
  { key: "-100..-1", min: -100, max: -1 },
  { key: "0", min: 0, max: 0 },
  { key: "1..100", min: 1, max: 100 },
  { key: "101..250", min: 101, max: 250 },
  { key: "251..500", min: 251, max: 500 },
  { key: "501..1000", min: 501, max: 1000 },
  { key: "1001..2000", min: 1001, max: 2000 },
  { key: "2001..5000", min: 2001, max: 5000 },
  { key: ">5000", min: 5001, max: Number.POSITIVE_INFINITY },
] as const;

export type SignedMsBucketKey = (typeof SIGNED_MS_BUCKETS)[number]["key"];

export interface SignedMsHistogram {
  /** How many finite signed samples were bucketed. */
  samples: number;
  /** How many calls carried no finite value (a missing clock, not a zero). */
  unmeasured: number;
  buckets: Record<string, number>;
}

export function newSignedMsHistogram(): SignedMsHistogram {
  const buckets: Record<string, number> = {};
  for (const b of SIGNED_MS_BUCKETS) buckets[b.key] = 0;
  return { samples: 0, unmeasured: 0, buckets };
}

export function signedMsBucketKey(value: number): SignedMsBucketKey {
  for (const b of SIGNED_MS_BUCKETS) {
    if (value >= b.min && value <= b.max) return b.key;
  }
  // Unreachable: the buckets span [-Inf, +Inf] with no gap. Kept total anyway.
  return value < 0 ? "<=-5000" : ">5000";
}

/**
 * Record one signed sample. A null/non-finite value increments `unmeasured`
 * rather than being coerced to 0 — an absent clock and a zero difference are
 * different facts and the histogram must not merge them.
 */
export function recordSignedMs(hist: SignedMsHistogram, value: number | null | undefined): void {
  const v = finite(value);
  if (v == null) { hist.unmeasured += 1; return; }
  hist.buckets[signedMsBucketKey(v)] += 1;
  hist.samples += 1;
}

/** Snapshot copy, so a health response can never alias mutable counter state. */
export function snapshotSignedMsHistogram(hist: SignedMsHistogram): SignedMsHistogram {
  return { samples: hist.samples, unmeasured: hist.unmeasured, buckets: { ...hist.buckets } };
}

/**
 * The quote-age implementations that still DISAGREE with `signedQuoteAgeAt`.
 *
 * Phase 2A deliberately does not unify them: each one feeds a live gate, and
 * changing any of them would move acceptance in the same deployment that is
 * supposed to prove acceptance did not move. This registry exists so the
 * divergence is a tracked fact on the health surface instead of tribal
 * knowledge, and so the repair pass has an explicit checklist.
 *
 * `referenceClock` is the half that matters most: three of the four measure
 * against an instant that is not the decision, which is the co-primary root
 * cause. `negativeHandling` is the other half: every one of them destroys the
 * sign, so none of them can currently observe the phenomenon at all.
 */
export const LEGACY_QUOTE_AGE_CONSUMERS = [
  {
    consumer: "options_research_observations.quote_age_ms",
    site: "lib/research/options/loop.ts (via quoteFreshness)",
    referenceClock: "OBSERVATION_START",
    negativeHandling: "NULL_AND_INVALID",
    note: "quoteFreshness() reports valid:false and ageMs:null when the quote post-dates the reference, so the row records no age at all rather than a negative one.",
  },
  {
    consumer: "options_live_latency_traces.provider_quote_age_ms",
    site: "lib/research/options/monitor.ts",
    referenceClock: "POST_EVALUATION_RETURN",
    negativeHandling: "CLAMPED_TO_ZERO",
    note: "Measured against strategyEvaluationCompletedAtMs, which is stamped after runOptionsCandidate returns and therefore also contains persistence time. Closest of the three to the decision, still not the decision.",
  },
  {
    consumer: "SetupEpisodeV2 zoneA.option.quoteAgeMs + executableAtT0",
    site: "lib/research/episode/v2.ts",
    referenceClock: "OBSERVATION_START",
    negativeHandling: "CLAMPED_TO_ZERO",
    note: "The clamp makes a quote that post-dates t0 look maximally fresh to the <=60s executability gate. Left in place so acceptance is unchanged.",
  },
  {
    consumer: "callout contract quoteAgeMs (delivery + paper entry)",
    site: "lib/research/options/loop.ts evaluateOptionsCandidate (via quoteFreshness)",
    referenceClock: "OBSERVATION_START",
    negativeHandling: "NULL_AND_INVALID",
    note: "Feeds the freshness gate inside buildRealOptionEntry. A live trading gate: it must not move before the validator repair is proven.",
  },
] as const;

/** The canonical implementation every consumer above should eventually reach. */
export const CANONICAL_QUOTE_AGE = {
  helper: "signedQuoteAgeAt(referenceMs, quoteEventAtMs)",
  referenceClock: "DECISION",
  negativeHandling: "PRESERVED_SIGNED",
  unifiedInPhase2A: false,
} as const;

export function newTimestampRelationCounts(): Record<TimestampRelation, number> {
  return {
    BEFORE_OR_AT_OBSERVATION_START: 0,
    BETWEEN_OBSERVATION_AND_DECISION: 0,
    AFTER_DECISION: 0,
    INSUFFICIENT_TIMESTAMP_EVIDENCE: 0,
  };
}
