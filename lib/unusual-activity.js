/**
 * unusual-activity.js — pure functions that flag "unusual" option contracts from
 * a chain snapshot: day volume that is large relative to open interest (fresh
 * positioning), with liquidity + premium floors so we don't surface junk.
 *
 * No network — safe to unit test. Input contracts are the normalized shape from
 * polygon-provider.parseOptionsSnapshot (volume, openInterest, iv, delta, mid,
 * spreadPct, strike, expiration, dte, side, underlyingPrice, optionSymbol).
 */

export const DEFAULT_UNUSUAL_CONFIG = {
  minVolume: 200, // contract must actually trade today
  minVolOiRatio: 1.0, // volume >= OI is notable; >2 is loud
  minOpenInterest: 0, // floor on OI (0 = allow brand-new strikes)
  maxSpreadPct: 30, // avoid untradeable wide markets
  minMid: 0.05, // skip near-worthless lottery premium
  topPerUnderlying: 6, // cap hits per symbol so one name can't flood
};

export function unusualConfigFromEnv(env = process.env) {
  return {
    minVolume: Number(env.UNUSUAL_MIN_VOLUME ?? DEFAULT_UNUSUAL_CONFIG.minVolume),
    minVolOiRatio: Number(env.UNUSUAL_MIN_VOL_OI ?? DEFAULT_UNUSUAL_CONFIG.minVolOiRatio),
    minOpenInterest: Number(env.UNUSUAL_MIN_OI ?? DEFAULT_UNUSUAL_CONFIG.minOpenInterest),
    maxSpreadPct: Number(env.UNUSUAL_MAX_SPREAD_PCT ?? DEFAULT_UNUSUAL_CONFIG.maxSpreadPct),
    minMid: Number(env.UNUSUAL_MIN_MID ?? DEFAULT_UNUSUAL_CONFIG.minMid),
    topPerUnderlying: Number(env.UNUSUAL_TOP_PER_UNDERLYING ?? DEFAULT_UNUSUAL_CONFIG.topPerUnderlying),
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function gradeFromScore(score) {
  if (score >= 80) return "STRONG";
  if (score >= 65) return "GOOD";
  if (score >= 50) return "WATCH";
  return "SKIP";
}

function normalizeIvPct(iv) {
  if (iv == null) return null;
  return iv <= 5 ? +(iv * 100).toFixed(1) : +Number(iv).toFixed(1);
}

/**
 * Score a single contract's "unusualness" 0-100.
 * Weighted by volume/OI ratio, absolute volume, and tradeability (spread).
 */
export function scoreUnusual(contract, cfg = DEFAULT_UNUSUAL_CONFIG) {
  const volume = num(contract.volume);
  const oi = num(contract.openInterest);
  const ratio = oi > 0 ? +(volume / oi).toFixed(2) : (volume > 0 ? Infinity : 0);
  const reasons = [];

  // Ratio component (up to 45): 1x -> ~11, 2x -> ~22, 4x+ -> capped 45.
  const ratioForScore = ratio === Infinity ? 6 : ratio;
  const ratioPart = Math.min(45, ratioForScore * 11);
  if (ratio === Infinity) reasons.push(`Volume ${volume.toLocaleString()} vs 0 OI (new positioning)`);
  else if (ratio >= 1) reasons.push(`Volume ${ratio}x open interest`);

  // Absolute volume component (up to 30): 1k -> ~15, 5k+ -> capped 30.
  const volPart = Math.min(30, (volume / 5000) * 30);
  if (volume >= 5000) reasons.push(`Heavy volume ${volume.toLocaleString()}`);
  else if (volume >= 1000) reasons.push(`Volume ${volume.toLocaleString()}`);

  // Tradeability component (up to 15): tight spread rewarded.
  let spreadPart = 8;
  if (contract.spreadPct != null) {
    spreadPart = Math.max(0, 15 * (1 - contract.spreadPct / (cfg.maxSpreadPct || 30)));
    if (contract.spreadPct <= 6) reasons.push(`Tight spread ${contract.spreadPct}%`);
    else if (contract.spreadPct > (cfg.maxSpreadPct || 30) * 0.7) reasons.push(`Wide spread ${contract.spreadPct}%`);
  }

  // Liquidity bonus (up to 10) for real open interest behind it.
  const oiPart = Math.min(10, (oi / 5000) * 10);
  if (oi >= 5000) reasons.push(`Deep OI ${oi.toLocaleString()}`);

  const ivPct = normalizeIvPct(contract.iv);
  if (ivPct != null && ivPct > 120) reasons.push(`High IV ${Math.round(ivPct)}%`);

  const score = Math.round(Math.max(0, Math.min(100, ratioPart + volPart + spreadPart + oiPart)));
  return { score, grade: gradeFromScore(score), ratio, ivPct, reasons };
}

/**
 * Filter + score a chain for unusual contracts and return the top hits.
 * @param {Array} contracts normalized contracts (both sides)
 * @param {object} opts config overrides + { symbol }
 * @returns {Array} ranked unusual hits
 */
export function detectUnusualContracts(contracts = [], opts = {}) {
  const cfg = { ...DEFAULT_UNUSUAL_CONFIG, ...opts };
  const symbol = opts.symbol ? String(opts.symbol).toUpperCase() : null;

  const hits = [];
  for (const c of contracts) {
    const volume = num(c.volume);
    const oi = num(c.openInterest);
    if (volume < cfg.minVolume) continue;
    if (cfg.minOpenInterest && oi < cfg.minOpenInterest) continue;
    if (cfg.minMid && c.mid != null && c.mid < cfg.minMid) continue;
    if (cfg.maxSpreadPct != null && c.spreadPct != null && c.spreadPct > cfg.maxSpreadPct) continue;

    const ratio = oi > 0 ? volume / oi : (volume > 0 ? Infinity : 0);
    if (ratio < cfg.minVolOiRatio) continue;

    const { score, grade, ivPct, reasons } = scoreUnusual(c, cfg);
    hits.push({
      symbol,
      optionSymbol: c.optionSymbol,
      side: c.side,
      strike: c.strike,
      expiration: c.expiration,
      dte: c.dte,
      volume,
      openInterest: oi,
      volOiRatio: ratio === Infinity ? null : +ratio.toFixed(2),
      newPositioning: ratio === Infinity,
      mid: c.mid,
      bid: c.bid,
      ask: c.ask,
      spreadPct: c.spreadPct,
      delta: c.delta,
      iv: ivPct,
      underlyingPrice: c.underlyingPrice,
      score,
      grade,
      reason: reasons.slice(0, 3).join(" · ") || "Unusual volume",
      reasons,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return cfg.topPerUnderlying ? hits.slice(0, cfg.topPerUnderlying) : hits;
}

export { gradeFromScore };
