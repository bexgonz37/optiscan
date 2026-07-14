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
  monthlyHardLimitUsd: number;
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
    // Cost guards: soft ≤ hard is enforced by the caller; defaults are conservative.
    monthlySoftLimitUsd: num(env.AI_MONTHLY_SOFT_LIMIT_USD, 5, 0, 100_000),
    monthlyHardLimitUsd: num(env.AI_MONTHLY_HARD_LIMIT_USD, 20, 0, 100_000),
    maxInputTokensPerJob: Math.floor(num(env.AI_MAX_INPUT_TOKENS_PER_JOB, 60_000, 1_000, 400_000)),
    maxOutputTokensPerJob: Math.floor(num(env.AI_MAX_OUTPUT_TOKENS_PER_JOB, 4_000, 256, 32_000)),
    jobTimeoutMs: Math.floor(num(env.AI_JOB_TIMEOUT_MS, 60_000, 5_000, 300_000)),
    maxRetries: Math.floor(num(env.AI_MAX_RETRIES, 2, 0, 5)),
  };
}
