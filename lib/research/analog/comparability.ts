/**
 * comparability.ts — ANALOG_COMPARABILITY_V1. Which keys make two setups comparable,
 * resolved from the FEATURE-VECTOR VERSION rather than from a global constant.
 *
 * ── Why this had to stop being a constant ────────────────────────────────────
 *
 * `retrieval.ts` imported `COMPARABILITY_KEYS` from the V1 registry and applied it to
 * every corpus it was handed. That is correct while exactly one vector exists. It stopped
 * being correct the moment a second population arrived whose evidence answers a DIFFERENT
 * question with the SAME field names, and the failure it produced was total and silent:
 * all 6,935 SetupEpisodeV2 rows were rejected as NOT_COMPARABLE_VECTOR because
 * `cmp_liquidity` is null on every one of them — see `feature-vector-v2.ts` for why that
 * null is structural rather than a data gap.
 *
 * ── Required vs optional, and why optional is not "ignore" ───────────────────
 *
 *   required  present on BOTH sides AND equal, or the pair is not comparable at all.
 *   optional  equal WHEN BOTH SIDES HAVE IT. When either side lacks it the key is
 *             DROPPED and counted in `droppedKeys` — it is never scored as agreement.
 *
 * The distinction is the whole safety property. A missing key that silently "matches"
 * turns the least-evidenced pairs into the most comparable ones, which is the same
 * failure `mdistPartial` exists to prevent one layer down. So `comparabilityOf` reports
 * `coverage` (shared keys / applicable keys) and the caller decides; it never decides by
 * pretending.
 *
 * ── Versions do not mix ──────────────────────────────────────────────────────
 *
 * V1 and V2 use the same seven dimension NAMES and the same UNITS over different windows
 * and, for `atrPct` and `posInRange`, different formulas entirely. Nothing about that is
 * a defect — they were computed by different systems for different purposes — but it does
 * mean a V1 `atrPct` and a V2 `atrPct` are not the same measurement. Retrieval therefore
 * refuses across versions instead of z-scoring two definitions into one space, which
 * would produce a number and no error.
 */

export interface ComparabilitySpec {
  /** The feature-vector version this spec governs. */
  readonly version: string;
  /** Must be present on both sides and equal. */
  readonly required: readonly string[];
  /** Must be equal when both sides have it; dropped and counted when either lacks it. */
  readonly optional: readonly string[];
  /** Not a filter — caps how many analogs one ticker may contribute. */
  readonly dedupKey: string;
  /** Distance dimensions, in fixed order. */
  readonly distanceDimensions: readonly string[];
}

const REGISTRY = new Map<string, ComparabilitySpec>();

export function registerComparabilitySpec(spec: ComparabilitySpec): ComparabilitySpec {
  const frozen = Object.freeze({
    ...spec,
    required: Object.freeze([...spec.required].sort()),
    optional: Object.freeze([...spec.optional].sort()),
    distanceDimensions: Object.freeze([...spec.distanceDimensions].sort()),
  });
  REGISTRY.set(spec.version, frozen);
  return frozen;
}

/**
 * The spec for a version. THROWS on an unknown version rather than falling back to V1 —
 * a silent fallback is how a third vector would inherit V1's liquidity requirement and
 * be rejected wholesale all over again, this time with nothing in the output to say so.
 */
export function comparabilitySpecFor(version: string): ComparabilitySpec {
  const spec = REGISTRY.get(version);
  if (!spec) {
    throw new Error(
      `no comparability spec registered for feature-vector version ${String(version)}; ` +
        `known versions: ${[...REGISTRY.keys()].sort().join(", ") || "(none)"}`,
    );
  }
  return spec;
}

export function knownVectorVersions(): string[] {
  return [...REGISTRY.keys()].sort();
}

export type ComparabilityVerdict =
  | "COMPARABLE"
  | "REQUIRED_KEY_ABSENT"
  | "REQUIRED_KEY_MISMATCH"
  | "OPTIONAL_KEY_MISMATCH";

export interface ComparabilityResult {
  verdict: ComparabilityVerdict;
  comparable: boolean;
  /** Keys compared on both sides and equal. */
  sharedKeys: string[];
  /** Optional keys skipped because one side lacked the value. NEVER counted as agreement. */
  droppedKeys: string[];
  /** sharedKeys / (required + applicable optional). 1 only when nothing was dropped. */
  coverage: number;
  /** The first key that failed, for reporting. */
  failedKey: string | null;
}

type Values = Readonly<Record<string, number | null>>;

/**
 * Compare two vectors' comparability keys under one spec.
 * Both vectors must already be on the same version; `retrieveAnalogs` enforces that.
 */
export function comparabilityOf(spec: ComparabilitySpec, a: Values, b: Values): ComparabilityResult {
  const shared: string[] = [];
  const dropped: string[] = [];
  const total = spec.required.length + spec.optional.length;
  const fail = (verdict: ComparabilityVerdict, key: string): ComparabilityResult => ({
    verdict, comparable: false, sharedKeys: shared, droppedKeys: dropped,
    coverage: total === 0 ? 1 : +(shared.length / total).toFixed(4), failedKey: key,
  });

  for (const k of spec.required) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    if (av === null || bv === null) return fail("REQUIRED_KEY_ABSENT", k);
    if (av !== bv) return fail("REQUIRED_KEY_MISMATCH", k);
    shared.push(k);
  }
  for (const k of spec.optional) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    // Absent on either side: unknown, not agreement. Dropped and reported.
    if (av === null || bv === null) { dropped.push(k); continue; }
    if (av !== bv) return fail("OPTIONAL_KEY_MISMATCH", k);
    shared.push(k);
  }
  return {
    verdict: "COMPARABLE", comparable: true, sharedKeys: shared, droppedKeys: dropped,
    coverage: total === 0 ? 1 : +(shared.length / total).toFixed(4), failedKey: null,
  };
}

/** Whether a single vector carries enough to be retrieved against at all. */
export function vectorSelfComparable(spec: ComparabilitySpec, values: Values): boolean {
  return spec.required.every((k) => (values[k] ?? null) !== null) && (values[spec.dedupKey] ?? null) !== null;
}
