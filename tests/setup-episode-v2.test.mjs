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
  setupEpisodeV2HealthOnDb,
  setupEpisodeV2Key,
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
  return d;
}

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
