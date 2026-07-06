/**
 * options-pressure.js — a simple internal "options pressure confirmation"
 * read from the 0DTE chain snapshot at trigger time. Inspired by the CONCEPT
 * of flow tools (options activity confirming/weakening the underlying move) —
 * NOT a clone of anyone's proprietary logic, and explicitly NOT institutional
 * certainty. It is confirmation context, nothing more.
 *
 * Inputs are the normalized 0DTE contracts we already fetched (no extra API
 * cost). Deterministic, pure, unit tested.
 *
 * Signals:
 *   volume share    — call volume vs put volume
 *   premium share   — volume × mid per side (dollar-weighted conviction)
 *   concentration   — top strike's share of total volume (0DTE crowds pool)
 *   liquidity floor — total volume < 500 contracts = too poor to read
 *
 * Labels: "More call volume than puts" / "More put volume than puts" / "Mixed flow" /
 * "No clear options confirmation" / "Flow fading" (only from refresh deltas)
 * / "Liquidity too poor".
 *
 * These describe OPTIONS activity — not stock price direction. Use `alignHint`
 * when you have tape direction to explain mismatches (e.g. calls heavy while dipping).
 */

const CALL_LABEL = "More call volume than puts";
const PUT_LABEL = "More put volume than puts";
const LEGACY_CALL = "Call pressure building";
const LEGACY_PUT = "Put pressure building";

const isCallHeavy = (label) => label === CALL_LABEL || label === LEGACY_CALL;
const isPutHeavy = (label) => label === PUT_LABEL || label === LEGACY_PUT;

export function alignHint(label, direction) {
  if (!label || !direction || direction === "neutral" || direction === "chop") return null;
  if (direction === "bearish" && isCallHeavy(label)) {
    return "Stock is falling but call options dominate — often hedging, dip-buying, or lag. Not a clean bullish read.";
  }
  if (direction === "bullish" && isPutHeavy(label)) {
    return "Stock is rising but put options dominate — often hedging or fade bets. Not a clean bearish read.";
  }
  if (direction === "bullish" && isCallHeavy(label)) return "Options flow agrees with the upward move.";
  if (direction === "bearish" && isPutHeavy(label)) return "Options flow agrees with the downward move.";
  return null;
}

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

export function optionsPressure(contracts = [], opts = {}) {
  let callVol = 0, putVol = 0, callPrem = 0, putPrem = 0;
  const strikeVol = new Map();
  for (const c of contracts) {
    const v = isNum(c.volume) ? c.volume : 0;
    const prem = v * (isNum(c.mid) ? c.mid : 0);
    if (c.side === "call") { callVol += v; callPrem += prem; }
    else if (c.side === "put") { putVol += v; putPrem += prem; }
    if (c.strike != null) strikeVol.set(c.strike, (strikeVol.get(c.strike) ?? 0) + v);
  }
  const totalVol = callVol + putVol;
  const totalPrem = callPrem + putPrem;
  const volShare = totalVol > 0 ? callVol / totalVol : 0.5;      // 1 = all calls
  const premShare = totalPrem > 0 ? callPrem / totalPrem : 0.5;
  const topStrike = Math.max(0, ...strikeVol.values());
  const concentration = totalVol > 0 ? +(topStrike / totalVol).toFixed(2) : 0;

  const detail = {
    callVolume: callVol, putVolume: putVol,
    callPremium: Math.round(callPrem), putPremium: Math.round(putPrem),
    volShare: +volShare.toFixed(2), premShare: +premShare.toFixed(2),
    concentration, totalVolume: totalVol,
  };

  if (totalVol < 500) return { label: "Liquidity too poor", score: 0, ...detail };

  // Refresh-time fading check: volume stalled AND spreads widening since last look.
  if (opts.prev && isNum(opts.prev.totalVolume) && isNum(opts.prev.avgSpreadPct)) {
    const volDelta = totalVol - opts.prev.totalVolume;
    const spreads = contracts.map((c) => c.spreadPct).filter(isNum);
    const avgSpread = spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
    if (volDelta < totalVol * 0.01 && avgSpread != null && avgSpread > opts.prev.avgSpreadPct * 1.3) {
      return { label: "Flow fading", score: 20, ...detail };
    }
  }

  // Both volume AND premium must agree for a directional read.
  const callSide = volShare >= 0.62 && premShare >= 0.58;
  const putSide = volShare <= 0.38 && premShare <= 0.42;
  const strength = Math.round(Math.abs(volShare - 0.5) * 100 + Math.abs(premShare - 0.5) * 80 + concentration * 20);

  if (callSide) {
    const label = CALL_LABEL;
    const stockAligned = opts.direction === "bullish" ? true : opts.direction === "bearish" ? false : null;
    return {
      label,
      score: Math.min(100, 40 + strength),
      stockAligned,
      hint: alignHint(label, opts.direction),
      ...detail,
    };
  }
  if (putSide) {
    const label = PUT_LABEL;
    const stockAligned = opts.direction === "bearish" ? true : opts.direction === "bullish" ? false : null;
    return {
      label,
      score: Math.min(100, 40 + strength),
      stockAligned,
      hint: alignHint(label, opts.direction),
      ...detail,
    };
  }
  const oneAgrees = volShare >= 0.58 || volShare <= 0.42 || premShare >= 0.58 || premShare <= 0.42;
  if (oneAgrees) return { label: "Mixed flow", score: 35, ...detail };
  return { label: "No clear options confirmation", score: 25, ...detail };
}

/** Does the pressure read agree with the tape direction? (context chip) */
export function pressureConfirms(label, direction) {
  if (direction === "bullish") return isCallHeavy(label);
  if (direction === "bearish") return isPutHeavy(label);
  return false;
}
