/**
 * retry-correction.ts — turn a REAL validation violation into the retry directive.
 *
 * ── The defect this exists to fix ──────────────────────────────────────────────
 *
 * Every structured AI job gets one paid retry. Until now that retry appended a single
 * fixed sentence: "your previous reply contained no usable structured payload". That
 * sentence is accurate for a parse failure and FALSE for every other kind — an
 * anti-fabrication rejection, a wrong field type, an over-long findings array all
 * arrive as perfectly well-formed payloads. The model was told the one thing that was
 * not wrong and never told the thing that was.
 *
 * The production evidence is unambiguous. Across 29 recorded VALIDATION_FAILED runs
 * every rejected token appears exactly TWICE — once for the first attempt and once for
 * the retry — with byte-identical surrounding context. "8%" eight times, "75%" four
 * times, "5 of 6" four times. The retry was not a second chance; it was the same
 * request asked again, and it cost the same money to fail the same way.
 *
 * ── What this module may and may not say ──────────────────────────────────────
 *
 * A correction may name WHAT was rejected and WHY. It may NOT supply a replacement
 * number, because a retry that hands the model a figure to use is a retry that
 * launders the validator into a suggestion box. The directives below therefore always
 * offer the same two exits — remove the claim, or cite a value that is already in the
 * registry — and never a third.
 *
 * NOTHING here loosens a validator. The same validator judges the retry, and a retry
 * that is still wrong still fails closed. This only stops the second attempt from being
 * uninformed.
 *
 * PURE: no I/O, no provider call, no database, no clock.
 */
// Type-only import: erased at compile time, so the cycle with provider.ts is not real.
import type { AiSchemaViolation } from "./provider.ts";

/** The generic directive, still correct for the failure it was written for. */
export const STRUCTURED_RETRY_INSTRUCTION =
  " CRITICAL RETRY: your previous reply contained no usable structured payload."
  + " Respond ONLY with the required structured JSON (call the provided tool when one is defined)."
  + " Do not emit reasoning, prose, markdown, or an empty object."
  + " If the evidence is insufficient, return the minimal valid payload (for example an empty list field) instead of nothing.";

const PREFIX = " CRITICAL RETRY — your previous reply was REJECTED by a deterministic validator.";
const CLOSE =
  " Return the full payload again with this corrected. Every other part of your previous"
  + " answer was acceptable; do not rewrite it wholesale, and do not add new claims.";

function short(v: unknown, max = 160): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return String(s ?? "").slice(0, max);
}

/**
 * Build the retry directive for one violation.
 *
 * Returns the generic instruction when the violation carries nothing specific enough
 * to correct — an honest "I do not know what you did wrong" beats a confident wrong
 * diagnosis, which is precisely the bug being fixed.
 */
export function buildRetryCorrection(violation: AiSchemaViolation | null | undefined): string {
  if (!violation) return STRUCTURED_RETRY_INSTRUCTION;

  // ── anti-fabrication: a number that is not in the evidence registry ──────────
  if (violation.stage === "anti_fabrication" && violation.token) {
    const type = violation.semanticType ?? "value";
    const ctx = violation.context ? ` It appeared here: "${short(violation.context, 180)}".` : "";
    const derived = type === "percentage" || type === "ratio" || type === "decimal";
    return PREFIX
      + ` It contained the ${type} "${violation.token}", which is NOT present in the structured`
      + ` quantitative evidence registry you were given.${ctx}`
      + (derived
        ? " You almost certainly DERIVED it — dividing, converting or summing two supplied figures."
          + " That is forbidden even when the arithmetic is correct: a quotient you computed is not"
          + " evidence, and the registry is the whole of what you may quote."
        : "")
      + ` Fix it in exactly one of two ways: DELETE the "${violation.token}" claim and state the`
      + " relationship in words with only the raw supplied figures, OR replace it with a value that"
      + " appears verbatim in the registry. Do not compute a substitute, and do not round a"
      + " registry value into a different number."
      + CLOSE;
  }

  // ── a hard cap on how many items a field may carry ──────────────────────────
  const cap = /at most (\d+) (\w+)/i.exec(violation.message ?? "");
  if (cap) {
    return PREFIX
      + ` You returned too many ${cap[2]}: the hard maximum is ${cap[1]}.`
      + ` Keep only the ${cap[1]} best-supported ${cap[2]} — the ones resting on the largest samples —`
      + ` and DELETE the rest. Do not merge several into one to fit the cap, and do not shorten`
      + ` them: returning fewer than ${cap[1]}, including none at all, is a correct answer.`
      + CLOSE;
  }

  // ── a field of the wrong shape ──────────────────────────────────────────────
  if (violation.stage === "schema" && violation.failingField) {
    const expected = violation.expectedValue ? String(violation.expectedValue) : null;
    const received = violation.receivedValue == null ? null : short(violation.receivedValue);
    return PREFIX
      + ` The field "${violation.failingField}" was rejected: ${short(violation.message, 200)}.`
      + (expected ? ` It MUST be ${expected}.` : "")
      + (received ? ` You sent: ${received}.` : "")
      + (expected === "array"
        ? " Send a JSON array of separate strings — not one joined string, not an object, not null."
          + " An empty array [] is valid and is the right answer when you have nothing to put in it."
        : "")
      + CLOSE;
  }

  // Something went wrong that this module cannot describe precisely. Say the true,
  // general thing rather than guessing at a specific cause.
  if (violation.message) {
    return PREFIX
      + ` The validator reported: ${short(violation.message, 240)}.`
      + " Correct exactly that and return the full payload again."
      + CLOSE;
  }

  return STRUCTURED_RETRY_INSTRUCTION;
}
