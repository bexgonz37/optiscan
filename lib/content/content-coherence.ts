/**
 * content-coherence.ts — does this draft say something a person can actually
 * believe, given the evidence it was built from?
 *
 * The existing guards each answer a different question and all of them were
 * passing on copy that was plainly wrong:
 *
 *   - `validateSocialDraftLanguage` blocks live-action phrasing ("buy now").
 *   - `claim-integrity` blocks unverified PERFORMANCE claims.
 *   - `renderLine` drops a line whose placeholder is missing.
 *
 * None of them compares the copy to the position it describes. Production on
 * 2026-08-19 therefore shipped, to the owner's review queue:
 *
 *     "$NVDA wasn't on my radar 15 minutes ago. Now it is.
 *      Here's why:
 *      • Large call buying detected
 *      Watching the 2026-08-21 $220 PUT closely."
 *
 * Call-side flow offered as the reason for a PUT. That line survived because it
 * is a hardcoded literal with no placeholder in it, so the one mechanism that
 * could have dropped it — a missing variable — had nothing to catch. Two of the
 * four drafts citing call buying were on PUTs.
 *
 * WHAT THIS CHECKS, AND WHY EACH ONE IS HERE
 *
 * Every rule below corresponds to something observed in the production drafts
 * table, not to a hypothetical. A rule is a REJECT when the copy would mislead
 * a reader about a position or a result, and a REWRITE_REQUIRED when the copy is
 * merely unpublishable prose. Nothing here is a style opinion.
 *
 * PURE. No I/O, no clock, no env.
 */

export type CoherenceSeverity = "REJECT" | "REWRITE_REQUIRED";

export interface CoherenceViolation {
  rule: string;
  severity: CoherenceSeverity;
  /** Plain English, written for the owner reading the queue — not a log line. */
  detail: string;
}

export interface CoherenceInput {
  text: string;
  /** CALL | PUT | "" — the side of the contract the draft is about. */
  optionType?: string | null;
  /** BULLISH | BEARISH | "" — the tracked direction. */
  direction?: string | null;
  /** Whether a verified claim packet backs any performance number in the copy. */
  claimVerified?: boolean;
  /**
   * True when the number in the copy is a peak/MFE rather than a realized
   * result. MFE described as "made" is the single most damaging inaccuracy this
   * system can publish, because it is the one a reader cannot detect.
   */
  isMaxExcursion?: boolean;
  /** True when the tracked result came from the owner-only validation lane. */
  ownerValidationOnly?: boolean;
}

export interface CoherenceVerdict {
  coherent: boolean;
  violations: CoherenceViolation[];
}

/** Copy asserting call-side buying/flow. */
const CALL_SIDE_CLAIM = /\b(call (buying|flow|sweeps?|volume)|calls? (being )?bought|bullish (flow|sweeps?))\b/i;
/** Copy asserting put-side buying/flow. */
const PUT_SIDE_CLAIM = /\b(put (buying|flow|sweeps?|volume)|puts? (being )?bought|bearish (flow|sweeps?))\b/i;

/**
 * Backend vocabulary that must never reach human copy. These are real strings
 * from this codebase, not a generic profanity list.
 */
const BACKEND_LABELS: Array<{ re: RegExp; label: string }> = [
  { re: /UNKNOWN_LEGACY_VERSION/, label: "UNKNOWN_LEGACY_VERSION" },
  { re: /OWNER_VALIDATION_PAPER/, label: "OWNER_VALIDATION_PAPER" },
  { re: /DELIVERED_ALERT_PAPER/, label: "DELIVERED_ALERT_PAPER" },
  { re: /RESEARCH_ONLY/, label: "RESEARCH_ONLY" },
  { re: /NON_ACTIONABLE_RESEARCH/, label: "NON_ACTIONABLE_RESEARCH" },
  { re: /INSUFFICIENT_EVIDENCE/, label: "INSUFFICIENT_EVIDENCE" },
  { re: /case_json/, label: "case_json" },
  { re: /\bfingerprint\b/i, label: "fingerprint" },
  { re: /\bopportunity_case_id\b/i, label: "opportunity_case_id" },
];

/**
 * Claims that attribute a result to subscribers or members. Before subscriber
 * readiness there is no subscriber evidence of any kind, so these are false by
 * construction — not merely unsupported.
 */
const SUBSCRIBER_ATTRIBUTION = [
  /\bsubscribers?\s+(made|caught|banked|got|took)\b/i,
  /\bmembers?\s+(made|caught|banked|got|took)\b/i,
  /\bthe\s+(group|community|server)\s+(made|caught|banked)\b/i,
  /\bmy\s+subscribers?\b/i,
];

/** Realized-result verbs. Applying one of these to a peak is the MFE lie. */
const REALIZED_RESULT = /\b(made|banked|booked|locked in|took (home|profit)|closed (for|at)|realized)\b/i;

const PERCENT_CLAIM = /([+-]?\d+(?:\.\d+)?)\s*%/;

const norm = (s: unknown) => String(s ?? "").trim().toUpperCase();

/**
 * Validate one rendered draft against the position and evidence it describes.
 *
 * Returns every violation rather than the first, because the owner reading a
 * rejection wants to know what is wrong with the draft, not what is wrong with
 * its first line.
 */
export function validateContentCoherence(input: CoherenceInput): CoherenceVerdict {
  const text = String(input.text ?? "");
  const violations: CoherenceViolation[] = [];
  const side = norm(input.optionType);
  const direction = norm(input.direction);

  // ── 1. Directional contradiction ──────────────────────────────────────────
  // The evidence cited must point the same way as the contract named. This is
  // the NVDA/AMD defect: a hardcoded "Large call buying detected" bullet above
  // a PUT.
  const bearishPosition = side === "PUT" || direction === "BEARISH" || direction === "DOWN";
  const bullishPosition = side === "CALL" || direction === "BULLISH" || direction === "UP";
  if (bearishPosition && CALL_SIDE_CLAIM.test(text)) {
    violations.push({
      rule: "DIRECTIONAL_CONTRADICTION",
      severity: "REJECT",
      detail: "The copy cites call-side buying as the reason, but the tracked contract is a PUT. "
        + "Either explain the contradiction accurately or drop that framing.",
    });
  }
  if (bullishPosition && PUT_SIDE_CLAIM.test(text)) {
    violations.push({
      rule: "DIRECTIONAL_CONTRADICTION",
      severity: "REJECT",
      detail: "The copy cites put-side buying as the reason, but the tracked contract is a CALL.",
    });
  }

  // ── 2. MFE described as a realized return ─────────────────────────────────
  if (input.isMaxExcursion && REALIZED_RESULT.test(text) && PERCENT_CLAIM.test(text)) {
    violations.push({
      rule: "MFE_AS_REALIZED",
      severity: "REJECT",
      detail: "This number is the peak the position reached, not what it closed at. "
        + "Copy that says it was 'made' or 'banked' claims a result that never happened.",
    });
  }

  // ── 3. Owner-only result presented as a subscriber result ─────────────────
  for (const re of SUBSCRIBER_ATTRIBUTION) {
    if (re.test(text)) {
      violations.push({
        rule: "SUBSCRIBER_CLAIM_WITHOUT_SUBSCRIBERS",
        severity: "REJECT",
        detail: "The copy attributes a result to subscribers or members. No subscriber delivery "
          + "evidence exists, so this is not something the record can support.",
      });
      break;
    }
  }
  if (input.ownerValidationOnly && /\b(we|our members|the room)\b.*\b(caught|made|banked)\b/i.test(text)) {
    violations.push({
      rule: "OWNER_RESULT_AS_GROUP_RESULT",
      severity: "REJECT",
      detail: "This result came from the owner-only validation lane. Presenting it as a group "
        + "result overstates who received it.",
    });
  }

  // ── 4. Unsupported performance number ─────────────────────────────────────
  if (input.claimVerified === false && PERCENT_CLAIM.test(text) && REALIZED_RESULT.test(text)) {
    violations.push({
      rule: "UNSUPPORTED_PERFORMANCE_CLAIM",
      severity: "REJECT",
      detail: "A realized performance number appears in the copy with no verified claim behind it.",
    });
  }

  // ── 5. Backend vocabulary ─────────────────────────────────────────────────
  for (const { re, label } of BACKEND_LABELS) {
    if (re.test(text)) {
      violations.push({
        rule: "BACKEND_LABEL_IN_COPY",
        severity: "REWRITE_REQUIRED",
        detail: `"${label}" is an internal label. It means nothing to a reader and reads as a leak.`,
      });
    }
  }

  // ── 6. Prose defects observed in production ───────────────────────────────
  // "…bearish structure intact.." — the template ends in a period and the
  // interpolated thesis already carried one.
  if (/[.!?]{2,}/.test(text.replace(/\.\.\./g, ""))) {
    violations.push({
      rule: "DOUBLE_PUNCTUATION",
      severity: "REWRITE_REQUIRED",
      detail: "Doubled sentence punctuation. Usually an interpolated value that already ended in a period.",
    });
  }
  // A SCREAMING_SNAKE token that is not a cashtag or hashtag is a backend
  // constant that escaped, whether or not it is on the known list above.
  const snake = text.match(/(?<![$#\w])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}/g);
  if (snake && snake.length) {
    const known = new Set(violations.filter((v) => v.rule === "BACKEND_LABEL_IN_COPY").map((v) => v.detail));
    if (!known.size) {
      violations.push({
        rule: "BACKEND_LABEL_IN_COPY",
        severity: "REWRITE_REQUIRED",
        detail: `"${snake[0]}" is an internal constant, not language.`,
      });
    }
  }

  return { coherent: violations.length === 0, violations };
}

/** True when nothing found would mislead a reader. Rewrite-level issues still fail. */
export function isPublishableCopy(input: CoherenceInput): boolean {
  return validateContentCoherence(input).coherent;
}
