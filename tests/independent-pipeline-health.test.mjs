import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndependentPipelineHealth } from "../lib/research/options/independent-pipeline-health.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-07-27T17:00:00.000Z");

const base = {
  nowMs: NOW,
  discoveryEnabled: true,
  killSwitch: false,
  ownership: "independent",
  independentOwns: true,
  localRunning: false,
  localAlive: false,
  localLastTier0CycleMs: null,
  localLastTier1CycleMs: null,
  localLastTier2CycleMs: null,
  localBreaker: "closed",
  localUnhealthyReason: null,
  portfolioHealthy: true,
  heartbeat: null,
  heartbeatAgeMs: null,
  heartbeatFresh: false,
  sessionGuardState: "REGULAR_SESSION",
  sessionGuardReason: "Regular session",
  polygonEnvConfigured: true,
  selfCheckPolygonOk: true,
  webhookConfigured: true,
  recentSentCount24h: 2,
};

test("web process with fresh worker heartbeat reports RUNNING_IN_WORKER, not stopped", () => {
  const health = buildIndependentPipelineHealth({
    ...base,
    localRunning: false,
    localAlive: false,
    heartbeat: {
      session: "regular",
      running: true,
      breaker: "closed",
      lastTier1CycleMs: NOW - 5_000,
      lastTier2CycleMs: NOW - 8_000,
      providerFailures: 0,
      at: NOW - 4_000,
    },
    heartbeatAgeMs: 4_000,
    heartbeatFresh: true,
  });
  assert.equal(health.runMode, "RUNNING_IN_WORKER");
  assert.equal(health.monitorAlive, true);
  assert.equal(health.monitorRunning, true);
  assert.match(health.labels.monitor, /worker process/i);
  assert.equal(health.labels.processNote, "Web process does not host the scanner");
  assert.equal(health.session, "REGULAR_SESSION");
  assert.match(health.labels.session, /REGULAR_SESSION/);
  assert.equal(health.polygonConfigured, true);
  assert.equal(health.polygonHealthy, true);
  assert.match(health.labels.polygon, /configured and healthy/i);
  assert.equal(health.sources.monitor, "Database heartbeat");
  assert.equal(health.sources.session, "Session guard");
  assert.doesNotMatch(health.labels.monitor, /not running/i);
});

test("fresh local monitor reports RUNNING_IN_THIS_PROCESS", () => {
  const health = buildIndependentPipelineHealth({
    ...base,
    localRunning: true,
    localAlive: true,
    localLastTier0CycleMs: NOW - 1_000,
    localLastTier1CycleMs: NOW - 2_000,
    heartbeatFresh: false,
    heartbeat: null,
  });
  assert.equal(health.runMode, "RUNNING_IN_THIS_PROCESS");
  assert.equal(health.localProcessHostsMonitor, true);
  assert.match(health.labels.monitor, /this process/i);
  assert.equal(health.labels.processNote, null);
});

test("stale heartbeat with no local loop is NOT_RUNNING or UNKNOWN — never claims worker alive", () => {
  const health = buildIndependentPipelineHealth({
    ...base,
    recentSentCount24h: 0,
    heartbeat: { running: false, breaker: "closed", at: NOW - 600_000 },
    heartbeatAgeMs: 600_000,
    heartbeatFresh: false,
  });
  assert.ok(health.runMode === "NOT_RUNNING" || health.runMode === "UNKNOWN");
  assert.equal(health.monitorAlive, false);
});

test("recent independent sends without local monitor still avoid false stopped when heartbeat missing", () => {
  const health = buildIndependentPipelineHealth({
    ...base,
    heartbeat: null,
    heartbeatFresh: false,
    recentSentCount24h: 2,
  });
  assert.equal(health.runMode, "RUNNING_IN_WORKER");
  assert.equal(health.monitorAlive, true);
  assert.doesNotMatch(health.labels.monitor, /not running/i);
});

test("Command Center no longer warns that the monitor is stopped merely because web process is idle", () => {
  const cc = readFileSync(join(root, "components/CommandCenter.tsx"), "utf8");
  assert.ok(!/not running in this process/.test(cc), "must not use the old false-warning copy");
  assert.ok(/RUNNING_IN_WORKER/.test(cc), "must understand worker run mode");
  assert.ok(/labels\?\.monitor|labels\.monitor/.test(cc), "must prefer API monitor labels over local process inference");
  assert.ok(/cc-attention-source/.test(cc), "must render health source labels");
  assert.ok(/processNote/.test(cc), "must surface web-does-not-host-scanner note as informational");
});
