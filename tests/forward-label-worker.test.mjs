import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { ensureEnterpriseSchemaOnDb } from "../lib/db-schema-readiness.ts";
import {
  appendEpisodeActionOnDb,
  buildSetupEpisodeV2,
  persistSetupEpisodeV2OnDb,
} from "../lib/research/episode/v2.ts";
import {
  FORWARD_ENTRY_CONVENTION,
  buildCoverageReportOnDb,
  buildDatasetVersionOnDb,
  competingOrder,
  evaluateOptionPath,
  evaluateUnderlyingPath,
  forwardLabelConfig,
  horizonMatured,
  runForwardLabelWorkerOnDb,
} from "../lib/research/episode/forward-labeler.ts";

const T0 = Date.UTC(2026, 7, 19, 15, 0, 0);
const OCC_CALL = "O:MRNA260821C00140000";
const OCC_PUT = "O:MRNA260821P00140000";
const cfg = { ...forwardLabelConfig({}), evidenceGraceMs: 30_000 };

function zoneValue(value, asOfMs = T0) {
  return { value, source: "fixture", asOfMs, quality: value == null ? "MISSING" : "EXACT", missingReason: value == null ? "FIXTURE_MISSING" : null, featureVersion: "fixture@1" };
}

function episode(over = {}) {
  const occ = over.selected_occ === undefined ? OCC_CALL : over.selected_occ;
  const direction = over.direction ?? "bullish";
  const t0 = over.t0_ms ?? T0;
  return {
    episode_key: over.episode_key ?? "ep_fixture_1", symbol: over.symbol ?? "MRNA", t0_ms: t0,
    trading_day: "2026-08-19", session: "regular", direction, population: over.population ?? "ACTIONABLE",
    selected_strategy: "breakout_forming", selection_strength: 0.75, selected_occ: occ,
    entry_convention: occ ? FORWARD_ENTRY_CONVENTION : null, config_digest: "fixture-digest",
    production_sha: "fixture-sha", opportunity_case_id: null, thesis_fingerprint: null,
    zone_a_json: JSON.stringify({
      underlying: { price: zoneValue(over.underlyingPrice ?? 100, t0) },
      option: occ ? {
        occ: zoneValue(occ, t0), side: zoneValue(direction === "bearish" ? "put" : "call", t0),
        ask: zoneValue(over.ask ?? 1.2, t0 - 1_000), bid: zoneValue(over.bid ?? 1.1, t0 - 1_000),
        quoteTimestamp: zoneValue(t0 - 1_000, t0), quoteAgeMs: zoneValue(1_000, t0),
        spreadPct: zoneValue(8.7, t0), executableAtT0: zoneValue(true, t0),
      } : null,
      optiscan: { sharedFeatureSnapshot: zoneValue(over.featureSnapshot ?? null, t0) }, marketContext: {},
    }),
    ...over,
  };
}

function quote(atMinutes, bid, ask = Math.max(0.01, bid + 0.1), extra = {}) {
  return { atMs: T0 + atMinutes * 60_000, bid, ask, quoteAgeMs: 0, source: "fixture_nbbo", ...extra };
}

function optionLabel(points, over = {}) {
  return evaluateOptionPath({
    episode: episode(over.episode ?? {}), horizon: over.horizon ?? "5m", endMs: over.endMs ?? T0 + 5 * 60_000,
    nowMs: over.nowMs ?? T0 + 10 * 60_000, points, config: { ...cfg, ...(over.config ?? {}) },
    providerAdmissionConstrained: over.providerAdmissionConstrained, truncated: over.truncated,
  });
}

test("exact option ask-entry/future-bid return, independent MFE/MAE, thresholds, and event order", () => {
  const path = [quote(1, 0.9), quote(2, 0.95), quote(3, 1.5), quote(4, 3.25), quote(5, 3.25)];
  const label = optionLabel(path);
  assert.equal(label.terminalReturnPct, 170.8333, "1.20 ask to 3.25 future bid");
  assert.equal(label.maePct, -25, "initial decline is MAE");
  assert.equal(label.mfePct, 170.8333, "later rally is MFE");
  assert.equal(label.plus25VsNeg20Order, "SECOND_EVENT", "-20 happened before +25");
  assert.equal(label.hit100, true);
  assert.equal(label.hit200, false);

  const targetFirst = optionLabel([quote(1, 1.5), quote(2, 0.9), quote(3, 1.3), quote(4, 1.3), quote(5, 1.3)]);
  assert.equal(targetFirst.plus25VsNeg20Order, "FIRST_EVENT", "+25 happened before -20");
  assert.equal(targetFirst.plus25BeforeNeg20, true);
});

test("competing events preserve exact ambiguity and underlying intrabar ambiguity", () => {
  assert.equal(competingOrder(T0 + 1, T0 + 1), "AMBIGUOUS");
  assert.equal(competingOrder(T0 + 1, T0 + 1, true), "AMBIGUOUS_INTRABAR");
  const u = evaluateUnderlyingPath({
    episode: episode(), horizon: "5m", endMs: T0 + 5 * 60_000, nowMs: T0 + 10 * 60_000, config: cfg,
    bars: [
      { atMs: T0 + 60_000, open: 100, high: 126, low: 79, close: 101, source: "fixture_ohlc", quality: "OK" },
      ...[2,3,4].map((m) => ({ atMs: T0 + m * 60_000, open: 101, high: 102, low: 100, close: 101, source: "fixture_ohlc", quality: "OK" })),
    ],
  });
  assert.equal(u.plus25VsNeg20Order, "AMBIGUOUS_INTRABAR");
  assert.equal(u.intrabarStatus, "AMBIGUOUS_INTRABAR");
});

test("CALL and PUT underlying direction use the frozen entry denominator", () => {
  const bars = [1,2,3,4].map((m) => ({ atMs: T0 + m * 60_000, open: 100, high: 110, low: 90, close: 90, source: "fixture_ohlc", quality: "OK" }));
  const call = evaluateUnderlyingPath({ episode: episode({ direction: "bullish" }), horizon: "5m", endMs: T0 + 5 * 60_000, nowMs: T0 + 10 * 60_000, bars, config: cfg });
  const put = evaluateUnderlyingPath({ episode: episode({ direction: "bearish" }), horizon: "5m", endMs: T0 + 5 * 60_000, nowMs: T0 + 10 * 60_000, bars, config: cfg });
  assert.equal(call.terminalReturnPct, -10);
  assert.equal(put.terminalReturnPct, 10);
  assert.equal(call.mfePct, 10);
  assert.equal(put.mfePct, 10);
});

test("immature, missing, stale/gapped, zero-bid, and invalid NBBO stay distinct", () => {
  assert.equal(horizonMatured(episode(), "5m", T0 + 5 * 60_000, cfg, {}), false, "immature is not missing");
  const missing = optionLabel([]);
  assert.equal(missing.coverage, "INSUFFICIENT");
  assert.equal(missing.missingReason, "NO_FUTURE_QUOTE");
  assert.equal(missing.hit25, null, "absence is unknown, never did-not-hit");

  const gapped = optionLabel([quote(1, 1.3), quote(5, 1.4)], { config: { maxOptionGapMs: 90_000 } });
  assert.equal(gapped.coverage, "CENSORED");
  assert.equal(gapped.missingReason, "QUOTE_PATH_INADEQUATE");
  assert.equal(gapped.terminalReturnPct, null);

  const zero = optionLabel([quote(1, 0, 0.1), quote(2, 0, 0.1), quote(3, 0, 0.1), quote(4, 0, 0.1), quote(5, 0, 0.1)]);
  assert.equal(zero.terminalReturnPct, -100);
  const crossed = optionLabel([quote(1, 1.3, 1.2), quote(5, 1.3, 1.2)]);
  assert.equal(crossed.missingReason, "INVALID_OR_CROSSED_NBBO");
  const stale = optionLabel([quote(1, 1.3, 1.4, { quoteAgeMs: 999_999 }), quote(5, 1.4, 1.5, { quoteAgeMs: 999_999 })]);
  assert.equal(stale.coverage, "INSUFFICIENT");
  assert.equal(stale.terminalReturnPct, null);
});

function candidate(nowMs = T0, symbol = "MRNA") {
  return { symbol, nowMs, session: "regular", tier: 2, underlying: {
    price: 100, dayDollarVolume: 2e9, relVolume: 2, volumeAccel: 1.2, volumeSurgeProxy: 2,
    dollarVolumeAccel: 1.3, velPct: 2, accelPct: 1, gapPct: 1, aboveVwap: true, hodBreak: false,
    lodBreak: false, nearResistancePct: 0.2, nearSupportPct: null, compressionPct: 0.7,
    realizedVolExpanding: true, openingRange: true, premarketLevelTest: false,
  } };
}

function evaluation({ population = "ACTIONABLE", occ = OCC_CALL, side = "call" } = {}) {
  const rejected = population === "REJECTED";
  return {
    selection: {
      symbol: "MRNA", direction: side === "put" ? "bearish" : "bullish", reason: "fixture",
      selected: { key: "breakout_forming", label: "Breakout", score: 0.75, side, researchOnly: population === "WATCH", preferredDte: "1-7dte" },
      considered: [{ key: "breakout_forming", label: "Breakout", applicable: true, score: 0.75, matched: [], rejection: null }],
    },
    contract: rejected || !occ ? null : { optionSymbol: occ, side, strike: 140, expiration: "2026-08-21", dte: 2, bid: 1.1, ask: 1.2, spreadPct: 8.7, volume: 10, openInterest: 20, iv: 1, delta: null, gamma: null, theta: null, vega: null, providerTimestamp: T0 - 1_000 },
    callout: { state: rejected ? "REJECTED" : "READY", message: null, reason: rejected ? "fixture rejection" : "ready", freshness: null, entry: null },
    paperEntry: null, state: rejected ? "REJECTED" : "READY", contractFunnel: null,
  };
}

function workerDb() {
  const d = new Database(":memory:");
  ensureEnterpriseSchemaOnDb(d);
  d.exec(`
    CREATE TABLE historical_underlying_bars (symbol TEXT,timeframe TEXT,ts_ms INTEGER,open REAL,high REAL,low REAL,close REAL,source TEXT,quality TEXT);
    CREATE TABLE historical_option_quotes (occ TEXT,ts_ms INTEGER,bid REAL,ask REAL,source TEXT);
  `);
  return d;
}

function persistFixtureEpisode(d, population, candidateId, over = {}) {
  const ep = buildSetupEpisodeV2({ candidate: candidate(over.nowMs ?? T0, over.symbol ?? "MRNA"), result: evaluation({ population, occ: over.occ, side: over.side }), candidateId, env: {} });
  assert.equal(persistSetupEpisodeV2OnDb(d, ep).ok, true);
  appendEpisodeActionOnDb(d, { episodeKey: ep.episodeKey, kind: "OBSERVATION", actionRef: `obs:${candidateId}`, occurredAtMs: ep.t0Ms });
  return ep;
}

function seedPaths(d, occs = [OCC_CALL]) {
  const bars = d.prepare("INSERT INTO historical_underlying_bars VALUES (?,?,?,?,?,?,?,?,?)");
  const quotes = d.prepare("INSERT INTO historical_option_quotes VALUES (?,?,?,?,?)");
  for (let m = 1; m <= 60; m++) {
    bars.run("MRNA", "1m", T0 + m * 60_000, 100, 101, 99, 100.5, "fixture_ohlc", "OK");
    for (const occ of occs) quotes.run(occ, T0 + m * 60_000, 1.2 + m / 100, 1.3 + m / 100, "fixture_nbbo");
  }
}

test("worker keeps ACTIONABLE/WATCH/REJECTED and action populations distinct without fake trades", async () => {
  const d = workerDb();
  const actionable = persistFixtureEpisode(d, "ACTIONABLE", 1, { occ: OCC_CALL });
  const watch = persistFixtureEpisode(d, "WATCH", 2, { occ: OCC_CALL, nowMs: T0 + 1 });
  const rejected = persistFixtureEpisode(d, "REJECTED", 3, { occ: null, nowMs: T0 + 2 });
  appendEpisodeActionOnDb(d, { episodeKey: actionable.episodeKey, kind: "PAPER_TRADE", actionRef: "paper:1", occurredAtMs: T0 });
  appendEpisodeActionOnDb(d, { episodeKey: actionable.episodeKey, kind: "DELIVERED_SUBSCRIBER_TRADE", actionRef: "subscriber:1", occurredAtMs: T0 });
  appendEpisodeActionOnDb(d, { episodeKey: watch.episodeKey, kind: "COUNTERFACTUAL", actionRef: "cf:1", occurredAtMs: T0 + 1, exactOcc: OCC_CALL, entryConvention: FORWARD_ENTRY_CONVENTION, defensibleEntry: true });
  seedPaths(d);
  await runForwardLabelWorkerOnDb(d, { nowMs: T0 + 62 * 60_000, env: {}, config: { batchLimit: 10, evidenceGraceMs: 30_000, maxRunMs: 8_000 } });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM episode_outcome_labels_v2 WHERE episode_key=? AND label_kind='EXACT_OPTION_EXECUTABLE_LABEL'").get(rejected.episodeKey).n, 0, "rejected episode has no fake option label");
  assert.ok(d.prepare("SELECT COUNT(*) n FROM episode_outcome_labels_v2 WHERE episode_key=? AND label_kind='UNDERLYING_LABEL'").get(rejected.episodeKey).n > 0, "rejected episode still learns from underlying evidence");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM episode_actions WHERE episode_key=? AND action_kind='PAPER_TRADE'").get(watch.episodeKey).n, 0, "WATCH learns without fake paper trade");
  assert.deepEqual(new Set(d.prepare("SELECT action_kind FROM episode_actions").all().map((r) => r.action_kind)), new Set(["OBSERVATION", "PAPER_TRADE", "DELIVERED_SUBSCRIBER_TRADE", "COUNTERFACTUAL"]));
});

test("exact OCC cannot cross, same OCC may label independent episodes, and restart is idempotent", async () => {
  const d = workerDb();
  const a = persistFixtureEpisode(d, "ACTIONABLE", 10, { occ: OCC_CALL });
  const b = persistFixtureEpisode(d, "ACTIONABLE", 11, { occ: OCC_CALL, nowMs: T0 + 1 });
  const put = persistFixtureEpisode(d, "ACTIONABLE", 12, { occ: OCC_PUT, side: "put", nowMs: T0 + 2 });
  seedPaths(d, [OCC_CALL]);
  const zoneBefore = d.prepare("SELECT zone_a_json FROM setup_episodes WHERE episode_key=?").get(a.episodeKey).zone_a_json;
  const first = await runForwardLabelWorkerOnDb(d, { nowMs: T0 + 62 * 60_000, env: {}, config: { batchLimit: 10, evidenceGraceMs: 30_000 } });
  const countAfterFirst = d.prepare("SELECT COUNT(*) n FROM episode_outcome_labels_v2").get().n;
  const second = await runForwardLabelWorkerOnDb(d, { nowMs: T0 + 62 * 60_000, env: {}, config: { batchLimit: 10, evidenceGraceMs: 30_000 } });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM episode_outcome_labels_v2").get().n, countAfterFirst, "rerun/restart duplicates nothing");
  assert.equal(second.labelsInserted, 0);
  assert.ok(first.labelsInserted > 0);
  assert.ok(d.prepare("SELECT COUNT(*) n FROM episode_outcome_labels_v2 WHERE episode_key IN (?,?) AND exact_occ=?").get(a.episodeKey, b.episodeKey, OCC_CALL).n >= 2, "same OCC is valid for separate episode identities");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM episode_outcome_labels_v2 WHERE episode_key=? AND label_kind='EXACT_OPTION_EXECUTABLE_LABEL' AND coverage='COMPLETE'").get(put.episodeKey).n, 0, "CALL quotes cannot label the PUT OCC");
  assert.equal(d.prepare("SELECT zone_a_json FROM setup_episodes WHERE episode_key=?").get(a.episodeKey).zone_a_json, zoneBefore, "future outcomes cannot modify Zone A");
});

test("censored labels remain immutable, coverage reconciles, and dataset version is reproducible", async () => {
  const d = workerDb();
  persistFixtureEpisode(d, "WATCH", 20, { occ: OCC_CALL });
  // Sparse evidence forces a canonical censored path.
  d.prepare("INSERT INTO historical_underlying_bars VALUES (?,?,?,?,?,?,?,?,?)").run("MRNA", "1m", T0 + 5 * 60_000, 100, 101, 99, 100, "fixture", "OK");
  d.prepare("INSERT INTO historical_option_quotes VALUES (?,?,?,?,?)").run(OCC_CALL, T0 + 5 * 60_000, 1.3, 1.4, "fixture");
  await runForwardLabelWorkerOnDb(d, { nowMs: T0 + 7 * 60_000, env: {}, config: { batchLimit: 10, evidenceGraceMs: 30_000, maxOptionGapMs: 60_000 } });
  const before = d.prepare("SELECT label_id,coverage,censored,terminal_return_pct FROM episode_outcome_labels_v2 ORDER BY label_id").all();
  assert.ok(before.some((r) => r.censored === 1));
  seedPaths(d);
  await runForwardLabelWorkerOnDb(d, { nowMs: T0 + 7 * 60_000, env: {}, config: { batchLimit: 10, evidenceGraceMs: 30_000 } });
  assert.deepEqual(d.prepare("SELECT label_id,coverage,censored,terminal_return_pct FROM episode_outcome_labels_v2 ORDER BY label_id").all(), before, "late evidence cannot rewrite a censored immutable version");

  const report = buildCoverageReportOnDb(d, "2026-08-19", T0 + 7 * 60_000, cfg, {}, null);
  assert.equal(report.underlying.reconciles, true);
  assert.equal(report.exactOption.reconciles, true);
  assert.equal(Object.values(report.exactOption.buckets).reduce((a, b) => a + b, 0), report.horizonUnits.mature);
  const v1 = buildDatasetVersionOnDb(d, T0 + 7 * 60_000).datasetVersion;
  const v2 = buildDatasetVersionOnDb(d, T0 + 8 * 60_000).datasetVersion;
  assert.equal(v1, v2);
  assert.match(v1, /^fds_[a-f0-9]{24}$/);
});
