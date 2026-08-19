import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/query-plans — does production actually use the indexes we added?
 *
 * The 2026-08-18 performance audit kept hitting the same wall: a query would be slow in
 * production, an index would obviously fix it, the index would be added — and the route
 * would still be slow, with no way to tell from outside whether the index was missing,
 * present but unused, or present and used but beside the point.
 *
 * Guessing at that costs a deploy per guess. This reports it directly: the indexes that
 * exist on the hot tables, and SQLite's actual chosen plan for the handful of queries
 * that dominate the owner-facing pages.
 *
 * EXPLAIN QUERY PLAN executes nothing. It compiles the statement and returns the
 * planner's decision, so this route reads no rows, writes nothing, spends no provider or
 * AI budget, and cannot affect any scan, gate, ranking, contract, target, stop, exit or
 * delivery. Owner-gated like every other diagnostic.
 */

/** The queries that actually decide how the private app feels, verbatim from their call sites. */
const HOT_QUERIES: Array<{ id: string; why: string; sql: string; params: unknown[] }> = [
  {
    id: "shadow_lane_outcomes",
    why: "Quant Lab shadow lanes. Measured at 34.3s and 7.1s to return 145 and 89 rows.",
    sql: `SELECT return_60m, mfe_pct, mae_pct, t1_hit, t2_hit, stop_hit, data_status, strategy, entry_quality_verdict, path
          FROM options_shadow_outcomes WHERE would_send=? AND path IN ('proposed','independent')`,
    params: [1],
  },
  {
    id: "supervisor_observation_count",
    why: "Quant Lab supervisor tile. One number over 3.7M rows.",
    sql: "SELECT COUNT(*) n FROM options_shadow_decisions WHERE path='supervisor'",
    params: [],
  },
  {
    id: "paper_trade_by_alert",
    why: "Paper chain, once per SENT alert.",
    sql: "SELECT * FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' ORDER BY id ASC",
    params: ["probe"],
  },
  {
    id: "lifecycle_candidate_lookup",
    why: "Paper lifecycle, once per alert, over 92k candidate rows with SELECT *.",
    sql: `SELECT * FROM options_candidates
          WHERE symbol=? AND UPPER(COALESCE(state,'')) IN ('READY','SELECTED')
            AND created_at_ms <= ? ORDER BY id DESC LIMIT 1`,
    params: ["SPY", 9_000_000_000_000],
  },
  {
    id: "marks_by_contract",
    why: "Ranked-setups premium series fallback over the 320k-row marks table.",
    sql: `SELECT COALESCE(exit_fill, (bid+ask)/2.0) m FROM options_paper_marks
          WHERE option_symbol=? ORDER BY mark_at_ms ASC LIMIT 24`,
    params: ["probe"],
  },
  {
    id: "case_by_alert",
    why: "Opportunity case resolution, once per alert, over 59k cases.",
    sql: "SELECT opportunity_id FROM opportunity_cases WHERE alert_id=? ORDER BY updated_at_ms DESC LIMIT 1",
    params: ["probe"],
  },
];

const HOT_TABLES = [
  "options_shadow_outcomes",
  "options_shadow_decisions",
  "options_paper_trades",
  "options_paper_marks",
  "options_candidates",
  "options_alerts",
  "opportunity_cases",
];

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const db = getDb() as unknown as {
      prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown };
    };

    const indexes: Record<string, string[]> = {};
    for (const table of HOT_TABLES) {
      try {
        indexes[table] = (db.prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name",
        ).all(table) as { name: string }[]).map((r) => r.name);
      } catch {
        indexes[table] = ["<unreadable>"];
      }
    }

    // Has ANALYZE ever run? Without sqlite_stat1 the planner has no selectivity
    // information and can reasonably prefer a full scan over a highly selective index,
    // which is exactly the failure this route was built to distinguish.
    let analyzed: { present: boolean; tables: string[] } = { present: false, tables: [] };
    try {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'").get();
      if (has) {
        const rows = db.prepare("SELECT DISTINCT tbl FROM sqlite_stat1 ORDER BY tbl").all() as { tbl: string }[];
        analyzed = { present: true, tables: rows.map((r) => r.tbl) };
      }
    } catch { /* absence is the answer */ }

    const plans = HOT_QUERIES.map((q) => {
      try {
        const rows = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[];
        const detail = rows.map((r) => r.detail);
        return {
          id: q.id,
          why: q.why,
          plan: detail,
          usesIndex: detail.some((d) => /USING (COVERING )?INDEX/i.test(d)),
          fullScan: detail.some((d) => /^SCAN /i.test(d)),
          tempSort: detail.some((d) => /TEMP B-TREE/i.test(d)),
        };
      } catch (err) {
        return { id: q.id, why: q.why, plan: [], error: String((err as Error)?.message ?? err).slice(0, 200) };
      }
    });

    const scanning = plans.filter((p) => (p as { fullScan?: boolean }).fullScan).map((p) => p.id);

    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      indexes,
      analyze: {
        ...analyzed,
        note: analyzed.present
          ? "sqlite_stat1 exists, so the planner has selectivity statistics for the tables listed."
          : "ANALYZE has never run. Without sqlite_stat1 the planner works from heuristics only and "
            + "may prefer a full scan over a highly selective index. If a hot query below reports "
            + "fullScan despite a matching index existing, this is the first thing to suspect.",
      },
      plans,
      verdict: scanning.length
        ? `FULL SCAN on: ${scanning.join(", ")}`
        : "No hot query is doing a full table scan.",
      safety: {
        readOnly: true,
        note: "EXPLAIN QUERY PLAN compiles without executing. No row is read or written, no provider "
          + "or AI budget is spent, and nothing here is consulted by any scanner, gate or delivery path.",
      },
    }, { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
