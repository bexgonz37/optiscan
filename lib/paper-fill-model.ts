/**
 * paper-fill-model.ts — deterministic, conservative simulated fills (rebuild).
 *
 * PURE: no I/O, no DB, no clock in the OUTPUT (the caller passes nowMs). Given a
 * verified two-sided quote it decides IF and at WHAT PRICE an order fills, plus
 * the exact slippage and fee assumptions applied — which are recorded verbatim
 * in the immutable entry/exit snapshots.
 *
 * Rules (deliberately conservative — paper must understate, never flatter):
 *  - Long entries pay the ASK (never the mid) plus bounded slippage, capped at
 *    the order limit — a limit order never fills above its limit.
 *  - Exits leave at the BID minus bounded slippage (floored at 0).
 *  - NO fill on a missing / one-sided / crossed / stale / out-of-limit quote,
 *    or when the spread-protection gate fails.
 *  - Slippage and fees are configurable and deterministic; nothing about L2
 *    depth, queue position, or market impact is fabricated.
 *  - Partial fills are structurally representable but DISABLED by default this
 *    phase (no verified market depth) — simulateFill only ever returns full or
 *    no fill.
 */
import type { MarketSession } from "./trading-session.ts";
import type { OptionQuote } from "./execution/broker.ts";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface FillConfig {
  /** Fraction of the absolute spread added to the ask on entry. */
  entrySlippageFrac: number;
  /** Fraction of the absolute spread subtracted from the bid on exit. */
  exitSlippageFrac: number;
  /** Hard cap on per-unit slippage in dollars. */
  maxSlippageAbs: number;
  /** Commission per option contract (per side). */
  feePerContract: number;
  /** Commission per share (per side). */
  feePerShare: number;
  /** Multiplier applied to slippage in premarket/afterhours (wider markets). */
  extendedSlippageMultiplier: number;
  /** Reject a fill when the quoted spread exceeds this percent. */
  maxSpreadPct: number;
  /** Max quote age (ms) before a quote is treated as stale (no fill). */
  maxQuoteAgeMs: number;
}

export function defaultFillConfig(env: NodeJS.ProcessEnv = process.env): FillConfig {
  const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    entrySlippageFrac: num(env.PAPER_ENTRY_SLIPPAGE_FRAC, 0.25),
    exitSlippageFrac: num(env.PAPER_EXIT_SLIPPAGE_FRAC, 0.25),
    maxSlippageAbs: num(env.PAPER_MAX_SLIPPAGE_ABS, 0.05),
    feePerContract: num(env.PAPER_FEE_PER_CONTRACT, 0.65),
    feePerShare: num(env.PAPER_FEE_PER_SHARE, 0),
    extendedSlippageMultiplier: num(env.PAPER_EXTENDED_SLIPPAGE_MULT, 2),
    maxSpreadPct: num(env.PAPER_FILL_MAX_SPREAD_PCT, 15),
    maxQuoteAgeMs: num(env.PAPER_FILL_MAX_QUOTE_AGE_MS, 60_000),
  };
}

export type FillSide = "buy_to_open" | "sell_to_close";
export type FillAsset = "option" | "stock";

export interface FillRequest {
  side: FillSide;
  assetClass: FillAsset;
  /** Contracts (options) or shares (stock). */
  units: number;
  /** Premium/price limit. Entry fills only when marketable at/under it; exits use it for target-limit fills, else null for stop/market-style exits. */
  limit: number | null;
  session: MarketSession;
  /** For exits triggered by stop/smart (leave at bid − slippage regardless of a resting limit). */
  marketableExit?: boolean;
}

/** The assumptions applied to a fill — recorded immutably in the snapshot. */
export interface FillAssumptions {
  entrySlippageFrac: number;
  exitSlippageFrac: number;
  maxSlippageAbs: number;
  feePerUnit: number;
  extendedSlippageMultiplier: number;
  session: MarketSession;
  slippageApplied: number;
}

export interface FillResult {
  filled: boolean;
  /** Per-unit fill price BEFORE fees (fees are a separate line). */
  price: number | null;
  /** Total fees for this fill (all units). */
  fees: number;
  reason: string;
  assumptions: FillAssumptions | null;
}

function usableQuote(q: OptionQuote, cfg: FillConfig, nowMs: number): { ok: boolean; reason: string } {
  if (!isNum(q.bid) || !isNum(q.ask)) return { ok: false, reason: "one-sided or missing quote" };
  if (q.bid <= 0 || q.ask <= 0) return { ok: false, reason: "non-positive quote" };
  if (q.ask < q.bid) return { ok: false, reason: "crossed quote (ask < bid)" };
  if (isNum(q.asOfMs) && nowMs - q.asOfMs > cfg.maxQuoteAgeMs) {
    return { ok: false, reason: `stale quote (${Math.round((nowMs - (q.asOfMs as number)) / 1000)}s old > ${Math.round(cfg.maxQuoteAgeMs / 1000)}s)` };
  }
  const spreadPct = isNum(q.spreadPct) ? q.spreadPct : (q.ask > 0 ? ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100 : Infinity);
  if (spreadPct > cfg.maxSpreadPct) return { ok: false, reason: `spread ${spreadPct.toFixed(1)}% > ${cfg.maxSpreadPct}% fill limit` };
  return { ok: true, reason: "usable" };
}

function slippageFor(spreadAbs: number, frac: number, session: MarketSession, cfg: FillConfig): number {
  const extended = session === "premarket" || session === "afterhours";
  const raw = spreadAbs * frac * (extended ? cfg.extendedSlippageMultiplier : 1);
  return Math.max(0, Math.min(raw, cfg.maxSlippageAbs));
}

/**
 * Simulate a single fill. Returns full-or-no fill (partials disabled this phase).
 * `units` may be contracts or shares; fee-per-unit is chosen by asset class.
 */
export function simulateFill(req: FillRequest, quote: OptionQuote, cfg: FillConfig, nowMs: number): FillResult {
  const feePerUnit = req.assetClass === "stock" ? cfg.feePerShare : cfg.feePerContract;
  const baseAssumptions = (slippageApplied: number): FillAssumptions => ({
    entrySlippageFrac: cfg.entrySlippageFrac,
    exitSlippageFrac: cfg.exitSlippageFrac,
    maxSlippageAbs: cfg.maxSlippageAbs,
    feePerUnit,
    extendedSlippageMultiplier: cfg.extendedSlippageMultiplier,
    session: req.session,
    slippageApplied,
  });
  const noFill = (reason: string): FillResult => ({ filled: false, price: null, fees: 0, reason, assumptions: null });

  if (!isNum(req.units) || req.units <= 0) return noFill("invalid unit count");
  const chk = usableQuote(quote, cfg, nowMs);
  if (!chk.ok) return noFill(chk.reason);

  const bid = quote.bid as number;
  const ask = quote.ask as number;
  const spreadAbs = ask - bid;
  const fees = +(feePerUnit * req.units).toFixed(2);

  if (req.side === "buy_to_open") {
    const slip = slippageFor(spreadAbs, cfg.entrySlippageFrac, req.session, cfg);
    // Marketable only when the ask is at/under the limit; never fill above limit.
    if (req.limit != null && ask > req.limit) {
      return noFill(`ask ${ask.toFixed(2)} above limit ${req.limit.toFixed(2)} — not marketable`);
    }
    const raw = ask + slip;
    const price = req.limit != null ? Math.min(raw, req.limit) : raw;
    return { filled: true, price: +price.toFixed(4), fees, reason: `entry at ask ${ask.toFixed(2)} + slip ${slip.toFixed(2)} (cap limit ${req.limit ?? "none"})`, assumptions: baseAssumptions(+(price - ask).toFixed(4)) };
  }

  // sell_to_close
  const slip = slippageFor(spreadAbs, cfg.exitSlippageFrac, req.session, cfg);
  if (!req.marketableExit && req.limit != null && bid < req.limit) {
    return noFill(`bid ${bid.toFixed(2)} below target limit ${req.limit.toFixed(2)}`);
  }
  const price = Math.max(0, bid - slip);
  return { filled: true, price: +price.toFixed(4), fees, reason: `exit at bid ${bid.toFixed(2)} − slip ${slip.toFixed(2)}`, assumptions: baseAssumptions(+(bid - price).toFixed(4)) };
}

/** Intrinsic value at expiration from the underlying (worthless when OTM). */
export function intrinsicValue(optionType: "call" | "put", strike: number | null, underlying: number | null): number {
  if (!isNum(strike) || !isNum(underlying)) return 0;
  const raw = optionType === "call" ? underlying - strike : strike - underlying;
  return raw > 0 ? +raw.toFixed(4) : 0;
}
