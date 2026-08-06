/**
 * Loads verified executable outcomes out of the paper-trade store into the pure
 * segmentation model.
 *
 * The audited -7.2% expectancy was a POPULATION number. This is the query that lets it be
 * broken apart by strategy and version, which is the prerequisite for quarantining
 * anything specific instead of everything.
 *
 * Zero provider calls. Read-only. `paper_kind` is the structural audience separator:
 * DELIVERED_ALERT_PAPER is the exact mirror of alerts subscribers actually received.
 */
import type { OutcomeRow } from "./strategy-performance.ts";
import { isIndexSymbol } from "./discovery.ts";
import { loadMarkEvidenceOnDb } from "./mark-evidence-loader.ts";
import { excursionIsTrustworthy } from "./mark-evidence.ts";

export interface PerfDb {
  prepare(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
}

function hasTable(db: PerfDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function columns(db: PerfDb, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => String(c.name)));
  } catch {
    return new Set();
  }
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

/** Underlying ticker out of an OCC symbol: "O:SPY260807P00770000" -> "SPY". */
export function underlyingFromOcc(occ: string | null): string | null {
  if (!occ) return null;
  const m = /^O:([A-Z]+)\d{6}[CP]\d+$/.exec(String(occ).trim().toUpperCase());
  return m ? m[1] : null;
}

export interface LoadOptions {
  /** Only rows entered at or after this time. */
  sinceMs?: number | null;
  /** Restrict to specific paper_kind lanes. Default: all. */
  lanes?: string[] | null;
  limit?: number;
}

/**
 * Read outcomes. Legacy databases are handled by checking for each optional column, so a
 * database that predates experiment/thesis attribution still loads rather than throwing.
 */
export function loadOutcomeRowsOnDb(db: PerfDb, opts: LoadOptions = {}): OutcomeRow[] {
  if (!hasTable(db, "options_paper_trades")) return [];
  const cols = columns(db, "options_paper_trades");
  const has = (c: string) => cols.has(c);
  const pick = (c: string, alias = c) => (has(c) ? `${c} AS ${alias}` : `NULL AS ${alias}`);

  const select = [
    "id",
    pick("option_symbol"),
    pick("paper_kind"),
    pick("strategy"),
    pick("side"),
    pick("dte"),
    pick("delta"),
    pick("spread_pct"),
    pick("entry_fill"),
    pick("exit_fill"),
    pick("return_pct"),
    pick("mfe_pct"),
    pick("mae_pct"),
    pick("open_interest"),
    pick("volume"),
    pick("entered_at_ms"),
    pick("exit_at_ms"),
    pick("session"),
    pick("status"),
    pick("experiment_id"),
    pick("experiment_variant"),
    pick("feature_snapshot_json"),
    pick("alert_id"),
  ].join(", ");

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceMs != null && has("entered_at_ms")) { where.push("entered_at_ms >= ?"); params.push(opts.sinceMs); }
  if (opts.lanes?.length && has("paper_kind")) {
    where.push(`paper_kind IN (${opts.lanes.map(() => "?").join(",")})`);
    params.push(...opts.lanes);
  }
  const sql = `SELECT ${select} FROM options_paper_trades`
    + (where.length ? ` WHERE ${where.join(" AND ")}` : "")
    + (has("entered_at_ms") ? " ORDER BY entered_at_ms DESC" : "")
    + ` LIMIT ${Math.max(1, Math.min(50_000, opts.limit ?? 20_000))}`;

  let rows: any[] = [];
  try { rows = db.prepare(sql).all(...params) as any[]; } catch { return []; }

  // Join the OBSERVATION-SERIES verdict. Without this, excursion trustworthiness is
  // inferred from two summary fields; with it, it is derived from how many distinct
  // post-entry observations actually exist. That distinction is the whole reason the
  // earlier performance numbers could not be trusted.
  const evidenceByTrade = new Map<number, { trustworthy: boolean; immediateFailureUsable: boolean; state: string }>();
  try {
    for (const e of loadMarkEvidenceOnDb(db as any, { sinceMs: opts.sinceMs ?? null, limit: 20_000 })) {
      evidenceByTrade.set(e.tradeId, {
        trustworthy: excursionIsTrustworthy(e.state),
        immediateFailureUsable: e.permissions.immediateFailure,
        state: e.state,
      });
    }
  } catch { /* absent evidence falls back to the summary-field heuristic */ }

  return rows.map((r) => {
    // Latency and premium expansion live in the feature snapshot when they were captured
    // at all. Absent means absent — it is never defaulted to zero.
    let snap: any = null;
    try { snap = r.feature_snapshot_json ? JSON.parse(String(r.feature_snapshot_json)) : null; } catch { snap = null; }
    const symbol = underlyingFromOcc(str(r.option_symbol));
    const sessionDate = str(r.session) ?? (r.entered_at_ms
      ? new Date(Number(r.entered_at_ms)).toISOString().slice(0, 10)
      : null);
    return {
      tradeId: Number(r.id),
      lane: str(r.paper_kind) ?? "LEGACY_UNCLASSIFIED",
      strategy: str(r.strategy),
      // These attributions did not exist as columns; when a snapshot carries them we use
      // them, otherwise the segment key reports "unknown" rather than inventing a version.
      strategyVersion: str(snap?.strategyVersion) ?? str(snap?.strategy_version),
      selectionVersion: str(snap?.selectionVersion) ?? str(snap?.selection_version),
      rankingVersion: str(snap?.rankingVersion) ?? str(snap?.ranking_version),
      deploymentSha: str(snap?.deploymentSha) ?? str(snap?.deployment_sha),
      direction: str(r.side),
      symbol,
      isIndexSymbol: symbol ? isIndexSymbol(symbol) : null,
      dte: num(r.dte),
      delta: num(r.delta),
      spreadPct: num(r.spread_pct),
      entryFill: num(r.entry_fill),
      exitFill: num(r.exit_fill),
      returnPct: num(r.return_pct),
      mfePct: num(r.mfe_pct),
      maePct: num(r.mae_pct),
      openInterest: num(r.open_interest),
      volume: num(r.volume),
      sessionDate,
      enteredAtMs: num(r.entered_at_ms),
      exitAtMs: num(r.exit_at_ms),
      alertLatencyMs: num(snap?.alertLatencyMs) ?? num(snap?.captureToNotifyMs),
      premiumExpansionPct: num(snap?.premiumExpansionPct) ?? num(snap?.premiumChasePct),
      marketRegime: str(snap?.marketRegime) ?? str(snap?.regime),
      excursionTrustworthy: evidenceByTrade.get(Number(r.id))?.trustworthy ?? null,
      immediateFailureUsable: evidenceByTrade.get(Number(r.id))?.immediateFailureUsable ?? null,
      markEvidenceState: evidenceByTrade.get(Number(r.id))?.state ?? null,
    } satisfies OutcomeRow;
  });
}
