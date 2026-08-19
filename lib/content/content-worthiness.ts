/**
 * content-worthiness.ts — NOT EVERY INTERNAL EVENT DESERVES CONTENT.
 *
 * WHAT WENT WRONG
 *
 * The pipeline was `event -> templates -> persist -> Discord`, with the only
 * filters being binary safety gates. It had no opinion about whether an event
 * was WORTH saying. Production on 2026-08-19 is the proof:
 *
 *   - 200 drafts sampled, **62 distinct texts**. 138 were byte-identical repeats.
 *   - `"Adding conviction to $AMZN."` — persisted **22 times**.
 *   - 184 of 200 were `CONVICTION_INCREASED`, the most routine event there is.
 *   - AMZN alone produced **52 drafts in one session**.
 *   - All 200 were `NON_ACTIONABLE_RESEARCH`. Not one carried a verified result.
 *
 * Three independent defects stacked:
 *
 *  1. `emitContentEventForCase` put `nowMs` in the event discriminator, so
 *     `INSERT OR IGNORE` could never collide and every strengthen tick was a
 *     brand-new event.
 *  2. `draftFingerprint` included that event id, so the UNIQUE constraint on
 *     `content_drafts.fingerprint` deduplicated nothing. In the sample,
 *     fingerprint === id for all 200 rows.
 *  3. `eligibleCategories` mapped `THESIS_STRENGTHENED -> CONVICTION_INCREASED`
 *     UNCONDITIONALLY, bypassing even the confidence thresholds.
 *
 * Each was individually reasonable. Together they made a machine that could only
 * ever produce more.
 *
 * WHAT THIS MODULE IS
 *
 * A deterministic worthiness score and a SEMANTIC fingerprint. No model is
 * consulted: deciding whether an event happened, or whether it resembles one
 * from ten minutes ago, is arithmetic, and paying a language model to do
 * arithmetic is how a $20 monthly cap becomes a $200 bill.
 *
 * The score is not a quota. It answers "is this worth a person's attention"
 * one candidate at a time. On a day where nothing is, the correct output is
 * zero drafts, and the design has to be capable of returning zero — a ranked
 * top-N always returns N, which is how "best of today" quietly becomes "today".
 *
 * PURE. No I/O, no clock, no env read at call time.
 */

export type WorthinessDimension =
  | "NOVELTY"
  | "SIGNIFICANCE"
  | "EVIDENCE_QUALITY"
  | "AUDIENCE_VALUE"
  | "TIMELINESS"
  | "NON_DUPLICATION";

/**
 * Default threshold. A candidate at or above this is worth the owner's review
 * queue; below it stays internal.
 *
 * Calibrated against the production sample: routine `CONVICTION_INCREASED` with
 * an unchanged thesis lands near 0.30, a verified closed result near 0.90.
 */
export const DEFAULT_WORTHINESS_THRESHOLD = 0.55;

/**
 * Soft daily objective, used for ranking and for the Discord notice — never as
 * a quota. Nothing here manufactures a candidate to reach it.
 */
export const DAILY_CONTENT_OBJECTIVE = 5;

const WEIGHTS: Record<WorthinessDimension, number> = {
  SIGNIFICANCE: 0.30,
  NOVELTY: 0.22,
  EVIDENCE_QUALITY: 0.20,
  AUDIENCE_VALUE: 0.16,
  TIMELINESS: 0.07,
  NON_DUPLICATION: 0.05,
};

/**
 * How much a category is worth saying at all, before any evidence about this
 * particular instance.
 *
 * `CONVICTION_INCREASED` sits at 0.12 deliberately. It is not junk — it is the
 * system working — but "the thing I already told you about is still the thing
 * I told you about" is an internal state change, and 92% of a day's drafts
 * being that one category is the definition of a feed nobody reads.
 */
const CATEGORY_SIGNIFICANCE: Record<string, number> = {
  CLOSED_WINNER: 1.00,
  CLOSED_LOSER: 0.95,
  WHY_THIS_WORKED: 0.92,
  WHY_THIS_FAILED: 0.92,
  MISSED_OPPORTUNITY: 0.90,
  RESEARCH_FINDING: 0.85,
  RETURN_MILESTONE: 0.80,
  SHADOW_EXPERIMENT_UPDATE: 0.70,
  MARKET_OBSERVATION: 0.65,
  BUILD_INSIGHT: 0.60,
  EDUCATIONAL_BREAKDOWN: 0.55,
  JUST_ENTERED_RADAR: 0.40,
  THESIS_WEAKENED: 0.32,
  HIGH_CONVICTION: 0.30,
  NEW_HIGH: 0.28,
  NEXT_SESSION_WATCH: 0.25,
  CONVICTION_INCREASED: 0.12,
};

/** Categories whose value is that a reader learns something, not that we moved. */
const HIGH_AUDIENCE_VALUE = new Set([
  "CLOSED_WINNER", "CLOSED_LOSER", "WHY_THIS_WORKED", "WHY_THIS_FAILED",
  "MISSED_OPPORTUNITY", "RESEARCH_FINDING", "SHADOW_EXPERIMENT_UPDATE",
  "EDUCATIONAL_BREAKDOWN", "MARKET_OBSERVATION", "BUILD_INSIGHT",
]);

/** Coarse buckets for the owner-facing queue filters. */
export type ContentAngle =
  | "RESULTS" | "RESEARCH" | "MISSED_OPPORTUNITY" | "BUILD_PRODUCT" | "MARKET_OBSERVATION" | "LIFECYCLE";

export function angleFor(category: string): ContentAngle {
  if (["CLOSED_WINNER", "CLOSED_LOSER", "RETURN_MILESTONE", "WHY_THIS_WORKED", "WHY_THIS_FAILED"].includes(category)) {
    return "RESULTS";
  }
  if (category === "MISSED_OPPORTUNITY") return "MISSED_OPPORTUNITY";
  if (["RESEARCH_FINDING", "SHADOW_EXPERIMENT_UPDATE", "EDUCATIONAL_BREAKDOWN"].includes(category)) return "RESEARCH";
  if (category === "BUILD_INSIGHT") return "BUILD_PRODUCT";
  if (category === "MARKET_OBSERVATION") return "MARKET_OBSERVATION";
  return "LIFECYCLE";
}

export interface WorthinessInput {
  category: string;
  symbol?: string | null;
  /** Verified claim packet behind any performance number. */
  claimVerified?: boolean;
  /** An exact OCC contract is on the record for this case. */
  hasExactOcc?: boolean;
  /** A realized, closed outcome rather than an open position's excursion. */
  hasRealizedOutcome?: boolean;
  /** Drafts already persisted for this symbol+category in this session. */
  priorDraftsSameSymbolCategory?: number;
  /** Drafts already persisted for this symbol in this session, any category. */
  priorDraftsSameSymbol?: number;
  /** True when this exact semantic fingerprint is already on record. */
  duplicateFingerprint?: boolean;
  /**
   * True when the underlying state genuinely changed since the last draft for
   * this symbol+category — a new milestone, a new status, a materially different
   * thesis, a new realized outcome.
   */
  materialChange?: boolean;
  /** Age of the source event when the draft is built. */
  eventAgeMs?: number;
  /** |return| or |milestone| in percent, when the category carries one. */
  magnitudePct?: number | null;
}

export interface WorthinessScore {
  score: number;
  dimensions: Record<WorthinessDimension, number>;
  angle: ContentAngle;
  /** Above the threshold AND not vetoed. */
  worthy: boolean;
  /** The single reason it was refused, in plain English. Null when worthy. */
  refusedBecause: string | null;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

export function scoreContentWorthiness(
  input: WorthinessInput,
  threshold: number = DEFAULT_WORTHINESS_THRESHOLD,
): WorthinessScore {
  const category = String(input.category ?? "");
  const angle = angleFor(category);

  const significance = (() => {
    const base = CATEGORY_SIGNIFICANCE[category] ?? 0.2;
    const mag = Math.abs(Number(input.magnitudePct ?? 0));
    // A big realized number earns some significance; a big UNREALIZED one does
    // not, because the honest version of that sentence is "it is up, for now".
    if (!input.hasRealizedOutcome || !Number.isFinite(mag) || mag <= 0) return base;
    return clamp01(base + Math.min(0.15, mag / 1000));
  })();

  const prior = Math.max(0, Math.floor(input.priorDraftsSameSymbolCategory ?? 0));
  const priorAny = Math.max(0, Math.floor(input.priorDraftsSameSymbol ?? 0));
  // Diminishing returns on repetition, and the symbol's own share of the day
  // counts too: the 52nd AMZN draft is uninteresting even under a fresh category.
  const novelty = clamp01((1 / (1 + prior)) * (1 / (1 + priorAny / 4)));

  const evidenceQuality = input.claimVerified
    ? 1
    : input.hasRealizedOutcome
      ? 0.7
      : input.hasExactOcc
        ? 0.5
        : 0.25;

  const audienceValue = HIGH_AUDIENCE_VALUE.has(category) ? 0.9 : 0.35;

  const ageMs = Math.max(0, Number(input.eventAgeMs ?? 0));
  const timeliness = clamp01(1 - ageMs / (6 * 60 * 60 * 1000));

  const nonDuplication = input.duplicateFingerprint ? 0 : 1;

  const dimensions: Record<WorthinessDimension, number> = {
    SIGNIFICANCE: significance,
    NOVELTY: novelty,
    EVIDENCE_QUALITY: evidenceQuality,
    AUDIENCE_VALUE: audienceValue,
    TIMELINESS: timeliness,
    NON_DUPLICATION: nonDuplication,
  };

  let score = 0;
  for (const [dim, w] of Object.entries(WEIGHTS)) {
    score += w * dimensions[dim as WorthinessDimension];
  }
  score = clamp01(score);

  // ── Hard vetoes ───────────────────────────────────────────────────────────
  // A veto is not a low score. These are conditions under which the draft must
  // not exist at all, and a weighted average can always be dragged back over a
  // threshold by an unrelated dimension.
  let refusedBecause: string | null = null;
  if (input.duplicateFingerprint) {
    refusedBecause = "An identical draft already exists for this symbol, event and evidence state.";
  } else if (input.materialChange === false) {
    refusedBecause = "Nothing has materially changed since the last draft about this.";
  } else if (score < threshold) {
    refusedBecause = "Routine internal event — below the bar for something worth posting.";
  }

  return { score, dimensions, angle, worthy: refusedBecause == null, refusedBecause };
}

// ---------------------------------------------------------------------------
// Semantic fingerprint
// ---------------------------------------------------------------------------

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Collapse prose to its meaning so trivial rewording is not "new". */
export function thesisDigest(parts: Array<string | null | undefined>): string {
  const joined = parts
    .map((p) => String(p ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ");
  return joined ? djb2(joined) : "none";
}

export interface SemanticFingerprintInput {
  symbol: string;
  category: string;
  optionType?: string | null;
  /** Trading session, so a genuinely new day may say the thing again. */
  sessionDate: string;
  /** Digest of the thesis/evidence the draft is built from. */
  thesisDigest: string;
  /** Milestone or status that makes this instance distinct, when one exists. */
  milestone?: string | number | null;
  /** Evidence state, so an unverified draft and its verified successor differ. */
  evidenceState?: string | null;
}

/**
 * The identity a draft should have had all along.
 *
 * Deliberately does NOT include the content-event id, the draft id, the
 * template variant or any timestamp. Every one of those is unique per
 * generation, which is precisely why the old `draftFingerprint` — keyed on
 * `caseId|contentEventId|eventType|milestone|templateFamily|platform` — was
 * idempotency for retries dressed up as deduplication. It could only ever
 * collide with a literal re-run of the same generation.
 *
 * What IS included is what a reader would use to say "you already posted this":
 * the symbol, the side, what kind of event it was, what the thesis said, what
 * evidence stood behind it, and which session it belongs to.
 */
export function semanticContentFingerprint(input: SemanticFingerprintInput): string {
  const key = [
    String(input.symbol ?? "").toUpperCase(),
    String(input.category ?? ""),
    String(input.optionType ?? "").toUpperCase(),
    String(input.sessionDate ?? ""),
    String(input.thesisDigest ?? "none"),
    input.milestone == null ? "none" : String(input.milestone),
    String(input.evidenceState ?? "none"),
  ].join("|");
  return `cf_${djb2(key)}`;
}

/**
 * Collapse exact semantic duplicates inside one batch, keeping the highest
 * scorer.
 *
 * Production shipped four drafts for a single AMZN event at the identical
 * millisecond, and three for every conviction bump, because the bundle builder
 * emitted every renderable template and persisted all of them. Within a batch,
 * one idea is one candidate.
 */
export function collapseBatchDuplicates<T extends { fingerprint: string; score: number }>(
  candidates: readonly T[],
): T[] {
  const best = new Map<string, T>();
  for (const c of candidates) {
    const prev = best.get(c.fingerprint);
    if (!prev || c.score > prev.score) best.set(c.fingerprint, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint));
}
