/**
 * feature-vector-v2.ts — ANALOG_FEATURE_VECTOR_V2. The vector for SetupEpisodeV2 rows.
 *
 * ── The bug this file is the answer to ───────────────────────────────────────
 *
 * Every one of the ~6,935 V2 episodes in production loaded as NOT_COMPARABLE_VECTOR, so
 * the entire forward corpus was invisible to retrieval. The cause is not a data-quality
 * problem and it is not fixable by filling anything in:
 *
 *   `persistSetupEpisodeV2OnDb` (episode/v2.ts) writes an EXPLICIT column list that does
 *   not contain `liquidity_tier`. It cannot: `SetupEpisodeV2` has no liquidity-tier field.
 *   V2 rows carry their features in `zone_a_json`, and the tier concept was never part of
 *   that shape. The null is structural — the column is not empty, it is inapplicable.
 *
 * ── Why the V1 tier cannot be reconstructed, stated precisely ────────────────
 *
 * The ONLY definition of `liquidity_tier` anywhere in this codebase is
 * `episode/seed.ts::liquidityTier(dollarVol)`, and its input is
 *
 *     dollarVol = bars[i].c * bars[i].v          ← ONE 1-MINUTE BAR of the underlying
 *     high >= $5,000,000 | medium >= $500,000 | low otherwise
 *
 * V2's nearest frozen quantity is `zoneA.underlying.dayDollarVolume` — SESSION-TO-DATE
 * dollar volume. Same units, different denominator by two to three orders of magnitude.
 * Worse, it is degenerate here by construction: every V2 candidate already cleared the
 * Tier-2 gate `dayDollarVolume >= OPT_T2_MIN_DOLLAR_VOL` (default $20,000,000, four times
 * V1's "high" boundary), so running V1's thresholds over it labels 100% of the corpus
 * "high". That is a constant column wearing the name of a comparability key: it would
 * clear the rejection, restore 6,935 rows, filter nothing, and look exactly like a fix.
 *
 * So `cmp_liquidity` is NOT emitted for V2. Not defaulted, not bucketed, not carried over.
 *
 * ── What replaces it, and why it is honest ───────────────────────────────────
 *
 * `cmp_liquidity` existed to stop analogs being drawn across "incomparable spreads". V2
 * answers that question with better evidence than V1 ever had: the option leg's own
 * frozen T0 executability, `zoneA.option.executableAtT0` — computed live as
 * `bid > 0 && ask > bid && quoteAge <= 60s` and immutable once written. It is a real
 * point-in-time observation, it needs no threshold invented for this file, and it splits
 * the population where the spread question actually bites.
 *
 * It is OPTIONAL rather than required, because a REJECTED episode may never have selected
 * a contract at all (`zoneA.option === null`). When either side lacks it the key is
 * DROPPED and counted — never treated as a match. See `comparability.ts`.
 *
 * ── The seven dimensions have the same names and are not the same numbers ────
 *
 * V2 sources its distance dimensions from the frozen `sharedFeatureSnapshot`
 * (`computeOptionsFeatures`), V1 from `seedEpisodesPure`. They agree on name and units and
 * disagree on window and, for two of them, on formula:
 *
 *   velPct       V1: 15-bar change          V2: 5-bar change
 *   accelPct     V1: vel(i) - vel(i-1)      V2: vel - prevVel (5-bar)
 *   rvol         V1: bar vol / mean(60)     V2: cumulative vol / time-of-day average
 *   realizedVol  V1: std of 20-bar returns  V2: std of session-to-date bar returns
 *   atrPct       V1: (rangeHigh-rangeLow)/close over 60 bars  V2: true 14-bar ATR / price
 *   posInRange   V1: over the 60-bar range  V2: over the session-to-date hod/lod
 *   gapPct       both: (open - prevClose) / prevClose
 *
 * None of that is a defect — two systems measured what each needed. It does mean a V1
 * `atrPct` and a V2 `atrPct` are different measurements, and z-scoring them into one space
 * would return a number with no error and no meaning. Retrieval therefore refuses to mix
 * versions outright rather than blending them; `comparability.ts` carries that rule.
 *
 * ── posInRange is derived, and derivation is not fabrication ─────────────────
 *
 * `computeOptionsFeatures` records `hod`, `lod` and `price` but not `posInRange`. The
 * quotient (price - lod) / (hod - lod) is V1's own definition applied to V2's own frozen
 * inputs — all three are session-to-date values fenced at T0 by `validateZoneA`. When the
 * range is degenerate (hod == lod) the result is null, NOT 0.5: 0.5 is "mid-range", a
 * real reading, and the one substitution most likely to look reasonable and be wrong.
 */
import { registerComparabilitySpec } from "./comparability.ts";
import {
  DISTANCE_DIMENSIONS,
  DEDUP_KEY,
  encodeDirection,
  symbolHash,
  type AnalogFeatureVector,
  type FeatureFieldSpec,
} from "./feature-vector.ts";

export const ANALOG_FEATURE_VECTOR_V2_VERSION = "ANALOG_FEATURE_VECTOR_V2";

/** The V2-native comparability key. Presence of executable option evidence at T0. */
export const V2_EXECUTABLE_KEY = "cmp_executable";

export const ANALOG_FEATURE_FIELDS_V2: readonly FeatureFieldSpec[] = Object.freeze([
  {
    key: "accelPct",
    role: "distance",
    definition: "Change in the underlying's 5-bar velocity between the last two bars.",
    units: "percent per window, signed",
    source: "zone_a_json.optiscan.sharedFeatureSnapshot.underlying.accelPct (computeOptionsFeatures)",
    clockSemantics: "sharedFeatureSnapshot asOfMs = t0Ms; validateZoneA rejects any Zone-A asOf > t0",
    nullSemantics: "null when the snapshot was 'snapshot_only' (no bars were fetched). Excluded from the distance; never 0.",
  },
  {
    key: "atrPct",
    role: "distance",
    definition: "True 14-bar ATR as a percentage of price. NOT V1's 60-bar range/close — same name, different estimator.",
    units: "percent",
    source: "zone_a_json.optiscan.sharedFeatureSnapshot.underlying.atrPct",
    clockSemantics: "sharedFeatureSnapshot asOfMs = t0Ms",
    nullSemantics: "null when price is non-positive or no bars were enriched. Excluded; never 0.",
  },
  {
    key: "gapPct",
    role: "distance",
    definition: "First stored bar's open versus the prior close.",
    units: "percent, signed",
    source: "zone_a_json.optiscan.sharedFeatureSnapshot.underlying.gapPct, else zone_a_json.underlying.gapPct",
    clockSemantics: "sharedFeatureSnapshot asOfMs = t0Ms",
    nullSemantics: "null when prevClose was unavailable (the snapshot records it in its own `missing` list). Excluded; never 0.",
  },
  {
    key: "posInRange",
    role: "distance",
    definition: "(price - lod) / (hod - lod) over the session-to-date extremes observed at T0. V1's definition over V2's frozen inputs.",
    units: "ratio 0..1",
    source: "derived from sharedFeatureSnapshot.underlying.{price,hod,lod}",
    clockSemantics: "all three are session-to-date at t0Ms; the range never includes a later bar",
    nullSemantics: "null when hod == lod or any input is absent. NOT 0.5 — mid-range is a real reading.",
  },
  {
    key: "realizedVol",
    role: "distance",
    definition: "Standard deviation of session-to-date bar-to-bar returns. Same formula as V1 over a different window.",
    units: "ratio, per bar",
    source: "zone_a_json.optiscan.sharedFeatureSnapshot.underlying.realizedVol",
    clockSemantics: "sharedFeatureSnapshot asOfMs = t0Ms",
    nullSemantics: "null when no bars were enriched. Excluded; never 0.",
  },
  {
    key: "rvol",
    role: "distance",
    definition: "Cumulative session volume versus the time-of-day average. V1 used a single bar over a 60-bar mean.",
    units: "ratio (1.0 = typical)",
    source: "sharedFeatureSnapshot.underlying.relVolume, else zone_a_json.underlying.relVolume",
    clockSemantics: "sharedFeatureSnapshot asOfMs = t0Ms; the baseline is a trailing average, never same-day forward volume",
    nullSemantics: "null without a time-of-day baseline (the snapshot records 'timeOfDayAvgVolume' as missing). Excluded; never 0.",
  },
  {
    key: "velPct",
    role: "distance",
    definition: "5-bar price change ending at T0. V1's window is 15 bars.",
    units: "percent, signed",
    source: "sharedFeatureSnapshot.underlying.velPct, else zone_a_json.underlying.velPct",
    clockSemantics: "sharedFeatureSnapshot asOfMs = t0Ms",
    nullSemantics: "null when unavailable. Excluded; never 0 — 0 means 'flat', a real reading.",
  },
  {
    key: "cmp_direction",
    role: "comparability",
    definition: "Thesis side. REQUIRED — a bullish setup is never an analog for a bearish one.",
    units: "enum encoded: bearish=0, bullish=1",
    source: "setup_episodes.direction (written by persistSetupEpisodeV2OnDb)",
    clockSemantics: "fixed at T0 by strategy selection; not a market observation",
    nullSemantics: "a null direction cannot be compared; the episode is EXCLUDED, never defaulted to bullish.",
  },
  {
    key: V2_EXECUTABLE_KEY,
    role: "comparability",
    definition:
      "Whether the selected contract was executable at T0 (bid > 0, ask > bid, quote age <= 60s). OPTIONAL: it replaces V1's " +
      "cmp_liquidity, which cannot be reconstructed from V2 evidence and would be a constant column if forced.",
    units: "enum encoded: not-executable=0, executable=1",
    source: "zone_a_json.option.executableAtT0",
    clockSemantics: "frozen at T0 by the live evaluator and immutable by trigger thereafter",
    nullSemantics:
      "null when no contract was selected (a REJECTED episode has zone_a_json.option === null). The key is DROPPED for that " +
      "pair and counted in droppedKeys — it is NEVER scored as a match.",
  },
  {
    key: DEDUP_KEY,
    role: "dedup",
    definition: "Stable ticker hash. Caps how many analogs one ticker may contribute; never a filter and never a distance dimension.",
    units: "djb2-xor hash mod 100000",
    source: "setup_episodes.symbol",
    clockSemantics: "identity, not an observation",
    nullSemantics: "a row without a symbol cannot be deduped and is EXCLUDED.",
  },
]);

export const ANALOG_COMPARABILITY_SPEC_V2 = registerComparabilitySpec({
  version: ANALOG_FEATURE_VECTOR_V2_VERSION,
  required: ["cmp_direction"],
  optional: [V2_EXECUTABLE_KEY],
  dedupKey: DEDUP_KEY,
  // Identical dimension NAMES to V1 by design; the version is what keeps the two spaces apart.
  distanceDimensions: DISTANCE_DIMENSIONS,
});

export interface AnalogFeatureInputV2 {
  velPct?: number | null;
  accelPct?: number | null;
  rvol?: number | null;
  realizedVol?: number | null;
  atrPct?: number | null;
  posInRange?: number | null;
  gapPct?: number | null;
  direction?: string | null;
  /** Frozen `zoneA.option.executableAtT0`. Null when no contract was selected. */
  executableAtT0?: boolean | null;
  symbol?: string | null;
}

function finiteOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** true → 1, false → 0, anything else → null. An absent contract is NOT "not executable". */
export function encodeExecutable(v: unknown): number | null {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

export function buildAnalogFeatureVectorV2(input: AnalogFeatureInputV2): AnalogFeatureVector {
  const values: Record<string, number | null> = {
    accelPct: finiteOrNull(input.accelPct),
    atrPct: finiteOrNull(input.atrPct),
    gapPct: finiteOrNull(input.gapPct),
    posInRange: finiteOrNull(input.posInRange),
    realizedVol: finiteOrNull(input.realizedVol),
    rvol: finiteOrNull(input.rvol),
    velPct: finiteOrNull(input.velPct),
    cmp_direction: encodeDirection(input.direction),
    [V2_EXECUTABLE_KEY]: encodeExecutable(input.executableAtT0),
    [DEDUP_KEY]: symbolHash(input.symbol),
  };
  const keys = Object.keys(values).sort();
  const available = keys.filter((k) => values[k] !== null);
  const unavailable = keys.filter((k) => values[k] === null);
  // REQUIRED keys only. `cmp_executable` is optional by spec, so its absence does not make
  // the vector unusable — it makes one comparison narrower, and that is reported per pair.
  const comparable =
    ANALOG_COMPARABILITY_SPEC_V2.required.every((k) => values[k] !== null) && values[DEDUP_KEY] !== null;
  return { version: ANALOG_FEATURE_VECTOR_V2_VERSION, values, available, unavailable, comparable };
}

/** Read a nested value out of a parsed `zone_a_json` EvidenceValue wrapper or a bare object. */
function evValue(node: unknown): unknown {
  if (node && typeof node === "object" && "value" in (node as Record<string, unknown>)) {
    return (node as Record<string, unknown>).value;
  }
  return node;
}

export interface ZoneAExtract {
  values: AnalogFeatureInputV2;
  /** Which source answered each dimension, for the research surface. */
  sources: Record<string, string>;
}

/**
 * Pull the V2 feature inputs out of a parsed `zone_a_json`.
 *
 * Preference order per dimension is EXPLICIT and recorded: the enriched
 * `sharedFeatureSnapshot` first (it is the block `computeOptionsFeatures` produced), then
 * the candidate's own `underlying` block. Both are Zone-A and both are fenced at T0; the
 * snapshot is preferred only because it carries all seven dimensions rather than four.
 */
export function extractV2FeatureInputs(zoneA: unknown): ZoneAExtract {
  const sources: Record<string, string> = {};
  const empty: ZoneAExtract = { values: {}, sources };
  if (!zoneA || typeof zoneA !== "object") return empty;
  const z = zoneA as Record<string, unknown>;

  const underlying = (evValue(z.underlying) ?? {}) as Record<string, unknown>;
  const optiscan = (evValue(z.optiscan) ?? {}) as Record<string, unknown>;
  const option = evValue(z.option) as Record<string, unknown> | null;

  const snapshot = (evValue(optiscan.sharedFeatureSnapshot) ?? null) as Record<string, unknown> | null;
  const snapUnderlying = (snapshot && typeof snapshot === "object"
    ? (snapshot.underlying ?? null)
    : null) as Record<string, unknown> | null;

  const num = (v: unknown): number | null => {
    const raw = evValue(v);
    if (raw === null || raw === undefined || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const pick = (key: string, snapKey: string, underlyingKey: string | null): number | null => {
    const fromSnap = snapUnderlying ? num(snapUnderlying[snapKey]) : null;
    if (fromSnap !== null) { sources[key] = `sharedFeatureSnapshot.underlying.${snapKey}`; return fromSnap; }
    if (underlyingKey) {
      const fromU = num(underlying[underlyingKey]);
      if (fromU !== null) { sources[key] = `zoneA.underlying.${underlyingKey}`; return fromU; }
    }
    sources[key] = "ABSENT";
    return null;
  };

  // posInRange is not stored; it is V1's ratio over V2's own frozen hod/lod/price.
  let posInRange: number | null = null;
  if (snapUnderlying) {
    const price = num(snapUnderlying.price);
    const hod = num(snapUnderlying.hod);
    const lod = num(snapUnderlying.lod);
    if (price !== null && hod !== null && lod !== null && hod > lod) {
      posInRange = +((price - lod) / (hod - lod)).toFixed(4);
      sources.posInRange = "derived: (price - lod) / (hod - lod) from sharedFeatureSnapshot";
    } else {
      sources.posInRange = "ABSENT: degenerate or incomplete session range (never defaulted to 0.5)";
    }
  } else {
    sources.posInRange = "ABSENT";
  }

  const executableRaw = option ? evValue(option.executableAtT0) : null;
  sources[V2_EXECUTABLE_KEY] = option
    ? "zoneA.option.executableAtT0"
    : "ABSENT: no contract was selected at T0";

  return {
    values: {
      velPct: pick("velPct", "velPct", "velPct"),
      accelPct: pick("accelPct", "accelPct", "accelPct"),
      rvol: pick("rvol", "relVolume", "relVolume"),
      realizedVol: pick("realizedVol", "realizedVol", null),
      atrPct: pick("atrPct", "atrPct", null),
      posInRange,
      gapPct: pick("gapPct", "gapPct", "gapPct"),
      executableAtT0: executableRaw === true ? true : executableRaw === false ? false : null,
    },
    sources,
  };
}

/**
 * Build the V2 vector for a `setup_episodes` row with `episode_version = 2`.
 *
 * `liquidity_tier` on the row is DELIBERATELY not read. It is null for every V2 row by
 * construction, and reading it could only ever reintroduce the rejection this file exists
 * to remove.
 */
export function vectorFromV2EpisodeRow(row: Record<string, any>): AnalogFeatureVector {
  let zone: unknown = null;
  try {
    zone = typeof row.zone_a_json === "string" ? JSON.parse(row.zone_a_json) : row.zone_a_json;
  } catch {
    zone = null;
  }
  const extract = extractV2FeatureInputs(zone);
  return buildAnalogFeatureVectorV2({
    ...extract.values,
    direction: row.direction ?? null,
    symbol: row.symbol ?? null,
  });
}

export function describeAnalogFeatureVectorV2(): {
  version: string;
  distanceDimensions: readonly string[];
  requiredComparabilityKeys: readonly string[];
  optionalComparabilityKeys: readonly string[];
  dedupKey: string;
  fields: readonly FeatureFieldSpec[];
  liquidityTierNote: string;
} {
  return {
    version: ANALOG_FEATURE_VECTOR_V2_VERSION,
    distanceDimensions: ANALOG_COMPARABILITY_SPEC_V2.distanceDimensions,
    requiredComparabilityKeys: ANALOG_COMPARABILITY_SPEC_V2.required,
    optionalComparabilityKeys: ANALOG_COMPARABILITY_SPEC_V2.optional,
    dedupKey: ANALOG_COMPARABILITY_SPEC_V2.dedupKey,
    fields: ANALOG_FEATURE_FIELDS_V2,
    liquidityTierNote:
      "cmp_liquidity is absent from V2 on purpose. Its only definition (episode/seed.ts) is a tier over ONE 1-minute bar's " +
      "underlying dollar volume with a $5,000,000 'high' boundary. V2's nearest frozen quantity is session-to-date " +
      "dayDollarVolume, already gated at OPT_T2_MIN_DOLLAR_VOL (default $20,000,000), so V1's thresholds would classify " +
      "100% of V2 as 'high' — a constant column that clears the rejection and filters nothing.",
  };
}
