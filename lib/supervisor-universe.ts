/**
 * supervisor-universe.ts — pure ordering of the Supervisor cycle ticker universe.
 *
 * No provider/DB/@-alias imports so this is directly unit-testable and free of
 * side effects. The live wiring (env + scanner movers) lives in
 * `supervisor-cycle.ts`, which delegates the ordering to `buildCycleUniverse`.
 *
 * Ordering contract:
 *   1. Every VALID pinned core ticker is included first, in the order given.
 *   2. The strongest dynamic candidates (already ranked strongest-first by the
 *      caller) then fill the remaining capacity.
 *   3. Everything is deduplicated (core vs. core, core vs. dynamic, dynamic vs.
 *      dynamic) and the total never exceeds `cap`.
 *   4. Invalid/garbage symbols are dropped, never crash the cycle.
 *
 * This module fabricates nothing: it only orders symbols. Per-symbol data
 * availability, options-chain support, freshness, and risk gates are enforced
 * downstream in the callout/agent/relevance layers — a symbol that has no
 * supported chain or stale data simply fails honestly there while the rest of
 * the cycle continues.
 */

/** Default pinned core universe (overridable via SUPERVISOR_CORE_TICKERS). */
export const DEFAULT_SUPERVISOR_CORE_TICKERS = "NVDA,META,SPCX,SPY,AAPL,AMZN";

// A tradable US ticker: leading letter, then letters/digits, with an optional
// single-letter class suffix (e.g. BRK.B). Rejects empty strings and garbage so
// a malformed env value can never crash the cycle.
const TICKER_RE = /^[A-Z][A-Z0-9]*(\.[A-Z])?$/;

export function isValidTicker(sym: string): boolean {
  return TICKER_RE.test(sym);
}

/** Parse a comma/space separated list into validated, deduped, uppercased tickers. */
export function parseTickerList(csv: string | undefined | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(csv ?? "").split(/[\s,]+/)) {
    const sym = raw.trim().toUpperCase();
    if (!sym || !isValidTicker(sym) || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

/**
 * Build the ordered cycle universe: valid core first, then dynamic candidates
 * (already ranked strongest-first) filling the remaining capacity, deduplicated
 * and capped. `cap` is clamped to 1–50.
 */
export function buildCycleUniverse(
  coreCsv: string | undefined | null,
  dynamicCandidates: readonly string[],
  cap: number,
): string[] {
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(cap)) || 8));
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const sym = String(raw ?? "").trim().toUpperCase();
    if (!sym || !isValidTicker(sym) || seen.has(sym) || out.length >= limit) return;
    seen.add(sym);
    out.push(sym);
  };
  // Core is pinned first so every valid core symbol is present before any mover.
  for (const c of parseTickerList(coreCsv)) add(c);
  for (const d of dynamicCandidates ?? []) add(d);
  return out;
}
