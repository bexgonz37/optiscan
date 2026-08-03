/**
 * trade-verification.ts — ONE definition of "is this row trustworthy enough to
 * count as performance". PURE: no DB, no network, no AI.
 *
 * WHY THIS EXISTS. paper-chain already verified rows (rejecting duplicates,
 * stale marks, missing mirrors and unverified entries/exits) while quant-lab
 * selected `status='EXITED' AND return_pct IS NOT NULL` with no verification at
 * all. The two disagreed by 471 rows out of 553, and the headline performance
 * number came from the unverified one. Two verifiers is one too many; this
 * module is the single one both paths must use.
 *
 * PRECEDENCE IS FIXED AND WORST-CAUSE-FIRST. A row that is both a duplicate and
 * missing its mirror reports the more fundamental defect, so exclusion counts
 * never double-count and always name the cause a fix would have to address.
 *
 * EXCLUSION IS NOT DELETION. Every excluded row keeps its reason and stays
 * visible in diagnostics with its P&L reported separately. Silently dropping a
 * row is how a losing population becomes an attractive one.
 */

export const VERIFICATION_VERSION = "TRADE_VERIFICATION_V1" as const;

/** Exhaustive, ordered worst-cause-first. Exactly one applies per row. */
export type VerificationStatus =
  /** Delivered, mirrored, entry+exit proven, marks valid, not duplicated. */
  | "VERIFIED_GRADED"
  /** No paper mirror exists for a delivered alert. */
  | "MISSING_MIRROR"
  /** More than one paper position for the same alert. */
  | "DUPLICATE"
  /** Entry fill missing or not provable. */
  | "UNVERIFIED_ENTRY"
  /** Exited, but the exit has no matching proven mark. */
  | "UNVERIFIED_EXIT"
  /** Grading mark absent, stale, or otherwise unusable. */
  | "INVALID_OR_STALE_MARK"
  /** Row exists for audit only; never represented a delivered subscriber alert. */
  | "AUDIT_ONLY"
  /** No return can be computed at all. */
  | "UNGRADEABLE"
  /** Excluded for a reason outside the taxonomy. Always carries a reason string. */
  | "EXCLUDED_OTHER";

export const VERIFICATION_STATUSES: readonly VerificationStatus[] = Object.freeze([
  "VERIFIED_GRADED", "MISSING_MIRROR", "DUPLICATE", "UNVERIFIED_ENTRY",
  "UNVERIFIED_EXIT", "INVALID_OR_STALE_MARK", "AUDIT_ONLY", "UNGRADEABLE", "EXCLUDED_OTHER",
]);

/** The ONLY status permitted into official performance metrics. */
export const OFFICIAL_STATUS: VerificationStatus = "VERIFIED_GRADED";

export interface VerificationFacts {
  /** Was this row a genuinely delivered subscriber alert? */
  subscriberDelivered: boolean | null;
  /** Does a paper mirror exist? */
  hasPaperMirror: boolean | null;
  /** How many paper positions exist for this alert. */
  paperRowCount: number | null;
  /** Entry fill present and finite. */
  entryValid: boolean | null;
  /** Exit proven by a matching mark (true when the position is still open). */
  exitValid: boolean | null;
  /** Grading mark present, fresh enough, and usable. */
  markValid: boolean | null;
  /** A return could be computed at all. */
  hasReturn: boolean | null;
  /** Row is bookkeeping only — never a delivered alert. */
  auditOnly?: boolean | null;
}

export interface VerificationResult {
  status: VerificationStatus;
  /** Machine-readable cause. Always present, including for VERIFIED_GRADED. */
  reason: string;
  /** True only for VERIFIED_GRADED. The single gate official metrics may read. */
  officialEligible: boolean;
  version: string;
}

/**
 * Classify one row. Total: every input maps to exactly one status.
 *
 * A null fact is treated as NOT PROVEN, never as proven-good. That is the
 * conservative direction and the reason a legacy row with unknown provenance
 * cannot drift into the official sample.
 */
export function classifyVerification(f: VerificationFacts): VerificationResult {
  const no = (status: VerificationStatus, reason: string): VerificationResult =>
    ({ status, reason, officialEligible: false, version: VERIFICATION_VERSION });

  if (f.auditOnly === true) return no("AUDIT_ONLY", "row is bookkeeping only, never a delivered alert");
  if (f.hasPaperMirror !== true) return no("MISSING_MIRROR", "no paper mirror for a delivered alert");
  if ((f.paperRowCount ?? 0) > 1) return no("DUPLICATE", `${f.paperRowCount} paper positions for one alert`);
  if (f.subscriberDelivered !== true) return no("AUDIT_ONLY", "delivery to a subscriber was not proven");
  if (f.entryValid !== true) return no("UNVERIFIED_ENTRY", "entry fill missing or unprovable");
  if (f.markValid !== true) return no("INVALID_OR_STALE_MARK", "grading mark absent, stale, or unusable");
  if (f.exitValid !== true) return no("UNVERIFIED_EXIT", "exit has no matching proven mark");
  if (f.hasReturn !== true) return no("UNGRADEABLE", "no return could be computed");

  return {
    status: "VERIFIED_GRADED",
    reason: "delivered, mirrored, entry and exit proven, mark valid, not duplicated",
    officialEligible: true,
    version: VERIFICATION_VERSION,
  };
}

export interface ExclusionBreakdown {
  total: number;
  verified: number;
  excluded: number;
  byStatus: Record<string, number>;
  /** P&L of excluded rows, reported SEPARATELY and never netted into official. */
  excludedPnlUsd: number | null;
  verifiedPnlUsd: number | null;
  verifiedFraction: number | null;
  /** Safe to publish as performance? */
  quotable: boolean;
  note: string;
}

/**
 * Split a population into official and excluded, keeping both visible.
 *
 * `excludedPnlUsd` exists so the difference between the headline and reality is
 * always inspectable. In production that gap was −$69,325 of a −$72,078 total.
 */
export function buildExclusionBreakdown(
  rows: ReadonlyArray<{ status: VerificationStatus; pnlUsd?: number | null }>,
): ExclusionBreakdown {
  const byStatus: Record<string, number> = {};
  for (const s of VERIFICATION_STATUSES) byStatus[s] = 0;
  let verifiedPnl = 0, excludedPnl = 0, verified = 0, verifiedPnlSeen = false, excludedPnlSeen = false;

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const pnl = typeof r.pnlUsd === "number" && Number.isFinite(r.pnlUsd) ? r.pnlUsd : null;
    if (r.status === OFFICIAL_STATUS) {
      verified += 1;
      if (pnl != null) { verifiedPnl += pnl; verifiedPnlSeen = true; }
    } else if (pnl != null) {
      excludedPnl += pnl; excludedPnlSeen = true;
    }
  }
  const total = rows.length;
  const frac = total > 0 ? Math.round((verified / total) * 10_000) / 10_000 : null;
  return {
    total, verified, excluded: total - verified, byStatus,
    verifiedPnlUsd: verifiedPnlSeen ? round2(verifiedPnl) : null,
    excludedPnlUsd: excludedPnlSeen ? round2(excludedPnl) : null,
    verifiedFraction: frac,
    quotable: frac != null && frac >= 0.8 && verified >= 30,
    note: frac == null
      ? "Empty population."
      : frac < 0.5
        ? `Only ${(frac * 100).toFixed(1)}% verified — the unverified majority must never be quoted as performance.`
        : frac >= 0.8
          ? "Verified majority. Quote with the sample size stated."
          : `${(frac * 100).toFixed(1)}% verified — report with an explicit caveat.`,
  };
}

/**
 * The official filter. Callers computing win rate, expectancy, median return,
 * profit factor, MFE, MAE or milestone rates MUST route through this.
 */
export function officialRowsOnly<T extends { status: VerificationStatus }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.status === OFFICIAL_STATUS);
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
