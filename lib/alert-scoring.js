/**
 * alert-scoring.js — pure scoring functions for Alert Lab (no network, no DB,
 * safe to unit test — same conventions as momentum-signals.js).
 *
 * Three scores, all 0-100:
 *   - optionsLiquidityScore: how tradeable the alert's contract market is
 *   - riskScore:             how many structural red flags the setup carries
 *                            (HIGHER = RISKIER)
 *   - setupScore:            overall setup quality with a full component
 *                            breakdown (stored as score_breakdown_json)
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
 *                  DTE <= 21 -> 10 (weeklies zone), DTE <= 45 -> 6, else 0.
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
 *   no/stale catalyst      15   — move without a live documented driver.
 *   pre-alert overextension up to 20 — 0 below 5% |move|, full 20 at >=15%.
 *                                Chasing an already-made move is the classic
 *                                false-positive shape.
 *   low share volume   up to 15 — full 15 under 100k shares, 0 above 1M.
 *   very high IV           10   — IV > 150%: premium priced for chaos.
 *   near market close       5   — < 45 min to 16:00 ET (pass minsToClose).
 *
 * Missing inputs contribute 0 (unknown ≠ risky) EXCEPT catalyst, where
 * "unknown" is exactly the risk being measured. Float/halt/social data are
 * not available from the provider and are NOT faked — low price + thin volume
 * act as the pump-risk proxy.
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
  if (ct === "no_clear_catalyst" || cq === "unknown" || cq === "stale") {
    score += 15;
    reasons.push(cq === "stale" ? "Only stale news found" : "No clear catalyst");
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

  if (isNum(input.minsToClose) && input.minsToClose >= 0 && input.minsToClose < 45) {
    score += 5;
    reasons.push("Near market close");
  }

  return { score: Math.round(clamp(score, 0, 100)), reasons };
}

const CATALYST_PART = { strong: 20, medium: 12, weak: 6, stale: 3, unknown: 0 };

/**
 * Setup Score (0-100) with component breakdown, per the scanner spec:
 *
 *   relative volume   0-20 — (relVol - 1) / 2.5 * 20, capped (3.5x -> 20)
 *   price momentum    0-15 — |move| scaled to 5% (5%+ -> 15)
 *   catalyst quality  0-20 — strong 20 / medium 12 / weak 6 / stale 3 / unk 0
 *   options liquidity 0-20 — optionsLiquidityScore * 0.2
 *   timing/early      0-10 — full 10 when the move is real but NOT extended
 *                            (1.5%-5%); 5 up to 8%; 0 beyond (late alert)
 *   technicals        0-10 — 5 trend stack aligned + 5 VWAP side aligned
 *   risk penalty     -0-25 — riskScore * 0.25 subtracted
 *
 * Returns { score, breakdown, reasons } — breakdown is persisted so every
 * alert can show exactly where its number came from.
 */
export function setupScore(input = {}) {
  const reasons = [];

  const relVol = isNum(input.relVol) ? input.relVol : null;
  const relVolPart = relVol == null ? 0 : clamp(((relVol - 1) / 2.5) * 20, 0, 20);
  if (relVol != null && relVol >= 2) reasons.push(`Volume ${relVol}x average`);

  const absMove = Math.abs(Number(input.movePct ?? 0));
  const momentumPart = clamp((absMove / 5) * 15, 0, 15);
  if (absMove >= 1.5) reasons.push(`${absMove.toFixed(1)}% move`);

  const cq = input.catalystQuality ?? "unknown";
  const catalystPart = CATALYST_PART[cq] ?? 0;
  if (catalystPart >= 12) reasons.push(`Catalyst ${cq}: ${(input.catalystType ?? "").replace(/_/g, " ")}`);

  const liq = isNum(input.liquidityScore) ? input.liquidityScore : 0;
  const liquidityPart = clamp(liq * 0.2, 0, 20);
  if (liq >= 70) reasons.push("Liquid options market");

  let timingPart = 0;
  if (absMove >= 1.5 && absMove <= 5) timingPart = 10;
  else if (absMove > 5 && absMove <= 8) timingPart = 5;
  if (timingPart === 10) reasons.push("Caught early (not extended)");
  else if (absMove > 8) reasons.push("Late — move already extended");

  let technicalPart = 0;
  if (input.trendAligned) technicalPart += 5;
  if (input.vwapAligned) technicalPart += 5;
  if (technicalPart === 10) reasons.push("Trend + VWAP aligned");

  const risk = clamp(Number(input.riskScore ?? 0), 0, 100);
  const riskPenalty = clamp(risk * 0.25, 0, 25);

  const raw = relVolPart + momentumPart + catalystPart + liquidityPart + timingPart + technicalPart - riskPenalty;
  const score = Math.round(clamp(raw, 0, 100));

  const breakdown = {
    relVol: +relVolPart.toFixed(1),
    momentum: +momentumPart.toFixed(1),
    catalyst: catalystPart,
    liquidity: +liquidityPart.toFixed(1),
    timing: timingPart,
    technical: technicalPart,
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
