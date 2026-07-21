import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { bucketStats, calibrationByConfidence, maxDrawdown, winRate } from "../lib/research/forward/aggregate.ts";
import { buildForwardReport } from "../lib/research/forward/report.ts";
import { computeLatencyMetrics } from "../lib/research/forward/latency.ts";
import { readForwardReportOnDb } from "../lib/research/forward/read.ts";

const emptyLatency = computeLatencyMetrics([]);

test("aggregate stats: winRate, drawdown, buckets, calibration", () => {
  const items = [
    { bucketKey: "bullish_call_short", confidence: 0.8, returnPct: 5, win: true, capturedAtMs: 1 },
    { bucketKey: "bullish_call_short", confidence: 0.8, returnPct: -3, win: false, capturedAtMs: 2 },
    { bucketKey: "bullish_call_0dte", confidence: 0.55, returnPct: 2, win: true, capturedAtMs: 3 },
  ];
  assert.equal(winRate(items), 0.6667);
  assert.ok(maxDrawdown(items) <= 0);
  const bs = bucketStats(items);
  assert.equal(bs.find((b) => b.bucketKey === "bullish_call_short").n, 2);
  const cal = calibrationByConfidence(items);
  assert.ok(cal.brier != null && cal.ece != null);
});

test("buildForwardReport is COLLECTING_DATA on a thin sample and lists missing evidence", () => {
  const rep = buildForwardReport({ graded: [], primaryHorizon: "1d", latency: emptyLatency, backtest: null, discord: { delivered: 0, failed: 0, retried: 0, duplicateSuppressed: 0 }, outages: { providerOutages: 0, discordOutages: 0, lastOutageMs: null } });
  assert.equal(rep.status, "COLLECTING_DATA");
  assert.equal(rep.forwardSampleSize, 0);
  assert.ok(rep.missingEvidence.some((m) => /forward sample/.test(m)));
  assert.ok(rep.missingEvidence.some((m) => /p95/.test(m)));
  assert.ok(rep.missingEvidence.some((m) => /commercial-readiness/.test(m)));
  assert.match(rep.disclaimer, /No real-money execution/);
  // latency targets are never reported as met without a production sample
  assert.equal(rep.latencyTargets.p95Met, null);
});

test("latency targets are only 'met' with a real sample under the threshold", () => {
  const fast = computeLatencyMetrics(Array.from({ length: 5 }, () => ({ latency: { market_data_received: 0, trigger_detected: 100, early_watch_queued: 900, analog_lookup_start: 1000 }, state: "CONFIRMED" })));
  const rep = buildForwardReport({ graded: [], primaryHorizon: "1d", latency: fast, backtest: null, discord: { delivered: 10, failed: 0, retried: 0, duplicateSuppressed: 0 }, outages: { providerOutages: 0, discordOutages: 0, lastOutageMs: null }, minLatencySample: 3, targets: { earlyWatchP50Ms: 3000, earlyWatchP95Ms: 8000 } });
  assert.equal(rep.latencyTargets.p50Met, true);
  assert.equal(rep.latencyTargets.p95Met, true);
  assert.equal(rep.latencyTargets.heavyWorkOffCriticalPath, true, "analog started after early-watch");
  // still COLLECTING_DATA because the forward sample is empty
  assert.equal(rep.status, "COLLECTING_DATA");
});

test("readForwardReportOnDb assembles from the DB (read-only)", () => {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE forward_recommendations (rec_id TEXT PRIMARY KEY, strategy_key TEXT, confidence REAL, captured_at_ms INTEGER);
    CREATE TABLE forward_outcomes (rec_id TEXT, horizon TEXT, return_pct REAL, win INTEGER);
    CREATE TABLE two_speed_alerts (state TEXT, latency_json TEXT, discord_failures INTEGER, discord_retries INTEGER, late_entry INTEGER, discord_message_id TEXT);`);
  d.prepare("INSERT INTO forward_recommendations VALUES (?,?,?,?)").run("r1", "bullish_call_short", 0.7, 1);
  d.prepare("INSERT INTO forward_outcomes VALUES (?,?,?,?)").run("r1", "1d", 4.2, 1);
  d.prepare("INSERT INTO two_speed_alerts VALUES (?,?,?,?,?,?)").run("EARLY_WATCH", JSON.stringify({ market_data_received: 0, trigger_detected: 80, early_watch_queued: 700 }), 0, 0, 0, "msg1");
  const rep = readForwardReportOnDb(d, { primaryHorizon: "1d" });
  assert.equal(rep.forwardSampleSize, 1);
  assert.equal(rep.byStrategy[0].bucketKey, "bullish_call_short");
  assert.equal(rep.latency.total, 1);
  assert.equal(rep.discord.delivered, 1);
  assert.equal(rep.status, "COLLECTING_DATA"); // 1 sample is far below the threshold
});
