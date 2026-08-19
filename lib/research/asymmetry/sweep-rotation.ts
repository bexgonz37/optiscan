/**
 * sweep-rotation.ts — the round-robin budget cursor shared by the research
 * sweeps.
 *
 * Extracted from `transition-runner.ts` unchanged, because a second sweep now
 * needs it and importing the transition runner for one pure function would drag
 * the notifier, the notify journal and the paper-activation gate into the mark
 * path. `transition-runner.ts` re-exports it, so every existing import and test
 * keeps working against the same implementation.
 *
 * FAIRNESS IS A CORRECTNESS PROPERTY, NOT A NICETY. A case that is never
 * observed can never transition, and a horizon that is never reached can never
 * be marked — so a fixed-order budget permanently freezes everything past the
 * cutoff. Both sweeps read their case list newest-first, which means that
 * without rotation the cutoff always falls in the same place.
 *
 * PURE and deterministic given a cursor. No clock, no I/O.
 */

/**
 * Order cases so the ones waiting longest are served first, then wrap.
 *
 * Returns the slice to work on, the cursor the NEXT sweep should start from,
 * and how many were deferred. A deferred case is untouched: it keeps its state,
 * stays in the population, and is first in line next time.
 */
export function rotateForBudget<T>(cases: readonly T[], cursor: number, budget: number): {
  selected: T[]; nextCursor: number; deferred: number;
} {
  if (cases.length === 0 || budget <= 0) return { selected: [], nextCursor: cursor, deferred: cases.length };
  if (budget >= cases.length) return { selected: [...cases], nextCursor: 0, deferred: 0 };
  const start = ((cursor % cases.length) + cases.length) % cases.length;
  const selected: T[] = [];
  for (let i = 0; i < budget; i++) selected.push(cases[(start + i) % cases.length]);
  return { selected, nextCursor: (start + budget) % cases.length, deferred: cases.length - budget };
}
