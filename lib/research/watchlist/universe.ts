/**
 * universe.ts — PURE candidate universe for the professional Watchlist.
 *
 * The universe is the set of symbols we are ALLOWED to consider. It is not a
 * prediction and it is not a plan: a symbol reaches the published Watchlist only
 * by carrying deterministic setup evidence (see setup-families.ts).
 *
 * Two kinds of membership:
 *  - STATIC tiers (index/sector ETFs, large-cap liquid options names) are fixed
 *    lists reviewed by a human. They never change at runtime.
 *  - EVIDENCE tiers (high-volume momentum, confirmed catalyst) are supplied by
 *    the caller from real observations. Nothing is invented here.
 *
 * Every candidate must additionally carry evidence of LIQUID OPTIONS. A symbol
 * with no options-liquidity evidence is excluded with a reason, never assumed.
 */

export type UniverseTier =
  | "CORE_INDEX"
  | "SECTOR_ETF"
  | "LARGE_CAP_LIQUID"
  | "HIGH_VOLUME_MOMENTUM"
  | "CONFIRMED_CATALYST";

/** SPY, QQQ, IWM — always considered. */
export const CORE_INDEX_SYMBOLS = ["SPY", "QQQ", "IWM"] as const;

/** Liquid index and sector ETFs with deep, continuously quoted options. */
export const SECTOR_ETF_SYMBOLS = [
  "DIA", "SMH", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU",
  "XLB", "XLRE", "XLC", "XBI", "XOP", "KRE", "GLD", "SLV", "TLT", "HYG",
  "EEM", "EFA", "FXI", "ARKK", "IBIT",
] as const;

/** Large-cap names with continuously quoted, multi-expiry options chains. */
export const LARGE_CAP_LIQUID_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX",
  "JPM", "BAC", "WFC", "GS", "V", "MA", "UNH", "LLY", "JNJ", "PFE",
  "XOM", "CVX", "COP", "WMT", "COST", "HD", "MCD", "NKE", "DIS", "CRM",
  "ORCL", "ADBE", "INTC", "MU", "QCOM", "TXN", "PLTR", "UBER", "COIN", "MSTR",
  "SMCI", "ARM", "BA", "CAT", "GE", "T", "VZ", "PYPL", "SHOP", "SQ",
] as const;

const STATIC_TIERS: Array<{ tier: UniverseTier; symbols: readonly string[] }> = [
  { tier: "CORE_INDEX", symbols: CORE_INDEX_SYMBOLS },
  { tier: "SECTOR_ETF", symbols: SECTOR_ETF_SYMBOLS },
  { tier: "LARGE_CAP_LIQUID", symbols: LARGE_CAP_LIQUID_SYMBOLS },
];

/** Observed high-volume momentum name. Supplied from real scanner evidence. */
export interface MomentumCandidate {
  symbol: string;
  /** Completed-session dollar volume. */
  dollarVolume: number;
  /** Completed-session absolute percent move. */
  absMovePct: number;
  observedAtMs: number;
}

/** A caller-CONFIRMED earnings or catalyst name. Never derived from price. */
export interface CatalystCandidate {
  symbol: string;
  label: string;
  kind: "EARNINGS" | "CATALYST";
  confirmedAtMs: number;
  source: string;
}

/** Evidence that a symbol genuinely has tradable options. */
export interface OptionsLiquidityEvidence {
  symbol: string;
  /** Total open interest across the near expirations examined. */
  openInterest: number | null;
  /** Total option contract volume in the completed session. */
  contractVolume: number | null;
  /** Tightest observed near-the-money bid/ask spread, in percent of mid. */
  tightestSpreadPct: number | null;
  observedAtMs: number;
}

export interface UniverseCandidate {
  symbol: string;
  tiers: UniverseTier[];
  catalyst: CatalystCandidate | null;
  optionsLiquidity: OptionsLiquidityEvidence | null;
}

export interface ExcludedCandidate {
  symbol: string;
  reason: string;
}

export interface BuildUniverseInput {
  momentum?: MomentumCandidate[] | null;
  catalysts?: CatalystCandidate[] | null;
  optionsLiquidity?: OptionsLiquidityEvidence[] | null;
  nowMs: number;
  /** Overrides for the momentum admission floors. */
  minMomentumDollarVolume?: number;
  minMomentumAbsMovePct?: number;
}

export interface WatchlistUniverse {
  candidates: UniverseCandidate[];
  excluded: ExcludedCandidate[];
  /** Symbols admitted per tier, for diagnostics. */
  tierCounts: Record<UniverseTier, number>;
}

// Admission floors for the evidence tier. A name below either floor is not a
// "high-volume momentum name"; it is just a mover.
const MIN_MOMENTUM_DOLLAR_VOLUME = 50_000_000;
const MIN_MOMENTUM_ABS_MOVE_PCT = 3.0;

// Options-liquidity floors. These describe an options market a retail order can
// actually work in; a symbol failing any of them is excluded with its reason.
const MIN_OPEN_INTEREST = 500;
const MIN_CONTRACT_VOLUME = 100;
const MAX_SPREAD_PCT = 15;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const norm = (s: unknown) => String(s ?? "").trim().toUpperCase();

/**
 * Does this symbol have evidence of a liquid options market?
 * Missing evidence is NOT a pass — it is an explicit exclusion.
 */
export function optionsLiquidityVerdict(
  evidence: OptionsLiquidityEvidence | null | undefined,
): { liquid: boolean; reason: string | null } {
  if (!evidence) return { liquid: false, reason: "No options liquidity evidence" };
  const oi = isNum(evidence.openInterest) ? evidence.openInterest : null;
  const vol = isNum(evidence.contractVolume) ? evidence.contractVolume : null;
  const spread = isNum(evidence.tightestSpreadPct) ? evidence.tightestSpreadPct : null;
  if (oi == null || vol == null || spread == null) return { liquid: false, reason: "Incomplete options liquidity evidence" };
  if (oi < MIN_OPEN_INTEREST) return { liquid: false, reason: `Open interest ${oi} below ${MIN_OPEN_INTEREST}` };
  if (vol < MIN_CONTRACT_VOLUME) return { liquid: false, reason: `Contract volume ${vol} below ${MIN_CONTRACT_VOLUME}` };
  if (spread > MAX_SPREAD_PCT) return { liquid: false, reason: `Tightest spread ${spread.toFixed(1)}% wider than ${MAX_SPREAD_PCT}%` };
  return { liquid: true, reason: null };
}

/**
 * Build the candidate universe. Deterministic and order-stable: identical input
 * always produces identical output.
 */
export function buildWatchlistUniverse(input: BuildUniverseInput): WatchlistUniverse {
  const minDollarVolume = input.minMomentumDollarVolume ?? MIN_MOMENTUM_DOLLAR_VOLUME;
  const minMovePct = input.minMomentumAbsMovePct ?? MIN_MOMENTUM_ABS_MOVE_PCT;
  const tiersBySymbol = new Map<string, Set<UniverseTier>>();
  const excluded: ExcludedCandidate[] = [];

  const addTier = (symbol: string, tier: UniverseTier) => {
    const s = norm(symbol);
    if (!s || !/^[A-Z][A-Z.]{0,5}$/.test(s)) return;
    if (!tiersBySymbol.has(s)) tiersBySymbol.set(s, new Set());
    tiersBySymbol.get(s)!.add(tier);
  };

  for (const { tier, symbols } of STATIC_TIERS) for (const s of symbols) addTier(s, tier);

  for (const m of input.momentum ?? []) {
    const s = norm(m?.symbol);
    if (!s) continue;
    if (!isNum(m.observedAtMs) || m.observedAtMs > input.nowMs) {
      excluded.push({ symbol: s, reason: "Momentum evidence is not from a completed observation" });
      continue;
    }
    if (!isNum(m.dollarVolume) || m.dollarVolume < minDollarVolume) {
      excluded.push({ symbol: s, reason: "Below the high-volume momentum dollar-volume floor" });
      continue;
    }
    if (!isNum(m.absMovePct) || Math.abs(m.absMovePct) < minMovePct) {
      excluded.push({ symbol: s, reason: "Below the high-volume momentum move floor" });
      continue;
    }
    addTier(s, "HIGH_VOLUME_MOMENTUM");
  }

  const catalystBySymbol = new Map<string, CatalystCandidate>();
  for (const c of input.catalysts ?? []) {
    const s = norm(c?.symbol);
    if (!s) continue;
    if (!c.label || !String(c.label).trim() || !c.source || !String(c.source).trim()) {
      excluded.push({ symbol: s, reason: "Catalyst is not confirmed with a label and source" });
      continue;
    }
    if (!isNum(c.confirmedAtMs) || c.confirmedAtMs > input.nowMs) {
      excluded.push({ symbol: s, reason: "Catalyst confirmation is not in the past" });
      continue;
    }
    catalystBySymbol.set(s, { ...c, symbol: s });
    addTier(s, "CONFIRMED_CATALYST");
  }

  const liquidityBySymbol = new Map<string, OptionsLiquidityEvidence>();
  for (const e of input.optionsLiquidity ?? []) {
    const s = norm(e?.symbol);
    if (!s) continue;
    if (!isNum(e.observedAtMs) || e.observedAtMs > input.nowMs) continue;
    liquidityBySymbol.set(s, { ...e, symbol: s });
  }

  const candidates: UniverseCandidate[] = [];
  for (const symbol of [...tiersBySymbol.keys()].sort()) {
    const liquidity = liquidityBySymbol.get(symbol) ?? null;
    const verdict = optionsLiquidityVerdict(liquidity);
    if (!verdict.liquid) {
      excluded.push({ symbol, reason: verdict.reason ?? "No liquid options" });
      continue;
    }
    candidates.push({
      symbol,
      tiers: [...tiersBySymbol.get(symbol)!].sort(),
      catalyst: catalystBySymbol.get(symbol) ?? null,
      optionsLiquidity: liquidity,
    });
  }

  const tierCounts = {
    CORE_INDEX: 0, SECTOR_ETF: 0, LARGE_CAP_LIQUID: 0,
    HIGH_VOLUME_MOMENTUM: 0, CONFIRMED_CATALYST: 0,
  } as Record<UniverseTier, number>;
  for (const c of candidates) for (const t of c.tiers) tierCounts[t] += 1;

  return {
    candidates,
    excluded: excluded.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.reason.localeCompare(b.reason)),
    tierCounts,
  };
}

/** Every symbol the static tiers can ever admit. Useful for provider batching. */
export function staticUniverseSymbols(): string[] {
  const out = new Set<string>();
  for (const { symbols } of STATIC_TIERS) for (const s of symbols) out.add(s);
  return [...out].sort();
}
