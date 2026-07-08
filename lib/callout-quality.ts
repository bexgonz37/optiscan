/**
 * callout-quality.ts — gold-standard bar derived from audit winners (META #436:
 * +0.78% stock @5m, +82% option mid, TRADE with zero blockers).
 *
 * TRADE  = META-tier order (BUY CALL/PUT)
 * WATCH  = strong enough to interrupt the user (popup + list)
 * SKIP   = do not persist — too weak vs the META reference
 */

export type CalloutTier = "TRADE" | "WATCH" | "SKIP";

export interface CalloutQualityInput {
  setupScore: number;
  shortRate: number | null;
  surge: number | null;
  direction: "bullish" | "bearish" | "choppy" | string;
  moveStatus: string;
  callWatch: number;
  putWatch: number;
  worthScore: number;
  contractScore: number;
  liquidityScore: number;
  efficiency: number | null;
  accel: number | null;
  aboveVwap: boolean | null;
  hodBreak: boolean;
  lodBreak: boolean;
  tradeBlockers: string[];
}

export interface CalloutQualityResult {
  tier: CalloutTier;
  /** Human-readable misses vs the META profile */
  failures: string[];
  sideGap: number;
  speedAbs: number;
}

function sideGap(input: CalloutQualityInput): number {
  if (input.direction === "bearish") return input.putWatch - input.callWatch;
  if (input.direction === "bullish") return input.callWatch - input.putWatch;
  return Math.max(input.callWatch, input.putWatch) - Math.min(input.callWatch, input.putWatch);
}

function accelAligned(input: CalloutQualityInput): boolean {
  if (input.direction === "bearish") return (input.accel ?? 0) < 0;
  if (input.direction === "bullish") return (input.accel ?? 0) > 0;
  return false;
}

function structureOk(input: CalloutQualityInput): boolean {
  const levelBreak = input.direction === "bearish" ? input.lodBreak : input.hodBreak;
  if (levelBreak) return true;
  if (input.aboveVwap == null) return true;
  return input.direction === "bearish" ? !input.aboveVwap : input.aboveVwap;
}

/** META #436 profile — the bar for BUY CALL/PUT. Tunable via env (in/out scalps). */
export function passesGoldTrade(input: CalloutQualityInput): string[] {
  const failures: string[] = [];
  const speed = Math.abs(input.shortRate ?? 0);
  const surge = input.surge ?? 0;
  const gap = sideGap(input);
  const minSetup = Number(process.env.GOLD_TRADE_MIN_SETUP ?? 84);
  const minSpeed = Number(process.env.GOLD_TRADE_MIN_SPEED ?? 0.22);
  const minSurge = Number(process.env.GOLD_TRADE_MIN_SURGE ?? 2.2);
  const minWorth = Number(process.env.GOLD_TRADE_MIN_WORTH ?? 76);
  const minContract = Number(process.env.GOLD_TRADE_MIN_CONTRACT ?? 68);
  const minLiq = Number(process.env.GOLD_TRADE_MIN_LIQUIDITY ?? 60);
  const minGap = Number(process.env.GOLD_TRADE_MIN_SIDE_GAP ?? 18);

  if (input.setupScore < minSetup) failures.push(`setup ${Math.round(input.setupScore)} < ${minSetup}`);
  if (speed < minSpeed) failures.push(`speed ${speed.toFixed(2)}%/min < ${minSpeed}`);
  if (surge < minSurge) failures.push(`surge ${surge.toFixed(1)}x < ${minSurge}`);
  if (!["early", "extended_tradable", "continuing"].includes(input.moveStatus)) {
    failures.push(`move ${input.moveStatus} — need early/tradable momentum`);
  }
  if (input.worthScore < minWorth) failures.push(`worth-it ${Math.round(input.worthScore)} < ${minWorth}`);
  if (input.contractScore < minContract) failures.push(`contract ${Math.round(input.contractScore)} < ${minContract}`);
  if (input.liquidityScore < minLiq) failures.push(`liquidity ${Math.round(input.liquidityScore)} < ${minLiq}`);
  if (gap < minGap) failures.push(`side conviction gap ${Math.round(gap)} < ${minGap}`);
  if (input.efficiency != null && input.efficiency < 0.28) failures.push("tape efficiency < 0.28");
  if (!accelAligned(input) && !(input.hodBreak || input.lodBreak)) {
    failures.push("speed without acceleration follow-through");
  }
  if (!structureOk(input)) failures.push("counter-VWAP without level break");
  if (input.moveStatus === "continuing" && surge < 2.5) {
    failures.push("continuing move needs ≥2.5x surge (PLTR-class fade risk)");
  }
  if (input.tradeBlockers.length) failures.push(`order gates: ${input.tradeBlockers[0]}`);

  return failures;
}

/** Strong WATCH — popup-worthy, still below META BUY bar. */
export function passesGoldWatch(input: CalloutQualityInput): string[] {
  const failures: string[] = [];
  const speed = Math.abs(input.shortRate ?? 0);
  const surge = input.surge ?? 0;
  const gap = sideGap(input);

  if (input.setupScore < 78) failures.push(`setup ${Math.round(input.setupScore)} < 78`);
  if (speed < 0.20) failures.push(`speed ${speed.toFixed(2)}%/min < 0.20`);
  if (surge < 2.2) failures.push(`surge ${surge.toFixed(1)}x < 2.2`);
  if (["exhausted", "extended_risky"].includes(input.moveStatus)) {
    failures.push(`move ${input.moveStatus}`);
  }
  if (input.worthScore < 72) failures.push(`worth-it ${Math.round(input.worthScore)} < 72`);
  if (input.contractScore < 60) failures.push(`contract ${Math.round(input.contractScore)} < 60`);
  if (input.liquidityScore < 55) failures.push(`liquidity ${Math.round(input.liquidityScore)} < 55`);
  if (gap < 18) failures.push(`side gap ${Math.round(gap)} < 18`);
  if (input.moveStatus === "continuing" && surge < 2.5) {
    failures.push("continuing + weak surge (PLTR pattern)");
  }

  return failures;
}

export function evaluateCalloutQuality(input: CalloutQualityInput): CalloutQualityResult {
  const speedAbs = Math.abs(input.shortRate ?? 0);
  const gap = sideGap(input);
  const tradeFails = passesGoldTrade(input);
  if (tradeFails.length === 0) {
    return { tier: "TRADE", failures: [], sideGap: gap, speedAbs };
  }
  const watchFails = passesGoldWatch(input);
  if (watchFails.length === 0) {
    return { tier: "WATCH", failures: tradeFails, sideGap: gap, speedAbs };
  }
  return { tier: "SKIP", failures: watchFails, sideGap: gap, speedAbs };
}
