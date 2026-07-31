/**
 * tests/high-asymmetry-runtime-edge.test.mjs — proves the radar has a REAL
 * runtime edge from the live options loop, not merely a module that exists.
 *
 * This suite exists because the previous state of this branch was a set of
 * well-tested modules that nothing called. The assertions below fail if that
 * regresses: if the call site is removed, if the module becomes test-only, or
 * if a table gains a writer with no reader.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { captureAsymmetryCandidate, initialStateFor, CAPTURE_ENABLED_ENV } from "../lib/research/asymmetry/capture.ts";
import {
  ensureAsymmetrySchema, openAsymmetryCaseOnDb, hasActiveAsymmetryCase,
  recordTransitionOnDb, attachNormalQualificationOnDb, listCasesOnDb, lastStateOnDb,
} from "../lib/research/asymmetry/case-store.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const OBSERVED = Date.parse("2026-07-30T14:00:00.000Z"); // 10:00 ET
const OCC = "O:NVDA260807C00200000";
const ON = { [CAPTURE_ENABLED_ENV]: "1" };

const db = () => new Database(":memory:");

const candidate = (over = {}) => ({
  symbol: "NVDA", direction: "CALL", optionSymbol: OCC,
  underlying: "NVDA", expiration: "2026-08-07", strike: 200, right: "C",
  observedAtMs: OBSERVED, sessionDate: "2026-07-30", fingerprint: `2026-07-30|${OCC}`,
  bid: 2.00, ask: 2.10, quoteAtMs: OBSERVED - 1000, quoteAgeMs: 1000,
  optionVolume: 500, openInterest: 4000, impliedVolatility: 0.42, delta: 0.35, gamma: 0.02,
  underlyingPrice: 198.5, vwap: 197.0, stockVolume: 1e6, relativeVolume: 1.8,
  volumeAcceleration: 1.2, priorMovePct: 1.1, compressionState: "COMPRESSED",
  distanceToTriggerPct: 0.7, roomToNextLevelPct: 2.4,
  marketAlignment: "ALIGNED", sectorAlignment: "ALIGNED",
  catalyst: { label: "Confirmed launch", source: "company release" },
  setupFamily: "breakout_continuation", scannerVersion: "test",
  invalidated: false, nowMs: OBSERVED + 5000,
  ...over,
});

// ── THE EDGE: the live loop actually calls the radar ─────────────────────────

test("the real options loop imports and calls the radar capture entrypoint", () => {
  const loop = readFileSync("lib/research/options/loop.ts", "utf8");
  assert.match(loop, /import \{ captureAsymmetryCandidate \} from "\.\.\/asymmetry\/capture\.ts"/,
    "the live loop must import the capture entrypoint");
  const code = loop.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(code, /captureAsymmetryCandidate\(/, "the live loop must CALL it, not merely import it");

  // It must sit after exact-OCC selection and before subscriber qualification
  // finishes — i.e. inside the contract branch, alongside the existing capture.
  const callIdx = code.indexOf("captureAsymmetryCandidate(");
  const occIdx = code.indexOf("res.contract.optionSymbol");
  assert.ok(occIdx >= 0 && occIdx < callIdx, "the exact OCC must already be known at the call site");
});

test("the radar module is NOT imported only by tests and diagnostics", () => {
  // The acceptance gate: a production module reachable only from tests fails.
  const loop = readFileSync("lib/research/options/loop.ts", "utf8");
  assert.ok(loop.includes("asymmetry/capture.ts"), "a PRODUCTION file must import the radar");
});

// ── The edge cannot affect subscriber SEND ───────────────────────────────────

test("the capture result carries nothing the loop can act on", () => {
  const d = db();
  const r = captureAsymmetryCandidate(d, candidate(), ON);
  assert.equal(r.subscriberSendCreated, false);
  // No field could be branched on to change a send decision.
  for (const forbidden of ["send", "deliver", "approved", "shouldSend", "allow", "sendNow"]) {
    assert.equal(forbidden in r, false, `result must not expose ${forbidden}`);
  }
  d.close();
});

test("the call site cannot let the capture result influence the loop", () => {
  const code = readFileSync("lib/research/options/loop.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // This assertion used to be "the result is never assigned to a variable",
  // which was a PROXY for the real property. The result is now assigned — but
  // only so its outcome can be COUNTED, because discarding it entirely made a
  // radar that refuses everything indistinguishable from one never called.
  // The real invariant is asserted directly instead, and it is stricter.

  // 1. Capture is still invoked unconditionally, never inside a guard that
  //    could skip it based on scanner state.
  assert.equal(/if\s*\([^)]*\)\s*\{?\s*(?:const\s+\w+\s*=\s*)?captureAsymmetryCandidate/.test(code), false,
    "capture must not be conditional on scanner state");

  // 2. The result never reaches the loop's own output or control flow.
  assert.equal(/return[^;\n]*captureAsymmetryCandidate/.test(code), false, "the result must not be returned directly");
  assert.equal(/return[^;\n]*asymResult/.test(code), false, "and must not be returned via its variable");
  assert.equal(/\bres\s*\.\s*\w+\s*=\s*asymResult/.test(code), false, "and must not be written onto the scanner result");

  // 3. Every use of it is a telemetry call. Nothing else may read it.
  for (const line of code.split("\n").filter((l) => l.includes("asymResult"))) {
    assert.ok(
      /recordCapture|const asymResult|const asymStage|asymResult\.(outcome|blockedBy|reason|optionSymbol|labels)/.test(line),
      `asymResult may only feed telemetry, but appears in: ${line.trim()}`,
    );
  }
});

// ── Failure isolation ───────────────────────────────────────────────────────

test("capture never throws, whatever the database does", () => {
  const exploding = {
    exec() { throw new Error("disk full"); },
    prepare() { throw new Error("disk full"); },
  };
  const r = captureAsymmetryCandidate(exploding, candidate(), ON);
  assert.ok(["ERROR", "PERSIST_FAILED"].includes(r.outcome), `contained, got ${r.outcome}`);
  assert.equal(r.subscriberSendCreated, false);
});

test("capture never throws on malformed input", () => {
  const d = db();
  for (const bad of [{}, { fingerprint: null }, { observedAtMs: NaN }, { ask: "x" }]) {
    const r = captureAsymmetryCandidate(d, { ...candidate(), ...bad }, ON);
    assert.ok(typeof r.outcome === "string", "must always return a result");
  }
  d.close();
});

// ── Off by default ──────────────────────────────────────────────────────────

test("without the capture flag it does no database work at all", () => {
  let touched = false;
  const spy = { exec() { touched = true; }, prepare() { touched = true; return { get: () => null, all: () => [], run: () => ({}) }; } };
  const r = captureAsymmetryCandidate(spy, candidate(), {});
  assert.equal(r.outcome, "DISABLED");
  assert.match(r.reason, new RegExp(CAPTURE_ENABLED_ENV));
  assert.equal(touched, false, "a disabled radar must not touch the database");
});

// ── Persistence: writer AND reader, repeat-safe ──────────────────────────────

test("a captured candidate becomes a durable case that the read path returns", () => {
  const d = db();
  const r = captureAsymmetryCandidate(d, candidate(), ON);
  assert.equal(r.outcome, "CAPTURED");

  // Writer has a reader — the acceptance gate requires both.
  const cases = listCasesOnDb(d, "2026-07-30");
  assert.equal(cases.length, 1);
  assert.equal(cases[0].optionSymbol, OCC);
  assert.equal(cases[0].earlyAsk, 2.10, "the conservative ask entry is recorded");
  assert.equal(lastStateOnDb(d, "2026-07-30", `2026-07-30|${OCC}`), r.state);
  d.close();
});

test("one active case per fingerprint, enforced by the primary key", () => {
  const d = db();
  assert.equal(captureAsymmetryCandidate(d, candidate(), ON).outcome, "CAPTURED");
  // Second and third attempts must not create another case.
  assert.equal(captureAsymmetryCandidate(d, candidate(), ON).outcome, "DUPLICATE");
  assert.equal(captureAsymmetryCandidate(d, candidate({ ask: 9.99 }), ON).outcome, "DUPLICATE");
  assert.equal(listCasesOnDb(d, "2026-07-30").length, 1);
  // The FIRST detection wins — an early ask is never overwritten by a later one.
  assert.equal(listCasesOnDb(d, "2026-07-30")[0].earlyAsk, 2.10);
  d.close();
});

test("the schema migration is additive and repeat-safe", () => {
  const d = db();
  ensureAsymmetrySchema(d);
  ensureAsymmetrySchema(d);
  ensureAsymmetrySchema(d);
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'asymmetry%'").all().map((r) => r.name).sort();
  assert.deepEqual(tables, ["asymmetry_cases", "asymmetry_daily_reviews", "asymmetry_marks", "asymmetry_outcomes", "asymmetry_transitions"]);
  // No destructive DDL anywhere in the store.
  const src = readFileSync("lib/research/asymmetry/case-store.ts", "utf8");
  assert.equal(/DROP TABLE|DROP INDEX|ALTER TABLE .* DROP|DELETE FROM/i.test(src), false, "no destructive DDL");
  d.close();
});

test("blocked candidates are not persisted", () => {
  const d = db();
  const r = captureAsymmetryCandidate(d, candidate({ optionSymbol: null }), ON);
  assert.equal(r.outcome, "BLOCKED");
  assert.ok(r.blockedBy.includes("NO_EXACT_OCC"));
  ensureAsymmetrySchema(d);
  assert.equal(listCasesOnDb(d, "2026-07-30").length, 0, "an unusable observation must not create a case");
  d.close();
});

// ── Transitions and lead time ───────────────────────────────────────────────

test("transitions persist, update the case state, and are repeat-safe", () => {
  const d = db();
  captureAsymmetryCandidate(d, candidate(), ON);
  const fp = `2026-07-30|${OCC}`;
  const args = { sessionDate: "2026-07-30", fingerprint: fp, fromState: "EARLY_ASYMMETRY", toState: "HIGH_ASYMMETRY", occurredAtMs: OBSERVED + 60_000, reason: "confirmed", notified: false, notifyOutcome: "DISABLED" };
  assert.equal(recordTransitionOnDb(d, args).created, true);
  assert.equal(recordTransitionOnDb(d, args).created, false, "a replayed transition is a no-op");
  assert.equal(lastStateOnDb(d, "2026-07-30", fp), "HIGH_ASYMMETRY");
  assert.equal(d.prepare("SELECT COUNT(*) c FROM asymmetry_transitions").get().c, 1);
  d.close();
});

test("lead time and premium avoided are computed only when the normal pipeline qualifies", () => {
  const d = db();
  captureAsymmetryCandidate(d, candidate(), ON);
  // Before qualification both are unknown — NOT zero.
  let c = listCasesOnDb(d, "2026-07-30")[0];
  assert.equal(c.leadMs, null, "no subscriber alert means unknown lead, not zero");
  assert.equal(c.premiumAvoidedPct, null);

  attachNormalQualificationOnDb(d, { sessionDate: "2026-07-30", optionSymbol: OCC, qualifiedAtMs: OBSERVED + 180_000, ask: 2.73 });
  c = listCasesOnDb(d, "2026-07-30")[0];
  assert.equal(c.leadMs, 180_000, "radar saw it 3 minutes earlier");
  assert.ok(Math.abs(c.premiumAvoidedPct - 30) < 0.01, `expected ~30%, got ${c.premiumAvoidedPct}`);

  // Idempotent: the FIRST qualification wins.
  attachNormalQualificationOnDb(d, { sessionDate: "2026-07-30", optionSymbol: OCC, qualifiedAtMs: OBSERVED + 600_000, ask: 5.0 });
  assert.equal(listCasesOnDb(d, "2026-07-30")[0].leadMs, 180_000, "a later qualification must not overwrite");
  d.close();
});

// ── Deterministic state, no AI ──────────────────────────────────────────────

test("the initial state is deterministic from evidence coverage alone", () => {
  assert.equal(initialStateFor(0), "HIGH_ASYMMETRY");
  assert.equal(initialStateFor(2), "CONFIRMING");
  assert.equal(initialStateFor(6), "EARLY_ASYMMETRY");
  assert.equal(initialStateFor(12), "INSUFFICIENT_EVIDENCE");
  // Same input, same answer, every time.
  for (let i = 0; i < 14; i++) assert.equal(initialStateFor(i), initialStateFor(i));
});

test("incomplete evidence is disclosed and still captured, not rejected", () => {
  const d = db();
  const r = captureAsymmetryCandidate(d, candidate({
    impliedVolatility: null, delta: null, gamma: null, catalyst: null,
    marketAlignment: null, sectorAlignment: null, relativeVolume: null,
  }), ON);
  assert.equal(r.outcome, "CAPTURED", "sparse evidence must not block an early observation");
  assert.ok(r.labels.includes("NO_CATALYST"));
  assert.ok(r.labels.includes("NO_IMPLIED_VOLATILITY"));
  assert.equal(listCasesOnDb(d, "2026-07-30")[0].missingEvidence.length, r.labels.length,
    "the missing-evidence list is persisted, not discarded");
  d.close();
});

test("no AI or LLM authority exists anywhere on the capture path", () => {
  for (const f of ["lib/research/asymmetry/capture.ts", "lib/research/asymmetry/case-store.ts", "lib/research/asymmetry/live-intake.ts"]) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of ["anthropic", "openai", "runStructuredAiJob", "llm", "completion"]) {
      assert.equal(code.toLowerCase().includes(forbidden), false, `${f} must not reference ${forbidden}`);
    }
    assert.equal(/placeOrder|submitOrder|executeTrade/.test(code), false, `${f} must not reference order execution`);
  }
});

test("capture makes no network call and reads no webhook", () => {
  const code = readFileSync("lib/research/asymmetry/capture.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of ["fetch(", "webhook", "DISCORD_"]) {
    assert.equal(code.includes(forbidden), false, `capture must not reference ${forbidden}`);
  }
});
