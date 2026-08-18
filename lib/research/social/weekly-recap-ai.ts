/**
 * weekly-recap-ai.ts — OPTIONAL wording layer for the weekly recap.
 *
 * The AI may rewrite phrasing, vary tweets, summarise a setup reason, and organise a
 * thread. It may NOT calculate, adjust, round, combine, or introduce any number or
 * ticker. Enforcement is not a prompt request: every returned variant is validated
 * against the deterministic report and discarded on any mismatch, so the worst case
 * is that the owner sees the deterministic draft instead of a rewritten one.
 *
 * This module never posts, sends, schedules, or writes production state.
 */
import { aiConfig } from "../../ai/config.ts";
import { runStructuredAiJob, type ProviderDeps } from "../../ai/provider.ts";
import {
  validateDraftAgainstRecap,
  type DraftStyle,
  type RecapDraft,
} from "./weekly-recap-drafts.ts";
import { LABEL_COMBINED_PEAK, LABEL_COMBINED_TRACKED, type WeeklySocialRecap } from "./weekly-recap.ts";

export const RECAP_AI_PROMPT_VERSION = "weekly-social-recap-v1";

/** Ledger label for content-wording spend. */
export const RECAP_AI_JOB_TYPE = "social_recap_rewrite";

export interface AiRewriteResult {
  ok: boolean;
  /** Accepted variants only. Any variant failing validation is dropped. */
  variants: Array<{ text: string; parts: string[] }>;
  rejected: Array<{ text: string; failures: unknown[] }>;
  status: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  note: string;
}

function systemPrompt(recap: WeeklySocialRecap, draft: RecapDraft): string {
  const t = recap.verifiedSubscriber;
  return [
    "You rewrite a finished, already-calculated trading recap for social media. You are a copy editor, not an analyst.",
    "",
    "ABSOLUTE RULES:",
    "1. You may NOT calculate, adjust, round, sum, average, or invent ANY number. Copy every figure EXACTLY as it appears in the draft, including its sign and decimals.",
    "2. You may NOT introduce a ticker, contract, expiration, or strike that is not already in the draft.",
    `3. Keep the exact labels "${LABEL_COMBINED_PEAK}" and "${LABEL_COMBINED_TRACKED}". Never rename them.`,
    "4. Never describe combined peak moves as portfolio return, account return, account growth, or a realized result. Keep the sentence stating it is the sum of individual callout peaks and not portfolio return.",
    "5. Never claim that anyone made, earned, banked, captured, entered at, or exited at anything. OptiScan can verify what a callout did; it cannot prove any person traded it. Do not write \"we made\", \"you made\", \"followers made\", or \"our members made\".",
    "6. Keep the educational-purposes and risk disclosure.",
    "7. Do not hide or soften losses, open positions, or excluded rows that appear in the draft.",
    "8. You may improve flow, tighten wording, vary tweet phrasing, and summarise the setup reason in plain English.",
    "",
    "CONTEXT (do not restate figures beyond what the draft already contains):",
    `Verified subscriber callouts: ${t.eligibleCallouts}; closed: ${t.closedCallouts}; open: ${t.openCallouts}; winners: ${t.winners}; losers: ${t.losers}.`,
    recap.warnings.length ? `Warnings that must survive: ${recap.warnings.join(" ")}` : "No data-quality warnings.",
    "",
    `TARGET STYLE: ${draft.label}`,
    draft.style === "B_TWITTER_THREAD"
      ? "Return each tweet as a separate entry in parts."
      : "Return one entry in parts.",
    "",
    "DRAFT TO REWRITE (the only permitted source of numbers and tickers):",
    draft.text,
    "",
    "Respond with the recap_rewrite tool only.",
  ].join("\n");
}

const REWRITE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      description: "One to three rewritten variants of the same draft.",
      items: {
        type: "object",
        properties: {
          parts: {
            type: "array",
            items: { type: "string" },
            description: "Text blocks (tweets for a thread, otherwise one block).",
          },
        },
        required: ["parts"],
      },
    },
  },
  required: ["variants"],
};

interface RawRewrite { variants: Array<{ parts: string[] }> }

function validateShape(json: unknown): RawRewrite {
  const o = json as any;
  if (!o || typeof o !== "object" || !Array.isArray(o.variants)) throw new Error("variants missing");
  const variants = o.variants
    .map((v: any) => ({ parts: Array.isArray(v?.parts) ? v.parts.filter((p: unknown) => typeof p === "string") : [] }))
    .filter((v: { parts: string[] }) => v.parts.length > 0);
  if (!variants.length) throw new Error("no usable variants");
  return { variants };
}

/**
 * Rewrite one deterministic draft. Never throws; a failure returns the reason and no
 * variants, leaving the deterministic draft as the thing the owner copies.
 */
export async function rewriteRecapDraft(input: {
  recap: WeeklySocialRecap;
  draft: RecapDraft;
  style?: DraftStyle;
  deps?: ProviderDeps;
}): Promise<AiRewriteResult> {
  const deps = input.deps ?? {};
  const cfg = aiConfig(deps.env ?? process.env);
  const base: AiRewriteResult = {
    ok: false,
    variants: [],
    rejected: [],
    status: "AI_DISABLED",
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    note: "Deterministic draft is unchanged and remains available.",
  };
  if (!cfg.enabled) return base;

  let result;
  try {
    result = await runStructuredAiJob<RawRewrite>(
      {
        model: cfg.weeklyModel,
        system: systemPrompt(input.recap, input.draft),
        user: "Rewrite the draft under the rules above. Change wording only; every number and ticker must match the draft exactly.",
        maxOutputTokens: Math.min(cfg.maxOutputTokensPerJob, 2_500),
        timeoutMs: cfg.jobTimeoutMs,
        maxRetries: Math.min(cfg.maxRetries, 1),
        // Content wording counts against the SAME monthly AI budget as the research jobs.
        // It had no ledger row at all, so a marketing rewrite could consume budget the
        // nightly analyst then believed it still had.
        jobType: RECAP_AI_JOB_TYPE,
        meter: true,
        toolName: "recap_rewrite",
        toolInputSchema: REWRITE_SCHEMA,
        validatorName: "weeklyRecapRewrite",
        promptVersion: RECAP_AI_PROMPT_VERSION,
      },
      validateShape,
      deps,
    );
  } catch {
    return { ...base, status: "PROVIDER_ERROR" };
  }
  if (!result.ok || !result.data) {
    return { ...base, status: result.errorCategory === "timeout" ? "AI_TIMEOUT" : "PROVIDER_ERROR" };
  }

  const accepted: AiRewriteResult["variants"] = [];
  const rejected: AiRewriteResult["rejected"] = [];
  for (const variant of result.data.variants) {
    const text = variant.parts.join("\n\n---\n\n");
    const validation = validateDraftAgainstRecap(text, input.recap);
    if (validation.ok) accepted.push({ text, parts: variant.parts });
    else rejected.push({ text, failures: validation.failures });
  }

  return {
    ok: accepted.length > 0,
    variants: accepted,
    rejected,
    status: accepted.length > 0
      ? (rejected.length ? "PARTIAL_ACCEPTED" : "ACCEPTED")
      : "REJECTED_VALIDATION",
    model: cfg.weeklyModel,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    note: accepted.length > 0
      ? "AI rewrote wording only. Every number was validated against the deterministic report."
      : "All AI variants failed numeric validation and were discarded. The deterministic draft is unchanged.",
  };
}
