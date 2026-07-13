/**
 * model-experimental.ts — deterministic disclosure text for the three model
 * states (Phase 8). PURE. Produces exactly the mandated labels/warnings so
 * desktop, Discord, and the dashboard render the model state consistently.
 *
 * The three states:
 *   ACTIVE_VALIDATED                  — strict production thresholds met.
 *   ACTIVE_EXPERIMENTAL_RESEARCH_ONLY — a real two-class dataset exists but
 *                                       validated thresholds are not met.
 *   INACTIVE_NO_TRAINABLE_DATA        — not enough data; NO probability shown.
 *
 * Experimental probability is RESEARCH ONLY: it never creates ACTIONABLE, never
 * bypasses a gate, never enables bearish/live execution, and is never a guarantee.
 */
export const EXPERIMENTAL_LABEL = "EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY";
export const SETUP_SCORE_LABEL = "SETUP SCORE — NOT A PROBABILITY";

export type ModelStateName =
  | "ACTIVE_VALIDATED"
  | "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY"
  | "INACTIVE_NO_TRAINABLE_DATA";

export interface ExperimentalMeta {
  trainingSample: number;
  wins: number;
  losses: number;
  holdout: number;
  modelVersion: number | null;
  brier: number | null;
  ece: number | null;
  coverage: number | null;
  reasonNotValidated: string | null;
}

export interface ValidatedRequirements {
  minGraded: number;
  minWins: number;
  minLosses: number;
  minHoldout: number;
}

/** How much more data is needed to reach the VALIDATED tier (never negative). */
export function requiredForValidated(meta: ExperimentalMeta, req: ValidatedRequirements): {
  moreGraded: number; moreWins: number; moreLosses: number; moreHoldout: number;
} {
  const gap = (need: number, have: number) => Math.max(0, need - have);
  return {
    moreGraded: gap(req.minGraded, meta.trainingSample),
    moreWins: gap(req.minWins, meta.wins),
    moreLosses: gap(req.minLosses, meta.losses),
    moreHoldout: gap(req.minHoldout, meta.holdout),
  };
}

export interface ModelDisclosure {
  state: ModelStateName;
  headline: string | null;      // EXPERIMENTAL label, or null
  showProbability: boolean;
  fallbackLabel: string | null; // SETUP SCORE label when inactive
  lines: string[];              // sample/wins/losses/holdout/brier/calibration/coverage/reason or "need N more…"
}

/** Build the deterministic disclosure for a model state. */
export function describeModelState(
  state: ModelStateName,
  meta: ExperimentalMeta,
  req: ValidatedRequirements,
): ModelDisclosure {
  if (state === "ACTIVE_VALIDATED") {
    return {
      state,
      headline: null,
      showProbability: true,
      fallbackLabel: null,
      lines: [
        `Validated model v${meta.modelVersion ?? "?"}`,
        `sample ${meta.trainingSample} (${meta.wins}W/${meta.losses}L), holdout ${meta.holdout}`,
        `Brier ${meta.brier ?? "—"}, ECE ${meta.ece ?? "—"}, coverage ${meta.coverage == null ? "—" : Math.round(meta.coverage * 100) + "%"}`,
      ],
    };
  }
  if (state === "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY") {
    return {
      state,
      headline: EXPERIMENTAL_LABEL,
      showProbability: true,
      fallbackLabel: null,
      lines: [
        `Experimental model v${meta.modelVersion ?? "?"} — research only`,
        `sample ${meta.trainingSample} (${meta.wins}W/${meta.losses}L), holdout ${meta.holdout}`,
        `Brier ${meta.brier ?? "—"}, calibration ${meta.ece == null ? "—" : `ECE ${meta.ece}`}, coverage ${meta.coverage == null ? "—" : Math.round(meta.coverage * 100) + "%"}`,
        `Not validated because: ${meta.reasonNotValidated ?? "production thresholds not yet met"}`,
      ],
    };
  }
  // INACTIVE_NO_TRAINABLE_DATA
  const more = requiredForValidated(meta, req);
  return {
    state,
    headline: null,
    showProbability: false,
    fallbackLabel: SETUP_SCORE_LABEL,
    lines: [
      "No probability — insufficient trustworthy outcomes.",
      `Need ${more.moreGraded} more graded, ${more.moreWins} more wins, ${more.moreLosses} more losses, ${more.moreHoldout} more holdout for a validated model.`,
    ],
  };
}
