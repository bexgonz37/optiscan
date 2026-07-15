/**
 * bullish-direction.ts — PURE, deterministic hard invariant for the BULLISH stock
 * momentum Discord channel. No AI, no provider calls, no clock in the output.
 *
 * The failure this exists to prevent (META, after-hours): a stock that closed the
 * regular session up (+4.7%) but is CURRENTLY FALLING in after-hours fired a
 * "moving upward quickly right now" alert because (a) the day-move field carried
 * the stale regular-session gain and (b) a momentary positive velocity blip during
 * the decline satisfied the velocity gate. The fix is to require SESSION-CURRENT
 * upward evidence — positive short-window returns measured from live ticks in the
 * CURRENT session — and to NEVER treat the regular-session day gain as proof of
 * current bullish momentum.
 *
 * A ticker may be red on the full day yet genuinely accelerating up in extended
 * hours: that is allowed, because the invariant judges only current-session
 * evidence (it never references the day move). A weak bounce inside a decline is
 * rejected because its 30s/60s returns are not both positive. There is therefore
 * no separate "reversal threshold" — a reversal must clear the exact same
 * current-session bar as any other bullish setup.
 */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);

export type Session = "premarket" | "regular" | "afterhours" | "closed";

/** Classifications permitted to fire a live bullish alert (EARLY_CONTINUATION == CONTINUATION). */
export const BULLISH_ALLOWED_CLASSES = new Set(["FRESH_ACCELERATION", "CONTINUATION"]);

export interface BullishDirectionInput {
  session: Session;
  direction: string | null;
  /** Velocity %/min over the short window (signed). */
  shortRate: number | null;
  /** Session-current trailing returns (%). */
  ret10sPct: number | null;
  ret30sPct: number | null;
  ret60sPct: number | null;
  /** Above session VWAP / recent base? */
  aboveVwap: boolean | null;
  /** Broke the session high / recent breakout level? */
  hodBreak: boolean;
  classification: string | null;
  /** Extension above VWAP / recent base (%). */
  vwapDistPct: number | null;
  /** Quote age (ms) at evaluation — freshness. */
  quoteAgeMs: number | null;
}

export interface BullishDirectionConfig {
  maxQuoteAgeMs: number;
  minShortRatePctMin: number;   // required positive velocity
  minRet10sPct: number;         // required positive 10s return
  minRet30sPct: number;         // required positive 30s return
  maxRet60sGivebackPct: number; // reject if 60s return is more negative than this (a bounce inside a decline)
  maxVwapExtPct: number;        // reject when too extended above the base
  requireAboveBase: boolean;    // require aboveVwap!=false OR hodBreak
}

/**
 * Session-aware config. Extended-hours (premarket / after-hours) markets are
 * thinner and noisier, so they demand a bit MORE current-session evidence than
 * regular hours — never less. All bounded + env-tunable + documented.
 */
export function bullishDirectionConfig(session: Session, env: NodeJS.ProcessEnv = process.env): BullishDirectionConfig {
  const extended = session === "premarket" || session === "afterhours";
  return {
    maxQuoteAgeMs: num(env.STOCK_MAX_QUOTE_AGE_MS, 15_000),
    minShortRatePctMin: num(env.BULLISH_MIN_SHORT_RATE_PCT_MIN, extended ? 0.20 : 0.15),
    minRet10sPct: num(env.BULLISH_MIN_RET10S_PCT, extended ? 0.05 : 0.03),
    minRet30sPct: num(env.BULLISH_MIN_RET30S_PCT, extended ? 0.06 : 0.03),
    maxRet60sGivebackPct: num(env.BULLISH_MAX_RET60S_GIVEBACK_PCT, extended ? 0.05 : 0.10),
    maxVwapExtPct: num(env.STOCK_MAX_VWAP_EXT_PCT, 2.5),
    requireAboveBase: env.BULLISH_REQUIRE_ABOVE_BASE !== "0",
  };
}

export interface BullishDirectionVerdict {
  ok: boolean;
  reason: string;
  /** Machine-readable code of the first failed invariant (null when ok). */
  failedInvariant: string | null;
  /** True direction status derived from CURRENT-session evidence, for persistence. */
  currentDirection: "up" | "down" | "flat";
}

function currentDirectionOf(i: BullishDirectionInput): "up" | "down" | "flat" {
  const signals = [i.ret10sPct, i.ret30sPct, i.shortRate].filter(isNum) as number[];
  if (!signals.length) return "flat";
  const sum = signals.reduce((s, v) => s + Math.sign(v), 0);
  return sum > 0 ? "up" : sum < 0 ? "down" : "flat";
}

/**
 * The hard bullish invariant. Returns ok only when EVERY current-session
 * condition holds. The order is chosen so the reported reason is the most
 * fundamental failure. Never references the regular-session day move.
 */
export function bullishDirectionOk(i: BullishDirectionInput, cfg: BullishDirectionConfig = bullishDirectionConfig(i.session)): BullishDirectionVerdict {
  const currentDirection = currentDirectionOf(i);
  const fail = (failedInvariant: string, reason: string): BullishDirectionVerdict => ({ ok: false, reason, failedInvariant, currentDirection });

  if (i.session === "closed") return fail("session_closed", "market closed");
  if (i.direction !== "bullish") return fail("not_bullish", `direction ${i.direction ?? "null"} is not bullish`);

  // Fresh quote (a stale quote can't prove current direction).
  if (isNum(i.quoteAgeMs) && i.quoteAgeMs > cfg.maxQuoteAgeMs) {
    return fail("stale_quote", `quote ${Math.round(i.quoteAgeMs / 1000)}s old > ${Math.round(cfg.maxQuoteAgeMs / 1000)}s`);
  }

  // Positive current velocity.
  if (!isNum(i.shortRate) || i.shortRate < cfg.minShortRatePctMin) {
    return fail("velocity_not_bullish", `velocity ${isNum(i.shortRate) ? i.shortRate.toFixed(2) : "n/a"}%/min < required +${cfg.minShortRatePctMin}%/min`);
  }

  // Positive session-current short-window movement (THIS is what catches an
  // after-hours decline with a momentary bounce: ret10 may pop but ret30 stays red).
  if (!isNum(i.ret10sPct) || i.ret10sPct < cfg.minRet10sPct) {
    return fail("ret10s_not_bullish", `10s return ${isNum(i.ret10sPct) ? i.ret10sPct.toFixed(2) : "n/a"}% < required +${cfg.minRet10sPct}%`);
  }
  if (!isNum(i.ret30sPct) || i.ret30sPct < cfg.minRet30sPct) {
    return fail("ret30s_not_bullish", `30s return ${isNum(i.ret30sPct) ? i.ret30sPct.toFixed(2) : "n/a"}% < required +${cfg.minRet30sPct}% (weak bounce / still falling)`);
  }
  // A deeply negative 60s return means the last 10–30s is only a bounce inside a
  // larger recent drop — not "moving up quickly right now".
  if (isNum(i.ret60sPct) && i.ret60sPct < -cfg.maxRet60sGivebackPct) {
    return fail("ret60s_reversal", `60s return ${i.ret60sPct.toFixed(2)}% is a bounce inside a decline (> ${cfg.maxRet60sGivebackPct}% giveback)`);
  }

  // Above the relevant recent base / breakout level.
  if (cfg.requireAboveBase && i.aboveVwap === false && !i.hodBreak) {
    return fail("below_base", "price is below VWAP / recent base and not breaking the session high");
  }

  // Allowed, fresh classification only.
  if (i.classification != null && !BULLISH_ALLOWED_CLASSES.has(i.classification)) {
    return fail("class_not_allowed", `classification ${i.classification} is not FRESH_ACCELERATION / EARLY_CONTINUATION`);
  }

  // Not excessively extended.
  if (cfg.maxVwapExtPct > 0 && isNum(i.vwapDistPct) && i.vwapDistPct >= cfg.maxVwapExtPct) {
    return fail("extended", `+${i.vwapDistPct.toFixed(1)}% above base ≥ ${cfg.maxVwapExtPct}% chase limit`);
  }

  return { ok: true, reason: "current-session bullish evidence confirmed", failedInvariant: null, currentDirection };
}
