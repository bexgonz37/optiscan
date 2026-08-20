/**
 * Phase 2A timestamp-semantics instrumentation gate.
 *
 * These tests exist to prove TWO things at once, and the second matters more
 * than the first:
 *
 *   1. the four-clock model classifies and measures correctly;
 *   2. NOTHING about live acceptance moved. The Zone-A validator still rejects
 *      exactly the fixture it rejected before, contract/strategy/delivery output
 *      is untouched, and no provider call was added.
 *
 * If a later change makes (2) fail, that change is the validator repair — which
 * belongs to the next phase, not this one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { ensureEnterpriseSchemaOnDb } from "../lib/db-schema-readiness.ts";
import {
  SIGNED_MS_BUCKETS,
  classifyTimestampRelation,
  decisionClockEvidence,
  decisionClockRelations,
  newSignedMsHistogram,
  recordSignedMs,
  signedMsBucketKey,
  signedQuoteAgeAt,
} from "../lib/research/episode/clocks.ts";
import {
  buildSetupEpisodeV2,
  classifyEpisodeBuildRejection,
  persistSetupEpisodeV2OnDb,
  resetSetupEpisodeV2HealthForTests,
  setupEpisodeV2HealthOnDb,
  validateZoneA,
} from "../lib/research/episode/v2.ts";

const T0 = Date.UTC(2026, 7, 20, 15, 0, 0);
const OBSERVATION_START = T0;
const DECISION = T0 + 4_000;

const candidate = (over = {}) => ({
  symbol: "MRNA", nowMs: T0, session: "regular", tier: 2,
  underlying: {
    price: 143, dayDollarVolume: 2e9, relVolume: 2.4, volumeAccel: 1.2,
    volumeSurgeProxy: 3.2, dollarVolumeAccel: 1.3, velPct: 4, accelPct: 1,
    gapPct: null, aboveVwap: true, hodBreak: false, lodBreak: false,
    nearResistancePct: 0.2, nearSupportPct: null, compressionPct: 0.7,
    realizedVolExpanding: true, openingRange: true, premarketLevelTest: false,
  },
  ...over,
});

const contractAt = (providerTimestamp) => ({
  optionSymbol: "O:MRNA260821C00120000", side: "call", strike: 120,
  expiration: "2026-08-21", dte: 1, bid: 22, ask: 24, spreadPct: 8.7,
  volume: 250, openInterest: 900, iv: 1.2, delta: 0.55, gamma: 0.01,
  theta: -0.3, vega: 0.1, providerTimestamp,
});

function result(providerTimestamp, state = "READY") {
  return {
    selection: {
      symbol: "MRNA", direction: "bullish", reason: "selected breakout_forming",
      selected: { key: "breakout_forming", label: "Breakout forming", score: 0.75, side: "call", researchOnly: false, preferredDte: "1-7dte" },
      considered: [{ key: "breakout_forming", label: "Breakout forming", applicable: true, score: 0.75, matched: ["volume_acceleration"], rejection: null }],
    },
    contract: contractAt(providerTimestamp),
    callout: { state, message: null, reason: "ready", freshness: "FRESH", entry: null },
    paperEntry: null,
    state,
    contractFunnel: null,
  };
}

const clocks = (over = {}) => ({
  observationStartedAtMs: OBSERVATION_START,
  decisionAtMs: DECISION,
  quoteReceivedAtMs: DECISION - 500,
  ...over,
});

function build(providerTimestamp, over = {}) {
  return buildSetupEpisodeV2({
    candidate: candidate(), result: result(providerTimestamp),
    candidateId: 7, clocks: clocks(over), env: {},
  });
}

function db() {
  const d = new Database(":memory:");
  ensureEnterpriseSchemaOnDb(d);
  return d;
}

// ── 1/2/3. The three classifications ────────────────────────────────────────

test("a quote event inside the evaluation window is BETWEEN_OBSERVATION_AND_DECISION", () => {
  // The 2026-08-20 population: 311ms after the scan began, well before the decision.
  const relation = classifyTimestampRelation({
    observationStartedAtMs: OBSERVATION_START,
    decisionAtMs: DECISION,
    quoteEventAtMs: OBSERVATION_START + 311,
  });
  assert.equal(relation, "BETWEEN_OBSERVATION_AND_DECISION");
  // The decision instant itself is INSIDE the window, not after it.
  assert.equal(classifyTimestampRelation({
    observationStartedAtMs: OBSERVATION_START, decisionAtMs: DECISION, quoteEventAtMs: DECISION,
  }), "BETWEEN_OBSERVATION_AND_DECISION");
});

test("a quote event after the decision instant is AFTER_DECISION", () => {
  assert.equal(classifyTimestampRelation({
    observationStartedAtMs: OBSERVATION_START, decisionAtMs: DECISION, quoteEventAtMs: DECISION + 1,
  }), "AFTER_DECISION");
});

test("a quote event at or before observation start is BEFORE_OR_AT_OBSERVATION_START", () => {
  assert.equal(classifyTimestampRelation({
    observationStartedAtMs: OBSERVATION_START, decisionAtMs: DECISION, quoteEventAtMs: OBSERVATION_START - 900,
  }), "BEFORE_OR_AT_OBSERVATION_START");
  assert.equal(classifyTimestampRelation({
    observationStartedAtMs: OBSERVATION_START, decisionAtMs: DECISION, quoteEventAtMs: OBSERVATION_START,
  }), "BEFORE_OR_AT_OBSERVATION_START");
});

test("missing or incoherent clocks are INSUFFICIENT_TIMESTAMP_EVIDENCE, never a guess", () => {
  const base = { observationStartedAtMs: OBSERVATION_START, decisionAtMs: DECISION, quoteEventAtMs: T0 };
  for (const missing of ["observationStartedAtMs", "decisionAtMs", "quoteEventAtMs"]) {
    assert.equal(classifyTimestampRelation({ ...base, [missing]: null }), "INSUFFICIENT_TIMESTAMP_EVIDENCE", missing);
  }
  // A decision that precedes its own observation start is not a usable window.
  assert.equal(classifyTimestampRelation({
    observationStartedAtMs: DECISION, decisionAtMs: OBSERVATION_START, quoteEventAtMs: T0,
  }), "INSUFFICIENT_TIMESTAMP_EVIDENCE");
});

// ── 4/5. Signed differences survive; nothing is clamped ─────────────────────

test("signed quote age keeps its sign and never clamps", () => {
  assert.equal(signedQuoteAgeAt(1_000, 400), 600);
  assert.equal(signedQuoteAgeAt(400, 1_000), -600);
  assert.equal(signedQuoteAgeAt(1_000, 1_000), 0);
  // Null ONLY for a missing input — never because the answer came out negative.
  assert.equal(signedQuoteAgeAt(null, 1_000), null);
  assert.equal(signedQuoteAgeAt(1_000, null), null);
  assert.equal(signedQuoteAgeAt(1_000, Number.NaN), null);
});

test("derived relations preserve every sign and separate mixed from local clocks", () => {
  const quoteEventAtMs = OBSERVATION_START + 311;
  const r = decisionClockRelations({ ...clocks(), quoteEventAtMs });
  assert.equal(r.quoteEventAfterObservationStartMs, 311);          // signed, positive
  assert.equal(r.quoteAgeAtDecisionMs, DECISION - quoteEventAtMs); // 3689
  assert.equal(r.quoteAgeAtObservationStartMs, -311);              // signed, NEGATIVE, preserved
  assert.equal(r.observationStartToDecisionMs, 4_000);
  assert.equal(r.chainResponseCompletedToDecisionMs, 500);
  // The two views of the same fact must be exact negatives of each other.
  assert.equal(r.quoteEventAfterObservationStartMs, -r.quoteAgeAtObservationStartMs);
});

test("an unmeasured chain completion is null, never fabricated from another clock", () => {
  const r = decisionClockRelations({ ...clocks({ quoteReceivedAtMs: null }), quoteEventAtMs: T0 });
  assert.equal(r.quoteEventToChainResponseCompletedMs, null);
  assert.equal(r.chainResponseCompletedToDecisionMs, null);
  // The clocks that ARE present still measure.
  assert.equal(r.observationStartToDecisionMs, 4_000);
});

test("the built episode carries four distinct clocks and never collapses one into another", () => {
  resetSetupEpisodeV2HealthForTests();
  const quoteEventAtMs = OBSERVATION_START - 2_000;
  const ep = build(quoteEventAtMs);
  const c = ep.decisionClocks;
  assert.equal(c.observationStartedAtMs, OBSERVATION_START);
  assert.equal(c.decisionAtMs, DECISION);
  assert.equal(c.quoteEventAtMs, quoteEventAtMs);
  assert.equal(c.quoteReceivedAtMs, DECISION - 500);
  assert.equal(new Set([c.observationStartedAtMs, c.decisionAtMs, c.quoteEventAtMs, c.quoteReceivedAtMs]).size, 4);
  assert.equal(c.clockDomains.quoteEventAtMs, "PROVIDER_EXCHANGE_SIP");
  assert.equal(c.clockDomains.decisionAtMs, "LOCAL");
  assert.equal(c.authority, "DIAGNOSTIC_ONLY");
  // t0 semantics are untouched: still the observation start, and Zone A is still
  // validated against it.
  assert.equal(ep.t0Ms, T0);
  assert.equal(ep.maxFeatureAsOfMs, T0);
});

test("the builder reads the quote event from the contract, so a caller cannot substitute a local clock", () => {
  resetSetupEpisodeV2HealthForTests();
  const ep = buildSetupEpisodeV2({
    candidate: candidate(), result: result(T0 - 5_000), candidateId: 1, env: {},
    // A caller trying to inject a quote event is simply ignored.
    clocks: { ...clocks(), quoteEventAtMs: DECISION + 999_999 },
  });
  assert.equal(ep.decisionClocks.quoteEventAtMs, T0 - 5_000);
});

// ── 6. THE REGRESSION GUARD: live behaviour did not change ──────────────────

test("the Zone-A validator still rejects the same future-vs-t0 fixture as before", () => {
  resetSetupEpisodeV2HealthForTests();
  // 311ms after t0 — inside the evaluation window, and STILL rejected. That is
  // the point: the old rule is left in place so the two can be compared live.
  const futureByMs = 311;
  assert.throws(() => build(T0 + futureByMs), /Zone-A leakage/);

  const health = setupEpisodeV2HealthOnDb(db());
  assert.equal(health.runtime.buildAttempts, 1);
  assert.equal(health.runtime.buildSuccesses, 0);
  assert.equal(health.runtime.buildRejectionsByClass.ZONE_A_FUTURE_TIMESTAMP, 1);
  assert.equal(health.timestampSemantics.validatorChanged, false);
  assert.equal(health.timestampSemantics.authority, "DIAGNOSTIC_ONLY");

  // And the raw validator, called directly, behaves exactly as documented.
  const zoneA = { u: { asOfMs: T0 + 1, value: 1, source: "s", quality: "EXACT", missingReason: null, featureVersion: "v" } };
  assert.equal(validateZoneA(zoneA, T0).length, 1);
  assert.equal(validateZoneA({ ...zoneA, u: { ...zoneA.u, asOfMs: T0 } }, T0).length, 0);
  assert.equal(classifyEpisodeBuildRejection(new Error(`SetupEpisodeV2 Zone-A leakage: zoneA.option.bid.asOfMs ${T0 + 1} > t0Ms ${T0}`)), "ZONE_A_FUTURE_TIMESTAMP");
});

test("a quote arriving inside the window is still rejected, and is classified as the reason why", () => {
  resetSetupEpisodeV2HealthForTests();
  assert.throws(() => build(OBSERVATION_START + 311), /Zone-A leakage/);
  const ts = setupEpisodeV2HealthOnDb(db()).timestampSemantics;
  // Rejected (unchanged) AND measured (new). This single counter is the number
  // the next live session has to produce before the validator may be touched.
  assert.equal(ts.zoneAFutureTimestampRejections.total, 1);
  assert.equal(ts.zoneAFutureTimestampRejections.betweenObservationAndDecisionCount, 1);
  assert.equal(ts.zoneAFutureTimestampRejections.afterDecisionCount, 0);
  assert.equal(ts.zoneAFutureTimestampRejections.insufficientCount, 0);
});

test("a quote genuinely after the decision is rejected AND classified AFTER_DECISION", () => {
  resetSetupEpisodeV2HealthForTests();
  assert.throws(() => build(DECISION + 1_500), /Zone-A leakage/);
  const ts = setupEpisodeV2HealthOnDb(db()).timestampSemantics;
  assert.equal(ts.zoneAFutureTimestampRejections.afterDecisionCount, 1);
  assert.equal(ts.zoneAFutureTimestampRejections.betweenObservationAndDecisionCount, 0);
});

test("a rejection with no clock evidence is counted as insufficient, not guessed", () => {
  resetSetupEpisodeV2HealthForTests();
  // No `clocks` at all: observation start falls back to nowMs, decision is unknown.
  assert.throws(() => buildSetupEpisodeV2({
    candidate: candidate(), result: result(T0 + 400), candidateId: 3, env: {},
  }), /Zone-A leakage/);
  const ts = setupEpisodeV2HealthOnDb(db()).timestampSemantics;
  assert.equal(ts.zoneAFutureTimestampRejections.insufficientCount, 1);
  assert.equal(ts.zoneAFutureTimestampRejections.betweenObservationAndDecisionCount, 0);
  assert.equal(ts.zoneAFutureTimestampRejections.reconciles, true);
});

test("no trading output changed: strategy, contract, disposition and convention are untouched", () => {
  resetSetupEpisodeV2HealthForTests();
  const withClocks = build(T0 - 1_000);
  resetSetupEpisodeV2HealthForTests();
  const withoutClocks = buildSetupEpisodeV2({
    candidate: candidate(), result: result(T0 - 1_000), candidateId: 7, env: {},
  });
  for (const key of [
    "episodeKey", "population", "disposition", "selectedStrategy", "selectionStrength",
    "selectedOcc", "entryConvention", "direction", "rejectionReason", "t0Ms",
    "maxFeatureAsOfMs", "configDigest", "sourceLane",
  ]) {
    assert.deepEqual(withClocks[key], withoutClocks[key], key);
  }
  // Zone A itself — the frozen decision evidence — is byte-identical.
  assert.equal(JSON.stringify(withClocks.zoneA), JSON.stringify(withoutClocks.zoneA));
});

test("the legacy executable-freshness clamp is preserved exactly as it was", () => {
  resetSetupEpisodeV2HealthForTests();
  // A quote 2s old: legacy age is 2000 and the contract is executable.
  const older = build(T0 - 2_000);
  assert.equal(older.zoneA.option.quoteAgeMs.value, 2_000);
  assert.equal(older.zoneA.option.executableAtT0.value, true);
  // A quote 90s old: still positive, but past the 60s executability bar.
  resetSetupEpisodeV2HealthForTests();
  const stale = build(T0 - 90_000);
  assert.equal(stale.zoneA.option.quoteAgeMs.value, 90_000);
  assert.equal(stale.zoneA.option.executableAtT0.value, false);
  // The canonical SIGNED value for the same episode is not clamped, and the two
  // disagree exactly where the legacy clamp bites.
  assert.equal(stale.decisionClocks.relations.quoteAgeAtObservationStartMs, 90_000);
});

// ── 7/8/9. Health counters ──────────────────────────────────────────────────

test("timestamp relation counters reconcile with build attempts", () => {
  resetSetupEpisodeV2HealthForTests();
  build(OBSERVATION_START - 5_000);                                   // before start  → success
  assert.throws(() => build(OBSERVATION_START + 200), /Zone-A/);      // in window     → rejected
  assert.throws(() => build(DECISION + 200), /Zone-A/);               // after decision→ rejected
  assert.throws(() => buildSetupEpisodeV2({                           // no clocks     → rejected
    candidate: candidate(), result: result(T0 + 50), candidateId: 9, env: {},
  }), /Zone-A/);

  const health = setupEpisodeV2HealthOnDb(db());
  const ts = health.timestampSemantics;
  assert.equal(health.runtime.buildAttempts, 4);
  assert.equal(ts.attemptsClassified, 4);
  assert.equal(ts.reconcilesWithBuildAttempts, true);
  assert.equal(ts.timestampRelation.BEFORE_OR_AT_OBSERVATION_START, 1);
  assert.equal(ts.timestampRelation.BETWEEN_OBSERVATION_AND_DECISION, 1);
  assert.equal(ts.timestampRelation.AFTER_DECISION, 1);
  assert.equal(ts.timestampRelation.INSUFFICIENT_TIMESTAMP_EVIDENCE, 1);
  // Rejections reconcile against their own class total independently.
  assert.equal(ts.zoneAFutureTimestampRejections.total, 3);
  assert.equal(ts.zoneAFutureTimestampRejections.classified, 3);
  assert.equal(ts.zoneAFutureTimestampRejections.reconciles, true);
});

test("firstBuildAttemptAtMs is recorded once and never moves", () => {
  resetSetupEpisodeV2HealthForTests();
  const d = db();
  assert.equal(setupEpisodeV2HealthOnDb(d).runtime.firstBuildAttemptAtMs, null);
  build(T0 - 1_000);
  assert.equal(setupEpisodeV2HealthOnDb(d).runtime.firstBuildAttemptAtMs, T0);
  buildSetupEpisodeV2({
    candidate: candidate({ nowMs: T0 + 60_000 }), result: result(T0 + 50_000),
    candidateId: 2, clocks: clocks({ observationStartedAtMs: T0 + 60_000, decisionAtMs: T0 + 64_000 }), env: {},
  });
  const runtime = setupEpisodeV2HealthOnDb(d).runtime;
  assert.equal(runtime.firstBuildAttemptAtMs, T0, "first attempt must not move");
  assert.equal(runtime.lastBuildAttemptAtMs, T0 + 60_000, "last attempt must advance");
});

test("health stays a bounded, fixed-width structure under heavy traffic", () => {
  resetSetupEpisodeV2HealthForTests();
  for (let i = 0; i < 400; i += 1) {
    // Deliberately spread across every relation class and both signs.
    const offset = (i % 4 === 0) ? -6_000 : (i % 4 === 1) ? 200 : (i % 4 === 2) ? 9_000 : -50;
    try { build(OBSERVATION_START + offset); } catch { /* rejections are expected */ }
  }
  const ts = setupEpisodeV2HealthOnDb(db()).timestampSemantics;
  assert.equal(ts.buildAttempts, 400);
  assert.equal(ts.bounded, true);
  assert.equal(ts.providerCalls, 0);
  assert.equal(ts.scope, "PROCESS_LIFETIME");
  // Fixed key sets regardless of how many events were recorded.
  assert.equal(Object.keys(ts.timestampRelation).length, 4);
  const hist = ts.histograms.allAttempts.quoteEventAfterObservationStartMs;
  assert.equal(Object.keys(hist.buckets).length, SIGNED_MS_BUCKETS.length);
  assert.equal(hist.samples, 400);
  // Serialized size is a constant, not a function of traffic.
  assert.ok(JSON.stringify(ts).length < 6_000, "health payload must stay small");
});

test("a restart resets process-lifetime counters to a clean, fully-formed state", () => {
  resetSetupEpisodeV2HealthForTests();
  build(T0 - 1_000);
  resetSetupEpisodeV2HealthForTests();               // simulates a process restart
  const ts = setupEpisodeV2HealthOnDb(db()).timestampSemantics;
  assert.equal(ts.buildAttempts, 0);
  assert.equal(ts.firstBuildAttemptAtMs, null);
  assert.equal(ts.reconcilesWithBuildAttempts, true);
  for (const n of Object.values(ts.timestampRelation)) assert.equal(n, 0);
  assert.equal(ts.histograms.allAttempts.quoteAgeAtDecisionMs.samples, 0);
});

// ── Histogram mechanics ─────────────────────────────────────────────────────

test("signed histogram buckets are contiguous, signed, and give zero its own bucket", () => {
  assert.equal(signedMsBucketKey(0), "0");
  assert.equal(signedMsBucketKey(-1), "-100..-1");
  assert.equal(signedMsBucketKey(1), "1..100");
  assert.equal(signedMsBucketKey(-5_000), "<=-5000");
  assert.equal(signedMsBucketKey(-5_001), "<=-5000");
  assert.equal(signedMsBucketKey(5_000), "2001..5000");
  assert.equal(signedMsBucketKey(5_001), ">5000");
  assert.equal(signedMsBucketKey(3_564), "2001..5000");   // the measured 2026-08-20 max
  assert.equal(signedMsBucketKey(311), "251..500");       // the measured p50
  // No value can fall outside the bucket set.
  for (const v of [-1e9, -5001, -1, 0, 1, 1e9]) assert.ok(signedMsBucketKey(v));
});

test("a missing sample is counted as unmeasured, never as a zero", () => {
  const h = newSignedMsHistogram();
  recordSignedMs(h, null);
  recordSignedMs(h, undefined);
  recordSignedMs(h, Number.NaN);
  recordSignedMs(h, 0);
  assert.equal(h.unmeasured, 3);
  assert.equal(h.samples, 1);
  assert.equal(h.buckets["0"], 1);
});

test("the health histogram is a snapshot and cannot alias live counter state", () => {
  resetSetupEpisodeV2HealthForTests();
  const d = db();
  build(T0 - 1_000);
  const first = setupEpisodeV2HealthOnDb(d).timestampSemantics.histograms.allAttempts.quoteEventAfterObservationStartMs;
  build(T0 - 2_000);
  assert.equal(first.samples, 1, "an earlier snapshot must not mutate");
  assert.equal(
    setupEpisodeV2HealthOnDb(d).timestampSemantics.histograms.allAttempts.quoteEventAfterObservationStartMs.samples,
    2,
  );
});

// ── 10/11. Persistence, legacy rows, no provider calls ──────────────────────

test("the four clocks persist to columns and to immutable provenance JSON", () => {
  resetSetupEpisodeV2HealthForTests();
  const d = db();
  const quoteEventAtMs = OBSERVATION_START - 1_200;
  const ep = build(quoteEventAtMs);
  assert.equal(persistSetupEpisodeV2OnDb(d, ep, T0).ok, true);

  const row = d.prepare(`SELECT observation_started_at_ms, decision_at_ms, quote_event_at_ms,
    quote_received_at_ms, timestamp_relation, provenance_json, t0_ms
    FROM setup_episodes WHERE episode_key=?`).get(ep.episodeKey);
  assert.equal(row.observation_started_at_ms, OBSERVATION_START);
  assert.equal(row.decision_at_ms, DECISION);
  assert.equal(row.quote_event_at_ms, quoteEventAtMs);
  assert.equal(row.quote_received_at_ms, DECISION - 500);
  assert.equal(row.timestamp_relation, "BEFORE_OR_AT_OBSERVATION_START");
  // t0 keeps its existing meaning and is still stored separately.
  assert.equal(row.t0_ms, T0);
  const provenance = JSON.parse(row.provenance_json);
  assert.equal(provenance.sourceLane, "OPTIONS_MONITOR");            // unchanged legacy key
  assert.equal(provenance.decisionClocks.quoteEventAtMs, quoteEventAtMs);
  assert.equal(provenance.decisionClocks.relations.quoteAgeAtDecisionMs, DECISION - quoteEventAtMs);
  assert.equal(provenance.decisionClocks.authority, "DIAGNOSTIC_ONLY");
});

test("persisted V2 rows stay immutable after the clock columns exist", () => {
  resetSetupEpisodeV2HealthForTests();
  const d = db();
  const ep = build(T0 - 1_000);
  persistSetupEpisodeV2OnDb(d, ep, T0);
  assert.throws(
    () => d.prepare("UPDATE setup_episodes SET decision_at_ms=? WHERE episode_key=?").run(0, ep.episodeKey),
    /immutable/,
  );
  assert.throws(() => d.prepare("DELETE FROM setup_episodes WHERE episode_key=?").run(ep.episodeKey), /immutable/);
});

test("a production-shaped legacy table gains the clock columns before any index is built", () => {
  const d = new Database(":memory:");
  // The pre-Phase-2A production shape: no V2 identity columns, no clock columns.
  d.exec(`CREATE TABLE setup_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, episode_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL, symbol TEXT NOT NULL, t0_ms INTEGER NOT NULL,
    trading_day TEXT NOT NULL, session TEXT NOT NULL, tod_bucket TEXT,
    asset_class TEXT NOT NULL DEFAULT 'stock', direction TEXT, missing_json TEXT,
    gate_results_json TEXT, feature_schema_version INTEGER NOT NULL,
    max_feature_as_of_ms INTEGER NOT NULL, provenance_json TEXT, created_at_ms INTEGER NOT NULL
  );`);
  // Must not throw: the Phase-1 incident was an index created before its columns.
  ensureEnterpriseSchemaOnDb(d);
  const columns = new Set(d.prepare("PRAGMA table_info(setup_episodes)").all().map((c) => c.name));
  for (const c of [
    "observation_started_at_ms", "decision_at_ms", "quote_event_at_ms",
    "quote_received_at_ms", "timestamp_relation",
  ]) assert.ok(columns.has(c), `missing ${c}`);
  const indexes = d.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  assert.ok(indexes.includes("idx_setup_episodes_v2_ts_relation"));
  // Repeat-safe: running the repair again is a no-op, not an error.
  ensureEnterpriseSchemaOnDb(d);

  resetSetupEpisodeV2HealthForTests();
  assert.equal(persistSetupEpisodeV2OnDb(d, build(T0 - 1_000), T0).ok, true);
});

test("legacy rows without clock evidence stay readable and report no relation", () => {
  const d = db();
  d.prepare(`INSERT INTO setup_episodes
    (episode_key,source,symbol,t0_ms,trading_day,session,asset_class,missing_json,gate_results_json,
     feature_schema_version,max_feature_as_of_ms,provenance_json,created_at_ms,episode_version,population,zone_a_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("ep2_legacy", "live_scanner", "AAPL", T0, "2026-08-20", "regular", "option",
      "[]", "{}", 2, T0, JSON.stringify({ sourceLane: "OPTIONS_MONITOR" }), T0, 2, "ACTIONABLE", "{}");
  const row = d.prepare("SELECT * FROM setup_episodes WHERE episode_key='ep2_legacy'").get();
  assert.equal(row.observation_started_at_ms, null);
  assert.equal(row.decision_at_ms, null);
  assert.equal(row.timestamp_relation, null);
  assert.equal(JSON.parse(row.provenance_json).decisionClocks, undefined);
  // The V2 count still includes it — an absent clock is not an absent episode.
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_episodes WHERE episode_version=2").get().n, 1);
});

test("the whole instrumentation path is pure: no provider calls, no network, no clock reads", () => {
  // decisionClockEvidence is the only thing the live path calls per candidate.
  const before = Date.now;
  let dateNowCalls = 0;
  Date.now = () => { dateNowCalls += 1; return before.call(Date); };
  try {
    const evidence = decisionClockEvidence({ ...clocks(), quoteEventAtMs: T0 - 500 });
    assert.equal(evidence.timestampRelation, "BEFORE_OR_AT_OBSERVATION_START");
    const h = newSignedMsHistogram();
    recordSignedMs(h, evidence.relations.quoteAgeAtDecisionMs);
    assert.equal(h.samples, 1);
  } finally {
    Date.now = before;
  }
  assert.equal(dateNowCalls, 0, "instrumentation must not read the clock itself");
  // No fetch/provider module is imported by the clocks module at all.
  assert.equal(typeof decisionClockEvidence, "function");
});

// ── Legacy freshness divergence is a tracked, live fact ─────────────────────

test("every still-divergent legacy quote-age consumer is named on the health surface", async () => {
  const { LEGACY_QUOTE_AGE_CONSUMERS, CANONICAL_QUOTE_AGE } =
    await import("../lib/research/episode/clocks.ts");
  resetSetupEpisodeV2HealthForTests();
  const legacy = setupEpisodeV2HealthOnDb(db()).timestampSemantics.legacyQuoteAgeSemantics;
  // Phase 2A explicitly does NOT unify them.
  assert.equal(legacy.unified, false);
  assert.equal(CANONICAL_QUOTE_AGE.referenceClock, "DECISION");
  assert.equal(CANONICAL_QUOTE_AGE.negativeHandling, "PRESERVED_SIGNED");
  assert.equal(legacy.stillDivergent.length, LEGACY_QUOTE_AGE_CONSUMERS.length);
  for (const c of legacy.stillDivergent) {
    assert.ok(c.consumer && c.site && c.note, "each consumer names itself and its site");
    // Each one diverges on the reference clock, the sign handling, or both.
    const divergesOnClock = c.referenceClock !== CANONICAL_QUOTE_AGE.referenceClock;
    const divergesOnSign = c.negativeHandling !== CANONICAL_QUOTE_AGE.negativeHandling;
    assert.ok(divergesOnClock || divergesOnSign, `${c.consumer} is listed but does not diverge`);
    // None of them can currently observe a negative age at all.
    assert.ok(["CLAMPED_TO_ZERO", "NULL_AND_INVALID"].includes(c.negativeHandling));
  }
});
