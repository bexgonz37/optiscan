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
  const cols = new Set(
    (db.prepare("PRAGMA table_info(contract_funnel_evidence)").all() as Array<{ name: string }>)
      .map((c) => String(c.name)),
  );
  const add = (name: string, ddl: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE contract_funnel_evidence ADD COLUMN ${ddl}`);
  };
  add("requested_dte_min", "requested_dte_min INTEGER");
  add("requested_dte_max", "requested_dte_max INTEGER");
  add("fetched_dte_ranges_json", "fetched_dte_ranges_json TEXT");
  add("requested_expiration_start", "requested_expiration_start TEXT");
  add("requested_expiration_end", "requested_expiration_end TEXT");
  add("expirations_covered_json", "expirations_covered_json TEXT");
  add("pages_requested", "pages_requested INTEGER NOT NULL DEFAULT 0");
  add("pages_received", "pages_received INTEGER NOT NULL DEFAULT 0");
  add("raw_contracts_received", "raw_contracts_received INTEGER NOT NULL DEFAULT 0");
  add("normalized_contracts_received", "normalized_contracts_received INTEGER NOT NULL DEFAULT 0");
  add("chain_outcome", "chain_outcome TEXT");
  add("range_coverage", "range_coverage TEXT NOT NULL DEFAULT 'UNKNOWN'");
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
         greeks_missing_on_side, page_limit_reached,
         requested_dte_min, requested_dte_max, fetched_dte_ranges_json,
         requested_expiration_start, requested_expiration_end, expirations_covered_json,
         pages_requested, pages_received, raw_contracts_received, normalized_contracts_received,
         chain_outcome, range_coverage
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      ev.requestedDteMin ?? null, ev.requestedDteMax ?? null, JSON.stringify(ev.fetchedDteRanges ?? []),
      ev.requestedExpirationStart ?? null, ev.requestedExpirationEnd ?? null, JSON.stringify(ev.expirationsCovered ?? []),
      ev.pagesRequested ?? 0, ev.pagesReceived ?? 0, ev.rawContractsReceived ?? ev.contractsReceived,
      ev.normalizedContractsReceived ?? ev.contractsReceived,
      ev.chainOutcome ?? null, ev.rangeCoverage ?? "UNKNOWN",
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
  opts: FunnelScope = {},
): ContractFunnelEvidence[] {
  try {
    ensureContractFunnelSchema(db);
    const { sql: whereSql, args } = funnelWhere(sessionDate, opts, { sinceMs });
    const rows = db.prepare(
      `SELECT * FROM contract_funnel_evidence
        WHERE ${whereSql}
        ORDER BY at_ms DESC LIMIT ?`,
    ).all(...args, limit) as Record<string, unknown>[];
    return rows.map(rowToEvidence);
  } catch {
    return [];
  }
}

function rowToEvidence(r: Record<string, unknown>): ContractFunnelEvidence {
  const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
  const stringArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v !== "string" || !v.trim()) return [];
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
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
    requestedDteMin: r.requested_dte_min == null ? null : n(r.requested_dte_min),
    requestedDteMax: r.requested_dte_max == null ? null : n(r.requested_dte_max),
    fetchedDteRanges: stringArray(r.fetched_dte_ranges_json),
    requestedExpirationStart: r.requested_expiration_start == null ? null : String(r.requested_expiration_start),
    requestedExpirationEnd: r.requested_expiration_end == null ? null : String(r.requested_expiration_end),
    expirationsCovered: stringArray(r.expirations_covered_json),
    pagesRequested: n(r.pages_requested),
    pagesReceived: n(r.pages_received),
    rawContractsReceived: n(r.raw_contracts_received),
    normalizedContractsReceived: n(r.normalized_contracts_received),
    chainOutcome: r.chain_outcome == null ? null : String(r.chain_outcome) as ContractFunnelEvidence["chainOutcome"],
    rangeCoverage: (["FULL", "PARTIAL", "NONE", "UNKNOWN"].includes(String(r.range_coverage))
      ? String(r.range_coverage)
      : "UNKNOWN") as ContractFunnelEvidence["rangeCoverage"],
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

/** Scope shared by every funnel reader, so a filter cannot be honoured by one and dropped by another. */
export type FunnelScope = { symbol?: string; side?: "call" | "put" };

/**
 * One filter builder for all three readers.
 *
 * These clauses used to be written inline in deltaSourceSplitOnDb only. The other
 * two readers took no scope at all, so `?symbol=SPY` returned SPY's delta split
 * beside GLOBAL terminal reasons and a GLOBAL observed count — all three under a
 * `scope: { symbol: "SPY" }` header that claimed otherwise.
 */
function funnelWhere(sessionDate: string, scope: FunnelScope, extra: { sinceMs?: number } = {}) {
  const where = ["session_date = ?"];
  const args: unknown[] = [sessionDate];
  if (extra.sinceMs != null) { where.push("at_ms >= ?"); args.push(extra.sinceMs); }
  if (scope.symbol) { where.push("symbol = ?"); args.push(scope.symbol); }
  if (scope.side) { where.push("requested_side = ?"); args.push(scope.side); }
  return { sql: where.join(" AND "), args };
}

/**
 * The measurement the 2026-08-03 fix was supposed to be validated against, and
 * which no query could answer until this table existed.
 */
export function deltaSourceSplitOnDb(
  db: StoreDb,
  sessionDate: string,
  opts: FunnelScope = {},
): DeltaSourceSplit {
  const empty: DeltaSourceSplit = {
    total: 0, providerDelta: 0, moneynessProxy: 0, unselected: 0, proxyShareOfSelected: null,
  };
  try {
    ensureContractFunnelSchema(db);
    const { sql: whereSql, args } = funnelWhere(sessionDate, opts);
    const where = [whereSql];
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

/**
 * Per-strategy stage census — "how far did each strategy's candidates get".
 *
 * WHY THIS EXISTS. `terminalReasonBreakdownOnDb` says 51 of 52 SPY rows died at
 * NO_CONTRACT_IN_DTE_RANGE. It cannot say WHICH strategy asked, or whether the
 * chain that was handed to the filter even contained the band the strategy
 * wanted. Those two facts separate a real DTE/expiration defect from a strategy
 * whose requested band the fetch could never have supplied — and they are the
 * difference between fixing the date math and fixing the request.
 *
 * `contractsReceived` / `passedSide` / `passedDte` are the three counts either
 * diagnosis has to explain, so they are reported per strategy rather than summed.
 * Averages are carried as SUM + n so a caller can weight them honestly; a
 * strategy with no rows is absent rather than reported as zero.
 */
export function strategyStageBreakdownOnDb(
  db: StoreDb,
  sessionDate: string,
  opts: FunnelScope = {},
): {
  strategyKey: string; rows: number; terminalReason: string;
  contractsReceived: number; passedSide: number; passedDte: number;
  requestedDteMin: number | null; requestedDteMax: number | null;
  fetchedDteRanges: string[]; expirationsCovered: string[];
  pagesRequested: number; pagesReceived: number;
  rawContractsReceived: number; normalizedContractsReceived: number;
  chainOutcomes: string[]; rangeCoverage: string[];
}[] {
  try {
    ensureContractFunnelSchema(db);
    const { sql: whereSql, args } = funnelWhere(sessionDate, opts);
    const splitConcat = (v: unknown): string[] =>
      typeof v === "string" && v.length ? v.split("\x1f").filter(Boolean) : [];
    const jsonArraysFromConcat = (v: unknown): string[] => {
      const out = new Set<string>();
      for (const part of splitConcat(v)) {
        try {
          const parsed = JSON.parse(part);
          if (Array.isArray(parsed)) for (const item of parsed) out.add(String(item));
        } catch { /* ignore legacy/non-json values */ }
      }
      return [...out].sort();
    };
    return (db.prepare(
      `SELECT strategy_key AS strategyKey, terminal_reason AS terminalReason,
              COUNT(*) AS n,
              SUM(contracts_received) AS contractsReceived,
              SUM(passed_side) AS passedSide,
              SUM(passed_dte) AS passedDte,
              MIN(requested_dte_min) AS requestedDteMin,
              MAX(requested_dte_max) AS requestedDteMax,
              GROUP_CONCAT(fetched_dte_ranges_json, CHAR(31)) AS fetchedDteRangesJson,
              GROUP_CONCAT(expirations_covered_json, CHAR(31)) AS expirationsCoveredJson,
              SUM(pages_requested) AS pagesRequested,
              SUM(pages_received) AS pagesReceived,
              SUM(raw_contracts_received) AS rawContractsReceived,
              SUM(normalized_contracts_received) AS normalizedContractsReceived,
              GROUP_CONCAT(chain_outcome, CHAR(31)) AS chainOutcomes,
              GROUP_CONCAT(range_coverage, CHAR(31)) AS rangeCoverage
         FROM contract_funnel_evidence WHERE ${whereSql}
        GROUP BY strategy_key, terminal_reason
        ORDER BY n DESC`,
    ).all(...args) as Record<string, unknown>[]).map((r) => ({
      strategyKey: String(r.strategyKey ?? ""),
      terminalReason: String(r.terminalReason ?? ""),
      rows: Number(r.n ?? 0),
      contractsReceived: Number(r.contractsReceived ?? 0),
      passedSide: Number(r.passedSide ?? 0),
      passedDte: Number(r.passedDte ?? 0),
      requestedDteMin: r.requestedDteMin == null ? null : Number(r.requestedDteMin),
      requestedDteMax: r.requestedDteMax == null ? null : Number(r.requestedDteMax),
      fetchedDteRanges: jsonArraysFromConcat(r.fetchedDteRangesJson),
      expirationsCovered: jsonArraysFromConcat(r.expirationsCoveredJson),
      pagesRequested: Number(r.pagesRequested ?? 0),
      pagesReceived: Number(r.pagesReceived ?? 0),
      rawContractsReceived: Number(r.rawContractsReceived ?? 0),
      normalizedContractsReceived: Number(r.normalizedContractsReceived ?? 0),
      chainOutcomes: [...new Set(splitConcat(r.chainOutcomes))].sort(),
      rangeCoverage: [...new Set(splitConcat(r.rangeCoverage))].sort(),
    }));
  } catch {
    return [];
  }
}

/** Terminal-reason distribution — "what killed the funnel today", by count, within scope. */
export function terminalReasonBreakdownOnDb(
  db: StoreDb,
  sessionDate: string,
  opts: FunnelScope = {},
): { reason: string; count: number; distinctSymbols: number }[] {
  try {
    ensureContractFunnelSchema(db);
    const { sql: whereSql, args } = funnelWhere(sessionDate, opts);
    // `count` is ATTEMPTS — one row per candidate evaluation that reached contract
    // selection. The scanner re-evaluates the same symbol every cooldown, so a single
    // symbol blocked by provider quota all session contributes many attempts. Reporting
    // attempts beside distinct symbols is what makes "49" and "780" comparable instead
    // of contradictory: they are the same event counted in two different units.
    return (db.prepare(
      `SELECT terminal_reason AS reason, COUNT(*) AS count,
              COUNT(DISTINCT symbol) AS distinctSymbols
         FROM contract_funnel_evidence WHERE ${whereSql}
        GROUP BY terminal_reason ORDER BY count DESC`,
    ).all(...args) as { reason: string; count: number; distinctSymbols: number }[]).map((r) => ({
      reason: String(r.reason),
      count: Number(r.count ?? 0),
      distinctSymbols: Number(r.distinctSymbols ?? 0),
    }));
  } catch {
    return [];
  }
}
