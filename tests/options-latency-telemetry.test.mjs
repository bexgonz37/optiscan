import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureEnterpriseSchemaOnDb } from "../lib/db-schema-readiness.ts";
import {
  markOptionsDeliveryDecisionOnDb,
  markOptionsDiscordAcceptedOnDb,
  markOptionsDiscordSendStartedOnDb,
  optionsLatencySummaryOnDb,
  persistOptionsLatencyTraceOnDb,
} from "../lib/research/options/latency-telemetry.ts";

test("actual-stage latency telemetry exposes bounded p50/p95/p99 and quote age", () => {
  const db = new Database(":memory:");
  ensureEnterpriseSchemaOnDb(db);
  const base = Date.UTC(2026, 7, 19, 14, 30);
  for (let i = 1; i <= 20; i += 1) {
    const observation = base + i * 10_000;
    const trace = {
      traceId: `trace-${i}`, symbol: "MRNA", tier: 1,
      observationReceivedAtMs: observation,
      candidateCreatedAtMs: observation + i * 10,
      strategyEvaluationCompletedAtMs: observation + i * 20,
      chainStartedAtMs: observation + i * 12,
      chainCompletedAtMs: observation + i * 17,
      contractSelectedAtMs: observation + i * 20,
      providerQuoteTimestampMs: observation - i * 3,
      providerQuoteAgeMs: i * 3,
    };
    persistOptionsLatencyTraceOnDb(db, trace, "lower_high_continuation", "READY", observation + i * 20);
    const decision = observation + i * 30;
    markOptionsDeliveryDecisionOnDb(db, trace.traceId, decision, "DELIVERED", `a-${i}`);
    markOptionsDiscordSendStartedOnDb(db, trace.traceId, decision + i * 2);
    markOptionsDiscordAcceptedOnDb(db, trace.traceId, decision + i * 4, `a-${i}`);
  }
  const summary = optionsLatencySummaryOnDb(db, base + 1_000_000);
  assert.equal(summary.available, true);
  assert.equal(summary.bounded, true);
  assert.deepEqual(summary.observationToCandidate, { n: 20, p50: 100, p95: 190, p99: 200 });
  assert.deepEqual(summary.candidateToDecision, { n: 20, p50: 200, p95: 380, p99: 400 });
  assert.deepEqual(summary.decisionToDiscord, { n: 20, p50: 40, p95: 76, p99: 80 });
  assert.deepEqual(summary.chainProvider, { n: 20, p50: 50, p95: 95, p99: 100 });
  assert.deepEqual(summary.providerQuoteAge, { n: 20, p50: 30, p95: 57, p99: 60 });
  assert.equal(summary.slosMs.totalObservationToDiscord.p99, 7000);
  db.close();
});

test("missing latency schema fails loudly instead of reporting zero traces", () => {
  const db = new Database(":memory:");
  assert.throws(() => optionsLatencySummaryOnDb(db), /options_live_latency_traces/);
  db.close();
});
