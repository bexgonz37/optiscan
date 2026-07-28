/**
 * In-memory last universe-filter attrition snapshot for owner diagnostics.
 */
import {
  runUniverseFilterChain,
  summarizeFilterAttrition,
  type FilterCandidate,
  type FilterChainResult,
  DEFAULT_UNIVERSE_FILTERS,
} from "./universe-filters.ts";

type G = typeof globalThis & { __optiscanLastFilterChain?: FilterChainResult | null };

export function recordUniverseFilterSnapshot(
  candidates: FilterCandidate[],
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): FilterChainResult {
  const result = runUniverseFilterChain(candidates, DEFAULT_UNIVERSE_FILTERS, env, nowMs);
  (globalThis as G).__optiscanLastFilterChain = result;
  return result;
}

export function getLastUniverseFilterSnapshot(): FilterChainResult | null {
  return (globalThis as G).__optiscanLastFilterChain ?? null;
}

export function getLastUniverseFilterSummary() {
  const snap = getLastUniverseFilterSnapshot();
  if (!snap) return null;
  return summarizeFilterAttrition(snap);
}
