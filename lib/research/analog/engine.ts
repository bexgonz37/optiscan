/**
 * lib/research/analog/engine.ts — the Tier-1 analog engine (Analog Engine, Phase D).
 * PURE. Implements the Phase-B `Scorer` interface so it competes against the baselines on
 * identical, strictly-out-of-sample splits.
 *
 * Pipeline per query: comparability pre-filter (hard `cmp_*` keys must match — never a
 * distance dimension) → outcome-weighted, correlation-aware kNN (similarity.ts) → forward-
 * return distribution → sample-size shrinkage + dispersion/contradiction penalties →
 * abstention. Abstain ⇒ score 0 (the harness treats it as "did not act"). The engine reads
 * ONLY decision-time features; it never sees the query's outcome.
 */
import { fitMetric, mdist, type MetricModel } from "./similarity.ts";
import type { LabeledEpisode, ScoreInput, Scorer } from "../eval/types.ts";

export interface AnalogConfig {
  ridge: number;
  k: number;                    // neighbors to retrieve
  maxRadius: number;            // distance beyond which analogs are ignored (Infinity = off)
  minEffectiveSample: number;   // abstain below this many usable analogs
  dispersionCeiling: number;    // abstain when analog outcomes are too scattered
  contradictionCeiling: number; // abstain when analogs split ~evenly win/loss (0.5 = even)
  shrinkK: number;              // sample-size shrinkage strength toward base rate
  perKeyCap: number;            // max analogs sharing a cmp_symbol (dedup independence)
}
export function defaultAnalogConfig(): AnalogConfig {
  return { ridge: 0.1, k: 30, maxRadius: Infinity, minEffectiveSample: 15, dispersionCeiling: Infinity, contradictionCeiling: 0.49, shrinkK: 20, perKeyCap: 5 };
}

interface Row { vec: number[]; cmp: Record<string, number>; win: boolean; outcome: number; id: string; symKey: string }
export interface Analog { id: string; distance: number; win: boolean; outcome: number }
export interface AnalogExplain {
  abstain: boolean; reason: string | null; p: number;
  nAnalogs: number; effectiveSample: number;
  winRate: number; expectancy: number; dispersion: number; contradiction: number;
  p10: number; p50: number; p90: number;
  nearest: Analog[]; nearestWin: Analog | null; nearestLoss: Analog | null;
}

const isCmp = (k: string) => k.startsWith("cmp_");

export class AnalogScorer implements Scorer {
  readonly name = "analog_tier1";
  private cfg: AnalogConfig;
  private dims: string[] = [];
  private model: MetricModel | null = null;
  private rows: Row[] = [];
  private baseRate = 0.5;

  constructor(cfg: Partial<AnalogConfig> = {}) { this.cfg = { ...defaultAnalogConfig(), ...cfg }; }

  fit(train: LabeledEpisode[]): void {
    const dimSet = new Set<string>();
    for (const t of train) for (const k of Object.keys(t.input.features)) if (!isCmp(k)) dimSet.add(k);
    this.dims = [...dimSet].sort();
    const rows = train.map((t) => this.dims.map((k) => t.input.features[k] ?? NaN));
    const wins = train.map((t) => t.win);
    this.model = train.length >= 2 ? fitMetric(rows, wins, this.dims, this.cfg.ridge) : null;
    this.rows = train.map((t) => ({
      vec: this.dims.map((k) => t.input.features[k] ?? NaN),
      cmp: Object.fromEntries(Object.entries(t.input.features).filter(([k]) => isCmp(k))),
      win: t.win, outcome: t.outcome, id: t.input.id, symKey: String(t.input.features["cmp_symbol"] ?? t.input.id),
    }));
    this.baseRate = train.length ? wins.filter(Boolean).length / train.length : 0.5;
  }

  private explainFull(input: ScoreInput): AnalogExplain {
    const abst = (reason: string): AnalogExplain => ({ abstain: true, reason, p: 0, nAnalogs: 0, effectiveSample: 0, winRate: 0, expectancy: 0, dispersion: 0, contradiction: 0, p10: 0, p50: 0, p90: 0, nearest: [], nearestWin: null, nearestLoss: null });
    if (!this.model) return abst("not fitted / insufficient training data");
    const qvec = this.dims.map((k) => input.features[k] ?? NaN);
    const qcmp = Object.fromEntries(Object.entries(input.features).filter(([k]) => isCmp(k)));
    const pool = this.rows.filter((r) => Object.keys(qcmp).every((k) => r.cmp[k] === qcmp[k]));
    if (pool.length < this.cfg.minEffectiveSample) return abst(`comparable pool ${pool.length} < ${this.cfg.minEffectiveSample}`);

    const scored = pool.map((r) => ({ r, d: mdist(this.model!, qvec, r.vec) }))
      .filter((x) => x.d <= this.cfg.maxRadius)
      .sort((a, b) => a.d - b.d);
    // Dedup independence: cap analogs per cmp_symbol.
    const perKey = new Map<string, number>(); const kept: typeof scored = [];
    for (const s of scored) { const c = perKey.get(s.r.symKey) ?? 0; if (c >= this.cfg.perKeyCap) continue; perKey.set(s.r.symKey, c + 1); kept.push(s); if (kept.length >= this.cfg.k) break; }
    if (kept.length < this.cfg.minEffectiveSample) return abst(`usable analogs ${kept.length} < ${this.cfg.minEffectiveSample}`);
    if (kept[0].d > this.cfg.maxRadius) return abst("nearest analog beyond radius");

    const outs = kept.map((x) => x.r.outcome);
    const winRate = kept.filter((x) => x.r.win).length / kept.length;
    const expectancy = outs.reduce((a, x) => a + x, 0) / outs.length;
    const dispersion = std(outs);
    const contradiction = Math.min(winRate, 1 - winRate); // 0 = unanimous, 0.5 = even split
    if (dispersion > this.cfg.dispersionCeiling) return abst(`dispersion ${dispersion.toFixed(3)} > ceiling`);
    if (contradiction > this.cfg.contradictionCeiling) return abst(`analogs contradict (contradiction ${contradiction.toFixed(2)})`);

    const shrink = kept.length / (kept.length + this.cfg.shrinkK);
    let p = this.baseRate + (winRate - this.baseRate) * shrink;
    const dispFactor = 1 / (1 + dispersion);            // wide outcomes → pull toward 0.5
    p = 0.5 + (p - 0.5) * dispFactor;
    p = Math.max(0, Math.min(1, p));

    const sortedOut = [...outs].sort((a, b) => a - b);
    const analogs: Analog[] = kept.map((x) => ({ id: x.r.id, distance: +x.d.toFixed(6), win: x.r.win, outcome: x.r.outcome }));
    return {
      abstain: false, reason: null, p, nAnalogs: kept.length, effectiveSample: perKey.size,
      winRate: +winRate.toFixed(4), expectancy: +expectancy.toFixed(6), dispersion: +dispersion.toFixed(6), contradiction: +contradiction.toFixed(4),
      p10: pctile(sortedOut, 0.1), p50: pctile(sortedOut, 0.5), p90: pctile(sortedOut, 0.9),
      nearest: analogs.slice(0, 5),
      nearestWin: analogs.find((a) => a.win) ?? null, nearestLoss: analogs.find((a) => !a.win) ?? null,
    };
  }

  /** Public: full evidence for the recommendation card / Phase-D report. */
  explain(input: ScoreInput): AnalogExplain { return this.explainFull(input); }

  score(input: ScoreInput): number { return this.explainFull(input).p; }
}

function std(xs: number[]): number { if (xs.length < 2) return 0; const m = xs.reduce((a, x) => a + x, 0) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); }
function pctile(sorted: number[], q: number): number { if (!sorted.length) return 0; const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1)))); return +sorted[idx].toFixed(6); }
