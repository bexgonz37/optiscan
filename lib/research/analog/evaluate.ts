/**
 * lib/research/analog/evaluate.ts — the Phase-D real-data evaluation runner (Analog Engine).
 * Reads the SEEDED episode library, builds strictly-out-of-sample splits, runs the analog
 * engine against every baseline, and writes the durable GO/REMEDIATE/STOP report. Impure
 * (reads DB) with a pure core over supplied rows so it is testable on a synthetic library.
 *
 * Honesty: dataset provenance is read from the seed runs — if the universe was survivorship-
 * biased (or unknown), the report is EXPLORATORY_ONLY and can never GO (report.ts enforces).
 */
import { brier, coverage, ece, expectancy, hitRate } from "../eval/metrics.ts";
import { baselineSuite } from "../eval/baselines.ts";
import { beatsAllBaselines, evaluate as runEvaluate, walkForwardSplits } from "../eval/harness.ts";
import type { LabeledEpisode } from "../eval/types.ts";
import { AnalogScorer, type AnalogConfig } from "./engine.ts";
import { buildPhaseDReport, persistPhaseDReportOnDb, type BaselineOutcome, type DatasetKind, type PhaseDReport } from "./report.ts";

interface EvalDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }

const parse = (s: any) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const encLiquidity = (t: string | null) => (t === "high" ? 2 : t === "medium" ? 1 : 0);

/** Flatten a setup_episodes row's Zone-A JSON blocks into a numeric feature record + cmp keys. */
export function episodeRowToLabeled(row: any, returnPct: number, labelAsOfMs: number): LabeledEpisode {
  const ps = parse(row.price_structure_json)?.values ?? {};
  const mo = parse(row.momentum_json)?.values ?? {};
  const vo = parse(row.volume_json)?.values ?? {};
  const vl = parse(row.volatility_json)?.values ?? {};
  const features: Record<string, number> = {
    velPct: num(mo.velPct), accelPct: num(mo.accelPct), rvol: num(vo.rvol),
    realizedVol: num(vl.realizedVol), atrPct: num(vl.atrPct), posInRange: num(ps.posInRange), gapPct: num(ps.gapPct),
    cmp_liquidity: encLiquidity(row.liquidity_tier), cmp_direction: row.direction === "bearish" ? 0 : 1, cmp_symbol: hashNum(row.symbol),
  };
  return { input: { id: row.episode_key, t0Ms: row.t0_ms, features }, win: returnPct > 0, outcome: returnPct, labelStartMs: row.t0_ms, labelEndMs: labelAsOfMs };
}

/** Read the labeled episode set for a horizon (UNDERLYING labels). */
export function readEpisodesForEvalOnDb(db: EvalDb, horizon: string): LabeledEpisode[] {
  const rows = db.prepare(
    `SELECT e.*, l.return_pct AS l_return, l.label_as_of_ms AS l_asof
     FROM setup_episodes e JOIN episode_labels l ON l.episode_key = e.episode_key
     WHERE l.horizon = ? AND l.target_kind = 'UNDERLYING' AND l.return_pct IS NOT NULL`,
  ).all(horizon) as any[];
  return rows.map((r) => episodeRowToLabeled(r, r.l_return, r.l_asof));
}

function datasetProvenance(db: EvalDb): { datasetKind: DatasetKind; survivorshipBias: boolean; universeSource: string; dateFrom: string; dateTo: string } {
  const runs = (safeAll(db, "SELECT provider_limitations, date_from, date_to FROM replay_runs WHERE asset_class='stock'")).map((r) => ({ prov: parse(r.provider_limitations), from: r.date_from, to: r.date_to }));
  if (runs.length === 0) return { datasetKind: "survivorship_fallback", survivorshipBias: true, universeSource: "unknown (no seed runs)", dateFrom: "", dateTo: "" };
  const allFree = runs.every((r) => r.prov && r.prov.survivorshipBias === false);
  const source = runs[0].prov?.universeSource ?? "unspecified";
  return {
    datasetKind: allFree ? "real_seeded" : "survivorship_fallback",
    survivorshipBias: !allFree, universeSource: source,
    dateFrom: runs.map((r) => r.from).sort()[0] ?? "", dateTo: runs.map((r) => r.to).sort().reverse()[0] ?? "",
  };
}

export interface RunEvalOpts { horizon?: string; folds?: number; embargoMs?: number; minEpisodes?: number; config?: Partial<AnalogConfig>; iters?: number }

/** Run the full Phase-D evaluation on the DB and persist the report. Returns the report. */
export function runPhaseDEvalOnDb(db: EvalDb, opts: RunEvalOpts = {}, nowMs: number = Date.now()): PhaseDReport {
  const horizon = opts.horizon ?? "5d";
  const minEpisodes = opts.minEpisodes ?? 500;
  const prov = datasetProvenance(db);
  const episodes = readEpisodesForEvalOnDb(db, horizon);
  const modeledShare = modeledOutcomeShare(db);
  const missingRates = missingFeatureRates(db);

  const base = {
    datasetKind: prov.datasetKind, provenance: { universeSource: prov.universeSource, survivorshipBias: prov.survivorshipBias, corporateActionAdjusted: true },
    dateFrom: prov.dateFrom, dateTo: prov.dateTo, episodeCount: episodes.length,
    excludedCount: 0, rejectedCount: 0, missingFeatureRates: missingRates,
    transactionCostAssumptions: "modeled option via Greeks reprice; underlying labels are observed (no fill costs applied at Phase D)", modeledOutcomeShare: modeledShare,
  };

  if (episodes.length < minEpisodes) {
    const report = buildPhaseDReport({ ...base, trainTestWindows: 0, embargoMs: 0,
      candidate: { name: "analog_tier1", expectancy: 0, hitRate: 0, brier: 0, ece: 0, coverage: 0, abstentionRate: 1, nOos: 0 }, baselines: [] }, nowMs);
    persistReport(db, report, nowMs);
    return report;
  }

  const folds = opts.folds ?? 4;
  const splits = walkForwardSplits(episodes, folds);
  const dims = Object.keys(episodes[0].input.features).filter((k) => !k.startsWith("cmp_"));
  const analog = new AnalogScorer(opts.config);
  const res = beatsAllBaselines(analog, baselineSuite(dims), splits, { embargoMs: opts.embargoMs ?? 0, iters: opts.iters ?? 1500 });
  const out = runEvaluate(analog, splits, opts.embargoMs ?? 0);
  const abstentionRate = out.predictions.length ? out.predictions.filter((p) => p.p === 0).length / out.predictions.length : 1;
  const baselines: BaselineOutcome[] = res.perBaseline.map((r) => ({ baseline: r.baseline.name, liftPoint: r.lift.point, liftLo: r.lift.lo, liftHi: r.lift.hi, significant: r.lift.significant }));

  const report = buildPhaseDReport({
    ...base, trainTestWindows: folds, embargoMs: opts.embargoMs ?? 0,
    candidate: {
      name: "analog_tier1",
      expectancy: +expectancy(out.predictions).toFixed(6), hitRate: +hitRate(out.predictions).toFixed(4),
      brier: +brier(out.predictions).toFixed(6), ece: +ece(out.predictions).toFixed(6),
      coverage: +coverage(out.predictions).toFixed(4), abstentionRate: +abstentionRate.toFixed(4), nOos: out.predictions.length,
    },
    baselines,
  }, nowMs);
  persistReport(db, report, nowMs);
  return report;
}

function persistReport(db: EvalDb, report: PhaseDReport, nowMs: number) {
  persistPhaseDReportOnDb(db as any, `phaseD_${nowMs}`, report, nowMs);
}
function modeledOutcomeShare(db: EvalDb): number {
  const t = safeAll(db, "SELECT COUNT(*) n FROM episode_labels")[0]?.n ?? 0;
  const m = safeAll(db, "SELECT COUNT(*) n FROM episode_labels WHERE outcome_kind='MODELED_OPTION'")[0]?.n ?? 0;
  return t ? +(m / t).toFixed(4) : 0;
}
function missingFeatureRates(db: EvalDb): Record<string, number> {
  const total = safeAll(db, "SELECT COUNT(*) n FROM setup_episodes")[0]?.n ?? 0;
  if (!total) return {};
  const miss = safeAll(db, "SELECT COUNT(*) n FROM setup_episodes WHERE missing_json LIKE '%optionsContext%'")[0]?.n ?? 0;
  return { optionsContext: +(miss / total).toFixed(4) };
}
function safeAll(db: EvalDb, sql: string, ...a: any[]): any[] { try { return db.prepare(sql).all(...a); } catch { return []; } }
function num(v: any): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function hashNum(s: string): number { let h = 5381; for (let i = 0; i < String(s).length; i++) h = (((h << 5) + h) ^ String(s).charCodeAt(i)) >>> 0; return h % 100000; }
