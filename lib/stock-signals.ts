import { bearishActionable, BEARISH_DISABLED_REASON } from "./bearish-gate.ts";
import { classifyStockMomentum, type StockMomentumClass } from "./stock-momentum-classifier.ts";

/**
 * stock-signals.ts - pure deterministic scoring for regular-stock callouts.
 * No AI and no news in the live signal path.
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const STOCK_MIN_SPEED_PCT_PER_MIN = 0.2;
export const STOCK_MIN_SURGE = 1.5;
export const STOCK_DEFAULT_MIN_SCORE = 66;
export const STOCK_CLEAR_MIN_CONFIDENCE = Number(process.env.STOCK_CLEAR_MIN_CONFIDENCE ?? 78);

export type StockSide = "LONG" | "SHORT" | "NONE";
export type StockAction = "BUY" | "WAIT" | "SKIP";

export interface StockSignalInput {
  direction?: "bullish" | "bearish" | "choppy" | null;
  directionConfidence?: number | null;
  shortRate?: number | null;
  instantRate?: number | null;
  accel?: number | null;
  surge?: number | null;
  relVol?: number | null;
  volumeAcceleration?: number | null;
  efficiency?: number | null;
  aboveVwap?: boolean | null;
  hodBreak?: boolean;
  lodBreak?: boolean;
  movePct?: number | null;
  vwapDistPct?: number | null;
  quoteAgeMs?: number | null;
  spreadPct?: number | null;
  rankDelta?: number | null;
}

export interface StockScore { score: number; reasons: string[] }

export function stockSetupScore(i: StockSignalInput): StockScore {
  const reasons: string[] = [];
  const dirUp = i.direction !== "bearish";

  const speed = isNum(i.shortRate) ? Math.abs(i.shortRate) : 0;
  const speedPart = clamp(speed / (STOCK_MIN_SPEED_PCT_PER_MIN * 2.5), 0, 1) * 30;
  if (speed >= STOCK_MIN_SPEED_PCT_PER_MIN) reasons.push(`Moving ${speed.toFixed(2)}%/min right now`);

  const surgeSignal = isNum(i.surge) ? clamp((i.surge - 1) / 2, 0, 1) : 0;
  const relVolSignal = isNum(i.relVol) ? clamp((i.relVol - 1) / 3, 0, 1) : 0;
  const volumePart = Math.max(surgeSignal, relVolSignal) * 20;
  if (volumePart >= 12) reasons.push(isNum(i.surge) && surgeSignal >= relVolSignal ? `Volume surging ${i.surge!.toFixed(1)}x` : `Volume ${i.relVol!.toFixed(1)}x average`);

  const eff = isNum(i.efficiency) ? clamp(i.efficiency, 0, 1) : 0.4;
  const effPart = eff * 15;
  if (eff >= 0.6) reasons.push("Clean directional tape");

  const convPart = clamp(Number(i.directionConfidence ?? 0) / 100, 0, 1) * 15;

  let levelPart = 0;
  if (dirUp ? i.hodBreak : i.lodBreak) { levelPart += 12; reasons.push(dirUp ? "Breaking high of day" : "Breaking low of day"); }
  if (i.aboveVwap != null && (dirUp ? i.aboveVwap : !i.aboveVwap)) { levelPart += 8; reasons.push("Right side of VWAP"); }

  return { score: Math.round(clamp(speedPart + volumePart + effPart + convPart + levelPart, 0, 100)), reasons };
}

export interface StockVerdict {
  action: StockAction;
  side: StockSide;
  headline: string;
  reason: string;
  confidence: number;
  score: number;
  reasons: string[];
  classification: StockMomentumClass;
  dominantReason: string;
}

function withClass(
  base: Omit<StockVerdict, "classification" | "dominantReason">,
  classified: ReturnType<typeof classifyStockMomentum>,
): StockVerdict {
  return { ...base, classification: classified.classification, dominantReason: classified.dominantReason };
}

export function computeStockVerdict(i: StockSignalInput, { minScore = STOCK_DEFAULT_MIN_SCORE } = {}): StockVerdict {
  const classified = classifyStockMomentum({
    direction: i.direction,
    shortRate: i.shortRate,
    instantRate: i.instantRate,
    acceleration: i.accel,
    volumeSurge: i.surge,
    relVol: i.relVol,
    volumeAcceleration: i.volumeAcceleration,
    movePct: i.movePct,
    vwapDistPct: i.vwapDistPct,
    hodBreak: i.hodBreak,
    lodBreak: i.lodBreak,
    efficiency: i.efficiency,
    quoteAgeMs: i.quoteAgeMs,
    spreadPct: i.spreadPct,
    rankDelta: i.rankDelta,
  });
  const base = stockSetupScore(i);
  const score = Math.round(clamp(base.score + classified.scoreBoost, 0, 100));
  const reasons = [...classified.reasons, ...base.reasons];
  const side: StockSide = i.direction === "bullish" ? "LONG" : i.direction === "bearish" ? "SHORT" : "NONE";
  const speed = isNum(i.shortRate) ? i.shortRate : null;
  const speedAligned =
    speed != null &&
    (side === "LONG" ? speed >= STOCK_MIN_SPEED_PCT_PER_MIN : side === "SHORT" ? speed <= -STOCK_MIN_SPEED_PCT_PER_MIN : false);
  const volumeOk = (isNum(i.surge) && i.surge >= STOCK_MIN_SURGE) || (isNum(i.relVol) && i.relVol >= 2);
  const eff = isNum(i.efficiency) ? i.efficiency : null;
  const confidence = Math.min(99, Math.round(score * 0.7 + clamp(Number(i.directionConfidence ?? 0), 0, 100) * 0.3));

  if (side === "NONE") {
    return withClass({ action: "SKIP", side, headline: "SKIP", reason: "No clear direction - tape is choppy.", confidence, score, reasons }, classified);
  }
  if (classified.classification === "NOISY_ILLIQUID_SPIKE") {
    return withClass({ action: "SKIP", side, headline: "SKIP", reason: classified.dominantReason, confidence, score, reasons }, classified);
  }
  if (classified.classification === "LATE_EXHAUSTION" || classified.classification === "SLOW_GRINDER") {
    return withClass({ action: "WAIT", side, headline: side === "LONG" ? "Watch ↑ move" : "Watch ↓ move", reason: classified.dominantReason, confidence, score, reasons }, classified);
  }
  if (eff != null && eff < 0.35) {
    return withClass({ action: "SKIP", side, headline: "SKIP", reason: `Tape too choppy (efficiency ${eff.toFixed(2)}) - fake-move risk.`, confidence, score, reasons }, classified);
  }

  const dayMove = isNum(i.movePct) ? i.movePct : null;
  const counterTrend =
    dayMove != null &&
    ((side === "SHORT" && dayMove > 0.75 && !i.lodBreak) ||
     (side === "LONG" && dayMove < -0.75 && !i.hodBreak));
  if (counterTrend) {
    return withClass({
      action: "WAIT", side, headline: side === "LONG" ? "Watch ↑ move" : "Watch ↓ move",
      reason: side === "SHORT"
        ? `Stock is +${dayMove!.toFixed(1)}% on the day - a short against the day trend needs an LOD break, not a 10-second dip.`
        : `Stock is ${dayMove!.toFixed(1)}% on the day - a long against the day trend needs an HOD break, not a 10-second pop.`,
      confidence, score, reasons,
    }, classified);
  }
  if (!speedAligned) {
    return withClass({
      action: "WAIT", side, headline: side === "LONG" ? "Watch ↑ move" : "Watch ↓ move",
      reason: `Needs live ${side === "LONG" ? "upward" : "downward"} speed >= ${STOCK_MIN_SPEED_PCT_PER_MIN}%/min right now.`,
      confidence, score, reasons,
    }, classified);
  }
  if (!volumeOk) {
    return withClass({
      action: "WAIT", side, headline: side === "LONG" ? "Watch ↑ move" : "Watch ↓ move",
      reason: "Speed without volume - extended-hours moves need real participation.",
      confidence, score, reasons,
    }, classified);
  }
  if (score < minScore) {
    return withClass({
      action: "WAIT", side, headline: side === "LONG" ? "Watch up move" : "Watch down move",
      reason: `Setup ${score}/100 is below the ${minScore} bar.`,
      confidence, score, reasons,
    }, classified);
  }
  if (side === "SHORT" && !bearishActionable()) {
    return withClass({
      action: "WAIT", side, headline: "Watch ↓ move",
      reason: `${BEARISH_DISABLED_REASON}: bearish stock callouts are research-only until bearish trading is enabled.`,
      confidence, score, reasons,
    }, classified);
  }
  return withClass({
    action: "BUY", side, headline: side === "LONG" ? "Buy stock ↑" : "Bet stock ↓",
    reason: side === "LONG"
      ? `Price rising fast - buy shares, not options. ${reasons[0] ?? "Live speed"}.`
      : `Price falling fast - short/sell shares, not options. ${reasons[0] ?? "Live speed"}.`,
    confidence, score, reasons,
  }, classified);
}
