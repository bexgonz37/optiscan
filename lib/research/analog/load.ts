/**
 * lib/research/analog/load.ts — safe RESEARCH-ONLY loader that fits an AnalogScorer from the stored
 * corpus for the analog SHADOW bridge (Analog Shadow, part G). PURE-ish (reads the DB).
 *
 * The analog shadow must NOT silently remain inert: this loads the corpus, fits the scorer, and — if
 * the corpus is too small or unfit — returns null WITH THE EXACT REASON so the shadow records an
 * honest abstain. Never forces an analog result; analog evidence is never actionable.
 */
import { AnalogScorer, type AnalogConfig } from "./engine.ts";
import { readEpisodesForEvalOnDb } from "./evaluate.ts";

interface LoadDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] } }

export interface FittedScorerResult { scorer: AnalogScorer | null; fit: boolean; reason: string; episodeCount: number; horizon: string }

export interface LoadScorerOpts { horizon?: string; minEpisodes?: number; config?: Partial<AnalogConfig> }

/** Fit an AnalogScorer from the corpus, or return null + reason when it is unfit (too small). */
export function loadFittedAnalogScorer(db: LoadDb, opts: LoadScorerOpts = {}): FittedScorerResult {
  const horizon = opts.horizon ?? "1d";
  const minEpisodes = opts.minEpisodes ?? 200;
  let episodes: ReturnType<typeof readEpisodesForEvalOnDb> = [];
  try { episodes = readEpisodesForEvalOnDb(db as any, horizon); } catch { /* schema not present */ }
  if (episodes.length < minEpisodes) {
    return { scorer: null, fit: false, reason: `corpus too small: ${episodes.length} < ${minEpisodes} episodes at ${horizon} (analog shadow abstains)`, episodeCount: episodes.length, horizon };
  }
  const scorer = new AnalogScorer(opts.config);
  scorer.fit(episodes);
  return { scorer, fit: true, reason: `fitted on ${episodes.length} episodes at ${horizon}`, episodeCount: episodes.length, horizon };
}

// Cache the fitted scorer per process (refit at most every TTL) so the shadow cycle never refits on
// the hot side. The fit itself runs inside the bounded shadow queue (off the scanner path).
type G = typeof globalThis & { __optiscanAnalogScorer?: { at: number; result: FittedScorerResult } };
const TTL_MS = 15 * 60_000;
export function loadCachedAnalogScorer(getDb: () => LoadDb, opts: LoadScorerOpts = {}, nowMs: number = Date.now()): FittedScorerResult {
  const g = globalThis as G;
  if (g.__optiscanAnalogScorer && nowMs - g.__optiscanAnalogScorer.at < TTL_MS) return g.__optiscanAnalogScorer.result;
  let result: FittedScorerResult;
  try { result = loadFittedAnalogScorer(getDb(), opts); }
  catch (e: any) { result = { scorer: null, fit: false, reason: `load error (isolated): ${String(e?.message ?? e).slice(0, 100)}`, episodeCount: 0, horizon: opts.horizon ?? "1d" }; }
  g.__optiscanAnalogScorer = { at: nowMs, result };
  return result;
}
