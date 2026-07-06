/**
 * alert-scoring.js — pure scoring for the 0DTE options momentum scanner.
 * No network, no DB, no AI — deterministic and unit tested.
 *
 * v3 (0DTE pivot) — TWO deliberate spec changes vs earlier versions:
 *   1. CATALYSTS ARE NOT SCORED. News is optional context attached after the
 *      alert; it never gates, boosts, or suppresses anything here.
 *   2. MOVE SIZE IS NOT A RISK. "Already up 15%" is what a momentum scanner
 *      is FOR — risk comes from structure: chop, deceleration/exhaustion,
 *      spreads, dead contracts, hot IV, and the late-day theta cliff.
 *
 * Research heuristics only — no recommendations, no backtested edge.
 */

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Normalize IV to percent whether the source gave 0.45 or 45. */
export function ivToPct(iv) {
  if (!isNum(iv)) return null;
  return iv <= 5 ? iv * 100 : iv;
}

/**
 * Options Liquidity Score (0-100) — used by both the swing radar and the
 * 0DTE path (the 0DTE contract score in zero-dte.js is the sharper tool).
 *
 * Weights: spread 40 (0% -> 40, 0 at >=20%), volume 25 (1k+ full),
 * OI 25 (2k+ full), near-term availability 10 (DTE<=21 -> 10, <=45 -> 6).
 * Missing quote = spread part 0: unquotable is illiquid by definition.
 */
export function optionsLiquidityScore(contract = {}) {
  const reasons = [];
  const spreadPct = isNum(contract.spreadPct) ? contract.spreadPct : null;
  const volume = isNum(contract.volume) ? contract.volume : 0;
  const oi = isNum(contract.openInterest) ? contract.openInterest : 0;
  const dte = isNum(contract.dte) ? contract.dte : null;

  const spreadPart = spreadPct == null ? 0 : clamp(40 * (1 - spreadPct / 20), 0, 40);
  if (spreadPct != null && spreadPct <= 5) reasons.push(`Tight spread ${spreadPct}%`);
  else if (spreadPct == null) reasons.push("No live quote (spread unknown)");
  else if (spreadPct > 15) reasons.push(`Wide spread ${spreadPct}%`);

  const volPart = clamp((volume / 1000) * 25, 0, 25);
  if (volume >= 1000) reasons.push(`Active: ${volume.toLocaleString()} contracts today`);

  const oiPart = clamp((oi / 2000) * 25, 0, 25);
  if (oi >= 2000) reasons.push(`Deep OI ${oi.toLocaleString()}`);
  else if (oi < 200) reasons.push(`Thin OI ${oi}`);

  let dtePart = 0;
  if (dte != null && dte <= 21) dtePart = 10;
  else if (dte != null && dte <= 45) dtePart = 6;

  const score = Math.round(clamp(spreadPart + volPart + oiPart + dtePart, 0, 100));
  return { score, reasons };
}

/**
 * Risk Score (0-100, HIGHER = RISKIER). 0DTE structural red flags only:
 *
 *   wide spread          up to 20 — 0 below 6%, full 20 at >=20%.
 *   thin contract market up to 15 — volume<100 AND OI<100 worst case.
 *   choppy tape          up to 20 — path efficiency < 0.45, scaled.
 *   exhaustion               15/8 — moveStatus 'exhausted' 15, 'extended_risky' 8.
 *   very hot IV              10   — > 250% (0DTE IV runs naturally high).
 *   near market close        10   — < 45 min: theta cliff + closing chop.
 *   low share volume     up to 10 — underlying < 1M shares scaled.
 *
 * NOT here on purpose: move size (that's moveStatus's job — a big move that
 * is still accelerating is 'continuing', not risky) and catalysts (context
 * only, never a penalty — no news does NOT make a clean tape risky).
 */
export function riskScore(input = {}) {
  const reasons = [];
  let score = 0;

  const spreadPct = isNum(input.spreadPct) ? input.spreadPct : null;
  if (spreadPct != null && spreadPct > 6) {
    const part = clamp(((spreadPct - 6) / 14) * 20, 0, 20);
    score += part;
    if (part >= 10) reasons.push(`Wide spread ${spreadPct}%`);
  }

  const vol = isNum(input.optionVolume) ? input.optionVolume : null;
  const oi = isNum(input.openInterest) ? input.openInterest : null;
  if (vol != null || oi != null) {
    const volOk = clamp((vol ?? 0) / 500, 0, 1);
    const oiOk = clamp((oi ?? 0) / 300, 0, 1);
    const part = clamp((1 - Math.max(volOk, oiOk)) * 15, 0, 15);
    score += part;
    if (part >= 10) reasons.push("Thin contract market");
  }

  const eff = isNum(input.efficiency) ? input.efficiency : null;
  if (eff != null && eff < 0.45) {
    const part = clamp(((0.45 - eff) / 0.45) * 20, 0, 20);
    score += part;
    if (eff < 0.3) reasons.push(`Choppy tape (efficiency ${eff})`);
  }

  if (input.moveStatus === "exhausted") { score += 15; reasons.push("Move exhausted"); }
  else if (input.moveStatus === "extended_risky") { score += 8; reasons.push("Chase risk — extended and decelerating"); }

  const ivPct = ivToPct(input.iv);
  if (ivPct != null && ivPct > 250) {
    score += 10;
    reasons.push(`IV too hot ${Math.round(ivPct)}%`);
  }

  if (isNum(input.minsToClose) && input.minsToClose >= 0 && input.minsToClose < 45) {
    score += 10;
    reasons.push("Late-day risk (theta cliff)");
  }

  const shareVol = isNum(input.shareVolume) ? input.shareVolume : null;
  if (shareVol != null && shareVol < 1_000_000) {
    const part = clamp((1 - shareVol / 1_000_000) * 10, 0, 10);
    score += part;
    if (shareVol < 300_000) reasons.push(`Low underlying volume ${(shareVol / 1000).toFixed(0)}k`);
  }

  return { score: Math.round(clamp(score, 0, 100)), reasons };
}

const STATUS_TIMING = { early: 10, continuing: 10, extended_tradable: 6, extended_risky: 2, exhausted: 0 };

/**
 * Setup Score (0-100) with component breakdown — 0DTE weights per spec:
 *
 *   price momentum / acceleration  0-20 — momentum01 (direction-engine
 *                                         confidence 0-1) * 20
 *   relative volume / surge        0-15 — best of candle relVol and the
 *                                         per-second volume-surge ratio
 *   VWAP / key level behavior      0-15 — right side of VWAP 8 + HOD/LOD
 *                                         break 7
 *   options liquidity              0-25 — contract volume 13 (1.5k+ full)
 *                                         + open interest 12 (1k+ full)
 *   spread quality                 0-10 — 0% -> 10, 0 at >=12%
 *   0DTE contract suitability      0-10 — zeroDteContractScore * 0.1
 *   timing / continuation          0-10 — early/continuing 10,
 *                                         extended-tradable 6, chase 2,
 *                                         exhausted 0 (NOT move size!)
 *   risk penalty                  -0-25 — riskScore * 0.25
 *
 * NO CATALYST TERM — by spec. Breakdown persists to score_breakdown_json.
 */
export function setupScore(input = {}) {
  const reasons = [];

  const momentum01 = clamp(Number(input.momentum01 ?? 0), 0, 1);
  const momentumPart = momentum01 * 20;
  if (momentum01 >= 0.6) reasons.push("Strong directional momentum");

  const relVolSignal = isNum(input.relVol) ? clamp((input.relVol - 1) / 2.5, 0, 1) : 0;
  const surgeSignal = isNum(input.surge) ? clamp((input.surge - 1) / 1.5, 0, 1) : 0;
  const volumePart = Math.max(relVolSignal, surgeSignal) * 15;
  if (volumePart >= 9) reasons.push(isNum(input.surge) && surgeSignal >= relVolSignal ? `Volume surging ${input.surge}x` : `Volume ${input.relVol}x average`);

  let levelPart = 0;
  if (input.vwapAligned) { levelPart += 8; reasons.push("Right side of VWAP"); }
  if (input.levelBreak) { levelPart += 7; reasons.push("Breaking high/low of day"); }

  const cVol = isNum(input.optionVolume) ? input.optionVolume : 0;
  const cOi = isNum(input.openInterest) ? input.openInterest : 0;
  const liquidityPart = clamp((cVol / 1500) * 13, 0, 13) + clamp((cOi / 1000) * 12, 0, 12);
  if (liquidityPart >= 18) reasons.push("Liquid contracts");

  const spreadPct = isNum(input.spreadPct) ? input.spreadPct : null;
  const spreadPart = spreadPct == null ? 0 : clamp(10 * (1 - spreadPct / 12), 0, 10);
  if (spreadPct != null && spreadPct <= 4) reasons.push(`Tight spread ${spreadPct}%`);

  const zeroDtePart = clamp(Number(input.zeroDteScore ?? 0) * 0.1, 0, 10);

  const timingPart = STATUS_TIMING[input.moveStatus] ?? 5;
  if (timingPart === 10) reasons.push("Move still early/continuing");
  else if (input.moveStatus === "extended_risky") reasons.push("Late — chase risk");

  const risk = clamp(Number(input.riskScore ?? 0), 0, 100);
  const riskPenalty = clamp(risk * 0.25, 0, 25);

  const raw = momentumPart + volumePart + levelPart + liquidityPart + spreadPart + zeroDtePart + timingPart - riskPenalty;
  const score = Math.round(clamp(raw, 0, 100));

  const breakdown = {
    momentum: +momentumPart.toFixed(1),
    volume: +volumePart.toFixed(1),
    vwapLevels: levelPart,
    liquidity: +liquidityPart.toFixed(1),
    spread: +spreadPart.toFixed(1),
    zeroDteFit: +zeroDtePart.toFixed(1),
    timing: timingPart,
    riskPenalty: +(-riskPenalty).toFixed(1),
  };
  return { score, breakdown, reasons };
}

/**
 * False-positive rule, evaluated at the end-of-day checkpoint:
 * the alert never moved at least `minFavorablePct` in its own direction AND
 * closed unfavorable vs the alert price. Both conditions — a signal that ran
 * 3% then faded is a timing miss, not a false positive.
 */
export function isFalsePositive({ maxFavorablePct, eodFavorablePct, minFavorablePct = 1.5 }) {
  if (!isNum(maxFavorablePct) || !isNum(eodFavorablePct)) return false;
  return maxFavorablePct < minFavorablePct && eodFavorablePct < 0;
}
