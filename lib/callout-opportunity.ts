/**
 * callout-opportunity.ts — deterministic "was there ever a profit opportunity?"
 * grade for a callout, measured by peak favorable excursion.
 *
 * PURE: no I/O, no DB, no clock. Given the peak favorable % the engine recorded
 * for a filled trade — ideally over the contract's WHOLE life to expiration, not
 * just the held window — it answers a different question than realized P&L:
 *
 *   "Did the call/put ever go far enough green that there was a real chance to
 *    book a profit, at any point before expiration?"
 *
 * This is intentionally distinct from `trade-outcome.ts` (which grades the
 * REALIZED net P&L at the actual exit). A trade can be a realized LOSS (stopped
 * out early, or exited on time) yet still have had a genuine profit opportunity
 * if the contract later ran green before expiration. Tracking that separately is
 * how we measure whether the CALLOUT was right, independent of the paper exit.
 *
 * It NEVER fabricates: if no peak-favorable figure was recorded (unfilled, or no
 * marks), the grade is UNGRADABLE — never a guessed number.
 */
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const OPPORTUNITY_VERSION = 1;

export type OpportunityGrade = "HIT" | "NONE" | "UNGRADABLE";
/** Which window the peak-favorable figure was measured over. */
export type OpportunityWindow = "held" | "to_expiration" | "none";

export interface OpportunityConfig {
  /** Favorable % that counts as a real, bookable profit opportunity. */
  minFavorablePct: number;
}

/**
 * Options are leveraged, so a meaningful "chance to make money" is a sizeable
 * favorable move on the contract. Default 25%; fully env-overridable. Set lower
 * to count smaller green excursions, higher to require a bigger runner.
 */
export function opportunityConfig(env: NodeJS.ProcessEnv = process.env): OpportunityConfig {
  const n = Number(env.OPPORTUNITY_MIN_FAVORABLE_PCT);
  return { minFavorablePct: Number.isFinite(n) && n > 0 ? n : 25 };
}

export interface OpportunityInput {
  /** Only filled trades have an entry price to measure favorable excursion from. */
  filled: boolean;
  /**
   * Peak favorable % relative to the entry price. For options this should be the
   * lifetime peak (held window extended to expiration where sampling ran); for
   * stock, the held-window peak. Null when nothing was ever marked.
   */
  peakFavorablePct: number | null;
  /** Window the peak covers — drives the honesty of the "to expiration" claim. */
  window: OpportunityWindow;
}

export interface GradedOpportunity {
  opportunityGrade: OpportunityGrade;
  /** The peak favorable % actually used (rounded), or null when ungradable. */
  peakFavorablePct: number | null;
  /** Threshold applied. */
  thresholdPct: number;
  /** Window the peak was measured over. */
  window: OpportunityWindow;
  /** True only when the peak reached the threshold (a real chance to profit). */
  hadProfitOpportunity: boolean;
  reasons: string[];
  version: number;
}

/**
 * Grade whether a callout ever presented a bookable profit opportunity. Pure and
 * deterministic; grades independently of realized P&L so an early-stopped trade
 * that later ran green is still counted as an opportunity that existed.
 */
export function gradeOpportunity(input: OpportunityInput, env: NodeJS.ProcessEnv = process.env): GradedOpportunity {
  const threshold = opportunityConfig(env).minFavorablePct;
  const peak = isNum(input.peakFavorablePct) ? input.peakFavorablePct : null;

  if (!input.filled || peak == null) {
    return {
      opportunityGrade: "UNGRADABLE",
      peakFavorablePct: peak == null ? null : +peak.toFixed(2),
      thresholdPct: threshold,
      window: "none",
      hadProfitOpportunity: false,
      reasons: [!input.filled ? "not_filled — no entry to measure from" : "no peak-favorable recorded"],
      version: OPPORTUNITY_VERSION,
    };
  }

  const hit = peak >= threshold;
  const window: OpportunityWindow = input.window === "none" ? "held" : input.window;
  return {
    opportunityGrade: hit ? "HIT" : "NONE",
    peakFavorablePct: +peak.toFixed(2),
    thresholdPct: threshold,
    window,
    hadProfitOpportunity: hit,
    reasons: [
      hit
        ? `peak +${peak.toFixed(1)}% reached the ${threshold}% profit-opportunity threshold`
        : `peak +${peak.toFixed(1)}% never reached the ${threshold}% threshold`,
      window === "to_expiration" ? "measured to expiration" : "measured over the held window only",
    ],
    version: OPPORTUNITY_VERSION,
  };
}
