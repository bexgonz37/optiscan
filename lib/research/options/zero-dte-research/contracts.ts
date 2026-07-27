/**
 * Contract selection for 0DTE research — real quotes only; log ATM/ITM/OTM alts.
 */

export interface ChainContract {
  optionSymbol: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  volume?: number | null;
  openInterest?: number | null;
  iv?: number | null;
  quoteAgeMs?: number | null;
  providerTimestamp?: number | null;
}

export type Moneyness = "ATM" | "ITM1" | "OTM1";
export type DeltaBand = "0.35-0.45" | "0.45-0.55" | "0.55-0.65";

export interface ContractAlt {
  moneyness: Moneyness;
  optionSymbol: string;
  strike: number;
  delta: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadPct: number | null;
}

function mid(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || bid <= 0 || ask <= 0) return null;
  return +(((bid + ask) / 2)).toFixed(4);
}

function spreadPct(bid: number | null, ask: number | null): number | null {
  const m = mid(bid, ask);
  if (m == null || m <= 0 || bid == null || ask == null) return null;
  return +(((ask - bid) / m) * 100).toFixed(3);
}

function usable(c: ChainContract, maxSpreadPct = 12, maxAgeMs = 15_000): boolean {
  if (!c.optionSymbol?.startsWith("O:")) return false;
  if (c.dte !== 0) return false;
  if (c.bid == null || c.ask == null || c.bid <= 0 || c.ask <= 0) return false;
  const sp = spreadPct(c.bid, c.ask);
  if (sp == null || sp > maxSpreadPct) return false;
  if (c.quoteAgeMs != null && c.quoteAgeMs > maxAgeMs) return false;
  return true;
}

function deltaBandOf(absDelta: number): DeltaBand | null {
  if (absDelta >= 0.35 && absDelta < 0.45) return "0.35-0.45";
  if (absDelta >= 0.45 && absDelta < 0.55) return "0.45-0.55";
  if (absDelta >= 0.55 && absDelta <= 0.65) return "0.55-0.65";
  return null;
}

export function selectZeroDteContracts(input: {
  chain: ChainContract[];
  side: "call" | "put";
  underlyingPrice: number;
  preferredAbsDelta?: number;
}): {
  primary: ChainContract | null;
  moneyness: Moneyness | null;
  deltaBand: DeltaBand | null;
  alts: ContractAlt[];
  reason: string | null;
} {
  const side = input.side;
  const spot = input.underlyingPrice;
  const preferred = input.preferredAbsDelta ?? 0.5;
  const pool = input.chain.filter((c) => c.side === side && usable(c));
  if (!pool.length) return { primary: null, moneyness: null, deltaBand: null, alts: [], reason: "no_usable_0dte_quotes" };

  const byStrike = [...pool].sort((a, b) => a.strike - b.strike);
  const atm = byStrike.reduce((best, c) =>
    Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best, byStrike[0]);
  const atmIdx = byStrike.findIndex((c) => c.optionSymbol === atm.optionSymbol);
  const itm1 = side === "call"
    ? byStrike.slice(0, atmIdx).reverse()[0] ?? null
    : byStrike.slice(atmIdx + 1)[0] ?? null;
  const otm1 = side === "call"
    ? byStrike.slice(atmIdx + 1)[0] ?? null
    : byStrike.slice(0, atmIdx).reverse()[0] ?? null;

  const withDelta = pool.filter((c) => c.delta != null && Number.isFinite(c.delta));
  const primary = (withDelta.length
    ? withDelta.reduce((best, c) =>
      Math.abs(Math.abs(Number(c.delta)) - preferred) < Math.abs(Math.abs(Number(best.delta)) - preferred) ? c : best, withDelta[0])
    : atm);

  let moneyness: Moneyness = "ATM";
  if (itm1 && primary.optionSymbol === itm1.optionSymbol) moneyness = "ITM1";
  else if (otm1 && primary.optionSymbol === otm1.optionSymbol) moneyness = "OTM1";
  else if (Math.abs(primary.strike - spot) <= Math.abs(atm.strike - spot) + 1e-9) moneyness = "ATM";
  else if (side === "call" ? primary.strike < spot : primary.strike > spot) moneyness = "ITM1";
  else moneyness = "OTM1";

  const alts: ContractAlt[] = [];
  for (const [label, c] of [["ATM", atm], ["ITM1", itm1], ["OTM1", otm1]] as const) {
    if (!c) continue;
    alts.push({
      moneyness: label,
      optionSymbol: c.optionSymbol,
      strike: c.strike,
      delta: c.delta,
      bid: c.bid,
      ask: c.ask,
      mid: mid(c.bid, c.ask),
      spreadPct: spreadPct(c.bid, c.ask),
    });
  }

  const absD = primary.delta != null ? Math.abs(Number(primary.delta)) : null;
  return {
    primary,
    moneyness,
    deltaBand: absD != null ? deltaBandOf(absD) : null,
    alts,
    reason: null,
  };
}
