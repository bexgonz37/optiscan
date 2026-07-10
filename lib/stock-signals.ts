import { bearishActionable, BEARISH_DISABLED_REASON } from "./bearish-gate.ts";
/**
 * stock-signals.ts — pure, deterministic scoring for regular-stock callouts
 * (premarket / after-hours, no option chain involved).
 *
 * Mirrors the 0DTE philosophy: BUY only on live, direction-aligned speed with
 * volume behind it. Underlying-only, so the 25 points the options setupScore
 * spends on contract liquidity/spread are redistributed to tape quality.
 * No AI, no news in the signal path — catalysts attach afterwards.
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Live speed needed for a stock BUY in extended hours (%/min, direction-aligned). */
export const STOCK_MIN_SPEED_PCT_PER_MIN = 0.2;
/** Volume surge that counts as real extended-hours participation. */
export const STOCK_MIN_SURGE = 1.5;
/** Default score bar for persisting a stock alert (settings key: stock_min_score). */
export const STOCK_DEFAULT_MIN_SCORE = 66;
/** Confidence bar for Discord — tunable because extended-hours liquidity varies by account/data plan. */
export const STOCK_CLEAR_MIN_CONFIDENCE = Number(process.env.STOCK_CLEAR_MIN_CONFIDENCE ?? 78);

export type StockSide = "LONG" | "SHORT" | "NONE";
export type StockAction = "BUY" | "WAIT" | "SKIP";

export interface StockSignalInput {
  direction?: "bullish" | "bearish" | "choppy" | null;
  directionConfidence?: number | null; // 0-100
  shortRate?: number | null;           // %/min, signed
  accel?: number | null;
  surge?: number | null;
  relVol?: number | null;
  efficiency?: number | null;          // 0-1 path efficiency
  aboveVwap?: boolean | null;
  hodBreak?: boolean;
  lodBreak?: boolean;
  movePct?: number | null;             // day move at alert
}

export interface StockScore { score: number; reasons: string[] }

/** 0-100 setup score for an underlying-only momentum callout. */
export function stockSetupScore(i: StockSignalInput): StockScore {
  const reasons: string[] = [];
  const dirUp = i.direction !== "bearish";

  // Speed (30): the core of an extended-hours signal.
  const speed = isNum(i.shortRate) ? Math.abs(i.shortRate) : 0;
  const speedPart = clamp(speed / (STOCK_MIN_SPEED_PCT_PER_MIN * 2.5), 0, 1) * 30;
  if (speed >= STOCK_MIN_SPEED_PCT_PER_MIN) reasons.push(`Moving ${speed.toFixed(2)}%/min right now`);

  // Volume (20): surge (1s tape) or relVol (candles), whichever is stronger.
  const surgeSignal = isNum(i.surge) ? clamp((i.surge - 1) / 2, 0, 1) : 0;
  const relVolSignal = isNum(i.relVol) ? clamp((i.relVol - 1) / 3, 0, 1) : 0;
  const volumePart = Math.max(surgeSignal, relVolSignal) * 20;
  if (volumePart >= 12) reasons.push(isNum(i.surge) && surgeSignal >= relVolSignal ? `Volume surging ${i.surge!.toFixed(1)}x` : `Volume ${i.relVol!.toFixed(1)}x average`);

  // Tape quality (15): efficiency = clean directional path, not chop.
  const eff = isNum(i.efficiency) ? clamp(i.efficiency, 0, 1) : 0.4;
  const effPart = eff * 15;
  if (eff >= 0.6) reasons.push("Clean directional tape");

  // Direction conviction (15).
  const convPart = clamp(Number(i.directionConfidence ?? 0) / 100, 0, 1) * 15;

  // Levels (20): aligned HOD/LOD break + right side of VWAP.
  let levelPart = 0;
  if (dirUp ? i.hodBreak : i.lodBreak) { levelPart += 12; reasons.push(dirUp ? "Breaking high of day" : "Breaking low of day"); }
  if (i.aboveVwap != null && (dirUp ? i.aboveVwap : !i.aboveVwap)) { levelPart += 8; reasons.push("Right side of VWAP"); }

  return { score: Math.round(clamp(speedPart + volumePart + effPart + convPart + levelPart, 0, 100)), reasons };
}

export interface StockVerdict {
  action: StockAction;
  side: StockSide;
  headline: string; // "BUY LONG" | "BUY SHORT" | "WAIT — LONG SETUP" | "SKIP"
  reason: string;
  confidence: number; // 0-99
  score: number;
  reasons: string[];
}

/**
 * BUY LONG / BUY SHORT / WAIT / SKIP for a stock callout.
 * BUY requires: clear direction + live aligned speed ≥ 0.2%/min + real volume
 * + score above the bar. Same "speed proof" doctrine as the options verdict.
 */
export function computeStockVerdict(i: StockSignalInput, { minScore = STOCK_DEFAULT_MIN_SCORE } = {}): StockVerdict {
  const { score, reasons } = stockSetupScore(i);
  const side: StockSide = i.direction === "bullish" ? "LONG" : i.direction === "bearish" ? "SHORT" : "NONE";
  const speed = isNum(i.shortRate) ? i.shortRate : null;
  const speedAligned =
    speed != null &&
    (side === "LONG" ? speed >= STOCK_MIN_SPEED_PCT_PER_MIN : side === "SHORT" ? speed <= -STOCK_MIN_SPEED_PCT_PER_MIN : false);
  const volumeOk = (isNum(i.surge) && i.surge >= STOCK_MIN_SURGE) || (isNum(i.relVol) && i.relVol >= 2);
  const eff = isNum(i.efficiency) ? i.efficiency : null;

  const confidence = Math.min(99, Math.round(score * 0.7 + clamp(Number(i.directionConfidence ?? 0), 0, 100) * 0.3));

  if (side === "NONE") {
    return { action: "SKIP", side, headline: "SKIP", reason: "No clear direction — tape is choppy.", confidence, score, reasons };
  }
  if (eff != null && eff < 0.35) {
    return { action: "SKIP", side, headline: "SKIP", reason: `Tape too choppy (efficiency ${eff.toFixed(2)}) — fake-move risk.`, confidence, score, reasons };
  }
  // Day-trend alignment (quality-model fix, 2026-07-09): a 10-second bearish
  // read on a stock that's UP big on the day is a dip, not a short — the
  // options path already blocks counter-trend entries (trendAlignedForTrade);
  // shares now get the same discipline. Counter-day-trend BUYs require the
  // structural proof of a level break in the trade direction.
  const dayMove = isNum(i.movePct) ? i.movePct : null;
  const counterTrend =
    dayMove != null &&
    ((side === "SHORT" && dayMove > 0.75 && !i.lodBreak) ||
     (side === "LONG" && dayMove < -0.75 && !i.hodBreak));
  if (counterTrend) {
    return {
      action: "WAIT", side, headline: side === "LONG" ? "Watch ↑ move" : "Watch ↓ move",
      reason: side === "SHORT"
        ? `Stock is +${dayMove!.toFixed(1)}% on the day — a short against the day trend needs an LOD break, not a 10-second dip.`
        : `Stock is ${dayMove!.toFixed(1)}% on the day — a long against the day trend needs an HOD break, not a 10-second pop.`,
      confidence, score, reasons,
    };
  }
  if (!speedAligned) {
    return {
      action: "WAIT", side, headline: side === "LONG" ? "Watch ↑ move" : "Watch ↓ move",
      reason: `Needs live ${side === "LONG" ? "upward" : "downward"} speed ≥ ${STOCK_MIN_SPEED_PCT_PER_MIN}%/min right now.`,
      confidence, score, reasons,
    };
  }
  if (!volumeOk) {
    return {
      action: "WAIT", side, headline: side === "LONG" ? "Watch ↑ move" : "Watch ↓ move",
      reason: "Speed without volume — extended-hours moves need real participation.",
      confidence, score, reasons,
    };
  }
  if (score < minScore) {
    return {
      action: "WAIT", side, headline: side === "LONG" ? "Watch ↑ move" : "Watch ↓ move",
      reason: `Setup ${score}/100 is below the ${minScore} bar.`,
      confidence, score, reasons,
    };
  }
  // Bearish safety gate (2026-07-10): SHORT verdicts are research-only until
  // the short strategy is rebuilt and validated (lib/bearish-gate.ts).
  if (side === "SHORT" && !bearishActionable()) {
    return {
      action: "WAIT", side, headline: "Watch ↓ move",
      reason: `${BEARISH_DISABLED_REASON}: bearish stock callouts are research-only pending strategy rebuild.`,
      confidence, score, reasons,
    };
  }
  return {
    action: "BUY", side, headline: side === "LONG" ? "Buy stock ↑" : "Bet stock ↓",
    reason: side === "LONG"
      ? `Price rising fast — buy shares, not options. ${reasons[0] ?? "Live speed"}.`
      : `Price falling fast — short/sell shares, not options. ${reasons[0] ?? "Live speed"}.`,
    confidence, score, reasons,
  };
}
