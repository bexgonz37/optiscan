const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);

export interface StockMomentumPolicyConfig {
  minPrice: number;
  maxPrice: number;
  minDayVolume: number;
  minGainFromPrevClosePct: number;
  minRet10sPct: number;
  minRet30sPct: number;
  minRet60sPct: number;
  minVelocityPctPerMin: number;
  exceptionalVelocityPctPerMin: number;
  minVolumeAcceleration: number;
  maxSpreadPct: number;
  maxQuoteAgeMs: number;
  maxVwapExtensionPct: number;
}

export function stockMomentumPolicyConfig(env: NodeJS.ProcessEnv = process.env): StockMomentumPolicyConfig {
  return {
    minPrice: num(env.STOCK_MOMENTUM_MIN_PRICE, 0.5),
    maxPrice: num(env.STOCK_MOMENTUM_MAX_PRICE, 50),
    minDayVolume: num(env.STOCK_MOMENTUM_MIN_DAY_VOLUME ?? env.SCANNER_DISCOVERY_MIN_VOLUME, 500_000),
    minGainFromPrevClosePct: num(env.STOCK_MOMENTUM_MIN_GAIN_FROM_PREV_CLOSE_PCT, 10),
    minRet10sPct: num(env.STOCK_FAST_MIN_RET_10S_PCT, 0.40),
    minRet30sPct: num(env.STOCK_FAST_MIN_RET_30S_PCT, 1.00),
    minRet60sPct: num(env.STOCK_FAST_MIN_RET_60S_PCT, 1.50),
    minVelocityPctPerMin: num(env.STOCK_FAST_MIN_VELOCITY_PCT_PER_MIN, 2.00),
    exceptionalVelocityPctPerMin: num(env.STOCK_FAST_EXCEPTIONAL_VELOCITY_PCT_PER_MIN, 2.00),
    minVolumeAcceleration: num(env.STOCK_FAST_MIN_VOLUME_ACCELERATION, 0),
    maxSpreadPct: num(env.STOCK_MAX_SPREAD_PCT, 1.5),
    maxQuoteAgeMs: num(env.STOCK_MAX_QUOTE_AGE_MS, 15_000),
    maxVwapExtensionPct: num(env.STOCK_MAX_VWAP_EXT_PCT, 2.5),
  };
}

export interface BroadStockEligibilityInput {
  symbol?: string | null;
  price: number | null;
  dayVolume: number | null;
  gainFromPrevClosePct: number | null;
}

export interface StockMomentumFastInput extends BroadStockEligibilityInput {
  direction: "bullish" | "bearish" | "choppy" | string;
  ret10sPct: number | null;
  ret30sPct: number | null;
  ret60sPct: number | null;
  velocityPctPerMin: number | null;
  volumeAcceleration: number | null;
  volumeRate: number | null;
  spreadPct: number | null;
  quoteAgeMs: number | null;
  aboveVwap: boolean | null;
  hodBreak: boolean;
  vwapDistPct: number | null;
  classification?: string | null;
}

export interface StockPolicyDecision {
  ok: boolean;
  reason: string;
  failedGate?: string;
}

function fail(failedGate: string, reason: string): StockPolicyDecision {
  return { ok: false, failedGate, reason };
}

export function broadStockEligibility(
  input: BroadStockEligibilityInput,
  cfg: StockMomentumPolicyConfig = stockMomentumPolicyConfig(),
): StockPolicyDecision {
  if (!input.symbol) return fail("symbol", "missing symbol");
  if (!isNum(input.price)) return fail("price", "missing price");
  if (input.price < cfg.minPrice || input.price > cfg.maxPrice) {
    return fail("price", `price ${input.price.toFixed(2)} outside $${cfg.minPrice}-${cfg.maxPrice}`);
  }
  if (!isNum(input.dayVolume) || input.dayVolume < cfg.minDayVolume) {
    return fail("volume", `day volume ${input.dayVolume ?? "n/a"} < ${cfg.minDayVolume}`);
  }
  if (!isNum(input.gainFromPrevClosePct) || input.gainFromPrevClosePct < cfg.minGainFromPrevClosePct) {
    return fail("gain", `gain ${input.gainFromPrevClosePct ?? "n/a"}% < +${cfg.minGainFromPrevClosePct}%`);
  }
  return { ok: true, reason: "broad stock runner eligible" };
}

export function fastStockMomentumEligibility(
  input: StockMomentumFastInput,
  cfg: StockMomentumPolicyConfig = stockMomentumPolicyConfig(),
): StockPolicyDecision {
  const broad = broadStockEligibility(input, cfg);
  if (!broad.ok) return broad;
  if (input.direction !== "bullish") return fail("direction", `direction ${input.direction} is not bullish`);
  if (isNum(input.quoteAgeMs) && input.quoteAgeMs > cfg.maxQuoteAgeMs) return fail("freshness", `quote age ${input.quoteAgeMs}ms > ${cfg.maxQuoteAgeMs}ms`);
  if (!isNum(input.spreadPct)) return fail("spread", "missing two-sided spread");
  if (input.spreadPct > cfg.maxSpreadPct) return fail("spread", `spread ${input.spreadPct}% > ${cfg.maxSpreadPct}%`);
  if (isNum(input.vwapDistPct) && input.vwapDistPct >= cfg.maxVwapExtensionPct) {
    return fail("vwap_extension", `VWAP extension ${input.vwapDistPct.toFixed(2)}% >= ${cfg.maxVwapExtensionPct}%`);
  }
  if (input.classification === "SLOW_GRINDER" || input.classification === "LATE_EXHAUSTION" || input.classification === "NOISY_ILLIQUID_SPIKE") {
    return fail("classification", `classification ${input.classification} is suppressed`);
  }

  const structureOk = input.hodBreak || input.aboveVwap === true;
  if (!structureOk) return fail("structure", "not above VWAP and no HOD break");

  const volumeOk = isNum(input.volumeRate) && input.volumeRate > 0 &&
    (!isNum(input.volumeAcceleration) || input.volumeAcceleration >= cfg.minVolumeAcceleration);
  if (!volumeOk) return fail("volume_now", "current volume impulse not confirmed");

  const ret10Ok = isNum(input.ret10sPct) && input.ret10sPct >= cfg.minRet10sPct;
  const ret30Ok = isNum(input.ret30sPct) && input.ret30sPct >= cfg.minRet30sPct;
  const ret60Ok = isNum(input.ret60sPct) && input.ret60sPct >= cfg.minRet60sPct;
  const velocityOk = isNum(input.velocityPctPerMin) && input.velocityPctPerMin >= cfg.minVelocityPctPerMin;

  if (ret10Ok && ret30Ok && velocityOk) return { ok: true, reason: "broad runner with confirmed fast 10s/30s velocity" };

  const anyReturnOk = ret10Ok || ret30Ok || ret60Ok;
  const exceptionalVelocityOk = isNum(input.velocityPctPerMin) && input.velocityPctPerMin >= cfg.exceptionalVelocityPctPerMin;
  if (exceptionalVelocityOk && anyReturnOk && volumeOk && structureOk) {
    return { ok: true, reason: "broad runner with exceptional current velocity" };
  }

  return fail(
    "fast_momentum",
    `fast thresholds not met (10s ${input.ret10sPct ?? "n/a"}%, 30s ${input.ret30sPct ?? "n/a"}%, 60s ${input.ret60sPct ?? "n/a"}%, velocity ${input.velocityPctPerMin ?? "n/a"}%/min)`,
  );
}
