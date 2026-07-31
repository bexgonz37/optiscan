/**
 * live-quote.ts — exact-OCC quote adapter for forward marking.
 *
 * Uses the SAME provider abstraction the live grading path already uses:
 * `buildLiveGradeDeps().getQuote(optionSymbol, underlyingSymbol)`, which goes
 * through `fetchOptionChain` and therefore respects the existing metered
 * data-access boundaries. No new provider integration and no bypass.
 *
 * NOTE the interface it must match, verified against source rather than
 * assumed: getQuote is ASYNC, needs the UNDERLYING symbol as well as the OCC,
 * and returns `providerTimestamp` (not `quoteAtMs`).
 *
 * A provider fault is reported as PROVIDER_ERROR and is deliberately
 * distinguishable from a genuine NO_QUOTE — otherwise an outage would look
 * identical to a contract that simply had no two-sided market, and the research
 * would silently misattribute missing data.
 */
import type { MarkQuote } from "./mark-runner.ts";

export interface QuoteFetchResult {
  quote: MarkQuote | null;
  /** Set only when the provider itself failed, never when it answered "none". */
  providerError: string | null;
}

/** Fetch a present-time quote for one exact OCC. Never throws. */
export async function liveAsymmetryQuote(
  optionSymbol: string,
  underlyingSymbol: string,
): Promise<QuoteFetchResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildLiveGradeDeps } = require("@/lib/research/options/live-deps");
    const deps = buildLiveGradeDeps();
    const q = await deps.getQuote(optionSymbol, underlyingSymbol);
    if (!q) return { quote: null, providerError: null }; // genuine no-quote
    return {
      quote: {
        optionSymbol,
        bid: num(q.bid),
        ask: num(q.ask),
        quoteAtMs: num(q.providerTimestamp),
      },
      providerError: null,
    };
  } catch (err: any) {
    return { quote: null, providerError: String(err?.message ?? err) };
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Live observation for the transition sweep, built on the SAME verified
 * provider as marking. Returns null when the contract cannot be observed, which
 * the runner treats as "no re-evaluation this tick" rather than as evidence of
 * failure — a missing quote must never be read as a dead setup.
 *
 * `triggered` and `invalidated` are left false here: neither is knowable from a
 * quote alone, and inventing them would fabricate a state change.
 */
export async function observeAsymmetryCase(
  c: { fingerprint: string; optionSymbol: string; symbol: string },
): Promise<{
  fingerprint: string; bid: number | null; ask: number | null; quoteAtMs: number | null;
  triggered: boolean; invalidated: boolean; spreadPct: number | null; openInterest: number | null;
} | null> {
  const fetched = await liveAsymmetryQuote(c.optionSymbol, c.symbol);
  const q = fetched.quote;
  if (!q || q.bid == null || q.ask == null) return null;
  const mid = (q.bid + q.ask) / 2;
  return {
    fingerprint: c.fingerprint,
    bid: q.bid,
    ask: q.ask,
    quoteAtMs: q.quoteAtMs,
    triggered: false,
    invalidated: false,
    spreadPct: mid > 0 ? Math.round(((q.ask - q.bid) / mid) * 10000) / 100 : null,
    // Open interest is not returned by the grade-quote path; absent stays absent.
    openInterest: null,
  };
}
