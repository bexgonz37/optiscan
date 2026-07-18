/**
 * lib/research/research-consumer.ts — the INDEPENDENT Challenge + Research paper
 * consumers (Phase 3). Impure (SQLite) with a testable OnDb core.
 *
 * These consume PERSISTED lane-routing decisions directly — they do NOT require or
 * mirror a Primary trade. Each fills into its OWN portfolio (CHALLENGE / RESEARCH)
 * via the engine's self-contained single-trade path, which applies that portfolio's
 * OWN balance, sizing, risk, per-ticker cooldown, and the existing fill/exit/grade
 * sweep. Full lane/strategy/tier/setup attribution is frozen on every trade.
 *
 * Hard guarantees:
 *   • No-op unless the lane's flag is on (RESEARCH_LANE_ENABLED /
 *     CHALLENGE_INDEPENDENT_ENABLED). Production path byte-identical when off.
 *   • REJECTED_INVALID is never filled (excluded in SQL + re-asserted per row).
 *   • A candidate with no defensible captured quote is never filled (no fabrication).
 *   • Agents never reach here — the consumer acts ONLY on persisted routes.
 *   • Never throws into the caller.
 */
import { researchFlags } from "./flags.ts";
import { lanePortfolioSpec } from "./lane-portfolio.ts";
import type { Lane } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveDb = () => require("@/lib/db").getDb();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveCreateTrade: ConsumerCreateTradeFn = (input) => require("@/lib/paper-engine").createLanePaperTrade(input);

export interface ConsumerCreateTradeInput {
  ticker: string;
  optionSymbol: string;
  optionType: "call" | "put";
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  entryLimit: number;
  thesis: string;
  portfolio: string;
  setupId: string;
  strategyAgent: string | null;
  setupTier: string;
  lane: string;
}
export type ConsumerCreateTradeFn = (input: ConsumerCreateTradeInput) => { ok: boolean; id?: number; risk?: { failures: string[] } };

interface ConsumerDb {
  prepare(sql: string): { all: (...a: any[]) => any[]; get: (...a: any[]) => any };
}

export interface ConsumerSummary {
  evaluated: number;
  created: number;
  rejected: number;
  duplicates: number;
  skippedNoQuote: number;
  createdByLane: Record<string, number>;
  skippedReason: string | null;
}

function emptySummary(skippedReason: string | null): ConsumerSummary {
  return { evaluated: 0, created: 0, rejected: 0, duplicates: 0, skippedNoQuote: 0, createdByLane: {}, skippedReason };
}

/**
 * Consume routed candidates for the given executable lanes on an explicit DB, using
 * an injected create-trade fn (so tests never touch the real engine). Pure of flags.
 */
export function consumeRoutedCandidatesOnDb(
  db: ConsumerDb,
  createTrade: ConsumerCreateTradeFn,
  lanes: Lane[],
  nowMs: number = Date.now(),
): ConsumerSummary {
  const summary = emptySummary(null);
  if (lanes.length === 0) return summary;
  const placeholders = lanes.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT lr.lane AS lane, sc.setup_id, sc.ticker, sc.option_symbol, sc.side, sc.strike, sc.expiration, sc.dte,
            sc.option_mid, sc.option_ask, sc.strategy_agent, sc.setup_tier, sc.direction, sc.entry_thesis
     FROM lane_routes lr JOIN setup_candidates sc ON sc.setup_id = lr.setup_id
     WHERE lr.routed = 1 AND lr.lane IN (${placeholders}) AND sc.setup_tier != 'REJECTED_INVALID'
     ORDER BY lr.id ASC`,
  ).all(...lanes) as any[];

  for (const r of rows) {
    const spec = lanePortfolioSpec(r.lane as Lane);
    if (!spec) continue;
    summary.evaluated += 1;

    // Re-assert the honesty rule: never fill a rejected setup, and only fill a real
    // OPTION contract with a defensible captured quote.
    if (r.setup_tier === "REJECTED_INVALID") { summary.rejected += 1; continue; }
    if (!r.option_symbol) { summary.skippedNoQuote += 1; continue; } // stock research → Phase 4
    const entryLimit = firstPositive(r.option_mid, r.option_ask);
    if (entryLimit == null) { summary.skippedNoQuote += 1; continue; }

    // Dedup: one trade per (setup, portfolio) — restart/retry safe.
    const dup = db.prepare("SELECT 1 FROM paper_trades WHERE setup_id=? AND COALESCE(portfolio,'PRIMARY')=? LIMIT 1").get(r.setup_id, spec.portfolio);
    if (dup) { summary.duplicates += 1; continue; }

    const res = createTrade({
      ticker: r.ticker,
      optionSymbol: r.option_symbol,
      optionType: (r.side as "call" | "put" | null) ?? (r.direction === "bearish" ? "put" : "call"),
      strike: r.strike ?? null,
      expiration: r.expiration ?? null,
      dte: r.dte ?? null,
      entryLimit,
      thesis: `${r.lane} ${r.setup_tier} [${r.strategy_agent}]: ${(r.entry_thesis ?? "routed research candidate").slice(0, 180)}`,
      portfolio: spec.portfolio,
      setupId: r.setup_id,
      strategyAgent: r.strategy_agent ?? null,
      setupTier: r.setup_tier,
      lane: r.lane,
    });
    if (res.ok) {
      summary.created += 1;
      summary.createdByLane[r.lane] = (summary.createdByLane[r.lane] ?? 0) + 1;
    } else {
      summary.rejected += 1;
    }
  }
  return summary;
}

function firstPositive(...vals: Array<number | null | undefined>): number | null {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return null;
}

/** Enabled executable lanes given the flags. Primary is NOT consumed here (it keeps
 *  the existing supervisor→paper bridge). */
export function enabledConsumerLanes(env: NodeJS.ProcessEnv = process.env): Lane[] {
  const f = researchFlags(env);
  const lanes: Lane[] = [];
  if (f.challengeIndependent) lanes.push("CHALLENGE_PAPER");
  if (f.researchLane) lanes.push("RESEARCH");
  return lanes;
}

/**
 * Live entry point used by the supervisor cycle. HARD no-op unless at least one lane
 * flag is on; never throws into the caller.
 */
export function consumeRoutedCandidates(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): ConsumerSummary {
  const lanes = enabledConsumerLanes(env);
  if (lanes.length === 0) return emptySummary("no lane flag enabled (RESEARCH_LANE_ENABLED / CHALLENGE_INDEPENDENT_ENABLED)");
  try {
    return consumeRoutedCandidatesOnDb(liveDb() as ConsumerDb, liveCreateTrade, lanes, nowMs);
  } catch (err: any) {
    return emptySummary(`consumer error (isolated): ${err?.message ?? String(err)}`);
  }
}
