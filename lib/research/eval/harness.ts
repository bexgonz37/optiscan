/**
 * lib/research/eval/harness.ts — the walk-forward / purged-embargoed evaluation harness
 * (Analog Engine, Phase B). PURE core + a thin OnDb persister.
 *
 * Invariants that make the harness trustworthy:
 *   • Strictly out-of-sample: a scorer is fit ONLY on training episodes and scored on a
 *     LATER, disjoint test block (expanding walk-forward).
 *   • Purge + embargo: training episodes whose forward-label window reaches into (or within
 *     an embargo of) the test period are removed — overlapping labels can't leak.
 *   • Lift over a baseline is reported with a paired bootstrap CI; a scorer only "wins" when
 *     that CI strictly excludes zero. On a no-signal dataset the harness reports NO lift.
 */
import { brier, ece, expectancy, hitRate, coverage, bootstrapLiftCI, type CI, type Prediction } from "./metrics.ts";
import type { LabeledEpisode, Scorer } from "./types.ts";

export interface Split { train: LabeledEpisode[]; test: LabeledEpisode[] }

/** Expanding walk-forward splits over time (episodes sorted by t0). */
export function walkForwardSplits(episodes: LabeledEpisode[], folds = 4): Split[] {
  const eps = [...episodes].sort((a, b) => a.input.t0Ms - b.input.t0Ms);
  const block = Math.floor(eps.length / (folds + 1));
  if (block < 1) return [];
  const splits: Split[] = [];
  for (let k = 0; k < folds; k++) {
    const trainEnd = (k + 1) * block;
    const test = eps.slice(trainEnd, k + 2 === folds + 1 ? eps.length : trainEnd + block);
    if (test.length === 0) break;
    splits.push({ train: eps.slice(0, trainEnd), test });
  }
  return splits;
}

/** Remove training episodes whose label window reaches into the test period (± embargo). */
export function purgeEmbargo(train: LabeledEpisode[], test: LabeledEpisode[], embargoMs = 0): LabeledEpisode[] {
  if (test.length === 0) return train;
  const testStart = Math.min(...test.map((t) => t.input.t0Ms));
  return train.filter((t) => t.labelEndMs < testStart - embargoMs);
}

export interface EvalOutput {
  predictions: (Prediction & { id: string })[];
  perSplit: { split: number; n: number; expectancy: number; hitRate: number; brier: number; ece: number; coverage: number }[];
}

/** Fit-on-train, score-on-test across all splits; collect strictly-OOS predictions. */
export function evaluate(scorer: Scorer, splits: Split[], embargoMs = 0): EvalOutput {
  const predictions: (Prediction & { id: string })[] = [];
  const perSplit: EvalOutput["perSplit"] = [];
  splits.forEach((s, i) => {
    const train = purgeEmbargo(s.train, s.test, embargoMs);
    if (scorer.fit) scorer.fit(train);
    const preds: Prediction[] = s.test.map((t) => ({ p: clamp01(scorer.score(t.input)), win: t.win, outcome: t.outcome }));
    s.test.forEach((t, j) => predictions.push({ id: t.input.id, ...preds[j] }));
    perSplit.push({ split: i, n: preds.length, expectancy: +expectancy(preds).toFixed(6), hitRate: +hitRate(preds).toFixed(4), brier: +brier(preds).toFixed(6), ece: +ece(preds).toFixed(6), coverage: +coverage(preds).toFixed(4) });
  });
  return { predictions, perSplit };
}

export interface ComparisonResult {
  candidate: { name: string; expectancy: number; hitRate: number; brier: number; ece: number; coverage: number; nOos: number };
  baseline: { name: string; expectancy: number; hitRate: number; brier: number; ece: number; coverage: number };
  lift: CI; // paired per-episode contribution lift; significant = CI excludes 0
}

/** Per-episode contribution = outcome if the scorer acted (p≥0.5), else 0 — rewards
 *  selecting winners and abstaining on losers. Candidate & baseline see identical splits. */
function contributions(out: EvalOutput): number[] {
  return out.predictions.map((p) => (p.p >= 0.5 ? p.outcome : 0));
}
function agg(out: EvalOutput) {
  return { expectancy: +expectancy(out.predictions).toFixed(6), hitRate: +hitRate(out.predictions).toFixed(4), brier: +brier(out.predictions).toFixed(6), ece: +ece(out.predictions).toFixed(6), coverage: +coverage(out.predictions).toFixed(4) };
}

/** Compare a candidate to one baseline out-of-sample with a paired bootstrap lift CI. */
export function compareToBaseline(candidate: Scorer, baseline: Scorer, splits: Split[], opts: { embargoMs?: number; iters?: number } = {}): ComparisonResult {
  const c = evaluate(candidate, splits, opts.embargoMs ?? 0);
  const b = evaluate(baseline, splits, opts.embargoMs ?? 0);
  const lift = bootstrapLiftCI(contributions(c), contributions(b), opts.iters ?? 2000);
  return {
    candidate: { name: candidate.name, ...agg(c), nOos: c.predictions.length },
    baseline: { name: baseline.name, ...agg(b) },
    lift,
  };
}

/** Beat EVERY baseline (each lift CI strictly &gt; 0) — the Phase D go/no-go predicate. */
export function beatsAllBaselines(candidate: Scorer, baselines: Scorer[], splits: Split[], opts: { embargoMs?: number; iters?: number } = {}): { ok: boolean; perBaseline: ComparisonResult[] } {
  const perBaseline = baselines.map((b) => compareToBaseline(candidate, b, splits, opts));
  return { ok: perBaseline.every((r) => r.lift.significant), perBaseline };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// ── OnDb persistence (idempotent) ────────────────────────────────────────────
interface EvalDb { prepare(sql: string): { run: (...a: any[]) => { changes: number } } }

export function persistComparisonOnDb(db: EvalDb, runId: string, dataset: string, r: ComparisonResult, perSplit: EvalOutput["perSplit"], nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT OR IGNORE INTO eval_runs (run_id, kind, dataset, scorer, baseline, splits, n_oos, oos_expectancy, oos_hit_rate, oos_brier, oos_ece, lift_vs_baseline, lift_ci_low, lift_ci_high, significant, config_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(runId, "walk_forward", dataset, r.candidate.name, r.baseline.name, perSplit.length, r.candidate.nOos,
    r.candidate.expectancy, r.candidate.hitRate, r.candidate.brier, r.candidate.ece,
    r.lift.point, r.lift.lo, r.lift.hi, r.lift.significant ? 1 : 0, null, nowMs);
  for (const s of perSplit) {
    db.prepare(`INSERT OR IGNORE INTO eval_results (run_id, scorer, split_idx, n, expectancy, hit_rate, brier, ece, coverage, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(runId, r.candidate.name, s.split, s.n, s.expectancy, s.hitRate, s.brier, s.ece, s.coverage, nowMs);
  }
}
