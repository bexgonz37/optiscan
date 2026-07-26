import test from "node:test";

import assert from "node:assert/strict";

import Database from "better-sqlite3";

import { isSameTradingSession, evaluateMarketSessionGuard } from "../lib/market-session-guard.ts";

import { tradingDay } from "../lib/trading-session.ts";

import { decideDeliveryBatch } from "../lib/research/options/delivery-decision.ts";

import { evaluateShadowDecision, persistShadowDecision, recordSupervisorShadowObservation } from "../lib/research/options/shadow-runner.ts";

import { evaluateEntryQuality, evaluate0DteSessionCutoff } from "../lib/entry-quality-gate.ts";

import { validateSubscriberConfigWithSchema, shouldBlockIndependentDelivery } from "../lib/subscriber-config-validator.ts";

import { inspectSchemaReadiness } from "../lib/db-schema-readiness.ts";

import { upsertShadowOutcomeFromDecision } from "../lib/research/options/shadow-outcomes.ts";

import { deliverOptionsCallout } from "../lib/research/options/delivery.ts";



const FRIDAY = Date.parse("2026-07-24T15:00:00-04:00");

const MONDAY = Date.parse("2026-07-27T15:00:00-04:00");



test("isSameTradingSession rejects Friday candidate on Monday", () => {

  assert.equal(isSameTradingSession("2026-07-24", MONDAY), false);

  assert.equal(isSameTradingSession("2026-07-27", MONDAY), true);

});



test("decideDeliveryBatch rejects EXPIRED_TRADING_SESSION", async () => {

  const d = new Database(":memory:");

  d.exec(`CREATE TABLE options_delivery_decisions (

    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, symbol TEXT, strategy TEXT, side TEXT, tier INTEGER,

    outcome TEXT, reason TEXT, quality REAL, rank INTEGER, batch_size INTEGER, components_json TEXT,

    cluster_key TEXT, threshold REAL, session_state TEXT, alert_id TEXT, would_deliver_solo INTEGER,

    competing_json TEXT, delivery_attempted INTEGER DEFAULT 0, delivery_sent INTEGER DEFAULT 0,

    delivery_state TEXT, final_delivery_outcome TEXT DEFAULT 'SKIPPED', delivery_failure_category TEXT,

    final_delivery_reason TEXT, delivery_attempted_at_ms INTEGER, delivery_completed_at_ms INTEGER,

    entry_quality_verdict TEXT, delivery_latency_ms INTEGER, batch_entered_at_ms INTEGER, created_at_ms INTEGER

  )`);

  const deliveryInput = {

    candidateSymbol: "NVDA",

    strategy: "sr_reclaim",

    researchOnly: false,

    contract: { optionSymbol: "O:NVDA", side: "call", strike: 100, expiration: "2026-07-24", bid: 1, ask: 1.1, spreadPct: 4, quoteAgeMs: 500, dte: 0 },

    message: "test",

    observedUnderlyingPrice: 100,

    currentUnderlyingPrice: 100,

    chaseLimitPct: 5,

    underlyingPrice: 100,

    tradingSessionDate: "2026-07-24",

    decisionMs: MONDAY,

  };

  const out = await decideDeliveryBatch([{

    deliveryInput,

    symbol: "NVDA",

    side: "call",

    strategy: "sr_reclaim",

    researchOnly: false,

    tier: 1,

    matchedSignals: 3,

    requiredSignals: 4,

    strategyScore: 0.8,

    spreadPct: 4,

    openInterest: 5000,

    volume: 1000,

    fractionMove: 0.2,

    levelProximityPct: 0.3,

    nowMs: MONDAY,

  }], { getDb: () => d, now: () => MONDAY }, { OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1", MARKET_SESSION_GUARD: "shadow" });

  assert.equal(out[0].reason, "EXPIRED_TRADING_SESSION");

});



test("shadow would_send matches enforce parity on weekend", () => {

  const sat = Date.parse("2026-07-25T15:00:00-04:00");

  const input = {

    path: "proposed",

    symbol: "SPY",

    strategy: "sr_reclaim",

    side: "call",

    deliveryInput: {

      candidateSymbol: "SPY",

      strategy: "sr_reclaim",

      researchOnly: false,

      contract: { optionSymbol: "O:SPY", side: "call", strike: 500, expiration: "2026-07-25", bid: 1, ask: 1.1, spreadPct: 4, quoteAgeMs: 500, dte: 0 },

      message: "x",

      observedUnderlyingPrice: 500,

      currentUnderlyingPrice: 500,

      chaseLimitPct: 5,

      underlyingPrice: 500,

      tradingSessionDate: tradingDay(sat),

    },

    nowMs: sat,

  };

  const shadow = evaluateShadowDecision(input, { MARKET_SESSION_GUARD: "shadow", ENTRY_QUALITY_GATE: "shadow", OPTIONS_CALLOUTS_KILL: "1" });

  const enforce = evaluateShadowDecision(input, { MARKET_SESSION_GUARD: "enforce", ENTRY_QUALITY_GATE: "enforce", OPTIONS_CALLOUTS_KILL: "1" });

  assert.equal(shadow.wouldSend, false);

  assert.equal(enforce.wouldSend, false);

  assert.equal(shadow.actualAction, "OBSERVE_ONLY");

});



test("0DTE dual cutoff blocks when minutes-to-close is tight even before wall clock", () => {

  const closeMs = Date.parse("2026-07-24T16:00:00-04:00");

  const at120m = closeMs - 119 * 60_000;

  const r = evaluate0DteSessionCutoff({

    side: "call",

    dte: 0,

    nowMs: at120m,

    underlyingNow: 100,

    optionNow: 2,

    minutesToSessionClose: 119,

  }, { OPTIONS_0DTE_MIN_MINUTES_TO_CLOSE: "120", OPTIONS_0DTE_LATEST_ENTRY_ET: "15:00" });

  assert.equal(r.blocked, true);

});



test("entry quality returns six dimensions and composite", () => {

  const r = evaluateEntryQuality({

    side: "call",

    dte: 1,

    nowMs: MONDAY,

    underlyingNow: 100,

    optionNow: 2,

    quoteAgeMs: 500,

    spreadPct: 4,

    higherHighs: true,

    higherLows: true,

    aboveVwap: true,

  }, { ENTRY_QUALITY_GATE: "enforce" });

  assert.ok(r.dimensions.setupQuality);

  assert.ok(r.dimensions.entryEarliness);

  assert.ok(r.dimensions.contractQuality);

  assert.ok(r.dimensions.remainingOpportunity);

  assert.ok(r.dimensions.sessionRisk);

  assert.ok(r.dimensions.marketAlignment);

  assert.ok(r.composite.primaryVerdict);

});



test("strict schema missing columns blocks independent monitor start", () => {

  const d = new Database(":memory:");

  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY, symbol TEXT);
    CREATE TABLE options_shadow_decisions (id INTEGER PRIMARY KEY);
    CREATE TABLE options_shadow_outcomes (id INTEGER PRIMARY KEY)`);

  const result = validateSubscriberConfigWithSchema(d, {

    SUBSCRIBER_CONFIG_STRICT: "1",

    SUBSCRIBER_OPTIONS_DISCORD_OWNER: "independent",

    INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",

    EARLY_OPTIONS_CALLOUTS_ENABLED: "1",

    OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",

    AGENT_CALLOUT_DISCORD: "0",

  });

  assert.equal(result.ok, false);

  assert.ok(shouldBlockIndependentDelivery(result, { SUBSCRIBER_CONFIG_STRICT: "1", SUBSCRIBER_OPTIONS_DISCORD_OWNER: "independent" }));

});



test("supervisor shadow observation persists without sending", () => {

  const d = new Database(":memory:");

  d.exec(`CREATE TABLE options_shadow_decisions (

    id INTEGER PRIMARY KEY AUTOINCREMENT,

    trading_session_date TEXT NOT NULL,

    symbol TEXT NOT NULL,

    strategy TEXT,

    side TEXT,

    path TEXT NOT NULL,

    would_send INTEGER NOT NULL DEFAULT 0,

    entry_quality_verdict TEXT,

    session_guard_state TEXT,

    reasons_json TEXT,

    metrics_json TEXT,

    underlying_returns_json TEXT,

    option_returns_json TEXT,

    alert_fingerprint TEXT,

    created_at_ms INTEGER NOT NULL,

    actual_action TEXT,

    would_allow_session INTEGER,

    block_reasons_json TEXT,

    entry_quality_dimensions_json TEXT,

    candidate_id INTEGER,

    actually_delivered INTEGER NOT NULL DEFAULT 0

  )`);

  recordSupervisorShadowObservation(d, {

    symbol: "NVDA",

    strategy: "0DTE",

    side: "call",

    supervisorWouldSend: true,

    nowMs: MONDAY,

  }, { SUBSCRIBER_SHADOW_MODE: "1", OPTIONS_CALLOUTS_KILL: "1", SUBSCRIBER_OPTIONS_DISCORD_OWNER: "independent" });

  const row = d.prepare("SELECT path, would_send, actual_action FROM options_shadow_decisions").get();

  assert.equal(row.path, "supervisor");

  assert.equal(row.actual_action, "OBSERVE_ONLY");

});



test("shadow outcomes table stays isolated from delivered alerts", () => {

  const d = new Database(":memory:");

  d.exec(`CREATE TABLE options_shadow_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, trading_session_date TEXT, symbol TEXT, strategy TEXT, side TEXT, path TEXT, would_send INTEGER, entry_quality_verdict TEXT, session_guard_state TEXT, reasons_json TEXT, metrics_json TEXT, alert_fingerprint TEXT, created_at_ms INTEGER, actual_action TEXT, would_allow_session INTEGER, block_reasons_json TEXT, entry_quality_dimensions_json TEXT, candidate_id INTEGER, actually_delivered INTEGER DEFAULT 0);

    CREATE TABLE options_shadow_outcomes (

      id INTEGER PRIMARY KEY AUTOINCREMENT, shadow_decision_id INTEGER, candidate_symbol TEXT, strategy TEXT, side TEXT,

      trading_session_date TEXT, path TEXT, would_send INTEGER, option_symbol TEXT, frozen_entry REAL, frozen_t1 REAL,

      frozen_t2 REAL, frozen_stop REAL, underlying_at_decision REAL, option_at_decision REAL,
      bid_at_decision REAL, ask_at_decision REAL, spread_pct_at_decision REAL, dte_at_decision INTEGER,
      strike_at_decision REAL, expiration_at_decision TEXT, quality_score REAL, block_reasons_json TEXT,
      entry_quality_verdict TEXT,

      entry_quality_dimensions_json TEXT, session_guard_state TEXT, decision_at_ms INTEGER, data_status TEXT,

      created_at_ms INTEGER, updated_at_ms INTEGER

    )`);

  const input = {

    path: "proposed",

    symbol: "NVDA",

    strategy: "sr_reclaim",

    side: "call",

    deliveryInput: {

      candidateSymbol: "NVDA",

      strategy: "sr_reclaim",

      researchOnly: false,

      contract: { optionSymbol: "O:NVDA", side: "call", strike: 100, expiration: "2026-07-27", bid: 1, ask: 1.1, spreadPct: 4, quoteAgeMs: 500 },

      message: "x",

      observedUnderlyingPrice: 100,

      currentUnderlyingPrice: 100,

      chaseLimitPct: 5,

      underlyingPrice: 100,

      entry: { mid: 1.05, t1: 110, t2: 115, stop: 95, methodology: "test" },

    },

    nowMs: MONDAY,

  };

  const result = evaluateShadowDecision(input, { SUBSCRIBER_SHADOW_MODE: "1", MARKET_SESSION_GUARD: "shadow", ENTRY_QUALITY_GATE: "shadow", OPTIONS_CALLOUTS_KILL: "1" });

  const id = persistShadowDecision(d, input, result, { SUBSCRIBER_SHADOW_MODE: "1" });

  assert.ok(id);

  const outcomes = d.prepare("SELECT COUNT(*) n FROM options_shadow_outcomes").get().n;

  assert.equal(outcomes, 1);

  const alerts = d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='options_alerts'").get().n;

  assert.equal(alerts, 0);

});



test("kill switch blocks deliverOptionsCallout", async () => {

  const out = await deliverOptionsCallout({

    candidateSymbol: "NVDA",

    strategy: "sr_reclaim",

    researchOnly: false,

    contract: { optionSymbol: "O:NVDA", side: "call", strike: 100, expiration: "2026-07-27", bid: 1, ask: 1.1, spreadPct: 4, quoteAgeMs: 500 },

    message: "x",

    observedUnderlyingPrice: 100,

    currentUnderlyingPrice: 100,

    chaseLimitPct: 5,

    underlyingPrice: 100,

    tradingSessionDate: tradingDay(MONDAY),

  }, {}, {

    INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",

    EARLY_OPTIONS_CALLOUTS_ENABLED: "1",

    OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",

    OPTIONS_CALLOUTS_KILL: "1",

    MARKET_SESSION_GUARD: "shadow",

  });

  assert.equal(out.sent, false);

  assert.match(out.reason, /kill_switch/);

});



test("inspectSchemaReadiness fails on partial instrumentation schema", () => {

  const d = new Database(":memory:");

  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY, symbol TEXT);
    CREATE TABLE options_shadow_decisions (id INTEGER PRIMARY KEY);
    CREATE TABLE options_shadow_outcomes (id INTEGER PRIMARY KEY)`);

  const r = inspectSchemaReadiness(d, {});

  assert.equal(r.ok, false);

  assert.ok(r.missingInstrumentationColumns.length > 0);

});


