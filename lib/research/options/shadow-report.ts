/**
 * options/shadow-report.ts — daily shadow vs actual comparison summaries.
 */
type ReportDb = {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown };
};

export interface ShadowDailySummary {
  tradingSessionDate: string;
  total: number;
  proposedWouldSend: number;
  proposedWouldBlock: number;
  observedOnly: number;
  wouldAllowSession: number;
  wouldBlockSession: number;
  actuallyDelivered: number;
  byVerdict: Record<string, number>;
  byPath: Record<string, { total: number; wouldSend: number }>;
  byActualAction: Record<string, number>;
}

export function shadowSummaryForDay(db: ReportDb, tradingSessionDate: string): ShadowDailySummary {
  const out: ShadowDailySummary = {
    tradingSessionDate,
    total: 0,
    proposedWouldSend: 0,
    proposedWouldBlock: 0,
    observedOnly: 0,
    wouldAllowSession: 0,
    wouldBlockSession: 0,
    actuallyDelivered: 0,
    byVerdict: {},
    byPath: {},
    byActualAction: {},
  };
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_shadow_decisions'").get()) return out;
    const rows = db.prepare(
      `SELECT path, would_send, entry_quality_verdict, actual_action, would_allow_session, actually_delivered
       FROM options_shadow_decisions WHERE trading_session_date=?`,
    ).all(tradingSessionDate) as {
      path: string;
      would_send: number;
      entry_quality_verdict: string | null;
      actual_action: string | null;
      would_allow_session: number | null;
      actually_delivered: number | null;
    }[];
    out.total = rows.length;
    for (const r of rows) {
      const path = r.path ?? "unknown";
      out.byPath[path] ??= { total: 0, wouldSend: 0 };
      out.byPath[path].total += 1;
      if (r.would_send) out.byPath[path].wouldSend += 1;
      const v = r.entry_quality_verdict ?? "unknown";
      out.byVerdict[v] = (out.byVerdict[v] ?? 0) + 1;
      const action = r.actual_action ?? "unknown";
      out.byActualAction[action] = (out.byActualAction[action] ?? 0) + 1;
      if (r.actual_action === "OBSERVE_ONLY") out.observedOnly += 1;
      if (r.would_allow_session) out.wouldAllowSession += 1;
      else out.wouldBlockSession += 1;
      if (r.actually_delivered) out.actuallyDelivered += 1;
      if (path === "proposed") {
        if (r.would_send) out.proposedWouldSend += 1;
        else out.proposedWouldBlock += 1;
      }
    }
  } catch { /* isolated */ }
  return out;
}

export function shadowSummaryRecentDays(db: ReportDb, days = 7): ShadowDailySummary[] {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_shadow_decisions'").get()) return [];
    const dayRows = db.prepare(
      "SELECT DISTINCT trading_session_date d FROM options_shadow_decisions ORDER BY d DESC LIMIT ?",
    ).all(days) as { d: string }[];
    return dayRows.map((r) => shadowSummaryForDay(db, r.d));
  } catch {
    return [];
  }
}
