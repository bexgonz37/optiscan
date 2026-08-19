/**
 * executable-opportunity.ts — WAS THERE STILL A BUYABLE OPTION WHEN WE FOUND IT?
 *
 * THE QUESTION, AND WHY IT IS THE ONLY ONE THAT MATTERS
 *
 * Discovery was repaired: an MRNA-class mover above $50 can now be found and
 * ranked instead of hidden by provider order. That answers "did we see it",
 * which is trivially yes and worth almost nothing on its own. The question that
 * decides whether the hypothesis has any value is:
 *
 *   When an extreme mover is discovered, is there still an EXECUTABLE options
 *   opportunity with meaningful reward remaining?
 *
 * `EXTREME_PREMARKET_DISCOVERY_V1` declares that as its EXECUTABLE scope and
 * marks it NOT STARTED, blocked on provider budget: quoting options on newly
 * discovered symbols needs a lane holding no minute reserve, and on 2026-08-19
 * such a lane was served 393 requests against 1,647 refusals. A sample drawn
 * only from the minutes a starved lane happened to win is biased, and a biased
 * sample is worse than none because it looks like evidence.
 *
 * THAT REASONING IS CORRECT — AND IT ANSWERS A DIFFERENT QUESTION
 *
 * It describes what a PROSPECTIVE lane would cost: going and quoting movers we
 * have not quoted. But the ladder can also be measured RETROSPECTIVELY, on the
 * subset OptiScan did quote, from rows that were already paid for and are
 * already on disk:
 *
 *   options_research_observations   NBBO, spread, delta, OI, volume, DTE, OCC
 *   asymmetry_outcomes              entry ask, MFE, MAE, the hit ladder, timings
 *   contract_funnel_evidence        why no contract was selected
 *   market_mover_observations       when the symbol was first seen at all
 *
 * Every EXECUTABLE field has a durable source among those four. This module is
 * the join. It issues ZERO provider requests, holds no reserve, cannot starve a
 * lane, and — like the coverage forensic — stays runnable while the minute cap
 * is saturated, which is exactly when a budget-caused miss needs investigating.
 *
 * WHAT IT MUST NEVER DO, AND THE SHAPE THAT ENFORCES IT
 *
 * NEVER CLAIM AN UNQUOTED MOVE WAS ATTAINABLE. A symbol with no NBBO row gets a
 * coverage verdict and a null ladder — never a zero, never an inferred return
 * from the underlying's move. `ExecutableMeasurement.ladder` is `null` unless
 * `firstExecutableNbboAtMs` is non-null, and that is a type-level invariant, not
 * a convention. The underlying moving 133% tells you nothing about what a
 * contract was quoted at, and the whole point of the MRNA post-mortem was that
 * the honest number (+293% from the first executable mark) and the headline
 * number (+319,400% from a penny prior close) differ by four orders of
 * magnitude.
 *
 * WHAT IT CANNOT ANSWER, STATED PLAINLY
 *
 * A retrospective join measures the QUOTED subset. It cannot tell you what the
 * ladder would have looked like on movers nobody quoted, because that evidence
 * does not exist and cannot be manufactured. `SelectionBias` reports the size of
 * that gap on every run rather than leaving the reader to assume there isn't one.
 * The prospective half stays NOT STARTED and stays blocked on the same budget.
 *
 * SHADOW / RESEARCH ONLY. Reads four tables. Writes nothing, sends nothing,
 * authorizes nothing.
 */

interface EvidenceDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

/** Where a discovered mover ended up. Mirrors the coverage forensic's vocabulary. */
export type ExecutableState =
  /** Never admitted to any universe — nothing to quote, nothing to claim. */
  | "NOT_ADMITTED_TO_UNIVERSE"
  /** Admitted and looked at, but no NBBO was ever recorded. */
  | "ADMITTED_NOT_QUOTED"
  /** Quoted, but the contract funnel refused every candidate. */
  | "QUOTED_NO_CONTRACT_SELECTED"
  /** Quoted, a contract was selected, and the ladder is measurable. */
  | "EXECUTABLE_EVIDENCE_PRESENT";

export interface AttainableLadder {
  /**
   * The mark the ladder is measured FROM: the first regular-hours executable
   * quote, not the prior close. This distinction is the whole finding of the
   * MRNA post-mortem.
   */
  entryMark: number;
  pct10: boolean;
  pct25: boolean;
  pct50: boolean;
  pct100: boolean;
  pct200: boolean;
  mfePct: number | null;
  maePct: number | null;
  finalReturnPct: number | null;
  timeTo25Ms: number | null;
  timeTo50Ms: number | null;
  timeTo100Ms: number | null;
  timeTo200Ms: number | null;
  marksUsed: number;
  /**
   * MARKED means the rung has its own recorded crossing; DERIVED_FROM_MFE means
   * it was inferred from the peak. Both are sound — a peak of +40% did reach
   * +25% — but only one has a timestamp, which is why they are distinguished
   * rather than merged.
   */
  ladderSource: "MARKED" | "DERIVED_FROM_MFE";
}

export interface ExecutableContract {
  optionSymbol: string;
  optionType: string | null;
  strike: number | null;
  expiration: string | null;
  entryMark: number | null;
  spreadPct: number | null;
  delta: number | null;
  openInterest: number | null;
  volume: number | null;
  dte: number | null;
}

export interface ExecutableMeasurement {
  symbol: string;
  sessionDate: string;
  state: ExecutableState;
  /** When the mover was first independently observed, from market state. */
  discoveredAtMs: number | null;
  premarketRank: number | null;
  underlyingMovePct: number | null;
  peakUnderlyingMovePct: number | null;
  /** First quote that could actually have been acted on. Null = never quoted. */
  firstExecutableNbboAtMs: number | null;
  /**
   * Minutes between first seeing the mover and having an executable quote.
   *
   * NEGATIVE is legitimate and worth reading: the symbol was already being
   * quoted before it qualified as a mover, so coverage was never the constraint
   * for it. Clamping to zero would erase exactly that distinction.
   */
  timeToFirstQuoteMinutes: number | null;
  contract: ExecutableContract | null;
  /** NULL unless `firstExecutableNbboAtMs` is non-null. Never a zero-fill. */
  ladder: AttainableLadder | null;
  /** Terminal reason from the contract funnel, when nothing was selected. */
  noContractReason: string | null;
  /** Plain English, for the private app. */
  note: string;
}

/**
 * The buckets PARTITION the population: they sum to `moversConsidered`.
 *
 * The first version did not. `withExecutableEvidence` counted rows with a
 * LADDER while the others counted STATES, so a symbol that was quoted but never
 * marked fell through every bucket and 8 of 40 movers were simply unaccounted
 * for. A reader checking the arithmetic of a bias report and finding it does not
 * add up has no reason to trust the fraction either.
 */
export interface SelectionBias {
  moversConsidered: number;
  /** Quoted AND marked — the only rows the ladder can describe. */
  withExecutableEvidence: number;
  /** Quoted, but no marks were taken, so there is no ladder to report. */
  quotedWithoutMarks: number;
  quotedButNoContract: number;
  admittedNotQuoted: number;
  notAdmitted: number;
  /**
   * The share of discovered movers the ladder can say nothing about. Reported
   * on every run because a retrospective measurement's honesty depends entirely
   * on the reader knowing how much of the population it excludes.
   */
  unmeasuredFraction: number | null;
}

export interface ExecutableOpportunityReport {
  sessionDate: string;
  minPeakAbsMovePct: number;
  providerRequests: 0;
  measurements: ExecutableMeasurement[];
  bias: SelectionBias;
  /** Aggregates over the measurable subset ONLY. */
  attainable: {
    n: number;
    reached10: number;
    reached25: number;
    reached50: number;
    reached100: number;
    reached200: number;
    medianMfePct: number | null;
    medianTimeTo50Minutes: number | null;
  };
  evidenceState: "NO_MOVERS" | "NO_EXECUTABLE_EVIDENCE" | "MEASURABLE";
  limitations: string[];
}

const MIN_PEAK_MOVE_PCT = 10;
/** How many of the session's top movers to measure. Bounds the SQL, not a cap on truth. */
const DEFAULT_LIMIT = 40;

function hasTable(db: EvidenceDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/**
 * A missing value is null, never 0.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious one-liner
 * turns "no delta was recorded" into "delta was exactly zero" and "this rung was
 * never timed" into "it was reached instantly". Both are claims the evidence
 * does not make.
 */
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * The earliest quote for a symbol that a person could have acted on.
 *
 * Ordered by the QUOTE's own timestamp where one exists, falling back to when
 * we observed it. A quote is executable when it has both sides — a one-sided
 * book is a price you cannot cross.
 */
function firstExecutableQuote(
  db: EvidenceDb,
  symbol: string,
  sessionDate: string,
): { atMs: number; contract: ExecutableContract } | null {
  if (!hasTable(db, "options_research_observations")) return null;
  try {
    const r = db.prepare(
      `SELECT option_symbol, option_type, strike, expiration, option_bid, option_ask,
              spread_pct, delta, open_interest, volume, dte,
              COALESCE(quote_timestamp_ms, observed_at_ms) AS at_ms
         FROM options_research_observations
        WHERE symbol = ? AND session_date = ?
          AND option_symbol IS NOT NULL
          AND option_bid IS NOT NULL AND option_ask IS NOT NULL
          AND option_ask > 0
        ORDER BY at_ms ASC
        LIMIT 1`,
    ).get(String(symbol).toUpperCase(), sessionDate) as any;
    if (!r) return null;
    const bid = num(r.option_bid);
    const ask = num(r.option_ask);
    // The mark is the midpoint of a two-sided quote. Not the last trade, which
    // may be stale, and not the ask, which overstates what a fill costs.
    const entryMark = bid != null && ask != null ? (bid + ask) / 2 : null;
    return {
      atMs: Number(r.at_ms),
      contract: {
        optionSymbol: String(r.option_symbol),
        optionType: r.option_type == null ? null : String(r.option_type),
        strike: num(r.strike),
        expiration: r.expiration == null ? null : String(r.expiration),
        entryMark,
        spreadPct: num(r.spread_pct),
        delta: num(r.delta),
        openInterest: num(r.open_interest),
        volume: num(r.volume),
        dte: num(r.dte),
      },
    };
  } catch {
    return null;
  }
}

/**
 * The attainable ladder for one contract, from marks already taken.
 *
 * `asymmetry_outcomes` records 25/50/100/200/500 with timings. +10 has no column
 * of its own, so it is derived from the peak — which is exact, not an estimate:
 * a position whose MFE was +14% did reach +10%. It simply has no timestamp, and
 * `ladderSource` says so.
 */
function ladderFor(
  db: EvidenceDb,
  optionSymbol: string,
  sessionDate: string,
  entryMark: number | null,
): AttainableLadder | null {
  if (!hasTable(db, "asymmetry_outcomes")) return null;
  try {
    const r = db.prepare(
      `SELECT entry_ask, mfe_pct, mae_pct, final_return_pct,
              hit_25, hit_50, hit_100, hit_200,
              time_to_25_ms, time_to_50_ms, time_to_100_ms, time_to_200_ms, marks_used
         FROM asymmetry_outcomes
        WHERE option_symbol = ? AND session_date = ?
        ORDER BY marks_used DESC
        LIMIT 1`,
    ).get(optionSymbol, sessionDate) as any;
    if (!r) return null;
    const mfe = num(r.mfe_pct);
    const mark = entryMark ?? num(r.entry_ask);
    if (mark == null) return null;
    const marked = r.hit_25 != null || r.hit_50 != null || r.hit_100 != null;
    const reached = (pct: number, col: unknown) => {
      if (col != null) return Number(col) === 1;
      return mfe != null && mfe >= pct;
    };
    return {
      entryMark: mark,
      pct10: mfe != null ? mfe >= 10 : false,
      pct25: reached(25, r.hit_25),
      pct50: reached(50, r.hit_50),
      pct100: reached(100, r.hit_100),
      pct200: reached(200, r.hit_200),
      mfePct: mfe,
      maePct: num(r.mae_pct),
      finalReturnPct: num(r.final_return_pct),
      timeTo25Ms: num(r.time_to_25_ms),
      timeTo50Ms: num(r.time_to_50_ms),
      timeTo100Ms: num(r.time_to_100_ms),
      timeTo200Ms: num(r.time_to_200_ms),
      marksUsed: Number(r.marks_used) || 0,
      ladderSource: marked ? "MARKED" : "DERIVED_FROM_MFE",
    };
  } catch {
    return null;
  }
}

/**
 * `terminal_reason` records how the funnel ENDED, which includes ending well.
 *
 * `CONTRACT_SELECTED` is the success value, and the first version of this module
 * read any non-null terminal reason as a refusal. Production immediately showed
 * the cost: 10 of 40 movers were labelled QUOTED_NO_CONTRACT_SELECTED with the
 * reason "CONTRACT_SELECTED", which is a sentence that contradicts itself. A
 * classifier that turns a success into a failure does not produce a slightly
 * wrong number; it inverts the finding.
 */
const FUNNEL_SUCCESS_REASONS = new Set(["CONTRACT_SELECTED"]);

/** Why the funnel refused, when it refused. Recorded, not inferred. */
function noContractReason(db: EvidenceDb, symbol: string, sessionDate: string): string | null {
  if (!hasTable(db, "contract_funnel_evidence")) return null;
  try {
    const r = db.prepare(
      `SELECT terminal_reason FROM contract_funnel_evidence
        WHERE symbol = ? AND session_date = ? AND terminal_reason IS NOT NULL
        ORDER BY at_ms DESC LIMIT 1`,
    ).get(String(symbol).toUpperCase(), sessionDate) as any;
    const reason = r?.terminal_reason == null ? null : String(r.terminal_reason);
    if (reason == null || FUNNEL_SUCCESS_REASONS.has(reason)) return null;
    return reason;
  } catch {
    return null;
  }
}

/** Did any lane record a decision about this symbol at all? */
function everAdmitted(db: EvidenceDb, symbol: string, sessionDate: string): boolean {
  const sym = String(symbol).toUpperCase();
  for (const [table, col] of [
    ["options_candidates", "symbol"],
    ["contract_funnel_evidence", "symbol"],
    ["options_research_observations", "symbol"],
  ] as const) {
    if (!hasTable(db, table)) continue;
    try {
      const r = db.prepare(
        `SELECT 1 FROM ${table} WHERE ${col} = ? AND session_date = ? LIMIT 1`,
      ).get(sym, sessionDate);
      if (r) return true;
    } catch { /* a missing column is a no, not a crash */ }
  }
  return false;
}

/**
 * Measure the executable half for one session's top movers.
 *
 * Makes NO provider call. `providerRequests` is typed as the literal `0` so a
 * future edit that introduces one cannot type-check without being noticed.
 */
export function measureExecutableOpportunityOnDb(
  db: EvidenceDb,
  opts: { sessionDate: string; minPeakAbsMovePct?: number; limit?: number },
): ExecutableOpportunityReport {
  const sessionDate = opts.sessionDate;
  const minPeakAbsMovePct = Number.isFinite(opts.minPeakAbsMovePct as number)
    ? (opts.minPeakAbsMovePct as number)
    : MIN_PEAK_MOVE_PCT;
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? DEFAULT_LIMIT)));

  const limitations: string[] = [
    "Retrospective. Measures the movers OptiScan actually quoted; it cannot describe "
    + "the ladder on movers nobody quoted, because that evidence does not exist.",
    "Never infers an option return from the underlying's move. A symbol with no NBBO "
    + "carries a null ladder, not a zero.",
    "Makes no provider request, so it stays runnable while the minute cap is saturated.",
  ];

  let movers: any[] = [];
  if (hasTable(db, "market_mover_observations")) {
    try {
      movers = db.prepare(
        `SELECT symbol, first_observed_at_ms, first_rank, first_move_pct, peak_abs_move_pct
           FROM market_mover_observations
          WHERE session_date = ? AND peak_abs_move_pct >= ?
          ORDER BY peak_abs_move_pct DESC, dollar_volume DESC, symbol ASC
          LIMIT ?`,
      ).all(sessionDate, minPeakAbsMovePct, limit) as any[];
    } catch { movers = []; }
  }

  const measurements: ExecutableMeasurement[] = [];
  for (const m of movers) {
    const symbol = String(m.symbol ?? "").toUpperCase();
    if (!symbol) continue;
    const discoveredAtMs = num(m.first_observed_at_ms);
    const quote = firstExecutableQuote(db, symbol, sessionDate);
    const admitted = quote != null || everAdmitted(db, symbol, sessionDate);
    const reason = noContractReason(db, symbol, sessionDate);

    let state: ExecutableState;
    let ladder: AttainableLadder | null = null;
    let note: string;

    if (quote) {
      ladder = ladderFor(db, quote.contract.optionSymbol, sessionDate, quote.contract.entryMark);
      state = "EXECUTABLE_EVIDENCE_PRESENT";
      note = ladder
        ? `Quoted at ${new Date(quote.atMs).toISOString()}; ${ladder.marksUsed} marks on record.`
        : "Quoted, but no marks were taken on the contract, so no ladder can be reported.";
    } else if (!admitted) {
      state = "NOT_ADMITTED_TO_UNIVERSE";
      note = "Never entered any lane's universe, so nothing was ever quoted. "
        + "No return can be claimed for this symbol.";
    } else if (reason) {
      state = "QUOTED_NO_CONTRACT_SELECTED";
      note = `Looked at, but the contract rules refused every candidate (${reason}).`;
    } else {
      // Reached here with no NBBO and no refusal recorded — including the case
      // where the funnel reported CONTRACT_SELECTED but no observation row was
      // written. That is a gap in the record, not a rejection, and saying so is
      // more useful than guessing which it was.
      state = "ADMITTED_NOT_QUOTED";
      note = "Admitted to a universe but no two-sided option quote was ever recorded for it.";
    }

    measurements.push({
      symbol,
      sessionDate,
      state,
      discoveredAtMs,
      premarketRank: num(m.first_rank),
      underlyingMovePct: num(m.first_move_pct),
      peakUnderlyingMovePct: num(m.peak_abs_move_pct),
      firstExecutableNbboAtMs: quote?.atMs ?? null,
      timeToFirstQuoteMinutes: quote && discoveredAtMs != null
        ? Math.round(((quote.atMs - discoveredAtMs) / 60_000) * 10) / 10
        : null,
      contract: quote?.contract ?? null,
      // The invariant, enforced at the one place it can be violated.
      ladder: quote ? ladder : null,
      noContractReason: reason,
      note,
    });
  }

  const withEvidence = measurements.filter((m) => m.ladder != null);
  const bias: SelectionBias = {
    moversConsidered: measurements.length,
    withExecutableEvidence: withEvidence.length,
    quotedWithoutMarks: measurements.filter(
      (m) => m.state === "EXECUTABLE_EVIDENCE_PRESENT" && m.ladder == null,
    ).length,
    quotedButNoContract: measurements.filter((m) => m.state === "QUOTED_NO_CONTRACT_SELECTED").length,
    admittedNotQuoted: measurements.filter((m) => m.state === "ADMITTED_NOT_QUOTED").length,
    notAdmitted: measurements.filter((m) => m.state === "NOT_ADMITTED_TO_UNIVERSE").length,
    unmeasuredFraction: measurements.length
      ? (measurements.length - withEvidence.length) / measurements.length
      : null,
  };

  const attainable = {
    n: withEvidence.length,
    reached10: withEvidence.filter((m) => m.ladder!.pct10).length,
    reached25: withEvidence.filter((m) => m.ladder!.pct25).length,
    reached50: withEvidence.filter((m) => m.ladder!.pct50).length,
    reached100: withEvidence.filter((m) => m.ladder!.pct100).length,
    reached200: withEvidence.filter((m) => m.ladder!.pct200).length,
    medianMfePct: median(withEvidence.map((m) => m.ladder!.mfePct).filter((v): v is number => v != null)),
    medianTimeTo50Minutes: median(
      withEvidence.map((m) => m.ladder!.timeTo50Ms).filter((v): v is number => v != null).map((v) => v / 60_000),
    ),
  };

  if (bias.unmeasuredFraction != null && bias.unmeasuredFraction > 0) {
    limitations.push(
      `${Math.round(bias.unmeasuredFraction * 100)}% of this session's discovered movers carry no `
      + "executable evidence. The aggregates above describe the quoted subset only.",
    );
  }

  return {
    sessionDate,
    minPeakAbsMovePct,
    providerRequests: 0,
    measurements,
    bias,
    attainable,
    evidenceState: !measurements.length
      ? "NO_MOVERS"
      : withEvidence.length === 0 ? "NO_EXECUTABLE_EVIDENCE" : "MEASURABLE",
    limitations,
  };
}
