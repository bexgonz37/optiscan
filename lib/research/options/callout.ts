/**
 * lib/research/options/callout.ts — the SINGLE public callout pipeline for the Options scanner.
 * PURE. One message per play. Internal states FORMING/READY/SENT/REJECTED/TOO_LATE/EXPIRED; only a
 * READY play produces a message. The formatter matches the required public format exactly. Nothing
 * here sends Discord — delivery is a separate, flag-gated, explicitly-approved step.
 */
import { checkEntryFreshness } from "../forward/freshness.ts";
import { realOptionEntryEligible, defaultRealOptionEntryGate, type RealOptionEntryGateCfg } from "./paper-class.ts";
import { getStrategy } from "./strategy-catalog.ts";

export type CalloutState = "FORMING" | "READY" | "SENT" | "REJECTED" | "TOO_LATE" | "EXPIRED";

export interface CalloutContract {
  optionSymbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number;
  bid: number | null; ask: number | null; spreadPct: number | null; quoteAgeMs: number | null;
  openInterest: number | null; volume: number | null;
}
export interface CalloutInput {
  symbol: string; strategyKey: string; researchOnly: boolean;
  contract: CalloutContract | null;
  observedUnderlyingPrice: number; observedAtMs: number;
  currentUnderlyingPrice: number; currentAtMs: number;
  entryZone: [number, number] | null;
  targets: [number, number] | null;
  why: string;
  ttlMs?: number; ageMs?: number;
  gateCfg?: RealOptionEntryGateCfg;
}

export interface CalloutResult { state: CalloutState; message: string | null; reason: string; freshness: string | null }

/** Decide the single callout. READY (with message) only when everything passes and it is still early. */
export function evaluateCallout(input: CalloutInput): CalloutResult {
  const strat = getStrategy(input.strategyKey);
  if (!strat) return { state: "REJECTED", message: null, reason: `unknown strategy ${input.strategyKey}`, freshness: null };
  if (!input.contract) return { state: "REJECTED", message: null, reason: "no real contract selected", freshness: null };
  if (input.ttlMs != null && input.ageMs != null && input.ageMs > input.ttlMs) return { state: "EXPIRED", message: null, reason: "aged out before READY", freshness: null };

  // liquidity/quote gate (real contract, non-zero-bid, spread, freshness, OI/volume)
  const gate = realOptionEntryEligible({ optionSymbol: input.contract.optionSymbol, bid: input.contract.bid, ask: input.contract.ask, spreadPct: input.contract.spreadPct, quoteAgeMs: input.contract.quoteAgeMs, openInterest: input.contract.openInterest, volume: input.contract.volume }, input.gateCfg ?? defaultRealOptionEntryGate());
  if (!gate.ok) return { state: "REJECTED", message: null, reason: `contract gate: ${gate.rejections.join(",")}`, freshness: null };

  // freshness / chase — on the UNDERLYING (chase + age). input.entryZone is the OPTION premium band
  // (display only); it is NOT an underlying price zone, so it must not gate the underlying freshness.
  const fresh = checkEntryFreshness({ side: input.contract.side, observedPrice: input.observedUnderlyingPrice, observedAtMs: input.observedAtMs, currentPrice: input.currentUnderlyingPrice, currentAtMs: input.currentAtMs, entryZone: null, maxChasePct: strat.chaseLimitPct, maxAgeMs: strat.freshnessMaxMs });
  if (fresh.state === "TOO_LATE") return { state: "TOO_LATE", message: null, reason: `too late: ${fresh.reason}`, freshness: fresh.reason };

  return { state: "READY", message: formatCallout(input), reason: "ready — deterministic strategy valid, real liquid contract, still early", freshness: "fresh" };
}

/** The exact public format. Puts are RESEARCH_ONLY: the message is still built but a delivery layer
 *  must not send a research-only put as a public actionable alert (enforced downstream). */
export function formatCallout(input: CalloutInput): string {
  const c = input.contract!;
  const side = c.side.toUpperCase();
  const exp = mmdd(c.expiration);
  const entry = input.entryZone ? `$${fix(input.entryZone[0])}–$${fix(input.entryZone[1])}` : (c.bid != null && c.ask != null ? `$${fix(c.bid)}–$${fix(c.ask)}` : "n/a");
  const targets = input.targets ? `$${fix(input.targets[0])} / $${fix(input.targets[1])}` : "n/a";
  const tag = input.researchOnly ? " (RESEARCH_ONLY)" : "";
  return `${input.symbol.toUpperCase()} ${side}${tag}\n$${fixStrike(c.strike)} — ${exp}\nEntry: ${entry}\nTargets: ${targets}\nWhy: ${input.why}`;
}

const fix = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2));
const fixStrike = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
function mmdd(iso: string): string { const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}` : iso; }
