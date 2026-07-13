/**
 * agents/relevance.ts — deterministic horizon relevance (Phase: live runtime wiring).
 * PURE. Decides which horizon agents should actually run for a ticker given the
 * fetched chain's real DTE coverage. A longer-dated agent must NOT run (and must
 * never widen to unsupported contracts) unless the chain genuinely contains a
 * contract inside its DTE window. The momentum-stock agent needs no chain.
 *
 * This keeps provider spend honest — one chain fetch per ticker serves every
 * horizon whose range it covers, and horizons it does not cover are skipped
 * rather than fabricating a contract.
 */

export interface DteCoverage {
  minDte: number;
  maxDte: number;
  count: number;
}

/** Real DTE coverage of a fetched chain, or null when there are no dated contracts. */
export function chainDteCoverage(contracts: Array<{ dte?: number | null }>): DteCoverage | null {
  let minDte = Infinity;
  let maxDte = -Infinity;
  let count = 0;
  for (const c of contracts) {
    const d = c?.dte;
    if (typeof d === "number" && Number.isFinite(d)) {
      if (d < minDte) minDte = d;
      if (d > maxDte) maxDte = d;
      count++;
    }
  }
  if (count === 0) return null;
  return { minDte, maxDte, count };
}

/** True when the chain's coverage overlaps a horizon's [lo,hi] DTE window. */
export function horizonSupported(range: [number, number] | null, coverage: DteCoverage | null): boolean {
  if (!range) return false;
  if (!coverage) return false;
  const [lo, hi] = range;
  // Overlap test: the horizon window and the chain coverage window intersect.
  return coverage.minDte <= hi && coverage.maxDte >= lo;
}

/**
 * Filter horizon agent configs to only those whose DTE window the chain covers.
 * When there is no chain at all, no option horizon agent runs (they will surface
 * NO_VALID_CONTRACT / DATA_STALE via their own evaluation if invoked, but we do
 * not even fetch/evaluate them here). Stock agents are handled separately.
 */
export function relevantOptionAgents<T extends { dteRange: [number, number] | null }>(
  agents: T[],
  coverage: DteCoverage | null,
): T[] {
  return agents.filter((a) => horizonSupported(a.dteRange, coverage));
}
