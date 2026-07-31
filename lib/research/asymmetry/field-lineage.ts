/**
 * field-lineage.ts — where each alert field comes from, and what it costs.
 * PURE data + pure helpers. No network, no DB.
 *
 * THE QUESTION THIS SETTLES. An alert that says "Underlying: unavailable" for a
 * value the scanner already held is not a data problem, it is a plumbing
 * problem — and the two have completely different fixes. Guessing which one you
 * have leads to adding a provider call to solve a mapping bug. This table
 * forces the distinction to be stated per field, with the file that proves it.
 *
 * THE PRIORITY ORDER IS THE POINT, and it is enforced by `resolutionPlan()`:
 *
 *   1. reuse the live payload            (free)
 *   2. reuse the already-fetched chain   (free)
 *   3. reuse persisted evidence          (free)
 *   4. reuse local tables                (free)
 *   5. reuse cache                       (free)
 *   6. a bounded provider request        ONLY when materially necessary
 *   7. leave it missing                  rather than multiply calls
 *
 * A FIELD MAY NOT BUY ITS WAY UP THIS LIST BY BEING NICE TO LOOK AT. Anything
 * whose only justification is Discord presentation is capped at step 5 by
 * `presentationOnly`, and resolutionPlan() will never propose a call for it.
 */

export type LineageSource =
  | "LIVE_SCANNER_PAYLOAD"
  | "FETCHED_OPTION_CHAIN"
  | "PERSISTED_EVIDENCE"
  | "LOCAL_TABLE"
  | "CACHE"
  | "PROVIDER_REQUEST"
  | "NOT_OBTAINABLE";

/** Where in the priority order a field can be satisfied. Lower is cheaper. */
export const SOURCE_PRIORITY: Readonly<Record<LineageSource, number>> = Object.freeze({
  LIVE_SCANNER_PAYLOAD: 1,
  FETCHED_OPTION_CHAIN: 2,
  PERSISTED_EVIDENCE: 3,
  LOCAL_TABLE: 4,
  CACHE: 5,
  PROVIDER_REQUEST: 6,
  NOT_OBTAINABLE: 7,
});

export type MissingBehavior =
  /** Omit the line entirely. Never printed as a zero or a dash. */
  | "OMIT_FROM_MESSAGE"
  /** Print the word "unavailable" so the absence is visible. */
  | "REPORT_UNAVAILABLE"
  /** The gate treats absence as "cannot judge", never as "passes". */
  | "GATE_TREATS_AS_UNKNOWN"
  /** Absence blocks the notification outright. */
  | "SUPPRESSES_NOTIFICATION";

export interface FieldLineage {
  field: string;
  /** The true upstream origin of the value. */
  originalSource: LineageSource;
  /** Is it already in hand at decision time, without a new call? */
  alreadyFetched: boolean;
  /** Does it survive into a durable row? */
  persisted: boolean;
  /** Is it fetched and then thrown away before persistence? The plumbing bug. */
  droppedDuringMapping: boolean;
  availableLocally: boolean;
  cached: boolean;
  /** Would satisfying it require a NEW provider request today? */
  additionalProviderCallRequired: boolean;
  /** How stale the value may be before it is not usable. Null = no rule yet. */
  freshnessRuleMs: number | null;
  missingBehavior: MissingBehavior;
  /** True when the only argument for sourcing it is how the message looks. */
  presentationOnly: boolean;
  /** The file that proves the claims above. */
  evidence: string;
}

export const FIELD_LINEAGE: readonly FieldLineage[] = Object.freeze([
  {
    field: "trigger",
    originalSource: "NOT_OBTAINABLE",
    alreadyFetched: false, persisted: false, droppedDuringMapping: false,
    availableLocally: false, cached: false, additionalProviderCallRequired: false,
    freshnessRuleMs: null, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "transition-runner.ts passes `trigger: null` into both decideNotification and notifyPrivateAsymmetry, and asymmetry_cases has no trigger column. No upstream produces a published trigger level for the asymmetry lane — this is a DERIVATION gap, not a provider gap, and no provider call can close it. It is also why timing-classification cannot measure FAILED_BREAKOUT and reports triggerReclaimedThenLost as null.",
  },
  {
    field: "invalidation",
    originalSource: "NOT_OBTAINABLE",
    alreadyFetched: false, persisted: false, droppedDuringMapping: false,
    availableLocally: false, cached: false, additionalProviderCallRequired: false,
    freshnessRuleMs: null, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "Same as trigger: transition-runner.ts passes null and no column exists. private-notify.ts prints 'no invalidation level recorded' rather than inventing one.",
  },
  {
    field: "catalyst",
    originalSource: "PROVIDER_REQUEST",
    alreadyFetched: false, persisted: false, droppedDuringMapping: false,
    availableLocally: true, cached: false, additionalProviderCallRequired: true,
    freshnessRuleMs: 24 * 60 * 60_000, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "fetchNews (lib/polygon-provider.js) wraps /v2/reference/news at ~1 call per ticker. catalyst_records exists locally (475 rows) and should be consulted first. NO_CATALYST is the most common missingEvidence entry in production. Step 4 (local table) before step 6 (request).",
  },
  {
    field: "marketAlignment",
    originalSource: "CACHE",
    alreadyFetched: true, persisted: false, droppedDuringMapping: true,
    availableLocally: true, cached: true, additionalProviderCallRequired: false,
    freshnessRuleMs: 60_000, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "lib/research/context/market-context.ts already computes index context and the scanner already holds SPY/QQQ quotes each tick. The value is never written onto the asymmetry case, so NO_MARKET_ALIGNMENT is a mapping loss, not a missing entitlement. Costs zero additional calls to fix.",
  },
  {
    field: "sectorAlignment",
    originalSource: "PROVIDER_REQUEST",
    alreadyFetched: false, persisted: false, droppedDuringMapping: false,
    availableLocally: false, cached: false, additionalProviderCallRequired: true,
    freshnessRuleMs: 60_000, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "Sector ETF aggregates come from the entitled /v2/aggs, but the repo has NO symbol-to-sector mapping (source-priority.ts). The mapping is the real work; the data is cheap and shared across all symbols in a sector, so one cached ETF quote serves every candidate in it.",
  },
  {
    field: "impliedVolatility",
    originalSource: "FETCHED_OPTION_CHAIN",
    alreadyFetched: true, persisted: false, droppedDuringMapping: true,
    availableLocally: false, cached: true, additionalProviderCallRequired: false,
    freshnessRuleMs: 120_000, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "PROBED 2026-07-31: /v3/snapshot/options returned implied_volatility on 160/250 NVDA contracts. lib/research/options/live-deps.ts maps it, but asymmetry evidence has no column. Free to persist; absent on deep ITM/OTM contracts, which must stay null rather than 0.",
  },
  {
    field: "delta",
    originalSource: "FETCHED_OPTION_CHAIN",
    alreadyFetched: true, persisted: false, droppedDuringMapping: true,
    availableLocally: false, cached: true, additionalProviderCallRequired: false,
    freshnessRuleMs: 120_000, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "Mapped by live-deps.ts from the chain snapshot the scanner already fetched; dropped before the asymmetry case row. Zero additional cost.",
  },
  {
    field: "gamma",
    originalSource: "FETCHED_OPTION_CHAIN",
    alreadyFetched: true, persisted: false, droppedDuringMapping: true,
    availableLocally: false, cached: true, additionalProviderCallRequired: false,
    freshnessRuleMs: 120_000, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "PROBED 2026-07-31: greeks.gamma present on the same 160/250 contracts as IV (ATM NVDA call: 0.1871). live-deps.ts maps only delta, so gamma is dropped at the mapper. Zero additional cost.",
  },
  {
    field: "optionVolume",
    originalSource: "FETCHED_OPTION_CHAIN",
    alreadyFetched: true, persisted: false, droppedDuringMapping: true,
    availableLocally: false, cached: true, additionalProviderCallRequired: false,
    freshnessRuleMs: 120_000, missingBehavior: "GATE_TREATS_AS_UNKNOWN", presentationOnly: false,
    evidence: "PROBED 2026-07-31: day.volume present on 221/250 contracts. transition-runner.ts passes `contractVolume: null` into the gate, so the minContractVolume check (25) is INERT in production today — it can never fire on a null. Fixing this is a mapping change with zero call cost, and it will make the gate strictly stricter.",
  },
  {
    field: "openInterest",
    originalSource: "FETCHED_OPTION_CHAIN",
    alreadyFetched: true, persisted: false, droppedDuringMapping: false,
    availableLocally: false, cached: true, additionalProviderCallRequired: false,
    freshnessRuleMs: 24 * 60 * 60_000, missingBehavior: "GATE_TREATS_AS_UNKNOWN", presentationOnly: false,
    evidence: "PROBED 2026-07-31: open_interest present on 250/250 contracts. Reaches the gate via CaseObservation.openInterest. NOT reconstructible for past sessions — historical cohort rows must leave it null.",
  },
  {
    field: "relativeVolume",
    originalSource: "PROVIDER_REQUEST",
    alreadyFetched: false, persisted: false, droppedDuringMapping: false,
    availableLocally: false, cached: false, additionalProviderCallRequired: true,
    freshnessRuleMs: 60_000, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "Needs a same-time-of-day baseline from /v2/aggs minute bars. Entitled and backfillable, and one baseline per symbol per day serves every candidate on that symbol — so the amortized cost is low even though the first call is real.",
  },
  {
    field: "volumeAcceleration",
    originalSource: "PROVIDER_REQUEST",
    alreadyFetched: false, persisted: false, droppedDuringMapping: false,
    availableLocally: false, cached: false, additionalProviderCallRequired: true,
    freshnessRuleMs: 60_000, missingBehavior: "OMIT_FROM_MESSAGE", presentationOnly: false,
    evidence: "Derived from the same minute bars as relativeVolume — no additional request beyond that one. Production reports NO_VOLUME_ACCELERATION with reason NO_BASELINE, which is the baseline being absent, not the field.",
  },
  {
    field: "bid",
    originalSource: "LIVE_SCANNER_PAYLOAD",
    alreadyFetched: true, persisted: true, droppedDuringMapping: false,
    availableLocally: true, cached: true, additionalProviderCallRequired: false,
    freshnessRuleMs: 120_000, missingBehavior: "SUPPRESSES_NOTIFICATION", presentationOnly: false,
    evidence: "CaseObservation.bid, persisted as asymmetry_cases.early_bid and asymmetry_marks.bid. Marks are the BID by design. Historically reconstructible via /v3/quotes/{OCC}.",
  },
  {
    field: "ask",
    originalSource: "LIVE_SCANNER_PAYLOAD",
    alreadyFetched: true, persisted: true, droppedDuringMapping: false,
    availableLocally: true, cached: true, additionalProviderCallRequired: false,
    freshnessRuleMs: 120_000, missingBehavior: "SUPPRESSES_NOTIFICATION", presentationOnly: false,
    evidence: "CaseObservation.ask, persisted as asymmetry_cases.early_ask. Entry is the ASK by design. decideNotification refuses to send without it (INSUFFICIENT_NOTIFICATION_EVIDENCE_NO_ENTRY_QUOTE).",
  },
  {
    field: "quoteTimestamp",
    originalSource: "LIVE_SCANNER_PAYLOAD",
    alreadyFetched: true, persisted: true, droppedDuringMapping: false,
    availableLocally: true, cached: false, additionalProviderCallRequired: false,
    freshnessRuleMs: 120_000, missingBehavior: "SUPPRESSES_NOTIFICATION", presentationOnly: false,
    evidence: "CaseObservation.quoteAtMs, normalized to milliseconds at the provider boundary by lib/provider-timestamp.js (commit a4a7f31). This is the input to the 120s staleness rule, and it is now persisted per decision in asymmetry_notify_decisions.quote_age_ms — previously it was discarded, which is why the threshold could not be evaluated.",
  },
  {
    field: "underlyingPrice",
    originalSource: "PERSISTED_EVIDENCE",
    alreadyFetched: true, persisted: true, droppedDuringMapping: false,
    availableLocally: true, cached: true, additionalProviderCallRequired: false,
    freshnessRuleMs: 120_000, missingBehavior: "SUPPRESSES_NOTIFICATION", presentationOnly: false,
    evidence: "Read back out of asymmetry_cases.evidence_json by listCasesOnDb (case-store.ts). Was captured all along but never read back, which is why alerts printed 'Underlying: unavailable' for a value already in hand — the archetypal mapping loss this table exists to expose.",
  },
]);

export interface ResolutionStep {
  field: string;
  /** The cheapest source that can satisfy this field today. */
  resolveFrom: LineageSource;
  priority: number;
  /** True when closing the gap costs nothing but a mapping change. */
  freeToFix: boolean;
  /** True when a bounded provider request is genuinely justified. */
  providerCallJustified: boolean;
  note: string;
}

/**
 * The ordered plan. Free mapping fixes come first because they are strictly
 * better than any request: cheaper, immediate, and they improve the data the
 * gate itself sees rather than just the message.
 *
 * `providerCallJustified` is false for presentation-only fields NO MATTER WHAT.
 * That is the rule "do not add provider calls merely to improve Discord
 * appearance", expressed as code instead of as a comment.
 */
export function resolutionPlan(lineage: readonly FieldLineage[] = FIELD_LINEAGE): ResolutionStep[] {
  return lineage
    .map((f): ResolutionStep => {
      const freeToFix = f.droppedDuringMapping && !f.additionalProviderCallRequired;
      const providerCallJustified = f.additionalProviderCallRequired
        && !f.presentationOnly
        && f.originalSource !== "NOT_OBTAINABLE";
      return {
        field: f.field,
        resolveFrom: f.originalSource,
        priority: SOURCE_PRIORITY[f.originalSource],
        freeToFix,
        providerCallJustified,
        note: f.originalSource === "NOT_OBTAINABLE"
          ? "No provider can supply this. It must be derived upstream or stay absent."
          : freeToFix
            ? "Already fetched and then dropped. Fix the mapping; zero additional calls."
            : providerCallJustified
              ? "Needs a bounded request. Cache per symbol per session so the cost amortizes."
              : "Already satisfied from a free source.",
      };
    })
    .sort((a, b) =>
      Number(b.freeToFix) - Number(a.freeToFix)
      || a.priority - b.priority
      || a.field.localeCompare(b.field));
}

/** Fields fetched and then discarded. The zero-cost wins, listed on their own. */
export function freeWins(lineage: readonly FieldLineage[] = FIELD_LINEAGE): string[] {
  return lineage.filter((f) => f.droppedDuringMapping && !f.additionalProviderCallRequired).map((f) => f.field);
}

/** Fields no provider can supply. These need derivation, not budget. */
export function derivationGaps(lineage: readonly FieldLineage[] = FIELD_LINEAGE): string[] {
  return lineage.filter((f) => f.originalSource === "NOT_OBTAINABLE").map((f) => f.field);
}
