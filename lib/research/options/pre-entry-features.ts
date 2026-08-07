/**
 * Pre-entry features for a delivered options opportunity.
 *
 * WHY THIS EXISTS
 *
 * The question this lane needs answered is "what distinguished the winners from the losers
 * BEFORE entry" — and the only way to answer it honestly is to make it structurally hard to
 * read a field that did not exist yet. Two fields in `opportunity_cases.case_json` look
 * exactly like selection evidence and are not:
 *
 *   contractCandidates[].observedAtMs   0 of 222 rows observed at or before entry
 *   contractUpdates[].changedAtMs       0 of 163 rows changed at or before entry
 *
 * Both accumulate over the LIFE of a case, so a position that lived longer collects more of
 * them. Ranked naively they are the two strongest "predictors" in the cohort (AUC 0.89/0.88)
 * and they are pure hindsight: they measure survival, not selection. Anything derived from
 * them would look excellent in backtest and do nothing live.
 *
 * So this module does not extract "everything available". It extracts a CLOSED, declared set
 * of fields, each carrying the timestamp basis that makes it pre-entry, and `assertNoLeakage`
 * exists so a test can fail if the denylist is ever read.
 *
 * PURE. No I/O, no clock, no env. Callers supply rows.
 */

/** Fields that exist on the source rows and must never reach a selection rule. */
export const HINDSIGHT_DENYLIST = Object.freeze([
  // case_json lifetime accumulators — see header
  "contractCandidates",
  "contractCandidateCount",
  "contractUpdates",
  "contractUpdateCount",
  // outcome columns
  "return_pct", "returnPct", "exit_fill", "exitFill", "exit_reason", "exitReason",
  "exit_at_ms", "exitAtMs", "pnl", "mfe_pct", "mfePct", "mae_pct", "maePct",
  "last_mark_return_pct", "peakPct", "troughPct", "result_class", "resultClass",
] as const);

/**
 * Why a feature is trustworthy as pre-entry evidence.
 * `FROZEN_AT_ENTRY` — written once when the contract was frozen; cannot move afterwards.
 * `SNAPSHOT_AT_DELIVERY` — captured into the alert's evidence snapshot at notification time.
 * `DERIVED_PRE_ENTRY` — computed only from other pre-entry values.
 * `DEGENERATE` — the column exists but production never wrote a distinguishing value.
 */
export type FeatureBasis =
  | "FROZEN_AT_ENTRY"
  | "SNAPSHOT_AT_DELIVERY"
  | "DERIVED_PRE_ENTRY"
  | "DEGENERATE";

export interface PreEntryFeatures {
  // ---- contract, frozen at entry ----
  dte: number | null;
  strike: number | null;
  entryFill: number | null;
  spreadPct: number | null;
  contractVolume: number | null;
  openInterest: number | null;
  iv: number | null;
  absDelta: number | null;
  /** (strike - underlying) / underlying, in percent. Negative = OTM for a put. */
  moneynessPct: number | null;

  // ---- underlying setup, snapshotted at delivery ----
  underlyingAtEntry: number | null;
  dollarVolume: number | null;
  vwapDistPct: number | null;
  aboveVwap: boolean | null;
  velPct: number | null;
  accelPct: number | null;
  volumeAccel: number | null;
  compressionScore: number | null;
  expansionScore: number | null;
  atrPct: number | null;
  hodProxPct: number | null;
  lodProxPct: number | null;
  nearestSupportDistPct: number | null;
  nearestResistanceDistPct: number | null;
  gapPct: number | null;
  gapBehavior: string | null;

  // ---- chain, snapshotted at delivery ----
  callPutVolRatio: number | null;
  ivLevel: number | null;
  medianSpreadPct: number | null;
  zeroBidRate: number | null;
  ntmConcentration: number | null;
  chainDirection: string | null;

  // ---- timing, derived pre-entry ----
  /** Minutes past midnight ET at entry. */
  etMinute: number | null;
  /** This opening's 1-based ordinal among same-strategy openings that session. */
  sessionAlertOrdinal: number | null;
  /** Same-strategy positions already open when this one opened. */
  concurrentOpen: number | null;
  earlinessPhase: string | null;
  /** entry - first detection. DEGENERATE in history: production wrote 0 for every row. */
  confirmationDelayMs: number | null;
  /** DEGENERATE in history: only bid/ask rounding noise was ever recorded. */
  premiumExpansionPct: number | null;
}

/** Declared basis for every feature, so a report can say what it is entitled to claim. */
export const FEATURE_BASIS: Readonly<Record<keyof PreEntryFeatures, FeatureBasis>> = Object.freeze({
  dte: "FROZEN_AT_ENTRY", strike: "FROZEN_AT_ENTRY", entryFill: "FROZEN_AT_ENTRY",
  spreadPct: "FROZEN_AT_ENTRY", contractVolume: "FROZEN_AT_ENTRY", openInterest: "FROZEN_AT_ENTRY",
  iv: "FROZEN_AT_ENTRY", absDelta: "FROZEN_AT_ENTRY", moneynessPct: "DERIVED_PRE_ENTRY",
  underlyingAtEntry: "FROZEN_AT_ENTRY",
  dollarVolume: "SNAPSHOT_AT_DELIVERY", vwapDistPct: "SNAPSHOT_AT_DELIVERY",
  aboveVwap: "SNAPSHOT_AT_DELIVERY", velPct: "SNAPSHOT_AT_DELIVERY",
  accelPct: "SNAPSHOT_AT_DELIVERY", volumeAccel: "SNAPSHOT_AT_DELIVERY",
  compressionScore: "SNAPSHOT_AT_DELIVERY", expansionScore: "SNAPSHOT_AT_DELIVERY",
  atrPct: "SNAPSHOT_AT_DELIVERY", hodProxPct: "SNAPSHOT_AT_DELIVERY",
  lodProxPct: "SNAPSHOT_AT_DELIVERY", nearestSupportDistPct: "SNAPSHOT_AT_DELIVERY",
  nearestResistanceDistPct: "SNAPSHOT_AT_DELIVERY", gapPct: "SNAPSHOT_AT_DELIVERY",
  gapBehavior: "SNAPSHOT_AT_DELIVERY",
  callPutVolRatio: "SNAPSHOT_AT_DELIVERY", ivLevel: "SNAPSHOT_AT_DELIVERY",
  medianSpreadPct: "SNAPSHOT_AT_DELIVERY", zeroBidRate: "SNAPSHOT_AT_DELIVERY",
  ntmConcentration: "SNAPSHOT_AT_DELIVERY", chainDirection: "SNAPSHOT_AT_DELIVERY",
  etMinute: "DERIVED_PRE_ENTRY", sessionAlertOrdinal: "DERIVED_PRE_ENTRY",
  concurrentOpen: "DERIVED_PRE_ENTRY", earlinessPhase: "SNAPSHOT_AT_DELIVERY",
  confirmationDelayMs: "DEGENERATE", premiumExpansionPct: "DEGENERATE",
});

/** Raw shape the loader hands over. Deliberately narrow. */
export interface PreEntrySource {
  strike: number | null;
  dte: number | null;
  entryFill: number | null;
  spreadPct: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  underlyingPrice: number | null;
  enteredAtMs: number;
  /** Parsed `options_alerts.evidence_snapshot_json`. */
  evidence: unknown;
  firstDetectedAtMs: number | null;
  optionAtFirstDetection: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Minutes past midnight in US/Eastern for a UTC epoch. */
export function easternMinuteOfDay(ms: number): number | null {
  if (!Number.isFinite(ms)) return null;
  const s = new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
  const [h, m] = s.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/** Session date (US/Eastern calendar day) for a UTC epoch. */
export function easternSessionDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function extractPreEntryFeatures(src: PreEntrySource): PreEntryFeatures {
  const ev = obj(src.evidence);
  const u = obj(ev.underlying);
  const ch = obj(ev.chain);

  const px = num(src.underlyingPrice) ?? num(u.price);
  const strike = num(src.strike);
  const moneynessPct = px && px > 0 && strike != null ? ((strike - px) / px) * 100 : null;

  const firstOpt = num(src.optionAtFirstDetection);
  const entry = num(src.entryFill);
  const premiumExpansionPct =
    firstOpt && firstOpt > 0 && entry != null ? ((entry - firstOpt) / firstOpt) * 100 : null;

  return {
    dte: num(src.dte), strike, entryFill: entry,
    spreadPct: num(src.spreadPct), contractVolume: num(src.volume),
    openInterest: num(src.openInterest), iv: num(src.iv),
    absDelta: num(src.delta) == null ? null : Math.abs(num(src.delta)!),
    moneynessPct,
    underlyingAtEntry: px,
    dollarVolume: num(u.dollarVolume), vwapDistPct: num(u.vwapDistPct),
    aboveVwap: bool(u.aboveVwap), velPct: num(u.velPct), accelPct: num(u.accelPct),
    volumeAccel: num(u.volumeAccel), compressionScore: num(u.compressionScore),
    expansionScore: num(u.expansionScore), atrPct: num(u.atrPct),
    hodProxPct: num(u.hodProxPct), lodProxPct: num(u.lodProxPct),
    nearestSupportDistPct: num(u.nearestSupportDistPct),
    nearestResistanceDistPct: num(u.nearestResistanceDistPct),
    gapPct: num(u.gapPct), gapBehavior: str(u.gapBehavior),
    callPutVolRatio: num(ch.callPutVolRatio), ivLevel: num(ch.ivLevel),
    medianSpreadPct: num(ch.medianSpreadPct), zeroBidRate: num(ch.zeroBidRate),
    ntmConcentration: num(ch.ntmConcentration), chainDirection: str(ch.direction),
    etMinute: easternMinuteOfDay(src.enteredAtMs),
    sessionAlertOrdinal: null, // assigned by the cohort builder, which sees the whole session
    concurrentOpen: null,
    earlinessPhase: str(ev.earlinessPhase),
    confirmationDelayMs: src.firstDetectedAtMs == null ? null : src.enteredAtMs - src.firstDetectedAtMs,
    premiumExpansionPct,
  };
}

/**
 * Fails if a denylisted key is present on an object handed to a selection rule.
 * Used by tests and by the experiment entry point so leakage cannot be reintroduced quietly.
 */
export function assertNoLeakage(candidate: Record<string, unknown>, where: string): void {
  const found = HINDSIGHT_DENYLIST.filter((k) => k in candidate);
  if (found.length) {
    throw new Error(`${where}: hindsight field(s) reached a pre-entry rule: ${found.join(", ")}`);
  }
}

/**
 * A feature is DEGENERATE when production wrote no distinguishing value. Reported so the
 * packet cannot claim "confirmation delay did not matter" when the truth is that it was
 * never measured.
 */
export function degenerateFeatures(
  list: readonly PreEntryFeatures[],
): { feature: string; distinctValues: number; note: string }[] {
  const out: { feature: string; distinctValues: number; note: string }[] = [];
  for (const k of ["confirmationDelayMs", "premiumExpansionPct"] as const) {
    const vals = new Set(list.map((f) => f[k]).filter((v) => v != null && v !== 0));
    if (vals.size === 0) {
      out.push({ feature: k, distinctValues: 0, note: "never written with a non-zero value" });
    }
  }
  return out;
}
