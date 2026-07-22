import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { buildResearchOverviewOnDb, scrubSecrets, capabilityStatus } from "../lib/research/overview.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE setup_candidates (setup_id TEXT, setup_tier TEXT, strategy_agent TEXT, strategy_version INTEGER, strategy_family TEXT, asset_class TEXT, direction TEXT, horizon TEXT, session TEXT, freshness_state TEXT, created_at_ms INTEGER);
    CREATE TABLE lane_routes (id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, lane TEXT, routed INTEGER, reason_code TEXT, setup_tier TEXT, created_at_ms INTEGER);
    CREATE TABLE paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, portfolio TEXT, status TEXT, entry_price REAL, exit_price REAL, option_symbol TEXT, option_type TEXT, contracts INTEGER, strategy_agent TEXT, created_at_ms INTEGER);
    CREATE TABLE research_experiments (id TEXT, version INTEGER, status TEXT);
    CREATE TABLE research_enrollments (id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, fill_status TEXT, strategy_agent TEXT, strategy_version INTEGER);
    CREATE TABLE counterfactual_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, kind TEXT, win INTEGER, reached_target INTEGER, created_at_ms INTEGER);
    CREATE TABLE setup_gate_results (id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, gate_name TEXT, passed INTEGER);
    CREATE TABLE ai_research_runs (run_id TEXT);
    CREATE TABLE ai_research_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, finding_type TEXT);
    CREATE TABLE ai_training_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, source_kind TEXT);
    CREATE TABLE research_proposals (proposal_id TEXT, status TEXT);
    CREATE TABLE replay_runs (run_id TEXT, asset_class TEXT, status TEXT);
    CREATE TABLE replay_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_class TEXT);`);
  return d;
}
function seed(d) {
  const sc = d.prepare("INSERT INTO setup_candidates (setup_id,setup_tier,strategy_agent,asset_class,direction,horizon,session,freshness_state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)");
  sc.run("s1", "PRODUCTION_QUALITY", "call_0DTE", "option", "bullish", "0DTE", "regular", "fresh", 1);
  sc.run("s2", "REJECTED_INVALID", "put_research_0DTE", "option", "bearish", "0DTE", "regular", "MARKET_CLOSED", 1);
  d.prepare("INSERT INTO lane_routes (setup_id,lane,routed,reason_code,setup_tier,created_at_ms) VALUES ('s1','RESEARCH',1,'OK','PRODUCTION_QUALITY',1)").run();
  d.prepare("INSERT INTO lane_routes (setup_id,lane,routed,reason_code,setup_tier,created_at_ms) VALUES ('s2','RESEARCH',0,'REJECTED_INVALID','REJECTED_INVALID',1)").run();
  d.prepare("INSERT INTO paper_trades (setup_id,portfolio,status,entry_price,exit_price,option_symbol,option_type,contracts,strategy_agent,created_at_ms) VALUES ('s1','RESEARCH','EXITED',2,3,'O:X','call',1,'call_0DTE',1)").run();
  d.prepare("INSERT INTO research_experiments (id,version,status) VALUES ('e1',1,'ACTIVE')").run();
  d.prepare("INSERT INTO research_enrollments (setup_id,fill_status,strategy_agent) VALUES ('s1','FILLED','call_0DTE')").run();
  d.prepare("INSERT INTO research_enrollments (setup_id,fill_status,strategy_agent) VALUES ('s2','NOT_FILLABLE_REJECTED','put_research_0DTE')").run();
  d.prepare("INSERT INTO counterfactual_outcomes (setup_id,kind,win,created_at_ms) VALUES ('cf1','executable_counterfactual',1,1)").run();
  d.prepare("INSERT INTO counterfactual_outcomes (setup_id,kind,reached_target,created_at_ms) VALUES ('ob1','market_movement_observation',1,1)").run();
  d.prepare("INSERT INTO replay_runs (run_id,asset_class,status) VALUES ('r1','stock','COMPLETED')").run();
}

test("overview returns all sections, separated", () => {
  const d = db(); seed(d);
  const o = buildResearchOverviewOnDb(d, {}, 1);
  for (const k of ["capabilities", "candidateFunnel", "laneRouting", "portfolios", "experiments", "counterfactuals", "gateEffectiveness", "strategyAgents", "aiResearch", "replay", "sessionProvider"]) {
    assert.ok(k in o, `missing section ${k}`);
  }
  assert.equal(o.readOnly, true);
});

test("capabilities: Production Discord is authoritative (not router-controlled); options replay is honest", () => {
  const caps = capabilityStatus({});
  const discord = caps.find((c) => c.capability === "Production Discord");
  assert.equal(discord.canAffectDiscord, true);
  assert.match(discord.reason, /NOT by the research router/);
  const optRep = caps.find((c) => c.capability === "Historical Options Replay");
  assert.equal(optRep.runtimeState, "INACTIVE_DISABLED");
  assert.match(optRep.reason, /OPTIONS_REPLAY_ENABLED/);
  const activeOptRep = capabilityStatus({ OPTIONS_REPLAY_ENABLED: "1" }).find((c) => c.capability === "Historical Options Replay");
  assert.equal(activeOptRep.runtimeState, "ACTIVE_UNDERLYING_FORWARD");
  assert.match(activeOptRep.reason, /does not prove option profitability/);
  // Research/Challenge can create paper trades but never Discord.
  for (const n of ["Independent Challenge", "Independent Research"]) {
    const c = caps.find((x) => x.capability === n);
    assert.equal(c.canAffectDiscord, false);
    assert.equal(c.canCreatePaperTrades, true);
  }
});

test("candidate tiers are separated with explicit counts", () => {
  const d = db(); seed(d);
  const o = buildResearchOverviewOnDb(d, {}, 1);
  assert.equal(o.candidateFunnel.byTier.PRODUCTION_QUALITY, 1);
  assert.equal(o.candidateFunnel.byTier.REJECTED_INVALID, 1);
});

test("Production Discord is NOT represented as a router lane", () => {
  const d = db(); seed(d);
  const o = buildResearchOverviewOnDb(d, {}, 1);
  assert.ok(!("PRODUCTION_DISCORD" in o.laneRouting.lanes));
  assert.match(o.laneRouting.PRODUCTION_DISCORD.note, /authoritative/);
  assert.equal(o.laneRouting.lanes.RESEARCH.routed, 1);
});

test("portfolios are independent (not mirrors); rejected never shown as a filled trade", () => {
  const d = db(); seed(d);
  const o = buildResearchOverviewOnDb(d, {}, 1);
  assert.match(o.portfolios.portfolios.CHALLENGE.independent, /NOT a Primary mirror/);
  assert.equal(o.portfolios.portfolios.RESEARCH.closedTrades, 1);
  assert.equal(o.portfolios.portfolios.PRIMARY.closedTrades, 0, "the rejected setup is not a Primary trade");
});

test("experiments show fill / non-fill / rejected counts", () => {
  const d = db(); seed(d);
  const o = buildResearchOverviewOnDb(d, {}, 1);
  assert.equal(o.experiments.enrollments.filled, 1);
  assert.equal(o.experiments.enrollments.rejectedNotFillable, 1);
});

test("counterfactual executable and observation are separate; observations carry no P&L", () => {
  const d = db(); seed(d);
  const o = buildResearchOverviewOnDb(d, {}, 1);
  assert.equal(o.counterfactuals.executableCounterfactual.total, 1);
  assert.equal(o.counterfactuals.executableCounterfactual.wins, 1);
  assert.equal(o.counterfactuals.marketMovementObservation.total, 1);
  assert.ok(!("wins" in o.counterfactuals.marketMovementObservation), "observations have no win/loss P&L");
  assert.match(o.counterfactuals.marketMovementObservation.note, /NOT trade P&L/);
});

test("agent diagnostics report inactive agents honestly (not active)", () => {
  const d = db(); seed(d);
  const o = buildResearchOverviewOnDb(d, {}, 1);
  assert.ok(o.strategyAgents.activeProducers >= 10);
  assert.ok(o.strategyAgents.inactiveMissingData >= 10);
  const news = o.strategyAgents.agents.find((a) => a.id === "news_catalyst");
  assert.equal(news.status, "INACTIVE_MISSING_DATA");
  assert.ok(news.missingRequirements.length > 0);
});

test("AI research is advisory-only with a human-review boundary; replay stock/options separate", () => {
  const d = db(); seed(d);
  const o = buildResearchOverviewOnDb(d, { OPTIONS_REPLAY_ENABLED: "1" }, 1);
  assert.equal(o.aiResearch.advisoryOnly, true);
  assert.match(o.aiResearch.humanReviewBoundary, /never auto-apply/);
  assert.equal(o.replay.options.status, "ACTIVE_UNDERLYING_FORWARD");
  assert.equal(o.replay.options.replayExists, true);
  assert.equal(o.replay.options.gradingBasis, "UNDERLYING_FORWARD");
  assert.equal(o.replay.options.provesOptionProfitability, false);
  assert.equal(o.replay.options.executableOutcomes, 0);
  assert.ok(o.replay.options.missingEntitlementsForExecutableOptionReplay.includes("historical_delta"));
  assert.match(o.replay.options.note, /does NOT simulate.*option profitability/);
});

test("session/provider: MARKET_CLOSED is distinct from PROVIDER_ERROR", () => {
  const o = buildResearchOverviewOnDb(db(), {}, 1);
  assert.ok("MARKET_CLOSED" in o.sessionProvider.classes);
  assert.ok("PROVIDER_ERROR" in o.sessionProvider.classes);
  assert.notEqual(o.sessionProvider.classes.MARKET_CLOSED, o.sessionProvider.classes.PROVIDER_ERROR);
});

// ── secret safety ────────────────────────────────────────────────────────────
test("scrubSecrets drops any sensitive key recursively", () => {
  const scrubbed = scrubSecrets({ ok: 1, token: "abc", nested: { apiKey: "x", webhook: "https://discord.com/api/webhooks/xxx", keep: 2 }, list: [{ password: "p", fine: 3 }] });
  assert.deepEqual(scrubbed, { ok: 1, nested: { keep: 2 }, list: [{ fine: 3 }] });
});

test("the full overview response contains NO secret-bearing key or webhook URL", () => {
  const d = db(); seed(d);
  const o = buildResearchOverviewOnDb(d, { POLYGON_API_KEY: "supersecret", DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/zzz" }, 1);
  const json = JSON.stringify(o);
  assert.doesNotMatch(json, /supersecret/, "no provider key value leaks");
  assert.doesNotMatch(json, /discord\.com\/api\/webhooks/, "no webhook URL leaks");
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) {
      assert.doesNotMatch(k, /token|secret|api[_-]?key|apikey|password|webhook|credential|authorization|cookie|bearer|database_url|railway|private_key/i, `sensitive key leaked: ${k}`);
      walk(val);
    }
  };
  walk(o);
});

// ── failure isolation ────────────────────────────────────────────────────────
test("one failing section reports {error} but others still succeed", () => {
  const real = db(); seed(real);
  const throwing = { prepare(sql) { if (sql.includes("setup_gate_results")) throw new Error("boom"); return real.prepare(sql); } };
  const o = buildResearchOverviewOnDb(throwing, {}, 1);
  assert.ok(o.gateEffectiveness.error, "gate-effectiveness section failed safely");
  assert.ok(Array.isArray(o.capabilities), "capabilities still succeeded");
  assert.equal(o.candidateFunnel.byTier.PRODUCTION_QUALITY, 1, "unaffected section still works");
});

// ── read-only guards (route + module) ────────────────────────────────────────
test("route uses shared auth, is read-only, and calls no provider", () => {
  const src = read("app/api/research/overview/route.ts");
  assert.match(src, /checkApiToken/, "reuses shared auth");
  assert.match(src, /unauthorized\(\)/);
  assert.doesNotMatch(src, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i, "route performs no writes");
  assert.doesNotMatch(src, /fetchOptionChain|fetchCandles|polyRequest|fetchBulkQuotes/, "route makes no provider calls");
});

test("overview module makes no provider calls and no writes", () => {
  const src = read("lib/research/overview.ts");
  assert.doesNotMatch(src, /fetchOptionChain|fetchCandles|polyRequest|polyFetch/, "no provider calls");
  assert.doesNotMatch(src, /\bINSERT INTO\b|\bUPDATE \b|\bDELETE FROM\b/i, "no writes");
});
