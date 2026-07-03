/**
 * options-signals.js — pure functions that turn an equity momentum setup + an
 * option chain into a ranked options SIGNAL (calls/puts, strike, expiry, entry,
 * score, reason). No network, no order placement — safe to unit test.
 */

export const DEFAULT_OPTIONS_CONFIG = {
  targetDelta: 0.4,
  dteMin: 3,
  dteMax: 45,
  maxSpreadPct: 15,
  minOpenInterest: 100,
  minVolume: 0,
};

export function optionsConfigFromEnv(env = process.env) {
  return {
    targetDelta: Number(env.OPTIONS_TARGET_DELTA ?? DEFAULT_OPTIONS_CONFIG.targetDelta),
    dteMin: Number(env.OPTIONS_MIN_DTE ?? DEFAULT_OPTIONS_CONFIG.dteMin),
    dteMax: Number(env.OPTIONS_MAX_DTE ?? DEFAULT_OPTIONS_CONFIG.dteMax),
    maxSpreadPct: Number(env.OPTIONS_MAX_SPREAD_PCT ?? DEFAULT_OPTIONS_CONFIG.maxSpreadPct),
    minOpenInterest: Number(env.OPTIONS_MIN_OPEN_INTEREST ?? DEFAULT_OPTIONS_CONFIG.minOpenInterest),
    minVolume: Number(env.OPTIONS_MIN_VOLUME ?? DEFAULT_OPTIONS_CONFIG.minVolume),
  };
}

/**
 * Decide directional bias from the underlying momentum context.
 * @returns {{ side: "call"|"put"|null, bias: string, reasons: string[] }}
 */
export function deriveDirection(ctx = {}) {
  const move = Number(ctx.movePct ?? 0);
  const vwapRaw = ctx.priceVsVwapPct;
  const vwap = vwapRaw == null ? null : Number(vwapRaw);
  const macd = ctx.macd || {};
  const momentum = ctx.momentum || {};
  const reasons = [];
  let bull = 0;
  let bear = 0;

  if (move > 0) { bull += 1; reasons.push(`Up ${move.toFixed(1)}% on the day`); }
  else if (move < 0) { bear += 1; reasons.push(`Down ${Math.abs(move).toFixed(1)}% on the day`); }

  if (vwap != null && Number.isFinite(vwap)) {
    if (vwap >= 0) { bull += 1; reasons.push(`Above VWAP (+${vwap.toFixed(1)}%)`); }
    else { bear += 1; reasons.push(`Below VWAP (${vwap.toFixed(1)}%)`); }
  }

  if (macd.bullish) { bull += 1; reasons.push("MACD bullish"); }
  else if (macd.bearish) { bear += 1; reasons.push("MACD bearish"); }

  if (momentum.accelerating) { bull += 1; reasons.push("Momentum accelerating"); }
  if (momentum.fading) { bear += 1; reasons.push("Fading from high of day"); }

  let side = null;
  let bias = "neutral";
  if (bull > bear) { side = "call"; bias = "bullish"; }
  else if (bear > bull) { side = "put"; bias = "bearish"; }
  else if (move !== 0) { side = move > 0 ? "call" : "put"; bias = move > 0 ? "bullish" : "bearish"; }

  return { side, bias, reasons };
}

function isFinitePos(n) {
  return Number.isFinite(n) && n > 0;
}

/**
 * Pick the best contract from a chain for a given side, targeting a delta band,
 * DTE window, tight spread, and sufficient liquidity.
 */
export function selectContract(contracts = [], opts = {}) {
  const cfg = { ...DEFAULT_OPTIONS_CONFIG, ...opts };
  const side = opts.side;
  const targetDelta = Math.abs(cfg.targetDelta);

  const pool = contracts.filter((c) => {
    if (side && c.side !== side) return false;
    if (c.dte != null && (c.dte < cfg.dteMin || c.dte > cfg.dteMax)) return false;
    if (!isFinitePos(c.mid)) return false;
    if (cfg.minOpenInterest && (c.openInterest ?? 0) < cfg.minOpenInterest) return false;
    if (cfg.minVolume && (c.volume ?? 0) < cfg.minVolume) return false;
    if (cfg.maxSpreadPct != null && c.spreadPct != null && c.spreadPct > cfg.maxSpreadPct) return false;
    return true;
  });
  if (!pool.length) return null;

  const scored = pool.map((c) => {
    const absDelta = c.delta != null ? Math.abs(c.delta) : targetDelta;
    const deltaMatch = 1 - Math.min(1, Math.abs(absDelta - targetDelta) / 0.5);
    const spreadScore = c.spreadPct == null ? 0.5 : Math.max(0, 1 - c.spreadPct / (cfg.maxSpreadPct || 15));
    const oiScore = Math.min(1, (c.openInterest ?? 0) / 1000);
    const volScore = Math.min(1, (c.volume ?? 0) / 500);
    const contractScore = +(
      deltaMatch * 0.5 + spreadScore * 0.25 + oiScore * 0.15 + volScore * 0.1
    ).toFixed(4);
    return { ...c, contractScore, absDelta };
  });

  scored.sort((a, b) => b.contractScore - a.contractScore);
  return scored[0];
}

export function breakeven(contract) {
  if (!contract || contract.strike == null || contract.mid == null) return null;
  return contract.side === "put"
    ? +(contract.strike - contract.mid).toFixed(2)
    : +(contract.strike + contract.mid).toFixed(2);
}

/**
 * Score an options signal 0-100 combining the underlying setup strength with the
 * chosen contract's quality (delta match, liquidity, spread, IV sanity).
 */
export function scoreOptionSignal(ctx = {}, contract, direction) {
  if (!contract) return { score: 0, reasons: [], warnings: ["No suitable contract found"] };
  const reasons = [];
  const warnings = [];

  const setup = Number(ctx.signalScore ?? ctx.setupScore ?? 0);
  const setupPart = Math.max(0, Math.min(50, setup * 0.5));
  if (setup >= 70) reasons.push(`Strong underlying setup (${Math.round(setup)}/100)`);
  else if (setup >= 50) reasons.push(`Moderate underlying setup (${Math.round(setup)}/100)`);

  const contractPart = Math.max(0, Math.min(40, (contract.contractScore ?? 0) * 40));
  if ((contract.openInterest ?? 0) >= 500) reasons.push(`Liquid: ${contract.openInterest} OI`);
  if (contract.spreadPct != null && contract.spreadPct <= 5) reasons.push(`Tight spread ${contract.spreadPct}%`);
  else if (contract.spreadPct != null && contract.spreadPct > 12) warnings.push(`Wide spread ${contract.spreadPct}%`);

  let ivPart = 10;
  if (contract.iv != null) {
    const ivPct = contract.iv <= 5 ? contract.iv * 100 : contract.iv;
    if (ivPct > 150) { ivPart = 2; warnings.push(`Very high IV ${Math.round(ivPct)}%`); }
    else if (ivPct > 80) { ivPart = 6; reasons.push(`Elevated IV ${Math.round(ivPct)}%`); }
    else { reasons.push(`IV ${Math.round(ivPct)}%`); }
  }

  if (contract.absDelta != null) reasons.push(`Delta ${contract.absDelta.toFixed(2)}`);
  if (Array.isArray(direction?.reasons)) reasons.push(...direction.reasons);

  const score = Math.round(Math.max(0, Math.min(100, setupPart + contractPart + ivPart)));
  return { score, reasons: [...new Set(reasons)], warnings };
}

function gradeFromScore(score) {
  if (score >= 80) return "STRONG";
  if (score >= 65) return "GOOD";
  if (score >= 50) return "WATCH";
  return "SKIP";
}

/**
 * Build a complete options signal for one underlying from its momentum context
 * and an option chain (array of contracts).
 */
export function buildOptionSignal(ctx = {}, contracts = [], opts = {}) {
  const cfg = { ...DEFAULT_OPTIONS_CONFIG, ...opts };
  const direction = deriveDirection(ctx);
  if (!direction.side) {
    return {
      symbol: ctx.symbol || ctx.ticker || null,
      side: null,
      bias: "neutral",
      grade: "SKIP",
      score: 0,
      reason: "No clear directional bias",
      contract: null,
    };
  }

  const contract = selectContract(contracts, { ...cfg, side: direction.side });
  const { score, reasons, warnings } = scoreOptionSignal(ctx, contract, direction);
  const be = breakeven(contract);

  return {
    symbol: ctx.symbol || ctx.ticker || null,
    underlyingPrice: Number(ctx.price ?? contract?.underlyingPrice ?? null) || null,
    side: direction.side,
    bias: direction.bias,
    grade: gradeFromScore(contract ? score : 0),
    score: contract ? score : 0,
    contract: contract ? {
      optionSymbol: contract.optionSymbol,
      side: contract.side,
      strike: contract.strike,
      expiration: contract.expiration,
      dte: contract.dte,
      entry: contract.mid,
      bid: contract.bid,
      ask: contract.ask,
      delta: contract.delta,
      iv: contract.iv,
      openInterest: contract.openInterest,
      volume: contract.volume,
      spreadPct: contract.spreadPct,
      breakeven: be,
    } : null,
    reason: reasons.slice(0, 4).join(" · ") || direction.reasons.join(" · "),
    reasons,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

export { gradeFromScore };
