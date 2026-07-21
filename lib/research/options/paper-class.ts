/**
 * lib/research/options/paper-class.ts — classify every paper result into ONE non-overlapping
 * category (Options paper audit, part I). PURE. These categories must NEVER be combined in a win
 * rate; reporting keeps them separate (section L).
 *
 *   EQUITY_PAPER                              — a stock paper trade (no option contract).
 *   REAL_OPTION_PAPER                         — a real OCC contract with real bid/ask, option P&L.
 *   MODELED_OPTION_RESEARCH                   — an option outcome derived by a model (Greeks reprice),
 *                                               NOT a real fill. Research only.
 *   UNDERLYING_PROXY_INVALID_FOR_OPTIONS_CLAIMS — an option "claim" whose P&L came from the underlying
 *                                               proxy (invalid to present as an option result).
 */
export type PaperResultClass = "EQUITY_PAPER" | "REAL_OPTION_PAPER" | "MODELED_OPTION_RESEARCH" | "UNDERLYING_PROXY_INVALID_FOR_OPTIONS_CLAIMS";

export interface PaperRow {
  optionSymbol?: string | null;     // OCC contract symbol, when this is an option trade
  assetClass?: string | null;       // 'stock' | 'options'
  entryBid?: number | null;
  entryAsk?: number | null;
  entryPrice?: number | null;
  pnlBasis?: string | null;         // 'option' | 'underlying' | null
  outcomeKind?: string | null;      // 'REAL' | 'MODELED_OPTION' | null
}

const OCC = /^O:[A-Z]{1,6}\d{6}[CP]\d{8}$/; // Polygon/OCC option symbol shape

export interface PaperClassResult { class: PaperResultClass; reasons: string[]; realExecutable: boolean }

export function classifyPaperResult(row: PaperRow): PaperClassResult {
  const reasons: string[] = [];
  const hasOption = Boolean(row.optionSymbol) || row.assetClass === "options";
  if (!hasOption) return { class: "EQUITY_PAPER", reasons: ["no option contract"], realExecutable: true };

  const validOcc = typeof row.optionSymbol === "string" && OCC.test(row.optionSymbol);
  if (!validOcc) reasons.push("no valid OCC contract symbol");
  const twoSided = row.entryBid != null && row.entryAsk != null && row.entryBid > 0 && row.entryAsk > 0;
  if (!twoSided) reasons.push("missing real two-sided bid/ask");

  if (row.outcomeKind === "MODELED_OPTION") { reasons.push("outcome is a modeled Greeks reprice, not a real fill"); return { class: "MODELED_OPTION_RESEARCH", reasons, realExecutable: false }; }
  if (row.pnlBasis === "underlying") { reasons.push("P&L computed from the underlying proxy — invalid for an option claim"); return { class: "UNDERLYING_PROXY_INVALID_FOR_OPTIONS_CLAIMS", reasons, realExecutable: false }; }

  if (validOcc && twoSided && (row.pnlBasis == null || row.pnlBasis === "option")) {
    return { class: "REAL_OPTION_PAPER", reasons: ["real OCC contract + two-sided quote + option P&L"], realExecutable: true };
  }
  // Has an option context but cannot be certified as a real option fill.
  return { class: "MODELED_OPTION_RESEARCH", reasons: reasons.length ? reasons : ["insufficient evidence for a real option fill"], realExecutable: false };
}

/** Gate for REAL_OPTION_PAPER eligibility BEFORE entry (revalidation): real OCC + fresh two-sided
 *  quote + not zero-bid + not excessively wide. Never fabricates a fill. */
export interface RealOptionEntryGateInput { optionSymbol: string | null; bid: number | null; ask: number | null; spreadPct: number | null; quoteAgeMs: number | null; openInterest: number | null; volume: number | null }
export interface RealOptionEntryGateCfg { maxSpreadPct: number; maxQuoteAgeMs: number; minOpenInterest: number; minVolume: number }
export function defaultRealOptionEntryGate(env: NodeJS.ProcessEnv = process.env): RealOptionEntryGateCfg {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return { maxSpreadPct: n(env.REAL_OPT_MAX_SPREAD_PCT, 10), maxQuoteAgeMs: n(env.REAL_OPT_MAX_QUOTE_AGE_MS, 15_000), minOpenInterest: n(env.REAL_OPT_MIN_OI, 500), minVolume: n(env.REAL_OPT_MIN_VOL, 50) };
}
export function realOptionEntryEligible(i: RealOptionEntryGateInput, cfg: RealOptionEntryGateCfg = defaultRealOptionEntryGate()): { ok: boolean; rejections: string[] } {
  const r: string[] = [];
  if (!i.optionSymbol || !OCC.test(i.optionSymbol)) r.push("no_valid_occ");
  if (i.bid == null || i.bid <= 0) r.push("zero_bid");
  if (i.ask == null || i.ask <= 0) r.push("no_ask");
  if (i.spreadPct != null && i.spreadPct > cfg.maxSpreadPct) r.push("spread_too_wide");
  if (i.quoteAgeMs != null && i.quoteAgeMs > cfg.maxQuoteAgeMs) r.push("stale_quote");
  if ((i.openInterest ?? 0) < cfg.minOpenInterest) r.push("insufficient_oi");
  if ((i.volume ?? 0) < cfg.minVolume) r.push("insufficient_volume");
  return { ok: r.length === 0, rejections: r };
}
