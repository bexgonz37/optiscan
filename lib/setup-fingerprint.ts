/**
 * setup-fingerprint.ts — the ONE deterministic, versioned setup fingerprint.
 *
 * PURE: no I/O, no DB, no clock in the OUTPUT (the caller passes entry-time
 * fields, including entryAtMs, explicitly). Given only information known AT OR
 * BEFORE the entry fill, it produces a stable machine ID plus the sorted,
 * human-readable canonical dimensions used to create it.
 *
 * Guarantees:
 *  - Deterministic and independent of object-property order (fixed key set,
 *    sorted before hashing).
 *  - Stable across restarts and processes (pure function of inputs + version;
 *    no wall-clock, no RNG, no raw unstable floats in the hash — only bucket
 *    labels are hashed).
 *  - Versioned: the fingerprint schema version is baked into both the canonical
 *    payload AND the identifier, so different versions can never be conflated.
 *  - Look-ahead safe by construction: the input type only exposes entry-time
 *    fields. Exit price / reason / realized P&L / MFE / MAE / later candles /
 *    final daily volume / future timestamps have NO channel into this module.
 *  - Robust to malformed values: NaN / Infinity / empty / wrong-case inputs are
 *    normalized to an explicit `NA`, never a fabricated bucket.
 *
 * A dimension-set or bucket-boundary change REQUIRES bumping FINGERPRINT_VERSION.
 * A strategy-meaning change REQUIRES bumping that strategy's STRATEGY_VERSIONS
 * entry (the resolved value is carried as a dimension, so it is part of identity).
 */
import { createHash } from "node:crypto";

/** Bump when the dimension set or ANY bucket boundary below changes. */
export const FINGERPRINT_VERSION = 1;

/**
 * Per-strategy meaning version. Bump an entry when the strategy's logic changes
 * meaning even though the dimension set is unchanged — old outcomes keep their
 * old value, so identity stays honest.
 */
export const STRATEGY_VERSIONS: Record<string, number> = {
  zero_dte_momentum: 1,
  swing_position: 1,
  near_money_context: 1,
  momentum_stock: 1,
  // Phase 5 horizon profiles (additive — new keys never change existing fingerprints).
  short_dated_call: 1,
  weekly_call: 1,
  multiweek_call: 1,
  leaps_research_call: 1,
};

export function strategyVersionFor(strategy: string | null | undefined): number {
  if (!strategy) return 0;
  // Case-insensitive: casing must never change identity. Registry keys are the
  // canonical lowercase profile names.
  return STRATEGY_VERSIONS[String(strategy).trim().toLowerCase()] ?? 0;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Entry-time inputs ONLY. There is deliberately no field for exit/realized data. */
export interface FingerprintInput {
  strategy?: string | null;          // selector_profile / strategy label
  instrument?: "option" | "stock" | null;
  optionType?: "call" | "put" | null;
  triggerFamily?: string | null;     // alerts.capture_action (TRADE | WATCH | ...)
  session?: string | null;           // session at entry
  entryAtMs?: number | null;         // fill timestamp (for the time-of-day bucket)
  dte?: number | null;
  delta?: number | null;
  spreadPct?: number | null;
  relVol?: number | null;
  aboveVwap?: boolean | null;
  lifecycleState?: string | null;    // opportunity lifecycle status, if tracked
  selectorProfile?: string | null;
  /** NA-safe / inconsistently populated — carried but never forced. */
  momentum?: number | null;          // short-rate / velocity (coarse sign bucket)
  moveClassification?: string | null;
}

export interface Fingerprint {
  /** Stable machine ID: `sf{version}_{16-hex}`. */
  id: string;
  version: number;
  strategyVersion: number;
  /** Fixed key set, canonical values (null rendered as "NA" in canonical/human). */
  dimensions: Record<string, string | null>;
  /** The exact sorted `key=value` string that was hashed (machine + human readable). */
  canonical: string;
  /** Compact human-readable one-liner. */
  humanSummary: string;
  /** Structured notes about malformed/invalid inputs that were normalized to NA. */
  dataQualityReasons: string[];
}

/** The fixed, ordered dimension key set. Adding/removing a key ⇒ bump version. */
export const DIMENSION_KEYS = [
  "strategy",
  "strategyVersion",
  "instrument",
  "direction",
  "triggerFamily",
  "session",
  "todBucket",
  "dteBucket",
  "deltaBand",
  "spreadBand",
  "relVolBucket",
  "vwapState",
  "lifecycleState",
  "selectorProfile",
  "momentumBucket",
  "moveClassification",
] as const;

// ── Normalizers / bucketers ─────────────────────────────────────────────────

function normEnum(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  return s.length ? s : null;
}

/** Number that is explicitly finite, else null (rejects NaN/Infinity). */
function finiteOrNull(v: unknown, reasons: string[], label: string): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    reasons.push(`${label}_invalid`);
    return null;
  }
  return v;
}

function directionOf(input: FingerprintInput): string | null {
  if (input.instrument === "stock") return "LONG"; // long-only path
  if (input.optionType === "call") return "CALL";
  if (input.optionType === "put") return "PUT";
  return null;
}

function etHourMinute(ms: number): { hour: number; minute: number } | null {
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ms));
    const hh = Number(parts.find((p) => p.type === "hour")?.value);
    const mm = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return { hour: hh === 24 ? 0 : hh, minute: mm };
  } catch {
    return null;
  }
}

function todBucket(entryAtMs: number | null): string | null {
  if (entryAtMs == null) return null;
  const hm = etHourMinute(entryAtMs);
  if (!hm) return null;
  const m = hm.hour * 60 + hm.minute;
  if (m < 9 * 60 + 30) return "PREMARKET";
  if (m < 11 * 60) return "OPEN";
  if (m < 14 * 60) return "MIDDAY";
  if (m < 16 * 60) return "POWER_HOUR";
  return "AFTERHOURS";
}

/** DTE buckets aligned with the strategy horizons used downstream. */
function dteBucket(dte: number | null): string | null {
  if (dte == null) return null;
  if (dte <= 0) return "0DTE";
  if (dte <= 5) return "1-5";
  if (dte <= 10) return "6-10";
  if (dte <= 35) return "11-35";
  if (dte <= 90) return "36-90";
  return ">90";
}

function deltaBand(delta: number | null): string | null {
  if (delta == null) return null;
  const d = Math.abs(delta);
  if (d < 0.3) return "<0.30";
  if (d < 0.45) return "0.30-0.45";
  if (d < 0.55) return "0.45-0.55";
  if (d < 0.7) return "0.55-0.70";
  return ">=0.70";
}

function spreadBand(spreadPct: number | null): string | null {
  if (spreadPct == null) return null;
  if (spreadPct <= 3) return "TIGHT";
  if (spreadPct <= 8) return "MODERATE";
  return "WIDE";
}

function relVolBucket(relVol: number | null): string | null {
  if (relVol == null) return null;
  if (relVol < 1) return "<1";
  if (relVol < 2) return "1-2";
  if (relVol < 4) return "2-4";
  return "4+";
}

function vwapState(above: boolean | null | undefined): string | null {
  if (above == null) return null;
  return above ? "ABOVE" : "BELOW";
}

/** Coarse, scale-independent momentum bucket (short-rate scaling is inconsistent). */
function momentumBucket(short: number | null): string | null {
  if (short == null) return null;
  if (short > 0) return "POS";
  if (short < 0) return "NEG";
  return "FLAT";
}

// ── Build ────────────────────────────────────────────────────────────────────

/** Build the deterministic, versioned fingerprint from entry-time fields only. */
export function buildFingerprint(input: FingerprintInput): Fingerprint {
  const reasons: string[] = [];

  const strategy = normEnum(input.strategy);
  if (!strategy) reasons.push("strategy_missing");
  const strategyVersion = strategyVersionFor(input.strategy);

  const delta = finiteOrNull(input.delta, reasons, "delta");
  const spreadPct = finiteOrNull(input.spreadPct, reasons, "spread");
  const relVol = finiteOrNull(input.relVol, reasons, "rel_vol");
  const dte = finiteOrNull(input.dte, reasons, "dte");
  const momentum = finiteOrNull(input.momentum, reasons, "momentum");
  const entryAtMs = finiteOrNull(input.entryAtMs, reasons, "entry_at_ms");

  const dimensions: Record<string, string | null> = {
    strategy,
    strategyVersion: String(strategyVersion),
    instrument: normEnum(input.instrument),
    direction: directionOf(input),
    triggerFamily: normEnum(input.triggerFamily),
    session: normEnum(input.session),
    todBucket: todBucket(entryAtMs),
    dteBucket: dteBucket(dte),
    deltaBand: deltaBand(delta),
    spreadBand: spreadBand(spreadPct),
    relVolBucket: relVolBucket(relVol),
    vwapState: vwapState(input.aboveVwap),
    lifecycleState: normEnum(input.lifecycleState) ?? "UNTRACKED",
    selectorProfile: normEnum(input.selectorProfile),
    momentumBucket: momentumBucket(momentum),
    moveClassification: normEnum(input.moveClassification),
  };

  // Canonical string: fixed, SORTED key set; null → "NA". Only bucket labels
  // (never raw floats) appear, so the hash is stable across environments.
  const canonical = canonicalize(dimensions, FINGERPRINT_VERSION);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const id = `sf${FINGERPRINT_VERSION}_${hash}`;

  const humanSummary = humanReadable(dimensions);

  return {
    id,
    version: FINGERPRINT_VERSION,
    strategyVersion,
    dimensions,
    canonical,
    humanSummary,
    dataQualityReasons: reasons,
  };
}

/** Deterministic canonical payload: `sf|v{n}|k=v|k=v|...` with SORTED keys. */
export function canonicalize(dimensions: Record<string, string | null>, version: number): string {
  const keys = [...DIMENSION_KEYS].sort();
  const parts = keys.map((k) => `${k}=${dimensions[k] == null ? "NA" : dimensions[k]}`);
  return `sf|v${version}|${parts.join("|")}`;
}

/** Compact human-readable summary (skips NA to stay legible). */
export function humanReadable(dimensions: Record<string, string | null>): string {
  const order: (typeof DIMENSION_KEYS)[number][] = [
    "strategy", "direction", "session", "todBucket", "dteBucket",
    "deltaBand", "spreadBand", "relVolBucket", "vwapState",
    "triggerFamily", "instrument", "lifecycleState", "moveClassification", "momentumBucket",
  ];
  const bits = order
    .map((k) => (dimensions[k] && dimensions[k] !== "NA" && dimensions[k] !== "UNTRACKED" ? `${k}=${dimensions[k]}` : null))
    .filter((x): x is string => x != null);
  return bits.join(" · ");
}
