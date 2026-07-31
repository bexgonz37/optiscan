/**
 * live-quote.ts — present-time exact-OCC quote adapter for forward marking.
 *
 * The ONLY provider touchpoint in the radar. Returns null on any failure so the
 * mark runner records a rejection rather than propagating an error, and uses
 * the existing metered chain path (no new provider integration, no new cost
 * beyond one snapshot call per marked contract).
 */
import type { MarkQuote } from "./mark-runner.ts";

/** Fetch a present-time quote for one exact OCC. Never throws. */
export function liveAsymmetryQuote(optionSymbol: string): MarkQuote | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getOptionQuoteSnapshot } = require("@/lib/research/options/live-deps");
    const q = getOptionQuoteSnapshot?.(optionSymbol);
    if (!q) return null;
    return {
      optionSymbol,
      bid: num(q.bid),
      ask: num(q.ask),
      quoteAtMs: num(q.providerTimestamp ?? q.quoteTimestampMs),
    };
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
