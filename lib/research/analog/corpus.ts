/**
 * corpus.ts — ANALOG_CORPUS_V1. Load an evidence-classed analog corpus from the store.
 *
 * ── One loader, one class per call ───────────────────────────────────────────
 *
 * `loadAnalogCorpusOnDb` takes the class as an ARGUMENT and returns only that class. There
 * is deliberately no "load everything" mode. A caller that wants two populations has to ask
 * twice and is then holding two arrays it cannot accidentally concatenate into one
 * probability — `assertSingleEvidenceClass` would throw if it tried.
 *
 * ── What each class actually maps to ─────────────────────────────────────────
 *
 *   HISTORICAL_UNDERLYING_ONLY  episode_labels.outcome_kind='REAL_UNDERLYING'
 *                               → 11,679 rows in production, the ENTIRE analog corpus
 *   MODELED_OPTION              episode_labels.outcome_kind='MODELED_OPTION'
 *                               → 0 rows in production; mapped so it can never be
 *                                 mistaken for exact evidence if it ever fills
 *   FORWARD_EXACT_OPTION        episode_outcome_labels_v2 label_kind='EXACT_OPTION_EXECUTABLE_LABEL'
 *   FORWARD_UNDERLYING_ONLY     episode_outcome_labels_v2 label_kind='UNDERLYING_LABEL'
 *
 * HISTORICAL_EXACT_OPTION and PAPER_DELIVERED_FORWARD are NOT loaded here. They already
 * have their own mature cohort engines — `historical/cohort-v2.ts` and
 * `options/cohort-probability.ts` — with their own entry conventions and their own floors.
 * Re-deriving them through this loader would create a second, subtly different reading of
 * populations that are already correctly measured, which is exactly the duplication this
 * whole layer exists to avoid.
 *
 * ── Censoring is preserved ───────────────────────────────────────────────────
 *
 * V2 carries `censored` and `terminal_return_pct`. A censored label loads with
 * `outcome: null`. It stays in the corpus (it is a real observation and it belongs in the
 * denominator of "how much of what we watched actually resolved") but it can never enter a
 * rate.
 *
 * ── The label window, not the decision time, is the fence ────────────────────
 *
 * `labelEndMs` comes from `label_as_of_ms` — the last instant the label consulted. That is
 * the value retrieval fences on, because an episode that STARTED before the query but was
 * still resolving at T0 carries information the query could not have had.
 */
import {
  ANALOG_FEATURE_VECTOR_VERSION,
  vectorFromEpisodeRow,
  type AnalogFeatureVector,
} from "./feature-vector.ts";
import {
  ANALOG_FEATURE_VECTOR_V2_VERSION,
  vectorFromV2EpisodeRow,
} from "./feature-vector-v2.ts";
import type { AnalogEvidenceClass } from "./evidence-class.ts";
import type { AnalogCorpusMember } from "./retrieval.ts";

export const ANALOG_CORPUS_VERSION = "ANALOG_CORPUS_V1";

interface CorpusDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

export interface LoadCorpusOptions {
  evidenceClass: AnalogEvidenceClass;
  /** Label horizon (e.g. "5d", "1d", "30m"). */
  horizon?: string;
  /** Hard cap so a research query can never walk a multi-GB table unbounded. */
  limit?: number;
  /**
   * Which feature-vector version this corpus is built in. A corpus is SINGLE-VERSION for
   * the same reason it is single-class: V1 and V2 share dimension names and do not share
   * estimators, so one metric fitted across both would be fitted on nothing. Rows of the
   * other version are counted in `droppedByVectorVersion`, never silently discarded.
   *
   * Defaults per class: HISTORICAL_* / MODELED_OPTION → V1 (their rows are episode_version
   * 1 replay rows); FORWARD_* → V2 (their labels only ever attach to episode_version 2).
   */
  vectorVersion?: string;
}

export interface LoadedCorpus {
  corpusVersion: string;
  evidenceClass: AnalogEvidenceClass;
  horizon: string | null;
  /** The single feature-vector version every member is built in. */
  vectorVersion: string;
  members: AnalogCorpusMember[];
  /** Rows the query returned before vector/comparability filtering. */
  rowsRead: number;
  /** Rows dropped because their vector lacked a REQUIRED comparability key. */
  droppedIncomparable: number;
  /** Rows dropped because they belong to the other feature-vector version. */
  droppedByVectorVersion: number;
  /** Rows dropped because t0 or the label window was not a finite timestamp. */
  droppedUnusableTimestamps: number;
  /** Members whose outcome is unresolved. */
  censoredCount: number;
  /**
   * Which label horizons this corpus actually contains. MORE THAN ONE IS A MIXED CORPUS:
   * the same episode appears once per horizon with the same T0 vector and a different
   * outcome, so the metric is fitted on each setup repeatedly and a 5-minute result lands
   * in the same rate as a session-long one. Pass `horizon` to load a single one.
   */
  horizonsPresent: string[];
  /** True when `horizonsPresent.length > 1`. */
  mixedHorizons: boolean;
  /** Repeated episode_keys — non-zero exactly when the corpus is horizon-mixed. */
  duplicateMemberIds: number;
  /** True when `limit` truncated the read — a silently capped corpus is a lie about N. */
  truncated: boolean;
  /** Empty-or-missing-table reason, when applicable. */
  note: string | null;
}

const DEFAULT_LIMIT = 20_000;

function tableExists(db: CorpusDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function tradingDayOf(row: any, t0Ms: number): string {
  if (typeof row.trading_day === "string" && row.trading_day) return row.trading_day;
  // Eastern calendar date of the decision instant. `countIndependentSessions` validates it.
  return new Date(t0Ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

interface AssembleResult {
  members: AnalogCorpusMember[];
  droppedIncomparable: number;
  droppedByVectorVersion: number;
  droppedUnusableTimestamps: number;
  censoredCount: number;
  horizonsPresent: string[];
  duplicateMemberIds: number;
}

function assemble(
  rows: any[],
  evidenceClass: AnalogEvidenceClass,
  vectorOf: (row: any) => AnalogFeatureVector,
  outcomeOf: (row: any) => number | null,
  vectorVersion: string,
): AssembleResult {
  const members: AnalogCorpusMember[] = [];
  let droppedIncomparable = 0;
  let droppedByVectorVersion = 0;
  let droppedUnusableTimestamps = 0;
  let censoredCount = 0;
  for (const row of rows) {
    const vector = vectorOf(row);
    // A version the caller did not ask for is not a defective row. It is a row that
    // belongs to the other corpus, and it is counted separately so "we found nothing"
    // and "we found the other version" can never read the same.
    if (vector.version !== vectorVersion) { droppedByVectorVersion++; continue; }
    if (!vector.comparable) { droppedIncomparable++; continue; }
    const t0Ms = Number(row.t0_ms);
    const labelEndMs = Number(row.label_as_of_ms);
    if (!Number.isFinite(t0Ms) || !Number.isFinite(labelEndMs)) { droppedUnusableTimestamps++; continue; }
    const outcome = outcomeOf(row);
    if (outcome === null) censoredCount++;
    members.push({
      id: String(row.episode_key),
      symbol: String(row.symbol),
      t0Ms,
      labelEndMs,
      tradingDay: tradingDayOf(row, t0Ms),
      evidenceClass,
      horizon: row.horizon == null ? null : String(row.horizon),
      vector,
      outcome,
    });
  }
  // Deterministic order: chronological, id tiebreak.
  members.sort((a, b) => (a.t0Ms - b.t0Ms) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // A repeated episode_key means one episode contributed several rows — in practice one
  // per horizon. It is reported rather than deduplicated here, because which horizon to
  // keep is the CALLER'S question and silently picking one would answer it for them.
  const seen = new Set<string>();
  let duplicateMemberIds = 0;
  for (const m of members) { if (seen.has(m.id)) duplicateMemberIds++; else seen.add(m.id); }
  return {
    members, droppedIncomparable, droppedByVectorVersion, droppedUnusableTimestamps, censoredCount,
    horizonsPresent: [...new Set(members.map((m) => m.horizon ?? "(none)"))].sort(),
    duplicateMemberIds,
  };
}

/**
 * Which vector a row is built in, decided by the row itself rather than by the caller.
 * `episode_version = 2` rows carry Zone-A JSON and a structurally null `liquidity_tier`;
 * anything else is a V1 replay row with per-block columns.
 */
export function vectorForEpisodeRow(row: Record<string, any>): AnalogFeatureVector {
  return Number(row.episode_version) === 2 ? vectorFromV2EpisodeRow(row) : vectorFromEpisodeRow(row);
}

function defaultVectorVersionFor(cls: AnalogEvidenceClass): string {
  return cls === "FORWARD_EXACT_OPTION" || cls === "FORWARD_UNDERLYING_ONLY"
    ? ANALOG_FEATURE_VECTOR_V2_VERSION
    : ANALOG_FEATURE_VECTOR_VERSION;
}

const finite = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Load exactly one evidence class. Never returns a mixed population. */
export function loadAnalogCorpusOnDb(db: CorpusDb, options: LoadCorpusOptions): LoadedCorpus {
  const { evidenceClass } = options;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const horizon = options.horizon ?? null;
  const vectorVersion = options.vectorVersion ?? defaultVectorVersionFor(evidenceClass);
  const empty = (note: string): LoadedCorpus => ({
    corpusVersion: ANALOG_CORPUS_VERSION, evidenceClass, horizon, vectorVersion, members: [],
    rowsRead: 0, droppedIncomparable: 0, droppedByVectorVersion: 0, droppedUnusableTimestamps: 0,
    censoredCount: 0, horizonsPresent: [], mixedHorizons: false, duplicateMemberIds: 0,
    truncated: false, note,
  });

  if (evidenceClass === "HISTORICAL_UNDERLYING_ONLY" || evidenceClass === "MODELED_OPTION") {
    if (!tableExists(db, "episode_labels") || !tableExists(db, "setup_episodes")) {
      return empty("episode_labels / setup_episodes not present in this database");
    }
    const outcomeKind = evidenceClass === "MODELED_OPTION" ? "MODELED_OPTION" : "REAL_UNDERLYING";
    const params: any[] = [outcomeKind];
    let where = "l.outcome_kind = ? AND l.target_kind = 'UNDERLYING'";
    if (evidenceClass === "MODELED_OPTION") where = "l.outcome_kind = ?";
    if (horizon) { where += " AND l.horizon = ?"; params.push(horizon); }
    const rows = db.prepare(
      `SELECT e.episode_key, e.symbol, e.t0_ms, e.trading_day, e.direction, e.liquidity_tier,
              e.episode_version, e.zone_a_json,
              e.price_structure_json, e.momentum_json, e.volume_json, e.volatility_json,
              l.horizon, l.return_pct, l.label_as_of_ms
       FROM setup_episodes e
       JOIN episode_labels l ON l.episode_key = e.episode_key
       WHERE ${where} AND l.label_as_of_ms IS NOT NULL
       ORDER BY e.t0_ms ASC, e.episode_key ASC
       LIMIT ?`,
    ).all(...params, limit + 1) as any[];
    const truncated = rows.length > limit;
    const use = truncated ? rows.slice(0, limit) : rows;
    const a = assemble(use, evidenceClass, vectorForEpisodeRow, (r) => finite(r.return_pct), vectorVersion);
    return {
      corpusVersion: ANALOG_CORPUS_VERSION, evidenceClass, horizon, vectorVersion,
      members: a.members,
      rowsRead: use.length,
      droppedIncomparable: a.droppedIncomparable,
      droppedByVectorVersion: a.droppedByVectorVersion,
      droppedUnusableTimestamps: a.droppedUnusableTimestamps,
      censoredCount: a.censoredCount,
      horizonsPresent: a.horizonsPresent,
      mixedHorizons: a.horizonsPresent.length > 1,
      duplicateMemberIds: a.duplicateMemberIds,
      truncated,
      note: truncated
        ? `read capped at ${limit} rows; N is a floor, not the population`
        : a.horizonsPresent.length > 1
          ? `MIXED HORIZONS (${a.horizonsPresent.join(", ")}): ${a.duplicateMemberIds} rows repeat an episode_key. ` +
            "Pass ?horizon= to load one; a mixed corpus fits the metric on each setup once per horizon."
          : null,
    };
  }

  if (evidenceClass === "FORWARD_EXACT_OPTION" || evidenceClass === "FORWARD_UNDERLYING_ONLY") {
    if (!tableExists(db, "episode_outcome_labels_v2") || !tableExists(db, "setup_episodes")) {
      return empty("episode_outcome_labels_v2 / setup_episodes not present in this database");
    }
    const labelKind = evidenceClass === "FORWARD_EXACT_OPTION"
      ? "EXACT_OPTION_EXECUTABLE_LABEL"
      : "UNDERLYING_LABEL";
    const params: any[] = [labelKind];
    let where = "l.label_kind = ?";
    if (horizon) { where += " AND l.horizon = ?"; params.push(horizon); }
    const rows = db.prepare(
      `SELECT e.episode_key, e.symbol, e.t0_ms, e.trading_day, e.direction, e.liquidity_tier,
              e.episode_version,
              e.price_structure_json, e.momentum_json, e.volume_json, e.volatility_json,
              e.zone_a_json,
              l.horizon, l.terminal_return_pct, l.censored, l.label_as_of_ms
       FROM setup_episodes e
       JOIN episode_outcome_labels_v2 l ON l.episode_key = e.episode_key
       WHERE ${where} AND l.label_as_of_ms IS NOT NULL
       ORDER BY e.t0_ms ASC, e.episode_key ASC
       LIMIT ?`,
    ).all(...params, limit + 1) as any[];
    const truncated = rows.length > limit;
    const use = truncated ? rows.slice(0, limit) : rows;
    const a = assemble(
      use, evidenceClass, vectorForEpisodeRow,
      // A censored label has NO outcome. `terminal_return_pct` may still be non-null on a
      // censored row (a partial path), and treating it as the realized outcome would put a
      // truncated observation into a completed-outcome rate.
      (r) => (Number(r.censored) === 1 ? null : finite(r.terminal_return_pct)),
      vectorVersion,
    );
    return {
      corpusVersion: ANALOG_CORPUS_VERSION, evidenceClass, horizon, vectorVersion,
      members: a.members,
      rowsRead: use.length,
      droppedIncomparable: a.droppedIncomparable,
      droppedByVectorVersion: a.droppedByVectorVersion,
      droppedUnusableTimestamps: a.droppedUnusableTimestamps,
      censoredCount: a.censoredCount,
      horizonsPresent: a.horizonsPresent,
      mixedHorizons: a.horizonsPresent.length > 1,
      duplicateMemberIds: a.duplicateMemberIds,
      truncated,
      note: truncated
        ? `read capped at ${limit} rows; N is a floor, not the population`
        : a.horizonsPresent.length > 1
          ? `MIXED HORIZONS (${a.horizonsPresent.join(", ")}): ${a.duplicateMemberIds} rows repeat an episode_key. ` +
            "Pass ?horizon= to load one; a mixed corpus fits the metric on each setup once per horizon."
          : null,
    };
  }

  return empty(
    `${evidenceClass} is not loaded by this module: it has its own cohort engine ` +
      "(historical/cohort-v2.ts for HISTORICAL_EXACT_OPTION, options/cohort-probability.ts for " +
      "PAPER_DELIVERED_FORWARD, shadow/store.ts for SHADOW_OBSERVATION). Re-deriving it here " +
      "would create a second reading of an already-measured population.",
  );
}

/**
 * V1-shaped Zone-A fallback, RETIRED.
 *
 * `vectorFromV2Row` used to try the V1 per-block columns and then fall back to
 * `zone_a_json`, and it is what produced the 6,935 NOT_COMPARABLE_VECTOR rejections: it
 * still demanded `cmp_liquidity`, which no V2 row has or can have. Its replacement is
 * `feature-vector-v2.ts::vectorFromV2EpisodeRow`, selected per row by `vectorForEpisodeRow`
 * on `episode_version`. Nothing referenced the old function once that landed, so it is gone
 * rather than left as a second way to build the same vector.
 */

/** Per-class inventory for the research surface. Bounded: counts only, no rows. */
export function analogCorpusInventoryOnDb(db: CorpusDb): Array<{
  evidenceClass: string;
  available: boolean;
  rows: number;
  labeled: number;
  censored: number;
  symbols: number;
  tradingDays: number;
  dateFrom: string | null;
  dateTo: string | null;
  note: string | null;
}> {
  const out: ReturnType<typeof analogCorpusInventoryOnDb> = [];
  const push = (evidenceClass: string, sql: string, params: any[], note: string | null) => {
    try {
      const r = db.prepare(sql).get(...params) as any;
      out.push({
        evidenceClass, available: true,
        rows: Number(r?.rows ?? 0), labeled: Number(r?.labeled ?? 0), censored: Number(r?.censored ?? 0),
        symbols: Number(r?.symbols ?? 0), tradingDays: Number(r?.days ?? 0),
        dateFrom: r?.date_from ?? null, dateTo: r?.date_to ?? null, note,
      });
    } catch (e: any) {
      out.push({
        evidenceClass, available: false, rows: 0, labeled: 0, censored: 0, symbols: 0, tradingDays: 0,
        dateFrom: null, dateTo: null, note: `unavailable: ${String(e?.message ?? e).slice(0, 120)}`,
      });
    }
  };

  const v1 = (kind: string) =>
    `SELECT COUNT(*) rows, SUM(CASE WHEN l.return_pct IS NOT NULL THEN 1 ELSE 0 END) labeled,
            SUM(CASE WHEN l.return_pct IS NULL THEN 1 ELSE 0 END) censored,
            COUNT(DISTINCT e.symbol) symbols, COUNT(DISTINCT e.trading_day) days,
            MIN(e.trading_day) date_from, MAX(e.trading_day) date_to
     FROM setup_episodes e JOIN episode_labels l ON l.episode_key = e.episode_key
     WHERE l.outcome_kind = '${kind}'`;
  const v2 = () =>
    `SELECT COUNT(*) rows, SUM(CASE WHEN l.censored = 0 THEN 1 ELSE 0 END) labeled,
            SUM(CASE WHEN l.censored = 1 THEN 1 ELSE 0 END) censored,
            COUNT(DISTINCT e.symbol) symbols, COUNT(DISTINCT e.trading_day) days,
            MIN(e.trading_day) date_from, MAX(e.trading_day) date_to
     FROM setup_episodes e JOIN episode_outcome_labels_v2 l ON l.episode_key = e.episode_key
     WHERE l.label_kind = ?`;

  push("HISTORICAL_UNDERLYING_ONLY", v1("REAL_UNDERLYING"), [], null);
  push("MODELED_OPTION", v1("MODELED_OPTION"), [], "modeled fills are never exact-option evidence");
  push("FORWARD_EXACT_OPTION", v2(), ["EXACT_OPTION_EXECUTABLE_LABEL"], null);
  push("FORWARD_UNDERLYING_ONLY", v2(), ["UNDERLYING_LABEL"], null);
  return out;
}

/**
 * Per-symbol / per-session breadth of the replay corpus — the answer to "is the corpus
 * three tickers or thirty", which the class-level inventory cannot give.
 *
 * Bounded by `limit` symbols and returns aggregates only, never rows.
 */
export function analogCorpusBreadthOnDb(
  db: CorpusDb,
  opts: { evidenceClass?: AnalogEvidenceClass; limit?: number } = {},
): {
  evidenceClass: AnalogEvidenceClass;
  symbols: Array<{ symbol: string; episodes: number; tradingDays: number; dateFrom: string; dateTo: string; sources: string }>;
  horizons: Array<{ horizon: string; rows: number; symbols: number; tradingDays: number }>;
  sources: Array<{ source: string; episodes: number; symbols: number; tradingDays: number }>;
  truncated: boolean;
  note: string | null;
} {
  const evidenceClass = opts.evidenceClass ?? "HISTORICAL_UNDERLYING_ONLY";
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const kind = evidenceClass === "MODELED_OPTION" ? "MODELED_OPTION" : "REAL_UNDERLYING";
  const many = <T>(sql: string, params: any[]): T[] => {
    try { return (db.prepare(sql).all(...params) ?? []) as T[]; } catch { return []; }
  };
  const symbols = many<any>(
    `SELECT e.symbol, COUNT(*) episodes, COUNT(DISTINCT e.trading_day) days,
            MIN(e.trading_day) date_from, MAX(e.trading_day) date_to,
            GROUP_CONCAT(DISTINCT e.source) sources
       FROM setup_episodes e JOIN episode_labels l ON l.episode_key = e.episode_key
      WHERE l.outcome_kind = ?
      GROUP BY e.symbol ORDER BY episodes DESC LIMIT ?`,
    [kind, limit + 1],
  );
  const truncated = symbols.length > limit;
  const horizons = many<any>(
    `SELECT l.horizon, COUNT(*) rows, COUNT(DISTINCT e.symbol) symbols, COUNT(DISTINCT e.trading_day) days
       FROM setup_episodes e JOIN episode_labels l ON l.episode_key = e.episode_key
      WHERE l.outcome_kind = ? GROUP BY l.horizon ORDER BY l.horizon`,
    [kind],
  );
  const sources = many<any>(
    `SELECT e.source, COUNT(DISTINCT e.episode_key) episodes, COUNT(DISTINCT e.symbol) symbols,
            COUNT(DISTINCT e.trading_day) days
       FROM setup_episodes e JOIN episode_labels l ON l.episode_key = e.episode_key
      WHERE l.outcome_kind = ? GROUP BY e.source ORDER BY episodes DESC`,
    [kind],
  );
  return {
    evidenceClass,
    symbols: (truncated ? symbols.slice(0, limit) : symbols).map((r) => ({
      symbol: String(r.symbol), episodes: Number(r.episodes), tradingDays: Number(r.days),
      dateFrom: String(r.date_from ?? ""), dateTo: String(r.date_to ?? ""), sources: String(r.sources ?? ""),
    })),
    horizons: horizons.map((r) => ({
      horizon: String(r.horizon), rows: Number(r.rows), symbols: Number(r.symbols), tradingDays: Number(r.days),
    })),
    sources: sources.map((r) => ({
      source: String(r.source), episodes: Number(r.episodes), symbols: Number(r.symbols), tradingDays: Number(r.days),
    })),
    truncated,
    note: truncated ? `symbol listing capped at ${limit}` : null,
  };
}
