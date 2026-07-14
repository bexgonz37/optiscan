/**
 * ai/pricing.ts — PURE model price table + cost estimation. USD per 1M tokens.
 *
 * Prices are used only to ESTIMATE spend for the soft/hard monthly guardrails and
 * to record an auditable per-job cost. An unknown model falls back to a
 * conservative (highest routine-tier) price so an untracked model can never make a
 * job look cheaper than it is. Estimates are labeled estimated — never billed truth.
 */

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Known routine-tier models (2026-06 pricing). Keep in sync with docs. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
};

/** Conservative fallback (Opus-tier) so an unknown model is never under-priced. */
const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 5, outputPerMTok: 25 };

export function modelPrice(model: string): ModelPrice {
  return MODEL_PRICES[model] ?? FALLBACK_PRICE;
}

/** Estimated USD cost for a job's token usage. Never negative; 6-dp rounded. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = modelPrice(model);
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const usd = (inTok / 1_000_000) * p.inputPerMTok + (outTok / 1_000_000) * p.outputPerMTok;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
