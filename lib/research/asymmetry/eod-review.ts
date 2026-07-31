/**
 * eod-review.ts — the deterministic end-of-day Quant review, and the ONLY
 * place AI is allowed anywhere near the radar.
 *
 *   runAsymmetryEodReview()
 *     -> listCasesOnDb / transitions / marks / listOutcomesOnDb   [read all four]
 *     -> buildDeterministicReview()                               [pure]
 *     -> persist review                                           [write]
 *     -> explainReviewWithAi()                                    [optional]
 *     -> persist ai_summary                                       [write]
 *
 * ORDER MATTERS AND IS ENFORCED: the deterministic review is computed and
 * PERSISTED before AI is invoked. If AI is disabled, fails, times out, or
 * returns nonsense, the review still exists and is unchanged. AI can only ever
 * append prose to a row that is already final.
 *
 * AI cannot change a threshold, a gate, a flag, a state, or a send. It receives
 * measured aggregates and returns text. Nothing reads that text back into a
 * decision, and a test asserts the module exposes no mutation path.
 */
import { ensureAsymmetrySchema, listCasesOnDb } from "./case-store.ts";
import { listOutcomesOnDb } from "./mark-runner.ts";
import type { AsymmetryResearchState } from "./states.ts";
import { PAPER_ENABLED_ENV, PAPER_RULES_VERSION } from "./paper/lane.ts";
import { buildQuantReport, type QuantReport } from "./paper/quant.ts";
import { milestoneDistribution } from "./paper/management.ts";
import {
  listPaperPositionsOnDb, listPaperSkipsOnDb, listPaperMarkRejectionsOnDb,
  persistQuantReportOnDb, recordReportDeliveryOnDb, readReportDeliveryOnDb, type PaperPositionRecord,
} from "./paper/store.ts";

export const EOD_ENABLED_ENV = "HIGH_ASYMMETRY_CAPTURE_ENABLED";
/** Minimum cohort before any rate is presented without a warning. */
export const MIN_SAMPLE = 10;

type ReviewDb = Parameters<typeof listCasesOnDb>[0];

export interface AsymmetryEodReview {
  sessionDate: string;
  builtAtMs: number;
  candidatesSurfaced: number;
  stateCounts: Record<string, number>;
  transitions: number;
  invalidations: number;
  liquidityFailures: number;
  premiumChases: number;
  /** Outcome cohort. Rates are null when the cohort is empty — never 0%. */
  graded: number;
  winners: number;
  losers: number;
  hit25: number; hit50: number; hit100: number; hit200: number; hit500: number;
  hitRate25Pct: number | null;
  medianLeadMs: number | null;
  medianPremiumAvoidedPct: number | null;
  normalScannerMisses: number;
  laterNormalAlerts: number;
  missingEvidenceCoverage: Array<{ reason: string; count: number }>;
  setupFamilyResults: Array<{ family: string; n: number }>;
  timeOfDayResults: Array<{ bucket: string; n: number }>;
  minimumSampleWarning: string | null;
  /** The daily paper-trading report. Null only when the lane never ran. */
  paper: AsymmetryPaperReport | null;
  advisoryOnly: true;
  productionBehaviorChanged: false;
}

/**
 * The daily paper-trading report. Every field is measured from persisted rows;
 * nothing here is estimated, projected, or produced by a model.
 */
export interface AsymmetryPaperReport {
  enabled: boolean;
  rulesVersion: string;
  casesCaptured: number;
  tradesOpened: number;
  tradesSkipped: number;
  skipReasons: Array<{ reason: string; count: number }>;
  openPositions: number;
  closedPositions: number;
  wins: number;
  losses: number;
  /** Positions with no verified exit. NOT losses and never counted as zero. */
  unverifiedOutcomes: number;
  totalSimulatedPnlUsd: number | null;
  normalizedOneContractPnlUsd: number | null;
  medianMfePct: number | null;
  medianMaePct: number | null;
  milestoneDistribution: Record<string, number>;
  largestWinner: { symbol: string; optionSymbol: string; returnPct: number } | null;
  largestLoss: { symbol: string; optionSymbol: string; returnPct: number } | null;
  bestMissedOpportunity: QuantReport["bestMissedOpportunity"];
  normalScannerComparison: {
    positionsAlsoAlerted: number;
    positionsNeverAlerted: number;
    medianLeadMs: number | null;
    medianPremiumAvoidedPct: number | null;
  };
  quoteAndProviderErrors: Array<{ reason: string; count: number }>;
  minimumSampleWarnings: string[];
  quant: QuantReport | null;
  /** Delivery is reported, never assumed. BLOCKED_CONFIG is a real outcome. */
  deliveryStatus: "PENDING" | "BLOCKED_CONFIG" | "SENT" | "FAILED";
  aiInvolvedInAnyDecision: false;
}

/** The paper-lane inputs the review needs. Absent = the lane never ran. */
export interface PaperReviewInput {
  enabled: boolean;
  positions: PaperPositionRecord[];
  skips: Array<{ reason: string; count: number }>;
  markRejections: Array<{ reason: string; count: number }>;
  deliveryStatus?: AsymmetryPaperReport["deliveryStatus"];
}

/** Pure aggregation. Deterministic and AI-free. */
export function buildDeterministicReview(input: {
  sessionDate: string;
  nowMs: number;
  cases: ReturnType<typeof listCasesOnDb>;
  transitions: Array<{ toState: string }>;
  outcomes: ReturnType<typeof listOutcomesOnDb>;
  paper?: PaperReviewInput;
}): AsymmetryEodReview {
  const { cases, transitions, outcomes } = input;
  const stateCounts: Record<string, number> = {};
  for (const c of cases) stateCounts[c.state] = (stateCounts[c.state] ?? 0) + 1;

  const graded = outcomes.filter((o) => o.marksUsed > 0);
  const winners = graded.filter((o) => (o.finalReturnPct ?? 0) > 0).length;
  const losers = graded.filter((o) => (o.finalReturnPct ?? 0) < 0).length;
  const count = (k: keyof typeof graded[number]) => graded.filter((o) => o[k] === true).length;

  const leads = cases.map((c) => c.leadMs).filter((v): v is number => v != null);
  const avoided = cases.map((c) => c.premiumAvoidedPct).filter((v): v is number => v != null);

  const missing = new Map<string, number>();
  for (const c of cases) for (const r of c.missingEvidence) missing.set(r, (missing.get(r) ?? 0) + 1);

  const byBucket = new Map<string, number>();
  for (const c of cases) {
    const b = bucketFor(c.firstDetectedAtMs);
    byBucket.set(b, (byBucket.get(b) ?? 0) + 1);
  }

  return {
    sessionDate: input.sessionDate,
    builtAtMs: input.nowMs,
    candidatesSurfaced: cases.length,
    stateCounts,
    transitions: transitions.length,
    invalidations: transitions.filter((t) => t.toState === "INVALIDATED").length,
    liquidityFailures: transitions.filter((t) => t.toState === "LIQUIDITY_FAILURE").length,
    premiumChases: transitions.filter((t) => t.toState === "PREMIUM_CHASE").length,
    graded: graded.length,
    winners,
    losers,
    hit25: count("hit25"), hit50: count("hit50"), hit100: count("hit100"),
    hit200: count("hit200"), hit500: count("hit500"),
    // An empty cohort has an UNKNOWN rate, not a zero rate.
    hitRate25Pct: graded.length ? round1((count("hit25") / graded.length) * 100) : null,
    medianLeadMs: median(leads),
    medianPremiumAvoidedPct: median(avoided),
    normalScannerMisses: cases.filter((c) => c.leadMs == null).length,
    laterNormalAlerts: cases.filter((c) => c.leadMs != null && c.leadMs > 0).length,
    missingEvidenceCoverage: [...missing.entries()].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
    setupFamilyResults: [],
    timeOfDayResults: [...byBucket.entries()].map(([bucket, n]) => ({ bucket, n })).sort((a, b) => a.bucket.localeCompare(b.bucket)),
    minimumSampleWarning: graded.length < MIN_SAMPLE
      ? `Only ${graded.length} graded outcome(s); below the ${MIN_SAMPLE}-sample minimum. No rate here supports a conclusion.`
      : null,
    paper: input.paper ? buildPaperReport(input.sessionDate, input.nowMs, cases, input.paper) : null,
    advisoryOnly: true,
    productionBehaviorChanged: false,
  };
}

/**
 * The daily paper report. Pure: every number is derived from the rows handed
 * in. An empty lane yields nulls and zero COUNTS — a count of zero trades is a
 * fact, whereas a rate over zero trades is not, so rates stay null.
 */
export function buildPaperReport(
  sessionDate: string,
  nowMs: number,
  cases: ReturnType<typeof listCasesOnDb>,
  paper: PaperReviewInput,
): AsymmetryPaperReport {
  const positions = paper.positions;
  const current = positions.filter((p) => p.rulesVersion === PAPER_RULES_VERSION);
  const graded = current.filter((p) => p.outcomeState === "VERIFIED" && p.finalReturnPct != null);

  const quant = buildQuantReport({
    sessionDate, nowMs,
    positions,
    skips: paper.skips.map((s) => ({ reason: s.reason, count: s.count, lastSeenAtMs: null })),
    cases: cases.map((c) => ({
      fingerprint: c.fingerprint, symbol: c.symbol, state: c.state,
      leadMs: c.leadMs, premiumAvoidedPct: c.premiumAvoidedPct, missingEvidence: c.missingEvidence,
    })),
  });

  const byReturn = graded.slice().sort((a, b) => (b.finalReturnPct as number) - (a.finalReturnPct as number));
  const best = byReturn[0];
  const worst = byReturn[byReturn.length - 1];
  const pnlSized = graded.map((p) => p.pnlSizedUsd).filter((v): v is number => v != null);
  const pnlOne = graded.map((p) => p.pnlOneContractUsd).filter((v): v is number => v != null);
  const leads = cases.map((c) => c.leadMs).filter((v): v is number => v != null);
  const avoided = cases.map((c) => c.premiumAvoidedPct).filter((v): v is number => v != null);

  return {
    enabled: paper.enabled,
    rulesVersion: PAPER_RULES_VERSION,
    casesCaptured: cases.length,
    tradesOpened: current.length,
    tradesSkipped: paper.skips.reduce((a, s) => a + s.count, 0),
    skipReasons: paper.skips,
    openPositions: current.filter((p) => p.positionState === "OPEN").length,
    closedPositions: current.filter((p) => p.positionState !== "OPEN").length,
    wins: graded.filter((p) => (p.finalReturnPct as number) > 0).length,
    losses: graded.filter((p) => (p.finalReturnPct as number) < 0).length,
    unverifiedOutcomes: current.filter((p) => p.outcomeState !== "VERIFIED").length,
    totalSimulatedPnlUsd: pnlSized.length ? round2(pnlSized.reduce((a, b) => a + b, 0)) : null,
    normalizedOneContractPnlUsd: pnlOne.length ? round2(pnlOne.reduce((a, b) => a + b, 0)) : null,
    // median2, not median: the shared helper rounds to a whole number, which is
    // fine for milliseconds and wrong for a percentage return.
    medianMfePct: median2(graded.map((p) => p.mfePct).filter((v): v is number => v != null)),
    medianMaePct: median2(graded.map((p) => p.maePct).filter((v): v is number => v != null)),
    milestoneDistribution: milestoneDistribution(current.map((p) => p.mfePct)),
    largestWinner: best && (best.finalReturnPct as number) > 0
      ? { symbol: best.symbol, optionSymbol: best.optionSymbol, returnPct: best.finalReturnPct as number }
      : null,
    largestLoss: worst && (worst.finalReturnPct as number) < 0
      ? { symbol: worst.symbol, optionSymbol: worst.optionSymbol, returnPct: worst.finalReturnPct as number }
      : null,
    bestMissedOpportunity: quant.bestMissedOpportunity,
    normalScannerComparison: {
      positionsAlsoAlerted: current.filter((p) => p.alertId != null).length,
      positionsNeverAlerted: current.filter((p) => p.alertId == null).length,
      medianLeadMs: median(leads),
      medianPremiumAvoidedPct: median2(avoided),
    },
    quoteAndProviderErrors: paper.markRejections,
    minimumSampleWarnings: quant.cohorts
      .map((c) => (c.minimumSampleWarning ? `${c.cohort}: ${c.minimumSampleWarning}` : null))
      .filter((v): v is string => v != null),
    quant,
    deliveryStatus: paper.deliveryStatus ?? "PENDING",
    aiInvolvedInAnyDecision: false,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
/** Median preserving two decimals. For percentages, where whole-number rounding lies. */
function median2(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

function bucketFor(ms: number): string {
  const h = new Date(ms).getUTCHours();
  if (h < 14) return "premarket";
  if (h < 15) return "open";
  if (h < 18) return "midday";
  if (h < 20) return "close";
  return "afterhours";
}
const round1 = (n: number) => Math.round(n * 10) / 10;
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface EodRunResult {
  ran: boolean;
  reason: string | null;
  sessionDate: string;
  review: AsymmetryEodReview | null;
  persisted: boolean;
  /** True when the deterministic Quant report was stored. Independent of AI. */
  quantPersisted: boolean;
  aiStatus: "SKIPPED" | "OK" | "FAILED" | "DISABLED" | "AI_BUDGET_BLOCKED" | "CACHED";
  aiReason: string | null;
  /** Outcome of the daily paper-report delivery. Never affects persistence. */
  paperDelivery: { status: string; reason: string | null } | null;
  errors: string[];
}

/**
 * The advisory result. A plain string is still accepted so an injected stub
 * stays trivial, but the real implementation reports its budget status too —
 * "we chose not to spend" and "it broke" must not look the same.
 */
export type AdvisoryResult = string | {
  status: "OK" | "FAILED" | "DISABLED" | "AI_BUDGET_BLOCKED" | "CACHED";
  summary: string | null;
  reason?: string | null;
};

export interface EodDeps {
  nowMs: number;
  sessionDate: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Injected AI. ADVISORY ONLY — its return value is stored as prose and is
   * never read back into any decision. It runs after everything deterministic
   * has already been persisted, so it cannot prevent, delay, or alter a
   * measured result.
   */
  explain?: (review: AsymmetryEodReview) => Promise<AdvisoryResult>;
  /**
   * Injected delivery for the daily paper report. Runs AFTER persistence and
   * cannot affect it: a missing webhook, a refused send, or an outage produces
   * a recorded status and nothing more.
   */
  deliverPaperReport?: (report: AsymmetryPaperReport) => Promise<{ status: string; reason: string | null }>;
}

/**
 * Build, persist, then optionally explain. Never throws.
 * The deterministic review is committed BEFORE AI runs.
 */
export async function runAsymmetryEodReview(db: ReviewDb, deps: EodDeps): Promise<EodRunResult> {
  const out: EodRunResult = {
    ran: false, reason: null, sessionDate: deps.sessionDate, review: null,
    persisted: false, quantPersisted: false, aiStatus: "SKIPPED", aiReason: null,
    paperDelivery: null, errors: [],
  };
  try {
    const env = deps.env ?? process.env;
    if (env[EOD_ENABLED_ENV] !== "1") {
      out.reason = `${EOD_ENABLED_ENV} is not set`;
      return out;
    }
    out.ran = true;

    const cases = listCasesOnDb(db, deps.sessionDate, 1000);
    const transitions = readTransitions(db, deps.sessionDate);
    const outcomes = listOutcomesOnDb(db, deps.sessionDate);
    const review = buildDeterministicReview({
      sessionDate: deps.sessionDate, nowMs: deps.nowMs, cases, transitions, outcomes,
      paper: {
        enabled: env[PAPER_ENABLED_ENV] === "1",
        positions: listPaperPositionsOnDb(db as any, deps.sessionDate, 1000),
        skips: listPaperSkipsOnDb(db as any, deps.sessionDate),
        markRejections: listPaperMarkRejectionsOnDb(db as any, deps.sessionDate),
        deliveryStatus: "PENDING",
      },
    });
    out.review = review;

    // The Quant report is stored SEPARATELY and keyed by rules version, so a
    // later rule change cannot overwrite or silently re-label the results this
    // version produced. It is persisted before AI for the same reason the
    // review is: nothing optional may stand between a measurement and its row.
    if (review.paper?.quant) {
      out.quantPersisted = persistQuantReportOnDb(db as any, {
        sessionDate: deps.sessionDate,
        rulesVersion: review.paper.quant.rulesVersion,
        builtAtMs: deps.nowMs,
        reportJson: JSON.stringify(review.paper.quant),
      });
      if (!out.quantPersisted) out.errors.push("quant: report could not be persisted");
    }

    // PERSIST FIRST. AI cannot prevent the measured review from existing.
    // The schema must be ensured here: on a session with zero captured cases
    // nothing else has created the tables, and a missing table would otherwise
    // silently lose the review.
    try {
      ensureAsymmetrySchema(db);
      db.prepare(`
        INSERT INTO asymmetry_daily_reviews (session_date, built_at_ms, review_json, ai_summary, ai_status)
        VALUES (?,?,?,NULL,'PENDING')
        ON CONFLICT(session_date) DO UPDATE SET
          built_at_ms=excluded.built_at_ms, review_json=excluded.review_json
      `).run(deps.sessionDate, deps.nowMs, JSON.stringify(review));
      out.persisted = true;
    } catch (err: any) {
      out.errors.push(`persist: ${String(err?.message ?? err)}`);
    }

    // Delivery is attempted only once the review and Quant report are stored,
    // and its outcome is recorded whatever it is. BLOCKED_CONFIG is a normal,
    // expected result — it means the report exists and simply was not posted.
    if (out.persisted && review.paper) {
      try {
        // ONCE PER SESSION. This job ticks hourly; without this guard the same
        // report would be posted again on every tick for the rest of the day.
        const already = readReportDeliveryOnDb(db as any, deps.sessionDate);
        const delivery = already?.status === "SENT"
          ? { status: "SENT", reason: "already delivered for this session" }
          : deps.deliverPaperReport
            ? await deps.deliverPaperReport(review.paper)
            : { status: "BLOCKED_CONFIG", reason: "no delivery function was injected" };
        out.paperDelivery = delivery;
        recordReportDeliveryOnDb(db as any, {
          sessionDate: deps.sessionDate, status: delivery.status, reason: delivery.reason, nowMs: deps.nowMs,
        });
      } catch (err: any) {
        out.paperDelivery = { status: "FAILED", reason: String(err?.message ?? err) };
        out.errors.push(`delivery: ${String(err?.message ?? err)}`);
      }
    }

    if (!deps.explain) {
      out.aiStatus = "DISABLED";
      out.aiReason = "no advisory function was injected";
      setAiStatus(db, deps.sessionDate, null, "DISABLED");
      return out;
    }
    // AI explains a STORED review or nothing at all. If persistence failed there
    // is no row for a summary to attach to, and calling the model would spend a
    // request describing a result that does not exist.
    if (!out.persisted) {
      out.aiStatus = "SKIPPED";
      out.aiReason = "the deterministic review was not persisted";
      out.errors.push("ai: skipped because the deterministic review was not persisted");
      return out;
    }
    try {
      const result = await deps.explain(review);
      // A bare string is the simple case: it succeeded and this is the prose.
      const normalized = typeof result === "string"
        ? { status: "OK" as const, summary: result, reason: null }
        : result;
      out.aiStatus = normalized.status;
      out.aiReason = normalized.reason ?? null;
      const summary = normalized.summary == null ? null : String(normalized.summary).slice(0, 4000);
      setAiStatus(db, deps.sessionDate, summary, normalized.status);
    } catch (err: any) {
      // AI failure must never invalidate the measured review, remove the Quant
      // report, or stop paper trading. It costs one paragraph and nothing else.
      out.aiStatus = "FAILED";
      out.aiReason = String(err?.message ?? err);
      out.errors.push(`ai: ${String(err?.message ?? err)}`);
      setAiStatus(db, deps.sessionDate, null, "FAILED");
    }
    return out;
  } catch (err: any) {
    out.errors.push(String(err?.message ?? err));
    return out;
  }
}

function setAiStatus(db: ReviewDb, sessionDate: string, summary: string | null, status: string): void {
  try {
    db.prepare("UPDATE asymmetry_daily_reviews SET ai_summary=?, ai_status=? WHERE session_date=?")
      .run(summary, status, sessionDate);
  } catch { /* diagnostics only */ }
}

function readTransitions(db: ReviewDb, sessionDate: string): Array<{ toState: string }> {
  try {
    return (db.prepare("SELECT to_state FROM asymmetry_transitions WHERE session_date=?").all(sessionDate) as any[])
      .map((r) => ({ toState: String(r.to_state) }));
  } catch {
    return [];
  }
}

/** Reader for the daily-review table — used by diagnostics. */
export function readEodReviewOnDb(db: ReviewDb, sessionDate: string): { review: AsymmetryEodReview | null; aiSummary: string | null; aiStatus: string | null } {
  try {
    const row = db.prepare("SELECT review_json, ai_summary, ai_status FROM asymmetry_daily_reviews WHERE session_date=?")
      .get(sessionDate) as any;
    if (!row) return { review: null, aiSummary: null, aiStatus: null };
    return {
      review: JSON.parse(String(row.review_json)) as AsymmetryEodReview,
      aiSummary: row.ai_summary == null ? null : String(row.ai_summary),
      aiStatus: row.ai_status == null ? null : String(row.ai_status),
    };
  } catch {
    return { review: null, aiSummary: null, aiStatus: null };
  }
}
