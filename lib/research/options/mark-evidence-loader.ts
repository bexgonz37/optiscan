/**
 * Reads paper positions and their mark series so evidence quality can be classified.
 *
 * Read-only, zero provider calls. Tolerates legacy shapes: a database with no
 * `options_paper_marks` table at all reports LEGACY_NO_MARKING rather than throwing.
 */
import { classifyMarkEvidence, type MarkEvidence, type MarkRow } from "./mark-evidence.ts";

export interface MarkDb {
  prepare(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
}

function hasTable(db: MarkDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface LoadMarkEvidenceOptions {
  sinceMs?: number | null;
  limit?: number;
  /** Restrict to a paper lane, e.g. DELIVERED_ALERT_PAPER. */
  lane?: string | null;
}

export interface MarkEvidenceRow extends MarkEvidence {
  strategy: string | null;
  lane: string | null;
  optionSymbol: string | null;
  storedMfePct: number | null;
  storedMaePct: number | null;
  returnPct: number | null;
  /** Why the position closed - the fastest route to "why was it never marked". */
  exitReason: string | null;
  enteredAtMs: number | null;
  exitAtMs: number | null;
  status: string | null;
}

export function loadMarkEvidenceOnDb(
  db: MarkDb,
  opts: LoadMarkEvidenceOptions = {},
): MarkEvidenceRow[] {
  if (!hasTable(db, "options_paper_trades")) return [];
  const marksTable = hasTable(db, "options_paper_marks");

  const where: string[] = ["result_class='REAL_OPTION_PAPER'"];
  const params: unknown[] = [];

  // Legacy databases may lack any of the newer columns. Select each only when it exists,
  // so a long-lived database still loads rather than throwing and reporting "no rows" -
  // which would look exactly like "nothing was ever marked".
  const cols = (() => {
    try {
      return new Set((db.prepare("PRAGMA table_info(options_paper_trades)").all() as any[]).map((c) => String(c.name)));
    } catch {
      return new Set<string>();
    }
  })();
  const pick = (c: string) => (cols.has(c) ? c : `NULL AS ${c}`);

  let trades: any[] = [];
  try {
    trades = db.prepare(
      `SELECT id, option_symbol, ${pick("strategy")}, ${pick("paper_kind")}, ${pick("status")}, ${pick("entry_fill")},
              ${pick("entered_at_ms")}, ${pick("exit_at_ms")}, ${pick("mfe_pct")}, ${pick("mae_pct")},
              ${pick("return_pct")}, ${pick("exit_reason")}
         FROM options_paper_trades
        WHERE ${[
          ...where,
          ...(opts.sinceMs != null && cols.has("entered_at_ms") ? ["entered_at_ms >= ?"] : []),
          ...(opts.lane && cols.has("paper_kind") ? ["paper_kind = ?"] : []),
        ].join(" AND ")}
        ${cols.has("entered_at_ms") ? "ORDER BY entered_at_ms DESC" : ""}
        LIMIT ${Math.max(1, Math.min(20_000, opts.limit ?? 5_000))}`,
    ).all(
      ...(opts.sinceMs != null && cols.has("entered_at_ms") ? [opts.sinceMs] : []),
      ...(opts.lane && cols.has("paper_kind") ? [opts.lane] : []),
    ) as any[];
  } catch {
    return [];
  }
  if (!trades.length) return [];

  // One query for every mark in scope, grouped in memory — far cheaper than N queries.
  const byTrade = new Map<number, MarkRow[]>();
  if (marksTable) {
    try {
      const ids = trades.map((t) => Number(t.id));
      const CHUNK = 500;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const rows = db.prepare(
          `SELECT trade_id, mark_at_ms, return_pct, bid, ask, quote_age_ms
             FROM options_paper_marks
            WHERE trade_id IN (${slice.map(() => "?").join(",")})`,
        ).all(...slice) as any[];
        for (const r of rows) {
          const id = Number(r.trade_id);
          if (!byTrade.has(id)) byTrade.set(id, []);
          byTrade.get(id)!.push({
            markAtMs: num(r.mark_at_ms),
            returnPct: num(r.return_pct),
            bid: num(r.bid),
            ask: num(r.ask),
            quoteAgeMs: num(r.quote_age_ms),
          });
        }
      }
    } catch { /* fall through: absent marks classify as ENTRY_ONLY */ }
  }

  return trades.map((t) => {
    const id = Number(t.id);
    const evidence = classifyMarkEvidence({
      tradeId: id,
      enteredAtMs: num(t.entered_at_ms),
      exitAtMs: num(t.exit_at_ms),
      status: t.status == null ? null : String(t.status),
      entryFill: num(t.entry_fill),
      marks: byTrade.get(id) ?? [],
      knownBlocker: marksTable ? null : "LEGACY_NO_MARKING",
    });
    return {
      ...evidence,
      strategy: t.strategy == null ? null : String(t.strategy),
      lane: t.paper_kind == null ? null : String(t.paper_kind),
      optionSymbol: t.option_symbol == null ? null : String(t.option_symbol),
      storedMfePct: num(t.mfe_pct),
      storedMaePct: num(t.mae_pct),
      returnPct: num(t.return_pct),
      exitReason: t.exit_reason == null ? null : String(t.exit_reason),
      enteredAtMs: num(t.entered_at_ms),
      exitAtMs: num(t.exit_at_ms),
      status: t.status == null ? null : String(t.status),
    };
  });
}
