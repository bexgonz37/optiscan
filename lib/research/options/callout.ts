/**
 * lib/research/options/callout.ts — the SINGLE public callout pipeline for the Options scanner.
 * PURE. One message per play. Internal states FORMING/READY/SENT/REJECTED/TOO_LATE/EXPIRED; only a
 * READY play produces a message. The formatter matches the required public format exactly. Nothing
 * here sends Discord — delivery is a separate, flag-gated, explicitly-approved step.
 */
import { checkEntryFreshness } from "../forward/freshness.ts";
import { realOptionEntryEligible, defaultRealOptionEntryGate, type RealOptionEntryGateCfg } from "./paper-class.ts";
import { getStrategy } from "./strategy-catalog.ts";
import { entryMidpoint, formatCompactAlert } from "./format.ts";
import { computeOptionTargets } from "./targets.ts";

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
  maxMidpointSpreadPct?: number;   // reject rather than publish an incredible midpoint on a too-wide spread
}

/** The FROZEN decision-time entry — one exact midpoint + deterministic targets. Persisted verbatim and
 *  reused by the linked paper mirror (never replaced later with a better entry). */
export interface FrozenEntry { bid: number; ask: number; mid: number; spreadPct: number; quoteAgeMs: number | null; t1: number; t2: number; stop: number; methodology: string }
export interface CalloutResult { state: CalloutState; message: string | null; reason: string; freshness: string | null; entry: FrozenEntry | null }

/** Decide the single callout. READY (with message) only when everything passes and it is still early. */
export function evaluateCallout(input: CalloutInput): CalloutResult {
  const rej = (state: CalloutState, reason: string, freshness: string | null = null): CalloutResult => ({ state, message: null, reason, freshness, entry: null });
  const strat = getStrategy(input.strategyKey);
  if (!strat) return rej("REJECTED", `unknown strategy ${input.strategyKey}`);
  if (!input.contract) return rej("REJECTED", "no real contract selected");
  if (input.ttlMs != null && input.ageMs != null && input.ageMs > input.ttlMs) return rej("EXPIRED", "aged out before READY");

  const c = input.contract;
  // HARD execution gate: real OCC, non-zero usable bid/ask, executable spread, fresh option quote, liquidity.
  const gate = realOptionEntryEligible({ optionSymbol: c.optionSymbol, bid: c.bid, ask: c.ask, spreadPct: c.spreadPct, quoteAgeMs: c.quoteAgeMs, openInterest: c.openInterest, volume: c.volume }, input.gateCfg ?? defaultRealOptionEntryGate());
  if (!gate.ok) return rej("REJECTED", `contract gate: ${gate.rejections.join(",")}`);

  // freshness / chase — on the UNDERLYING (genuine chase/extension rejection). Never gate on a premium band.
  const fresh = checkEntryFreshness({ side: c.side, observedPrice: input.observedUnderlyingPrice, observedAtMs: input.observedAtMs, currentPrice: input.currentUnderlyingPrice, currentAtMs: input.currentAtMs, entryZone: null, maxChasePct: strat.chaseLimitPct, maxAgeMs: strat.freshnessMaxMs });
  if (fresh.state === "TOO_LATE") return rej("TOO_LATE", `too late: ${fresh.reason}`, fresh.reason);

  // FREEZE the option quote and compute the ONE exact entry midpoint + deterministic targets.
  const bid = c.bid as number, ask = c.ask as number;   // gate guaranteed both > 0
  const mid = entryMidpoint(bid, ask);
  const spreadPct = c.spreadPct != null ? c.spreadPct : (mid > 0 ? +(((ask - bid) / mid) * 100).toFixed(3) : 999);
  const maxMidSpread = input.maxMidpointSpreadPct ?? (input.gateCfg ?? defaultRealOptionEntryGate()).maxSpreadPct;
  // If the spread is too wide for the midpoint to be credible, reject rather than publish a misleading entry.
  if (spreadPct > maxMidSpread) return rej("REJECTED", `spread_too_wide_for_credible_midpoint (${spreadPct.toFixed(1)}% > ${maxMidSpread}%)`);
  const tg = computeOptionTargets(mid, input.strategyKey);
  const entry: FrozenEntry = { bid, ask, mid, spreadPct: +Number(spreadPct).toFixed(3), quoteAgeMs: c.quoteAgeMs, t1: tg.t1, t2: tg.t2, stop: tg.stop, methodology: tg.methodology };
  const message = formatCompactAlert({ symbol: input.symbol, side: c.side, strike: c.strike, expiration: c.expiration, entryMid: mid, t1: tg.t1, t2: tg.t2, stop: tg.stop, strategyKey: input.strategyKey });
  return { state: "READY", message, reason: "ready — deterministic strategy valid, real liquid contract, still early", freshness: "fresh", entry };
}

/** Backward-compatible compact formatter (frozen midpoint + deterministic targets, one setup line). */
export function formatCallout(input: CalloutInput): string {
  const c = input.contract!;
  const bid = c.bid ?? 0, ask = c.ask ?? 0;
  const mid = entryMidpoint(bid, ask);
  const tg = computeOptionTargets(mid, input.strategyKey);
  return formatCompactAlert({ symbol: input.symbol, side: c.side, strike: c.strike, expiration: c.expiration, entryMid: mid, t1: tg.t1, t2: tg.t2, stop: tg.stop, strategyKey: input.strategyKey });
}
