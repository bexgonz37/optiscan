/**
 * statistics-store.ts — persistence + grouping for the authoritative statistics.
 *
 * Reads ONLY the Phase-1 `paper_trade_outcomes` layer (never the legacy gross-P&L
 * `trade_outcomes`). The math lives in the pure `setup-statistics.ts`; this module
 * enriches each outcome with its frozen fingerprint dimensions, groups by every
 * supported cut, and materializes the results into `authoritative_statistics`
 * with an idempotent, watermark-aware refresh.
 *
 * The `*OnDb` core takes a better-sqlite3 handle so it is unit-testable; the public
 * wrappers resolve `@/lib/db` lazily so the module stays node-importable.
 */
import {
  summarizeOutcomes,
  aggregateBy,
  STATISTICS_VERSION,
  type OutcomeStat,
  type SetupStatistics,
} from "./setup-statistics.ts";

/** OutcomeStat enriched with grouping fields (extra keys ignored by the math). */
interface EnrichedOutcome extends OutcomeStat {
  _fingerprintId: string | null;
  _fingerprintVersion: number | null;
  _strategy: string | null;
  _strategyVersion: number | null;
  _instrument: string | null;
  _selectorProfile: string | null;
  _session: string | null;
  _direction: string | null;
  _dims: Record<string, string | null>;
}

function safeParse(raw: string | null | undefined): Record<string, string | null> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** Read all outcomes joined to their frozen fingerprint dimensions. */
export function enrichedOutcomesOnDb(db: any): EnrichedOutcome[] {
  const rows = db.prepare(
    `SELECT o.*, f.dimensions_json AS dims_json
     FROM paper_trade_outcomes o
     LEFT JOIN setup_fingerprints f ON f.fingerprint_id = o.fingerprint_id
     ORDER BY o.exit_time_ms ASC, o.id ASC`,
  ).all() as any[];
  return rows.map((r) => ({
    grade: r.grade,
    gradingStatus: r.grading_status,
    dataQualityStatus: r.data_quality_status ?? null,
    netPnl: r.net_pnl ?? null,
    grossPnl: r.gross_pnl ?? null,
    returnPct: r.return_pct ?? null,
    rMultiple: r.r_multiple ?? null,
    entryFees: r.entry_fees ?? null,
    exitFees: r.exit_fees ?? null,
    entrySlippage: r.entry_slippage ?? null,
    exitSlippage: r.exit_slippage ?? null,
    holdMinutes: r.hold_minutes ?? null,
    mfePct: r.mfe_pct ?? null,
    maePct: r.mae_pct ?? null,
    exitTimeMs: r.exit_time_ms ?? null,
    _fingerprintId: r.fingerprint_id ?? null,
    _fingerprintVersion: r.fingerprint_version ?? null,
    _strategy: r.strategy ?? null,
    _strategyVersion: r.strategy_version ?? null,
    _instrument: r.instrument_type ?? null,
    _selectorProfile: r.selector_profile ?? null,
    _session: r.entry_session ?? null,
    _direction: r.direction ?? null,
    _dims: safeParse(r.dims_json),
  }));
}

/** The supported group cuts. Each maps an enriched outcome to a group key. */
const GROUP_CUTS: Record<string, (o: EnrichedOutcome) => string | null> = {
  fingerprint: (o) => o._fingerprintId,
  strategy: (o) => o._strategy,
  strategy_version: (o) => (o._strategy ? `${o._strategy}@${o._strategyVersion ?? 0}` : null),
  instrument: (o) => o._instrument,
  selector_profile: (o) => o._selectorProfile,
  session: (o) => o._session,
  direction: (o) => o._direction,
  tod_bucket: (o) => o._dims.todBucket ?? null,
  dte_bucket: (o) => o._dims.dteBucket ?? null,
  delta_band: (o) => o._dims.deltaBand ?? null,
  spread_band: (o) => o._dims.spreadBand ?? null,
  rel_vol_bucket: (o) => o._dims.relVolBucket ?? null,
  vwap_state: (o) => o._dims.vwapState ?? null,
  move_classification: (o) => o._dims.moveClassification ?? null,
};

export interface StatRecord {
  groupKind: string;
  groupKey: string;
  stats: SetupStatistics;
  fingerprintVersion: number | null;
  strategyVersion: number | null;
}

/** Compute overall + all grouped statistics (pure over the enriched rows). */
export function computeAllStatistics(outcomes: EnrichedOutcome[]): StatRecord[] {
  const out: StatRecord[] = [];
  out.push({ groupKind: "overall", groupKey: "all", stats: summarizeOutcomes(outcomes), fingerprintVersion: null, strategyVersion: null });
  for (const [kind, keyOf] of Object.entries(GROUP_CUTS)) {
    const present = outcomes.filter((o) => keyOf(o) != null);
    if (!present.length) continue;
    for (const { key, stats } of aggregateBy(present, (o) => keyOf(o as EnrichedOutcome) as string)) {
      const sample = present.find((o) => keyOf(o) === key);
      out.push({
        groupKind: kind,
        groupKey: key,
        stats,
        fingerprintVersion: sample?._fingerprintVersion ?? null,
        strategyVersion: sample?._strategyVersion ?? null,
      });
    }
  }
  return out;
}

/** Idempotent refresh of the materialized cache. Watermark = max outcome id. */
export function refreshStatisticsOnDb(db: any, nowMs: number): { groups: number; watermark: number } {
  const outcomes = enrichedOutcomesOnDb(db);
  const watermark = Number((db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM paper_trade_outcomes").get() as any)?.m ?? 0);
  const records = computeAllStatistics(outcomes);

  const upsert = db.prepare(
    `INSERT INTO authoritative_statistics
       (group_kind, group_key, statistics_version, fingerprint_version, strategy_version,
        graded_sample_size, ungradable_count, evidence_state, stats_json, source_watermark, last_refresh_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(group_kind, group_key, statistics_version) DO UPDATE SET
       fingerprint_version=excluded.fingerprint_version,
       strategy_version=excluded.strategy_version,
       graded_sample_size=excluded.graded_sample_size,
       ungradable_count=excluded.ungradable_count,
       evidence_state=excluded.evidence_state,
       stats_json=excluded.stats_json,
       source_watermark=excluded.source_watermark,
       last_refresh_ms=excluded.last_refresh_ms,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  const tx = db.transaction((recs: StatRecord[]) => {
    for (const r of recs) {
      upsert.run(
        r.groupKind, r.groupKey, STATISTICS_VERSION, r.fingerprintVersion, r.strategyVersion,
        r.stats.gradedSampleSize, r.stats.ungradableCount, r.stats.evidenceState,
        JSON.stringify(r.stats), watermark, nowMs,
      );
    }
  });
  tx(records);
  return { groups: records.length, watermark };
}

/** Read materialized statistics for one kind (or all). */
export function listStatisticsOnDb(db: any, kind?: string): Array<{ groupKind: string; groupKey: string; evidenceState: string; gradedSampleSize: number; stats: SetupStatistics; lastRefreshMs: number }> {
  const rows = (kind
    ? db.prepare("SELECT * FROM authoritative_statistics WHERE group_kind=? AND statistics_version=? ORDER BY graded_sample_size DESC").all(kind, STATISTICS_VERSION)
    : db.prepare("SELECT * FROM authoritative_statistics WHERE statistics_version=? ORDER BY group_kind, graded_sample_size DESC").all(STATISTICS_VERSION)) as any[];
  return rows.map((r) => ({
    groupKind: r.group_kind,
    groupKey: r.group_key,
    evidenceState: r.evidence_state,
    gradedSampleSize: r.graded_sample_size,
    stats: JSON.parse(r.stats_json),
    lastRefreshMs: r.last_refresh_ms,
  }));
}

// ── Public wrappers (lazy @/lib/db) ──────────────────────────────────────────

function lazyDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

export function refreshStatistics(nowMs: number = Date.now()): { groups: number; watermark: number } {
  try {
    return refreshStatisticsOnDb(lazyDb(), nowMs);
  } catch (err: any) {
    console.warn("[stats] refresh skipped:", err?.message);
    return { groups: 0, watermark: 0 };
  }
}

export function listStatistics(kind?: string): ReturnType<typeof listStatisticsOnDb> {
  try {
    return listStatisticsOnDb(lazyDb(), kind);
  } catch (err: any) {
    console.warn("[stats] list skipped:", err?.message);
    return [];
  }
}

/**
 * Evidence for one setup fingerprint, sourced from the AUTHORITATIVE layer.
 * Returns NOT_TRACKED when the fingerprint has no graded outcomes yet — the
 * honest default while the sample is empty.
 */
export function evidenceForFingerprint(fingerprintId: string | null): { evidenceState: string; evidenceSummary: string; gradedSampleSize: number } {
  if (!fingerprintId) return { evidenceState: "NOT_TRACKED", evidenceSummary: "No setup fingerprint assigned yet.", gradedSampleSize: 0 };
  try {
    const db = lazyDb();
    const r = db.prepare("SELECT stats_json FROM authoritative_statistics WHERE group_kind='fingerprint' AND group_key=? AND statistics_version=?").get(fingerprintId, STATISTICS_VERSION) as any;
    if (!r) return { evidenceState: "NOT_TRACKED", evidenceSummary: "No graded outcomes recorded for this setup yet.", gradedSampleSize: 0 };
    const s = JSON.parse(r.stats_json) as SetupStatistics;
    return { evidenceState: s.evidenceState, evidenceSummary: s.evidenceSummary, gradedSampleSize: s.gradedSampleSize };
  } catch (err: any) {
    console.warn("[stats] evidence lookup skipped:", err?.message);
    return { evidenceState: "NOT_TRACKED", evidenceSummary: "Evidence unavailable.", gradedSampleSize: 0 };
  }
}
