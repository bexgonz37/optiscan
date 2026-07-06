/**
 * zero-dte.js — the 0DTE options-momentum brain. All pure functions, all
 * deterministic, no network/DB/AI — safe to unit test and fast enough to run
 * inside the every-second scanner loop.
 *
 * Design rule from the spec: a big move is NOT automatically bad. Being up
 * 15% triggers continuation/exhaustion analysis, not a skip. What kills a
 * 0DTE setup is structure: wide spreads, dead contracts, chop, deceleration,
 * or premium that already prices in more move than realistically remains.
 * Catalysts are context only — nothing in here reads news.
 *
 * Ring buffer convention: array of { t (ms), p (price), v (cumulative day
 * volume) } ticks, oldest first, pushed ~once per second by the loop.
 */

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Price rate of change over a trailing window, in %/minute. */
function ratePctPerMin(ring, windowMs, nowMs) {
  if (!Array.isArray(ring) || ring.length < 2) return null;
  const end = ring[ring.length - 1];
  const startT = (nowMs ?? end.t) - windowMs;
  let start = ring[0];
  for (const tick of ring) { if (tick.t <= startT) start = tick; else break; }
  const dtMin = (end.t - start.t) / 60000;
  if (dtMin <= 0 || !isNum(start.p) || !isNum(end.p) || start.p <= 0) return null;
  return ((end.p - start.p) / start.p) * 100 / dtMin;
}

/**
 * Acceleration read: short-window rate vs long-window rate (%/min).
 * accel > 0 -> the move is speeding up; < 0 -> decelerating.
 */
export function acceleration(ring, { shortMs = 15000, longMs = 90000, nowMs } = {}) {
  const shortRate = ratePctPerMin(ring, shortMs, nowMs);
  const longRate = ratePctPerMin(ring, longMs, nowMs);
  if (shortRate == null || longRate == null) return { shortRate, longRate, accel: null };
  return { shortRate: +shortRate.toFixed(3), longRate: +longRate.toFixed(3), accel: +(shortRate - longRate).toFixed(3) };
}

/** Per-second traded volume, short window vs long window -> surge ratio. */
export function volumeSurge(ring, { shortMs = 30000, longMs = 180000, nowMs } = {}) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const end = ring[ring.length - 1];
  const now = nowMs ?? end.t;
  const rate = (windowMs) => {
    const startT = now - windowMs;
    let start = ring[0];
    for (const tick of ring) { if (tick.t <= startT) start = tick; else break; }
    const dtSec = (end.t - start.t) / 1000;
    if (dtSec <= 0 || !isNum(start.v) || !isNum(end.v)) return null;
    return Math.max(0, end.v - start.v) / dtSec;
  };
  const s = rate(shortMs);
  const l = rate(longMs);
  if (s == null || l == null || l <= 0) return null;
  return +(s / l).toFixed(2);
}

/**
 * Path efficiency 0-1: |net move| / sum of |tick moves| over the window.
 * 1 = clean straight-line move; near 0 = pure chop. "Too choppy" < 0.30.
 */
export function pathEfficiency(ring, { windowMs = 120000, nowMs } = {}) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const end = ring[ring.length - 1];
  const startT = (nowMs ?? end.t) - windowMs;
  const win = ring.filter((x) => x.t >= startT && isNum(x.p));
  if (win.length < 4) return null;
  let path = 0;
  for (let i = 1; i < win.length; i++) path += Math.abs(win[i].p - win[i - 1].p);
  if (path <= 0) return 0;
  return +(Math.abs(win[win.length - 1].p - win[0].p) / path).toFixed(3);
}

/** High/low-of-day + VWAP relationship. Break = at/through the level. */
export function detectLevels({ price, dayHigh, dayLow, vwap }) {
  const out = { hodBreak: false, nearHod: false, lodBreak: false, nearLod: false, aboveVwap: null, vwapDistPct: null };
  if (isNum(price) && isNum(dayHigh) && dayHigh > 0) {
    out.hodBreak = price >= dayHigh * 0.999;
    out.nearHod = !out.hodBreak && price >= dayHigh * 0.995;
  }
  if (isNum(price) && isNum(dayLow) && dayLow > 0) {
    out.lodBreak = price <= dayLow * 1.001;
    out.nearLod = !out.lodBreak && price <= dayLow * 1.005;
  }
  if (isNum(price) && isNum(vwap) && vwap > 0) {
    out.aboveVwap = price >= vwap;
    out.vwapDistPct = +(((price - vwap) / vwap) * 100).toFixed(2);
  }
  return out;
}

/**
 * Direction engine — THE call-vs-put question. Points-based and symmetric:
 *   day move sign, short-rate sign, acceleration sign, VWAP side, HOD/LOD
 *   break each vote bull or bear. Chop (efficiency < 0.30) or a tie reads as
 *   'choppy' — no directional bias is claimed that the tape doesn't show.
 * Confidence 0-100 scales with vote margin and move quality.
 */
export function directionRead({ movePct, shortRate, accel, aboveVwap, hodBreak, lodBreak, efficiency }) {
  let bull = 0;
  let bear = 0;
  const reasons = [];
  if (isNum(movePct) && movePct > 0.15) { bull++; reasons.push(`Up ${movePct.toFixed(1)}% on the day`); }
  else if (isNum(movePct) && movePct < -0.15) { bear++; reasons.push(`Down ${Math.abs(movePct).toFixed(1)}% on the day`); }
  if (isNum(shortRate) && shortRate > 0.05) { bull++; reasons.push("Pushing up right now"); }
  else if (isNum(shortRate) && shortRate < -0.05) { bear++; reasons.push("Pushing down right now"); }
  if (isNum(accel) && accel > 0.03) { bull += shortRate > 0 ? 1 : 0; bear += shortRate < 0 ? 1 : 0; }
  if (aboveVwap === true) { bull++; reasons.push("Above VWAP"); }
  else if (aboveVwap === false) { bear++; reasons.push("Below VWAP"); }
  if (hodBreak) { bull++; reasons.push("Breaking high of day"); }
  if (lodBreak) { bear++; reasons.push("Breaking low of day"); }

  const tooChoppy = isNum(efficiency) && efficiency < 0.3;
  if (tooChoppy) reasons.push(`Choppy tape (efficiency ${efficiency})`);
  const margin = Math.abs(bull - bear);
  if (tooChoppy || margin === 0) {
    return { direction: "choppy", confidence: clamp(20 + margin * 10, 0, 45), bull, bear, reasons };
  }
  const direction = bull > bear ? "bullish" : "bearish";
  const confidence = clamp(35 + margin * 15 + (isNum(efficiency) ? efficiency * 20 : 0), 0, 100);
  return { direction, confidence: Math.round(confidence), bull, bear, reasons };
}

/**
 * Continuation vs exhaustion. A +15% mover that is STILL accelerating with
 * expanding volume and a level break is 'continuing' — size alone never
 * downgrades it. What downgrades: deceleration, fading volume, losing VWAP,
 * or the tape turning against the move.
 */
export function moveStatus({ movePct, shortRate, accel, direction, aboveVwap, hodBreak, lodBreak, surge, efficiency }) {
  const absMove = Math.abs(Number(movePct ?? 0));
  const dirUp = direction === "bullish";
  const rateAligned = isNum(shortRate) && (dirUp ? shortRate > 0 : shortRate < 0);
  const accelerating = isNum(accel) && (dirUp ? accel > 0 : accel < 0);
  const vwapOk = aboveVwap == null ? true : dirUp ? aboveVwap : !aboveVwap;
  const levelBreak = dirUp ? hodBreak : lodBreak;
  const volumeOk = surge == null ? true : surge >= 0.8;
  const volumeExpanding = surge != null && surge >= 1.2;

  if (!rateAligned || !vwapOk) return "exhausted";
  if (isNum(efficiency) && efficiency < 0.3) return "extended_risky";
  if (absMove < 2 && (accelerating || levelBreak)) return "early";
  if ((accelerating || levelBreak) && volumeOk) return "continuing"; // any size — this is the 0DTE point
  if (absMove >= 5 && !accelerating && volumeExpanding) return "extended_tradable";
  if (absMove >= 5) return "extended_risky";
  return volumeOk ? "continuing" : "extended_risky";
}

export const MOVE_STATUS_LABEL = {
  early: "Early Move",
  continuing: "Continuation Setup",
  extended_tradable: "Extended But Still Tradable",
  extended_risky: "Chase Risk",
  exhausted: "Move Exhausted",
};

/**
 * Rough remaining-move estimate (% of underlying) for premium sanity checks:
 * half the current short rate carried for up to 30 more minutes, floored and
 * capped. A deliberately conservative heuristic, documented as such.
 */
export function expectedRemainingMovePct({ shortRate, minsToClose }) {
  if (!isNum(shortRate)) return 0.5;
  const mins = clamp(Number(minsToClose ?? 60), 0, 30);
  return +clamp(Math.abs(shortRate) * mins * 0.5, 0.15, 3).toFixed(2);
}

/**
 * 0DTE Contract Score (0-100) — is THIS contract worth watching right now?
 *
 * Weights:
 *   spread        30 — 0% -> 30, linear to 0 at >=12%. Spread is the whole
 *                      game on 0DTE; you pay it twice within minutes.
 *   volume        20 — 2,000+ contracts today -> full.
 *   open interest 10 — 500+ -> full (0DTE OI is naturally light intraday).
 *   delta zone    15 — |delta| 0.30-0.70 full; 0.20-0.30 / 0.70-0.85 partial;
 *                      lotto wings and deep ITM get 0. Never "cheapest wins".
 *   IV sanity     10 — 0DTE IV is naturally huge; only truly hot tape is
 *                      penalized: <=250% full, <=400% partial, above -> 0.
 *   time left     10 — >120 min -> 10, 45-120 -> 6, <45 -> 2 (theta cliff).
 *   premium vs move 5 — breakeven move required <= expected remaining move.
 *
 * Also returns risk booleans used for flags/labels.
 */
export function zeroDteContractScore(contract = {}, { minsToClose, expRemainPct } = {}) {
  const reasons = [];
  const spreadPct = isNum(contract.spreadPct) ? contract.spreadPct : null;
  const volume = isNum(contract.volume) ? contract.volume : 0;
  const oi = isNum(contract.openInterest) ? contract.openInterest : 0;
  const absDelta = isNum(contract.delta) ? Math.abs(contract.delta) : null;
  const ivPct = contract.iv == null ? null : contract.iv <= 5 ? contract.iv * 100 : contract.iv;
  const mins = isNum(minsToClose) ? minsToClose : 240;

  const spreadPart = spreadPct == null ? 0 : clamp(30 * (1 - spreadPct / 12), 0, 30);
  if (spreadPct != null && spreadPct <= 4) reasons.push(`Tight spread ${spreadPct}%`);
  const spreadTooWide = spreadPct == null || spreadPct > 10;
  if (spreadTooWide) reasons.push(spreadPct == null ? "No live quote" : `Spread too wide ${spreadPct}%`);

  const volPart = clamp((volume / 2000) * 20, 0, 20);
  if (volume >= 2000) reasons.push(`Active ${volume.toLocaleString()} contracts`);
  const oiPart = clamp((oi / 500) * 10, 0, 10);
  const lowLiquidity = volume < 100 && oi < 100;
  if (lowLiquidity) reasons.push("Low liquidity");

  let deltaPart = 0;
  if (absDelta != null) {
    if (absDelta >= 0.3 && absDelta <= 0.7) { deltaPart = 15; reasons.push(`Delta ${absDelta.toFixed(2)} (usable zone)`); }
    else if (absDelta >= 0.2 && absDelta <= 0.85) deltaPart = 8;
  }

  let ivPart = 10;
  let ivTooHot = false;
  if (ivPct != null) {
    if (ivPct > 400) { ivPart = 0; ivTooHot = true; reasons.push(`IV too hot ${Math.round(ivPct)}%`); }
    else if (ivPct > 250) { ivPart = 5; ivTooHot = true; reasons.push(`IV elevated ${Math.round(ivPct)}%`); }
  }

  const timePart = mins > 120 ? 10 : mins >= 45 ? 6 : 2;
  const thetaRiskHigh = mins < 120; // afternoon 0DTE decays brutally, always flag

  // Premium sanity: what % move does breakeven need vs what plausibly remains?
  let premiumPart = 5;
  let premiumTooExpensive = false;
  const mid = isNum(contract.mid) ? contract.mid : isNum(contract.entry) ? contract.entry : null;
  const under = isNum(contract.underlyingPrice) ? contract.underlyingPrice : null;
  if (absDelta != null && absDelta < 0.2) {
    premiumPart = 0; // lotto wings: breakeven is realistically unreachable — never credit "cheap"
  } else if (mid != null && under != null && under > 0 && isNum(expRemainPct)) {
    const breakevenMovePct = (mid / under) * 100; // rough: premium as % of spot
    if (breakevenMovePct > expRemainPct * 1.5) { premiumPart = 0; premiumTooExpensive = true; reasons.push(`Premium prices in ${breakevenMovePct.toFixed(1)}% vs ~${expRemainPct}% likely left`); }
    else if (breakevenMovePct > expRemainPct) premiumPart = 2;
  }

  const score = Math.round(clamp(spreadPart + volPart + oiPart + deltaPart + ivPart + timePart + premiumPart, 0, 100));
  return { score, reasons, flags: { spreadTooWide, premiumTooExpensive, ivTooHot, thetaRiskHigh, lowLiquidity } };
}

/**
 * Call Watch Score & Put Watch Score (0-100 each, always both computed).
 * Symmetric factor list per spec; each side scores its own alignment:
 *   directional acceleration 20, VWAP behavior 15, HOD/LOD break 15,
 *   volume surge/relVol 15, clean trend (efficiency) 10, contract spread 10,
 *   contract volume+OI 10, delta responsiveness proxy 5.
 */
export function watchScores(input = {}) {
  const {
    shortRate, accel, aboveVwap, hodBreak, lodBreak, surge, relVol, efficiency,
    callContract, putContract, minsToClose, expRemainPct,
  } = input;

  const volSignal = clamp(Math.max(surge ?? 0, ((relVol ?? 1) - 1) / 2) , 0, 1); // 0-1
  const effPart = isNum(efficiency) ? clamp(efficiency / 0.7, 0, 1) * 10 : 5;

  const side = (dirUp, contract) => {
    let s = 0;
    const rate = isNum(shortRate) ? (dirUp ? shortRate : -shortRate) : 0;
    const acc = isNum(accel) ? (dirUp ? accel : -accel) : 0;
    const ratePart = clamp((rate / 0.4) * 12 + (acc > 0 ? 8 : 0), 0, 20); // accelerating in this direction
    s += ratePart;
    if (aboveVwap != null) s += (dirUp ? aboveVwap : !aboveVwap) ? 15 : 0; // holding/losing VWAP
    s += (dirUp ? hodBreak : lodBreak) ? 15 : 0;
    s += clamp(volSignal * 15, 0, 15);
    s += effPart;
    if (contract) {
      const c = zeroDteContractScore(contract, { minsToClose, expRemainPct });
      s += contract.spreadPct != null ? clamp(10 * (1 - contract.spreadPct / 12), 0, 10) : 0;
      s += clamp(((contract.volume ?? 0) / 2000) * 6 + ((contract.openInterest ?? 0) / 500) * 4, 0, 10);
      const absDelta = contract.delta != null ? Math.abs(contract.delta) : null;
      s += absDelta != null && absDelta >= 0.3 && absDelta <= 0.7 ? 5 : 0;
      void c;
    }
    // No directional support at all (tape moving the other way, no level
    // break, wrong VWAP side) -> liquidity alone cannot make a side a watch:
    // cap so the OTHER side's score is the unambiguous call/put answer.
    const vwapAligned = aboveVwap != null && (dirUp ? aboveVwap : !aboveVwap);
    if (ratePart <= 0 && !(dirUp ? hodBreak : lodBreak) && !vwapAligned) {
      s = Math.min(s * 0.8, 40);
    }
    return Math.round(clamp(s, 0, 100));
  };

  return { callWatch: side(true, callContract), putWatch: side(false, putContract) };
}

/**
 * "Option Still Worth It?" (0-100 + verdict). The anti-"it's up too much"
 * check: continuation quality + contract quality + time left decide, not the
 * size of the move that already happened.
 */
export function optionStillWorthIt({ status, contractScore, minsToClose, spreadPct, efficiency }) {
  const statusPart = { early: 30, continuing: 30, extended_tradable: 18, extended_risky: 8, exhausted: 0 }[status] ?? 10;
  const contractPart = clamp((contractScore ?? 0) * 0.3, 0, 30);
  const mins = isNum(minsToClose) ? minsToClose : 240;
  const timePart = mins > 120 ? 15 : mins >= 45 ? 9 : mins >= 20 ? 4 : 0;
  const spreadPart = spreadPct == null ? 0 : spreadPct <= 8 ? 10 : spreadPct <= 12 ? 5 : 0;
  const effPart = isNum(efficiency) ? clamp(efficiency / 0.7, 0, 1) * 15 : 8;
  const score = Math.round(clamp(statusPart + contractPart + timePart + spreadPart + effPart, 0, 100));

  let verdict;
  if (isNum(efficiency) && efficiency < 0.3) verdict = "Too Choppy / Skip";
  else if (status === "exhausted") verdict = "Too Late / Skip";
  else if (status === "extended_risky") verdict = score >= 45 ? "Wait for Pullback" : "Chase Risk";
  else if (status === "extended_tradable") verdict = "Extended But Still Tradable";
  else if (status === "early") verdict = "Early Move";
  else verdict = "Continuation Setup";
  return { score, verdict };
}

/** Long-premium trade bias — the direct call-vs-put answer. */
export function tradeBias({ direction, status, callWatch, putWatch, contractScore, worthItScore }) {
  if (direction === "choppy") return "no_clean_setup";
  if (status === "exhausted") return "skip";
  if (status === "extended_risky") return worthItScore >= 45 ? "wait_for_pullback" : "chase_risk";
  const sideScore = direction === "bullish" ? callWatch : putWatch;
  if ((contractScore ?? 0) < 35 || sideScore < 45) return "watch_only";
  return direction === "bullish" ? "long_call_candidate" : "long_put_candidate";
}

export const TRADE_BIAS_LABEL = {
  long_call_candidate: "0DTE Call Watch",
  long_put_candidate: "0DTE Put Watch",
  watch_only: "Watch Only",
  wait_for_pullback: "Wait for Pullback",
  chase_risk: "Chase Risk",
  no_clean_setup: "Too Choppy",
  skip: "Skip",
};

/** The ten 0DTE risk labels. Pure derivation from computed values. */
export function riskFlags0dte({ flags = {}, status, efficiency, minsToClose, hodBreak, lodBreak, surge, direction }) {
  const out = [];
  if (flags.spreadTooWide) out.push("Spread Too Wide");
  if (flags.premiumTooExpensive) out.push("Premium Too Expensive");
  if (flags.ivTooHot) out.push("IV Too Hot");
  if (flags.thetaRiskHigh) out.push("Theta Risk High");
  if (status === "exhausted") out.push("Move Exhausted");
  if (isNum(efficiency) && efficiency < 0.3) out.push("Too Choppy");
  if (isNum(minsToClose) && minsToClose < 45) out.push("Late-Day Risk");
  if (flags.lowLiquidity) out.push("Low Liquidity");
  if (status === "extended_risky") out.push("Reversal Risk");
  if ((direction === "bullish" ? hodBreak : lodBreak) && surge != null && surge < 1.2) out.push("Fake Breakout Risk");
  return out;
}

/** Three-level risk chips for the popup. */
export const level = (v, medAt, highAt) => (v == null ? "Medium" : v >= highAt ? "High" : v >= medAt ? "Medium" : "Low");

/**
 * Trigger rule for the every-second loop — pure so it's unit-testable.
 * Fires on: real velocity + volume confirmation (or a level break), tape not
 * pure chop, and respect for the per-symbol cooldown. Deliberately does NOT
 * look at day-move size or catalysts — a +15% name that is still ripping
 * with volume triggers; a quiet drifter does not.
 */
export function shouldTrigger({
  shortRate, surge, hodBreak, lodBreak, efficiency, nowMs, cooldownUntil,
  minRate = 0.15, minSurge = 1.3, minLevelSurge = 1.2, minEfficiency = 0.35,
}) {
  if (isNum(cooldownUntil) && isNum(nowMs) && nowMs < cooldownUntil) return false;
  if (!isNum(shortRate) || Math.abs(shortRate) < minRate) return false;
  if (isNum(efficiency) && efficiency < minEfficiency) return false; // too choppy
  const volumeConfirms = surge != null && surge >= minSurge;
  const levelBreak = Boolean(hodBreak || lodBreak) && surge != null && surge >= minLevelSurge;
  return volumeConfirms || levelBreak;
}

/** True when ≥ minHits of the last window tick-rates meet minRate in signal direction. */
export function speedPersistentFromRing(ring, {
  minRate = 0.15, direction = "bullish", window = 5, minHits = 3, subWindowMs = 4000, nowMs,
} = {}) {
  if (!Array.isArray(ring) || ring.length < window) return false;
  const end = nowMs ?? ring[ring.length - 1]?.t;
  let hits = 0;
  for (let i = ring.length - window; i < ring.length; i++) {
    const sub = ring.slice(Math.max(0, i - Math.ceil(subWindowMs / 1000)), i + 1);
    if (sub.length < 2) continue;
    const rate = ratePctPerMin(sub, subWindowMs, end);
    if (rate == null) continue;
    if (direction === "bearish" && rate <= -minRate) hits++;
    else if (direction !== "bearish" && rate >= minRate) hits++;
  }
  return hits >= minHits;
}

/**
 * Rank one side's near-the-money 0DTE contracts. Never "cheapest", never
 * "highest volume blindly" — composite of liquidity, spread, delta zone,
 * premium sanity (via zeroDteContractScore).
 */
export function rankZeroDteContracts(contracts = [], side, { minsToClose, expRemainPct, max = 3 } = {}) {
  return contracts
    .filter((c) => c.side === side && c.mid != null && c.mid > 0)
    .map((c) => ({ contract: c, ...zeroDteContractScore(c, { minsToClose, expRemainPct }) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}
