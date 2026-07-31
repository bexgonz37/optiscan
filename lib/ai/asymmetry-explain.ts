/**
 * asymmetry-explain.ts — advisory explanation of an ALREADY-MEASURED review.
 *
 * This lives in lib/ai/ ON PURPOSE. The architecture forbids model calls
 * outside lib/ai/, and the radar's own boundary test forbids any asymmetry
 * module from importing an AI path. Keeping the call here preserves both: the
 * radar never imports AI, and the scheduler injects this function into the EOD
 * review's `explain` hook. The dependency points AI -> research, never the
 * reverse.
 *
 * Called by the EOD job only AFTER the deterministic review is persisted, so
 * this cannot prevent, delay, or alter a measured result. It returns prose.
 *
 * It has no authority. It exports one function that takes a review and returns
 * a string. There is no path from here to a threshold, gate, flag, state, or
 * send, and a test asserts the module contains no mutation call.
 */
import { runStructuredAiJob } from "./provider.ts";
import type { AsymmetryEodReview } from "../research/asymmetry/eod-review.ts";
import {
  checkAiBudget, recordAiCallOnDb, writeAiCache, estimateTokens, resolveAiBudgetConfig,
} from "./asymmetry-budget.ts";

const SYSTEM = [
  "You explain an options-research review that has ALREADY been measured and stored.",
  "You are describing it, not deciding anything.",
  "Cite only numbers present in the payload. Never claim profitability.",
  "Never claim causality. Never recommend enabling anything.",
  "You cannot change any threshold, gate, flag, or alert; saying so would be false.",
  "If the graded sample is small, say the sample is too small to conclude.",
].join(" ");

/**
 * Ask the existing advisory layer to explain the measured review.
 * Throws on failure so the caller records aiStatus FAILED and keeps the
 * deterministic review untouched.
 */
export async function explainAsymmetryReview(review: AsymmetryEodReview): Promise<string> {
  const res = await runStructuredAiJob<{ summary: string }>(
    {
      model: "claude-sonnet-5",
      system: SYSTEM,
      user: JSON.stringify(review),
      maxOutputTokens: 900,
      timeoutMs: 30_000,
      maxRetries: 1,
      validatorName: "asymmetry_review_summary",
    },
    (json) => {
      const summary = (json as { summary?: unknown })?.summary;
      if (typeof summary !== "string" || !summary.trim()) throw new Error("no summary");
      return { summary };
    },
  );
  const text = res.data?.summary ?? res.text ?? "";
  if (!res.ok || !text) throw new Error(`advisory layer returned no explanation`);
  return String(text);
}

/**
 * The budget-controlled entry point the scheduler injects.
 *
 * This is the ONLY place the High-Asymmetry system spends money, and it spends
 * it at most once per trading session. Everything upstream — capture, states,
 * paper entry, marks, exits, grading, the whole Quant report — has already been
 * computed and persisted deterministically before this is called, so every
 * branch below simply decides whether an optional paragraph gets written.
 *
 * It NEVER throws: a caller that is handed a status can distinguish "we chose
 * not to spend" from "it failed", and both leave the measured review intact.
 * It never buys credits and never raises its own limit.
 */
export async function explainAsymmetryReviewWithBudget(
  db: Parameters<typeof checkAiBudget>[0],
  sessionDate: string,
  review: AsymmetryEodReview,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: "OK" | "FAILED" | "DISABLED" | "AI_BUDGET_BLOCKED" | "CACHED"; summary: string | null; reason: string | null }> {
  const cfg = resolveAiBudgetConfig(env);
  // The cache key is the REVIEW VERSION, not the review contents: a review
  // rebuilt from the same rules on the same day is the same review, and
  // re-explaining it would be paying twice for one answer.
  const reviewVersion = review.paper?.rulesVersion ?? "REVIEW_V1";

  const decision = checkAiBudget(db, sessionDate, reviewVersion, cfg);
  if (decision.status === "CACHED") {
    recordAiCallOnDb(db, { sessionDate, reviewVersion, nowMs, status: "CACHED", cfg });
    return { status: "CACHED", summary: decision.cachedSummary, reason: decision.reason };
  }
  if (decision.status === "AI_DISABLED") {
    recordAiCallOnDb(db, { sessionDate, reviewVersion, nowMs, status: "DISABLED", cfg });
    return { status: "DISABLED", summary: null, reason: decision.reason };
  }
  if (decision.status === "AI_BUDGET_BLOCKED") {
    recordAiCallOnDb(db, { sessionDate, reviewVersion, nowMs, status: "BLOCKED", cfg });
    return { status: "AI_BUDGET_BLOCKED", summary: null, reason: decision.reason };
  }

  const payload = JSON.stringify(review);
  try {
    const summary = await explainAsymmetryReview(review);
    recordAiCallOnDb(db, {
      sessionDate, reviewVersion, nowMs, status: "CALLED", cfg,
      // ESTIMATED. The advisory layer does not return provider usage, and a
      // precise-looking fabricated number would be worse than an open estimate.
      estInputTokens: estimateTokens(SYSTEM) + estimateTokens(payload),
      estOutputTokens: estimateTokens(summary),
    });
    writeAiCache(db, { sessionDate, reviewVersion, summary, nowMs });
    return { status: "OK", summary, reason: null };
  } catch (err: any) {
    // A failed call may still have cost something upstream, so it is recorded —
    // but as FAILED, which does not consume the session's one allowed call.
    recordAiCallOnDb(db, { sessionDate, reviewVersion, nowMs, status: "FAILED", cfg });
    return { status: "FAILED", summary: null, reason: String(err?.message ?? err) };
  }
}
