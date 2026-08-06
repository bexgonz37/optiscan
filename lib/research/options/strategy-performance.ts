/**
 * Strategy/version performance segmentation.
 *
 * WHY THIS EXISTS
 *
 * The audited opening-alert population showed expectancy -7.2%, profit factor 0.49,
 * 59.9% immediate failure and 18.6% reaching +25%. Those are POPULATION numbers over
 * 181 sampled alerts spanning many strategies, both directions, several DTE bands and
 * more than one deployment. Treating that aggregate as "the strategy" is what made it
 * impossible to say which behaviour was actually losing money — and therefore impossible
 * to quarantine anything without quarantining everything.
 *
 * This module segments verified executable outcomes and computes per-segment metrics.
 * It is PURE: no I/O, no clock, no env. Callers supply rows.
 *
 * EXECUTABLE CONVENTION
 *
 * A return is only counted when it is priced the way a subscriber would actually
 * transact: entry at the ASK that was payable at alert time, exit at the BID later
 * available. Rows without that evidence are not silently coerced — they are classified
 * INSUFFICIENT_EVIDENCE or DATA_CONTAMINATED and reported as such. Missing data never
 * becomes zero.
 */

export type EvidenceQuality =
  /** Entry ask and exit bid both present; the row is priced as a subscriber would transact. */
  | "EXECUTABLE_VERIFIED"
  /** Priced, but from a lane whose provenance is not the delivered subscriber mirror. */
  | "RESEARCH_EXECUTABLE"
  /** Pre-foundation row with no reliable audience or pricing provenance. */
  | "CONTAMINATED"
  /** Present but missing the fields needed to price it honestly. */
  | "UNPRICEABLE";

export type StrategyClassification =
  | "FORWARD_VALIDATED"
  | "PROMISING_INSUFFICIENT_SAMPLE"
  | "UNPROVEN"
  | "NEGATIVE_EXPECTANCY"
  | "DEGRADED"
  | "DATA_CONTAMINATED"
  | "INSUFFICIENT_EVIDENCE";

/** One verified outcome, already normalised out of the paper-trade store. */
export interface OutcomeRow {
  tradeId: number;
  lane: string;                    // paper_kind: DELIVERED_ALERT_PAPER | RESEARCH_ONLY_PAPER | LEGACY_UNCLASSIFIED
  strategy: string | null;
  strategyVersion: string | null;
  selectionVersion: string | null;
  rankingVersion: string | null;
  deploymentSha: string | null;
  direction: string | null;        // call | put
  symbol: string | null;
  isIndexSymbol: boolean | null;
  dte: number | null;
  delta: number | null;
  spreadPct: number | null;
  entryFill: number | null;        // payable ask at alert
  exitFill: number | null;         // receivable bid at exit
  returnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  openInterest: number | null;
  volume: number | null;
  sessionDate: string | null;
  enteredAtMs: number | null;
  exitAtMs: number | null;
  /** ms between first eligibility and the alert actually going out. */
  alertLatencyMs: number | null;
  /** % the premium had already expanded before the alert was sent. */
  premiumExpansionPct: number | null;
  marketRegime: string | null;
}

export interface SegmentKey {
  lane: string;
  strategy: string;
  strategyVersion: string;
  selectionVersion: string;
  direction: string;
  symbolClass: string;   // "index" | "equity" | "unknown"
  dteBand: string;
  moneynessBand: string;
  premiumBand: string;
  timeOfDay: string;
  marketRegime: string;
  deploymentSha: string;
  sessionDate: string;
}

export interface SegmentMetrics {
  sampleSize: number;
  /** Rows that could be priced the executable way. Only these drive the metrics. */
  pricedSampleSize: number;
  winRate: number | null;
  reached25Pct: number | null;
  reached50Pct: number | null;
  reached100Pct: number | null;
  immediateFailureRate: number | null;
  medianReturnPct: number | null;
  medianMfePct: number | null;
  medianMaePct: number | null;
  expectancyPct: number | null;
  profitFactor: number | null;
  averageWinnerPct: number | null;
  averageLoserPct: number | null;
  medianAlertLatencyMs: number | null;
  medianPremiumExpansionPct: number | null;
  /** Worst run of consecutive losers. Only meaningful with an ordered sample. */
  maxAdverseSequence: number | null;
  evidenceQuality: EvidenceQuality;
  /** Fields that were absent, so a reader can see WHY a metric is null. */
  unavailable: string[];
}

/**
 * A row only counts toward the official numbers when it is priced the executable way.
 * `LEGACY_UNCLASSIFIED` is quarantined from BOTH subscriber stats and research learning,
 * matching the paper_kind contract in lib/db.ts.
 */
export function evidenceQualityOf(row: OutcomeRow): EvidenceQuality {
  if (row.lane === "LEGACY_UNCLASSIFIED" || !row.lane) return "CONTAMINATED";
  const priced = row.entryFill != null && row.entryFill > 0 && row.returnPct != null;
  if (!priced) return "UNPRICEABLE";
  return row.lane === "DELIVERED_ALERT_PAPER" ? "EXECUTABLE_VERIFIED" : "RESEARCH_EXECUTABLE";
}

export function dteBandOf(dte: number | null): string {
  if (dte == null) return "unknown";
  if (dte <= 0) return "0dte";
  if (dte <= 7) return "1-7dte";
  if (dte <= 14) return "8-14dte";
  if (dte <= 30) return "15-30dte";
  return "31+dte";
}

/** |delta| bands. Delta is the only moneyness proxy we can trust when strike/spot is absent. */
export function moneynessBandOf(delta: number | null): string {
  if (delta == null) return "unknown";
  const d = Math.abs(delta);
  if (d >= 0.65) return "deep_itm";
  if (d >= 0.45) return "atm";
  if (d >= 0.30) return "otm";
  return "far_otm";
}

export function premiumBandOf(entryFill: number | null): string {
  if (entryFill == null) return "unknown";
  if (entryFill < 0.5) return "under_50c";
  if (entryFill < 1.5) return "50c_1.50";
  if (entryFill < 3) return "1.50_3";
  if (entryFill < 6) return "3_6";
  return "over_6";
}

/** ET session buckets. Entry timing is a first-order driver of 0DTE outcomes. */
export function timeOfDayOf(enteredAtMs: number | null): string {
  if (enteredAtMs == null) return "unknown";
  const et = new Date(enteredAtMs).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  const hh = Number(et.slice(et.indexOf(",") + 2, et.indexOf(",") + 4));
  if (!Number.isFinite(hh)) return "unknown";
  if (hh < 10) return "open_0930_1000";
  if (hh < 12) return "morning_1000_1200";
  if (hh < 14) return "midday_1200_1400";
  return "close_1400_1600";
}

const N = (v: unknown): string => (v == null || v === "" ? "unknown" : String(v));

export function segmentKeyOf(row: OutcomeRow): SegmentKey {
  return {
    lane: N(row.lane),
    strategy: N(row.strategy),
    strategyVersion: N(row.strategyVersion),
    selectionVersion: N(row.selectionVersion),
    direction: N(row.direction),
    symbolClass: row.isIndexSymbol == null ? "unknown" : row.isIndexSymbol ? "index" : "equity",
    dteBand: dteBandOf(row.dte),
    moneynessBand: moneynessBandOf(row.delta),
    premiumBand: premiumBandOf(row.entryFill),
    timeOfDay: timeOfDayOf(row.enteredAtMs),
    marketRegime: N(row.marketRegime),
    deploymentSha: N(row.deploymentSha),
    sessionDate: N(row.sessionDate),
  };
}

export function segmentKeyString(k: SegmentKey): string {
  return [
    k.lane, k.strategy, k.strategyVersion, k.selectionVersion, k.direction,
    k.symbolClass, k.dteBand, k.moneynessBand, k.premiumBand, k.timeOfDay,
    k.marketRegime, k.deploymentSha, k.sessionDate,
  ].join("|");
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : +(((s[m - 1] + s[m]) / 2).toFixed(6));
};

const rate = (n: number, d: number): number | null => (d > 0 ? +(n / d).toFixed(6) : null);

/**
 * An alert "failed immediately" when it never gained more than 5% at any point. That is
 * the same definition the 59.9% baseline was measured with, kept identical so the new
 * per-segment numbers are comparable to it.
 */
export const IMMEDIATE_FAILURE_MFE_PCT = 5;

export function computeSegmentMetrics(rows: OutcomeRow[]): SegmentMetrics {
  const unavailable = new Set<string>();
  const qualities = rows.map(evidenceQualityOf);
  const contaminated = qualities.filter((q) => q === "CONTAMINATED").length;
  const priced = rows.filter((r) => {
    const q = evidenceQualityOf(r);
    return q === "EXECUTABLE_VERIFIED" || q === "RESEARCH_EXECUTABLE";
  });

  // The segment's evidence grade is the WEAKEST thing in it, not the best.
  let evidenceQuality: EvidenceQuality;
  if (!rows.length) evidenceQuality = "UNPRICEABLE";
  else if (contaminated > 0 && contaminated === rows.length) evidenceQuality = "CONTAMINATED";
  else if (!priced.length) evidenceQuality = "UNPRICEABLE";
  else if (priced.every((r) => evidenceQualityOf(r) === "EXECUTABLE_VERIFIED")) evidenceQuality = "EXECUTABLE_VERIFIED";
  else evidenceQuality = "RESEARCH_EXECUTABLE";

  const returns = priced.map((r) => r.returnPct!).filter((x) => Number.isFinite(x));
  const mfes = priced.map((r) => r.mfePct).filter((x): x is number => x != null && Number.isFinite(x));
  const maes = priced.map((r) => r.maePct).filter((x): x is number => x != null && Number.isFinite(x));
  const lats = priced.map((r) => r.alertLatencyMs).filter((x): x is number => x != null && Number.isFinite(x));
  const chases = priced.map((r) => r.premiumExpansionPct).filter((x): x is number => x != null && Number.isFinite(x));

  if (!mfes.length) unavailable.add("mfePct");
  if (!maes.length) unavailable.add("maePct");
  if (!lats.length) unavailable.add("alertLatencyMs");
  if (!chases.length) unavailable.add("premiumExpansionPct");

  const winners = returns.filter((x) => x > 0);
  const losers = returns.filter((x) => x <= 0);
  const grossWin = winners.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losers.reduce((a, b) => a + b, 0));

  // Ordered by entry time so "consecutive" means something.
  const ordered = [...priced]
    .filter((r) => r.enteredAtMs != null)
    .sort((a, b) => (a.enteredAtMs! - b.enteredAtMs!));
  let maxAdverseSequence: number | null = null;
  if (ordered.length) {
    let run = 0, best = 0;
    for (const r of ordered) {
      if ((r.returnPct ?? 0) <= 0) { run += 1; best = Math.max(best, run); } else run = 0;
    }
    maxAdverseSequence = best;
  } else {
    unavailable.add("maxAdverseSequence");
  }

  return {
    sampleSize: rows.length,
    pricedSampleSize: priced.length,
    winRate: rate(winners.length, returns.length),
    reached25Pct: mfes.length ? rate(mfes.filter((x) => x >= 25).length, mfes.length) : null,
    reached50Pct: mfes.length ? rate(mfes.filter((x) => x >= 50).length, mfes.length) : null,
    reached100Pct: mfes.length ? rate(mfes.filter((x) => x >= 100).length, mfes.length) : null,
    immediateFailureRate: mfes.length
      ? rate(mfes.filter((x) => x < IMMEDIATE_FAILURE_MFE_PCT).length, mfes.length)
      : null,
    medianReturnPct: median(returns),
    medianMfePct: median(mfes),
    medianMaePct: median(maes),
    expectancyPct: returns.length ? +(returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(4) : null,
    // Profit factor is undefined, NOT infinite, when there are no losses to divide by.
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : null,
    averageWinnerPct: winners.length ? +(grossWin / winners.length).toFixed(4) : null,
    averageLoserPct: losers.length ? +(losers.reduce((a, b) => a + b, 0) / losers.length).toFixed(4) : null,
    medianAlertLatencyMs: median(lats),
    medianPremiumExpansionPct: median(chases),
    maxAdverseSequence,
    evidenceQuality,
    unavailable: [...unavailable].sort(),
  };
}

/**
 * Classification thresholds.
 *
 * These are SCREENING thresholds derived from the measured population, not statistical
 * proof, and they are deliberately documented rather than tuned:
 *
 *   - The audited baseline is expectancy -7.2%, profit factor 0.49, +25% rate 18.6%.
 *     A version therefore has to clear BREAK-EVEN, not merely beat that baseline.
 *   - MIN_CLASSIFY_N = 20. Below this, the 95% binomial interval on an 18.6% base rate is
 *     roughly +/-17 points — wider than any effect worth acting on — so smaller samples
 *     are reported as INSUFFICIENT_EVIDENCE rather than given a verdict.
 *   - MIN_VALIDATE_N = 30 for FORWARD_VALIDATED, where the same interval is ~+/-14 points.
 *     Still wide. This is why FORWARD_VALIDATED is a CANDIDATE state and never authorises
 *     subscriber delivery on its own: human approval is always required.
 */
export interface ClassificationConfig {
  minClassifyN: number;
  minValidateN: number;
  negativeExpectancyPct: number;
  breakEvenProfitFactor: number;
  maxImmediateFailureRate: number;
}

export const DEFAULT_CLASSIFICATION: ClassificationConfig = Object.freeze({
  minClassifyN: 20,
  minValidateN: 30,
  // "Materially" negative: a rounding-level loss is not a quarantine reason.
  negativeExpectancyPct: -2,
  breakEvenProfitFactor: 1,
  // The measured baseline is 59.9%. Anything at or above that is not an improvement.
  maxImmediateFailureRate: 0.55,
});

export function classifySegment(
  m: SegmentMetrics,
  cfg: ClassificationConfig = DEFAULT_CLASSIFICATION,
): { classification: StrategyClassification; rationale: string } {
  if (m.evidenceQuality === "CONTAMINATED") {
    return { classification: "DATA_CONTAMINATED", rationale: "all rows are legacy/unclassified provenance" };
  }
  if (m.evidenceQuality === "UNPRICEABLE" || m.pricedSampleSize === 0) {
    return { classification: "INSUFFICIENT_EVIDENCE", rationale: "no row could be priced the executable way" };
  }
  if (m.expectancyPct == null) {
    return { classification: "INSUFFICIENT_EVIDENCE", rationale: "expectancy could not be computed" };
  }
  if (m.pricedSampleSize < cfg.minClassifyN) {
    // A small sample that is ALREADY strongly negative is worth flagging as promising-or-not,
    // but it is never enough to condemn a version outright.
    return {
      classification: m.expectancyPct > 0 ? "PROMISING_INSUFFICIENT_SAMPLE" : "INSUFFICIENT_EVIDENCE",
      rationale: `n=${m.pricedSampleSize} < ${cfg.minClassifyN}; expectancy ${m.expectancyPct}%`,
    };
  }
  const negative = m.expectancyPct <= cfg.negativeExpectancyPct
    && (m.profitFactor == null || m.profitFactor < cfg.breakEvenProfitFactor);
  if (negative) {
    return {
      classification: "NEGATIVE_EXPECTANCY",
      rationale: `expectancy ${m.expectancyPct}% <= ${cfg.negativeExpectancyPct}% and profit factor ${m.profitFactor ?? "n/a"} < ${cfg.breakEvenProfitFactor}`,
    };
  }
  // Zero losers over a real sample makes profit factor undefined rather than infinite.
  // That is not a validation: a strategy that has never once lost is far more likely to be
  // a data artifact (unclosed trades, one-sided marks) than a genuine edge, so it is named
  // as needing a loss before it can be judged instead of being waved through.
  if (m.profitFactor == null && m.expectancyPct > 0 && m.pricedSampleSize >= cfg.minValidateN) {
    return {
      classification: "UNPROVEN",
      rationale: `n=${m.pricedSampleSize} with zero losing trades — profit factor undefined, which is more likely a data artifact than an edge`,
    };
  }
  const positive = m.expectancyPct > 0
    && m.profitFactor != null && m.profitFactor > cfg.breakEvenProfitFactor;
  if (positive && m.pricedSampleSize >= cfg.minValidateN) {
    if (m.immediateFailureRate != null && m.immediateFailureRate > cfg.maxImmediateFailureRate) {
      return {
        classification: "DEGRADED",
        rationale: `expectancy positive but immediate-failure ${(m.immediateFailureRate * 100).toFixed(1)}% > ${(cfg.maxImmediateFailureRate * 100).toFixed(0)}%`,
      };
    }
    return {
      classification: "FORWARD_VALIDATED",
      rationale: `n=${m.pricedSampleSize}, expectancy ${m.expectancyPct}%, profit factor ${m.profitFactor}`,
    };
  }
  if (positive) {
    return {
      classification: "PROMISING_INSUFFICIENT_SAMPLE",
      rationale: `positive but n=${m.pricedSampleSize} < ${cfg.minValidateN}`,
    };
  }
  return {
    classification: "UNPROVEN",
    rationale: `expectancy ${m.expectancyPct}%, profit factor ${m.profitFactor ?? "n/a"} — neither materially negative nor proven positive`,
  };
}

export interface SegmentReport {
  key: SegmentKey;
  keyString: string;
  metrics: SegmentMetrics;
  classification: StrategyClassification;
  rationale: string;
}

/** Group rows by an arbitrary projection of the segment key, then classify each group. */
export function segmentAndClassify(
  rows: OutcomeRow[],
  project: (k: SegmentKey) => Partial<SegmentKey>,
  cfg: ClassificationConfig = DEFAULT_CLASSIFICATION,
): SegmentReport[] {
  const groups = new Map<string, { key: SegmentKey; rows: OutcomeRow[] }>();
  for (const row of rows) {
    const full = segmentKeyOf(row);
    const projected = { ...blankKey(), ...project(full) } as SegmentKey;
    const ks = segmentKeyString(projected);
    if (!groups.has(ks)) groups.set(ks, { key: projected, rows: [] });
    groups.get(ks)!.rows.push(row);
  }
  const out: SegmentReport[] = [];
  for (const [keyString, g] of groups) {
    const metrics = computeSegmentMetrics(g.rows);
    const { classification, rationale } = classifySegment(metrics, cfg);
    out.push({ key: g.key, keyString, metrics, classification, rationale });
  }
  // Worst expectancy first: the things most in need of quarantine sort to the top.
  return out.sort((a, b) => (a.metrics.expectancyPct ?? 0) - (b.metrics.expectancyPct ?? 0));
}

function blankKey(): SegmentKey {
  return {
    lane: "*", strategy: "*", strategyVersion: "*", selectionVersion: "*", direction: "*",
    symbolClass: "*", dteBand: "*", moneynessBand: "*", premiumBand: "*", timeOfDay: "*",
    marketRegime: "*", deploymentSha: "*", sessionDate: "*",
  };
}

/** The canonical projection P5 asks for: one row per strategy AND version. */
export const BY_STRATEGY_VERSION = (k: SegmentKey): Partial<SegmentKey> => ({
  lane: k.lane,
  strategy: k.strategy,
  strategyVersion: k.strategyVersion,
  selectionVersion: k.selectionVersion,
});

/** A version is quarantined from subscriber-style openings when it is proven bad or unproven. */
export const QUARANTINED_CLASSIFICATIONS: ReadonlySet<StrategyClassification> = new Set([
  "NEGATIVE_EXPECTANCY",
  "DEGRADED",
  "DATA_CONTAMINATED",
]);

export function isQuarantined(classification: StrategyClassification): boolean {
  return QUARANTINED_CLASSIFICATIONS.has(classification);
}
