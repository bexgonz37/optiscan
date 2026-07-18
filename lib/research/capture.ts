/**
 * lib/research/capture.ts — persistence for normalized SetupCandidates (Phase 1).
 *
 * Impure (SQLite) but the core is a testable OnDb function. Capture is a READ-ONLY
 * SHADOW: it only WRITES to setup_candidates / setup_gate_results and never feeds
 * the production Discord/paper path. It is a hard no-op unless
 * SETUP_CANDIDATE_CAPTURE_ENABLED=1, so shipping this cannot change production.
 *
 * Idempotent: setup_id is UNIQUE, so re-capture within a trading day is ignored
 * (INSERT OR IGNORE) — cycles, restarts, and retries never create duplicate rows.
 */
import { researchFlags } from "./flags.ts";
import type { SetupCandidate } from "./types.ts";

// Lazy server-only DB (literal specifier so the webpack alias resolves; keeps the
// OnDb core importable under `node --test` without booting the app).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveDb = () => require("@/lib/db").getDb();

interface CaptureDb {
  prepare(sql: string): { run: (...a: any[]) => { changes: number } };
}

export interface CaptureResult {
  captured: number;
  duplicates: number;
  skippedReason: string | null;
}

const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** Persist one candidate + its gate rows on an explicit DB. Returns true if inserted. */
export function captureSetupCandidateOnDb(db: CaptureDb, c: SetupCandidate, nowMs: number = Date.now()): boolean {
  const info = db.prepare(
    `INSERT OR IGNORE INTO setup_candidates
      (setup_id, trading_day, strategy_agent, strategy_family, strategy_version, agent_version,
       ticker, direction, asset_class, option_symbol, expiration, strike, side, horizon, session,
       setup_tier, confidence, candidate_status, actionability, freshness_state, liquidity, spread_pct,
       volume, open_interest, option_bid, option_ask, option_mid, greeks_json, entry_thesis, invalidation_thesis, gate_results_json,
       rejection_reasons_json, feature_snapshot_json, market_regime_json, consumer_lanes_json,
       experiment_id, model_version, outcome_json, originating_ts_ms, created_at_ms)
     VALUES (?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?)`,
  ).run(
    c.setupId, tradingDayOf(c), c.strategyAgent, c.strategyFamily ?? null, c.strategyVersion ?? null, c.agentVersion ?? null,
    c.ticker, c.direction, c.assetClass, c.optionSymbol, c.expiration, c.strike, c.side, c.horizon, c.session,
    c.setupTier, c.confidence, c.candidateStatus, c.actionability, c.freshnessState, c.liquidity, c.spreadPct,
    c.volume, c.openInterest, c.optionBid, c.optionAsk, c.optionMid, j(c.greeks), c.entryThesis, c.invalidationThesis, j(c.gateResults),
    j(c.rejectionReasons), j(c.featureSnapshot), j(c.marketRegimeContext), j(c.consumerLanes),
    c.experimentId, c.modelVersion, j(c.outcome), c.originatingTsMs, nowMs,
  );
  const inserted = info.changes > 0;
  if (inserted) {
    for (const [name, g] of Object.entries(c.gateResults)) {
      db.prepare(
        `INSERT INTO setup_gate_results (setup_id, gate_name, passed, score, reason, created_at_ms)
         VALUES (?,?,?,?,?,?)`,
      ).run(c.setupId, name, g.passed ? 1 : 0, g.score ?? null, g.reason ?? null, nowMs);
    }
  }
  return inserted;
}

/** setup_id encodes the trading day as its last segment (agent|ticker|contract|day). */
function tradingDayOf(c: SetupCandidate): string {
  const parts = c.setupId.split("|");
  return parts[parts.length - 1] ?? "";
}

/**
 * Live capture: a hard no-op unless the flag is on. Never throws into the caller
 * (capture is diagnostics — it must never break a supervisor cycle).
 */
export function captureSetupCandidates(candidates: SetupCandidate[], nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): CaptureResult {
  if (!researchFlags(env).setupCandidateCapture) {
    return { captured: 0, duplicates: 0, skippedReason: "SETUP_CANDIDATE_CAPTURE_ENABLED!=1" };
  }
  let captured = 0;
  let duplicates = 0;
  try {
    const db = liveDb() as CaptureDb;
    for (const c of candidates) {
      if (captureSetupCandidateOnDb(db, c, nowMs)) captured += 1;
      else duplicates += 1;
    }
  } catch (err: any) {
    return { captured, duplicates, skippedReason: `capture error (isolated): ${err?.message ?? String(err)}` };
  }
  return { captured, duplicates, skippedReason: null };
}
