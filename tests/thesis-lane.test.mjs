/**
 * tests/thesis-lane.test.mjs
 *
 * Reproduces the real AAPL duplicate incident and proves the authority stops it.
 *
 * Production, 2026-07-29: three AAPL PUT alerts for the SAME exact OCC
 * O:AAPL260729P00340000 at 14:50:15, 15:02:18 and 15:44:15, while the first was
 * open and past Target 1. The existing guard is an 8-minute window for core
 * symbols, and every repeat fell outside it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  thesisLaneKey, optionTypeFor, decideLaneAuthority, claimThesisLane,
  attachLaneEvidenceOnDb, closeThesisLaneOnDb, bindLaneAlertOnDb,
  readLaneOnDb, readLaneDiagnosticsOnDb, ensureThesisLaneSchema, REENTRY_COOLDOWN_MS,
} from "../lib/thesis-lane.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const SESSION = "2026-07-29";
const OCC = "O:AAPL260729P00340000";
// The three real alert times.
const T1 = Date.parse("2026-07-29T14:50:15.579Z");
const T2 = Date.parse("2026-07-29T15:02:18.712Z");
const T3 = Date.parse("2026-07-29T15:44:15.123Z");

const db = () => { const d = new Database(":memory:"); ensureThesisLaneSchema(d); return d; };
const claim = (d, over = {}) => claimThesisLane(d, {
  symbol: "AAPL", direction: "bearish", sessionDate: SESSION, nowMs: T1,
  optionSymbol: OCC, score: 87, ...over,
});

// ── The incident ────────────────────────────────────────────────────────────

test("REPRODUCES THE INCIDENT: the second and third AAPL PUT alerts are suppressed", () => {
  const d = db();
  const first = claim(d, { nowMs: T1, score: 87 });
  assert.equal(first.claimed, true, "the first alert opens the lane");
  bindLaneAlertOnDb(d, first.laneKey, 2113, T1);

  // 12 minutes later — outside the 8-minute window that let this through.
  const second = claim(d, { nowMs: T2, score: 88 });
  assert.equal(second.claimed, false, "the 15:02 repeat must be suppressed");
  assert.equal(second.reason, "THESIS_ALREADY_OPEN");
  assert.equal(second.existing.alertId, 2113, "and must point at the alert that holds the idea");

  // 42 minutes later.
  const third = claim(d, { nowMs: T3, score: 90 });
  assert.equal(third.claimed, false, "the 15:44 repeat must be suppressed too");
  d.close();
});

test("a rising score does not buy a second opening alert", () => {
  const d = db();
  claim(d, { nowMs: T1, score: 87 });
  for (const [t, s] of [[T2, 88], [T3, 90], [T3 + 60_000, 99]]) {
    assert.equal(claim(d, { nowMs: t, score: s }).claimed, false, `score ${s} must not reopen`);
  }
  d.close();
});

test("a different strike or expiration does not bypass the lane", () => {
  const d = db();
  claim(d, { nowMs: T1, optionSymbol: OCC });
  for (const occ of [
    "O:AAPL260729P00335000",  // different strike
    "O:AAPL260807P00340000",  // different expiration
    "O:AAPL260814P00300000",  // both
  ]) {
    const r = claim(d, { nowMs: T3, optionSymbol: occ });
    assert.equal(r.claimed, false, `${occ} is the same idea and must not reopen`);
  }
  d.close();
});

test("the lane key deliberately excludes strike, expiration and strategy", () => {
  const base = { symbol: "AAPL", direction: "bearish", optionType: "PUT", sessionDate: SESSION };
  const key = thesisLaneKey(base);
  assert.equal(key.includes("340"), false, "no strike in the key");
  assert.equal(key.includes("260729"), false, "no expiration in the key");
  // What DOES change it:
  assert.notEqual(thesisLaneKey({ ...base, symbol: "MSFT" }), key);
  assert.notEqual(thesisLaneKey({ ...base, direction: "bullish", optionType: "CALL" }), key);
  assert.notEqual(thesisLaneKey({ ...base, sessionDate: "2026-07-30" }), key);
});

test("the OPPOSITE direction remains independently evaluable", () => {
  const d = db();
  assert.equal(claim(d, { direction: "bearish", nowMs: T1 }).claimed, true);
  assert.equal(claim(d, { direction: "bullish", nowMs: T2 }).claimed, true,
    "an AAPL call thesis is a different idea from an AAPL put thesis");
  d.close();
});

test("a different SESSION starts a fresh lane", () => {
  const d = db();
  claim(d, { nowMs: T1 });
  assert.equal(claim(d, { sessionDate: "2026-07-30", nowMs: T1 + 86_400_000 }).claimed, true);
  d.close();
});

// ── Re-entry ────────────────────────────────────────────────────────────────

test("a closed lane may reopen only after the deterministic cooldown", () => {
  const d = db();
  const first = claim(d, { nowMs: T1 });
  assert.equal(closeThesisLaneOnDb(d, first.laneKey, T2), true);

  const tooSoon = claim(d, { nowMs: T2 + 60_000 });
  assert.equal(tooSoon.claimed, false, "a stop-out must not re-alert on the next tick");
  assert.match(tooSoon.reason, /REENTRY_COOLDOWN/);

  const later = claim(d, { nowMs: T2 + REENTRY_COOLDOWN_MS + 1000 });
  assert.equal(later.claimed, true, "after the cooldown the idea may be reopened");
  assert.equal(later.reason, "REENTRY_AFTER_COOLDOWN");
  d.close();
});

test("an invalidated lane behaves the same as a closed one", () => {
  const d = db();
  const c = claim(d, { nowMs: T1 });
  closeThesisLaneOnDb(d, c.laneKey, T2, "INVALIDATED");
  assert.equal(readLaneOnDb(d, c.laneKey).state, "INVALIDATED");
  assert.equal(claim(d, { nowMs: T2 + REENTRY_COOLDOWN_MS + 1000 }).claimed, true);
  d.close();
});

test("closing is guarded — only an OPEN lane closes, so a replay is a no-op", () => {
  const d = db();
  const c = claim(d, { nowMs: T1 });
  assert.equal(closeThesisLaneOnDb(d, c.laneKey, T2), true);
  assert.equal(closeThesisLaneOnDb(d, c.laneKey, T3), false, "a second close must change nothing");
  d.close();
});

// ── Evidence, not a second send ─────────────────────────────────────────────

test("a suppressed candidate becomes evidence and preserves the original alert", () => {
  const d = db();
  const first = claim(d, { nowMs: T1, score: 87 });
  bindLaneAlertOnDb(d, first.laneKey, 2113, T1);
  const openedAt = readLaneOnDb(d, first.laneKey).openedAtMs;

  const second = claim(d, { nowMs: T2, score: 88 });
  attachLaneEvidenceOnDb(d, {
    laneKey: second.laneKey, sessionDate: SESSION, nowMs: T2,
    candidateOptionSymbol: OCC, candidateScore: 88, reason: second.reason,
    originalAlertId: 2113, lifecycleEvent: "THESIS_STRENGTHENED",
  });

  const lane = readLaneOnDb(d, first.laneKey);
  assert.equal(lane.evidenceCount, 1);
  assert.equal(lane.suppressedCount, 1);
  assert.equal(lane.bestScore, 88, "the stronger score is recorded as evidence");
  assert.equal(lane.alertId, 2113, "the ORIGINAL alert still holds the lane");
  assert.equal(lane.openedAtMs, openedAt, "and the original open time is untouched");
  d.close();
});

test("diagnostics expose the lane, the suppression and its linkage", () => {
  const d = db();
  const c = claim(d, { nowMs: T1 });
  bindLaneAlertOnDb(d, c.laneKey, 2113, T1);
  const s = claim(d, { nowMs: T2, score: 88 });
  attachLaneEvidenceOnDb(d, {
    laneKey: s.laneKey, sessionDate: SESSION, nowMs: T2, candidateOptionSymbol: OCC,
    candidateScore: 88, reason: s.reason, originalAlertId: 2113, lifecycleEvent: "THESIS_STRENGTHENED",
  });
  const diag = readLaneDiagnosticsOnDb(d, SESSION);
  assert.equal(diag.activeLanes.length, 1);
  assert.equal(diag.suppressedTotal, 1);
  assert.equal(diag.recentSuppressions[0].originalAlertId, 2113);
  assert.equal(diag.recentSuppressions[0].lifecycleEvent, "THESIS_STRENGTHENED");
  assert.equal(diag.recentSuppressions[0].candidateOptionSymbol, OCC);
  d.close();
});

// ── Containment ─────────────────────────────────────────────────────────────

test("SUPPRESSION FAILURE MUST NEVER BLOCK THE SCANNER — it fails OPEN", () => {
  const broken = { prepare() { throw new Error("db gone"); }, exec() { throw new Error("db gone"); } };
  const r = claimThesisLane(broken, { symbol: "AAPL", direction: "bearish", sessionDate: SESSION, nowMs: T1 });
  assert.equal(r.claimed, true, "an unavailable authority must not silence alerts");
  assert.equal(r.reason, "AUTHORITY_UNAVAILABLE");
  // And the writers swallow it too.
  assert.doesNotThrow(() => attachLaneEvidenceOnDb(broken, {
    laneKey: "k", sessionDate: SESSION, nowMs: T1, candidateOptionSymbol: null,
    candidateScore: null, reason: "x", originalAlertId: null,
  }));
  assert.doesNotThrow(() => bindLaneAlertOnDb(broken, "k", 1, T1));
  assert.equal(closeThesisLaneOnDb(broken, "k", T1), false);
});

test("a concurrent double-claim produces exactly one winner", () => {
  const d = db();
  const a = claim(d, { nowMs: T1 });
  const b = claim(d, { nowMs: T1 });
  assert.equal(a.claimed, true);
  assert.equal(b.claimed, false, "the PRIMARY KEY decides, not a read-then-write check");
  d.close();
});

test("decideLaneAuthority is pure and total", () => {
  const key = "k";
  assert.equal(decideLaneAuthority(key, null, T1).allowed, true);
  const open = { laneKey: key, state: "OPEN", openedAtMs: T1, closedAtMs: null };
  assert.equal(decideLaneAuthority(key, open, T3).allowed, false);
  const closed = { laneKey: key, state: "CLOSED", openedAtMs: T1, closedAtMs: T1 };
  assert.equal(decideLaneAuthority(key, closed, T1 + 1000).allowed, false);
  assert.equal(decideLaneAuthority(key, closed, T1 + REENTRY_COOLDOWN_MS + 1).allowed, true);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test("the live capture path claims the lane before creating an alert", () => {
  const src = readFileSync("lib/alert-capture.ts", "utf8");
  assert.match(src, /claimThesisLane/, "captureZeroDte must claim the lane");
  assert.match(src, /attachLaneEvidenceOnDb/, "and record a suppressed candidate as evidence");
  assert.match(src, /bindLaneAlertOnDb/, "and bind the opening alert to the lane");
  // The claim must come BEFORE the alert is inserted, otherwise it guards nothing.
  assert.ok(src.indexOf("claimThesisLane") < src.indexOf("return id;"), "claim precedes the return");
  // A failed capture must release the lane rather than hold it shut all session.
  assert.match(src, /closeThesisLaneOnDb\(getDb\(\), claimedLaneKey/, "a failed capture releases the lane");
});

test("the authority never reaches a broker or a real order path", () => {
  const src = readFileSync("lib/thesis-lane.ts", "utf8");
  for (const forbidden of [/\/execution\//, /\/broker\//, /\bplaceOrder\b/, /\bfetch\s*\(/, /from\s+["'].*\/ai\//]) {
    assert.equal(forbidden.test(src), false, `must not reference ${forbidden}`);
  }
});

test("the migration is additive and repeat-safe", () => {
  const d = new Database(":memory:");
  for (let i = 0; i < 4; i += 1) ensureThesisLaneSchema(d);
  for (const t of ["thesis_lane_authority", "thesis_lane_suppressions"]) {
    assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
  }
  const src = readFileSync("lib/thesis-lane.ts", "utf8");
  assert.equal(/DROP\s+TABLE|ALTER\s+TABLE/i.test(src), false, "no destructive DDL");
  d.close();
});

test("optionTypeFor maps direction to the contract side", () => {
  assert.equal(optionTypeFor("bearish"), "PUT");
  assert.equal(optionTypeFor("bullish"), "CALL");
});
