/**
 * High-Asymmetry Radar — historical example import contract. PURE.
 *
 * Known "this one went up 800%" examples are valuable leads and worthless
 * evidence. This module lets such an example be SUBMITTED without ever letting
 * it be BELIEVED.
 *
 * The separation is structural, not a rule someone has to remember:
 *
 *  - `HistoricalExampleReference` — the screenshot, article, post, or broker
 *    statement — has NO numeric price, return, or quote field at all. There is
 *    no shape in which a screenshot could carry a price into the replay, so no
 *    code path can be written that reads a return off one.
 *  - `quoteEvidence` is the only channel that carries prices, and every quote
 *    in it is revalidated by the same `validateExecutableQuote` used everywhere
 *    else. A reference cannot substitute for it.
 *  - A submission with references but no quote evidence is retained as
 *    `PENDING_QUOTE_EVIDENCE`: a lead to go verify, never a graded outcome.
 *
 * Nothing here writes to a database. Accepted submissions become ordinary
 * `AsymmetryCandidateInput`s and are graded by exactly the same engine as
 * persisted candidates, with no special case and no relaxed rule.
 */
import { verifyOccIdentity, type AsymmetryQuoteObservation } from "./evidence.ts";
import { DAY_RE } from "./db-read.ts";
import type { AsymmetryCandidateInput } from "./report.ts";

export type ReferenceKind = "SCREENSHOT" | "ARTICLE" | "SOCIAL_POST" | "BROKER_STATEMENT" | "CHART_IMAGE" | "OTHER";

/**
 * Provenance for a human-supplied example.
 *
 * Deliberately carries NO price, return, percentage, bid, ask, or quote field.
 * A reference can say where something was seen; it can never say what it was
 * worth. `claimedNote` is free text kept for the human reader and is never
 * parsed for numbers by any code in the radar.
 */
export interface HistoricalExampleReference {
  kind: ReferenceKind;
  /** Where the reference lives. Never fetched by this module. */
  uri?: string | null;
  capturedAtMs?: number | null;
  /** Human note. Opaque to the radar — never parsed, never graded. */
  claimedNote?: string | null;
}

export interface HistoricalExampleSubmission {
  exampleId: string;
  symbol: string;
  sessionDate: string;
  /** Exact OCC. Without it the example is a lead, not a gradeable candidate. */
  occSymbol?: string | null;
  expiration?: string | null;
  strike?: number | null;
  optionType?: string | null;
  candidateAtMs?: number | null;
  direction?: string | null;
  setupFamily?: string | null;
  underlyingPrice?: number | null;
  references?: HistoricalExampleReference[];
  /** Independently verified quotes. The ONLY channel that carries prices. */
  quoteEvidence?: AsymmetryQuoteObservation[];
  /** Named provider/source for `quoteEvidence`. Required to accept it. */
  quoteEvidenceSource?: string | null;
  /** Marks after the candidate timestamp, same exact OCC. */
  markEvidence?: AsymmetryQuoteObservation[];
}

export type HistoricalExampleStatus =
  | "ACCEPTED_FOR_REPLAY"
  | "PENDING_EXACT_OCC"
  | "PENDING_CANDIDATE_TIMESTAMP"
  | "PENDING_QUOTE_EVIDENCE"
  | "REJECTED_UNVERIFIABLE";

export interface HistoricalExampleAcceptance {
  exampleId: string;
  symbol: string;
  sessionDate: string | null;
  occSymbol: string | null;
  status: HistoricalExampleStatus;
  reasons: string[];
  referenceCount: number;
  /** Always false. A reference is provenance, never price evidence. */
  referencesUsedAsPriceEvidence: false;
  quoteEvidenceCount: number;
  markEvidenceCount: number;
  /** Present only when status is ACCEPTED_FOR_REPLAY. */
  candidateInput: AsymmetryCandidateInput | null;
}

/**
 * Validates one submission. Never throws, never fabricates, and never lets a
 * reference stand in for a quote.
 */
export function acceptHistoricalExample(submission: HistoricalExampleSubmission): HistoricalExampleAcceptance {
  const references = Array.isArray(submission.references) ? submission.references : [];
  const quoteEvidence = Array.isArray(submission.quoteEvidence) ? submission.quoteEvidence : [];
  const markEvidence = Array.isArray(submission.markEvidence) ? submission.markEvidence : [];
  const reasons: string[] = [];

  const base: HistoricalExampleAcceptance = {
    exampleId: String(submission.exampleId ?? "").trim(),
    symbol: String(submission.symbol ?? "").trim().toUpperCase(),
    sessionDate: DAY_RE.test(String(submission.sessionDate ?? "")) ? String(submission.sessionDate) : null,
    occSymbol: null,
    status: "REJECTED_UNVERIFIABLE",
    reasons,
    referenceCount: references.length,
    referencesUsedAsPriceEvidence: false,
    quoteEvidenceCount: quoteEvidence.length,
    markEvidenceCount: markEvidence.length,
    candidateInput: null,
  };

  if (!base.exampleId) reasons.push("exampleId is required.");
  if (!base.symbol) reasons.push("symbol is required.");
  if (!base.sessionDate) reasons.push("sessionDate must be YYYY-MM-DD.");
  if (reasons.length) return base;

  const identity = verifyOccIdentity({
    occSymbol: submission.occSymbol,
    symbol: base.symbol,
    expiration: submission.expiration,
    strike: submission.strike,
    optionType: submission.optionType,
  });
  if (!identity.ok) {
    reasons.push(submission.occSymbol
      ? "The supplied OCC symbol does not parse or disagrees with the supplied contract terms."
      : "No exact OCC contract was supplied; the example is retained as a lead only.");
    return { ...base, status: "PENDING_EXACT_OCC" };
  }
  base.occSymbol = identity.occSymbol;

  const candidateAtMs = submission.candidateAtMs;
  if (candidateAtMs == null || !Number.isFinite(candidateAtMs)) {
    reasons.push("No candidate timestamp was supplied, so no entry moment can be established.");
    return { ...base, status: "PENDING_CANDIDATE_TIMESTAMP" };
  }

  const source = String(submission.quoteEvidenceSource ?? "").trim();
  if (!quoteEvidence.length || !source) {
    reasons.push(references.length
      ? `Retained as a lead: ${references.length} reference(s) supplied, but a screenshot or post is never price evidence. Independently sourced quote evidence is required.`
      : "No independently sourced quote evidence was supplied.");
    return { ...base, status: "PENDING_QUOTE_EVIDENCE" };
  }

  // The entry quote must be an exact-OCC observation at the candidate moment.
  const entryQuote = quoteEvidence.find((quote) =>
    String(quote.occSymbol ?? "").trim().toUpperCase() === identity.occSymbol
    && quote.atMs === candidateAtMs);
  if (!entryQuote) {
    reasons.push("Quote evidence contains no exact-OCC observation at the candidate timestamp.");
    return { ...base, status: "PENDING_QUOTE_EVIDENCE" };
  }

  reasons.push("Accepted for replay. It will be graded by the standard engine with no relaxed rule; references contributed provenance only.");
  return {
    ...base,
    status: "ACCEPTED_FOR_REPLAY",
    candidateInput: {
      evidence: {
        candidateId: `example:${base.exampleId}`,
        symbol: base.symbol,
        direction: submission.direction ?? submission.optionType ?? null,
        detectionAtMs: candidateAtMs,
        setupFamily: submission.setupFamily ?? null,
        underlyingPrice: submission.underlyingPrice ?? null,
        occSymbol: identity.occSymbol,
        expiration: identity.expiration,
        strike: identity.strike,
        optionType: identity.optionType,
        bid: entryQuote.bid,
        ask: entryQuote.ask,
        quoteTimestampMs: entryQuote.quoteTimestampMs,
        quoteSource: source,
      },
      priorQuotes: quoteEvidence.filter((quote) => quote.atMs <= candidateAtMs),
      marks: markEvidence,
    },
  };
}

export interface HistoricalExampleIntake {
  advisoryOnly: true;
  productionBehaviorChanged: false;
  submitted: number;
  accepted: number;
  pending: number;
  rejected: number;
  byStatus: Record<HistoricalExampleStatus, number>;
  acceptances: HistoricalExampleAcceptance[];
  candidateInputs: AsymmetryCandidateInput[];
  notes: string[];
}

const ALL_STATUSES: HistoricalExampleStatus[] = [
  "ACCEPTED_FOR_REPLAY", "PENDING_EXACT_OCC", "PENDING_CANDIDATE_TIMESTAMP",
  "PENDING_QUOTE_EVIDENCE", "REJECTED_UNVERIFIABLE",
];

export function intakeHistoricalExamples(submissions: HistoricalExampleSubmission[]): HistoricalExampleIntake {
  const acceptances = submissions.map(acceptHistoricalExample);
  const byStatus = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0])) as Record<HistoricalExampleStatus, number>;
  for (const acceptance of acceptances) byStatus[acceptance.status] += 1;

  return {
    advisoryOnly: true,
    productionBehaviorChanged: false,
    submitted: submissions.length,
    accepted: byStatus.ACCEPTED_FOR_REPLAY,
    pending: byStatus.PENDING_EXACT_OCC + byStatus.PENDING_CANDIDATE_TIMESTAMP + byStatus.PENDING_QUOTE_EVIDENCE,
    rejected: byStatus.REJECTED_UNVERIFIABLE,
    byStatus,
    acceptances,
    candidateInputs: acceptances
      .map((acceptance) => acceptance.candidateInput)
      .filter((input): input is AsymmetryCandidateInput => input != null),
    notes: [
      "A screenshot, article, chart image, or social post is provenance only. It carries no price field and can never become return evidence.",
      "An example without exact OCC, a candidate timestamp, or independently sourced quote evidence is retained as a lead, never as a graded outcome.",
      "Accepted examples are graded by the standard engine under the standard rules — ask entry, bid marks, exact OCC, fresh in-session quotes.",
      "A claimed return in a submission note is never read, parsed, or reported by the radar.",
    ],
  };
}
