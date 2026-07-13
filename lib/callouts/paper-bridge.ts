/**
 * callouts/paper-bridge.ts — the ONE authoritative bridge from Supervisor canonical
 * callouts to paper candidates. Impure (SQLite), but the eligibility decision is the
 * PURE rule in eligibility.ts.
 *
 * Flow: canonical callout → paperCandidateEligibility (HIGH + ACTIONABLE_NOW + valid
 * now + paper env gates) → freeze an auditable paper_candidates row → createPaperTrade
 * (the SAME risk/capital/READY path the legacy alert auto-entry uses) → the existing
 * sweep advances it through pre-entry revalidation → conservative fill → open → exit →
 * graded outcome. This module does NOT fill, price, or grade anything itself.
 *
 * Dedup: idempotency_key = paper:<ticker|dir|horizon>:<status>:<trading-day> is UNIQUE,
 * so scanner cycles, restarts, Discord retries, and lifecycle refreshes never create a
 * second candidate for the same setup identity that day. Only eligible callouts touch
 * this table — WAIT/WATCH/NEAR/MISSED/EXTENDED/etc. remain dashboard-only.
 */
import type { Callout } from "./callout.ts";
import { paperCandidateEligibility } from "./eligibility.ts";
import { estimatedEntryPrice } from "./confidence.ts";
import { tradingDay } from "../trading-session.ts";

// The DB + paper-engine live behind the "@/" alias and pull in server-only I/O.
// They are lazy-required (literal specifiers so the webpack alias still resolves)
// so the PURE, testable OnDb core imports cleanly under `node --test`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveDb = () => require("@/lib/db").getDb();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveCreateTrade: CreateTradeFn = (input) => require("@/lib/paper-engine").createPaperTrade(input);

export interface BridgeSummary {
  evaluated: number;
  eligible: number;
  created: number;
  duplicates: number;
  rejected: number;
  rejections: { ticker: string; reason: string }[];
}

/** Minimal DB surface the bridge needs (better-sqlite3 shaped). */
interface BridgeDb {
  prepare(sql: string): { get: (...a: any[]) => any; run: (...a: any[]) => { lastInsertRowid: number | bigint } };
}
/** The create-trade contract the bridge depends on (createPaperTrade compatible). */
export type CreateTradeFn = (input: {
  ticker: string; optionSymbol: string | null; optionType: "call" | "put";
  strike: number | null; expiration: string | null; dte: number | null;
  entryLimit: number | null; thesis: string;
}) => { ok: boolean; id?: number; risk: { allowed: boolean; failures: string[] } };

/**
 * Trading-day stamp used to scope the dedup key to one day. Uses the US/Eastern
 * trading day (DST-safe), NOT the UTC date — otherwise a late-afternoon or
 * after-hours setup after 20:00 ET would roll onto the next UTC calendar day and
 * mid-session dedup could break (a second identical candidate would look "new").
 */
function dayStamp(nowMs: number): string {
  return tradingDay(nowMs);
}

/** Stable per-day idempotency key for a callout's paper candidate. */
export function candidateIdempotencyKey(c: Callout, nowMs: number): string {
  return `paper:${c.key}:${c.status}:${dayStamp(nowMs)}`;
}

/** Real quote-as-of timestamp when the timing diagnostics carry it, else null. */
function quoteAsOfMs(c: Callout, nowMs: number): number | null {
  const age = c.timing?.quoteAgeMs;
  return typeof age === "number" && Number.isFinite(age) ? nowMs - age : null;
}

/**
 * Bridge a batch of callouts on an EXPLICIT db + create-trade fn (testable core).
 * Non-eligible callouts are ignored; eligible ones dedup on the UNIQUE idempotency
 * key so cycles/restarts/retries never create a second candidate for the same setup.
 */
export function bridgeCalloutsToPaperOnDb(
  db: BridgeDb,
  callouts: Callout[],
  createTrade: CreateTradeFn,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): BridgeSummary {
  const summary: BridgeSummary = { evaluated: 0, eligible: 0, created: 0, duplicates: 0, rejected: 0, rejections: [] };

  for (const c of callouts) {
    summary.evaluated += 1;
    const elig = paperCandidateEligibility(c, env);
    if (!elig.ok) continue; // dashboard-only / research-only — never a paper candidate
    summary.eligible += 1;

    const idem = candidateIdempotencyKey(c, nowMs);
    const existing = db.prepare("SELECT id FROM paper_candidates WHERE idempotency_key=?").get(idem) as any;
    if (existing) { summary.duplicates += 1; continue; }

    const k = c.contract!; // eligibility guarantees a valid two-sided contract
    const est = estimatedEntryPrice(c, env);
    // Limit for the conservative fill: the realistic estimated entry (ask + bounded
    // slippage). Slippage is applied ONCE, at fill time, in the fill model — this is
    // only the marketable limit, never an added cost.
    const entryLimit = est ?? k.mid ?? k.ask ?? null;

    let candidateId: number;
    try {
      const info = db.prepare(
        `INSERT INTO paper_candidates
           (idempotency_key, setup_identity, source, callout_key, ticker, direction, strategy, horizon,
            option_symbol, strike, expiration, dte, underlying_price, option_bid, option_ask, option_mid,
            estimated_entry, quote_asof_ms, entry_state, confidence_tier, setup_score, contract_score,
            risk_ok, lifecycle_status, callout_ts_ms, trigger_ts_ms, model_state, evidence_state,
            status, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?)`,
      ).run(
        idem, c.key, "SUPERVISOR", c.key, c.ticker, c.direction, c.strategyAgent, c.horizon,
        k.optionSymbol ?? null, k.strike ?? null, k.expiration ?? null, k.dte ?? null,
        c.underlyingPrice ?? null, k.bid ?? null, k.ask ?? null, k.mid ?? null,
        est ?? null, quoteAsOfMs(c, nowMs), c.entryState ?? null, c.confidenceTier,
        c.contractScore ?? null, c.contractScore ?? null,
        c.riskVerdict?.allowed === false ? 0 : 1, c.lifecycleStatus ?? null,
        c.timestamp ?? null, c.timing?.secondsSinceTrigger != null ? nowMs - c.timing.secondsSinceTrigger * 1000 : null,
        c.modelState ?? null, c.evidenceStatus ?? null,
        "ELIGIBLE", nowMs,
      );
      candidateId = Number(info.lastInsertRowid);
    } catch {
      // A UNIQUE race (two cycles at once) collapses to a duplicate, never a dup row.
      summary.duplicates += 1;
      continue;
    }

    // Create the READY paper trade from the FROZEN alert-time contract. createPaperTrade
    // re-runs freshness + risk + capital; the sweep then does pre-entry revalidation and
    // the conservative fill. No substitution, no fabricated fill.
    const res = createTrade({
      ticker: c.ticker,
      optionSymbol: k.optionSymbol,
      optionType: (k.side as "call" | "put" | null) ?? (c.direction === "bearish" ? "put" : "call"),
      strike: k.strike ?? null,
      expiration: k.expiration ?? null,
      dte: k.dte ?? null,
      entryLimit,
      thesis: `SUPERVISOR ${c.confidenceTier} ${c.status}: ${(c.reason ?? c.waitFor ?? "actionable now").slice(0, 180)}`,
    });

    if (res.ok) {
      summary.created += 1;
      db.prepare("UPDATE paper_candidates SET status='CREATED', paper_trade_id=? WHERE id=?").run(res.id ?? null, candidateId);
    } else {
      const reason = res.risk.failures.join("; ") || "createPaperTrade refused";
      summary.rejected += 1;
      summary.rejections.push({ ticker: c.ticker, reason });
      db.prepare("UPDATE paper_candidates SET status='REJECTED', reject_reason=? WHERE id=?").run(reason, candidateId);
    }
  }
  return summary;
}

/**
 * Bridge a batch of canonical callouts to paper candidates on the live DB. Returns a
 * summary for observability. Delegates to the testable OnDb core with the real
 * createPaperTrade (the SAME risk/capital/READY path the legacy alert auto-entry uses).
 */
export function bridgeCalloutsToPaper(callouts: Callout[], nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): BridgeSummary {
  return bridgeCalloutsToPaperOnDb(liveDb() as BridgeDb, callouts, liveCreateTrade, nowMs, env);
}

export interface PaperCandidateRow {
  id: number;
  ticker: string;
  direction: string;
  horizon: string | null;
  optionSymbol: string | null;
  confidenceTier: string | null;
  entryState: string | null;
  estimatedEntry: number | null;
  status: string;
  rejectReason: string | null;
  paperTradeId: number | null;
  calloutTsMs: number | null;
  triggerTsMs: number | null;
  quoteAsOfMs: number | null;
  createdAtMs: number;
}

/** Recent paper candidates (newest first) for the dashboard/runtime status. */
export function listPaperCandidates(limit = 50, sinceMs?: number): PaperCandidateRow[] {
  const db = liveDb();
  const rows = (sinceMs != null
    ? db.prepare("SELECT * FROM paper_candidates WHERE created_at_ms >= ? ORDER BY id DESC LIMIT ?").all(sinceMs, limit)
    : db.prepare("SELECT * FROM paper_candidates ORDER BY id DESC LIMIT ?").all(limit)) as any[];
  return rows.map((r) => ({
    id: r.id, ticker: r.ticker, direction: r.direction, horizon: r.horizon,
    optionSymbol: r.option_symbol, confidenceTier: r.confidence_tier, entryState: r.entry_state,
    estimatedEntry: r.estimated_entry, status: r.status, rejectReason: r.reject_reason,
    paperTradeId: r.paper_trade_id, calloutTsMs: r.callout_ts_ms, triggerTsMs: r.trigger_ts_ms,
    quoteAsOfMs: r.quote_asof_ms, createdAtMs: r.created_at_ms,
  }));
}

export interface PaperCandidateSummary {
  total: number;
  created: number;
  rejected: number;
  eligiblePending: number;
  last24h: { created: number; rejected: number };
  recentRejections: { ticker: string; reason: string; atMs: number }[];
}

/** Aggregate paper-candidate counts for owner-facing observability. */
export function paperCandidateSummary(nowMs: number = Date.now()): PaperCandidateSummary {
  const db = liveDb();
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_candidates'").get();
  if (!has) return { total: 0, created: 0, rejected: 0, eligiblePending: 0, last24h: { created: 0, rejected: 0 }, recentRejections: [] };
  const dayMs = nowMs - 24 * 3600_000;
  const count = (sql: string, ...args: any[]) => Number((db.prepare(sql).get(...args) as any)?.n ?? 0);
  const recentRejections = (db.prepare(
    "SELECT ticker, reject_reason, created_at_ms FROM paper_candidates WHERE status='REJECTED' ORDER BY id DESC LIMIT 10",
  ).all() as any[]).map((r) => ({ ticker: r.ticker, reason: r.reject_reason ?? "rejected", atMs: r.created_at_ms }));
  return {
    total: count("SELECT COUNT(*) n FROM paper_candidates"),
    created: count("SELECT COUNT(*) n FROM paper_candidates WHERE status='CREATED'"),
    rejected: count("SELECT COUNT(*) n FROM paper_candidates WHERE status='REJECTED'"),
    eligiblePending: count("SELECT COUNT(*) n FROM paper_candidates WHERE status='ELIGIBLE'"),
    last24h: {
      created: count("SELECT COUNT(*) n FROM paper_candidates WHERE status='CREATED' AND created_at_ms >= ?", dayMs),
      rejected: count("SELECT COUNT(*) n FROM paper_candidates WHERE status='REJECTED' AND created_at_ms >= ?", dayMs),
    },
    recentRejections,
  };
}
