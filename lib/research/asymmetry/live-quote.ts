/**
 * live-quote.ts — exact-OCC quote adapter for forward marking.
 *
 * FIXED 2026-08-02, after production recorded 2,718 NO_QUOTE mark rejections
 * against 7 usable marks (0.4%). Two defects, both here:
 *
 *  1. COST. This adapter read ONE contract by fetching its entire 0-60 DTE
 *     chain (up to OPTIONS_CHAIN_MAX_PAGES requests, up to 750 contracts) and
 *     searching the result. With ~395 open cases re-observed every 60 seconds,
 *     that is well over a thousand requests a minute against a 280/minute cap.
 *     Production hit callsToday = dailyCap = 200,000 and stayed there.
 *
 *  2. MISATTRIBUTION. Once the budget was exhausted, recordPolygonCall threw,
 *     fetchOptionChain returned available:false, getQuote mapped that to null,
 *     and THIS FUNCTION reported it as `providerError: null` — a genuine
 *     no-quote. So every quota refusal was recorded as "this contract had no
 *     market". The module docstring already promised that must never happen;
 *     the code did the opposite.
 *
 * Both are fixed by reading the single-contract snapshot (one request, exact
 * contract, no pagination) and by propagating budget refusals as their own
 * outcome. A missing quote and an unaffordable quote are different facts.
 */
import type { MarkQuote } from "./mark-runner.ts";

export interface QuoteFetchResult {
  quote: MarkQuote | null;
  /** Set only when the provider itself failed, never when it answered "none". */
  providerError: string | null;
  /**
   * True when the request was REFUSED for budget, not answered. Distinct from
   * providerError because it is self-inflicted and recoverable: the contract is
   * fine, we simply declined to pay for it on this tick.
   */
  budgetBlocked: boolean;
}

/** Fetch a present-time quote for one exact OCC. Never throws. */
export async function liveAsymmetryQuote(
  optionSymbol: string,
  underlyingSymbol: string,
): Promise<QuoteFetchResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetchOptionContractSnapshot } = require("@/lib/polygon-provider");
    const res = await fetchOptionContractSnapshot(underlyingSymbol, optionSymbol);
    if (res?.quotaExceeded) {
      return { quote: null, providerError: null, budgetBlocked: true };
    }
    if (!res?.available) {
      return { quote: null, providerError: String(res?.note ?? "provider unavailable"), budgetBlocked: false };
    }
    const c = res.contract;
    if (!c) return { quote: null, providerError: null, budgetBlocked: false }; // genuine no-quote
    return {
      quote: {
        optionSymbol,
        bid: num(c.bid),
        ask: num(c.ask),
        quoteAtMs: num(c.providerTimestamp),
      },
      providerError: null,
      budgetBlocked: false,
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    return {
      quote: null,
      providerError: /quota_exceeded/.test(msg) ? null : msg,
      budgetBlocked: /quota_exceeded/.test(msg),
    };
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
  // A budget refusal returns null for the same reason a missing quote does —
  // no re-evaluation this tick — but it is emphatically NOT evidence about the
  // contract, and the runner must not read it as one.
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
