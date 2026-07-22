/**
 * lib/research/overview.ts — the READ-ONLY research operations overview (Phase 8).
 *
 * PURE aggregation over PERSISTED state + current flag configuration. It NEVER
 * mutates state, runs agents, enrolls experiments, creates trades, runs replay,
 * executes AI, changes flags, or calls a provider. Every section runs in its own
 * try/catch so one failure reports `{ error }` and never crashes the whole view.
 * The final object is passed through `scrubSecrets` so no key/token/webhook/env value
 * can ever appear in the response.
 */
import { researchFlags } from "./flags.ts";
import { gateEffectivenessOnDb } from "./counterfactual.ts";
import { replayCapabilities } from "./replay-provider.ts";
import { defaultRegistry } from "./strategy-agents.ts";

interface ODb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

const on = (v: string | undefined) => v === "1";
function tableExists(db: ODb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}
function safeAll(db: ODb, sql: string, ...a: any[]): any[] {
  try { return db.prepare(sql).all(...a); } catch { return []; }
}
function section<T>(fn: () => T): T | { error: string } {
  try { return fn(); } catch (err: any) { return { error: String(err?.message ?? err).slice(0, 200) }; }
}

// ── A. Capability status (never "active" just because tables/code exist) ─────
export function capabilityStatus(env: NodeJS.ProcessEnv = process.env) {
  const f = researchFlags(env);
  const cap = (name: string, flag: string | null, enabled: boolean, o: { wired: boolean; canDiscord: boolean; canTrade: boolean; deps: string[]; runtime?: string; reason?: string }) => ({
    capability: name, featureFlag: flag, flagEnabled: enabled,
    runtimeState: o.runtime ?? (enabled ? "ACTIVE" : "INACTIVE_DISABLED"),
    reason: o.reason ?? (enabled ? "flag enabled" : `${flag ?? "flag"} is not set to 1`),
    requiredDependencies: o.deps, wiredIntoLiveCycle: o.wired, canAffectDiscord: o.canDiscord, canCreatePaperTrades: o.canTrade,
  });
  return [
    cap("SetupCandidate capture", "SETUP_CANDIDATE_CAPTURE_ENABLED", f.setupCandidateCapture, { wired: true, canDiscord: false, canTrade: false, deps: ["lane router path"] }),
    cap("Lane router", "LANE_ROUTER_ENABLED", f.laneRouter, { wired: true, canDiscord: false, canTrade: false, deps: ["setup_candidates", "lane_routes"] }),
    cap("Independent Challenge", "CHALLENGE_INDEPENDENT_ENABLED", f.challengeIndependent, { wired: true, canDiscord: false, canTrade: true, deps: ["lane_routes", "paper_trades"] }),
    cap("Independent Research", "RESEARCH_LANE_ENABLED", f.researchLane, { wired: true, canDiscord: false, canTrade: true, deps: ["lane_routes", "paper_trades"] }),
    cap("Strategy Agents V2", "STRATEGY_AGENTS_V2_ENABLED", f.strategyAgentsV2, { wired: false, canDiscord: false, canTrade: false, deps: ["agent registry"] }),
    cap("Experiment Ledger", "RESEARCH_LANE_ENABLED", f.researchLane, { wired: false, canDiscord: false, canTrade: true, deps: ["research_experiments", "research_enrollments"] }),
    cap("Counterfactual Analytics", null, true, { wired: false, canDiscord: false, canTrade: false, deps: ["counterfactual_outcomes", "setup_gate_results"], runtime: "ACTIVE_READ_ONLY", reason: "read-only analytics over persisted evidence" }),
    cap("AI Research Pipeline", "AI_RESEARCH_PIPELINE_ENABLED", f.aiResearchPipeline, { wired: false, canDiscord: false, canTrade: false, deps: ["ledger", "counterfactuals", "outcomes"] }),
    cap("Historical Stock Replay", "HISTORICAL_REPLAY_ENABLED", f.historicalReplay, { wired: false, canDiscord: false, canTrade: false, deps: ["/v2/aggs OHLCV"] }),
    cap("Historical Options Replay", "OPTIONS_REPLAY_ENABLED", on(env.OPTIONS_REPLAY_ENABLED), { wired: true, canDiscord: false, canTrade: false, deps: ["/v2/aggs OHLCV", "production options detection logic"], runtime: on(env.OPTIONS_REPLAY_ENABLED) ? "ACTIVE_UNDERLYING_FORWARD" : "INACTIVE_DISABLED", reason: on(env.OPTIONS_REPLAY_ENABLED) ? "replay lab uses underlying-forward labels only; it does not prove option profitability" : "OPTIONS_REPLAY_ENABLED is not set to 1" }),
    cap("Production Discord", "AGENT_CALLOUT_DISCORD", on(env.AGENT_CALLOUT_DISCORD), { wired: true, canDiscord: true, canTrade: false, deps: ["callouts/eligibility.ts (authoritative)"], reason: "governed by existing production eligibility — NOT by the research router" }),
    cap("Primary Paper", "PAPER_AUTO_ENTRY", on(env.PAPER_AUTO_ENTRY), { wired: true, canDiscord: false, canTrade: true, deps: ["supervisor→paper bridge"] }),
  ];
}

// ── B. Candidate funnel ──────────────────────────────────────────────────────
function candidateFunnel(db: ODb) {
  if (!tableExists(db, "setup_candidates")) return { available: false, note: "no setup_candidates yet (capture inactive)" };
  const groupCount = (col: string) => Object.fromEntries(safeAll(db, `SELECT ${col} k, COUNT(*) n FROM setup_candidates GROUP BY ${col}`).map((r) => [r.k ?? "unknown", r.n]));
  const tiers = groupCount("setup_tier");
  return {
    total: (safeAll(db, "SELECT COUNT(*) n FROM setup_candidates")[0]?.n) ?? 0,
    byTier: {
      PRODUCTION_QUALITY: tiers.PRODUCTION_QUALITY ?? 0, EXPERIMENTAL_VALID: tiers.EXPERIMENTAL_VALID ?? 0,
      NEAR_MISS_VALID: tiers.NEAR_MISS_VALID ?? 0, REJECTED_INVALID: tiers.REJECTED_INVALID ?? 0,
    },
    byStrategyAgent: groupCount("strategy_agent"), byStrategyVersion: groupCount("strategy_version"),
    byStrategyFamily: groupCount("strategy_family"), byAssetClass: groupCount("asset_class"),
    byDirection: groupCount("direction"), byHorizon: groupCount("horizon"),
    bySession: groupCount("session"), byDataQuality: groupCount("freshness_state"),
  };
}

// ── C. Lane routing (Discord is NOT a router lane) ───────────────────────────
function laneRouting(db: ODb) {
  if (!tableExists(db, "lane_routes")) return { available: false, note: "no lane_routes yet (router inactive)" };
  const lanes = ["PRIMARY_PAPER", "CHALLENGE_PAPER", "RESEARCH"];
  const out: Record<string, unknown> = {};
  for (const lane of lanes) {
    out[lane] = {
      considered: safeAll(db, "SELECT COUNT(*) n FROM lane_routes WHERE lane=?", lane)[0]?.n ?? 0,
      routed: safeAll(db, "SELECT COUNT(*) n FROM lane_routes WHERE lane=? AND routed=1", lane)[0]?.n ?? 0,
      notRouted: safeAll(db, "SELECT COUNT(*) n FROM lane_routes WHERE lane=? AND routed=0", lane)[0]?.n ?? 0,
      byReasonCode: Object.fromEntries(safeAll(db, "SELECT reason_code k, COUNT(*) n FROM lane_routes WHERE lane=? GROUP BY reason_code", lane).map((r) => [r.k, r.n])),
      byTier: Object.fromEntries(safeAll(db, "SELECT setup_tier k, COUNT(*) n FROM lane_routes WHERE lane=? GROUP BY setup_tier", lane).map((r) => [r.k, r.n])),
      latestRouteMs: safeAll(db, "SELECT MAX(created_at_ms) m FROM lane_routes WHERE lane=?", lane)[0]?.m ?? null,
    };
  }
  return { lanes: out, PRODUCTION_DISCORD: { note: "Production Discord is governed by callouts/eligibility.ts (authoritative), never by the research router" } };
}

// ── D. Paper portfolios (independent, not mirrors) ───────────────────────────
function portfolios(db: ODb, env: NodeJS.ProcessEnv) {
  if (!tableExists(db, "paper_trades")) return { available: false };
  const startBal: Record<string, number> = {
    PRIMARY: Number(env.PAPER_STARTING_BALANCE_USD ?? 5000),
    CHALLENGE: Number(env.PAPER_CHALLENGE_STARTING_BALANCE_USD ?? 10000),
    RESEARCH: Number(env.PAPER_RESEARCH_STARTING_BALANCE_USD ?? 10000),
  };
  const hasPortfolio = db.prepare("SELECT 1 FROM pragma_table_info('paper_trades') WHERE name='portfolio'").get();
  const pcol = hasPortfolio ? "COALESCE(portfolio,'PRIMARY')" : "'PRIMARY'";
  const out: Record<string, unknown> = {};
  for (const p of ["PRIMARY", "CHALLENGE", "RESEARCH"]) {
    const closed = safeAll(db, `SELECT entry_price, exit_price, option_symbol, option_type, contracts FROM paper_trades WHERE ${pcol}=? AND status='EXITED' AND entry_price IS NOT NULL AND exit_price IS NOT NULL`, p);
    let wins = 0, losses = 0, pnl = 0;
    for (const t of closed) {
      const mult = t.option_symbol ? 100 : 1; const dir = !t.option_symbol && t.option_type === "put" ? -1 : 1;
      const d = (t.exit_price - t.entry_price) * dir * mult * (t.contracts ?? 1);
      pnl += d; if (d > 0) wins++; else losses++;
    }
    out[p] = {
      independent: p !== "PRIMARY" ? "independent consumer — NOT a Primary mirror" : "conservative benchmark",
      startingBalance: startBal[p], realizedPnl: +pnl.toFixed(2), equity: +(startBal[p] + pnl).toFixed(2),
      openPositions: safeAll(db, `SELECT COUNT(*) n FROM paper_trades WHERE ${pcol}=? AND status IN ('WATCHING','READY','ENTERED')`, p)[0]?.n ?? 0,
      closedTrades: closed.length, wins, losses, winRatePct: closed.length ? +((wins / closed.length) * 100).toFixed(1) : null,
      cooldownScope: p === "PRIMARY" ? "account-wide (stricter)" : "per-ticker (isolated)",
      byStrategy: Object.fromEntries(safeAll(db, `SELECT strategy_agent k, COUNT(*) n FROM paper_trades WHERE ${pcol}=? GROUP BY strategy_agent`, p).map((r) => [r.k ?? "n/a", r.n])),
      latestActivityMs: safeAll(db, `SELECT MAX(created_at_ms) m FROM paper_trades WHERE ${pcol}=?`, p)[0]?.m ?? null,
    };
  }
  return { note: "Challenge and Research are independent portfolios, not mirrors of Primary", portfolios: out };
}

// ── E. Experiments ───────────────────────────────────────────────────────────
function experiments(db: ODb) {
  if (!tableExists(db, "research_experiments")) return { available: false };
  const enroll = tableExists(db, "research_enrollments");
  return {
    byStatus: Object.fromEntries(safeAll(db, "SELECT status k, COUNT(*) n FROM research_experiments GROUP BY status").map((r) => [r.k, r.n])),
    enrollments: enroll ? {
      total: safeAll(db, "SELECT COUNT(*) n FROM research_enrollments")[0]?.n ?? 0,
      filled: safeAll(db, "SELECT COUNT(*) n FROM research_enrollments WHERE fill_status='FILLED'")[0]?.n ?? 0,
      observedUnfilled: safeAll(db, "SELECT COUNT(*) n FROM research_enrollments WHERE fill_status='OBSERVED_UNFILLED'")[0]?.n ?? 0,
      rejectedNotFillable: safeAll(db, "SELECT COUNT(*) n FROM research_enrollments WHERE fill_status='NOT_FILLABLE_REJECTED'")[0]?.n ?? 0,
    } : { available: false },
  };
}

// ── F. Counterfactuals (executable vs observation kept separate) ─────────────
function counterfactuals(db: ODb) {
  if (!tableExists(db, "counterfactual_outcomes")) return { available: false };
  const cnt = (sql: string, ...a: any[]) => safeAll(db, sql, ...a)[0]?.n ?? 0;
  return {
    executableCounterfactual: {
      total: cnt("SELECT COUNT(*) n FROM counterfactual_outcomes WHERE kind='executable_counterfactual'"),
      wins: cnt("SELECT COUNT(*) n FROM counterfactual_outcomes WHERE kind='executable_counterfactual' AND win=1"),
      losses: cnt("SELECT COUNT(*) n FROM counterfactual_outcomes WHERE kind='executable_counterfactual' AND win=0"),
    },
    marketMovementObservation: {
      total: cnt("SELECT COUNT(*) n FROM counterfactual_outcomes WHERE kind='market_movement_observation'"),
      reachedTarget: cnt("SELECT COUNT(*) n FROM counterfactual_outcomes WHERE kind='market_movement_observation' AND reached_target=1"),
      note: "observations are NOT trade P&L and are never counted as executed wins/losses",
    },
    latestGradingMs: safeAll(db, "SELECT MAX(created_at_ms) m FROM counterfactual_outcomes")[0]?.m ?? null,
  };
}

// ── H. Strategy-agent diagnostics ────────────────────────────────────────────
function agentDiagnostics(db: ODb, env: NodeJS.ProcessEnv) {
  const rep = defaultRegistry().capabilityReport(env);
  const emitted = tableExists(db, "setup_candidates")
    ? Object.fromEntries(safeAll(db, "SELECT strategy_agent k, COUNT(*) n FROM setup_candidates GROUP BY strategy_agent").map((r) => [r.k, r.n]))
    : {};
  const agents = rep.map((a) => ({ ...a, emittedCandidates: emitted[a.id] ?? 0 }));
  return {
    activeProducers: agents.filter((a) => a.role === "producer" && a.status === "ACTIVE").length,
    activeContextReview: agents.filter((a) => (a.role === "context" || a.role === "review") && a.status === "ACTIVE").length,
    inactiveMissingData: agents.filter((a) => a.status === "INACTIVE_MISSING_DATA").length,
    agents,
  };
}

// ── I. AI research ───────────────────────────────────────────────────────────
function aiResearch(db: ODb, env: NodeJS.ProcessEnv) {
  const f = researchFlags(env);
  const runs = tableExists(db, "ai_research_runs") ? safeAll(db, "SELECT COUNT(*) n FROM ai_research_runs")[0]?.n ?? 0 : 0;
  const findings = tableExists(db, "ai_research_findings")
    ? Object.fromEntries(safeAll(db, "SELECT finding_type k, COUNT(*) n FROM ai_research_findings GROUP BY finding_type").map((r) => [r.k, r.n])) : {};
  const training = tableExists(db, "ai_training_rows")
    ? Object.fromEntries(safeAll(db, "SELECT source_kind k, COUNT(*) n FROM ai_training_rows GROUP BY source_kind").map((r) => [r.k, r.n])) : {};
  const proposals = tableExists(db, "research_proposals")
    ? Object.fromEntries(safeAll(db, "SELECT status k, COUNT(*) n FROM research_proposals GROUP BY status").map((r) => [r.k, r.n])) : {};
  return {
    advisoryOnly: true, humanReviewBoundary: "APPROVED proposals never auto-apply; execution is a separate explicit human step",
    pipelineFlagEnabled: f.aiResearchPipeline, pipelineRuntimeState: f.aiResearchPipeline ? "ACTIVE" : "INACTIVE_DISABLED",
    runCount: runs, findingsByType: findings, trainingRowsByKind: training, proposalsByStatus: proposals,
    note: "training-row kinds keep EXECUTED_TRADE / EXECUTABLE_COUNTERFACTUAL / MARKET_OBSERVATION / REJECTED_INVALID distinct",
  };
}

// ── J. Historical replay ─────────────────────────────────────────────────────
function replay(db: ODb, env: NodeJS.ProcessEnv) {
  const caps = replayCapabilities(env);
  const runsByAsset = (asset: string) => tableExists(db, "replay_runs")
    ? { runs: safeAll(db, "SELECT COUNT(*) n FROM replay_runs WHERE asset_class=?", asset)[0]?.n ?? 0, byStatus: Object.fromEntries(safeAll(db, "SELECT status k, COUNT(*) n FROM replay_runs WHERE asset_class=? GROUP BY status", asset).map((r) => [r.k, r.n])) }
    : { runs: 0, byStatus: {} };
  const optionReplayRuns = tableExists(db, "options_replay_runs")
    ? {
        runs: safeAll(db, "SELECT COUNT(*) n FROM options_replay_runs")[0]?.n ?? 0,
        byStatus: Object.fromEntries(safeAll(db, "SELECT status k, COUNT(*) n FROM options_replay_runs GROUP BY status").map((r) => [r.k, r.n])),
        candidates: tableExists(db, "options_replay_candidates") ? safeAll(db, "SELECT COUNT(*) n FROM options_replay_candidates")[0]?.n ?? 0 : 0,
      }
    : { runs: 0, byStatus: {}, candidates: 0 };
  const stockOutcomes = tableExists(db, "replay_outcomes") ? safeAll(db, "SELECT COUNT(*) n FROM replay_outcomes WHERE asset_class='stock'")[0]?.n ?? 0 : 0;
  const opt = caps.find((c) => c.assetClass === "option")!;
  const optionReplayEnabled = on(env.OPTIONS_REPLAY_ENABLED);
  return {
    stock: { flagEnabled: researchFlags(env).historicalReplay, capability: caps.find((c) => c.assetClass === "stock")!.status, ...runsByAsset("stock"), executableOutcomes: stockOutcomes, disclosures: ["deterministic clock", "no look-ahead (signal uses only past/current bars)", "documented slippage/fees"] },
    options: {
      status: optionReplayEnabled ? "ACTIVE_UNDERLYING_FORWARD" : "INACTIVE_DISABLED",
      flagEnabled: optionReplayEnabled,
      replayExists: true,
      gradingBasis: "UNDERLYING_FORWARD",
      provesOptionProfitability: false,
      executableOutcomes: 0,
      ...optionReplayRuns,
      blockerForExecutableOptionReplay: opt.reason,
      missingEntitlementsForExecutableOptionReplay: opt.missingFields,
      note: "options replay uses production detection over stock bars and underlying-forward labels only; it does NOT simulate premiums, spreads, greeks, fills, or option profitability",
    },
  };
}

// ── K. Session / provider diagnostics (persisted only; MARKET_CLOSED ≠ error) ─
function sessionProviderDiagnostics(db: ODb) {
  const byFreshness = tableExists(db, "setup_candidates")
    ? Object.fromEntries(safeAll(db, "SELECT freshness_state k, COUNT(*) n FROM setup_candidates GROUP BY freshness_state").map((r) => [r.k ?? "unknown", r.n])) : {};
  return {
    note: "distinct classes; MARKET_CLOSED and EXPECTED_SESSION_SUPPRESSION are NOT provider outages",
    classes: {
      MARKET_CLOSED: "expected outside RTH — not an error",
      EXPECTED_SESSION_SUPPRESSION: "expected — options evaluated only in the options session",
      DATA_STALE: "freshness gate blocked (may be expected off-hours)",
      PROVIDER_ERROR: "see /api/system/provider-health (not re-fetched here)",
      RATE_LIMITED: "see /api/system/provider-health",
      MISSING_ENTITLEMENT: "e.g. historical options — see replay.options.blocker",
      INVALID_RESPONSE: "see /api/system/provider-health",
      NO_VALID_CONTRACT: "selector found no usable contract",
    },
    persistedFreshnessState: byFreshness,
    liveProviderHealth: "not duplicated — read /api/system/provider-health (no provider call made here)",
  };
}

// ── secret scrubbing ─────────────────────────────────────────────────────────
const SECRET_KEY = /token|secret|api[_-]?key|apikey|password|passwd|webhook|credential|authorization|cookie|bearer|database_url|db_url|railway|private_key|session_id/i;

/** Recursively drop any key that looks sensitive (defense-in-depth). */
export function scrubSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue; // never emit a sensitive key
      out[k] = scrubSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Build the whole overview (each section failure-isolated) and scrub secrets. */
export function buildResearchOverviewOnDb(db: ODb, env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()) {
  const overview = {
    generatedAtMs: nowMs,
    readOnly: true,
    capabilities: section(() => capabilityStatus(env)),
    candidateFunnel: section(() => candidateFunnel(db)),
    laneRouting: section(() => laneRouting(db)),
    portfolios: section(() => portfolios(db, env)),
    experiments: section(() => experiments(db)),
    counterfactuals: section(() => counterfactuals(db)),
    gateEffectiveness: section(() => gateEffectivenessOnDb(db as any, { minSample: 20 })),
    strategyAgents: section(() => agentDiagnostics(db, env)),
    aiResearch: section(() => aiResearch(db, env)),
    replay: section(() => replay(db, env)),
    sessionProvider: section(() => sessionProviderDiagnostics(db)),
  };
  return scrubSecrets(overview);
}
