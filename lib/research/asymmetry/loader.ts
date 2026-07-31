/**
 * High-Asymmetry Radar — read-only cohort loader.
 *
 * Reads persisted facts ONLY, through the shared SELECT-only primitives in
 * `db-read.ts`. No writes, no migrations, no provider calls, no scheduler
 * participation. An absent table degrades into a warning and an empty cohort,
 * never an exception and never a fabricated row.
 *
 * Sources, and what each can honestly supply:
 *
 *  - `options_research_observations` — prospective, timestamped candidate
 *    evidence: exact OCC, bid/ask, provider quote timestamp, quote age, option
 *    volume, open interest, delta, DTE, strike, expiration, underlying price,
 *    levels, blockers, freshness.
 *  - `options_paper_marks` — exact-OCC bid/ask marks with quote age, used as
 *    outcome marks, matched by option_symbol.
 *
 * What NO persisted source can supply today is left MISSING on purpose. See
 * `KNOWN_UNSOURCED_FIELDS`.
 *
 * Candidate identity here is the Phase 1 default —
 * `OCC_SESSION_FIRST_OBSERVATION`. `identity.ts` audits that choice and offers
 * alternatives; the default is deliberately unchanged until real data supports
 * changing it.
 */
import { tradingDay } from "../../trading-session.ts";
import { buildAsymmetryResearchReport, type AsymmetryCandidateInput, type AsymmetryResearchReport } from "./report.ts";
import {
  DAY_RE, distanceToLevelPct, hasTable, quoteTimestampFor,
  readAsymmetryObservationsOnDb, readMarksForOccOnDb,
  type AsymmetryObservationRow, type Db,
} from "./db-read.ts";
import { groupCandidates, type CandidateIdentityStrategy } from "./identity.ts";
import type { AsymmetryQuoteObservation } from "./evidence.ts";

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

export interface AsymmetryCohortLoad {
  sessionDate: string;
  evaluationAtMs: number;
  cohortSize: number;
  report: AsymmetryResearchReport;
  warnings: string[];
  knownUnsourcedFields: string[];
}

/** Turns one persisted observation group into a gradeable candidate input. */
export function candidateInputFromRows(
  rows: AsymmetryObservationRow[],
  opts: { sessionDate: string; occSymbol: string; groupKey: string; marks: AsymmetryQuoteObservation[] },
): AsymmetryCandidateInput | null {
  const candidate = rows[0];
  const candidateAtMs = candidate?.observedAtMs;
  if (candidate == null || candidateAtMs == null) return null;

  const priorQuotes: AsymmetryQuoteObservation[] = rows
    .filter((row) => row.observedAtMs != null && row.observedAtMs <= candidateAtMs)
    .map((row) => ({
      occSymbol: opts.occSymbol,
      atMs: row.observedAtMs as number,
      bid: row.bid,
      ask: row.ask,
      quoteTimestampMs: quoteTimestampFor(row),
      source: "options_research_observations",
    }));

  return {
    evidence: {
      candidateId: `${opts.sessionDate}:${opts.groupKey}`,
      symbol: candidate.symbol,
      direction: candidate.direction ?? candidate.optionType ?? null,
      detectionAtMs: candidateAtMs,
      setupFamily: candidate.strategyFamily,
      underlyingPrice: candidate.underlyingPrice,
      occSymbol: opts.occSymbol,
      expiration: candidate.expiration,
      strike: candidate.strike,
      optionType: candidate.optionType,
      dte: candidate.dte,
      bid: candidate.bid,
      ask: candidate.ask,
      quoteTimestampMs: quoteTimestampFor(candidate),
      quoteSource: candidate.source,
      optionVolume: candidate.volume,
      openInterest: candidate.openInterest,
      delta: candidate.delta,
      greeksSource: candidate.delta == null ? null : (candidate.source ?? "options_research_observations"),
      distanceToLevelPct: distanceToLevelPct(candidate),
      levelSource: candidate.triggerLevel == null && candidate.supportLevel == null && candidate.resistanceLevel == null
        ? null
        : "options_research_observations",
      blockers: candidate.blockers,
    },
    priorQuotes,
    marks: opts.marks,
  };
}

/**
 * Loads one session's research candidates and grades them.
 * Read-only: every statement reached from here is a SELECT.
 */
export function loadAsymmetryCohortOnDb(
  db: Db,
  opts: {
    sessionDate?: string;
    evaluationAtMs?: number;
    maxQuoteAgeMs?: number;
    minimumSupportedSample?: number;
    limit?: number;
    identityStrategy?: CandidateIdentityStrategy;
    clusterGapMs?: number;
  } = {},
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
  if (!hasTable(db, "options_paper_marks")) warnings.push("options_paper_marks unavailable; no outcome can be graded.");

  const observations = readAsymmetryObservationsOnDb(db, { sessionDate, evaluationAtMs, requireOcc: true });
  if (!observations.length) {
    warnings.push(`No research observations recorded for ${sessionDate}.`);
    return empty();
  }

  const groups = groupCandidates(observations, {
    strategy: opts.identityStrategy ?? "OCC_SESSION_FIRST_OBSERVATION",
    clusterGapMs: opts.clusterGapMs,
  });

  const inputs: AsymmetryCandidateInput[] = [];
  for (const group of groups.slice(0, limit)) {
    const candidateAtMs = group.rows[0]?.observedAtMs;
    if (candidateAtMs == null) continue;
    const input = candidateInputFromRows(group.rows, {
      sessionDate,
      occSymbol: group.occSymbol,
      groupKey: group.key,
      marks: readMarksForOccOnDb(db, group.occSymbol, candidateAtMs, evaluationAtMs),
    });
    if (input) inputs.push(input);
  }

  if (groups.length > limit) {
    warnings.push(`Cohort truncated to the first ${limit} candidates of ${groups.length} for this session.`);
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
