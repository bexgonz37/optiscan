/**
 * content-feedback.ts — what the owner keeps, and what that should change.
 *
 * `updateContentDraftOnDb` has always written `approved_at_ms`,
 * `rejected_at_ms`, `manually_posted_at_ms` and `final_copy`. Grepping the
 * repository for any of those column names returns the writer, the DDL and some
 * test fixtures — and no reader. Every approval and rejection the owner has ever
 * made went into the database and stopped there. A loop with a sensor and no
 * consumer is not a loop.
 *
 * WHAT THIS DOES AND DELIBERATELY DOES NOT DO
 *
 * It aggregates. Approval rate per event type, per category, per angle; the
 * reasons drafts were refused; how often the owner rewrote the copy before
 * posting. That is enough to rank future proposals better.
 *
 * It does NOT train anything, does not adjust a threshold, and does not let a
 * model change a production rule. The prompt for this work says "simple
 * aggregate feedback is enough", and the reason it is enough is the reason it is
 * safe: an aggregate the owner can read and disagree with cannot silently become
 * a rule nobody chose. The ranking adjustment it produces is BOUNDED and
 * explicitly reversible — see `preferenceAdjustment`.
 *
 * Reads only. Never writes, never sends, never calls a model.
 */

interface FeedbackDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

export interface CategoryFeedback {
  category: string;
  generated: number;
  approved: number;
  rejected: number;
  manuallyPosted: number;
  edited: number;
  /** approved / (approved + rejected). Null until the owner has judged any. */
  approvalRate: number | null;
}

export interface ContentFeedbackReport {
  /** Days of history the aggregate covers. */
  days: number;
  totalDrafts: number;
  totalJudged: number;
  byCategory: CategoryFeedback[];
  byAngle: CategoryFeedback[];
  /** Why drafts never reached the queue, from the gate's own refusals. */
  refusalReasons: Array<{ reason: string; count: number }>;
  /**
   * Honest statement of what the numbers can support. With nothing judged, the
   * correct output is "no preference has been expressed yet", not a rate of 0.
   */
  evidenceState: "NO_FEEDBACK_YET" | "SPARSE" | "USABLE";
  note: string;
}

const MIN_JUDGED_FOR_USABLE = 20;
/** Below this many judgements for one bucket, its rate is noise. */
const MIN_JUDGED_PER_BUCKET = 5;

function hasTable(db: FeedbackDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function hasColumn(db: FeedbackDb, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return cols.some((c) => c?.name === column);
  } catch {
    return false;
  }
}

function rateOf(approved: number, rejected: number): number | null {
  const judged = approved + rejected;
  return judged > 0 ? approved / judged : null;
}

export function contentFeedbackReportOnDb(
  db: FeedbackDb,
  opts: { days?: number; nowMs?: number } = {},
): ContentFeedbackReport {
  const days = Math.max(1, Math.min(365, Math.floor(opts.days ?? 30)));
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = nowMs - days * 24 * 60 * 60 * 1000;
  const empty: ContentFeedbackReport = {
    days, totalDrafts: 0, totalJudged: 0, byCategory: [], byAngle: [], refusalReasons: [],
    evidenceState: "NO_FEEDBACK_YET",
    note: "No content drafts on record for this window.",
  };
  if (!hasTable(db, "content_drafts")) return empty;

  const angled = hasColumn(db, "content_drafts", "content_angle");

  const group = (col: string): CategoryFeedback[] => {
    try {
      const rows = db.prepare(
        `SELECT ${col} AS k,
                COUNT(*) AS generated,
                SUM(CASE WHEN approved_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN rejected_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN manually_posted_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS posted,
                SUM(CASE WHEN final_copy IS NOT NULL AND final_copy <> draft_text THEN 1 ELSE 0 END) AS edited
           FROM content_drafts
          WHERE created_at_ms >= ? AND ${col} IS NOT NULL
          GROUP BY ${col}`,
      ).all(sinceMs) as any[];
      return rows.map((r) => {
        const approved = Number(r.approved) || 0;
        const rejected = Number(r.rejected) || 0;
        return {
          category: String(r.k),
          generated: Number(r.generated) || 0,
          approved,
          rejected,
          manuallyPosted: Number(r.posted) || 0,
          edited: Number(r.edited) || 0,
          approvalRate: rateOf(approved, rejected),
        };
      }).sort((a, b) => b.generated - a.generated || a.category.localeCompare(b.category));
    } catch {
      return [];
    }
  };

  const byCategory = group("category");
  const byAngle = angled ? group("content_angle") : [];
  const totalDrafts = byCategory.reduce((n, c) => n + c.generated, 0);
  const totalJudged = byCategory.reduce((n, c) => n + c.approved + c.rejected, 0);

  // The gate's own refusals, read from the source events it marked.
  const refusalReasons: Array<{ reason: string; count: number }> = [];
  if (hasTable(db, "opportunity_content_events")) {
    try {
      const rows = db.prepare(
        `SELECT payload_json FROM opportunity_content_events
          WHERE created_at_ms >= ? AND payload_json LIKE '%contentSkipReason%' LIMIT 2000`,
      ).all(sinceMs) as Array<{ payload_json?: string }>;
      const counts = new Map<string, number>();
      for (const r of rows) {
        try {
          const p = JSON.parse(String(r.payload_json ?? "{}"));
          const reason = String(p?.contentSkipReason ?? "");
          if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1);
        } catch { /* one unreadable payload is not a failure */ }
      }
      for (const [reason, count] of counts) refusalReasons.push({ reason, count });
      refusalReasons.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    } catch { /* isolated */ }
  }

  const evidenceState = totalJudged === 0
    ? "NO_FEEDBACK_YET"
    : totalJudged < MIN_JUDGED_FOR_USABLE ? "SPARSE" : "USABLE";

  return {
    days, totalDrafts, totalJudged, byCategory, byAngle, refusalReasons, evidenceState,
    note: evidenceState === "NO_FEEDBACK_YET"
      ? "Nothing has been approved or rejected yet, so no preference can be inferred. "
        + "This is a statement about the record, not a score of zero."
      : evidenceState === "SPARSE"
        ? `Only ${totalJudged} drafts judged. Rates are shown but are not yet a preference.`
        : `${totalJudged} drafts judged across ${days} days.`,
  };
}

/**
 * A BOUNDED nudge to a category's RANKING, learned from what the owner keeps.
 *
 * Two properties matter more than the magnitude, and the first is structural
 * rather than numeric:
 *
 *  - IT IS NOT PART OF THE VERDICT. `scoreContentWorthiness` does not import
 *    this module and has no way to reach it; the worthy/unworthy decision is
 *    made from the event alone. Preference orders things already judged worth
 *    reading — it never promotes something that was not. That separation is
 *    what stops "the owner liked one of these" from quietly becoming a rule.
 *  - It is a pure function of persisted counts, gated on a minimum sample.
 *    Delete the feedback rows and the adjustment is gone. There is no learned
 *    state anywhere else to unwind, and nothing to retrain.
 *
 * The magnitude is small enough that even a caller who wrongly ADDED it to a
 * score before thresholding could not lift the routine-conviction case (0.482)
 * over the bar (0.55) — belt as well as braces, asserted by test.
 */
export const MAX_PREFERENCE_ADJUSTMENT = 0.05;

export function preferenceAdjustment(
  report: ContentFeedbackReport,
  category: string,
): number {
  if (report.evidenceState !== "USABLE") return 0;
  const row = report.byCategory.find((c) => c.category === category);
  if (!row || row.approvalRate == null) return 0;
  if (row.approved + row.rejected < MIN_JUDGED_PER_BUCKET) return 0;
  // 0.5 approval is neutral; 1.0 gives +max, 0.0 gives -max.
  return (row.approvalRate - 0.5) * 2 * MAX_PREFERENCE_ADJUSTMENT;
}
