import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { ensureEnterpriseSchemaOnDb, inspectSchemaReadiness } from "../lib/db-schema-readiness.ts";
import {
  appendEpisodeActionOnDb,
  appendOutcomeLabelV2OnDb,
  buildSetupEpisodeV2,
  decisionConfigDigest,
  persistSetupEpisodeV2OnDb,
  resetSetupEpisodeV2HealthForTests,
  setupEpisodeV2HealthOnDb,
  setupEpisodeV2Key,
  setupEpisodeV2TimestampDiagnosticOnDb,
  validateZoneA,
} from "../lib/research/episode/v2.ts";

const T0 = Date.UTC(2026, 7, 19, 15, 0, 0);
const candidate = (over = {}) => ({
  symbol: "MRNA", nowMs: T0, session: "regular", tier: 2,
  underlying: {
    price: 143, dayDollarVolume: 2e9, relVolume: null, volumeAccel: 1.2,
    volumeSurgeProxy: 3.2, dollarVolumeAccel: 1.3, velPct: 4, accelPct: 1,
    gapPct: null, aboveVwap: true, hodBreak: false, lodBreak: false,
    nearResistancePct: 0.2, nearSupportPct: null, compressionPct: 0.7,
    realizedVolExpanding: true, openingRange: true, premarketLevelTest: false,
  },
  ...over,
});

const contract = {
  optionSymbol: "O:MRNA260821C00120000", side: "call", strike: 120,
  expiration: "2026-08-21", dte: 2, bid: 22, ask: 24, spreadPct: 8.7,
  volume: 250, openInterest: 900, iv: 1.2, delta: null, gamma: 0.01,
  theta: -0.3, vega: 0.1, providerTimestamp: T0 - 1000,
};

function result(state = "READY", researchOnly = false) {
  return {
    selection: {
      symbol: "MRNA", direction: "bullish", reason: "selected breakout_forming",
      selected: { key: "breakout_forming", label: "Breakout forming", score: 0.75, side: "call", researchOnly, preferredDte: "1-7dte" },
      considered: [{ key: "breakout_forming", label: "Breakout forming", applicable: true, score: 0.75, matched: ["volume_acceleration"], rejection: null }],
    },
    contract: state === "REJECTED" ? null : contract,
    callout: state === "REJECTED" ? { state, message: null, reason: "no eligible contract", freshness: null, entry: null } : { state, message: null, reason: "ready", freshness: "FRESH", entry: null },
    paperEntry: null,
    state,
    contractFunnel: null,
  };
}

function db() {
  const d = new Database(":memory:");
  ensureEnterpriseSchemaOnDb(d);
  d.exec(`CREATE TABLE IF NOT EXISTS options_research_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_key TEXT NOT NULL UNIQUE,
    observed_at_ms INTEGER NOT NULL,
    session_date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    strategy_family TEXT,
    candidate_state TEXT,
    option_type TEXT,
    quote_timestamp_ms INTEGER,
    source TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`);
  return d;
}

test.beforeEach(() => resetSetupEpisodeV2HealthForTests());

function insertTimestampObservation(d, {
  key, observedAtMs, quoteTimestampMs, sessionDate = "2026-08-19", symbol = "MRNA",
  side = "call", strategy = "breakout_forming", candidateState = "CONTRACT_SELECTED",
}) {
  d.prepare(`INSERT INTO options_research_observations
    (observation_key,observed_at_ms,session_date,symbol,strategy_family,candidate_state,
     option_type,quote_timestamp_ms,source,created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    key, observedAtMs, sessionDate, symbol, strategy, candidateState,
    side, quoteTimestampMs, "episode-health-test", observedAtMs,
  );
}

test("episode build health counts a valid attempt and success", () => {
  const d = db();
  buildSetupEpisodeV2({ candidate: candidate(), result: result(), candidateId: 1, env: {} });
  const health = setupEpisodeV2HealthOnDb(d);
  assert.equal(health.evidenceState, "ATTEMPTED_WITH_SUCCESS");
  assert.equal(health.runtime.buildAttempts, 1);
  assert.equal(health.runtime.buildSuccesses, 1);
  assert.equal(health.runtime.buildRejectionsTotal, 0);
});

test("future provider timestamps count as Zone-A rejections, never successes", () => {
  const d = db();
  const future = { ...contract, providerTimestamp: T0 + 1 };
  assert.throws(
    () => buildSetupEpisodeV2({ candidate: candidate(), result: { ...result(), contract: future }, candidateId: 1, env: {} }),
    /Zone-A leakage/,
  );
  const health = setupEpisodeV2HealthOnDb(d);
  assert.equal(health.evidenceState, "ATTEMPTED_WITH_REJECTIONS");
  assert.equal(health.runtime.buildAttempts, 1);
  assert.equal(health.runtime.buildSuccesses, 0);
  assert.equal(health.runtime.buildRejectionsTotal, 1);
  assert.equal(health.runtime.buildRejectionsByClass.ZONE_A_FUTURE_TIMESTAMP, 1);
  assert.equal(health.runtime.lastBuildRejectionClass, "ZONE_A_FUTURE_TIMESTAMP");
});

test("generic builder faults have a separate rejection class", () => {
  const d = db();
  assert.throws(
    () => buildSetupEpisodeV2({ candidate: candidate({ underlying: null }), result: result(), candidateId: 1, env: {} }),
    TypeError,
  );
  const runtime = setupEpisodeV2HealthOnDb(d).runtime;
  assert.equal(runtime.buildAttempts, 1);
  assert.equal(runtime.buildSuccesses, 0);
  assert.equal(runtime.buildRejectionsByClass.OTHER_BUILD_ERROR, 1);
  assert.equal(runtime.buildRejectionsByClass.ZONE_A_FUTURE_TIMESTAMP, 0);
});

test("episode persistence failure is distinct from builder rejection", () => {
  const d = db();
  const ep = buildSetupEpisodeV2({ candidate: candidate(), result: result(), candidateId: 1, env: {} });
  const failingDb = { prepare() { throw new Error("fixture persistence unavailable"); } };
  assert.equal(persistSetupEpisodeV2OnDb(failingDb, ep, T0).ok, false);
  const health = setupEpisodeV2HealthOnDb(d);
  assert.equal(health.evidenceState, "PERSISTENCE_FAILURE");
  assert.equal(health.runtime.buildSuccesses, 1);
  assert.equal(health.runtime.buildRejectionsTotal, 0);
  assert.equal(health.runtime.persistenceAttempts, 1);
  assert.equal(health.runtime.persistenceSuccesses, 0);
  assert.equal(health.runtime.persistenceFailures, 1);
});

test("action failures are classified separately from build and persistence", () => {
  const d = db();
  const failingDb = { prepare() { throw new Error("fixture action unavailable"); } };
  const common = { episodeKey: "ep2_missing", actionRef: "fixture", occurredAtMs: T0 };
  assert.equal(appendEpisodeActionOnDb(failingDb, { ...common, kind: "OBSERVATION" }, T0).ok, false);
  assert.equal(appendEpisodeActionOnDb(failingDb, {
    ...common, kind: "COUNTERFACTUAL", exactOcc: contract.optionSymbol,
    entryConvention: "BUY_AT_ASK_EXIT_AT_FUTURE_BID", defensibleEntry: true,
  }, T0).ok, false);
  assert.equal(appendEpisodeActionOnDb(failingDb, { ...common, kind: "PAPER_TRADE" }, T0).ok, false);
  assert.equal(appendEpisodeActionOnDb(failingDb, { ...common, kind: "DELIVERED_SUBSCRIBER_TRADE" }, T0).ok, false);
  const runtime = setupEpisodeV2HealthOnDb(d).runtime;
  assert.equal(runtime.buildAttempts, 0);
  assert.equal(runtime.persistenceAttempts, 0);
  assert.equal(runtime.persistenceFailures, 0);
  assert.equal(runtime.observationActionFailures, 1);
  assert.equal(runtime.counterfactualActionFailures, 1);
  assert.equal(runtime.paperActionFailures, 1);
  assert.equal(runtime.subscriberActionFailures, 1);
});

test("zero episodes distinguishes never attempted from attempted and rejected", () => {
  const d = db();
  const before = setupEpisodeV2HealthOnDb(d);
  assert.equal(before.episodeCount, 0);
  assert.equal(before.evidenceState, "NEVER_ATTEMPTED");
  assert.equal(before.status, "NO_RUNTIME_EVIDENCE");

  const future = { ...contract, providerTimestamp: T0 + 1 };
  assert.throws(() => buildSetupEpisodeV2({
    candidate: candidate(), result: { ...result(), contract: future }, candidateId: 1, env: {},
  }));
  const after = setupEpisodeV2HealthOnDb(d);
  assert.equal(after.episodeCount, 0);
  assert.equal(after.evidenceState, "ATTEMPTED_WITH_REJECTIONS");
  assert.equal(after.status, "ERROR");
});

test("historical timestamp diagnostic buckets reconcile exactly", () => {
  const d = db();
  insertTimestampObservation(d, { key: "newer-call", observedAtMs: T0, quoteTimestampMs: T0 + 1 });
  insertTimestampObservation(d, { key: "equal-put", observedAtMs: T0, quoteTimestampMs: T0, side: "put", symbol: "TSLA", strategy: "fade" });
  insertTimestampObservation(d, { key: "older-call", observedAtMs: T0 + 10, quoteTimestampMs: T0 + 9, sessionDate: "2026-08-20" });
  insertTimestampObservation(d, { key: "newer-put", observedAtMs: T0 + 10, quoteTimestampMs: T0 + 11, sessionDate: "2026-08-20", side: "put", symbol: "AAPL", strategy: "fade" });
  insertTimestampObservation(d, { key: "excluded-state", observedAtMs: T0, quoteTimestampMs: T0 + 1, candidateState: "READY" });
  insertTimestampObservation(d, { key: "excluded-null", observedAtMs: T0, quoteTimestampMs: null });

  const diagnostic = setupEpisodeV2TimestampDiagnosticOnDb(d);
  assert.equal(diagnostic.status, "OK");
  assert.equal(diagnostic.totalRows, 4);
  assert.equal(diagnostic.quoteNewerThanObserved, 2);
  assert.equal(diagnostic.quoteEqualToObserved, 1);
  assert.equal(diagnostic.quoteOlderThanObserved, 1);
  assert.equal(diagnostic.newerThanObservationPct, 50);
  assert.equal(diagnostic.reconciles, true);
  for (const rows of Object.values(diagnostic.breakdowns)) {
    for (const row of rows) {
      assert.equal(row.totalRows, row.quoteNewerThanObserved + row.quoteEqualToObserved + row.quoteOlderThanObserved);
    }
  }
  assert.deepEqual(diagnostic.breakdowns.bySide.map((x) => [x.key, x.totalRows]), [["CALL", 2], ["PUT", 2]]);
  assert.deepEqual(diagnostic.breakdowns.bySessionDate.map((x) => [x.key, x.totalRows]), [["2026-08-20", 2], ["2026-08-19", 2]]);
});

test("historical timestamp diagnostic is read-only and makes zero provider calls", () => {
  const d = db();
  insertTimestampObservation(d, { key: "one", observedAtMs: T0, quoteTimestampMs: T0 + 1 });
  const changesBefore = d.prepare("SELECT total_changes() AS n").get().n;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (...args) => {
    providerCalls += 1;
    return originalFetch(...args);
  };
  try {
    const diagnostic = setupEpisodeV2TimestampDiagnosticOnDb(d);
    assert.equal(diagnostic.readOnly, true);
    assert.equal(diagnostic.providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(providerCalls, 0);
  assert.equal(d.prepare("SELECT total_changes() AS n").get().n, changesBefore);
});

test("episode runtime health remains a fixed-size scalar state under repeated failures", () => {
  const d = db();
  const shapeBefore = Object.keys(setupEpisodeV2HealthOnDb(d).runtime).sort();
  for (let i = 0; i < 200; i += 1) {
    assert.throws(() => buildSetupEpisodeV2({
      candidate: candidate({ underlying: null, nowMs: T0 + i }), result: result(), candidateId: i, env: {},
    }));
  }
  const runtime = setupEpisodeV2HealthOnDb(d).runtime;
  assert.deepEqual(Object.keys(runtime).sort(), shapeBefore);
  assert.equal(runtime.buildAttempts, 200);
  assert.equal(runtime.buildRejectionsTotal, 200);
  assert.equal(runtime.buildRejectionsByClass.OTHER_BUILD_ERROR, 200);
  assert.equal(Object.values(runtime).some(Array.isArray), false);
  assert.deepEqual(Object.keys(runtime.buildRejectionsByClass).sort(), [
    "OTHER_BUILD_ERROR", "OTHER_VALIDATION_REJECTION", "ZONE_A_FUTURE_TIMESTAMP",
  ]);
});

test("canonical Phase-1 tables are deterministic schema-readiness requirements", () => {
  const d = db();
  const report = inspectSchemaReadiness(d, { ALERT_DB_DIR: "/app/data" });
  assert.equal(report.ok, true);
  for (const table of ["setup_episodes", "episode_actions", "episode_outcome_labels_v2", "contract_funnel_evidence"]) {
    assert.ok(report.present.includes(table));
  }
});

test("production-shaped legacy setup_episodes upgrades columns before V2 indexes", () => {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE setup_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    symbol TEXT NOT NULL,
    t0_ms INTEGER NOT NULL,
    trading_day TEXT NOT NULL,
    session TEXT NOT NULL,
    feature_schema_version INTEGER NOT NULL,
    max_feature_as_of_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`);
  assert.doesNotThrow(() => ensureEnterpriseSchemaOnDb(d));
  const columns = new Set(d.prepare("PRAGMA table_info(setup_episodes)").all().map((r) => r.name));
  assert.ok(columns.has("episode_version"));
  assert.ok(columns.has("population"));
  const indexes = new Set(d.prepare("PRAGMA index_list(setup_episodes)").all().map((r) => r.name));
  assert.ok(indexes.has("idx_setup_episodes_v2_population"));
  assert.ok(indexes.has("idx_setup_episodes_v2_case"));
});

test("production-shaped legacy outcome labels upgrade columns before label-version index", () => {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE episode_outcome_labels_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id TEXT NOT NULL UNIQUE,
    episode_key TEXT NOT NULL,
    label_kind TEXT NOT NULL,
    horizon TEXT NOT NULL,
    exact_occ TEXT,
    entry_convention TEXT,
    terminal_return_pct REAL,
    mfe_pct REAL,
    mae_pct REAL,
    hit_10 INTEGER,
    hit_25 INTEGER,
    hit_50 INTEGER,
    hit_100 INTEGER,
    hit_neg_10 INTEGER,
    hit_neg_20 INTEGER,
    hit_stop INTEGER,
    time_to_10_ms INTEGER,
    time_to_25_ms INTEGER,
    time_to_50_ms INTEGER,
    time_to_100_ms INTEGER,
    time_to_neg_10_ms INTEGER,
    time_to_neg_20_ms INTEGER,
    time_to_stop_ms INTEGER,
    plus_10_before_neg_10 INTEGER,
    plus_25_before_neg_20 INTEGER,
    plus_50_before_stop INTEGER,
    stop_before_plus_25 INTEGER,
    coverage TEXT NOT NULL,
    censored INTEGER NOT NULL DEFAULT 0,
    missing_reason TEXT,
    quote_count INTEGER,
    first_evidence_at_ms INTEGER,
    last_evidence_at_ms INTEGER,
    evidence_quality TEXT NOT NULL,
    intrabar_status TEXT NOT NULL,
    label_as_of_ms INTEGER NOT NULL,
    config_digest TEXT NOT NULL,
    computed_at_ms INTEGER NOT NULL
  )`);
  assert.doesNotThrow(() => ensureEnterpriseSchemaOnDb(d));
  const columns = new Set(d.prepare("PRAGMA table_info(episode_outcome_labels_v2)").all().map((r) => r.name));
  assert.ok(columns.has("label_version"));
  assert.ok(columns.has("requested_end_at_ms"));
  const indexes = new Set(d.prepare("PRAGMA index_list(episode_outcome_labels_v2)").all().map((r) => r.name));
  assert.ok(indexes.has("idx_episode_outcomes_v2_version"));
});

test("episode identity is deterministic and collision-resistant enough for durable joins", () => {
  const material = {
    source: "live_scanner", symbol: "MRNA", t0Ms: T0, candidateId: 1,
    selectedOcc: contract.optionSymbol, configDigest: decisionConfigDigest({}),
  };
  const a = setupEpisodeV2Key(material);
  assert.equal(a, setupEpisodeV2Key(material));
  assert.match(a, /^ep2_[a-f0-9]{32}$/);
  assert.notEqual(a, setupEpisodeV2Key({ ...material, candidateId: 2 }));
});

test("config digest changes when a live delivery threshold changes and excludes unrelated secrets", () => {
  const base = decisionConfigDigest({ OPTIONS_QUALITY_DELIVER_BAR: "0.70", DISCORD_WEBHOOK_OPTIONS: "secret-a" });
  assert.notEqual(base, decisionConfigDigest({ OPTIONS_QUALITY_DELIVER_BAR: "0.71", DISCORD_WEBHOOK_OPTIONS: "secret-a" }));
  assert.equal(base, decisionConfigDigest({ OPTIONS_QUALITY_DELIVER_BAR: "0.70", DISCORD_WEBHOOK_OPTIONS: "secret-b" }));
});

test("ACTIONABLE, WATCH, and REJECTED evaluations write immutable V2 episodes without paper trades", () => {
  const d = db();
  const variants = [
    buildSetupEpisodeV2({ candidate: candidate(), result: result("READY", false), candidateId: 1, env: {} }),
    buildSetupEpisodeV2({ candidate: candidate({ nowMs: T0 + 1 }), result: result("READY", true), candidateId: 2, env: {} }),
    buildSetupEpisodeV2({ candidate: candidate({ nowMs: T0 + 2 }), result: result("REJECTED", false), candidateId: 3, env: {} }),
  ];
  for (const ep of variants) assert.equal(persistSetupEpisodeV2OnDb(d, ep).ok, true);
  assert.deepEqual(d.prepare("SELECT population FROM setup_episodes WHERE episode_version=2 ORDER BY t0_ms").all().map((r) => r.population), ["ACTIONABLE", "WATCH", "REJECTED"]);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_episodes WHERE episode_version=2").get().n, 3);
  assert.equal(setupEpisodeV2HealthOnDb(d).status, "OK");
  assert.equal(Boolean(d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_paper_trades'").get()), false,
    "episode capture has no paper-trade dependency");
  assert.throws(() => d.prepare("UPDATE setup_episodes SET population='WATCH' WHERE episode_version=2").run(), /immutable/);
});

test("Zone A rejects future outcomes and freezes truthful feature provenance", () => {
  const ep = buildSetupEpisodeV2({ candidate: candidate(), result: result(), candidateId: 1, env: {} });
  assert.equal(validateZoneA(ep.zoneA, ep.t0Ms).length, 0);
  assert.equal(ep.zoneA.underlying.relVolume.value, null);
  assert.equal(ep.zoneA.underlying.relVolume.quality, "MISSING");
  assert.equal(ep.zoneA.underlying.volumeSurgeProxy.quality, "PROXY");
  assert.equal(ep.zoneA.option.occ.value, contract.optionSymbol);
  assert.equal(ep.zoneA.option.ask.source, "provider_nbbo");
  assert.equal(Number(ep.zoneA.option.moneynessPct.value.toFixed(4)), Number((((120 / 143) - 1) * 100).toFixed(4)));
  assert.equal(ep.zoneA.optiscan.discoveryStage.quality, "MISSING");
  const leaky = structuredClone(ep.zoneA);
  leaky.optiscan.forwardOutcome = { value: 50, source: "future", asOfMs: T0 + 1, quality: "EXACT", missingReason: null, featureVersion: "x" };
  assert.ok(validateZoneA(leaky, T0).length >= 1);
});

test("observation, counterfactual, paper, and delivered actions are structurally distinct", () => {
  const d = db();
  const ep = buildSetupEpisodeV2({ candidate: candidate(), result: result(), candidateId: 1, env: {} });
  persistSetupEpisodeV2OnDb(d, ep);
  assert.equal(appendEpisodeActionOnDb(d, { episodeKey: ep.episodeKey, kind: "OBSERVATION", actionRef: "candidate:1", occurredAtMs: T0 }).ok, true);
  assert.equal(appendEpisodeActionOnDb(d, { episodeKey: ep.episodeKey, kind: "COUNTERFACTUAL", actionRef: "cf:1", occurredAtMs: T0 }).ok, false);
  assert.equal(appendEpisodeActionOnDb(d, {
    episodeKey: ep.episodeKey, kind: "COUNTERFACTUAL", actionRef: "cf:1", occurredAtMs: T0,
    exactOcc: contract.optionSymbol, defensibleEntry: true, entryConvention: "BUY_AT_ASK_EXIT_AT_FUTURE_BID",
  }).ok, true);
  assert.equal(appendEpisodeActionOnDb(d, { episodeKey: ep.episodeKey, kind: "PAPER_TRADE", actionRef: "paper:9", occurredAtMs: T0 }).ok, true);
  assert.equal(appendEpisodeActionOnDb(d, { episodeKey: ep.episodeKey, kind: "DELIVERED_SUBSCRIBER_TRADE", actionRef: "alert:a", occurredAtMs: T0 }).ok, true);
  assert.deepEqual(d.prepare("SELECT action_kind FROM episode_actions ORDER BY id").all().map((r) => r.action_kind),
    ["OBSERVATION", "COUNTERFACTUAL", "PAPER_TRADE", "DELIVERED_SUBSCRIBER_TRADE"]);
});

test("append-only V2 labels keep underlying/exact-option, horizons, conventions, and censoring separate", () => {
  const d = db();
  const ep = buildSetupEpisodeV2({ candidate: candidate(), result: result(), candidateId: 1, env: {} });
  persistSetupEpisodeV2OnDb(d, ep);
  const base = {
    episodeKey: ep.episodeKey, exactOcc: null, entryConvention: null,
    terminalReturnPct: null, mfePct: null, maePct: null,
    hit10: null, hit25: null, hit50: null, hit100: null, hitNeg10: null, hitNeg20: null, hitStop: null,
    timeTo10Ms: null, timeTo25Ms: null, timeTo50Ms: null, timeTo100Ms: null,
    timeToNeg10Ms: null, timeToNeg20Ms: null, timeToStopMs: null,
    plus10BeforeNeg10: null, plus25BeforeNeg20: null, plus50BeforeStop: null, stopBeforePlus25: null,
    coverage: "INSUFFICIENT", censored: true, missingReason: "NO_FORWARD_PATH", quoteCount: 0,
    firstEvidenceAtMs: null, lastEvidenceAtMs: null, evidenceQuality: "NONE",
    intrabarStatus: "NOT_APPLICABLE", labelAsOfMs: T0 + 5 * 60_000,
    configDigest: decisionConfigDigest({}),
  };
  assert.equal(appendOutcomeLabelV2OnDb(d, T0, { ...base, labelId: "u5", labelKind: "UNDERLYING_LABEL", horizon: "5m" }).ok, true);
  assert.equal(appendOutcomeLabelV2OnDb(d, T0, {
    ...base, labelId: "o15", labelKind: "EXACT_OPTION_EXECUTABLE_LABEL", horizon: "15m",
    exactOcc: contract.optionSymbol, entryConvention: "BUY_AT_ASK_EXIT_AT_FUTURE_BID",
  }).ok, true);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM episode_outcome_labels_v2").get().n, 2);
  assert.throws(() => d.prepare("UPDATE episode_outcome_labels_v2 SET hit_25=0").run(), /append-only/);
});
