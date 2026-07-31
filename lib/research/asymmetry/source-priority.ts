/**
 * High-Asymmetry Radar — missing-data source priority. PURE.
 *
 * Ranks what to source next. The ranking is built ONLY from things that are
 * actually known:
 *
 *   - how many candidates in a measured replay are affected (measured),
 *   - whether the existing Polygon/Massive integration already supplies it
 *     (verified against the repo's own provider code, cited per field),
 *   - implementation effort and ongoing API cost (engineering judgement),
 *   - whether it can be backfilled onto candidates already captured.
 *
 * What is deliberately NOT in the ranking is predictive power. No field has
 * been measured against an outsized cohort, because no outsized cohort exists
 * yet. Every field therefore carries `discriminationEvidence:
 * "UNMEASURED_HYPOTHESIS"`, and `rankMissingSources` refuses to order by it.
 * Sorting is by cost-to-obtain and reach, never by assumed importance.
 */
import type { DataAvailabilityAudit } from "./coverage-audit.ts";

export type ProviderSupport =
  /** Already fetched by an existing call; only persistence is missing. */
  | "ALREADY_FETCHED_NOT_PERSISTED"
  /** Obtainable from an endpoint the integration already uses and is entitled to. */
  | "AVAILABLE_ENTITLED"
  /** Provider offers it, but the integration is not built or not entitled. */
  | "AVAILABLE_NOT_INTEGRATED"
  /** Not obtainable from the current provider at all. */
  | "NOT_AVAILABLE";

export type Effort = "LOW" | "MEDIUM" | "HIGH";
export type ApiCost = "NONE" | "LOW" | "MEDIUM" | "HIGH";
/** Can the field be added to candidates ALREADY captured, or forward only? */
export type Backfill = "BACKFILLABLE" | "FORWARD_ONLY";

export interface MissingSourceProfile {
  field: string;
  /** Why the radar models it at all. Not a claim that it predicts anything. */
  rationale: string;
  providerSupport: ProviderSupport;
  /** The repo evidence behind `providerSupport`. */
  providerEvidence: string;
  effort: Effort;
  ongoingApiCost: ApiCost;
  backfill: Backfill;
  /** Always unmeasured in this phase. There is no outsized cohort to test on. */
  discriminationEvidence: "UNMEASURED_HYPOTHESIS";
}

/**
 * Static profiles. Provider claims are cited to the repo file that proves them
 * so this table can be re-verified rather than trusted.
 */
export const MISSING_SOURCE_PROFILES: MissingSourceProfile[] = [
  {
    field: "outcomeMarksForNonAlertedCandidates",
    rationale: "Outcome marks exist only for contracts that became paper trades, so the graded population is exactly the population already alerted on. Without marks for candidates that were never alerted, an OUTSIZED cohort cannot contain anything the system did not already act on, and the ordinary-versus-outsized comparison is structurally impossible.",
    providerSupport: "AVAILABLE_ENTITLED",
    providerEvidence: "options_paper_marks is keyed by trade_id and written only for paper trades (lib/db.ts). Forward marking needs the present-time /v3/snapshot/options call already implemented in lib/polygon-provider.js fetchOptionChain.",
    effort: "MEDIUM",
    ongoingApiCost: "MEDIUM",
    backfill: "FORWARD_ONLY",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "impliedVolatility",
    rationale: "Distinguishes a premium that is cheap for the expected move from one already priced for it.",
    providerSupport: "ALREADY_FETCHED_NOT_PERSISTED",
    providerEvidence: "fetchOptionChain records a `greeks` data sample and lib/research/options/live-deps.ts already maps `iv: c.iv ?? c.implied_volatility`. The value is in hand at scan time; options_research_observations simply has no column for it.",
    effort: "LOW",
    ongoingApiCost: "NONE",
    backfill: "FORWARD_ONLY",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "gamma",
    rationale: "Rate of delta change; part of why some contracts move violently on a small underlying move.",
    providerSupport: "AVAILABLE_NOT_INTEGRATED",
    providerEvidence: "/v3/snapshot/options returns a greeks block, but lib/research/options/live-deps.ts maps only delta today, so gamma is dropped before persistence.",
    effort: "LOW",
    ongoingApiCost: "NONE",
    backfill: "FORWARD_ONLY",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "relativeStockVolume",
    rationale: "Whether unusual participation is present versus the same time of day, rather than raw volume.",
    providerSupport: "AVAILABLE_ENTITLED",
    providerEvidence: "Historical stock OHLCV via /v2/aggs is entitled and integrated (lib/research/replay-provider.ts reports stock replay AVAILABLE), so a same-time-of-day baseline is computable and cacheable per symbol per day.",
    effort: "MEDIUM",
    ongoingApiCost: "LOW",
    backfill: "BACKFILLABLE",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "volumeAcceleration",
    rationale: "Whether participation is increasing at detection rather than already elevated and flat.",
    providerSupport: "AVAILABLE_ENTITLED",
    providerEvidence: "Derived from the same /v2/aggs minute bars as relativeStockVolume; no additional entitlement.",
    effort: "MEDIUM",
    ongoingApiCost: "LOW",
    backfill: "BACKFILLABLE",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "underlyingMovePctBeforeDetection",
    rationale: "How much of the underlying move had already happened when the candidate was detected.",
    providerSupport: "AVAILABLE_ENTITLED",
    providerEvidence: "Computable from /v2/aggs minute bars already entitled; the persisted underlying_price alone gives one point, not a window.",
    effort: "LOW",
    ongoingApiCost: "LOW",
    backfill: "BACKFILLABLE",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "relativeStrengthVsSpyPct",
    rationale: "Whether the symbol is moving independently of the index rather than with it.",
    providerSupport: "AVAILABLE_ENTITLED",
    providerEvidence: "SPY/QQQ aggregates come from the same entitled /v2/aggs endpoint; lib/market-context.ts already reads index context.",
    effort: "MEDIUM",
    ongoingApiCost: "LOW",
    backfill: "BACKFILLABLE",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "sectorAlignment",
    rationale: "Whether the sector confirms or contradicts the move.",
    providerSupport: "AVAILABLE_NOT_INTEGRATED",
    providerEvidence: "Sector ETF aggregates are obtainable from /v2/aggs, but no symbol-to-sector mapping exists in the repo, so the mapping is the real work.",
    effort: "MEDIUM",
    ongoingApiCost: "LOW",
    backfill: "BACKFILLABLE",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "catalystType",
    rationale: "Whether a sourced, timestamped event explains the move.",
    providerSupport: "AVAILABLE_ENTITLED",
    providerEvidence: "lib/polygon-provider.js fetchNews wraps /v2/reference/news (Benzinga-sourced, same key) and is already used for catalyst classification, at roughly one call per ticker lookup.",
    effort: "MEDIUM",
    ongoingApiCost: "MEDIUM",
    backfill: "BACKFILLABLE",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "historicalOptionQuotes",
    rationale: "Would allow past candidates to be graded retroactively instead of waiting for forward capture.",
    // CORRECTED 2026-07-31. This row previously said NOT_AVAILABLE, citing
    // replay-provider.ts. That citation conflated "not integrated" with "not
    // entitled". A direct probe of the live key proved the plan DOES serve
    // historical exact-OCC NBBO — see historical/capability-matrix.ts. The
    // wrong entry is why no historical winner cohort was ever attempted.
    providerSupport: "AVAILABLE_ENTITLED",
    providerEvidence: "PROBED 2026-07-31: GET /v3/quotes/{OCC} returned 200 with bid_price, ask_price, bid_size, ask_size and nanosecond sip_timestamp for expired NVDA contracts back to 2023-07-31. Wrapped by lib/research/asymmetry/historical/massive-historical.ts; row recorded in historical/capability-matrix.ts and re-checkable via scripts/massive-capability-probe.mjs.",
    effort: "MEDIUM",
    ongoingApiCost: "HIGH",
    backfill: "BACKFILLABLE",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
  {
    field: "historicalOpenInterest",
    rationale: "Separates a contract that was already crowded at detection from one that was discovered.",
    // Deliberately kept NOT_AVAILABLE: the probe found OI only on the
    // present-time snapshot. There is no historical OI series on this plan, so
    // cohort rows for past sessions must leave it missing rather than borrow
    // today's value for a past date.
    providerSupport: "NOT_AVAILABLE",
    providerEvidence: "PROBED 2026-07-31: open_interest appears on /v3/snapshot/options (250/250 contracts) but no endpoint returned an OI series for a past session. Recorded as a hard gap in historical/capability-matrix.ts.",
    effort: "HIGH",
    ongoingApiCost: "NONE",
    backfill: "FORWARD_ONLY",
    discriminationEvidence: "UNMEASURED_HYPOTHESIS",
  },
];

export interface RankedMissingSource extends MissingSourceProfile {
  /** Candidates in the measured replay missing this field. Null when unmeasured. */
  candidatesAffected: number | null;
  /** Lower is cheaper to obtain. Ordering key — NOT an importance score. */
  acquisitionRank: number;
  notes: string[];
}

const SUPPORT_WEIGHT: Record<ProviderSupport, number> = {
  ALREADY_FETCHED_NOT_PERSISTED: 0,
  AVAILABLE_ENTITLED: 1,
  AVAILABLE_NOT_INTEGRATED: 2,
  NOT_AVAILABLE: 4,
};
const EFFORT_WEIGHT: Record<Effort, number> = { LOW: 0, MEDIUM: 1, HIGH: 3 };
const COST_WEIGHT: Record<ApiCost, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
const BACKFILL_WEIGHT: Record<Backfill, number> = { BACKFILLABLE: 0, FORWARD_ONLY: 1 };

/**
 * Orders missing sources by cost to obtain and reach — never by assumed
 * predictive power, which is unmeasured for every field.
 *
 * `coverage` is optional; when supplied, the measured per-field missing counts
 * from a real replay are attached. Without it `candidatesAffected` stays null
 * rather than defaulting to zero.
 */
export function rankMissingSources(
  coverage?: DataAvailabilityAudit | null,
  missingByField?: Record<string, { count: number }> | null,
): { advisoryOnly: true; productionBehaviorChanged: false; measured: boolean; sources: RankedMissingSource[]; notes: string[] } {
  const measured = Boolean(coverage && coverage.distinctCandidateDetections > 0);

  const sources = MISSING_SOURCE_PROFILES
    .map((profile) => {
      const affected = missingByField?.[profile.field]?.count;
      return {
        ...profile,
        candidatesAffected: measured && affected != null ? affected : null,
        acquisitionRank:
          SUPPORT_WEIGHT[profile.providerSupport]
          + EFFORT_WEIGHT[profile.effort]
          + COST_WEIGHT[profile.ongoingApiCost]
          + BACKFILL_WEIGHT[profile.backfill],
        notes: [],
      };
    })
    .sort((a, b) => a.acquisitionRank - b.acquisitionRank || a.field.localeCompare(b.field));

  return {
    advisoryOnly: true,
    productionBehaviorChanged: false,
    measured,
    sources,
    notes: [
      "Ordered by cost to obtain and reach: provider support, implementation effort, ongoing API cost, and whether it can be backfilled.",
      "NOT ordered by predictive power. No field has been measured against an outsized cohort because no outsized cohort exists yet.",
      "Every field carries discriminationEvidence UNMEASURED_HYPOTHESIS. A rationale explains why the field is modelled, not that it works.",
      measured
        ? "candidatesAffected comes from a real replay of persisted evidence."
        : "candidatesAffected is null because no candidate has been measured; it is not zero.",
      "Provider claims cite the repo file that proves them so the table can be re-verified rather than trusted.",
    ],
  };
}
