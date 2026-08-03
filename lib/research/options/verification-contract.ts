/**
 * verification-contract.ts — THE definition of a verified graded opportunity.
 * PURE: no DB, no network, no AI.
 *
 * WHY THIS EXISTS. Three separate implementations of "is this row trustworthy"
 * had drifted apart:
 *
 *   paper-chain   — 82 valid of 553, using Discord delivery proof.
 *   quant-lab     — 276 valid of 357, using only paper columns and marks.
 *   readiness     — its own subset again.
 *
 * The second was introduced in Checkpoint 2 as a deliberate approximation and
 * turned out to be MORE permissive, not stricter, because it could not see
 * delivery proof at all. Official performance was quoted from it. That is the
 * exact failure this module removes: from here there is ONE authority, every
 * caller supplies facts, and nobody re-implements the decision.
 *
 * MISSING EVIDENCE IS NEVER PROOF. Every fact is tri-state — true, false, or
 * null-for-unknown — and a null NEVER satisfies a requirement. A legacy row
 * whose provenance is unknowable stays unverified forever rather than drifting
 * into the official sample once someone adds a column.
 */

export const VERIFICATION_CONTRACT_VERSION = "VERIFY_CONTRACT_V1" as const;
export const GRADING_VERSION = "GRADING_V1" as const;
export const DATA_QUALITY_VERSION = "DATA_QUALITY_V1" as const;

/** Top-level classification. Exactly one applies. Ordered worst-cause-first. */
export type VerificationStatus =
  | "VERIFIED_GRADED"
  | "AUDIT_ONLY"
  | "MISSING_MIRROR"
  | "DUPLICATE"
  | "SESSION_INVALID"
  | "WRONG_OCC"
  | "UNVERIFIED_DELIVERY"
  | "UNVERIFIED_ENTRY"
  | "UNVERIFIED_EXIT"
  | "INVALID_OR_STALE_MARK"
  | "UNGRADEABLE"
  | "EXCLUDED_OTHER";

export const VERIFICATION_STATUSES: readonly VerificationStatus[] = Object.freeze([
  "VERIFIED_GRADED", "AUDIT_ONLY", "MISSING_MIRROR", "DUPLICATE", "SESSION_INVALID",
  "WRONG_OCC", "UNVERIFIED_DELIVERY", "UNVERIFIED_ENTRY", "UNVERIFIED_EXIT",
  "INVALID_OR_STALE_MARK", "UNGRADEABLE", "EXCLUDED_OTHER",
]);

/** The ONLY status any official performance metric may count. */
export const OFFICIAL_STATUS: VerificationStatus = "VERIFIED_GRADED";

/** Why a row could not be linked to its counterparties. */
export type LinkageStatus =
  | "LINKED"
  | "NO_ALERT_LINK"
  | "NO_PAPER_LINK"
  | "OCC_MISMATCH"
  | "DELIVERY_NOT_PROVEN"
  | "LEGACY_UNLINKABLE"
  | "OTHER_PROVEN_REASON";

/**
 * Facts a caller must supply. Tri-state throughout: `null` means UNKNOWN and is
 * never accepted as satisfied.
 */
export interface VerificationFacts {
  /** The alert row exists and was a real subscriber send (state SENT, not research_only). */
  alertPresent: boolean | null;
  alertSentToSubscriber: boolean | null;
  /** Discord message id recorded for the opening message. */
  discordMessageIdPresent: boolean | null;
  /** Opportunity case linked. */
  opportunityCasePresent: boolean | null;
  /** Paper mirror exists for the alert. */
  paperMirrorPresent: boolean | null;
  /** Alert row itself claims a paper link. */
  alertPaperLinked: boolean | null;
  /** Count of paper positions for this alert. */
  paperRowCount: number | null;
  /** Entry fill present, finite and positive. */
  entryFillValid: boolean | null;
  /** Exit fill present when EXITED; true when the position is still open. */
  exitFillValid: boolean | null;
  /** Exit is corroborated by a matching mark. True when still open. */
  exitMarkMatched: boolean | null;
  /** Grading mark present, two-sided, fresh enough. */
  gradingMarkValid: boolean | null;
  /** The paper OCC equals the alert OCC. */
  occMatches: boolean | null;
  /** Opened inside a valid options session (no weekend/holiday/cross-session). */
  sessionValid: boolean | null;
  /** A return could be computed. */
  returnComputable: boolean | null;
  /** Bookkeeping-only row that never represented a delivered alert. */
  auditOnly?: boolean | null;
}

export interface CanonicalVerification {
  verificationStatus: VerificationStatus;
  verificationReasons: string[];
  entryVerified: boolean;
  exitVerified: boolean;
  deliveryVerified: boolean;
  exactOccVerified: boolean;
  entryQuoteVerified: boolean;
  exitQuoteVerified: boolean;
  markSeriesVerified: boolean;
  duplicateStatus: "UNIQUE" | "DUPLICATE" | "UNKNOWN";
  mirrorStatus: "PRESENT" | "MISSING" | "UNKNOWN";
  auditOnlyStatus: "NO" | "YES" | "UNKNOWN";
  sessionStatus: "VALID" | "INVALID" | "UNKNOWN";
  linkage: LinkageStatus;
  officialEligible: boolean;
  verificationVersion: string;
  gradingVersion: string;
  dataQualityVersion: string;
}

/** True only when the fact is explicitly true. Null and false both fail. */
const yes = (v: boolean | null | undefined): boolean => v === true;

/**
 * The single decision. Total and deterministic: every input maps to exactly one
 * status, and the same input always yields the same result.
 *
 * Precedence is worst-cause-first so exclusion counts never double-count and
 * always name the defect a fix would have to address.
 */
export function verifyOpportunity(f: VerificationFacts): CanonicalVerification {
  const reasons: string[] = [];

  const deliveryVerified = yes(f.alertPresent) && yes(f.alertSentToSubscriber)
    && yes(f.discordMessageIdPresent) && yes(f.opportunityCasePresent) && yes(f.alertPaperLinked);
  const entryQuoteVerified = yes(f.entryFillValid);
  const exitQuoteVerified = yes(f.exitFillValid);
  const markSeriesVerified = yes(f.gradingMarkValid);
  const entryVerified = entryQuoteVerified;
  const exitVerified = exitQuoteVerified && yes(f.exitMarkMatched);
  const exactOccVerified = yes(f.occMatches);

  const duplicateStatus = f.paperRowCount == null ? "UNKNOWN" : f.paperRowCount > 1 ? "DUPLICATE" : "UNIQUE";
  const mirrorStatus = f.paperMirrorPresent == null ? "UNKNOWN" : f.paperMirrorPresent ? "PRESENT" : "MISSING";
  const auditOnlyStatus = f.auditOnly == null ? "UNKNOWN" : f.auditOnly ? "YES" : "NO";
  const sessionStatus = f.sessionValid == null ? "UNKNOWN" : f.sessionValid ? "VALID" : "INVALID";

  const linkage: LinkageStatus = !yes(f.alertPresent)
    ? (f.alertPresent === null ? "LEGACY_UNLINKABLE" : "NO_ALERT_LINK")
    : mirrorStatus === "MISSING" ? "NO_PAPER_LINK"
      : f.occMatches === false ? "OCC_MISMATCH"
        : !deliveryVerified ? "DELIVERY_NOT_PROVEN"
          : "LINKED";

  const base = {
    entryVerified, exitVerified, deliveryVerified, exactOccVerified,
    entryQuoteVerified, exitQuoteVerified, markSeriesVerified,
    duplicateStatus, mirrorStatus, auditOnlyStatus, sessionStatus, linkage,
    verificationVersion: VERIFICATION_CONTRACT_VERSION,
    gradingVersion: GRADING_VERSION,
    dataQualityVersion: DATA_QUALITY_VERSION,
  } as const;

  const fail = (status: VerificationStatus, reason: string): CanonicalVerification => ({
    ...base, verificationStatus: status, verificationReasons: [...reasons, reason], officialEligible: false,
  });

  if (f.auditOnly === true) return fail("AUDIT_ONLY", "row is bookkeeping only, never a delivered alert");
  if (f.alertPresent !== true) return fail("AUDIT_ONLY", "no alert row — cannot have been a subscriber alert");
  if (mirrorStatus !== "PRESENT") return fail("MISSING_MIRROR", "no paper mirror for a delivered alert");
  if (duplicateStatus === "DUPLICATE") return fail("DUPLICATE", `${f.paperRowCount} paper positions for one alert`);
  if (duplicateStatus === "UNKNOWN") return fail("EXCLUDED_OTHER", "paper position count unknown — uniqueness unproven");
  if (f.sessionValid === false) return fail("SESSION_INVALID", "opened outside a valid options session");
  if (f.occMatches === false) return fail("WRONG_OCC", "paper contract differs from the alerted contract");
  if (!exactOccVerified) return fail("WRONG_OCC", "contract identity unproven");
  if (!deliveryVerified) return fail("UNVERIFIED_DELIVERY", "delivery to a subscriber was not proven end to end");
  if (!entryVerified) return fail("UNVERIFIED_ENTRY", "entry fill missing or unprovable");
  if (!markSeriesVerified) return fail("INVALID_OR_STALE_MARK", "grading mark absent, one-sided, or stale");
  if (!exitVerified) return fail("UNVERIFIED_EXIT", "exit is not corroborated by a matching mark");
  if (f.returnComputable !== true) return fail("UNGRADEABLE", "no return could be computed");

  return {
    ...base,
    verificationStatus: "VERIFIED_GRADED",
    verificationReasons: ["delivery, entry, exit, contract identity, session and marks all proven"],
    officialEligible: true,
  };
}

// ── parity ─────────────────────────────────────────────────────────────────

export type ParityStatus = "EXACT_PARITY" | "EXPLAINED_DIFFERENCE" | "UNEXPLAINED_DIFFERENCE" | "NOT_COMPARABLE";

export interface ParityReport {
  parityStatus: ParityStatus;
  comparedRows: number;
  matchingRows: number;
  mismatchingRows: number;
  mismatchReasons: Array<{ key: string; quantLab: string; paperChain: string; count: number }>;
  quantLabValidCount: number;
  paperChainValidCount: number;
  onlyValidInQuantLab: number;
  onlyValidInPaperChain: number;
  unlinkedRows: number;
  /** Rows present in one population and absent from the other. */
  populationOnlyInQuantLab: number;
  populationOnlyInPaperChain: number;
  note: string;
}

export interface ParityInput {
  key: string;
  quantLabStatus: VerificationStatus | null;
  paperChainStatus: VerificationStatus | null;
  linkage?: LinkageStatus | null;
}

/**
 * Compare the two systems row by row.
 *
 * "Approximately equal" is not accepted: any row where the two disagree is
 * counted and its reason pair recorded. Rows present in only one population are
 * reported separately rather than quietly dropped, because a population
 * difference and a classification difference need different fixes.
 */
export function compareParity(rows: readonly ParityInput[]): ParityReport {
  let matching = 0, mismatching = 0, onlyQl = 0, onlyPc = 0, popQl = 0, popPc = 0, unlinked = 0;
  const reasonCounts = new Map<string, { key: string; quantLab: string; paperChain: string; count: number }>();

  for (const r of rows) {
    if (r.linkage && r.linkage !== "LINKED") unlinked += 1;
    if (r.quantLabStatus == null && r.paperChainStatus == null) continue;
    if (r.quantLabStatus == null) { popPc += 1; continue; }
    if (r.paperChainStatus == null) { popQl += 1; continue; }

    if (r.quantLabStatus === r.paperChainStatus) { matching += 1; continue; }
    mismatching += 1;
    if (r.quantLabStatus === OFFICIAL_STATUS) onlyQl += 1;
    if (r.paperChainStatus === OFFICIAL_STATUS) onlyPc += 1;
    const k = `${r.quantLabStatus}|${r.paperChainStatus}`;
    const prev = reasonCounts.get(k);
    if (prev) prev.count += 1;
    else reasonCounts.set(k, { key: k, quantLab: r.quantLabStatus, paperChain: r.paperChainStatus, count: 1 });
  }

  const compared = matching + mismatching;
  const parityStatus: ParityStatus = compared === 0
    ? "NOT_COMPARABLE"
    : mismatching === 0
      ? "EXACT_PARITY"
      : (onlyQl === 0 && onlyPc === 0 ? "EXPLAINED_DIFFERENCE" : "UNEXPLAINED_DIFFERENCE");

  return {
    parityStatus, comparedRows: compared, matchingRows: matching, mismatchingRows: mismatching,
    mismatchReasons: [...reasonCounts.values()].sort((a, b) => b.count - a.count),
    quantLabValidCount: rows.filter((r) => r.quantLabStatus === OFFICIAL_STATUS).length,
    paperChainValidCount: rows.filter((r) => r.paperChainStatus === OFFICIAL_STATUS).length,
    onlyValidInQuantLab: onlyQl, onlyValidInPaperChain: onlyPc,
    unlinkedRows: unlinked,
    populationOnlyInQuantLab: popQl, populationOnlyInPaperChain: popPc,
    note: parityStatus === "EXACT_PARITY"
      ? "Both systems classify every comparable row identically."
      : parityStatus === "NOT_COMPARABLE"
        ? "No overlapping rows to compare."
        : parityStatus === "EXPLAINED_DIFFERENCE"
          ? "Statuses differ on some rows but neither system calls a row VERIFIED_GRADED that the other excludes."
          : `${onlyQl + onlyPc} row(s) are VERIFIED_GRADED in one system and excluded in the other. Official performance stays non-quotable until this is zero.`,
  };
}

/** Official performance may be quoted only when ALL of these hold. */
export function isQuotable(input: {
  parityStatus: ParityStatus;
  verifiedCount: number;
  verifiedFraction: number | null;
  independentMarkRate: number | null;
}): { quotable: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (input.parityStatus !== "EXACT_PARITY" && input.parityStatus !== "EXPLAINED_DIFFERENCE") {
    blockers.push(`parity is ${input.parityStatus}`);
  }
  if (input.verifiedCount < 30) blockers.push(`only ${input.verifiedCount} verified rows (need 30)`);
  if (input.verifiedFraction == null || input.verifiedFraction < 0.8) {
    blockers.push(`verified fraction ${input.verifiedFraction == null ? "unknown" : (input.verifiedFraction * 100).toFixed(1) + "%"} (need 80%)`);
  }
  if (input.independentMarkRate == null || input.independentMarkRate < 0.5) {
    blockers.push(`independent mark rate ${input.independentMarkRate == null ? "unknown" : (input.independentMarkRate * 100).toFixed(1) + "%"} (need 50%)`);
  }
  return { quotable: blockers.length === 0, blockers };
}
