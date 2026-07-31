/**
 * tests/high-asymmetry-capture-telemetry.test.mjs
 *
 * Observability for the capture edge.
 *
 * The defect being fixed: the live loop discarded the capture result, so a
 * radar being called and refusing everything was indistinguishable from one
 * never called at all. Production showed zero cases with a healthy monitor and
 * 522 chains fetched, and nothing could tell those apart.
 *
 * These tests prove the four causes are separately countable, and — just as
 * importantly — that the telemetry cannot influence the scanner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  CAPTURE_STAGES, MAX_RECENT_SAMPLES, ensureCaptureTelemetrySchema,
  recordCaptureStageOnDb, recordCaptureRejectionsOnDb, recordCaptureSampleOnDb,
  readCaptureTelemetryOnDb, classifyCause,
} from "../lib/research/asymmetry/capture-telemetry.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const SESSION = "2026-07-31";
const T0 = Date.parse("2026-07-31T14:00:00.000Z");

const db = () => { const d = new Database(":memory:"); ensureCaptureTelemetrySchema(d); return d; };

// ── The four causes are separately countable ────────────────────────────────

test("A: no contract selected is counted distinctly from capture being called", () => {
  const d = db();
  for (let i = 0; i < 5; i += 1) {
    recordCaptureStageOnDb(d, SESSION, "LOOP_REACHED", T0 + i);
    recordCaptureStageOnDb(d, SESSION, "NO_CONTRACT_SELECTED", T0 + i);
  }
  const t = readCaptureTelemetryOnDb(d, SESSION);
  assert.equal(t.counters.LOOP_REACHED, 5);
  assert.equal(t.counters.NO_CONTRACT_SELECTED, 5);
  assert.equal(t.counters.CAPTURE_CALLED, 0);
  assert.match(t.dominantCause, /^A_NO_CONTRACT_SELECTED/);
  d.close();
});

test("B: capture never called is distinguishable from every other cause", () => {
  const d = db();
  const t = readCaptureTelemetryOnDb(d, SESSION);
  assert.match(t.dominantCause, /NO_TELEMETRY_RECORDED_YET/);
  recordCaptureStageOnDb(d, SESSION, "LOOP_REACHED", T0);
  assert.match(readCaptureTelemetryOnDb(d, SESSION).dominantCause, /^B_CAPTURE_NEVER_CALLED/);
  d.close();
});

test("C: called and rejected reports the DOMINANT blocker by name", () => {
  const d = db();
  recordCaptureStageOnDb(d, SESSION, "LOOP_REACHED", T0);
  for (let i = 0; i < 9; i += 1) {
    recordCaptureStageOnDb(d, SESSION, "CAPTURE_CALLED", T0 + i);
    recordCaptureStageOnDb(d, SESSION, "CAPTURE_BLOCKED", T0 + i);
  }
  recordCaptureRejectionsOnDb(d, SESSION, ["UNUSABLE_SPREAD"], T0);
  recordCaptureRejectionsOnDb(d, SESSION, ["UNUSABLE_SPREAD"], T0 + 1);
  recordCaptureRejectionsOnDb(d, SESSION, ["STALE_QUOTE"], T0 + 2);
  const t = readCaptureTelemetryOnDb(d, SESSION);
  assert.match(t.dominantCause, /^C_CALLED_AND_REJECTED: dominant blocker UNUSABLE_SPREAD \(2\)/);
  assert.equal(t.rejections[0].reason, "UNUSABLE_SPREAD");
  assert.equal(t.rejections[0].count, 2);
  d.close();
});

test("D: persistence failure is distinct from an intake rejection", () => {
  const d = db();
  recordCaptureStageOnDb(d, SESSION, "LOOP_REACHED", T0);
  recordCaptureStageOnDb(d, SESSION, "CAPTURE_CALLED", T0);
  recordCaptureStageOnDb(d, SESSION, "CAPTURE_PERSIST_FAILED", T0);
  const t = readCaptureTelemetryOnDb(d, SESSION);
  assert.match(t.dominantCause, /^D_PERSIST_FAILED/);
  assert.notEqual(t.counters.CAPTURE_PERSIST_FAILED, t.counters.CAPTURE_BLOCKED);
  d.close();
});

test("a disabled capture flag is named rather than reported as a rejection", () => {
  const d = db();
  recordCaptureStageOnDb(d, SESSION, "LOOP_REACHED", T0);
  recordCaptureStageOnDb(d, SESSION, "CAPTURE_CALLED", T0);
  recordCaptureStageOnDb(d, SESSION, "CAPTURE_DISABLED", T0);
  assert.match(readCaptureTelemetryOnDb(d, SESSION).dominantCause, /^CAPTURE_DISABLED/);
  d.close();
});

test("a healthy radar reports that it is capturing", () => {
  const d = db();
  recordCaptureStageOnDb(d, SESSION, "LOOP_REACHED", T0);
  recordCaptureStageOnDb(d, SESSION, "CAPTURE_CALLED", T0);
  recordCaptureStageOnDb(d, SESSION, "CAPTURE_ACCEPTED", T0);
  assert.match(readCaptureTelemetryOnDb(d, SESSION).dominantCause, /^CAPTURING/);
  d.close();
});

test("the most UPSTREAM cause wins, so nobody is sent to the wrong place", () => {
  // Loop never reached, yet stale downstream rejections exist. Reporting the
  // rejections as the cause would point at intake rules that never ran.
  const cause = classifyCause(
    { LOOP_REACHED: 0, CAPTURE_CALLED: 0, CAPTURE_BLOCKED: 40 },
    [{ reason: "UNUSABLE_SPREAD", count: 40 }],
  );
  assert.match(cause, /^B_CAPTURE_NEVER_CALLED/);
});

// ── Recording behaviour ─────────────────────────────────────────────────────

test("every blocker on a candidate is counted, not just the first", () => {
  const d = db();
  recordCaptureRejectionsOnDb(d, SESSION, ["NO_EXECUTABLE_QUOTE", "UNUSABLE_SPREAD", "WRONG_SESSION"], T0);
  const t = readCaptureTelemetryOnDb(d, SESSION);
  assert.equal(t.rejections.length, 3, "a candidate blocked by three things is three facts");
  d.close();
});

test("recent samples are bounded and keep the newest", () => {
  const d = db();
  for (let i = 0; i < MAX_RECENT_SAMPLES + 25; i += 1) {
    recordCaptureSampleOnDb(d, {
      sessionDate: SESSION, observedAtMs: T0 + i, stage: "CAPTURE_BLOCKED",
      symbol: `SYM${i}`, optionSymbol: null, reason: "r", blockedBy: ["X"], labels: [],
    });
  }
  const t = readCaptureTelemetryOnDb(d, SESSION);
  assert.equal(t.recentSamples.length, MAX_RECENT_SAMPLES, "the window must be bounded");
  assert.equal(t.recentSamples[0].symbol, `SYM${MAX_RECENT_SAMPLES + 24}`, "newest first");
  const rows = d.prepare("SELECT COUNT(*) n FROM asymmetry_capture_samples").get().n;
  assert.equal(rows, MAX_RECENT_SAMPLES, "old rows are pruned, not merely hidden");
  d.close();
});

test("a sample ties a reason to an actual symbol and contract", () => {
  const d = db();
  recordCaptureSampleOnDb(d, {
    sessionDate: SESSION, observedAtMs: T0, stage: "CAPTURE_BLOCKED",
    symbol: "AAPL", optionSymbol: "O:AAPL260807P00200000",
    reason: "UNUSABLE_SPREAD", blockedBy: ["UNUSABLE_SPREAD"], labels: ["spreadPct"],
  });
  const [s] = readCaptureTelemetryOnDb(d, SESSION).recentSamples;
  assert.equal(s.symbol, "AAPL");
  assert.equal(s.optionSymbol, "O:AAPL260807P00200000");
  assert.deepEqual(s.blockedBy, ["UNUSABLE_SPREAD"]);
  d.close();
});

test("counters are never fabricated — an absent stage reads zero, not invented", () => {
  const d = db();
  recordCaptureStageOnDb(d, SESSION, "LOOP_REACHED", T0);
  const t = readCaptureTelemetryOnDb(d, SESSION);
  for (const stage of CAPTURE_STAGES) {
    assert.equal(typeof t.counters[stage], "number", `${stage} must always be present`);
  }
  assert.equal(t.counters.CAPTURE_ACCEPTED, 0);
  assert.equal(readCaptureTelemetryOnDb(d, "1999-01-01").counters.LOOP_REACHED, 0, "another session reads zero");
  d.close();
});

// ── Containment ─────────────────────────────────────────────────────────────

test("TELEMETRY CANNOT BLOCK THE SCANNER — every writer swallows a dead database", () => {
  const broken = { prepare() { throw new Error("db gone"); }, exec() { throw new Error("db gone"); } };
  assert.doesNotThrow(() => recordCaptureStageOnDb(broken, SESSION, "LOOP_REACHED", T0));
  assert.doesNotThrow(() => recordCaptureRejectionsOnDb(broken, SESSION, ["X"], T0));
  assert.doesNotThrow(() => recordCaptureSampleOnDb(broken, {
    sessionDate: SESSION, observedAtMs: T0, stage: "CAPTURE_BLOCKED",
    symbol: "A", optionSymbol: null, reason: null,
  }));
  const t = readCaptureTelemetryOnDb(broken, SESSION);
  assert.equal(t.dominantCause, "NO_TELEMETRY_RECORDED_YET", "an unreadable ledger is not a crash");
});

test("the loop records telemetry but the scanner never depends on it", () => {
  const src = readFileSync("lib/research/options/loop.ts", "utf8");
  assert.match(src, /recordCaptureStageOnDb/, "the loop must record");
  assert.match(src, /asymResult/, "and capture the result to count it");
  // The invariant is not "no branch at all" — deciding WHETHER to record a
  // rejection is legitimately a branch. It is that the result never escapes
  // into the scanner's own control flow or return value.
  assert.equal(/return[^;\n]*asymResult/.test(src), false, "the result must not be returned");
  assert.equal(/\bres\s*\.\s*\w+\s*=\s*asymResult/.test(src), false, "it must not be written back onto the scanner result");
  for (const line of src.split("\n").filter((l) => l.includes("asymResult"))) {
    assert.ok(
      /recordCapture|const asymResult|const asymStage|asymResult\.(outcome|blockedBy|reason|optionSymbol|labels)/.test(line),
      `asymResult may only feed telemetry, but appears in: ${line.trim()}`,
    );
  }
});

test("telemetry loosens no intake rule", () => {
  // Strip comments: the module DESCRIBES admission outcomes in prose, and a
  // bare word match would flag the explanation rather than any logic.
  const src = readFileSync("lib/research/asymmetry/capture-telemetry.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.equal(/decideLiveIntake|MAX_SPREAD|maxSpread|threshold/i.test(src), false,
    "the telemetry module must contain no admission logic");
  assert.equal(/from\s+["'].*\/ai\//.test(src), false, "no AI");
  assert.equal(/\bfetch\s*\(/.test(src), false, "no network");
});

test("the migration is additive and repeat-safe", () => {
  const d = new Database(":memory:");
  for (let i = 0; i < 4; i += 1) ensureCaptureTelemetrySchema(d);
  for (const t of ["asymmetry_capture_counters", "asymmetry_capture_rejections", "asymmetry_capture_samples"]) {
    assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), `${t} must exist`);
  }
  const src = readFileSync("lib/research/asymmetry/capture-telemetry.ts", "utf8");
  assert.equal(/DROP\s+TABLE|ALTER\s+TABLE/i.test(src), false, "no destructive DDL");
  d.close();
});
