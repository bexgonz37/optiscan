import type { OptionContract } from "@/lib/types";

export interface Economics {
  premium: number | null; // per share (mid)
  debitPerContract: number | null; // premium * 100
  maxLoss: number | null; // = debit for a long option
  maxProfit: number | null; // null => unbounded (long call)
  breakeven: number | null;
  toBreakevenPct: number | null; // move needed from underlying to breakeven
}

/**
 * Single-leg long-option economics. OptiScan signals are long calls/puts, so the
 * math is exact: max loss = premium paid, breakeven = strike ± premium.
 */
export function economics(contract: OptionContract | null, underlyingPrice: number | null): Economics {
  const premium = contract?.entry ?? contract?.mid ?? null;
  const strike = contract?.strike ?? null;
  const isCall = contract?.side === "call";
  if (premium == null || strike == null) {
    return { premium, debitPerContract: null, maxLoss: null, maxProfit: null, breakeven: null, toBreakevenPct: null };
  }
  const debit = +(premium * 100).toFixed(0);
  const breakeven = isCall ? +(strike + premium).toFixed(2) : +(strike - premium).toFixed(2);
  const maxProfit = isCall ? null : +((strike - premium) * 100).toFixed(0);
  let toBreakevenPct: number | null = null;
  if (underlyingPrice && underlyingPrice > 0) {
    toBreakevenPct = +(((breakeven - underlyingPrice) / underlyingPrice) * 100).toFixed(2);
  }
  return { premium, debitPerContract: debit, maxLoss: debit, maxProfit, breakeven, toBreakevenPct };
}

export interface PayoffData {
  prices: number[];
  pnl: number[]; // per contract ($)
  breakeven: number | null;
  minPrice: number;
  maxPrice: number;
}

/** Build a payoff-at-expiration curve for a single long option. */
export function payoffCurve(
  contract: OptionContract | null,
  underlyingPrice: number | null,
  steps = 60,
): PayoffData | null {
  const premium = contract?.entry ?? contract?.mid ?? null;
  const strike = contract?.strike ?? null;
  if (premium == null || strike == null) return null;
  const isCall = contract?.side === "call";
  const center = underlyingPrice && underlyingPrice > 0 ? underlyingPrice : strike;
  const span = Math.max(center * 0.25, Math.abs(strike - center) * 1.6, premium * 6);
  const minPrice = Math.max(0, center - span);
  const maxPrice = center + span;

  const prices: number[] = [];
  const pnl: number[] = [];
  for (let i = 0; i < steps; i++) {
    const s = minPrice + ((maxPrice - minPrice) * i) / (steps - 1);
    const intrinsic = isCall ? Math.max(s - strike, 0) : Math.max(strike - s, 0);
    prices.push(s);
    pnl.push(+((intrinsic - premium) * 100).toFixed(2));
  }
  const breakeven = isCall ? strike + premium : strike - premium;
  return { prices, pnl, breakeven, minPrice, maxPrice };
}
