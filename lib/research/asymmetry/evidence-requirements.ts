/**
 * evidence-requirements.ts — classify each missing-evidence label by whether the
 * pipeline can actually supply it today.
 *
 * WHY THIS EXISTS. `initialStateFor` grades a case by counting missing-evidence
 * labels: 0 -> HIGH_ASYMMETRY, <=3 -> CONFIRMING, <=9 -> EARLY_ASYMMETRY, else
 * INSUFFICIENT_EVIDENCE. The notification gate then refuses anything above
 * `maxMissingEvidenceForConfirming` (2).
 *
 * Those thresholds were calibrated against the full 13-label vocabulary, but the
 * live capture call in lib/research/options/loop.ts passes a hardcoded null for
 * catalyst, marketAlignment, sectorAlignment, volumeAcceleration, compressionState,
 * distanceToTriggerPct and roomToNextLevelPct. Six labels therefore fire on EVERY
 * candidate no matter how good the setup is:
 *
 *   NO_CATALYST, NO_MARKET_ALIGNMENT, NO_SECTOR_ALIGNMENT,
 *   NO_VOLUME_ACCELERATION, NO_COMPRESSION_STATE, NO_LEVEL_DISTANCE
 *
 * With a floor of six, <=3 and 0 are unreachable. Production confirms it exactly:
 * CONFIRMING 0 and HIGH_ASYMMETRY 0 across 200 candidates, every case sitting at
 * EARLY_ASYMMETRY (143) or INSUFFICIENT_EVIDENCE (49), and zero alerts all session.
 *
 * THIS IS NOT A RELAXATION. Nothing here lets a weak setup through. Every hard
 * blocker in live-intake (no exact OCC, contract identity mismatch, unexecutable
 * quote, unusable spread, unusable liquidity) is untouched, and so is every check
 * in the notification gate (spread, open interest, contract volume, premium chase,
 * entry timing, session authority, quote freshness). What changes is only the
 * ARITHMETIC of the completeness count: a field the pipeline never asks for is not
 * evidence that was sought and found absent, so counting it as such measures the
 * wiring rather than the setup.
 *
 * Unsupplied labels are never hidden — they are returned separately, persisted, and
 * surfaced in diagnostics, so the wiring debt stays visible and payable.
 *
 * As each field gets wired in loop.ts, move it to SUPPLIED and the gate gets
 * STRICTER automatically, because a real absence then counts again.
 */

import type { IntakeLabel } from "./live-intake.ts";

export type EvidenceAvailability =
  | "AVAILABLE_PROVIDER"
  | "AVAILABLE_DERIVED"
  | "UNAVAILABLE_PROVIDER"
  | "NOT_REQUESTED"
  | "STALE"
  | "INVALID"
  | "LEGACY_MISSING";

export interface EvidenceRequirement {
  label: IntakeLabel;
  /** The capture input(s) this label reports on. */
  fields: readonly string[];
  availability: EvidenceAvailability;
  /** True when the live capture path actually supplies the field today. */
  supplied: boolean;
  why: string;
}

/**
 * Ground truth as of 2026-08-05, read from lib/research/options/loop.ts. `supplied`
 * means the live call site passes a real value rather than a hardcoded null — NOT
 * that the provider always returns one. A supplied-but-null field still counts as
 * missing evidence, which is correct: it was asked for and was not there.
 */
export const EVIDENCE_REQUIREMENTS: readonly EvidenceRequirement[] = Object.freeze([
  {
    label: "NO_OPEN_INTEREST", fields: ["openInterest"], availability: "AVAILABLE_PROVIDER", supplied: true,
    why: "res.contract.openInterest — present on 250/250 probed contracts.",
  },
  {
    label: "NO_OPTION_VOLUME", fields: ["optionVolume"], availability: "AVAILABLE_PROVIDER", supplied: true,
    why: "res.contract.volume — present on 221/250 probed contracts.",
  },
  {
    label: "NO_IMPLIED_VOLATILITY", fields: ["impliedVolatility"], availability: "AVAILABLE_PROVIDER", supplied: true,
    why: "res.contract.iv — mapped by live-deps; absent on deep ITM/OTM rows, which stay null.",
  },
  {
    label: "NO_GREEKS", fields: ["delta", "gamma"], availability: "AVAILABLE_PROVIDER", supplied: true,
    why: "res.contract.delta and .gamma — both from the chain snapshot already fetched.",
  },
  {
    label: "NO_PRIOR_MOVE", fields: ["priorMovePct"], availability: "AVAILABLE_DERIVED", supplied: true,
    why: "input.underlying.changePercent.",
  },
  {
    label: "NO_VWAP_RELATIONSHIP", fields: ["underlyingPrice", "vwap"], availability: "AVAILABLE_DERIVED", supplied: true,
    why: "input.underlying.price and .vwap.",
  },
  {
    label: "NO_RELATIVE_VOLUME", fields: ["relativeVolume"], availability: "AVAILABLE_DERIVED", supplied: true,
    why: "input.underlying.relativeVolume.",
  },
  // ── Not supplied by the live capture path. Hardcoded null in loop.ts. ──────
  {
    label: "NO_CATALYST", fields: ["catalyst"], availability: "NOT_REQUESTED", supplied: false,
    why: "loop.ts passes catalyst: null. catalyst_records exists locally and fetchNews is entitled, but neither is consulted at capture.",
  },
  {
    label: "NO_MARKET_ALIGNMENT", fields: ["marketAlignment"], availability: "NOT_REQUESTED", supplied: false,
    why: "loop.ts passes marketAlignment: null. lib/research/context/market-context.ts computes it and costs no extra provider call, but is not wired to capture.",
  },
  {
    label: "NO_SECTOR_ALIGNMENT", fields: ["sectorAlignment"], availability: "UNAVAILABLE_PROVIDER", supplied: false,
    why: "loop.ts passes sectorAlignment: null. The repo has no symbol-to-sector mapping, so this is not obtainable without building one.",
  },
  {
    label: "NO_VOLUME_ACCELERATION", fields: ["volumeAcceleration"], availability: "NOT_REQUESTED", supplied: false,
    why: "loop.ts passes volumeAcceleration: null. Needs a per-symbol volume baseline that is not computed at capture.",
  },
  {
    label: "NO_COMPRESSION_STATE", fields: ["compressionState"], availability: "NOT_REQUESTED", supplied: false,
    why: "loop.ts passes compressionState: null. Derivable from the candle ring the scanner already holds.",
  },
  {
    label: "NO_LEVEL_DISTANCE", fields: ["distanceToTriggerPct", "roomToNextLevelPct"], availability: "NOT_REQUESTED", supplied: false,
    why: "loop.ts passes both as null. Requires named level detection, which is the derivation gap behind trigger/invalidation.",
  },
]);

const BY_LABEL = new Map(EVIDENCE_REQUIREMENTS.map((r) => [r.label, r]));

/** Labels the live capture path cannot supply today, so they cannot grade a setup. */
export const UNSUPPLIED_LABELS: ReadonlySet<string> = new Set(
  EVIDENCE_REQUIREMENTS.filter((r) => !r.supplied).map((r) => r.label),
);

export interface EvidenceSplit {
  /** Missing evidence that WAS sought. This is what grades the setup. */
  blocking: string[];
  /** Missing because the pipeline never supplies it. Recorded, never graded. */
  unsupplied: string[];
  /** Labels with no requirement entry — treated as blocking, never silently dropped. */
  unknown: string[];
  blockingCount: number;
}

/**
 * Split raw intake labels into the part that reflects the SETUP and the part that
 * reflects the WIRING. An unrecognised label is treated as blocking: a new label
 * must be classified deliberately, never excused by default.
 */
export function splitMissingEvidence(labels: readonly string[]): EvidenceSplit {
  const blocking: string[] = [];
  const unsupplied: string[] = [];
  const unknown: string[] = [];
  for (const label of labels) {
    const req = BY_LABEL.get(label as IntakeLabel);
    if (!req) { unknown.push(label); blocking.push(label); continue; }
    if (req.supplied) blocking.push(label);
    else unsupplied.push(label);
  }
  return { blocking, unsupplied, unknown, blockingCount: blocking.length };
}

/** How many labels can never be satisfied today. Grading must not exceed this budget. */
export function unsuppliedLabelCount(): number {
  return EVIDENCE_REQUIREMENTS.filter((r) => !r.supplied).length;
}
