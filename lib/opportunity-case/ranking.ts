/**
 * Rank explanation extension for Opportunity Case.
 */
import type { OpportunityCase } from "./schema.ts";

export interface RankExplanation {
  globalRank: number;
  qualityScore: number | null;
  components: Record<string, number>;
  explanation: string;
}

export function buildRankExplanation(c: OpportunityCase, rank: number, quality: number | null, components: Record<string, number> = {}): RankExplanation {
  const parts = Object.entries(components)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([k, v]) => `${k}=${v.toFixed(3)}`);
  return {
    globalRank: rank,
    qualityScore: quality,
    components,
    explanation: parts.length ? `Rank #${rank} driven by: ${parts.join(", ")}` : `Rank #${rank}`,
  };
}

export function attachRankToCase(c: OpportunityCase, rank: number, quality: number | null, components: Record<string, number> = {}): OpportunityCase {
  const ex = buildRankExplanation(c, rank, quality, components);
  return { ...c, rank, rankExplanation: ex.explanation, updatedAtMs: Date.now() };
}
