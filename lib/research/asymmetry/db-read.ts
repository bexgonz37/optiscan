/**
 * High-Asymmetry Radar — read primitives. SELECT-only.
 *
 * Every statement in this file is a SELECT. There is no INSERT, UPDATE, DELETE,
 * CREATE, or ALTER anywhere in the radar, so the replay adds no migration and
 * cannot corrupt a database it is pointed at. Tables are probed first; an
 * absent table yields an empty result and a warning, never an exception.
 *
 * Shared by the Phase 1 cohort loader and the Phase 2 replay so there is
 * exactly ONE piece of SQL per source of truth.
 */
import type { AsymmetryQuoteObservation } from "./evidence.ts";

export interface Db {
  prepare(sql: string): { all: (...args: any[]) => any[]; get: (...args: any[]) => any };
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One persisted research observation, normalized but NOT yet validated. */
export interface AsymmetryObservationRow {
  id: number | null;
  observedAtMs: number | null;
  sessionDate: string | null;
  symbol: string;
  direction: string | null;
  strategyFamily: string | null;
  candidateState: string | null;
  thesisFingerprint: string | null;
  alertId: string | null;
  /** Exactly as persisted — validation happens downstream, never here. */
  occSymbolRaw: string | null;
  optionType: string | null;
  strike: number | null;
  expiration: string | null;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  quoteTimestampMs: number | null;
  quoteAgeMs: number | null;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  dte: number | null;
  underlyingPrice: number | null;
  supportLevel: number | null;
  resistanceLevel: number | null;
  triggerLevel: number | null;
  blockers: string[];
  source: string | null;
  freshnessState: string | null;
}

export function hasTable(db: Db, table: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
}

export function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const textOrNull = (value: unknown): string | null => {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
};

/**
 * Prefers the recorded provider quote timestamp. Falls back to reconstructing
 * it from the recorded age; if neither exists the quote has no event time and
 * is refused downstream rather than assumed current.
 */
export function quoteTimestampFor(row: { quoteTimestampMs: number | null; observedAtMs: number | null; quoteAgeMs: number | null }): number | null {
  if (row.quoteTimestampMs != null) return row.quoteTimestampMs;
  if (row.observedAtMs == null || row.quoteAgeMs == null || row.quoteAgeMs < 0) return null;
  return row.observedAtMs - row.quoteAgeMs;
}

/**
 * Distance from the underlying to the nearest sourced decision level, as a
 * percentage. Null unless both a price and at least one level were persisted.
 */
export function distanceToLevelPct(row: AsymmetryObservationRow): number | null {
  const price = row.underlyingPrice;
  if (price == null || price <= 0) return null;
  const levels = [row.triggerLevel, row.supportLevel, row.resistanceLevel]
    .filter((level): level is number => level != null && level > 0);
  if (!levels.length) return null;
  const nearest = levels.reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a));
  return Math.round(((nearest - price) / price) * 1_000_000) / 10_000;
}

function toRow(raw: any): AsymmetryObservationRow {
  let blockers: string[] = [];
  try {
    const parsed = raw.blockers_json ? JSON.parse(String(raw.blockers_json)) : null;
    if (Array.isArray(parsed)) blockers = parsed.map(String);
  } catch { /* an unparseable blocker list contributes nothing, never a guess */ }

  return {
    id: numberOrNull(raw.id),
    observedAtMs: numberOrNull(raw.observed_at_ms),
    sessionDate: textOrNull(raw.session_date),
    symbol: String(raw.symbol ?? "").trim().toUpperCase(),
    direction: textOrNull(raw.direction),
    strategyFamily: textOrNull(raw.strategy_family),
    candidateState: textOrNull(raw.candidate_state),
    thesisFingerprint: textOrNull(raw.thesis_fingerprint),
    alertId: textOrNull(raw.alert_id),
    occSymbolRaw: textOrNull(raw.option_symbol),
    optionType: textOrNull(raw.option_type),
    strike: numberOrNull(raw.strike),
    expiration: textOrNull(raw.expiration),
    bid: numberOrNull(raw.option_bid),
    ask: numberOrNull(raw.option_ask),
    spreadPct: numberOrNull(raw.spread_pct),
    quoteTimestampMs: numberOrNull(raw.quote_timestamp_ms),
    quoteAgeMs: numberOrNull(raw.quote_age_ms),
    volume: numberOrNull(raw.volume),
    openInterest: numberOrNull(raw.open_interest),
    delta: numberOrNull(raw.delta),
    dte: numberOrNull(raw.dte),
    underlyingPrice: numberOrNull(raw.underlying_price),
    supportLevel: numberOrNull(raw.support_level),
    resistanceLevel: numberOrNull(raw.resistance_level),
    triggerLevel: numberOrNull(raw.trigger_level),
    blockers,
    source: textOrNull(raw.source),
    freshnessState: textOrNull(raw.freshness_state),
  };
}

const OBSERVATION_COLUMNS = [
  "id", "observed_at_ms", "session_date", "symbol", "direction", "strategy_family",
  "candidate_state", "thesis_fingerprint", "alert_id", "blockers_json", "underlying_price",
  "support_level", "resistance_level", "trigger_level", "option_symbol", "option_type", "strike",
  "expiration", "option_bid", "option_ask", "spread_pct", "quote_timestamp_ms", "quote_age_ms",
  "volume", "open_interest", "delta", "dte", "source", "freshness_state",
] as const;

/**
 * Columns a table actually has. A legacy database predating a migration is a
 * normal condition here, not an error: the read selects the intersection and
 * `toRow` leaves anything absent as null. Selecting a column that does not
 * exist would otherwise fail the whole read and look like "no evidence".
 */
function availableColumns(db: Db, table: string): Set<string> {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row: any) => String(row.name)));
  } catch {
    return new Set<string>();
  }
}

/** Trading sessions that have any research observation, newest first. */
export function listAsymmetrySessionsOnDb(db: Db, limit = 30): string[] {
  if (!hasTable(db, "options_research_observations")) return [];
  try {
    return db.prepare(`SELECT DISTINCT session_date FROM options_research_observations
      WHERE session_date IS NOT NULL ORDER BY session_date DESC LIMIT ?`)
      .all(Math.max(1, Math.min(365, limit)))
      .map((row: any) => String(row.session_date))
      .filter((day: string) => DAY_RE.test(day));
  } catch {
    return [];
  }
}

/**
 * Reads one session's observations at or before `evaluationAtMs`.
 *
 * `requireOcc` defaults to true, matching the Phase 1 loader. The coverage
 * audit sets it to false so observations WITHOUT a contract can be counted as
 * an exclusion instead of vanishing from the denominator.
 */
export function readAsymmetryObservationsOnDb(
  db: Db,
  opts: { sessionDate: string; evaluationAtMs: number; requireOcc?: boolean },
): AsymmetryObservationRow[] {
  if (!hasTable(db, "options_research_observations")) return [];
  const present = availableColumns(db, "options_research_observations");
  const selected = OBSERVATION_COLUMNS.filter((column) => present.has(column));
  if (!selected.includes("observed_at_ms") || !selected.includes("session_date")) return [];

  const requireOcc = opts.requireOcc !== false && present.has("option_symbol");
  const order = selected.includes("id") ? "observed_at_ms ASC, id ASC" : "observed_at_ms ASC";
  const sql = `SELECT ${selected.join(", ")}
    FROM options_research_observations
    WHERE session_date=? AND observed_at_ms<=?${requireOcc ? " AND option_symbol IS NOT NULL" : ""}
    ORDER BY ${order}`;
  try {
    return db.prepare(sql).all(opts.sessionDate, opts.evaluationAtMs).map(toRow);
  } catch {
    return [];
  }
}

/**
 * Exact-OCC outcome marks. Matched on `option_symbol`, so a mark can never be
 * attributed to a different contract, and bounded by the evaluation time so
 * future evidence is never read in the first place.
 */
export function readMarksForOccOnDb(
  db: Db,
  occSymbol: string,
  fromMs: number,
  toMs: number,
): AsymmetryQuoteObservation[] {
  if (!hasTable(db, "options_paper_marks")) return [];
  try {
    return db.prepare(`SELECT mark_at_ms, option_symbol, bid, ask, quote_age_ms
      FROM options_paper_marks
      WHERE option_symbol=? AND mark_at_ms>=? AND mark_at_ms<=?
      ORDER BY mark_at_ms ASC`)
      .all(occSymbol, fromMs, toMs)
      .map((row: any) => {
        const atMs = numberOrNull(row.mark_at_ms);
        const age = numberOrNull(row.quote_age_ms);
        return {
          occSymbol: String(row.option_symbol ?? "").trim().toUpperCase(),
          atMs: atMs ?? Number.NaN,
          bid: numberOrNull(row.bid),
          ask: numberOrNull(row.ask),
          // options_paper_marks stores an age, not an event time; the event
          // time is reconstructed from it rather than assumed to be the mark.
          quoteTimestampMs: atMs == null || age == null || age < 0 ? null : atMs - age,
          source: "options_paper_marks",
        };
      });
  } catch {
    return [];
  }
}
