/**
 * store.ts — durable missed-opportunity case registry.
 *
 * Additive and repeat-safe: CREATE ... IF NOT EXISTS plus an upsert keyed on
 * (session_date, symbol, occ_symbol, case_version), so replaying a session's
 * forensic overwrites its own row instead of accumulating near-duplicates. No
 * existing table is altered and there is no destructive DDL here.
 *
 * Not registered in schema readiness, every write is guarded, every function
 * returns a result rather than throwing. A persistence fault in a research
 * subsystem must never reach the scanner, delivery, or Discord.
 *
 * `case_version` is part of the key on purpose. When classification logic
 * changes, the new run writes a NEW row rather than silently rewriting history —
 * so a conclusion drawn last week remains inspectable next to the one that
 * replaced it.
 */
import { MISSED_OPPORTUNITY_CASE_VERSION, type MissedOpportunityCase } from "./types.ts";

type StoreDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

export interface StoreResult {
  ok: boolean;
  created: boolean;
  error: string | null;
}

/** Idempotent schema. Safe to call on every write. */
export function ensureMissedOpportunitySchema(db: StoreDb): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS missed_opportunity_cases (
        missed_opportunity_id TEXT PRIMARY KEY,
        case_version INTEGER NOT NULL,
        session_date TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT,
        occ_symbol TEXT,
        expiration TEXT,
        strike REAL,
        dte INTEGER,
        claim_verdict TEXT NOT NULL,
        claimed_return_pct REAL,
        executable_return_pct REAL,
        return_basis TEXT,
        root_cause TEXT NOT NULL,
        secondary_causes TEXT NOT NULL,
        failure_family TEXT NOT NULL,
        recoverability TEXT NOT NULL,
        evidence_quality TEXT NOT NULL,
        status TEXT NOT NULL,
        production_changed INTEGER NOT NULL DEFAULT 0,
        case_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_missed_opp_session
        ON missed_opportunity_cases(session_date, symbol);
      CREATE INDEX IF NOT EXISTS idx_missed_opp_cause
        ON missed_opportunity_cases(root_cause, session_date);
      CREATE INDEX IF NOT EXISTS idx_missed_opp_recoverability
        ON missed_opportunity_cases(recoverability, session_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_opp_identity
        ON missed_opportunity_cases(session_date, symbol, IFNULL(occ_symbol,''), case_version);
    `);
  } catch {
    /* research storage never escalates */
  }
}

/** Deterministic id, so the same case re-derived twice is the same row. */
export function missedOpportunityId(
  sessionDate: string,
  symbol: string,
  occSymbol: string | null,
  caseVersion: number = MISSED_OPPORTUNITY_CASE_VERSION,
): string {
  return `mo:${sessionDate}:${symbol.toUpperCase()}:${occSymbol ?? "NO_OCC"}:v${caseVersion}`;
}

export function saveMissedOpportunityCase(
  db: StoreDb,
  c: MissedOpportunityCase,
): StoreResult {
  try {
    ensureMissedOpportunitySchema(db);
    const existing = db
      .prepare("SELECT 1 FROM missed_opportunity_cases WHERE missed_opportunity_id=?")
      .get(c.missedOpportunityId);

    db.prepare(
      `INSERT INTO missed_opportunity_cases (
         missed_opportunity_id, case_version, session_date, symbol, direction, occ_symbol,
         expiration, strike, dte, claim_verdict, claimed_return_pct, executable_return_pct,
         return_basis, root_cause, secondary_causes, failure_family, recoverability,
         evidence_quality, status, production_changed, case_json, created_at_ms, updated_at_ms
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(missed_opportunity_id) DO UPDATE SET
         claim_verdict=excluded.claim_verdict,
         claimed_return_pct=excluded.claimed_return_pct,
         executable_return_pct=excluded.executable_return_pct,
         return_basis=excluded.return_basis,
         root_cause=excluded.root_cause,
         secondary_causes=excluded.secondary_causes,
         failure_family=excluded.failure_family,
         recoverability=excluded.recoverability,
         evidence_quality=excluded.evidence_quality,
         status=excluded.status,
         case_json=excluded.case_json,
         updated_at_ms=excluded.updated_at_ms`,
    ).run(
      c.missedOpportunityId,
      c.caseVersion,
      c.sessionDate,
      c.symbol.toUpperCase(),
      c.direction,
      c.occSymbol,
      c.expiration,
      c.strike,
      c.dte,
      c.externalClaim.verdict,
      c.externalClaim.claimedReturnPct,
      c.verified.executableReturnPct,
      c.verified.basis,
      c.rootCause,
      JSON.stringify(c.secondaryCauses),
      c.failureFamily,
      c.recoverability,
      c.evidenceQuality,
      c.status,
      c.productionChanged ? 1 : 0,
      JSON.stringify(c),
      c.createdAtMs,
      c.updatedAtMs,
    );

    return { ok: true, created: !existing, error: null };
  } catch (e) {
    return { ok: false, created: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function listMissedOpportunityCases(
  db: StoreDb,
  opts: { sessionDate?: string; symbol?: string; limit?: number } = {},
): MissedOpportunityCase[] {
  try {
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='missed_opportunity_cases'")
      .get();
    if (!has) return [];
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const rows = db
      .prepare(
        `SELECT case_json FROM missed_opportunity_cases
          WHERE (? IS NULL OR session_date=?) AND (? IS NULL OR symbol=?)
          ORDER BY session_date DESC, symbol ASC LIMIT ${limit}`,
      )
      .all(
        opts.sessionDate ?? null, opts.sessionDate ?? null,
        opts.symbol?.toUpperCase() ?? null, opts.symbol?.toUpperCase() ?? null,
      ) as any[];
    const out: MissedOpportunityCase[] = [];
    for (const r of rows) {
      try { out.push(JSON.parse(String(r.case_json))); } catch { /* skip unreadable row */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Recurring-defect rollup for the weekend report. Correct rejections are excluded. */
export function rootCauseTally(
  db: StoreDb,
  sinceSessionDate: string,
): { rootCause: string; count: number; symbols: string[] }[] {
  try {
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='missed_opportunity_cases'")
      .get();
    if (!has) return [];
    const rows = db
      .prepare(
        `SELECT root_cause, COUNT(*) n, GROUP_CONCAT(DISTINCT symbol) syms
           FROM missed_opportunity_cases
          WHERE session_date >= ? AND recoverability <> 'CORRECTLY_REJECTED'
          GROUP BY root_cause ORDER BY n DESC LIMIT 50`,
      )
      .all(sinceSessionDate) as any[];
    return rows.map((r) => ({
      rootCause: String(r.root_cause),
      count: Number(r.n) || 0,
      symbols: String(r.syms ?? "").split(",").filter(Boolean),
    }));
  } catch {
    return [];
  }
}
