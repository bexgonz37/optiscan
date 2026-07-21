/**
 * lib/research/eval/types.ts — shared evaluation contracts (Analog Engine, Phase B).
 * PURE types. A Scorer is anything that maps decision-time features → a win probability;
 * baselines and the future analog engine both implement it, so they compete on equal terms.
 */

/** Decision-time features ONLY (Zone A). The harness never hands a scorer an outcome. */
export interface ScoreInput {
  id: string;
  t0Ms: number;
  features: Record<string, number>;
}

/** An episode paired with its realized forward outcome + the time window that outcome
 *  occupies (used for purge/embargo so a training label never overlaps the test period). */
export interface LabeledEpisode {
  input: ScoreInput;
  win: boolean;
  outcome: number;      // signed realized outcome (e.g. return %)
  labelStartMs: number; // = t0Ms
  labelEndMs: number;   // when the forward label finished resolving
}

/** A recommender under test. `fit` is optional (baselines are stateless); it may see ONLY
 *  the training episodes it is given — the harness enforces the train/test boundary. */
export interface Scorer {
  name: string;
  fit?(train: LabeledEpisode[]): void;
  score(input: ScoreInput): number; // win probability in [0,1]
}
