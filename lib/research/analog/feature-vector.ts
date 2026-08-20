/**
 * feature-vector.ts — ANALOG_FEATURE_VECTOR_V1. One definition of what a setup looks like
 * at T0, shared by the side that TRAINS and the side that QUERIES.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * The vector was defined twice: once in `analog/evaluate.ts` (from a `setup_episodes` row)
 * and once in `shadow/analog-bridge.ts` (from live scanner features), each with its own
 * private copy of `encLiquidity` and `hashNum`. They agree today. Nothing makes them agree
 * tomorrow, and the failure is silent in the worst way — a query vector built in a
 * different space than the fitted metric still returns a number, because the metric treats
 * an absent dimension as the training mean (see `nullSemantics` below). Two files that
 * MUST be identical are one file.
 *
 * ── Missing is not zero, and not the mean ────────────────────────────────────
 *
 * The old loader ran every field through `num()`, which returns 0 for anything absent or
 * non-finite. `posInRange` is on [0,1] where 0 means "at the low of the range" — a strong
 * bearish reading. An episode that never recorded a price-structure block was therefore
 * trained as though it had printed at its session low. The z-scorer then does the opposite
 * substitution on the query side (absent → z=0 → exactly the cohort mean), so the SAME
 * absence is imputed as an extreme in training and as a perfect match at query time.
 *
 * Here a missing value is `null` and stays `null`. `available` / `unavailable` are carried
 * on the vector so retrieval can price the absence instead of guessing at it.
 *
 * ── The vector is deliberately NOT bigger ────────────────────────────────────
 *
 * Exactly the seven distance dimensions and three comparability keys the engine already
 * fits. Adding features because they are fashionable would change the metric, invalidate
 * the only baseline this system has, and do it in the same change that fixes the null
 * semantics — leaving nobody able to say which edit moved the result. New dimensions get a
 * new VERSION, and versions are compared against each other, not swapped underneath.
 *
 * ── cmp_ keys are comparability, not distance ────────────────────────────────
 *
 * Keys prefixed `cmp_` are hard filters (must match) rather than distance dimensions, with
 * one exception the engine already encodes: `cmp_symbol` is used ONLY to cap how many
 * analogs one ticker may contribute. Restricting analogs to a single symbol would make
 * cross-symbol evidence impossible, which is the opposite of what an analog engine is for.
 */

export const ANALOG_FEATURE_VECTOR_VERSION = "ANALOG_FEATURE_VECTOR_V1";

export type FeatureRole = "distance" | "comparability" | "dedup";

export interface FeatureFieldSpec {
  readonly key: string;
  readonly role: FeatureRole;
  readonly definition: string;
  readonly units: string;
  /** Which Zone-A source produced it. */
  readonly source: string;
  /** Which clock stamps it, and the fence it must satisfy. */
  readonly clockSemantics: string;
  /** What it means when the value is absent — and what we do about it. */
  readonly nullSemantics: string;
}

/**
 * The registry. Order is fixed and alphabetical-by-key within role so the vector is
 * reproducible across processes (the engine sorts its own dims, but a stable registry
 * makes the report and the tests deterministic too).
 */
export const ANALOG_FEATURE_FIELDS: readonly FeatureFieldSpec[] = Object.freeze([
  {
    key: "accelPct",
    role: "distance",
    definition: "Change in the underlying's short-window velocity — the second derivative of price over the momentum window.",
    units: "percent per window, signed",
    source: "setup_episodes.momentum_json.values.accelPct (live: momentum block)",
    clockSemantics: "momentum block asOfMs; leakage guard requires asOfMs <= t0Ms",
    nullSemantics: "null when no momentum block was recorded. Excluded from the distance; never 0.",
  },
  {
    key: "atrPct",
    role: "distance",
    definition: "Average true range as a percentage of price at T0.",
    units: "percent",
    source: "setup_episodes.volatility_json.values.atrPct",
    clockSemantics: "volatility block asOfMs; <= t0Ms",
    nullSemantics: "null when volatility was not reconstructable. Excluded from the distance; never 0.",
  },
  {
    key: "gapPct",
    role: "distance",
    definition: "Overnight gap from the prior session close to the current session open.",
    units: "percent, signed",
    source: "setup_episodes.price_structure_json.values.gapPct",
    clockSemantics: "price-structure block asOfMs; <= t0Ms",
    nullSemantics: "null before an open is known (and for continuous sessions). Excluded; never 0 — 0 means 'opened unchanged', which is a real and different claim.",
  },
  {
    key: "posInRange",
    role: "distance",
    definition: "Where price sits inside the range observed UP TO T0 (0 = at the low seen so far, 1 = at the high seen so far).",
    units: "ratio 0..1",
    source: "setup_episodes.price_structure_json.values.posInRange",
    clockSemantics: "price-structure block asOfMs; <= t0Ms. Range is the as-of-T0 range, never the whole-session range.",
    nullSemantics: "null when no range was established. Excluded; never 0 — 0 is 'at the session low', the single most misleading substitution in this vector.",
  },
  {
    key: "realizedVol",
    role: "distance",
    definition: "Realized volatility of the underlying over the volatility lookback ending at T0.",
    units: "annualized ratio",
    source: "setup_episodes.volatility_json.values.realizedVol",
    clockSemantics: "volatility block asOfMs; <= t0Ms",
    nullSemantics: "null when the lookback had insufficient bars. Excluded; never 0.",
  },
  {
    key: "rvol",
    role: "distance",
    definition: "Relative volume — volume so far today versus the same-time-of-day baseline.",
    units: "ratio (1.0 = typical)",
    source: "setup_episodes.volume_json.values.rvol",
    clockSemantics: "volume block asOfMs; <= t0Ms. Baseline is a trailing average, never same-day forward volume.",
    nullSemantics: "null without a volume baseline. Excluded; never 0 — 0 would read as 'no volume at all'.",
  },
  {
    key: "velPct",
    role: "distance",
    definition: "Underlying price velocity over the momentum window ending at T0.",
    units: "percent per window, signed",
    source: "setup_episodes.momentum_json.values.velPct",
    clockSemantics: "momentum block asOfMs; <= t0Ms",
    nullSemantics: "null when no momentum block was recorded. Excluded; never 0 — 0 means 'flat', a real reading.",
  },
  {
    key: "cmp_direction",
    role: "comparability",
    definition: "Thesis side. A bullish setup is never an analog for a bearish one.",
    units: "enum encoded: bearish=0, bullish=1",
    source: "setup_episodes.direction (live: scanner thesis side)",
    clockSemantics: "decided at T0 by the scanner; not a market observation",
    nullSemantics: "null direction cannot be compared and the episode is EXCLUDED from retrieval rather than defaulted to bullish.",
  },
  {
    key: "cmp_liquidity",
    role: "comparability",
    definition: "Liquidity tier of the underlying. Cross-tier analogs would compare instruments with incomparable spreads.",
    units: "enum encoded: low=0, medium=1, high=2",
    source: "setup_episodes.liquidity_tier",
    clockSemantics: "assigned from trailing liquidity at T0",
    nullSemantics: "null tier is EXCLUDED from retrieval, not encoded as 'low'. 1,723 of 3,231 production episodes carry a null tier.",
  },
  {
    key: "cmp_symbol",
    role: "dedup",
    definition: "Stable hash of the ticker. NEVER a comparability filter and NEVER a distance dimension — it exists only to cap how many analogs a single ticker may contribute, so one busy name cannot supply a whole cohort.",
    units: "djb2-xor hash mod 100000",
    source: "setup_episodes.symbol",
    clockSemantics: "identity, not an observation",
    nullSemantics: "a row without a symbol cannot be deduped and is EXCLUDED.",
  },
]);

export const DISTANCE_DIMENSIONS: readonly string[] = Object.freeze(
  ANALOG_FEATURE_FIELDS.filter((f) => f.role === "distance").map((f) => f.key).sort(),
);
export const COMPARABILITY_KEYS: readonly string[] = Object.freeze(
  ANALOG_FEATURE_FIELDS.filter((f) => f.role === "comparability").map((f) => f.key).sort(),
);
export const DEDUP_KEY = "cmp_symbol";

/** A built vector. `values` may contain nulls; `unavailable` names them explicitly. */
export interface AnalogFeatureVector {
  readonly version: string;
  readonly values: Readonly<Record<string, number | null>>;
  readonly available: readonly string[];
  readonly unavailable: readonly string[];
  /** True when every comparability key is present — a vector without them cannot be retrieved against. */
  readonly comparable: boolean;
}

/** Raw inputs, from either a stored episode row or the live scanner. Nulls are honest. */
export interface AnalogFeatureInput {
  velPct?: number | null;
  accelPct?: number | null;
  rvol?: number | null;
  realizedVol?: number | null;
  atrPct?: number | null;
  posInRange?: number | null;
  gapPct?: number | null;
  liquidityTier?: string | null;
  direction?: string | null;
  symbol?: string | null;
}

/** Finite numbers pass through; everything else (undefined, null, NaN, Infinity, "") is absent. */
function finiteOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function encodeLiquidityTier(t: string | null | undefined): number | null {
  if (t === "high") return 2;
  if (t === "medium") return 1;
  if (t === "low") return 0;
  return null; // unknown / null tier is NOT "low"
}

export function encodeDirection(d: string | null | undefined): number | null {
  if (d === "bullish") return 1;
  if (d === "bearish") return 0;
  return null; // unknown direction is NOT "bullish"
}

/** Stable, process-independent ticker hash. Identical to the historical implementation so
 *  previously fitted models and stored vectors remain readable. */
export function symbolHash(s: string | null | undefined): number | null {
  if (s === null || s === undefined || s === "") return null;
  const str = String(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  return h % 100000;
}

/**
 * Build the canonical vector. This is the ONLY supported way to produce analog features;
 * both the training loader and the live bridge route through it so the two spaces cannot
 * drift apart.
 */
export function buildAnalogFeatureVector(input: AnalogFeatureInput): AnalogFeatureVector {
  const values: Record<string, number | null> = {
    accelPct: finiteOrNull(input.accelPct),
    atrPct: finiteOrNull(input.atrPct),
    gapPct: finiteOrNull(input.gapPct),
    posInRange: finiteOrNull(input.posInRange),
    realizedVol: finiteOrNull(input.realizedVol),
    rvol: finiteOrNull(input.rvol),
    velPct: finiteOrNull(input.velPct),
    cmp_direction: encodeDirection(input.direction),
    cmp_liquidity: encodeLiquidityTier(input.liquidityTier),
    [DEDUP_KEY]: symbolHash(input.symbol),
  };
  const keys = Object.keys(values).sort();
  const available = keys.filter((k) => values[k] !== null);
  const unavailable = keys.filter((k) => values[k] === null);
  const comparable = COMPARABILITY_KEYS.every((k) => values[k] !== null) && values[DEDUP_KEY] !== null;
  return { version: ANALOG_FEATURE_VECTOR_VERSION, values, available, unavailable, comparable };
}

/**
 * Adapt a `setup_episodes` row (with its Zone-A JSON blocks) to the canonical vector.
 * Parsing failures produce nulls, not zeros.
 */
export function vectorFromEpisodeRow(row: Record<string, any>): AnalogFeatureVector {
  const block = (raw: unknown): Record<string, unknown> => {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const v = (parsed as any)?.values;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const ps = block(row.price_structure_json);
  const mo = block(row.momentum_json);
  const vo = block(row.volume_json);
  const vl = block(row.volatility_json);
  return buildAnalogFeatureVector({
    velPct: mo.velPct as number, accelPct: mo.accelPct as number,
    rvol: vo.rvol as number,
    realizedVol: vl.realizedVol as number, atrPct: vl.atrPct as number,
    posInRange: ps.posInRange as number, gapPct: ps.gapPct as number,
    liquidityTier: row.liquidity_tier ?? null,
    direction: row.direction ?? null,
    symbol: row.symbol ?? null,
  });
}

/** Field metadata for the research surface — definition, units, source, clock, nulls. */
export function describeAnalogFeatureVector(): {
  version: string;
  distanceDimensions: readonly string[];
  comparabilityKeys: readonly string[];
  dedupKey: string;
  fields: readonly FeatureFieldSpec[];
} {
  return {
    version: ANALOG_FEATURE_VECTOR_VERSION,
    distanceDimensions: DISTANCE_DIMENSIONS,
    comparabilityKeys: COMPARABILITY_KEYS,
    dedupKey: DEDUP_KEY,
    fields: ANALOG_FEATURE_FIELDS,
  };
}
