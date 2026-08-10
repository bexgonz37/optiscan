/**
 * data-truth.ts — what OptiScan ACTUALLY HOLDS, as opposed to what the provider
 * would sell it.
 *
 * The distinction this module exists to enforce:
 *
 *     PROVIDER HAS IT  !=  OPTISCAN HAS IT.
 *
 * `capability-matrix.ts` answers the first question and answers it from probe evidence.
 * It says, correctly, that per-OCC NBBO is available back to at least 2023-07-31. That
 * is a statement about an HTTP endpoint. Reading it as "we can build a 2023 cohort"
 * skips the only step that matters: nothing has ever fetched and stored those rows, and
 * a cohort can only be built from rows that exist locally.
 *
 * Every number here is a COUNT OF STORED ROWS. Nothing is inferred, nothing is
 * projected, and an absent table reports as absent rather than as zero coverage — the
 * two look identical in a total and mean opposite things.
 *
 * Read-only. No provider call, no quota spend, no writes.
 */

export interface TruthDb {
  prepare(sql: string): { get?: (...a: any[]) => any; all?: (...a: any[]) => any[] };
}

/** A store that either exists and has a shape, or does not exist at all. */
export interface StoreCoverage {
  table: string;
  present: boolean;
  rows: number;
  earliestMs: number | null;
  latestMs: number | null;
  earliest: string | null;
  latest: string | null;
  distinctSymbols: number | null;
  distinctContracts: number | null;
  distinctSessions: number | null;
  note: string;
}

function absent(table: string, note: string): StoreCoverage {
  return {
    table, present: false, rows: 0,
    earliestMs: null, latestMs: null, earliest: null, latest: null,
    distinctSymbols: null, distinctContracts: null, distinctSessions: null,
    note,
  };
}

function hasTable(db: TruthDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name));
  } catch {
    return false;
  }
}

const iso = (ms: number | null): string | null =>
  ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();

const n = (v: unknown): number | null => {
  const x = Number(v);
  return v == null || !Number.isFinite(x) ? null : x;
};

/**
 * Coverage of one store.
 *
 * `timeCol` must be an epoch-ms column. Callers pass the column that dates the
 * OBSERVATION, not the row's creation, wherever the two differ — a mark backfilled today
 * about a trade from last week belongs to last week.
 */
function coverage(
  db: TruthDb,
  table: string,
  opts: { timeCol: string; symbolCol?: string | null; contractCol?: string | null; sessionCol?: string | null; note: string },
): StoreCoverage {
  if (!hasTable(db, table)) return absent(table, "table does not exist in this database");
  try {
    const agg = db.prepare(
      `SELECT COUNT(*) rows, MIN(${opts.timeCol}) lo, MAX(${opts.timeCol}) hi FROM ${table}`,
    ).get?.() as any;
    const rows = Number(agg?.rows ?? 0);
    const lo = n(agg?.lo);
    const hi = n(agg?.hi);
    const distinct = (col: string | null | undefined): number | null => {
      if (!col) return null;
      try {
        return Number((db.prepare(`SELECT COUNT(DISTINCT ${col}) c FROM ${table}`).get?.() as any)?.c ?? 0);
      } catch {
        return null;
      }
    };
    return {
      table, present: true, rows,
      earliestMs: lo, latestMs: hi, earliest: iso(lo), latest: iso(hi),
      distinctSymbols: distinct(opts.symbolCol),
      distinctContracts: distinct(opts.contractCol),
      distinctSessions: distinct(opts.sessionCol),
      note: opts.note,
    };
  } catch (err: any) {
    return absent(table, `query failed: ${String(err?.message ?? err).slice(0, 120)}`);
  }
}

export interface DataTruthReport {
  /**
   * Persisted UNDERLYING price history.
   *
   * The headline finding, and the reason this section exists separately: OptiScan has
   * no bar store at all. `computeOptionsFeatures` runs on bars fetched per scan and
   * discarded, so the features derived from them survive while the bars themselves
   * never do. Any historical study of "what the underlying looked like before the run"
   * is therefore limited to the feature snapshots listed here, at the cadence the
   * scanner happened to run — it cannot be re-derived at a finer grain without
   * re-fetching from the provider.
   */
  underlying: {
    dedicatedBarStore: null;
    dedicatedBarStoreNote: string;
    derivedStores: StoreCoverage[];
  };
  /** Per-contract option observations actually stored locally. */
  optionsIngested: StoreCoverage[];
  /** The evidence lanes a cohort could be built from. */
  evidence: StoreCoverage[];
  note: string;
}

export function buildDataTruthReport(db: TruthDb): DataTruthReport {
  return {
    underlying: {
      dedicatedBarStore: null,
      dedicatedBarStoreNote:
        "NO persisted underlying bar/candle table exists. Bars are fetched per scan by "
        + "deps.getBars, consumed by computeOptionsFeatures, and discarded. What survives is the "
        + "DERIVED feature snapshot at scanner cadence, not the price series. Historical "
        + "underlying work must either re-fetch from the provider (entitled and integrated — see "
        + "capability-matrix 'Historical underlying aggregates') or accept scanner-cadence "
        + "features. This is a storage fact, not a provider limitation.",
      derivedStores: [
        coverage(db, "options_candidates", {
          timeCol: "created_at_ms", symbolCol: "symbol", contractCol: "option_symbol",
          note: "Decision-time feature snapshot per evaluated candidate (feature_snapshot_json holds hod/lod/vwap/compression).",
        }),
        coverage(db, "options_research_observations", {
          timeCol: "observed_at_ms", symbolCol: "symbol", contractCol: "option_symbol", sessionCol: "session_date",
          note: "Prospective research observations, including underlying price, VWAP and trigger level.",
        }),
        coverage(db, "market_context_snapshots", {
          timeCol: "created_at_ms",
          note: "Market regime/structure context. No per-symbol prices.",
        }),
      ],
    },
    optionsIngested: [
      coverage(db, "options_paper_marks", {
        timeCol: "mark_at_ms", contractCol: "option_symbol",
        note:
          "THE contract-consistent truth. Every row is a bid/ask observation on a NAMED OCC. "
          + "This is the only store from which a same-contract excursion or a milestone time can be computed.",
      }),
      coverage(db, "options_paper_trades", {
        timeCol: "created_at_ms", contractCol: "option_symbol",
        note: "Entry/exit identity per mirror. Carries entry_fill, IV, delta, OI and volume AS AT ENTRY only.",
      }),
      coverage(db, "options_snapshots", {
        timeCol: "id", contractCol: "option_symbol",
        note:
          "Legacy alert-linked option snapshot (bid/ask/IV/delta/OI). Dated by TEXT taken_at, so the "
          + "id range is reported instead of a timestamp range — an ordering, not a date.",
      }),
      coverage(db, "opportunity_contract_candidates", {
        timeCol: "observed_at_ms", contractCol: "option_symbol",
        note: "Contracts a case observed but did not freeze. Alternate observations, never trajectory.",
      }),
    ],
    evidence: [
      coverage(db, "opportunity_cases", {
        timeCol: "detected_at_ms", symbolCol: "underlying_symbol", sessionCol: "session_date",
        note: "The case population. Only delivery_decision='delivered' rows ever carried a number to a reader.",
      }),
      coverage(db, "opportunity_excursion_corrections", {
        timeCol: "corrected_at_ms",
        note: "The excursion audit record. VERIFIED_EXCURSION rows are the ONLY ones a cohort may use for MFE/MAE.",
      }),
      coverage(db, "opportunity_pre_move_discovery", {
        timeCol: "first_detected_at_ms", symbolCol: "symbol", contractCol: "option_symbol", sessionCol: "session_date",
        note:
          "PRE_MOVE_DISCOVERY_V1 prospective capture. Rows exist only from the moment capture shipped; "
          + "historical cases have none and none was invented for them.",
      }),
    ],
    note:
      "Counts are STORED ROWS. An absent table is reported absent, never as zero coverage — the two "
      + "look identical in a total and mean opposite things. Provider entitlement is a separate "
      + "question answered by capability-matrix.ts; entitlement is not possession.",
  };
}

/**
 * Whether the local record can support same-contract historical work at all.
 *
 * Deliberately narrow. It answers "is there contract-consistent evidence here", not
 * "is there enough evidence to draw a conclusion" — that second question belongs to
 * whatever cohort is being built, which knows its own stratification.
 */
export function historicalOptionsReadiness(db: TruthDb): {
  state: "NO_LOCAL_OPTION_HISTORY" | "LOCAL_OPTION_HISTORY_PRESENT";
  marks: number;
  distinctContracts: number;
  spanDays: number | null;
  reason: string;
} {
  const marks = coverage(db, "options_paper_marks", { timeCol: "mark_at_ms", contractCol: "option_symbol", note: "" });
  if (!marks.present || marks.rows === 0) {
    return {
      state: "NO_LOCAL_OPTION_HISTORY", marks: 0, distinctContracts: 0, spanDays: null,
      reason: "no per-contract option observations are stored locally",
    };
  }
  const spanDays = marks.earliestMs != null && marks.latestMs != null
    ? +((marks.latestMs - marks.earliestMs) / 86_400_000).toFixed(2)
    : null;
  return {
    state: "LOCAL_OPTION_HISTORY_PRESENT",
    marks: marks.rows,
    distinctContracts: marks.distinctContracts ?? 0,
    spanDays,
    reason:
      `${marks.rows} same-contract observations across ${marks.distinctContracts ?? 0} contracts spanning `
      + `${spanDays ?? "?"} days. Presence is not sufficiency: a cohort must still state its own sample.`,
  };
}
