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
