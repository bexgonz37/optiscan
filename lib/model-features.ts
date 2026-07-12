/**
 * model-features.ts — deterministic, leak-free feature extraction (Phase 4).
 *
 * PURE. Builds a numeric feature vector from a STRICT whitelist of information
 * known AT OR BEFORE the prediction timestamp (fingerprint dimensions + the
 * persisted entry-time market context + a few entry-time numerics). Exit values,
 * MFE/MAE, realized P&L, future bars, and later lifecycle states have NO channel
 * into this module — the input type does not expose them.
 *
 * Encoding: categoricals are one-hot over FIXED vocabularies (a value outside the
 * vocabulary or a missing value sets an explicit `__missing` indicator and all
 * category columns to 0). Numerics carry a paired missing-indicator. Deterministic
 * ordering (sorted feature names) so the vector is stable across processes.
 */
export const FEATURE_SCHEMA_VERSION = 1;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Whitelisted, entry-time-only inputs. No exit / realized / future fields exist here. */
export interface FeatureInput {
  // fingerprint dimensions (already bucketed, entry-time)
  strategy?: string | null;
  direction?: string | null;
  session?: string | null;
  todBucket?: string | null;
  dteBucket?: string | null;
  deltaBand?: string | null;
  spreadBand?: string | null;
  relVolBucket?: string | null;
  vwapState?: string | null;
  moveClassification?: string | null;
  instrument?: string | null;
  // entry-time market context (Phase 3)
  ctxRiskState?: string | null;
  ctxStructure?: string | null;
  ctxVolatility?: string | null;
  // entry-time numerics (optional, standardized downstream)
  dteAtEntry?: number | null;
  entryDelta?: number | null;
  entrySpreadPct?: number | null;
  relVol?: number | null;
  entryIv?: number | null;
  selectionScore?: number | null;
}

/** Fixed categorical vocabularies. Extending these ⇒ bump FEATURE_SCHEMA_VERSION. */
export const VOCAB: Record<string, string[]> = {
  strategy: ["ZERO_DTE_MOMENTUM", "SWING_POSITION", "MOMENTUM_STOCK", "NEAR_MONEY_CONTEXT"],
  direction: ["CALL", "PUT", "LONG"],
  session: ["PREMARKET", "REGULAR", "AFTERHOURS"],
  todBucket: ["PREMARKET", "OPEN", "MIDDAY", "POWER_HOUR", "AFTERHOURS"],
  dteBucket: ["0DTE", "1-5", "6-10", "11-35", "36-90", ">90"],
  deltaBand: ["<0.30", "0.30-0.45", "0.45-0.55", "0.55-0.70", ">=0.70"],
  spreadBand: ["TIGHT", "MODERATE", "WIDE"],
  relVolBucket: ["<1", "1-2", "2-4", "4+"],
  vwapState: ["ABOVE", "BELOW"],
  moveClassification: ["BREAKOUT", "CONTINUATION", "REVERSAL", "PULLBACK", "EXHAUSTED"],
  instrument: ["OPTION", "STOCK"],
  ctxRiskState: ["RISK_ON", "RISK_OFF", "MIXED"],
  ctxStructure: ["TRENDING", "CHOPPY"],
  ctxVolatility: ["LOW", "ELEVATED", "HIGH"],
};

const NUMERIC_FIELDS: Array<keyof FeatureInput> = [
  "dteAtEntry", "entryDelta", "entrySpreadPct", "relVol", "entryIv", "selectionScore",
];

const CATEGORICAL_FIELDS = Object.keys(VOCAB);

function norm(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  return s.length ? s : null;
}

export interface FeatureVector {
  names: string[];
  values: number[];
  /** Whitelisted field → whether it was missing/out-of-vocabulary. */
  missing: Record<string, boolean>;
  schemaVersion: number;
}

/** Stable, sorted feature-name schema (deterministic across processes). */
export function featureNames(): string[] {
  const names: string[] = [];
  for (const field of CATEGORICAL_FIELDS) {
    for (const cat of VOCAB[field]) names.push(`${field}=${cat}`);
    names.push(`${field}__missing`);
  }
  for (const f of NUMERIC_FIELDS) {
    names.push(`num:${f}`);
    names.push(`num:${f}__missing`);
  }
  return names.sort();
}

/** Extract a deterministic feature vector. Out-of-vocab / missing ⇒ explicit indicator. */
export function extractFeatures(input: FeatureInput): FeatureVector {
  const map = new Map<string, number>();
  const missing: Record<string, boolean> = {};

  for (const field of CATEGORICAL_FIELDS) {
    const raw = norm((input as any)[field]);
    const vocab = VOCAB[field];
    const known = raw != null && vocab.includes(raw);
    for (const cat of vocab) map.set(`${field}=${cat}`, known && raw === cat ? 1 : 0);
    map.set(`${field}__missing`, known ? 0 : 1);
    missing[field] = !known;
  }
  for (const f of NUMERIC_FIELDS) {
    const v = (input as any)[f];
    const ok = isNum(v);
    map.set(`num:${f}`, ok ? (v as number) : 0);
    map.set(`num:${f}__missing`, ok ? 0 : 1);
    missing[f] = !ok;
  }

  const names = featureNames();
  const values = names.map((n) => map.get(n) ?? 0);
  return { names, values, missing, schemaVersion: FEATURE_SCHEMA_VERSION };
}

/** Fraction of whitelisted fields that were present (data-quality coverage). */
export function featureCoverage(fv: FeatureVector): number {
  const keys = Object.keys(fv.missing);
  if (!keys.length) return 0;
  const present = keys.filter((k) => !fv.missing[k]).length;
  return present / keys.length;
}
