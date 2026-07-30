/**
 * High-Asymmetry Radar — read-only cohort loader.
 *
 * Reads persisted facts ONLY. No writes, no migrations, no provider calls, no
 * scheduler participation. Every table is probed first; an absent table
 * degrades into a warning and an empty cohort, never an exception and never a
 * fabricated row.
 *
 * Sources, and what each can honestly supply:
 *
 *  - `options_research_observations` — prospective, timestamped candidate
 *    evidence: exact OCC, bid/ask, provider quote timestamp, quote age, option
 *    volume, open interest, delta, DTE, strike, expiration, underlying price,
 *    levels, blockers, freshness. This is the candidate row AND, for earlier
 *    observations of the same contract, the premium-chase baseline.
 *  - `options_paper_marks` — exact-OCC bid/ask marks with quote age, used as
 *    outcome marks. Matched by option_symbol, so a mark can never be attributed
 *    to a different contract.
 *
 * What NO persisted source can supply today is left MISSING on purpose:
 * stock volume, relative volume versus the same time of day, volume
 * acceleration, implied volatility and its change, gamma, sector alignment,
 * relative strength, and confirmed catalysts. Those fields stay null with a
 * recorded reason until a real source exists. See `KNOWN_UNSOURCED_FIELDS`.
 */
import { tradingDay } from "../../trading-session.ts";
import { buildAsymmetryResearchReport, type AsymmetryCandidateInput, type AsymmetryResearchReport } from "./report.ts";
import type { AsymmetryQuoteObservation } from "./evidence.ts";

interface Db {
  prepare(sql: string): { all: (...args: any[]) => any[]; get: (...args: any[]) => any };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fields the radar models but no persisted source can populate yet. Reported
 * verbatim by the diagnostics endpoint so coverage gaps stay visible instead of
 * silently reading as "feature absent from every cohort".
 */
export const KNOWN_UNSOURCED_FIELDS = [
  "stockVolume",
  "relativeStockVolume",
  "volumeAcceleration",
  "impliedVolatility",
  "impliedVolatilityChange",
  "gamma",
  "relativeStrengthVsSpyPct",
  "relativeStrengthVsQqqPct",
  "relativeStrengthVsSectorPct",
  "sectorAlignment",
  "marketAlignment",
  "catalystType",
  "compressionState",
  "underlyingMovePctBeforeDetection",
] as const;

const hasTable = (db: Db, table: string): boolean => {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
};

const numberOrNull = (value: unknown): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export interface AsymmetryCohortLoad {
  sessionDate: string;
  evaluationAtMs: number;
  cohortSize: number;
  report: AsymmetryResearchReport;
  warnings: string[];
  knownUnsourcedFields: string[];
}

/**
 * Loads one session's research candidates and grades them.
 * Read-only: every statement here is a SELECT.
 */
export function loadAsymmetryCohortOnDb(
  db: Db,
  opts: { sessionDate?: string; evaluationAtMs?: number; maxQuoteAgeMs?: number; minimumSupportedSample?: number; limit?: number } = {},
): AsymmetryCohortLoad {
  const sessionDate = opts.sessionDate ?? tradingDay();
  if (!DAY_RE.test(sessionDate)) throw new Error("sessionDate must be YYYY-MM-DD");
  const evaluationAtMs = opts.evaluationAtMs ?? Date.now();
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(500, Number(opts.limit))) : 200;
  const warnings: string[] = [];
  const knownUnsourcedFields = [...KNOWN_UNSOURCED_FIELDS];

  const empty = (): AsymmetryCohortLoad => ({
    sessionDate,
    evaluationAtMs,
    cohortSize: 0,
    report: buildAsymmetryResearchReport([], { evaluationAtMs, maxQuoteAgeMs, minimumSupportedSample: opts.minimumSupportedSample }),
    warnings,
    knownUnsourcedFields,
  });

  if (!hasTable(db, "options_research_observations")) {
    warnings.push("options_research_observations unavailable; no research candidates can be loaded.");
    return empty();
  }
  const marksAvailable = hasTable(db, "options_paper_marks");
  if (!marksAvailable) warnings.push("options_paper_marks unavailable; no outcome can be graded.");

  const observations = db.prepare(`SELECT
      id, observed_at_ms, session_date, symbol, direction, strategy_family,
      candidate_state, blockers_json, underlying_price, support_level, resistance_level, trigger_level,
      option_symbol, option_type, strike, expiration, option_bid, option_ask,
      quote_timestamp_ms, quote_age_ms, volume, open_interest, delta, dte, source, freshness_state
    FROM options_research_observations
    WHERE session_date=? AND option_symbol IS NOT NULL AND observed_at_ms<=?
    ORDER BY observed_at_ms ASC`).all(sessionDate, evaluationAtMs);

  if (!observations.length) {
    warnings.push(`No research observations recorded for ${sessionDate}.`);
    return empty();
  }

  // Group by exact OCC. The FIRST observation of a contract is the candidate;
  // every earlier-or-equal observation of that same contract is available as a
  // premium-chase baseline. Grouping by anything looser could mix contracts.
  const byContract = new Map<string, any[]>();
  for (const row of observations) {
    const occSymbol = String(row.option_symbol ?? "").trim().toUpperCase();
    if (!occSymbol) continue;
    const bucket = byContract.get(occSymbol) ?? [];
    bucket.push(row);
    byContract.set(occSymbol, bucket);
  }

  const markStatement = marksAvailable
    ? db.prepare(`SELECT mark_at_ms, option_symbol, bid, ask, quote_age_ms
        FROM options_paper_marks
        WHERE option_symbol=? AND mark_at_ms>=? AND mark_at_ms<=?
        ORDER BY mark_at_ms ASC`)
    : null;

  const inputs: AsymmetryCandidateInput[] = [];
  for (const [occSymbol, rows] of [...byContract.entries()].slice(0, limit)) {
    const candidate = rows[0];
    const candidateAtMs = numberOrNull(candidate.observed_at_ms);
    if (candidateAtMs == null) continue;

    const priorQuotes: AsymmetryQuoteObservation[] = rows
      .filter((row: any) => numberOrNull(row.observed_at_ms) != null && Number(row.observed_at_ms) <= candidateAtMs)
      .map((row: any) => ({
        occSymbol,
        atMs: Number(row.observed_at_ms),
        bid: numberOrNull(row.option_bid),
        ask: numberOrNull(row.option_ask),
        quoteTimestampMs: quoteTimestampFor(row),
        source: "options_research_observations",
      }));

    const marks: AsymmetryQuoteObservation[] = markStatement
      ? markStatement.all(occSymbol, candidateAtMs, evaluationAtMs).map((row: any) => ({
          occSymbol: String(row.option_symbol ?? "").trim().toUpperCase(),
          atMs: Number(row.mark_at_ms),
          bid: numberOrNull(row.bid),
          ask: numberOrNull(row.ask),
          // options_paper_marks stores an age, not an event time; the event time
          // is reconstructed from it rather than assumed to be the mark time.
          quoteTimestampMs: numberOrNull(row.quote_age_ms) == null
            ? null
            : Number(row.mark_at_ms) - Number(row.quote_age_ms),
          source: "options_paper_marks",
        }))
      : [];

    let blockers: string[] = [];
    try {
      const parsed = candidate.blockers_json ? JSON.parse(String(candidate.blockers_json)) : null;
      if (Array.isArray(parsed)) blockers = parsed.map(String);
    } catch { /* an unparseable blocker list contributes nothing, never a guess */ }

    inputs.push({
      evidence: {
        candidateId: `${sessionDate}:${occSymbol}:${candidate.id}`,
        symbol: String(candidate.symbol ?? "").trim().toUpperCase(),
        direction: candidate.direction ?? candidate.option_type ?? null,
        detectionAtMs: candidateAtMs,
        setupFamily: candidate.strategy_family ?? null,
        underlyingPrice: numberOrNull(candidate.underlying_price),
        occSymbol,
        expiration: candidate.expiration ?? null,
        strike: numberOrNull(candidate.strike),
        optionType: candidate.option_type ?? null,
        dte: numberOrNull(candidate.dte),
        bid: numberOrNull(candidate.option_bid),
        ask: numberOrNull(candidate.option_ask),
        quoteTimestampMs: quoteTimestampFor(candidate),
        quoteSource: candidate.source ?? null,
        optionVolume: numberOrNull(candidate.volume),
        openInterest: numberOrNull(candidate.open_interest),
        delta: numberOrNull(candidate.delta),
        greeksSource: candidate.delta == null ? null : String(candidate.source ?? "options_research_observations"),
        distanceToLevelPct: distanceToLevelPct(candidate),
        levelSource: candidate.trigger_level == null && candidate.support_level == null && candidate.resistance_level == null
          ? null
          : "options_research_observations",
        blockers,
      },
      priorQuotes,
      marks,
    });
  }

  if (byContract.size > limit) {
    warnings.push(`Cohort truncated to the first ${limit} contracts of ${byContract.size} for this session.`);
  }

  return {
    sessionDate,
    evaluationAtMs,
    cohortSize: inputs.length,
    report: buildAsymmetryResearchReport(inputs, {
      evaluationAtMs, maxQuoteAgeMs, minimumSupportedSample: opts.minimumSupportedSample,
    }),
    warnings,
    knownUnsourcedFields,
  };
}

/**
 * Prefers the recorded provider quote timestamp. Falls back to reconstructing
 * it from the recorded age; if neither exists the quote has no event time and
 * will be refused downstream rather than assumed current.
 */
function quoteTimestampFor(row: any): number | null {
  const explicit = numberOrNull(row.quote_timestamp_ms);
  if (explicit != null) return explicit;
  const observedAtMs = numberOrNull(row.observed_at_ms);
  const age = numberOrNull(row.quote_age_ms);
  if (observedAtMs == null || age == null || age < 0) return null;
  return observedAtMs - age;
}

/**
 * Distance from the underlying to the nearest sourced decision level, as a
 * percentage. Null unless both a price and at least one level were persisted.
 */
function distanceToLevelPct(row: any): number | null {
  const price = numberOrNull(row.underlying_price);
  if (price == null || price <= 0) return null;
  const levels = [row.trigger_level, row.support_level, row.resistance_level]
    .map(numberOrNull)
    .filter((level): level is number => level != null && level > 0);
  if (!levels.length) return null;
  const nearest = levels.reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a));
  return Math.round(((nearest - price) / price) * 1000000) / 10000;
}
