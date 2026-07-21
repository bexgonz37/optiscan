/**
 * lib/ai/shadow-model.ts — the REAL model caller for the AI shadow (part F). Lives in lib/ai/ so it
 * may reference the Anthropic provider. It builds a strictly-structured prompt from AUTHORITATIVE
 * fields only, calls the existing approved provider (schema/timeout/retry framework), and returns a
 * ModelResult for `enqueueAiShadow`. It NEVER runs unless AI_SHADOW_ENABLED=1 and a provider is
 * wired; it cannot send alerts or change any actionable decision. The caller stays INJECTED so tests
 * and default operation incur no spend.
 */
import type { AiShadowInput, ModelResult } from "./shadow.ts";

/** PURE: assemble the authoritative-only prompt. No invented fields; missing data is passed through. */
export function buildAiShadowPrompt(input: AiShadowInput): { system: string; user: string } {
  const system = [
    "You are an OFFLINE advisory analyst for a deterministic options scanner. SHADOW comparison only.",
    "You do NOT send alerts, change gates/thresholds, select contracts, or make anything actionable.",
    "Use ONLY the provided fields. Never invent tickers, prices, earnings dates, Greeks, contracts, or flow.",
    "Never describe option volume as sweeps/institutional/smart-money — the data has no trade tape.",
    "Output ONLY the requested JSON object.",
  ].join(" ");
  const user = JSON.stringify({
    ticker: input.symbol,
    scannerDecision: input.scannerDecision,
    triggerFeatures: input.triggerFeatures,
    earnings: input.earnings,
    optionsActivity: input.optionsActivity,
    technicalState: input.technicalState,
    marketContext: input.marketContext,
    analogSummary: input.analog,
    missingEvidence: input.missing,
    paperHistory: input.paperHistory,
    outputSchema: { catalystClass: "string", setupSummary: "string", evidenceFor: ["string"], evidenceAgainst: ["string"], contradictions: ["string"], riskSummary: "string", confidenceExplanation: "string", missingEvidence: ["string"], classification: "CONFIRM|CANCEL|ABSTAIN" },
  });
  return { system, user };
}

export interface ProviderCall {
  (args: { model: string; system: string; user: string; timeoutMs: number; maxRetries: number }): Promise<{ json: unknown; inputTokens: number; outputTokens: number }>;
}
export interface ShadowModelConfig { model: string; timeoutMs: number; maxRetries: number; usdPer1kInput: number; usdPer1kOutput: number }
export function defaultShadowModelConfig(env: NodeJS.ProcessEnv = process.env): ShadowModelConfig {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return { model: env.AI_SHADOW_MODEL || "claude-haiku-4-5", timeoutMs: n(env.AI_SHADOW_TIMEOUT_MS, 12_000), maxRetries: n(env.AI_SHADOW_MAX_RETRIES, 1), usdPer1kInput: n(env.AI_SHADOW_USD_PER_1K_IN, 0.001), usdPer1kOutput: n(env.AI_SHADOW_USD_PER_1K_OUT, 0.005) };
}

/**
 * Build the `callModel` for enqueueAiShadow from an injected provider call. The provider is injected
 * so the actual Anthropic wiring (ai/provider.ts) is supplied by the caller at enable time — default
 * operation and all tests incur ZERO spend.
 */
export function anthropicShadowCaller(provider: ProviderCall, cfg: ShadowModelConfig = defaultShadowModelConfig()): (input: AiShadowInput) => Promise<ModelResult> {
  return async (input: AiShadowInput): Promise<ModelResult> => {
    const { system, user } = buildAiShadowPrompt(input);
    const res = await provider({ model: cfg.model, system, user, timeoutMs: cfg.timeoutMs, maxRetries: cfg.maxRetries });
    const costUsd = +((res.inputTokens / 1000) * cfg.usdPer1kInput + (res.outputTokens / 1000) * cfg.usdPer1kOutput).toFixed(6);
    return { json: res.json, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd };
  };
}
