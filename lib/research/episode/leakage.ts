/**
 * lib/research/episode/leakage.ts — the structural anti-look-ahead guard (Phase A).
 * PURE. These validators are the enforcement layer that makes leakage HARD:
 *   • No Zone-A feature block may carry an asOfMs later than the decision time t0.
 *   • The stored max_feature_as_of_ms must equal the true max and be <= t0.
 *   • No Zone-B label may be computed from data at/<= t0 (labelAsOfMs must be > t0).
 * The store (episode/store.ts) refuses to persist anything that fails these — a leaky
 * episode never enters the memory.
 */
import { maxFeatureAsOf, type Episode, type EpisodeLabel } from "./schema.ts";

export interface LeakageVerdict {
  ok: boolean;
  violations: string[];
}

/** Validate a Zone-A Episode: every feature block is at/<= t0, and the stored guard is honest. */
export function validateEpisodeNoLookahead(ep: Episode): LeakageVerdict {
  const v: string[] = [];
  if (!Number.isFinite(ep.t0Ms) || ep.t0Ms <= 0) v.push("t0Ms is not a valid decision time");
  for (const [name, block] of Object.entries(ep.blocks)) {
    if (!block) continue;
    if (!Number.isFinite(block.asOfMs)) { v.push(`block ${name} has no asOfMs`); continue; }
    if (block.asOfMs > ep.t0Ms) v.push(`block ${name} asOfMs ${block.asOfMs} > t0Ms ${ep.t0Ms} (look-ahead)`);
  }
  const trueMax = maxFeatureAsOf(ep);
  if (trueMax > ep.t0Ms) v.push(`max feature asOf ${trueMax} > t0Ms ${ep.t0Ms} (look-ahead)`);
  return { ok: v.length === 0, violations: v };
}

/** The value that must be stored in setup_episodes.max_feature_as_of_ms. */
export function leakageGuardValue(ep: Episode): number {
  return maxFeatureAsOf(ep);
}

/** Validate a Zone-B label was computed strictly forward of the decision time. */
export function validateLabelForward(label: Pick<EpisodeLabel, "labelAsOfMs">, t0Ms: number): LeakageVerdict {
  const v: string[] = [];
  if (!Number.isFinite(label.labelAsOfMs)) v.push("label has no labelAsOfMs");
  else if (label.labelAsOfMs <= t0Ms) v.push(`labelAsOfMs ${label.labelAsOfMs} <= t0Ms ${t0Ms} (a label must use only forward data)`);
  return { ok: v.length === 0, violations: v };
}

/** Bars are forward-only iff every bar timestamp is strictly after t0. Used by labelers. */
export function assertForwardBars(bars: { t: number }[], t0Ms: number): void {
  for (const b of bars) if (b.t <= t0Ms) throw new Error(`forward label received a bar at t=${b.t} <= t0Ms=${t0Ms} (look-ahead)`);
}
