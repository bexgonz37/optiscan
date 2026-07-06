/**
 * alert-scoring.js — pure scoring functions for Alert Lab (no network, no DB,
 * safe to unit test — same conventions as momentum-signals.js).
 *
 * Three scores, all 0-100:
 *   - optionsLiquidityScore: how tradeable the alert's contract market is
 *   - riskScore:             how many structural red flags the setup carries
 *                            (HIGHER = RISKIER)
 *   - signalQualityScore:    overall alert quality, blending momentum inputs,
 *                            catalyst strength, liquidity and flow confirmation
 *
 * These are research heuristics for measuring scanner output over time.
 * They are NOT trade recommendations and carry no backtested edge.
 */

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Normalize IV to percent whether the source gave 0.45 or 45. */
export function ivToPct(iv) {
  if (!isNum(iv)) return null;
  return iv <= 5 ? iv * 100 : iv;
}

/**
 * Options Liquidity Score (0-100).
 *
 * Weights:
 *   spread   40  — 0% spread -> 40 pts, linearly down to 0 at >=20% spread.
 *                  Spread is the dominant real cost of trading an option.
 *   volume   25  — today's contract volume, 1,000+ -> full 25.
 *   OI       25  — open interest, 2,000+ -> full 25.
 *   near-term 10 — a contract actually exists in a tradable window:
 *                  DTE <= 21 -> 10, DTE <= 45 -> 6, else/unknown -> 0.
 *
 * Missing spread (no quote) scores the spread part 0 — an unquotable market
 * is illiquid by definition.
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
 * Risk Score (0-100, HIGHER = RISKIER). Additive red flags:
 *
 *   wide spread        up to 20 — 0 below 8% spread, full 20 at >=25%.
 *   thin open interest up to 20 — full 20 at OI 0, 0 at OI >= 500.
 *   no clear catalyst      15   — move without a documented driver.
 *   pre-alert overextension up to 20 — 0 below 5% |move|, full 20 at >=15%.
 *                                Chasing an already-made move is the classic
 *                                false-positive shape.
 *   low share volume   up to 15 — full 15 under 100k shares, 0 above 1M.
 *   very high IV           10   — IV > 150%: premium priced for chaos.
 *
 * Missing inputs contribute 0 (unknown ≠ risky) EXCEPT catalyst, where
 * "unknown" is exactly the risk being measured.
 */
export function riskScore(input = {}) {
  const reasons = [];
  let score = 0;

  const spreadPct = isNum(input.spreadPct) ? input.spreadPct : null;
  if (spreadPct != null && spreadPct > 8) {
    const part = clamp(((spreadPct - 8) / 17) * 20, 0, 20);
    score += part;
    if (part >= 10) reasons.push(`Wide spread ${spreadPct}%`);
  }

  const oi = isNum(input.openInterest) ? input.openInterest : null;
  if (oi != null && oi < 500) {
    const part = clamp((1 - oi / 500) * 20, 0, 20);
    score += part;
    if (oi < 200) reasons.push(`Thin OI ${oi}`);
  }

  const ct = input.catalystType ?? "no_clear_catalyst";
  const cq = input.catalystQuality ?? "unknown";
  if (ct === "no_clear_catalyst" || cq === "unknown") {
    score += 15;
    reasons.push("No clear catalyst");
  }

  const absMove = Math.abs(Number(input.movePct ?? 0));
  if (absMove > 5) {
    const part = clamp(((absMove - 5) / 10) * 20, 0, 20);
    score += part;
    if (absMove >= 8) reasons.push(`Extended ${absMove.toFixed(1)}% pre-alert`);
  }

  const shareVol = isNum(input.shareVolume) ? input.shareVolume : null;
  if (shareVol != null && shareVol < 1_000_000) {
    const part = clamp((1 - shareVol / 1_000_000) * 15, 0, 15);
    score += part;
    if (shareVol < 300_000) reasons.push(`Low volume ${(shareVol / 1000).toFixed(0)}k shares`);
  }

  const ivPct = ivToPct(input.iv);
  if (ivPct != null && ivPct > 150) {
    score += 10;
    reasons.push(`Very high IV ${Math.round(ivPct)}%`);
  }

  return { score: Math.round(clamp(score, 0, 100)), reasons };
}

const CATALYST_QUALITY_PART = { strong: 20, medium: 12, weak: 6, unknown: 0 };

/**
 * Signal Quality Score (0-100).
 *
 * Weights:
 *   relative volume  25 — (relVol - 1) / 2 * 25, capped: 1x -> 0, 3x+ -> 25.
 *   move quality     20 — |move| scaled to 4%: 4%+ -> full 20. Rewards a real
 *                         move without requiring an extended one.
 *   catalyst         20 — strong 20 / medium 12 / weak 6 / unknown 0.
 *   options liquidity 20 — optionsLiquidityScore * 0.2 (an untradeable market
 *                          makes even a perfect signal unusable for research
 *                          into actionable setups).
 *   unusual flow     10 — same-ticker unusual-options hit this scan: the
 *                         options market is confirming the equity move.
 *   overextension   -15 — penalty when |move| > 8%: -(|move|-8) * 3, capped.
 *                         Mirrors the risk score: late alerts score lower.
 */
export function signalQualityScore(input = {}) {
  const reasons = [];

  const relVol = isNum(input.relVol) ? input.relVol : null;
  const relVolPart = relVol == null ? 0 : clamp(((relVol - 1) / 2) * 25, 0, 25);
  if (relVol != null && relVol >= 1.5) reasons.push(`Volume ${relVol}x average`);

  const absMove = Math.abs(Number(input.movePct ?? 0));
  const movePart = clamp((absMove / 4) * 20, 0, 20);
  if (absMove >= 1) reasons.push(`${absMove.toFixed(1)}% move at alert`);

  const cq = input.catalystQuality ?? "unknown";
  const catalystPart = CATALYST_QUALITY_PART[cq] ?? 0;
  if (catalystPart >= 12) reasons.push(`Catalyst: ${input.catalystType ?? "news"} (${cq})`);

  const liq = isNum(input.liquidityScore) ? input.liquidityScore : 0;
  const liqPart = clamp(liq * 0.2, 0, 20);
  if (liq >= 70) reasons.push("Liquid options market");

  const flowPart = input.hasUnusualFlow ? 10 : 0;
  if (input.hasUnusualFlow) reasons.push("Unusual options flow confirms");

  let penalty = 0;
  if (absMove > 8) {
    penalty = clamp((absMove - 8) * 3, 0, 15);
    reasons.push(`Overextended (${absMove.toFixed(1)}% already)`);
  }

  const score = Math.round(clamp(relVolPart + movePart + catalystPart + liqPart + flowPart - penalty, 0, 100));
  return { score, reasons };
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
