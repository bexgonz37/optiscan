/**
 * ai/config.ts — PURE environment configuration for the advisory AI layer.
 *
 * The AI layer is OFF by default and every job is independently gated. Nothing
 * here calls a network or a database; it only reads env with safe, clamped
 * defaults so a misconfiguration can never enable an unbounded/expensive job.
 *
 * Model routing (roadmap §12): a lower-cost model narrates the nightly report;
 * a stronger model reasons about weekly proposals. Frontier models are never used
 * for routine jobs.
 */

const DEFAULT_NIGHTLY_MODEL = "claude-haiku-4-5";   // lower-cost narration
const DEFAULT_WEEKLY_MODEL = "claude-sonnet-5";     // stronger reasoning for proposals

/**
 * The ABSOLUTE ceiling on OptiScan runtime LLM spend, in USD per calendar month.
 *
 * This is a constant and not a default, because the failure it prevents is a
 * configuration one. `AI_MONTHLY_HARD_LIMIT_USD` used to clamp at 100_000, so a single
 * mistyped Railway variable could raise the cap by four orders of magnitude and nothing
 * in the system would object — the budget would still report itself as "enforced".
 * The env var may now only ever LOWER the cap.
 *
 * It covers OptiScan's own runtime jobs (nightly narration, weekly research, metered
 * explanation, research proposals, AI-assisted content wording). It has nothing to do
 * with the Claude subscription used to develop the software.
 */
export const AI_MONTHLY_HARD_CAP_USD = 20;

function flag(v: string | undefined): boolean {
  return v === "1" || v === "true";
}
function num(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function str(v: string | undefined, def: string): string {
  const s = String(v ?? "").trim();
  return s || def;
}

export interface AiConfig {
  /** Master switch. When false NO AI job runs and NO provider call is made. */
  enabled: boolean;
  /** Whether an API key is present (never the key itself). */
  hasApiKey: boolean;
  nightlyDiagnosisEnabled: boolean;
  weeklyProposalsEnabled: boolean;
  /** Optional concise private recap through the existing recap webhook. */
  recapEnabled: boolean;
  nightlyModel: string;
  weeklyModel: string;
  recapModel: string;
  monthlySoftLimitUsd: number;
  /** Effective hard limit: the env value, never above AI_MONTHLY_HARD_CAP_USD. */
  monthlyHardLimitUsd: number;
  /** The absolute ceiling no configuration can raise. Always AI_MONTHLY_HARD_CAP_USD. */
  monthlyHardCapUsd: number;
  maxInputTokensPerJob: number;
  maxOutputTokensPerJob: number;
  jobTimeoutMs: number;
  maxRetries: number;
}

/**
 * Resolve the AI configuration from env. The API key is read ONLY to record its
 * presence — the raw value never leaves the provider module. Enable requires both
 * AI_ENABLED=1 AND a key so a flag alone can never attempt an unauthenticated call.
 */
export function aiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const hasApiKey = Boolean(String(env.ANTHROPIC_API_KEY ?? "").trim());
  const enabled = flag(env.AI_ENABLED) && hasApiKey;
  return {
    enabled,
    hasApiKey,
    nightlyDiagnosisEnabled: enabled && flag(env.AI_NIGHTLY_DIAGNOSIS_ENABLED),
    weeklyProposalsEnabled: enabled && flag(env.AI_WEEKLY_PROPOSALS_ENABLED),
    recapEnabled: enabled && flag(env.AI_RECAP_ENABLED),
    nightlyModel: str(env.AI_NIGHTLY_MODEL, DEFAULT_NIGHTLY_MODEL),
    weeklyModel: str(env.AI_WEEKLY_MODEL, DEFAULT_WEEKLY_MODEL),
    recapModel: str(env.AI_RECAP_MODEL, str(env.AI_NIGHTLY_MODEL, DEFAULT_NIGHTLY_MODEL)),
    // Cost guards. The hard limit is clamped to the absolute cap, so env can only
    // ever tighten it; the soft limit is then clamped to the hard limit, so a
    // "warn" threshold can never sit above the threshold that blocks.
    monthlySoftLimitUsd: Math.min(
      num(env.AI_MONTHLY_SOFT_LIMIT_USD, 5, 0, AI_MONTHLY_HARD_CAP_USD),
      num(env.AI_MONTHLY_HARD_LIMIT_USD, AI_MONTHLY_HARD_CAP_USD, 0, AI_MONTHLY_HARD_CAP_USD),
    ),
    monthlyHardLimitUsd: num(env.AI_MONTHLY_HARD_LIMIT_USD, AI_MONTHLY_HARD_CAP_USD, 0, AI_MONTHLY_HARD_CAP_USD),
    monthlyHardCapUsd: AI_MONTHLY_HARD_CAP_USD,
    maxInputTokensPerJob: Math.floor(num(env.AI_MAX_INPUT_TOKENS_PER_JOB, 60_000, 1_000, 400_000)),
    maxOutputTokensPerJob: Math.floor(num(env.AI_MAX_OUTPUT_TOKENS_PER_JOB, 4_000, 256, 32_000)),
    jobTimeoutMs: Math.floor(num(env.AI_JOB_TIMEOUT_MS, 60_000, 5_000, 300_000)),
    maxRetries: Math.floor(num(env.AI_MAX_RETRIES, 2, 0, 5)),
  };
}
