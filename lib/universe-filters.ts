/**
 * Declarative universe / contract filter chain (Freqtrade Pairlist-inspired).
 * Each stage removes candidates on one explicit criterion and records attrition.
 * Pure + deterministic — does not place orders or send Discord.
 */
export type FilterDecision = "PASS" | "DROP";

export interface FilterCandidate {
  symbol: string;
  price?: number | null;
  bid?: number | null;
  ask?: number | null;
  spreadPct?: number | null;
  /** Option premium mid (for tick-size gate). */
  premium?: number | null;
  tickSize?: number | null;
  /** Typical daily range as fraction (high-low)/low. */
  dailyRangeFrac?: number | null;
  /** Realized vol (decimal, e.g. 0.25 = 25%). */
  realizedVol?: number | null;
  /** Days listed / days with OI history. */
  ageDays?: number | null;
  openInterest?: number | null;
  dollarVolume?: number | null;
  [key: string]: unknown;
}

export interface FilterStageResult {
  id: string;
  label: string;
  entered: number;
  passed: number;
  dropped: number;
  dropReasons: Record<string, number>;
}

export interface FilterChainResult {
  survivors: FilterCandidate[];
  stages: FilterStageResult[];
  generatedAtMs: number;
}

export interface UniverseFilter {
  id: string;
  label: string;
  /** Return null to PASS, or a short reason string to DROP. */
  evaluate: (c: FilterCandidate, env?: NodeJS.ProcessEnv) => string | null;
}

function numEnv(env: NodeJS.ProcessEnv | undefined, key: string, d: number): number {
  const x = Number(env?.[key]);
  return Number.isFinite(x) ? x : d;
}

/** Drop when bid/ask spread is too wide (options: percent of mid). */
export const spreadFilter: UniverseFilter = {
  id: "SpreadFilter",
  label: "Spread % gate",
  evaluate: (c, env) => {
    const max = numEnv(env, "UNIVERSE_MAX_SPREAD_PCT", 10);
    if (c.spreadPct == null || !Number.isFinite(c.spreadPct)) return null;
    return c.spreadPct > max ? `spread ${c.spreadPct.toFixed(2)}% > ${max}%` : null;
  },
};

/** Drop when one tick is too large a % of premium (structural friction). */
export const priceTickFilter: UniverseFilter = {
  id: "PriceFilter",
  label: "Tick vs premium",
  evaluate: (c, env) => {
    const maxTickPct = numEnv(env, "UNIVERSE_MAX_TICK_PCT_OF_PREMIUM", 2);
    const premium = c.premium ?? null;
    const tick = c.tickSize ?? 0.01;
    if (premium == null || !(premium > 0) || !(tick > 0)) return null;
    const tickPct = (tick / premium) * 100;
    return tickPct > maxTickPct ? `tick ${tickPct.toFixed(2)}% of premium > ${maxTickPct}%` : null;
  },
};

/** Drop names whose typical daily range can't cover a minimum move. */
export const rangeStabilityFilter: UniverseFilter = {
  id: "RangeStabilityFilter",
  label: "Daily range stability",
  evaluate: (c, env) => {
    const min = numEnv(env, "UNIVERSE_MIN_DAILY_RANGE_FRAC", 0.008);
    if (c.dailyRangeFrac == null || !Number.isFinite(c.dailyRangeFrac)) return null;
    return c.dailyRangeFrac < min ? `daily range ${(c.dailyRangeFrac * 100).toFixed(2)}% < ${(min * 100).toFixed(2)}%` : null;
  },
};

/** Drop outside a realized-vol band (decimal). */
export const volatilityFilter: UniverseFilter = {
  id: "VolatilityFilter",
  label: "Realized vol band",
  evaluate: (c, env) => {
    const lo = numEnv(env, "UNIVERSE_RV_MIN", 0.05);
    const hi = numEnv(env, "UNIVERSE_RV_MAX", 0.85);
    if (c.realizedVol == null || !Number.isFinite(c.realizedVol)) return null;
    if (c.realizedVol < lo) return `RV ${c.realizedVol.toFixed(3)} < ${lo}`;
    if (c.realizedVol > hi) return `RV ${c.realizedVol.toFixed(3)} > ${hi}`;
    return null;
  },
};

/** Require minimum listing / OI-history age. */
export const ageFilter: UniverseFilter = {
  id: "AgeFilter",
  label: "Age / OI history",
  evaluate: (c, env) => {
    const minDays = numEnv(env, "UNIVERSE_MIN_AGE_DAYS", 10);
    const minOi = numEnv(env, "UNIVERSE_MIN_OPEN_INTEREST", 100);
    if (c.ageDays != null && Number.isFinite(c.ageDays) && c.ageDays < minDays) {
      return `age ${c.ageDays}d < ${minDays}d`;
    }
    if (c.openInterest != null && Number.isFinite(c.openInterest) && c.openInterest < minOi) {
      return `OI ${c.openInterest} < ${minOi}`;
    }
    return null;
  },
};

/** Absolute price floor/ceiling for underlyings. */
export const absolutePriceFilter: UniverseFilter = {
  id: "AbsolutePriceFilter",
  label: "Underlying price band",
  evaluate: (c, env) => {
    const min = numEnv(env, "UNIVERSE_MIN_PRICE", 5);
    const max = numEnv(env, "UNIVERSE_MAX_PRICE", 5000);
    if (c.price == null || !Number.isFinite(c.price)) return null;
    if (c.price < min) return `price ${c.price} < ${min}`;
    if (c.price > max) return `price ${c.price} > ${max}`;
    return null;
  },
};

export const DEFAULT_UNIVERSE_FILTERS: UniverseFilter[] = [
  absolutePriceFilter,
  spreadFilter,
  priceTickFilter,
  rangeStabilityFilter,
  volatilityFilter,
  ageFilter,
];

/** Run an ordered filter chain and return survivors + per-stage attrition. */
export function runUniverseFilterChain(
  candidates: FilterCandidate[],
  filters: UniverseFilter[] = DEFAULT_UNIVERSE_FILTERS,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): FilterChainResult {
  let current = [...candidates];
  const stages: FilterStageResult[] = [];
  for (const f of filters) {
    const entered = current.length;
    const dropReasons: Record<string, number> = {};
    const next: FilterCandidate[] = [];
    for (const c of current) {
      const reason = f.evaluate(c, env);
      if (reason) {
        dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
      } else {
        next.push(c);
      }
    }
    stages.push({
      id: f.id,
      label: f.label,
      entered,
      passed: next.length,
      dropped: entered - next.length,
      dropReasons,
    });
    current = next;
  }
  return { survivors: current, stages, generatedAtMs: nowMs };
}

/** Compact attrition summary for UI / diagnostics. */
export function summarizeFilterAttrition(result: FilterChainResult): {
  entered: number;
  survived: number;
  stages: Array<{ id: string; entered: number; passed: number; dropped: number; topReason: string | null }>;
} {
  const entered = result.stages[0]?.entered ?? result.survivors.length;
  return {
    entered,
    survived: result.survivors.length,
    stages: result.stages.map((s) => {
      const top = Object.entries(s.dropReasons).sort((a, b) => b[1] - a[1])[0];
      return {
        id: s.id,
        entered: s.entered,
        passed: s.passed,
        dropped: s.dropped,
        topReason: top ? `${top[0]} (×${top[1]})` : null,
      };
    }),
  };
}
