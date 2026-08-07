/**
 * Loads the frozen `lower_high_continuation` cohort from persisted rows.
 *
 * Read-only, ZERO provider calls. Joins three tables that each hold part of the pre-entry
 * picture: `options_paper_trades` (the frozen contract), `options_alerts` (the evidence
 * snapshot captured at notification), and `options_paper_marks` (the same-contract path).
 *
 * Marks are read with an explicit `option_symbol` match against the position's frozen OCC.
 * The re-selection defect fixed in `320d651` means a case can carry marks for a contract it
 * never held; filtering on the frozen OCC is what keeps "peak" a statement about the trade
 * that was actually delivered.
 *
 * Tolerates legacy shapes: missing columns and a missing marks table degrade to nulls and
 * UNGRADABLE rather than throwing, so an older database still loads.
 */
import {
  buildCohort, COHORT_PAPER_KIND, COHORT_STRATEGY,
  type Cohort, type CohortRowSource,
} from "./lower-high-cohort.ts";

export interface CohortDb {
  prepare(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
}

function hasTable(db: CohortDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch { return false; }
}

function columns(db: CohortDb, table: string): Set<string> {
  try {
    return new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name));
  } catch { return new Set(); }
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const parse = (v: unknown): unknown => {
  if (typeof v !== "string" || !v) return null;
  try { return JSON.parse(v); } catch { return null; }
};

export interface LoadCohortOptions {
  /** Optional lower bound on entry time. Omit for the whole frozen cohort. */
  sinceMs?: number | null;
  limit?: number;
  deploymentSha?: string | null;
}

export function loadLowerHighCohortOnDb(db: CohortDb, opts: LoadCohortOptions = {}): Cohort {
  if (!hasTable(db, "options_paper_trades")) return buildCohort([]);

  const paperCols = columns(db, "options_paper_trades");
  const pick = (c: string) => (paperCols.has(c) ? c : `NULL AS ${c}`);
  const marksTable = hasTable(db, "options_paper_marks");
  const alertsTable = hasTable(db, "options_alerts");
  const alertCols = alertsTable ? columns(db, "options_alerts") : new Set<string>();

  const where = ["strategy = ?"];
  const params: unknown[] = [COHORT_STRATEGY];
  if (paperCols.has("paper_kind")) { where.push("paper_kind = ?"); params.push(COHORT_PAPER_KIND); }
  if (opts.sinceMs != null) { where.push("entered_at_ms >= ?"); params.push(opts.sinceMs); }

  const trades = db.prepare(
    `SELECT id, option_symbol, side, strike, expiration, dte, status, exit_reason,
            entered_at_ms, exit_at_ms, return_pct, entry_fill, spread_pct, volume,
            open_interest, iv, delta, underlying_price,
            ${pick("alert_id")}, ${pick("exit_policy_version")}
       FROM options_paper_trades
      WHERE ${where.join(" AND ")}
      ORDER BY entered_at_ms ASC
      LIMIT ?`,
  ).all(...params, Math.min(opts.limit ?? 5_000, 20_000)) as Record<string, unknown>[];

  const alertStmt = alertsTable
    ? db.prepare(
        `SELECT ${alertCols.has("evidence_snapshot_json") ? "evidence_snapshot_json" : "NULL AS evidence_snapshot_json"},
                ${alertCols.has("opportunity_case_id") ? "opportunity_case_id" : "NULL AS opportunity_case_id"},
                ${alertCols.has("discord_message_id") ? "discord_message_id" : "NULL AS discord_message_id"},
                ${alertCols.has("candidate_symbol") ? "candidate_symbol" : "NULL AS candidate_symbol"},
                ${alertCols.has("first_detected_at_ms") ? "first_detected_at_ms" : "NULL AS first_detected_at_ms"},
                ${alertCols.has("option_at_first_detection") ? "option_at_first_detection" : "NULL AS option_at_first_detection"}
           FROM options_alerts WHERE alert_id = ?`,
      )
    : null;

  // Same-contract marks only. A mark on a re-selected OCC describes a different instrument.
  const markStmt = marksTable
    ? db.prepare(
        `SELECT mark_at_ms, return_pct FROM options_paper_marks
          WHERE trade_id = ? AND option_symbol = ? ORDER BY mark_at_ms ASC`,
      )
    : null;

  const sources: CohortRowSource[] = trades.map((t) => {
    const alertId = str(t.alert_id);
    const a = (alertId && alertStmt ? alertStmt.get(alertId) : null) as Record<string, unknown> | null;
    const enteredAtMs = num(t.entered_at_ms) ?? 0;

    const marks = (markStmt ? markStmt.all(t.id, t.option_symbol) : []) as Record<string, unknown>[];
    const rets = marks.map((m) => num(m.return_pct)).filter((v): v is number => v != null);
    const firstTo = (thr: number): number | null => {
      for (const m of marks) {
        const r = num(m.return_pct), at = num(m.mark_at_ms);
        if (r != null && at != null && r >= thr) return at - enteredAtMs;
      }
      return null;
    };

    return {
      paperTradeId: Number(t.id),
      alertId,
      opportunityCaseId: a ? str(a.opportunity_case_id) : null,
      discordMessageId: a ? str(a.discord_message_id) : null,
      symbol: a ? str(a.candidate_symbol) : null,
      optionSymbol: String(t.option_symbol),
      side: str(t.side),
      expiration: str(t.expiration),
      status: String(t.status ?? ""),
      exitReason: str(t.exit_reason),
      enteredAtMs,
      exitAtMs: num(t.exit_at_ms),
      returnPct: num(t.return_pct),
      sameContractMarks: marks.length,
      peakPct: rets.length ? Math.max(...rets) : null,
      troughPct: rets.length ? Math.min(...rets) : null,
      msToPct: { p5: firstTo(5), p10: firstTo(10), p25: firstTo(25), p50: firstTo(50), p100: firstTo(100) },
      // pre-entry source fields
      strike: num(t.strike), dte: num(t.dte), entryFill: num(t.entry_fill),
      spreadPct: num(t.spread_pct), volume: num(t.volume), openInterest: num(t.open_interest),
      iv: num(t.iv), delta: num(t.delta), underlyingPrice: num(t.underlying_price),
      evidence: a ? parse(a.evidence_snapshot_json) : null,
      firstDetectedAtMs: a ? num(a.first_detected_at_ms) : null,
      optionAtFirstDetection: a ? num(a.option_at_first_detection) : null,
      // Historical attribution is not invented; the cohort stamps UNKNOWN_LEGACY_VERSION.
      strategyVersion: null,
      exitPolicyVersion: str(t.exit_policy_version),
      deploymentSha: opts.deploymentSha ?? null,
    };
  });

  return buildCohort(sources);
}
