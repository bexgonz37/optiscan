/**
 * failure-cause.ts — what a losing trade's report card is ALLOWED to claim.
 *
 * ## The defect this exists to fix
 *
 * `WHY_THIS_FAILED` templates rendered `{{reason}}`, and `varsForEventRow` fills
 * `reason` from `firstOf(row.original_thesis_json)` — the thesis the trade was
 * ENTERED on. So the reason to buy was reprinted as the reason it lost.
 *
 * Verified in production at `cb1fc98`, draft `cd_ew04f1` / event `ce_1k0xr40`:
 *
 *     originalThesis: ["Lower high continuation with bearish structure intact."]
 *     strategyKey:    "lower_high_continuation"
 *     optionType:     PUT      direction: bearish
 *     returnPercent:  -48.5714 maxReturnPercent: 55.5556
 *
 *     draft_text: "Why $AAPL failed:
 *                  • Lower high continuation with bearish structure intact.
 *                  Closed -48.6%. Lessons > hype."
 *
 * That is not merely unsupported, it is inverted: a bearish structure staying
 * intact is the condition under which that PUT would have WON. The sibling
 * template produced "the setup broke when Lower high continuation with bearish
 * structure intact.." — a sentence asserting the setup broke by holding.
 *
 * And the row carried real evidence the template threw away: the position was
 * up 55.6% at its best mark and closed -48.6%. The cause was PROFIT_GIVEN_BACK,
 * which is arithmetic on two persisted marks, not interpretation.
 *
 * ## The rule
 *
 * A cause may be stated as fact ONLY when persisted evidence establishes it.
 * Everything else says so plainly. An observed market condition is never
 * promoted to a cause, and the entry thesis is never a cause at all — it is
 * labelled as the entry thesis or omitted.
 */

export type FailureCauseCode =
  | "BAD_DIRECTION"
  | "WEAK_SETUP"
  | "FALSE_BREAKOUT"
  | "ENTRY_TOO_LATE"
  | "PREMIUM_CHASE"
  | "WRONG_EXPIRATION"
  | "WRONG_STRIKE"
  | "WRONG_DTE"
  | "CONTRACT_SELECTION_FAILURE"
  | "WIDE_SPREAD"
  | "LOW_LIQUIDITY"
  | "THESIS_FAILED_IMMEDIATELY"
  | "PROFIT_GIVEN_BACK"
  | "EXIT_TOO_SLOW"
  | "STOP_TOO_WIDE"
  | "PROVIDER_BUDGET_DELAY"
  | "SCHEDULER_DELAY"
  | "DELIVERY_DELAY"
  | "VALID_UNAVOIDABLE_LOSS"
  | "INSUFFICIENT_EVIDENCE";

/**
 * How strongly the evidence supports the statement. Only VERIFIED_PRIMARY_CAUSE
 * may be phrased as fact.
 */
export type CauseGrade =
  | "VERIFIED_PRIMARY_CAUSE"
  | "CONTRIBUTING_FACTOR"
  | "OBSERVED_MARKET_CONDITION"
  | "AI_INTERPRETATION"
  | "TEMPLATE_LANGUAGE"
  | "INSUFFICIENT_EVIDENCE";

export interface FailureCause {
  code: FailureCauseCode;
  grade: CauseGrade;
  /** Owner-facing sentence. Safe to render verbatim. */
  statement: string;
  /** Which persisted fields established it. Empty when nothing did. */
  evidenceFields: string[];
  /** True only when `statement` may be presented as an established cause. */
  provable: boolean;
}

export interface FailureEvidence {
  returnPercent: number | null;
  maxReturnPercent: number | null;
  frozenEntry: number | null;
  currentMark: number | null;
  optionType?: string | null;
  direction?: string | null;
}

function fmtPct(x: number): string {
  return `${x > 0 ? "+" : ""}${Number.isInteger(x) ? x : x.toFixed(1)}%`;
}

/**
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious one-liner
 * turns "no maximum mark was ever recorded" into "the best mark was 0%" — which
 * reads as THESIS_FAILED_IMMEDIATELY and states an unproven cause as fact. That
 * is the same null→zero coercion this codebase is auditing elsewhere; absence is
 * kept as absence here.
 */
function num(x: unknown): number | null {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Minimum peak gain that makes "gave back a profit" the PRIMARY story rather
 * than noise around entry. Below this the position never had a profit worth
 * describing, so the loss is not explained by giving one back.
 */
function giveBackThresholdPct(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CONTENT_PROFIT_GIVEN_BACK_MIN_PCT);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

const INSUFFICIENT: Omit<FailureCause, "statement"> = {
  code: "INSUFFICIENT_EVIDENCE",
  grade: "INSUFFICIENT_EVIDENCE",
  evidenceFields: [],
  provable: false,
};

/**
 * Derive the failure cause from persisted evidence alone.
 *
 * Deliberately conservative. Only two causes are derivable from what a content
 * event actually stores, and both are arithmetic on recorded marks:
 *
 *   PROFIT_GIVEN_BACK          peak mark was well above entry, close was below
 *   THESIS_FAILED_IMMEDIATELY  the position never traded above entry
 *
 * Direction quality, entry timing, spread, liquidity and contract selection are
 * NOT derived here. The evidence for them lives in the alert and asymmetry
 * records, not on this row, and inventing them from a strategy name is exactly
 * the defect this module replaces. They return INSUFFICIENT_EVIDENCE until the
 * fields are wired, and the wording stays truthful in the meantime.
 */
export function deriveFailureCause(
  ev: FailureEvidence,
  env: NodeJS.ProcessEnv = process.env,
): FailureCause {
  const ret = num(ev.returnPercent);
  const max = num(ev.maxReturnPercent);

  if (ret == null) {
    return { ...INSUFFICIENT, statement: "The result is recorded, but current evidence is insufficient to attribute the outcome." };
  }
  if (ret >= 0) {
    return { ...INSUFFICIENT, statement: "This outcome was not a loss." };
  }

  const lossText = `The trade closed ${fmtPct(ret)}.`;

  if (max != null && max >= giveBackThresholdPct(env)) {
    return {
      code: "PROFIT_GIVEN_BACK",
      grade: "VERIFIED_PRIMARY_CAUSE",
      provable: true,
      evidenceFields: ["maxReturnPercent", "returnPercent"],
      statement:
        `The position reached ${fmtPct(max)} at its best recorded mark and closed ${fmtPct(ret)}. ` +
        `The loss came from giving back an open profit, not from the direction being wrong.`,
    };
  }

  if (max != null && max <= 0) {
    return {
      code: "THESIS_FAILED_IMMEDIATELY",
      grade: "VERIFIED_PRIMARY_CAUSE",
      provable: true,
      evidenceFields: ["maxReturnPercent", "returnPercent"],
      statement:
        `The position never traded above its entry — the best recorded mark was ${fmtPct(max)} — and closed ${fmtPct(ret)}. ` +
        `The thesis failed from the start rather than deteriorating later.`,
    };
  }

  return {
    ...INSUFFICIENT,
    statement:
      `${lossText} A verified root cause has not yet been established. ` +
      `Current evidence is insufficient to attribute the loss to direction, entry timing, contract selection, or exit behaviour.`,
  };
}

/**
 * Phrases that describe a market CONDITION. None states a mechanism by which an
 * option lost value, so none may stand alone as a cause. They are legitimate as
 * labelled observations or as the entry thesis — never after "why this failed".
 */
const CONDITION_ONLY_PHRASES: readonly RegExp[] = [
  /\bstructure\s+intact\b/i,
  /\bvwap\s+reject/i,
  /\bsellers\s+kept\s+control\b/i,
  /\bbuyers\s+kept\s+control\b/i,
  /\blower\s+high\s+continuation\b/i,
  /\bhigher\s+low\s+continuation\b/i,
];

export type GroundingVerdict =
  | { ok: true }
  | { ok: false; violation: "CONTRADICTORY_FAILURE_EXPLANATION" | "UNSUPPORTED_FAILURE_EXPLANATION"; detail: string };

/**
 * Reject a failure draft whose explanation is not grounded.
 *
 * Two distinct violations:
 *
 *  - CONTRADICTORY: the text asserts the directional thesis held while the
 *    matching option lost. A bearish structure that stayed intact is the
 *    condition under which a PUT wins, so it cannot explain a PUT's loss.
 *  - UNSUPPORTED: the explanation is a bare market condition with no mechanism.
 *
 * Applied to the FAILURE-EXPLANATION segment only. A draft may still quote the
 * entry thesis when it is explicitly labelled as such.
 */
export function validateFailureExplanation(
  explanation: string,
  ctx: { optionType?: string | null } = {},
): GroundingVerdict {
  const text = String(explanation ?? "");
  if (!text.trim()) return { ok: true };

  const type = String(ctx.optionType ?? "").toUpperCase();
  const heldIntact = /\b(intact|continuation|held|kept)\b/i.test(text);
  const bearish = /\b(bearish|lower high|breakdown|sellers)\b/i.test(text);
  const bullish = /\b(bullish|higher low|breakout|buyers)\b/i.test(text);

  if (heldIntact && type === "PUT" && bearish) {
    return {
      ok: false,
      violation: "CONTRADICTORY_FAILURE_EXPLANATION",
      detail: "a bearish condition that stayed intact would have made this PUT profitable, so it cannot explain the loss",
    };
  }
  if (heldIntact && type === "CALL" && bullish) {
    return {
      ok: false,
      violation: "CONTRADICTORY_FAILURE_EXPLANATION",
      detail: "a bullish condition that stayed intact would have made this CALL profitable, so it cannot explain the loss",
    };
  }
  for (const re of CONDITION_ONLY_PHRASES) {
    if (re.test(text)) {
      return {
        ok: false,
        violation: "UNSUPPORTED_FAILURE_EXPLANATION",
        detail: "the explanation states a market condition without establishing how it caused the option to lose value",
      };
    }
  }
  return { ok: true };
}
