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
  advisoryOnly: true;
  productionBehaviorChanged: false;
}

/** Pure aggregation. Deterministic and AI-free. */
export function buildDeterministicReview(input: {
  sessionDate: string;
  nowMs: number;
  cases: ReturnType<typeof listCasesOnDb>;
  transitions: Array<{ toState: string }>;
  outcomes: ReturnType<typeof listOutcomesOnDb>;
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
    advisoryOnly: true,
    productionBehaviorChanged: false,
  };
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
  aiStatus: "SKIPPED" | "OK" | "FAILED" | "DISABLED";
  errors: string[];
}

export interface EodDeps {
  nowMs: number;
  sessionDate: string;
  env?: NodeJS.ProcessEnv;
  /** Injected AI. Advisory only — its return value is stored as prose, never read back. */
  explain?: (review: AsymmetryEodReview) => Promise<string>;
}

/**
 * Build, persist, then optionally explain. Never throws.
 * The deterministic review is committed BEFORE AI runs.
 */
export async function runAsymmetryEodReview(db: ReviewDb, deps: EodDeps): Promise<EodRunResult> {
  const out: EodRunResult = { ran: false, reason: null, sessionDate: deps.sessionDate, review: null, persisted: false, aiStatus: "SKIPPED", errors: [] };
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
    const review = buildDeterministicReview({ sessionDate: deps.sessionDate, nowMs: deps.nowMs, cases, transitions, outcomes });
    out.review = review;

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

    if (!deps.explain) {
      out.aiStatus = "DISABLED";
      setAiStatus(db, deps.sessionDate, null, "DISABLED");
      return out;
    }
    // AI explains a STORED review or nothing at all. If persistence failed there
    // is no row for a summary to attach to, and calling the model would spend a
    // request describing a result that does not exist.
    if (!out.persisted) {
      out.aiStatus = "SKIPPED";
      out.errors.push("ai: skipped because the deterministic review was not persisted");
      return out;
    }
    try {
      const summary = await deps.explain(review);
      out.aiStatus = "OK";
      setAiStatus(db, deps.sessionDate, String(summary ?? "").slice(0, 4000), "OK");
    } catch (err: any) {
      // AI failure must never invalidate the measured review.
      out.aiStatus = "FAILED";
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
