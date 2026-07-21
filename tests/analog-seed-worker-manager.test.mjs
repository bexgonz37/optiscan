import test from "node:test";
import assert from "node:assert/strict";
import { nodeSupportsStripTypes, seedWorkerSpawnDecision, ensureSeedWorker } from "../lib/research/episode/seed-worker-manager.ts";

const ENABLED_FLAGS = { HISTORICAL_REPLAY_ENABLED: "1", EPISODE_CAPTURE_ENABLED: "1" };

test("nodeSupportsStripTypes gates on >= 22.6", () => {
  assert.equal(nodeSupportsStripTypes("22.6.0"), true);
  assert.equal(nodeSupportsStripTypes("22.23.1"), true);
  assert.equal(nodeSupportsStripTypes("24.0.0"), true);
  assert.equal(nodeSupportsStripTypes("22.5.9"), false);
  assert.equal(nodeSupportsStripTypes("20.10.0"), false);
});

test("default (no OPTISCAN_ENABLE_SEED_WORKER) never spawns — the web stays healthy", () => {
  const d = seedWorkerSpawnDecision({ ...ENABLED_FLAGS }, { workerFileExists: true, nodeVersion: "22.23.1" });
  assert.equal(d.spawn, false);
  assert.match(d.reason, /OPTISCAN_ENABLE_SEED_WORKER/);
});

test("the seed-worker child never spawns another worker (no recursion)", () => {
  const d = seedWorkerSpawnDecision({ ...ENABLED_FLAGS, OPTISCAN_ENABLE_SEED_WORKER: "1", OPTISCAN_PROCESS_ROLE: "seed-worker" }, { workerFileExists: true, nodeVersion: "22.23.1" });
  assert.equal(d.spawn, false);
  assert.match(d.reason, /no recursion/i);
});

test("enabled but replay flags off → no spawn", () => {
  const d = seedWorkerSpawnDecision({ OPTISCAN_ENABLE_SEED_WORKER: "1" }, { workerFileExists: true, nodeVersion: "22.23.1" });
  assert.equal(d.spawn, false);
  assert.match(d.reason, /flags off/);
});

test("enabled + flags on but worker file missing (standalone prune) → no spawn, no crash", () => {
  const d = seedWorkerSpawnDecision({ ...ENABLED_FLAGS, OPTISCAN_ENABLE_SEED_WORKER: "1" }, { workerFileExists: false, nodeVersion: "22.23.1" });
  assert.equal(d.spawn, false);
  assert.match(d.reason, /not found/);
});

test("enabled + flags on + file present but old Node → no spawn", () => {
  const d = seedWorkerSpawnDecision({ ...ENABLED_FLAGS, OPTISCAN_ENABLE_SEED_WORKER: "1" }, { workerFileExists: true, nodeVersion: "20.10.0" });
  assert.equal(d.spawn, false);
  assert.match(d.reason, /experimental-strip-types/);
});

test("all conditions satisfied → spawn", () => {
  const d = seedWorkerSpawnDecision({ ...ENABLED_FLAGS, OPTISCAN_ENABLE_SEED_WORKER: "1" }, { workerFileExists: true, nodeVersion: "22.23.1" });
  assert.equal(d.spawn, true);
});

test("ensureSeedWorker with the worker disabled is a safe no-op (never throws, never spawns)", () => {
  const res = ensureSeedWorker({ ...ENABLED_FLAGS }); // enable flag intentionally absent
  assert.equal(res.spawned, false);
  assert.match(res.reason, /OPTISCAN_ENABLE_SEED_WORKER/);
});
