/**
 * coverage-diagnostics.ts — HIST_COVERAGE_V1. Why an event is unsupported.
 *
 * ── The question this module exists to answer ─────────────────────────────────
 *
 *     Does a weak probability mean "the setup historically performed poorly",
 *     or does it mean "we barely have historical evidence"?
 *
 * Those are opposite conclusions and they arrive as the same number. 57 of 78 candidate
 * events currently produce no executable entry, and until each refusal names its cause
 * that 27% support rate is unreadable: it could be a provider that genuinely never quoted
 * those contracts, or it could be windows nobody has mined yet.
 *
 * ── This module NEVER improves coverage ──────────────────────────────────────
 *
 * It diagnoses. It does not widen a staleness tolerance, does not fall back to a nearby
 * contract, does not substitute a trade print for an NBBO, and does not accept a quote
 * after T. Every one of those would raise the support rate and destroy the thing the rate
 * measures. The output of this module is a WORK LIST for the miner, not a relaxation.
 *
 * The distinction that matters most is between MINEABLE and NOT_MINEABLE. A window nobody
 * fetched is a budget decision we can reverse. A contract the provider never quoted is a
 * fact we have to live with. Reporting them as one number would make a solvable problem
 * look permanent, or a permanent one look solvable.
 */
import { replayQuoteAsOfOnDb, sessionDateOf } from "./replay.ts";
import type { StoreDb } from "./store.ts";
import { classifySessionDate, tradingSessionsBetween } from "./trading-sessions.ts";

export const COVERAGE_DIAGNOSTIC_VERSION = "HIST_COVERAGE_V1" as const;

/** Mirrors the replay default. Named here so a diagnosis states the tolerance it used. */
export const DEFAULT_STALENESS_MS = 5 * 60_000;

/** `O:` + root + 6-digit date + C/P + 8-digit strike. */
const OCC_RE = /^O:[A-Z]{1,6}\d{6}[CP]\d{8}$/;

export type CoverageCause =
  | "SUPPORTED"
  | "MALFORMED_OCC_IDENTITY"
  | "ENTRY_TIMESTAMP_INVALID"
  | "ENTRY_NOT_A_TRADING_SESSION"
  | "OCC_REFERENCE_ABSENT_AND_UNMINED"
  | "NBBO_WINDOW_NEVER_MINED"
  | "ENTRY_BEFORE_MINED_WINDOW"
  | "ENTRY_AFTER_MINED_WINDOW"
  | "STALE_QUOTE_ONLY"
  | "PROVIDER_QUOTED_NO_ASK";

/**
 * Can mining fix this?
 *
 *   MINEABLE       — a window we have not fetched. Reversible with budget.
 *   NOT_MINEABLE   — the provider has no executable quote there. A fact, not a gap.
 *   IDENTITY_DEFECT— the candidate itself is malformed. Fix upstream, not by fetching.
 */
export type CoverageRemedy = "NONE_NEEDED" | "MINEABLE" | "NOT_MINEABLE" | "IDENTITY_DEFECT";

export interface EntryCoverageDiagnosis {
  version: typeof COVERAGE_DIAGNOSTIC_VERSION;
  occ: string;
  symbol: string | null;
  entryAtMs: number;
  sessionDate: string | null;
  opportunityCaseId: string | null;

  cause: CoverageCause;
  remedy: CoverageRemedy;
  executable: boolean;

  /** What the store actually holds for this contract. */
  quotesForOcc: number;
  minedFromMs: number | null;
  minedToMs: number | null;
  contractReferenceKnown: boolean;

  /** The quote in force at T, when one existed at all — even if it was refused. */
  nearestQuoteAtOrBeforeMs: number | null;
  nearestQuoteAgeMs: number | null;
  stalenessToleranceMs: number;

  /** The window a miner would need to fetch to resolve a MINEABLE gap. */
  suggestedWindow: { fromMs: number; toMs: number } | null;
  note: string;
}

function hasTable(db: StoreDb, name: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name);
  } catch {
    return false;
  }
}

interface OccSpan { rows: number; minMs: number | null; maxMs: number | null }

function occSpan(db: StoreDb, occ: string): OccSpan {
  if (!hasTable(db, "historical_option_quotes")) return { rows: 0, minMs: null, maxMs: null };
  try {
    const r = db.prepare(
      "SELECT COUNT(*) AS n, MIN(ts_ms) AS lo, MAX(ts_ms) AS hi FROM historical_option_quotes WHERE occ=?",
    ).get?.(occ) as { n?: number; lo?: number | null; hi?: number | null } | undefined;
    const rows = Number(r?.n ?? 0);
    return {
      rows,
      minMs: rows > 0 && r?.lo != null ? Number(r.lo) : null,
      maxMs: rows > 0 && r?.hi != null ? Number(r.hi) : null,
    };
  } catch {
    return { rows: 0, minMs: null, maxMs: null };
  }
}

function referenceKnown(db: StoreDb, occ: string): boolean {
  if (!hasTable(db, "historical_contract_reference")) return false;
  try {
    return !!db.prepare("SELECT 1 FROM historical_contract_reference WHERE occ=?").get?.(occ);
  } catch {
    return false;
  }
}

/**
 * Diagnose one candidate's executable-entry coverage.
 *
 * The checks run cheapest-and-most-fundamental first, so a diagnosis names the ROOT cause
 * rather than the last thing that happened to fail. A malformed OCC reported as
 * "provider has no quote" would send someone to buy data for a contract that never existed.
 */
export function diagnoseEntryCoverageOnDb(
  db: StoreDb,
  candidate: {
    occ: string;
    symbol?: string | null;
    entryAtMs: number;
    opportunityCaseId?: string | null;
  },
  opts: { maxStalenessMs?: number; windowMs?: number } = {},
): EntryCoverageDiagnosis {
  const occ = String(candidate.occ ?? "").toUpperCase();
  const tol = Math.max(1000, opts.maxStalenessMs ?? DEFAULT_STALENESS_MS);
  const windowMs = Math.max(60_000, opts.windowMs ?? 6 * 3600_000);
  const entryAtMs = Number(candidate.entryAtMs);

  const base: EntryCoverageDiagnosis = {
    version: COVERAGE_DIAGNOSTIC_VERSION,
    occ,
    symbol: candidate.symbol ? String(candidate.symbol).toUpperCase() : null,
    entryAtMs,
    sessionDate: Number.isFinite(entryAtMs) ? sessionDateOf(entryAtMs) : null,
    opportunityCaseId: candidate.opportunityCaseId ?? null,
    cause: "SUPPORTED",
    remedy: "NONE_NEEDED",
    executable: false,
    quotesForOcc: 0,
    minedFromMs: null,
    minedToMs: null,
    contractReferenceKnown: false,
    nearestQuoteAtOrBeforeMs: null,
    nearestQuoteAgeMs: null,
    stalenessToleranceMs: tol,
    suggestedWindow: null,
    note: "",
  };

  if (!OCC_RE.test(occ)) {
    return {
      ...base,
      cause: "MALFORMED_OCC_IDENTITY",
      remedy: "IDENTITY_DEFECT",
      note: "the frozen contract symbol is not a well-formed OCC; no amount of mining fixes a "
        + "candidate that does not identify a contract",
    };
  }
  if (!Number.isFinite(entryAtMs) || entryAtMs <= 0) {
    return {
      ...base,
      cause: "ENTRY_TIMESTAMP_INVALID",
      remedy: "IDENTITY_DEFECT",
      note: "the detection instant is missing or not a usable epoch",
    };
  }

  const sd = classifySessionDate(base.sessionDate);
  if (!sd.isTradingSession) {
    return {
      ...base,
      cause: "ENTRY_NOT_A_TRADING_SESSION",
      remedy: "IDENTITY_DEFECT",
      note: `the entry instant falls on ${base.sessionDate} (${sd.reason}); the market was not open, `
        + "so no executable quote can exist and none should be sought",
    };
  }

  const span = occSpan(db, occ);
  const known = referenceKnown(db, occ);
  const enriched: EntryCoverageDiagnosis = {
    ...base,
    quotesForOcc: span.rows,
    minedFromMs: span.minMs,
    minedToMs: span.maxMs,
    contractReferenceKnown: known,
  };
  // The window a miner would fetch: the event and its forward measurement window.
  const suggested = { fromMs: entryAtMs - tol, toMs: entryAtMs + windowMs };

  if (span.rows === 0) {
    return known
      ? {
        ...enriched,
        cause: "NBBO_WINDOW_NEVER_MINED",
        remedy: "MINEABLE",
        suggestedWindow: suggested,
        note: "the contract is known from reference data but no NBBO has ever been stored for it. "
          + "This is a budget gap, not a provider limitation, and it is the single largest "
          + "recoverable cause of unsupported events",
      }
      : {
        ...enriched,
        cause: "OCC_REFERENCE_ABSENT_AND_UNMINED",
        remedy: "MINEABLE",
        suggestedWindow: suggested,
        note: "neither reference data nor NBBO exists for this contract. Expired contracts cannot be "
          + "resolved from a live chain, so reference must be backfilled before the quote window "
          + "can be judged mineable",
      };
  }

  // Quotes exist for this contract. Ask the REAL question first — the same function the
  // replay engine asks, with the same tolerance — and use the mined span only to explain a
  // failure afterwards.
  //
  // Order matters. Comparing the entry instant against the span first would misreport a
  // perfectly executable quote one second before T as "after the mined window", because a
  // span that simply ENDS at the entry is not a span that misses it.
  const inForce = replayQuoteAsOfOnDb(db, occ, { asOfMs: entryAtMs, maxStalenessMs: tol });
  if (inForce) {
    if (inForce.ask != null && inForce.ask > 0) {
      return {
        ...enriched,
        cause: "SUPPORTED",
        remedy: "NONE_NEEDED",
        executable: true,
        nearestQuoteAtOrBeforeMs: inForce.tsMs,
        nearestQuoteAgeMs: inForce.ageMs,
        note: `executable: ask ${inForce.ask} in force ${inForce.ageMs}ms before the entry instant`,
      };
    }
    return {
      ...enriched,
      cause: "PROVIDER_QUOTED_NO_ASK",
      remedy: "NOT_MINEABLE",
      nearestQuoteAtOrBeforeMs: inForce.tsMs,
      nearestQuoteAgeMs: inForce.ageMs,
      note: "a quote was in force at the entry instant but carried no positive ask. Nobody was "
        + "offering the contract, so there was nothing to buy — mining more of this window "
        + "cannot change that",
    };
  }

  // Nothing executable. Now the span explains WHY, and whether mining can fix it.
  let latestBefore: number | null = null;
  try {
    const r = db.prepare(
      "SELECT MAX(ts_ms) AS ts FROM historical_option_quotes WHERE occ=? AND ts_ms <= ?",
    ).get?.(occ, entryAtMs) as { ts?: number | null } | undefined;
    latestBefore = r?.ts == null ? null : Number(r.ts);
  } catch {
    latestBefore = null;
  }

  if (latestBefore == null) {
    // Everything we hold for this contract is AFTER the entry. Reading forward for an entry
    // is precisely the leak the fence exists to refuse, so this stays unsupported until the
    // earlier window is fetched.
    return {
      ...enriched,
      cause: "ENTRY_BEFORE_MINED_WINDOW",
      remedy: "MINEABLE",
      suggestedWindow: {
        fromMs: suggested.fromMs,
        toMs: span.minMs != null ? Math.min(span.minMs, suggested.toMs) : suggested.toMs,
      },
      note: span.minMs != null
        ? `this contract is mined from ${new Date(span.minMs).toISOString()} onward, but the entry `
          + "instant precedes that. Taking the nearest quote AFTER the entry is the leak the fence "
          + "refuses, so the earlier window has to be fetched instead"
        : "no quote at or before the entry instant, and reading forward for an entry is refused",
    };
  }

  const age = entryAtMs - latestBefore;
  // A span that ends well before the entry is a fetch we never made. A span that reaches the
  // entry but holds nothing fresh is a contract nobody was quoting. Same symptom, opposite
  // remedy, so they must not share a cause.
  if (span.maxMs != null && entryAtMs - span.maxMs > tol) {
    return {
      ...enriched,
      cause: "ENTRY_AFTER_MINED_WINDOW",
      remedy: "MINEABLE",
      nearestQuoteAtOrBeforeMs: latestBefore,
      nearestQuoteAgeMs: age,
      suggestedWindow: { fromMs: span.maxMs, toMs: suggested.toMs },
      note: `this contract is mined only through ${new Date(span.maxMs).toISOString()}, which is `
        + `${Math.round((entryAtMs - span.maxMs) / 1000)}s before the entry instant — a window we `
        + "have not fetched rather than a contract nobody quoted",
    };
  }

  return {
    ...enriched,
    cause: "STALE_QUOTE_ONLY",
    remedy: "NOT_MINEABLE",
    nearestQuoteAtOrBeforeMs: latestBefore,
    nearestQuoteAgeMs: age,
    note: `the newest quote at or before the entry instant is ${Math.round(age / 1000)}s old, past the `
      + `${Math.round(tol / 1000)}s tolerance, inside a span we did mine. A contract nobody was `
      + "quoting was not executable, and widening the tolerance would manufacture a fill rather "
      + "than discover one",
  };
}

export interface CoverageCensus {
  version: typeof COVERAGE_DIAGNOSTIC_VERSION;
  examined: number;
  executable: number;
  executableRate: number | null;
  byCause: Record<string, number>;
  byRemedy: Record<string, number>;
  /** Candidates a miner could plausibly resolve, most recent first. */
  mineable: Array<{ occ: string; symbol: string | null; sessionDate: string | null; cause: CoverageCause; fromMs: number; toMs: number }>;
  note: string;
}

/** Diagnose a batch and census it by cause AND by whether mining can fix it. */
export function coverageCensusOnDb(
  db: StoreDb,
  candidates: ReadonlyArray<{ occ: string; symbol?: string | null; entryAtMs: number; opportunityCaseId?: string | null }>,
  opts: { maxStalenessMs?: number; windowMs?: number; mineableLimit?: number } = {},
): { diagnoses: EntryCoverageDiagnosis[]; census: CoverageCensus } {
  const diagnoses = candidates.map((c) => diagnoseEntryCoverageOnDb(db, c, opts));
  const byCause: Record<string, number> = {};
  const byRemedy: Record<string, number> = {};
  for (const d of diagnoses) {
    byCause[d.cause] = (byCause[d.cause] ?? 0) + 1;
    byRemedy[d.remedy] = (byRemedy[d.remedy] ?? 0) + 1;
  }
  const executable = diagnoses.filter((d) => d.executable).length;
  const mineable = diagnoses
    .filter((d) => d.remedy === "MINEABLE" && d.suggestedWindow)
    .sort((a, b) => b.entryAtMs - a.entryAtMs)
    .slice(0, Math.max(1, Math.min(2000, opts.mineableLimit ?? 200)))
    .map((d) => ({
      occ: d.occ,
      symbol: d.symbol,
      sessionDate: d.sessionDate,
      cause: d.cause,
      fromMs: (d.suggestedWindow as { fromMs: number }).fromMs,
      toMs: (d.suggestedWindow as { toMs: number }).toMs,
    }));

  return {
    diagnoses,
    census: {
      version: COVERAGE_DIAGNOSTIC_VERSION,
      examined: diagnoses.length,
      executable,
      executableRate: diagnoses.length ? +(executable / diagnoses.length).toFixed(4) : null,
      byCause,
      byRemedy,
      mineable,
      note:
        "MINEABLE and NOT_MINEABLE are the split that matters. A MINEABLE gap is a window we have "
        + "not fetched and can still reverse with budget; NOT_MINEABLE means the provider had no "
        + "executable quote there, which is a fact about the market rather than about our coverage. "
        + "Reporting them as one number would make a solvable problem look permanent. Nothing here "
        + "loosens the executable-quote standard — this is a work list, not a relaxation.",
    },
  };
}

// ── store-wide coverage, by every dimension a reader might ask about ──────────

export interface CoverageBreakdown {
  version: typeof COVERAGE_DIAGNOSTIC_VERSION;
  bars: {
    rows: number;
    symbols: string[];
    earliestSessionDate: string | null;
    latestSessionDate: string | null;
    tradingSessionsInRange: number;
    sessionsWithData: string[];
  };
  optionQuotes: {
    rows: number;
    contracts: number;
    earliestSessionDate: string | null;
    latestSessionDate: string | null;
    tradingSessionsInRange: number;
    sessionsWithData: string[];
    bySession: Array<{ sessionDate: string; rows: number; contracts: number }>;
    topContracts: Array<{ occ: string; rows: number }>;
  };
  optionTrades: { rows: number; contracts: number };
  contractReference: { rows: number; underlyings: number };
  marketContext: { rows: number; sessions: number };
  /**
   * The mismatch that made "6 sessions over a 5-day window" look like a counting bug.
   * Bars and quotes are separate datasets with separate spans; comparing one range against
   * the other's session count is the error, not the count.
   */
  datasetSpanMismatch: string;
  note: string;
}

function sessionsOf(db: StoreDb, sql: string): Array<{ sessionDate: string; rows: number; contracts: number }> {
  try {
    const rows = (db.prepare(sql).all?.() ?? []) as any[];
    const bucket = new Map<string, { rows: number; contracts: Set<string> }>();
    for (const r of rows) {
      const d = sessionDateOf(Number(r.ts_ms));
      if (!d) continue;
      const b = bucket.get(d) ?? { rows: 0, contracts: new Set<string>() };
      b.rows += Number(r.n ?? 1);
      if (r.occ) b.contracts.add(String(r.occ));
      bucket.set(d, b);
    }
    return [...bucket.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([sessionDate, v]) => ({ sessionDate, rows: v.rows, contracts: v.contracts.size }));
  } catch {
    return [];
  }
}

/** Everything a reader needs to tell thin evidence apart from poor performance. */
export function coverageBreakdownOnDb(db: StoreDb): CoverageBreakdown {
  const one = <T>(sql: string, fallback: T): T => {
    try {
      return (db.prepare(sql).get?.() ?? fallback) as T;
    } catch {
      return fallback;
    }
  };
  const many = <T>(sql: string): T[] => {
    try {
      return (db.prepare(sql).all?.() ?? []) as T[];
    } catch {
      return [];
    }
  };

  const barsAgg = one<{ n?: number; lo?: number | null; hi?: number | null }>(
    "SELECT COUNT(*) AS n, MIN(ts_ms) AS lo, MAX(ts_ms) AS hi FROM historical_underlying_bars", {},
  );
  const barSymbols = many<{ symbol: string }>(
    "SELECT DISTINCT symbol FROM historical_underlying_bars ORDER BY symbol",
  ).map((r) => String(r.symbol));
  const barSessions = many<{ ts_ms: number }>(
    "SELECT DISTINCT ts_ms FROM historical_underlying_bars",
  );
  const barSessionDates = [...new Set(barSessions.map((r) => sessionDateOf(Number(r.ts_ms))).filter((d): d is string => !!d))].sort();

  const qAgg = one<{ n?: number; c?: number; lo?: number | null; hi?: number | null }>(
    "SELECT COUNT(*) AS n, COUNT(DISTINCT occ) AS c, MIN(ts_ms) AS lo, MAX(ts_ms) AS hi FROM historical_option_quotes", {},
  );
  const quoteSessions = sessionsOf(
    db,
    "SELECT ts_ms, occ, 1 AS n FROM historical_option_quotes",
  );
  const topContracts = many<{ occ: string; n: number }>(
    "SELECT occ, COUNT(*) AS n FROM historical_option_quotes GROUP BY occ ORDER BY n DESC LIMIT 25",
  ).map((r) => ({ occ: String(r.occ), rows: Number(r.n) }));

  const tAgg = one<{ n?: number; c?: number }>(
    "SELECT COUNT(*) AS n, COUNT(DISTINCT occ) AS c FROM historical_option_trades", {},
  );
  const refAgg = one<{ n?: number; u?: number }>(
    "SELECT COUNT(*) AS n, COUNT(DISTINCT underlying) AS u FROM historical_contract_reference", {},
  );
  const ctxAgg = one<{ n?: number; s?: number }>(
    "SELECT COUNT(*) AS n, COUNT(DISTINCT session_date) AS s FROM historical_market_context", {},
  );

  const barLo = barsAgg.lo == null ? null : sessionDateOf(Number(barsAgg.lo));
  const barHi = barsAgg.hi == null ? null : sessionDateOf(Number(barsAgg.hi));
  const qLo = qAgg.lo == null ? null : sessionDateOf(Number(qAgg.lo));
  const qHi = qAgg.hi == null ? null : sessionDateOf(Number(qAgg.hi));

  const spanSessions = (from: string | null, to: string | null): number =>
    from && to ? tradingSessionsBetween(from, to).length : 0;

  const quoteSessionDates = quoteSessions.map((s) => s.sessionDate);

  return {
    version: COVERAGE_DIAGNOSTIC_VERSION,
    bars: {
      rows: Number(barsAgg.n ?? 0),
      symbols: barSymbols,
      earliestSessionDate: barLo,
      latestSessionDate: barHi,
      tradingSessionsInRange: spanSessions(barLo, barHi),
      sessionsWithData: barSessionDates,
    },
    optionQuotes: {
      rows: Number(qAgg.n ?? 0),
      contracts: Number(qAgg.c ?? 0),
      earliestSessionDate: qLo,
      latestSessionDate: qHi,
      tradingSessionsInRange: spanSessions(qLo, qHi),
      sessionsWithData: quoteSessionDates,
      bySession: quoteSessions,
      topContracts,
    },
    optionTrades: { rows: Number(tAgg.n ?? 0), contracts: Number(tAgg.c ?? 0) },
    contractReference: { rows: Number(refAgg.n ?? 0), underlyings: Number(refAgg.u ?? 0) },
    marketContext: { rows: Number(ctxAgg.n ?? 0), sessions: Number(ctxAgg.s ?? 0) },
    datasetSpanMismatch:
      `bars cover ${barLo ?? "—"}..${barHi ?? "—"} and option NBBO covers ${qLo ?? "—"}..${qHi ?? "—"}. `
      + "These are SEPARATE datasets with separate spans. Winner events are anchored on NBBO, so the "
      + "number of event sessions is bounded by the QUOTE range, not the bars range — comparing one "
      + "against the other is what makes a correct session count look inflated.",
    note:
      "Possession, not entitlement: every count here is stored rows in this database. A statistic "
      + "that is weak because a cohort barely exists and one that is weak because the setups "
      + "performed badly are indistinguishable without this breakdown.",
  };
}
