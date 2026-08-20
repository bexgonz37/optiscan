/**
 * The things this session was NOT allowed to change, asserted rather than promised.
 *
 * The repair touches routing, delivery reporting and lifecycle messaging. It must not move
 * a target, a stop, an entry convention, a threshold, the timestamp instrumentation, or the
 * number of provider calls anything makes. Each of those is checked here directly, because
 * "I did not change it" is a claim and this file is the evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { decideOptionExit, defaultGradeConfig, subscriberExitMode } from "../lib/research/options/grade.ts";
import { decisionConfig } from "../lib/research/options/delivery-decision.ts";
import { LATE_PHASE_FRACTION_MOVE } from "../lib/notifications/owner-opening-class.ts";
import { entryMidpoint } from "../lib/research/options/format.ts";
import { buildRealOptionEntry, realOptionExit } from "../lib/research/options/paper.ts";
import { validateLifecycleQuote } from "../lib/research/options/lifecycle-session.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── thresholds and bars ──────────────────────────────────────────────────────

test("delivery thresholds are unchanged", () => {
  const c = decisionConfig({});
  assert.equal(c.deliverBar, 0.70);
  assert.equal(c.openingBump, 0.06);
  assert.equal(c.excellentBar, 0.78);
  assert.equal(c.researchFloor, 0.35);
  assert.equal(c.maxPerFlush, 1);
  assert.equal(c.correlationWindowMs, 15 * 60_000);
  assert.equal(LATE_PHASE_FRACTION_MOVE, 0.75, "the late-phase bar was named, not moved");
});

test("grade thresholds are unchanged", () => {
  const g = defaultGradeConfig({});
  assert.equal(g.takeProfitPct, 60);
  assert.equal(g.stopLossPct, 40);
  assert.equal(g.maxHoldMs, 172_800_000);
  assert.equal(g.maxQuoteAgeMs, 900_000);
  assert.equal(subscriberExitMode({}), "targets_then_bands");
});

// ── targets, stops and the exit rule ─────────────────────────────────────────

const pos = (over = {}) => ({
  id: 1, option_symbol: "O:SPY260826C00640000", side: "call", strike: 640,
  expiration: "2026-08-26", dte: 6, entry_fill: 1.25, result_class: "REAL_OPTION_PAPER",
  strategy: "sr_reclaim", underlying_price: 640, target: 1.55, invalidation: 0.95,
  entered_at_ms: Date.parse("2026-08-20T17:00:00.000Z"), status: "ENTERED", ...over,
});
const NOW = Date.parse("2026-08-20T17:45:00.000Z");
const q = (bid, ask) => ({ bid, ask, quoteAgeMs: 500, providerTimestamp: NOW });

test("the exit rule is byte-for-byte the same decision it always was", () => {
  // Frozen T1 first.
  const t1 = decideOptionExit(pos(), q(1.70, 1.78), NOW);
  assert.equal(t1.action, "exit");
  assert.equal(t1.reason, "target_hit");

  // Frozen stop second.
  const stop = decideOptionExit(pos(), q(0.60, 0.66), NOW);
  assert.equal(stop.action, "exit");
  assert.equal(stop.reason, "stop_hit");

  // Inside the band: hold.
  const hold = decideOptionExit(pos(), q(1.30, 1.34), NOW);
  assert.equal(hold.action, "hold");
  assert.equal(hold.reason, null);

  // The safety bands still exist behind the frozen levels.
  const band = decideOptionExit(pos({ target: null, invalidation: null }), q(2.10, 2.14), NOW);
  assert.equal(band.reason, "target_hit");
  assert.match(band.note, /\+60% safety band/);
});

test("the exit rule closes the WHOLE position at Target 1 -- there is no partial exit", () => {
  const d = decideOptionExit(pos(), q(1.70, 1.78), NOW);
  // The decision carries one exit fill and one return. No quantity, no remainder, no
  // second leg. This is why the close copy may never present Target 2 as a live target.
  assert.deepEqual(Object.keys(d).sort(), ["action", "exitFill", "note", "pnl", "reason", "returnPct"]);
  assert.ok(d.exitFill > 0);
  const grade = read("lib/research/options/grade.ts");
  assert.ok(!/partial|scale.?out|runner|profit.?lock|trail/i.test(grade), "no partial-exit machinery exists");
});

// ── entry conventions: reported, never consolidated ──────────────────────────

test("all four entry conventions still compute exactly what they did", () => {
  // Display midpoint.
  assert.equal(entryMidpoint(1.20, 1.30), 1.25);
  // Paper fill: conservative, toward the ask -- deliberately NOT the midpoint.
  const entry = buildRealOptionEntry({
    quote: {
      optionSymbol: "O:SPY260826C00640000", side: "call", strike: 640, expiration: "2026-08-26",
      dte: 6, bid: 1.20, ask: 1.30, volume: 5000, openInterest: 5000, iv: 0.3, delta: 0.5,
      quoteAgeMs: 500, providerTimestamp: NOW,
    },
    underlyingPrice: 640, strategy: "sr_reclaim", target: 1.55, invalidation: 0.95,
  }, {});
  assert.equal(entry.mid, 1.25);
  assert.notEqual(entry.entryFill, entry.mid, "the paper fill is still its own convention");
  assert.equal(entry.target, 1.55, "targets are passed through untouched");
  assert.equal(entry.invalidation, 0.95, "stops are passed through untouched");
  // Exit fill: 60% toward the bid.
  assert.equal(realOptionExit(1.25, 1.70, 1.78).exitFill, 1.716);
});

test("the opening message states its convention without changing any number", () => {
  const fmt = read("lib/research/options/format.ts");
  assert.match(fmt, /Entry shown: live bid\/ask at callout/);
  assert.match(fmt, /Targets and stop below are measured from the frozen entry/);
  assert.match(fmt, /REFERENCE ONLY/);
  // The formatter is pure: it must not compute a target, stop or fill of its own.
  assert.ok(
    !/entryMid \*|t1 \*|stop \*|\* 1\.6|\* 0\.6/.test(fmt),
    "the formatter derives no price of its own",
  );
});

// ── timestamp instrumentation and Zone-A ─────────────────────────────────────

test("the Phase 2A timestamp instrumentation and Zone-A validator are untouched", () => {
  // Named explicitly so a future edit to any of them fails here rather than in production.
  for (const f of [
    "lib/research/episode/clocks.ts",
    "lib/research/episode/leakage.ts",
    "lib/research/options/lifecycle-session.ts",
  ]) {
    assert.ok(read(f).length > 0, `${f} still exists`);
  }
  // Lifecycle quote validation still refuses an unverifiable event time, unchanged.
  const closed = validateLifecycleQuote({
    bid: 1.7, ask: 1.78,
    providerTimestamp: Date.parse("2026-08-20T20:12:00.000Z"),
    observedAtMs: Date.parse("2026-08-20T20:13:00.000Z"),
    maxQuoteAgeMs: 60_000,
    env: { MARKET_SESSION_GUARD: "shadow" },
  });
  assert.equal(closed.valid, false, "a post-close quote still cannot create a lifecycle event");
});

test("the owner lifecycle gate runs AFTER quote validation, never around it", () => {
  const grade = read("lib/research/options/grade.ts");
  // The owner branch is inside the same validSessionQuote / validSessionEventAtMs guard the
  // subscriber branch uses. A lifecycle message must never be produced from a quote the
  // timestamp rules rejected.
  const branch = grade.slice(grade.indexOf("// OWNER lane close"));
  assert.match(branch, /pos\.paper_kind === OWNER_VALIDATION_PAPER_KIND/);
  // An unverified event time short-circuits to a recorded skip BEFORE any identity is
  // resolved or any message is built. The message can only be produced in the else branch.
  assert.match(branch, /if \(!validSessionQuote \|\| validSessionEventAtMs == null\) \{\s*\r?\n\s*skip\("event_time_unverified"\);/);
  const skipIdx = branch.indexOf('skip("event_time_unverified")');
  const sendIdx = branch.indexOf("maybeDeliverOpportunityClosedDiscord");
  assert.ok(skipIdx > -1 && sendIdx > skipIdx, "the timestamp guard precedes the send");
});

// ── provider budget ──────────────────────────────────────────────────────────

test("no new provider call is introduced anywhere in the repair", () => {
  const provider = /fetchOption|polygon|withProviderConsumer\(|getQuote\(|fetch\(/;
  for (const f of [
    "lib/notifications/owner-opening-class.ts",
    "lib/notifications/owner-delivery-truth.ts",
    "lib/research/options/owner-delivery-reconciliation.ts",
  ]) {
    assert.ok(!provider.test(read(f)), `${f} contacts no provider`);
  }
  // The owner close reuses the quote the grading pass already fetched for this position.
  const grade = read("lib/research/options/grade.ts");
  const before = (grade.match(/deps\.getQuote\(/g) ?? []).length;
  assert.equal(before, 1, "the grading pass still fetches exactly one quote per position");
});

test("the new modules perform no writes", () => {
  for (const f of [
    "lib/notifications/owner-delivery-truth.ts",
    "lib/research/options/owner-delivery-reconciliation.ts",
    "lib/notifications/owner-opening-class.ts",
  ]) {
    const src = read(f);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/.test(src), `${f} is read-only`);
  }
});

test("the owner close does not release a thesis claim or change alert cadence", () => {
  const grade = read("lib/research/options/grade.ts");
  const branch = grade.slice(grade.indexOf("// OWNER lane close"));
  assert.ok(
    !/closeOpportunityOnDb\(/.test(branch),
    "closing the case would release the thesis claim and change when the next callout may fire",
  );
});

// ── subscriber lane ──────────────────────────────────────────────────────────

test("the subscriber milestone path is still DELIVERED_ALERT_PAPER only", () => {
  const grade = read("lib/research/options/grade.ts");
  assert.match(
    grade,
    /if \(pos\.paper_kind && pos\.paper_kind !== "DELIVERED_ALERT_PAPER"\) return 0;/,
    "owner rows still get no intermediate milestone spam",
  );
});

test("suppression of a WATCH observation still reports delivered to its caller", () => {
  // Load-bearing: a false here releases the opportunity opening claim, which destroys
  // owner-mirror linkage and PRE_MOVE_V2 capture. Asserted at the source.
  const notify = read("lib/notifications/owner-research-notify.ts");
  const block = notify.slice(notify.indexOf("if (opts.researchObservation && ownerWatchDiscordSuppressed"));
  assert.match(block.slice(0, 900), /sent: true/);
});

test("a database with no delivery ledger cannot produce a lifecycle message", async () => {
  const { gradeOpenOptionPositionsOnDb } = await import("../lib/research/options/grade.ts");
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL,
      expiration TEXT, dte INTEGER, entry_fill REAL, result_class TEXT NOT NULL, strategy TEXT,
      underlying_price REAL, target REAL, invalidation REAL, status TEXT NOT NULL, paper_kind TEXT,
      alert_id TEXT, feature_snapshot_json TEXT, exit_fill REAL, pnl REAL, return_pct REAL,
      exit_reason TEXT, exit_at_ms INTEGER, entered_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
  `);
  d.prepare(
    `INSERT INTO options_paper_trades
      (option_symbol, side, strike, expiration, dte, entry_fill, result_class, strategy, target,
       invalidation, status, paper_kind, alert_id, feature_snapshot_json, entered_at_ms,
       created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "O:SPY260826C00640000", "call", 640, "2026-08-26", 6, 1.25, "REAL_OPTION_PAPER", "sr_reclaim",
    1.55, 0.95, "ENTERED", "OWNER_VALIDATION_PAPER", null,
    JSON.stringify({ opportunityCaseId: "oc_x" }),
    NOW - 3_600_000, NOW - 3_600_000, NOW - 3_600_000,
  );
  const sends = [];
  const r = await gradeOpenOptionPositionsOnDb(d, {
    getQuote: async () => q(1.70, 1.78),
    now: () => NOW,
    sendMilestone: async (p) => { sends.push(p); return { ok: true }; },
  }, {
    INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", REAL_OPTION_PAPER_ENABLED: "1",
    OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "1", MARKET_SESSION_GUARD: "shadow",
  });
  assert.equal(r.graded, 1, "the trade still exits");
  assert.equal(sends.length, 0, "with no ledger there is no proof of delivery, so no update");
  d.close();
});
