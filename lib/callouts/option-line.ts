/**
 * callouts/option-line.ts — the ONE canonical single-line options Discord format.
 * PURE. Nothing is fetched or fabricated: every field is read straight off the
 * Callout's already-verified `contract` (the SAME AgentResult.selectedContract the
 * paper bridge trades), so Discord can never publish a different contract than the
 * one OptiScan actually selected and paper-trades.
 *
 * The desk wants a single mobile-friendly line and nothing else, e.g.
 *
 *     $NVDA 18 JUL 26 $180 CALL $3.25
 *
 *   $NVDA      underlying ticker
 *   18 JUL 26  expiration (DD MON YY)
 *   $180       strike
 *   CALL/PUT   direction
 *   $3.25      contract price at alert time (midpoint preferred, else ask)
 *
 * No greeks, confidence, targets, entry zones, setup names, or free text. If a
 * valid contract cannot be determined the line is null and the delivery gate
 * withholds the actionable options alert (never a generic/incomplete alert).
 */
import type { Callout } from "./callout.ts";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** "2026-07-17" → "17 JUL 26". Returns null on a missing/malformed date. */
export function formatExpiryLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) return null;
  const year = m[1];
  const mon = Number(m[2]);
  const day = Number(m[3]);
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  return `${String(day).padStart(2, "0")} ${MONTHS[mon - 1]} ${year.slice(2)}`;
}

/** 322.5 → "322.5"; 180 → "180" (minimal decimals, max 2). Null when not finite. */
export function formatStrikeLabel(strike: number | null | undefined): string | null {
  if (!isNum(strike)) return null;
  return String(Math.round(strike * 100) / 100);
}

/**
 * The contract price shown at alert time. Existing pricing policy: prefer the
 * midpoint, otherwise the ask (there is no separate last-trade field on the
 * verified contract). Never invents a price — returns null when neither side is a
 * usable positive quote.
 */
export function optionAlertPrice(k: Callout["contract"]): { price: number; source: "mid" | "ask" } | null {
  if (!k) return null;
  if (isNum(k.mid) && k.mid > 0) return { price: k.mid, source: "mid" };
  if (isNum(k.ask) && k.ask > 0) return { price: k.ask, source: "ask" };
  return null;
}

export interface CanonicalOptionContract {
  ticker: string;
  side: "call" | "put";
  /** Provider/OCC contract identity — verified, never fabricated. */
  optionSymbol: string;
  strike: number;
  expiration: string;   // ISO (YYYY-MM-DD)
  dte: number | null;
  /** Contract price at alert time. */
  price: number;
  priceSource: "mid" | "ask";
}

/**
 * The ONE canonical contract identity used across Discord + paper trading +
 * outcome tracking. Returns null when the exact contract cannot be verified from
 * the callout — the caller must then withhold the actionable options alert.
 */
export function canonicalOptionContract(c: Callout): CanonicalOptionContract | null {
  const k = c?.contract;
  if (!k) return null;
  // OCC/provider symbol is the stable identity that ties Discord to the paper
  // trade; without it we cannot prove they reference the same contract.
  if (!k.optionSymbol || !String(k.optionSymbol).trim()) return null;
  if (!isNum(k.strike)) return null;
  if (!formatExpiryLabel(k.expiration)) return null;
  // Side falls back to the callout direction exactly as the paper bridge does, so
  // the two never diverge (paper-bridge.ts: side ?? (bearish ? put : call)).
  const side: "call" | "put" = k.side ?? (c.direction === "bearish" ? "put" : "call");
  const priced = optionAlertPrice(k);
  if (!priced) return null;
  return {
    ticker: String(c.ticker).toUpperCase(),
    side,
    optionSymbol: String(k.optionSymbol),
    strike: k.strike as number,
    expiration: k.expiration as string,
    dte: isNum(k.dte) ? (k.dte as number) : null,
    price: priced.price,
    priceSource: priced.source,
  };
}

/**
 * Build the single canonical options line, e.g. "$NVDA 18 JUL 26 $180 CALL $3.25".
 * Returns null when the exact contract cannot be verified.
 */
export function optionContractLine(c: Callout): string | null {
  const k = canonicalOptionContract(c);
  if (!k) return null;
  const expiry = formatExpiryLabel(k.expiration);
  const strike = formatStrikeLabel(k.strike);
  if (!expiry || !strike) return null; // guarded by canonicalOptionContract, defensive
  return `$${k.ticker} ${expiry} $${strike} ${k.side.toUpperCase()} $${k.price.toFixed(2)}`;
}

/**
 * True when two contract references are the SAME contract (by verified OCC symbol,
 * with strike/expiration/side as corroboration). Used to assert Discord never
 * publishes contract A while paper trading contract B.
 */
export function sameOptionContract(
  a: { optionSymbol: string; strike: number; expiration: string; side: "call" | "put" } | null,
  b: Callout["contract"],
): boolean {
  if (!a || !b) return false;
  if (!b.optionSymbol) return false;
  if (String(a.optionSymbol) !== String(b.optionSymbol)) return false;
  if (isNum(b.strike) && b.strike !== a.strike) return false;
  if (b.expiration && b.expiration !== a.expiration) return false;
  if (b.side && b.side !== a.side) return false;
  return true;
}

export interface OptionAlertDeliverable {
  ok: boolean;
  line: string | null;
  reason: string | null;
}

/**
 * Deterministic delivery decision for an actionable options alert: either a
 * verified single line, or a clear rejection reason. Chosen product policy is to
 * BLOCK (never send a generic/incomplete options alert) when the exact contract
 * cannot be verified.
 */
export function optionAlertDeliverable(c: Callout): OptionAlertDeliverable {
  const k = c?.contract;
  if (!k) return { ok: false, line: null, reason: "no selected contract" };
  if (!k.optionSymbol || !String(k.optionSymbol).trim()) {
    return { ok: false, line: null, reason: "missing provider/OCC contract symbol" };
  }
  if (!isNum(k.strike)) return { ok: false, line: null, reason: "missing strike" };
  if (!formatExpiryLabel(k.expiration)) return { ok: false, line: null, reason: "invalid or missing expiration" };
  if (!optionAlertPrice(k)) return { ok: false, line: null, reason: "no usable contract price (mid/ask)" };
  const line = optionContractLine(c);
  if (!line) return { ok: false, line: null, reason: "contract could not be formatted" };
  return { ok: true, line, reason: null };
}
