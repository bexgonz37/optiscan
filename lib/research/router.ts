/**
 * lib/research/router.ts — the lane router (Phase 2). Impure (SQLite) with a
 * testable OnDb core.
 *
 * Responsibility: take normalized SetupCandidates (adapted from the supervisor's
 * canonical AgentResults) and, for each, persist the candidate (shadow capture)
 * plus an explicit per-lane routing decision + reason code to `lane_routes`.
 *
 * Hard guarantees:
 *   • No-op unless LANE_ROUTER_ENABLED=1 (production path byte-identical when off).
 *   • Never sends Discord and never creates a trade — it only WRITES diagnostics.
 *     (Phase 3 attaches the actual Challenge/Research paper consumers to the routes.)
 *   • Never throws into the caller — routing is diagnostics; a failure must never
 *     break a supervisor cycle or Discord delivery.
 *   • REJECTED_INVALID is recorded but routed:false to every executable lane.
 */
import { marketSession, tradingDay } from "../trading-session.ts";
import type { AgentResult } from "../agents/types.ts";
import { agentResultToSetupCandidate } from "./adapter.ts";
import { captureSetupCandidateOnDb } from "./capture.ts";
import { researchFlags } from "./flags.ts";
import { evaluateExecutableLanes } from "./lane-policy.ts";
import type { MarketSessionName, SetupCandidate } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveDb = () => require("@/lib/db").getDb();

interface RouterDb {
  prepare(sql: string): { run: (...a: any[]) => { changes: number } };
}

export interface RouterSummary {
  evaluated: number;
  captured: number;
  routesWritten: number;
  routedByLane: Record<string, number>;
  skippedReason: string | null;
}

function emptySummary(skippedReason: string | null): RouterSummary {
  return { evaluated: 0, captured: 0, routesWritten: 0, routedByLane: {}, skippedReason };
}

/**
 * Persist candidates + their per-lane routing decisions on an explicit DB. Pure of
 * flags/clock beyond the passed nowMs; used directly by tests. Idempotent: capture
 * uses INSERT OR IGNORE on setup_id; routes use INSERT OR IGNORE on (setup_id,lane).
 */
export function routeCandidatesOnDb(db: RouterDb, candidates: SetupCandidate[], nowMs: number = Date.now()): RouterSummary {
  const summary = emptySummary(null);
  const insertRoute = db.prepare(
    `INSERT OR IGNORE INTO lane_routes (setup_id, lane, routed, reason_code, reason, setup_tier, created_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (const c of candidates) {
    summary.evaluated += 1;
    if (captureSetupCandidateOnDb(db as any, c, nowMs)) summary.captured += 1;
    for (const d of evaluateExecutableLanes(c)) {
      const info = insertRoute.run(c.setupId, d.lane, d.routed ? 1 : 0, d.reasonCode, d.reason, c.setupTier, nowMs);
      if (info.changes > 0) {
        summary.routesWritten += 1;
        if (d.routed) summary.routedByLane[d.lane] = (summary.routedByLane[d.lane] ?? 0) + 1;
      }
    }
  }
  return summary;
}

/**
 * Live entry point used by the supervisor cycle. Adapts canonical AgentResults to
 * SetupCandidates and routes them. HARD no-op unless LANE_ROUTER_ENABLED=1; never
 * throws into the caller.
 */
export function routeAgentResults(results: AgentResult[], nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): RouterSummary {
  if (!researchFlags(env).laneRouter) return emptySummary("LANE_ROUTER_ENABLED!=1");
  const day = tradingDay(nowMs);
  const session = marketSession(nowMs) as MarketSessionName;
  try {
    const candidates = results.map((r) => agentResultToSetupCandidate(r, { tradingDay: day, session }));
    return routeCandidatesOnDb(liveDb() as RouterDb, candidates, nowMs);
  } catch (err: any) {
    return emptySummary(`router error (isolated): ${err?.message ?? String(err)}`);
  }
}
