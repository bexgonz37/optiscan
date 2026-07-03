export type Grade = "STRONG" | "GOOD" | "WATCH" | "SKIP";
export type OptionSide = "call" | "put";

export interface OptionContract {
  optionSymbol: string | null;
  side: OptionSide | string;
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  entry?: number | null;
  mid?: number | null;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  iv: number | null;
  openInterest: number;
  volume: number;
  spreadPct: number | null;
  breakeven?: number | null;
}

export interface MomentumRow {
  symbol: string | null;
  name?: string | null;
  bias: string;
  side: OptionSide | null;
  score: number;
  grade: Grade;
  momentumScore: number;
  underlyingPrice: number | null;
  movePct: number;
  priceVsVwapPct: number | null;
  rsi: number | null;
  relVol: number | null;
  trend: string;
  contract: OptionContract | null;
  reason: string;
  reasons: string[];
  warnings: string[];
}

export interface UnusualRow {
  symbol: string | null;
  name?: string | null;
  optionSymbol: string | null;
  side: OptionSide | string;
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  volume: number;
  openInterest: number;
  volOiRatio: number | null;
  newPositioning: boolean;
  mid: number | null;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  delta: number | null;
  iv: number | null;
  underlyingPrice: number | null;
  score: number;
  grade: Grade;
  reason: string;
  reasons: string[];
}

export interface ScanMeta {
  generatedAt: string;
  provider: string;
  keyPresent: boolean;
  note?: string;
  universeCount: number;
  scannedCount: number;
  scanned: string[];
  errors: { symbol: string; message: string }[];
}

export interface ScanResult extends ScanMeta {
  momentum: MomentumRow[];
  unusual: UnusualRow[];
}

export interface SymbolDetail extends ScanMeta {
  symbol: string;
  quote: {
    symbol: string;
    name?: string | null;
    price: number | null;
    changePercent: number | null;
    volume: number | null;
  } | null;
  momentum: MomentumRow | null;
  unusual: UnusualRow[];
  contracts: OptionContract[];
}
