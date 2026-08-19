/**
 * tests/monday-preflight.test.mjs
 *
 * The preflight exists because "healthy" and "not measured" looked identical. A wedged
 * scanner reported loopRunning:true for five and a half hours; a recap that would have
 * thrown on its first execution passed its test; a case with no marks passed a peak
 * gate because there was nothing to contradict.
 *
 * So the property under test is not "does it say PASS". It is: a subsystem that cannot
 * be inspected reports UNKNOWN, UNKNOWN never rounds down to PASS, and the overall
 * verdict is the WORST check rather than the average.
 *
 * The fixture is the real production schema — a preflight that checks for columns
 * against an invented schema would be checking nothing.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  buildMondayPreflight,
  worstStatus,
} from "../lib/research/options/monday-preflight.ts";
import { ensureContractFunnelSchema } from "../lib/research/options/contract-funnel-store.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const NOW = Date.parse("2026-08-10T12:00:00.000Z");

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  // contract_funnel_evidence is created lazily by the funnel writer, not by SCHEMA. A
  // database that has actually run a session has it; see the UNKNOWN test below for
  // one that has not.
  ensureContractFunnelSchema(d);
  d.prepare(`INSERT INTO contract_funnel_evidence
    (session_date,at_ms,symbol,requested_side,strategy_key,discovery_version,selection_version,terminal_reason)
    VALUES (?,?,?,?,?,?,?,?)`).run("2026-08-10", NOW, "SPY", "call", "fixture", "fixture", "fixture", "NO_CONTRACT_SELECTED");
  return d;
}

const GREEN = {
  loop: { state: "HEALTHY", ticksStarted: 1030, ticksCompleted: 1030, timeoutCount: 0 },
  readiness: { state: "NOT_READY", blockingGates: 12, subscriberActive: 0 },
  lhc: { frozen: true, expectedHash: "80e5c5d878f5f9e185661981c87afc63", actualHash: "80e5c5d878f5f9e185661981c87afc63", shadowOnly: true },
  ownerRoutingEnabled: true,
  ownerMirrorEnabled: true,
};

const idOf = (p, id) => p.checks.find((c) => c.id === id);

test("a fully green environment passes every check", () => {
  const p = buildMondayPreflight(db(), GREEN, NOW);
  const failing = p.checks.filter((c) => c.status !== "PASS");
  assert.deepEqual(failing.map((c) => `${c.id}:${c.status}`), [], "expected all PASS");
  assert.equal(p.overall, "PASS");
});

test("a database that has never run the funnel reports UNKNOWN, not PASS", () => {
  const fresh = new Database(":memory:");
  applyProductionSchemaOnDb(fresh);
  const p = buildMondayPreflight(fresh, GREEN, NOW);
  assert.equal(
    p.checks.find((c) => c.id === "provider.accounting").status,
    "UNKNOWN",
    "no funnel evidence means the subsystem was not inspected",
  );
  assert.notEqual(p.overall, "PASS");
});

test("the verdict is the WORST check, never the average", () => {
  assert.equal(worstStatus([{ status: "PASS" }, { status: "PASS" }, { status: "FAIL" }]), "FAIL");
  assert.equal(worstStatus([{ status: "PASS" }, { status: "WARN" }]), "WARN");
  assert.equal(worstStatus([{ status: "PASS" }, { status: "UNKNOWN" }]), "UNKNOWN");
  assert.equal(worstStatus([{ status: "WARN" }, { status: "UNKNOWN" }]), "WARN");
  assert.equal(worstStatus([]), "PASS");
});

test("an uninspectable subsystem is UNKNOWN, never PASS", () => {
  const p = buildMondayPreflight(db(), {}, NOW);
  assert.equal(idOf(p, "scanner.loop").status, "UNKNOWN");
  assert.equal(idOf(p, "owner.routing").status, "UNKNOWN");
  assert.equal(idOf(p, "lhc.frozen").status, "UNKNOWN");
  assert.equal(idOf(p, "subscriber.blocked").status, "UNKNOWN");
  assert.notEqual(p.overall, "PASS", "an unchecked system must not report green");
});

test("a wedged loop FAILS instead of reporting running", () => {
  const p = buildMondayPreflight(db(), { ...GREEN, loop: { state: "WEDGED", ticksStarted: 900, ticksCompleted: 12, timeoutCount: 3 } }, NOW);
  assert.equal(idOf(p, "scanner.loop").status, "FAIL");
  assert.equal(p.overall, "FAIL");
});

test("a degraded loop WARNS rather than passing or failing outright", () => {
  const p = buildMondayPreflight(db(), { ...GREEN, loop: { state: "DEGRADED", ticksStarted: 100, ticksCompleted: 90, timeoutCount: 1 } }, NOW);
  assert.equal(idOf(p, "scanner.loop").status, "WARN");
  assert.equal(p.overall, "WARN");
});

test("a moved LHC definition hash FAILS", () => {
  const p = buildMondayPreflight(db(), {
    ...GREEN,
    lhc: { frozen: false, expectedHash: "80e5c5d878f5f9e185661981c87afc63", actualHash: "deadbeef", shadowOnly: true },
  }, NOW);
  assert.equal(idOf(p, "lhc.frozen").status, "FAIL");
});

test("a missing owner mirror FAILS — an ungradable alert is not evidence", () => {
  const p = buildMondayPreflight(db(), { ...GREEN, ownerMirrorEnabled: false }, NOW);
  const c = idOf(p, "owner.mirror");
  assert.equal(c.status, "FAIL");
  assert.match(c.detail, /never be graded/);
});

test("BLOCKED is the passing subscriber state, and READY is the warning", () => {
  const blocked = buildMondayPreflight(db(), GREEN, NOW);
  assert.equal(idOf(blocked, "subscriber.blocked").status, "PASS");

  const ready = buildMondayPreflight(db(), {
    ...GREEN,
    readiness: { state: "SUBSCRIBER_READY", blockingGates: 0, subscriberActive: 0 },
  }, NOW);
  assert.equal(
    idOf(ready, "subscriber.blocked").status,
    "WARN",
    "distribution is meant to be blocked; readiness is not a green light here",
  );

  const active = buildMondayPreflight(db(), {
    ...GREEN,
    readiness: { state: "NOT_READY", blockingGates: 12, subscriberActive: 3 },
  }, NOW);
  assert.equal(idOf(active, "subscriber.blocked").status, "WARN", "active subscribers contradict a blocked posture");
});

test("the recap schema check catches the column that would have silenced Monday", () => {
  const clean = buildMondayPreflight(db(), GREEN, NOW);
  assert.equal(idOf(clean, "recap.schema").status, "PASS");

  const d = db();
  d.exec("ALTER TABLE discord_deliveries ADD COLUMN option_side TEXT");
  const drifted = buildMondayPreflight(d, GREEN, NOW);
  assert.equal(idOf(drifted, "recap.schema").status, "WARN");
});

test("the excursion correction store is required, not optional", () => {
  const d = db();
  d.exec("DROP TABLE opportunity_excursion_corrections");
  const p = buildMondayPreflight(d, GREEN, NOW);
  assert.equal(idOf(p, "identity.excursionCorrections").status, "FAIL");
  assert.match(idOf(p, "identity.excursionCorrections").detail, /cannot be persisted/);
});

test("mark identity requires the column that records the observed contract", () => {
  const p = buildMondayPreflight(db(), GREEN, NOW);
  assert.equal(idOf(p, "identity.markOcc").status, "PASS");
});

test("the owner AI lane reports zero examples as evidence, not as failure", () => {
  const p = buildMondayPreflight(db(), GREEN, NOW);
  const c = idOf(p, "ai.ownerLane");
  assert.equal(c.status, "PASS");
  assert.equal(c.evidence.ownerExamples, 0);
  assert.match(c.detail, /no owner example has completed yet/);
});

test("the preflight states plainly that it predicts nothing", () => {
  const p = buildMondayPreflight(db(), GREEN, NOW);
  assert.match(p.note, /NO claim about what any trade or the market will do/i);
  assert.match(p.note, /UNKNOWN.*never.*same as PASS/is);
});
