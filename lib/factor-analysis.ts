/**
 * Factor IC analysis (Alphalens-inspired) over alerts × alert_performance.
 * Day-block bootstrap — never resample individual alerts within a day.
 * Pure math; DB read helpers are separate.
 */
export type FactorName =
  | "signal_score"
  | "risk_score"
  | "options_liquidity_score"
  | "scanner_score"
  | "continuation_score"
  | "exhaustion_score"
  | "long_call_score"
  | "long_put_score"
  | "zero_dte_contract_score"
  | "option_worth_score";

export const FACTOR_NAMES: FactorName[] = [
  "signal_score",
  "risk_score",
  "options_liquidity_score",
  "scanner_score",
  "continuation_score",
  "exhaustion_score",
  "long_call_score",
  "long_put_score",
  "zero_dte_contract_score",
  "option_worth_score",
];

export const FACTOR_HORIZONS = ["5m", "15m", "30m", "1h", "eod"] as const;
export type FactorHorizon = (typeof FACTOR_HORIZONS)[number];

export interface FactorObservation {
  tradingDay: string;
  alertId: number;
  factor: number;
  forwardReturn: number;
}

export interface DayIc {
  tradingDay: string;
  n: number;
  spearman: number | null;
}

export interface QuantileBucket {
  q: number;
  n: number;
  meanForward: number | null;
}

export interface FactorIcReport {
  factor: FactorName;
  horizon: FactorHorizon;
  observations: number;
  usableDays: number;
  minAlertsPerDay: number;
  meanIc: number | null;
  icStd: number | null;
  icIr: number | null;
  pooledSpearman: number | null;
  dayIcs: DayIc[];
  quantiles: QuantileBucket[];
  bootstrap: {
    samples: number;
    mean: number | null;
    lo: number | null;
    hi: number | null;
  };
  baselineMeanForward: number | null;
  topQuintileMean: number | null;
  beatsBaseline: boolean | null;
  note: string;
}

function rank(xs: number[]): number[] {
  const indexed = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(xs.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation. Returns null if n < 3 or zero variance. */
export function spearmanCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  return +(num / Math.sqrt(dx * dy)).toFixed(6);
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function quantileBuckets(obs: FactorObservation[], buckets = 5): QuantileBucket[] {
  if (obs.length < buckets) {
    return Array.from({ length: buckets }, (_, i) => ({ q: i + 1, n: 0, meanForward: null }));
  }
  const sorted = [...obs].sort((a, b) => a.factor - b.factor);
  const size = Math.floor(sorted.length / buckets);
  const out: QuantileBucket[] = [];
  for (let q = 0; q < buckets; q++) {
    const start = q * size;
    const end = q === buckets - 1 ? sorted.length : (q + 1) * size;
    const slice = sorted.slice(start, end);
    out.push({
      q: q + 1,
      n: slice.length,
      meanForward: mean(slice.map((o) => o.forwardReturn)),
    });
  }
  return out;
}

/** Mulberry32 PRNG for reproducible bootstrap. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Block-bootstrap entire trading days (not individual alerts).
 * Returns mean IC and percentile CI across resamples.
 */
export function dayBlockBootstrapIc(
  byDay: Map<string, FactorObservation[]>,
  samples = 200,
  seed = 42,
  minAlertsPerDay = 5,
): { mean: number | null; lo: number | null; hi: number | null; samples: number } {
  const usableDays = [...byDay.entries()].filter(([, rows]) => rows.length >= minAlertsPerDay);
  if (usableDays.length < 2) return { mean: null, lo: null, hi: null, samples: 0 };
  const rand = mulberry32(seed);
  const ics: number[] = [];
  for (let s = 0; s < samples; s++) {
    const pooled: FactorObservation[] = [];
    for (let i = 0; i < usableDays.length; i++) {
      const pick = usableDays[Math.floor(rand() * usableDays.length)][1];
      pooled.push(...pick);
    }
    const ic = spearmanCorrelation(
      pooled.map((o) => o.factor),
      pooled.map((o) => o.forwardReturn),
    );
    if (ic != null) ics.push(ic);
  }
  if (!ics.length) return { mean: null, lo: null, hi: null, samples: 0 };
  ics.sort((a, b) => a - b);
  const lo = ics[Math.floor(0.025 * (ics.length - 1))];
  const hi = ics[Math.floor(0.975 * (ics.length - 1))];
  return { mean: mean(ics), lo, hi, samples: ics.length };
}

export function analyzeFactorIc(
  observations: FactorObservation[],
  opts: {
    factor: FactorName;
    horizon: FactorHorizon;
    minAlertsPerDay?: number;
    bootstrapSamples?: number;
    seed?: number;
    /** Same-day random-universe baseline mean forward (optional). */
    baselineMeanForward?: number | null;
  },
): FactorIcReport {
  const minAlertsPerDay = opts.minAlertsPerDay ?? 5;
  const byDay = new Map<string, FactorObservation[]>();
  for (const o of observations) {
    const arr = byDay.get(o.tradingDay) ?? [];
    arr.push(o);
    byDay.set(o.tradingDay, arr);
  }
  const dayIcs: DayIc[] = [];
  for (const [day, rows] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (rows.length < minAlertsPerDay) {
      dayIcs.push({ tradingDay: day, n: rows.length, spearman: null });
      continue;
    }
    dayIcs.push({
      tradingDay: day,
      n: rows.length,
      spearman: spearmanCorrelation(
        rows.map((r) => r.factor),
        rows.map((r) => r.forwardReturn),
      ),
    });
  }
  const usable = dayIcs.filter((d) => d.spearman != null);
  const usableIcs = usable.map((d) => d.spearman as number);
  const meanIc = mean(usableIcs);
  const icStd = stdev(usableIcs);
  const icIr = meanIc != null && icStd != null && icStd > 0 ? +(meanIc / icStd).toFixed(4) : null;
  const pooledSpearman = spearmanCorrelation(
    observations.map((o) => o.factor),
    observations.map((o) => o.forwardReturn),
  );
  const quantiles = quantileBuckets(observations);
  const topQuintileMean = quantiles[quantiles.length - 1]?.meanForward ?? null;
  const baseline = opts.baselineMeanForward ?? null;
  const beatsBaseline =
    topQuintileMean != null && baseline != null ? topQuintileMean > baseline : null;
  const bootstrap = dayBlockBootstrapIc(
    byDay,
    opts.bootstrapSamples ?? 200,
    opts.seed ?? 42,
    minAlertsPerDay,
  );

  return {
    factor: opts.factor,
    horizon: opts.horizon,
    observations: observations.length,
    usableDays: usable.length,
    minAlertsPerDay,
    meanIc: meanIc != null ? +meanIc.toFixed(6) : null,
    icStd: icStd != null ? +icStd.toFixed(6) : null,
    icIr,
    pooledSpearman,
    dayIcs,
    quantiles,
    bootstrap: {
      samples: bootstrap.samples,
      mean: bootstrap.mean != null ? +bootstrap.mean.toFixed(6) : null,
      lo: bootstrap.lo != null ? +bootstrap.lo.toFixed(6) : null,
      hi: bootstrap.hi != null ? +bootstrap.hi.toFixed(6) : null,
    },
    baselineMeanForward: baseline,
    topQuintileMean: topQuintileMean != null ? +topQuintileMean.toFixed(6) : null,
    beatsBaseline,
    note:
      "Per-day Spearman only on days with ≥minAlertsPerDay. Bootstrap resamples whole trading days. " +
      "Top quintile vs baseline is an honesty check — if top does not beat baseline, treat the factor as noise.",
  };
}

type FactorDb = {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] };
};

/** Load factor × forward-return observations from alerts + alert_performance. */
export function loadFactorObservationsOnDb(
  db: FactorDb,
  factor: FactorName,
  horizon: FactorHorizon,
): FactorObservation[] {
  const allowed = new Set(FACTOR_NAMES);
  if (!allowed.has(factor)) return [];
  const sql = `
    SELECT a.trading_day AS tradingDay, a.id AS alertId, a.${factor} AS factor,
           p.percent_move_from_alert AS forwardReturn
    FROM alerts a
    JOIN alert_performance p ON p.alert_id = a.id
    WHERE p.checkpoint = ?
      AND a.${factor} IS NOT NULL
      AND p.percent_move_from_alert IS NOT NULL
    ORDER BY a.trading_day, a.id`;
  try {
    const rows = db.prepare(sql).all(horizon) as Array<{
      tradingDay: string;
      alertId: number;
      factor: number;
      forwardReturn: number;
    }>;
    return rows
      .filter((r) => Number.isFinite(Number(r.factor)) && Number.isFinite(Number(r.forwardReturn)))
      .map((r) => ({
        tradingDay: String(r.tradingDay),
        alertId: Number(r.alertId),
        factor: Number(r.factor),
        forwardReturn: Number(r.forwardReturn),
      }));
  } catch {
    return [];
  }
}
