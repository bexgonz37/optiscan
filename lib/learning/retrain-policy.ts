/**
 * learning/retrain-policy.ts — bounded, deterministic retraining policy (Phase 7).
 * PURE. Decides IF a retraining attempt is allowed. It never changes thresholds,
 * risk limits, or any trading rule — it only gates when the model registry may
 * train a challenger. Every attempt (allowed or skipped) is recorded by the store.
 */
export interface RetrainPolicy {
  minNewOutcomes: number;
  minHoursBetween: number;
  minCoverage: number;
}

export function defaultRetrainPolicy(env: NodeJS.ProcessEnv = process.env): RetrainPolicy {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minNewOutcomes: n(env.LEARN_MIN_NEW_OUTCOMES, 25),
    minHoursBetween: n(env.LEARN_MIN_HOURS_BETWEEN, 24),
    minCoverage: n(env.LEARN_MIN_COVERAGE, 0.95),
  };
}

export interface RetrainState {
  currentWatermark: number;
  lastTrainedWatermark: number;
  lastAttemptMs: number | null;
  newGradedSinceWatermark: number;
  wins: number;
  losses: number;
  coverage: number;
  nowMs: number;
}

export interface RetrainDecision {
  retrain: boolean;
  reasons: string[];
}

/** Decide whether a retraining attempt is permitted right now. */
export function shouldRetrain(state: RetrainState, policy: RetrainPolicy = defaultRetrainPolicy()): RetrainDecision {
  const reasons: string[] = [];

  if (state.currentWatermark <= state.lastTrainedWatermark) {
    reasons.push("no new outcomes since the last training watermark");
  }
  if (state.newGradedSinceWatermark < policy.minNewOutcomes) {
    reasons.push(`need ${policy.minNewOutcomes} new graded outcomes (have ${state.newGradedSinceWatermark})`);
  }
  if (state.lastAttemptMs != null) {
    const hours = (state.nowMs - state.lastAttemptMs) / 3_600_000;
    if (hours < policy.minHoursBetween) reasons.push(`only ${hours.toFixed(1)}h since last attempt (min ${policy.minHoursBetween}h)`);
  }
  if (state.wins < 1 || state.losses < 1) {
    reasons.push("both outcome classes must be present");
  }
  if (state.coverage < policy.minCoverage) {
    reasons.push(`feature coverage ${Math.round(state.coverage * 100)}% < ${Math.round(policy.minCoverage * 100)}% required`);
  }

  return { retrain: reasons.length === 0, reasons };
}
