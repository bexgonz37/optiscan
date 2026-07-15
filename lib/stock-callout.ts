/**
 * stock-callout.ts — PURE compact momentum-stock day-trade card + the now-only
 * eligibility gate for a NORMAL stock Discord alert.
 *
 * A momentum-stock alert is a regular (non-options) day-trade callout. It reaches
 * the stocks webhook only when it is a HIGH-confidence, ACTIONABLE_NOW setup with a
 * valid, fresh two-sided (NBBO) quote, an acceptable spread, an aligned direction,
 * and a permitted session. Anything else — WATCH / WAIT_FOR_PULLBACK / MISSED /
 * EXTENDED / stale / no valid two-sided quote — stays in the dashboard and is NOT
 * sent. Verified live prices only; if we cannot form a realistic entry range from a
 * live two-sided quote we report NO VALID ENTRY and do not send.
 */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

export interface StockCalloutInput {
  ticker: string;
  direction: "bullish" | "bearish" | "choppy";
  /** Verified last/reference price. */
  price: number | null;
  /** Verified NBBO. */
  bid: number | null;
  ask: number | null;
  /** Quote provider timestamp (ms) for freshness. */
  quoteAsOfMs: number | null;
  /** Deterministic setup confidence 0–100 (NOT a win probability). */
  confidence: number | null;
  /** True when the capture verdict is an actionable TRADE (not WAIT/WATCH). */
  actionableNow: boolean;
  session: string; // premarket | regular | afterhours | closed
  nowMs: number;
  /** Session VWAP at alert time (for the anti-chase / extension gate). Optional. */
  vwap?: number | null;
  /** Day change % vs prior close at alert time (for the day-run chase gate). Optional. */
  dayChangePct?: number | null;
}

export interface StockGateConfig {
  minConfidence: number;   // HIGH threshold
  maxSpreadPct: number;    // acceptable NBBO spread
  maxQuoteAgeMs: number;   // freshness
  allowExtendedHours: boolean;
  /** Anti-chase: max % ABOVE session VWAP before the move is "extended" (0 disables). */
  maxVwapExtensionPct: number;
  /** Anti-chase: max % already run on the day before it is a chase (0 disables). */
  maxDayRunPct: number;
}

export function stockGateConfig(env: NodeJS.ProcessEnv = process.env): StockGateConfig {
  return {
    minConfidence: num(env.STOCK_CLEAR_MIN_CONFIDENCE, 70),
    maxSpreadPct: num(env.STOCK_MAX_SPREAD_PCT, 1.5),
    maxQuoteAgeMs: num(env.STOCK_MAX_QUOTE_AGE_MS, 15_000),
    allowExtendedHours: env.PAPER_STOCK_EXTENDED_HOURS === "1" || env.STOCK_EXTENDED_HOURS === "1",
    maxVwapExtensionPct: num(env.STOCK_MAX_VWAP_EXT_PCT, 2.5),
    maxDayRunPct: num(env.STOCK_MAX_DAY_RUN_PCT, 0),
  };
}

export interface StockEligibility { ok: boolean; reason: string }

/**
 * Anti-chase / extension check (long-only), shared by the stock Discord gate AND
 * the paper stock-scalp entry so a chase is never alerted OR paper-traded. Returns
 * a precise reason string when the move is already extended, else null. Two
 * independent guards, each using ONLY verified fields (never fabricated) and each
 * disabled by setting its threshold to 0; a guard whose field is unavailable is
 * skipped (fail-open on that dimension only).
 *   1. Day-run: already moved too far on the day (a chase).
 *   2. VWAP extension: price too far ABOVE session VWAP (top-of-candle chase).
 */
export function stockExtensionReason(
  i: { price: number | null; vwap: number | null; dayChangePct: number | null },
  cfg: StockGateConfig = stockGateConfig(),
): string | null {
  if (cfg.maxDayRunPct > 0 && isNum(i.dayChangePct) && (i.dayChangePct as number) >= cfg.maxDayRunPct) {
    return `extended: already +${(i.dayChangePct as number).toFixed(1)}% on the day (≥ ${cfg.maxDayRunPct}% chase limit) — dashboard-only, wait for a pullback`;
  }
  if (cfg.maxVwapExtensionPct > 0 && isNum(i.vwap) && isNum(i.price) && (i.vwap as number) > 0) {
    const vwapExtPct = (((i.price as number) - (i.vwap as number)) / (i.vwap as number)) * 100;
    if (vwapExtPct >= cfg.maxVwapExtensionPct) {
      return `extended: +${vwapExtPct.toFixed(1)}% above VWAP (≥ ${cfg.maxVwapExtensionPct}% chase limit) — dashboard-only, wait for a pullback into VWAP`;
    }
  }
  return null;
}

/** True when a usable two-sided NBBO quote exists (both sides, positive, not crossed). */
export function hasTwoSidedStockQuote(bid: number | null, ask: number | null): boolean {
  return isNum(bid) && isNum(ask) && (bid as number) > 0 && (ask as number) > 0 && (ask as number) >= (bid as number);
}

/** NBBO spread as a percent of the mid, or null when a side is missing. */
export function stockSpreadPct(bid: number | null, ask: number | null): number | null {
  if (!hasTwoSidedStockQuote(bid, ask)) return null;
  const mid = ((bid as number) + (ask as number)) / 2;
  return mid > 0 ? +(((ask as number) - (bid as number)) / mid * 100).toFixed(2) : null;
}

/** The now-only rule for a normal stock Discord alert. Returns a precise reason. */
export function stockNowOnlyEligible(i: StockCalloutInput, cfg: StockGateConfig = stockGateConfig()): StockEligibility {
  if (i.session === "closed") return { ok: false, reason: "market closed" };
  const extended = i.session === "premarket" || i.session === "afterhours";
  if (extended && !cfg.allowExtendedHours) return { ok: false, reason: `extended-hours (${i.session}) stock alerts disabled` };
  if (i.direction !== "bullish") return { ok: false, reason: `direction ${i.direction} not aligned (long-only stock alerts)` };
  if (!i.actionableNow) return { ok: false, reason: "not ACTIONABLE_NOW (WATCH/WAIT/MISSED stays dashboard-only)" };
  if (!isNum(i.confidence) || (i.confidence as number) < cfg.minConfidence) {
    return { ok: false, reason: `confidence ${i.confidence ?? "n/a"} < HIGH threshold ${cfg.minConfidence}` };
  }
  // ANTI-CHASE / EXTENSION GATE (long-only) — shared with the paper stock path so a
  // chase is neither alerted NOR paper-traded.
  const chase = stockExtensionReason({ price: i.price, vwap: i.vwap ?? null, dayChangePct: i.dayChangePct ?? null }, cfg);
  if (chase) return { ok: false, reason: chase };
  if (!hasTwoSidedStockQuote(i.bid, i.ask)) return { ok: false, reason: "no valid two-sided (NBBO) quote — NO VALID ENTRY" };
  if (!isNum(i.quoteAsOfMs)) {
    return { ok: false, reason: "MISSING_QUOTE_TIMESTAMP — freshness unavailable; NO VALID ENTRY" };
  }
  if (i.nowMs - (i.quoteAsOfMs as number) > cfg.maxQuoteAgeMs) {
    return { ok: false, reason: `stale quote (${Math.round((i.nowMs - (i.quoteAsOfMs as number)) / 1000)}s old)` };
  }
  const spread = stockSpreadPct(i.bid, i.ask);
  if (spread == null || spread > cfg.maxSpreadPct) return { ok: false, reason: `spread ${spread ?? "n/a"}% > ${cfg.maxSpreadPct}% limit` };
  return { ok: true, reason: "HIGH + ACTIONABLE_NOW + valid NBBO entry now" };
}

function money(v: number | null | undefined): string {
  return isNum(v) ? `$${(v as number).toFixed(2)}` : "—";
}

function sessionLabel(session: string): string {
  if (session === "regular") return "Regular Market";
  if (session === "premarket") return "Premarket";
  if (session === "afterhours") return "After-Hours";
  return session;
}

function easternClock(ts: number): string {
  const t = new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return `${t} ET`;
}

export interface StockCompactCard {
  headline: string;   // "SMCI STOCK · HIGH CONFIDENCE"
  ticker: string;
  price: string;      // "$27.18"
  entry: string;      // "$27.18–$27.24" | "NO VALID ENTRY"
  status: string;     // "ACTIONABLE NOW"
  session: string;    // "Regular Market"
  time: string;       // "12:48 PM ET"
}

/** Build the compact stock card. `entry` is a live NBBO range, else NO VALID ENTRY. */
export function stockCompactCard(i: StockCalloutInput): StockCompactCard {
  const twoSided = hasTwoSidedStockQuote(i.bid, i.ask);
  const entry = twoSided ? `${money(i.bid)}–${money(i.ask)}` : "NO VALID ENTRY";
  return {
    headline: `${i.ticker} STOCK · HIGH CONFIDENCE`,
    ticker: i.ticker,
    price: money(i.price),
    entry,
    status: "ACTIONABLE NOW",
    session: sessionLabel(i.session),
    time: easternClock(i.nowMs),
  };
}

export interface StockDiscordPayload {
  content: string;
  embed: { title: string; description: string; color: number; footer: { text: string } };
}

/** Compact stock Discord payload (only meaningful for an eligible, now-valid setup). */
export function formatStockCalloutDiscord(i: StockCalloutInput): StockDiscordPayload {
  const card = stockCompactCard(i);
  const description = [
    `Stock: ${card.ticker}`,
    `Price: ${card.price}`,
    `Entry: ${card.entry}`,
    `Status: ${card.status}`,
    `Session: ${card.session}`,
    `Time: ${card.time}`,
    "",
    "Research/paper simulation — outcomes are uncertain and never assured.",
  ].join("\n");
  return {
    content: `🟢 ${card.headline}`,
    embed: { title: `🟢 ${card.headline}`, description, color: 0x2ecc71, footer: { text: `momentum_stock · ${new Date(i.nowMs).toISOString()}` } },
  };
}
