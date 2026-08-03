/**
 * contract-funnel-store.ts — durable persistence for contract-discovery evidence.
 *
 * WHY THIS EXISTS.
 *
 * `selectContractWithEvidence` has produced a complete `ContractFunnelEvidence`
 * record for every candidate since `a4777ec`. Nothing ever stored it. It was
 * returned on `OptionsEvalResult.contractFunnel`, read by no one, and discarded
 * when the candidate row was written.
 *
 * Two things were impossible as a result, and both were on the roadmap as
 * required next steps:
 *
 *  1. **`deltaSource` could not be measured.** The stated validation for the
 *     2026-08-03 fix was "confirm deltaSource splits sensibly between
 *     PROVIDER_DELTA and MONEYNESS_PROXY". No such split existed anywhere in the
 *     database, so the check could not be run at all — and a fix whose effect is
 *     unmeasurable cannot be promoted, only believed.
 *  2. **The discovery monitor had no input.** `discovery-monitor.ts` shipped in
 *     the same commit, consumes `ContractFunnelEvidence[]`, and had exactly one
 *     caller: its own test file. The alert it exists to raise — "SPY generated 18
 *     bullish candidates and zero calls reached pricing" — could never fire in
 *     production.
 *
 * This is a LOG, not a keyed summary: one row per candidate evaluation, so the
 * funnel can be sliced by symbol, side, strategy, terminal reason and selection
 * version after the fact. It answers "which narrowing killed this candidate",
 * which a keyed table holding only the latest state cannot.
 *
 * SAFETY. Additive and repeat-safe DDL only — CREATE ... IF NOT EXISTS, no ALTER,
 * no destructive statement. Not registered in schema readiness. Every function
 * swallows its own errors and returns a result. A persistence fault here must
 * never reach the scanner, contract selection, or Discord: this is evidence about
 * the pipeline and must always be the thing that gives way.
 */
import type { ContractFunnelEvidence } from "./contract-discovery.ts";

type StoreDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

/** Idempotent schema. Safe to call on every write. */
export function ensureContractFunnelSchema(db: StoreDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_funnel_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_date TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT,
      requested_side TEXT NOT NULL,
      strategy_key TEXT NOT NULL,

      discovery_version TEXT NOT NULL,
      selection_version TEXT NOT NULL,

      contracts_received INTEGER NOT NULL DEFAULT 0,
      calls_received INTEGER NOT NULL DEFAULT 0,
      puts_received INTEGER NOT NULL DEFAULT 0,
      passed_side INTEGER NOT NULL DEFAULT 0,
      passed_dte INTEGER NOT NULL DEFAULT 0,
      two_sided INTEGER NOT NULL DEFAULT 0,
      with_delta INTEGER NOT NULL DEFAULT 0,
      /* NULL, never 0, when there was no tradeable universe to divide by. */
      delta_coverage REAL,
      passed_delta_band INTEGER NOT NULL DEFAULT 0,
      ranked_count INTEGER NOT NULL DEFAULT 0,

      delta_source TEXT,
      selected_occ TEXT,
      terminal_reason TEXT NOT NULL,
      greeks_missing_on_side INTEGER NOT NULL DEFAULT 0,
      page_limit_reached INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_contract_funnel_session
      ON contract_funnel_evidence(session_date, at_ms);
    CREATE INDEX IF NOT EXISTS idx_contract_funnel_symbol
      ON contract_funnel_evidence(session_date, symbol, requested_side);
    CREATE INDEX IF NOT EXISTS idx_contract_funnel_terminal
      ON contract_funnel_evidence(session_date, terminal_reason);
  `);
}

export interface FunnelWriteResult {
  ok: boolean;
  error: string | null;
}

/**
 * Record one candidate's contract search. Never throws.
 *
 * `sessionDate` is passed in rather than derived here so a replay can write
 * historical rows without this module reaching for a clock.
 */
export function recordContractFunnelOnDb(
  db: StoreDb,
  sessionDate: string,
  ev: ContractFunnelEvidence,
): FunnelWriteResult {
  try {
    ensureContractFunnelSchema(db);
    db.prepare(
      `INSERT INTO contract_funnel_evidence (
         session_date, at_ms, symbol, direction, requested_side, strategy_key,
         discovery_version, selection_version,
         contracts_received, calls_received, puts_received, passed_side, passed_dte,
         two_sided, with_delta, delta_coverage, passed_delta_band, ranked_count,
         delta_source, selected_occ, terminal_reason,
         greeks_missing_on_side, page_limit_reached
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sessionDate, ev.atMs, ev.symbol, ev.direction ?? null, ev.requestedSide, ev.strategyKey,
      ev.discoveryVersion, ev.selectionVersion,
      ev.contractsReceived, ev.callsReceived, ev.putsReceived, ev.passedSide, ev.passedDte,
      ev.twoSided, ev.withDelta,
      // A chain with no tradeable contracts has UNKNOWN coverage, not 0% coverage.
      // Writing 0 here would let "we never got to look" average in with "we looked
      // and the provider published nothing" — the exact null-becomes-zero defect
      // this pipeline is being audited for.
      ev.twoSided > 0 || ev.withDelta > 0 ? ev.deltaCoverage : null,
      ev.passedDeltaBand, ev.rankedCount,
      ev.deltaSource ?? null, ev.selectedOcc ?? null, ev.terminalReason,
      ev.greeksMissingOnSide ? 1 : 0, ev.pageLimitReached ? 1 : 0,
    );
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One symbol/side's recent evidence, newest first — the monitor's input. */
export function readRecentFunnelEvidenceOnDb(
  db: StoreDb,
  sessionDate: string,
  sinceMs: number,
  limit = 2000,
): ContractFunnelEvidence[] {
  try {
    ensureContractFunnelSchema(db);
    const rows = db.prepare(
      `SELECT * FROM contract_funnel_evidence
        WHERE session_date = ? AND at_ms >= ?
        ORDER BY at_ms DESC LIMIT ?`,
    ).all(sessionDate, sinceMs, limit) as Record<string, unknown>[];
    return rows.map(rowToEvidence);
  } catch {
    return [];
  }
}

function rowToEvidence(r: Record<string, unknown>): ContractFunnelEvidence {
  const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
  return {
    symbol: String(r.symbol ?? ""),
    direction: r.direction == null ? null : String(r.direction),
    requestedSide: (r.requested_side === "put" ? "put" : "call"),
    strategyKey: String(r.strategy_key ?? ""),
    atMs: n(r.at_ms),
    discoveryVersion: String(r.discovery_version ?? ""),
    selectionVersion: String(r.selection_version ?? ""),
    // Not persisted per-row — they belong to the request plan, not the outcome.
    partitionsAttempted: [],
    requestedDteBuckets: [],
    preferredDelta: [0, 1],
    moneyness: "ATM",
    contractsReceived: n(r.contracts_received),
    callsReceived: n(r.calls_received),
    putsReceived: n(r.puts_received),
    passedSide: n(r.passed_side),
    passedDte: n(r.passed_dte),
    withBid: n(r.two_sided),
    withAsk: n(r.two_sided),
    twoSided: n(r.two_sided),
    withDelta: n(r.with_delta),
    // A NULL coverage means "unknown", and must not read back as 0% coverage.
    deltaCoverage: r.delta_coverage == null ? 0 : n(r.delta_coverage),
    passedDeltaBand: n(r.passed_delta_band),
    rankedCount: n(r.ranked_count),
    deltaSource: r.delta_source == null ? null : (String(r.delta_source) as ContractFunnelEvidence["deltaSource"]),
    selectedOcc: r.selected_occ == null ? null : String(r.selected_occ),
    terminalReason: String(r.terminal_reason ?? "INSUFFICIENT_EVIDENCE") as ContractFunnelEvidence["terminalReason"],
    greeksMissingOnSide: n(r.greeks_missing_on_side) === 1,
    pageLimitReached: n(r.page_limit_reached) === 1,
  };
}

export interface DeltaSourceSplit {
  total: number;
  providerDelta: number;
  moneynessProxy: number;
  unselected: number;
  /** Share of SELECTED contracts that required the missing-data fallback. */
  proxyShareOfSelected: number | null;
}

/**
 * The measurement the 2026-08-03 fix was supposed to be validated against, and
 * which no query could answer until this table existed.
 */
export function deltaSourceSplitOnDb(
  db: StoreDb,
  sessionDate: string,
  opts: { symbol?: string; side?: "call" | "put" } = {},
): DeltaSourceSplit {
  const empty: DeltaSourceSplit = {
    total: 0, providerDelta: 0, moneynessProxy: 0, unselected: 0, proxyShareOfSelected: null,
  };
  try {
    ensureContractFunnelSchema(db);
    const where = ["session_date = ?"];
    const args: unknown[] = [sessionDate];
    if (opts.symbol) { where.push("symbol = ?"); args.push(opts.symbol); }
    if (opts.side) { where.push("requested_side = ?"); args.push(opts.side); }
    const rows = db.prepare(
      `SELECT delta_source AS src, COUNT(*) AS n
         FROM contract_funnel_evidence WHERE ${where.join(" AND ")}
        GROUP BY delta_source`,
    ).all(...args) as { src: string | null; n: number }[];

    const out = { ...empty };
    for (const r of rows) {
      const n = Number(r.n ?? 0);
      out.total += n;
      if (r.src === "PROVIDER_DELTA") out.providerDelta += n;
      else if (r.src === "MONEYNESS_PROXY") out.moneynessProxy += n;
      else out.unselected += n;
    }
    const selected = out.providerDelta + out.moneynessProxy;
    // No selections is not 0% proxy use — it is no evidence. Stay null.
    out.proxyShareOfSelected = selected > 0 ? out.moneynessProxy / selected : null;
    return out;
  } catch {
    return empty;
  }
}

/** Terminal-reason distribution — "what killed the funnel today", by count. */
export function terminalReasonBreakdownOnDb(
  db: StoreDb,
  sessionDate: string,
): { reason: string; count: number }[] {
  try {
    ensureContractFunnelSchema(db);
    return (db.prepare(
      `SELECT terminal_reason AS reason, COUNT(*) AS count
         FROM contract_funnel_evidence WHERE session_date = ?
        GROUP BY terminal_reason ORDER BY count DESC`,
    ).all(sessionDate) as { reason: string; count: number }[]).map((r) => ({
      reason: String(r.reason), count: Number(r.count ?? 0),
    }));
  } catch {
    return [];
  }
}
