/**
 * stock-momentum-classifier.ts - pure deterministic classes for share momentum.
 * No AI, no news, no provider calls.
 */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export type StockMomentumClass =
  | "FRESH_ACCELERATION"
  | "CONTINUATION"
  | "SLOW_GRINDER"
  | "LATE_EXHAUSTION"
  | "NOISY_ILLIQUID_SPIKE";

export interface StockMomentumClassInput {
  direction?: "bullish" | "bearish" | "choppy" | string | null;
  shortRate?: number | null;
  instantRate?: number | null;
  acceleration?: number | null;
  volumeSurge?: number | null;
  relVol?: number | null;
  volumeAcceleration?: number | null;
  movePct?: number | null;
  vwapDistPct?: number | null;
  hodBreak?: boolean;
  lodBreak?: boolean;
  efficiency?: number | null;
  quoteAgeMs?: number | null;
  spreadPct?: number | null;
  rankDelta?: number | null;
}

export interface StockMomentumClassification {
  classification: StockMomentumClass;
  scoreBoost: number;
  dominantReason: string;
  reasons: string[];
  fresh: boolean;
  late: boolean;
}

function aligned(input: StockMomentumClassInput, value: number | null | undefined): number | null {
  if (!isNum(value)) return null;
  if (input.direction === "bullish") return value;
  if (input.direction === "bearish") return -value;
  return null;
}

export function classifyStockMomentum(input: StockMomentumClassInput): StockMomentumClassification {
  const reasons: string[] = [];
  const rate = aligned(input, input.shortRate);
  const instant = aligned(input, input.instantRate);
  const accel = aligned(input, input.acceleration);
  const speed = Math.max(rate ?? 0, instant ?? 0);
  const vol = Math.max(input.volumeSurge ?? 0, input.relVol ?? 0);
  const volAccel = input.volumeAcceleration ?? ((input.volumeSurge ?? 1) - 1);
  const absMove = Math.abs(input.movePct ?? 0);
  const absVwap = Math.abs(input.vwapDistPct ?? 0);
  const levelBreak = input.direction === "bearish" ? Boolean(input.lodBreak) : Boolean(input.hodBreak);
  const rankImproving = isNum(input.rankDelta) && input.rankDelta < 0;

  if (input.direction === "choppy") reasons.push("direction is choppy");
  if (isNum(input.quoteAgeMs) && input.quoteAgeMs > 15_000) reasons.push("quote is stale");
  if (isNum(input.spreadPct) && input.spreadPct > 0.8) reasons.push(`stock spread ${input.spreadPct.toFixed(2)}% is too wide`);
  if ((input.efficiency ?? 0.5) < 0.28) reasons.push("one-print/choppy tape");
  if (reasons.length) {
    return { classification: "NOISY_ILLIQUID_SPIKE", scoreBoost: -35, dominantReason: reasons[0], reasons, fresh: false, late: false };
  }

  const accelerating = (accel ?? 0) > 0.015;
  const volumeBuilding = vol >= 1.18 || volAccel > 0.12;
  const extensionOk = absMove < 6 && absVwap < 2.5;

  if (!extensionOk && ((accel ?? 0) <= 0 || vol < 1.15 || !levelBreak)) {
    reasons.push(absMove >= 6 ? `day move ${absMove.toFixed(1)}% already extended` : `VWAP extension ${absVwap.toFixed(1)}% already stretched`);
    if ((accel ?? 0) <= 0) reasons.push("velocity is decelerating");
    if (vol < 1.15) reasons.push("volume rate is fading");
    return { classification: "LATE_EXHAUSTION", scoreBoost: -30, dominantReason: reasons[0], reasons, fresh: false, late: true };
  }

  if (speed >= 0.24 && accelerating && volumeBuilding && (levelBreak || rankImproving) && extensionOk) {
    reasons.push("fresh acceleration with expanding volume");
    if (levelBreak) reasons.push("breaking a fresh range/session level");
    if (rankImproving) reasons.push("candidate rank is improving");
    return { classification: "FRESH_ACCELERATION", scoreBoost: 18, dominantReason: reasons[0], reasons, fresh: true, late: false };
  }

  if (speed >= 0.20 && (accel ?? 0) >= -0.02 && vol >= 1.15 && absVwap < 3.0) {
    reasons.push("continuation speed remains strong with supportive volume");
    return { classification: "CONTINUATION", scoreBoost: 8, dominantReason: reasons[0], reasons, fresh: false, late: false };
  }

  if (absMove >= 0.75 && speed < 0.14 && Math.abs(accel ?? 0) < 0.03 && vol < 1.2) {
    reasons.push("positive day move but low current velocity and flat volume");
    return { classification: "SLOW_GRINDER", scoreBoost: -22, dominantReason: reasons[0], reasons, fresh: false, late: false };
  }

  if ((accel ?? 0) < -0.06 && speed < 0.20) {
    reasons.push("velocity is rolling over before confirmation");
    return { classification: "LATE_EXHAUSTION", scoreBoost: -24, dominantReason: reasons[0], reasons, fresh: false, late: true };
  }

  reasons.push("developing but not yet fresh acceleration");
  return {
    classification: "CONTINUATION",
    scoreBoost: Math.round(clamp((speed - 0.16) * 40 + Math.max(0, vol - 1) * 4, -8, 6)),
    dominantReason: reasons[0],
    reasons,
    fresh: false,
    late: false,
  };
}
