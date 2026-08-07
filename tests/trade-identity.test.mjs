/**
 * tests/trade-identity.test.mjs
 *
 * The invariant under test: ONE CASE PERFORMANCE IDENTITY = ONE FROZEN OCC.
 *
 * A case keeps observing other contracts as its thesis lives on — the options loop
 * re-selects a preferred strike/expiration and records each in `contractCandidates` /
 * `contractUpdates`. Those are ALTERNATE OBSERVATIONS. Pricing one of them against
 * this case's frozen entry produces a number that is not a return on anything, and
 * that number is what reaches marketing copy, the nightly AI, and strategy grading.
 *
 * These tests pin: alternates never become performance, a mark the frozen contract
 * never printed is contamination, and an unprovable identity fails closed instead of
 * rounding up to "verified".
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  reconcileTradeIdentityOnDb,
  summarizeTradeIdentities,
  normalizeOcc,
} from "../lib/opportunity-case/trade-identity.ts";

const T0 = Date.parse("2026-08-06T17:36:21.306Z");
const FROZEN = "O:GOOGL260807P00357500";
const OTHER = "O:GOOGL260819P00355000";

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT, detected_at_ms INTEGER, case_json TEXT
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, option_symbol TEXT, entry_mid REAL, state TEXT, discord_message_id TEXT
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY, option_symbol TEXT, paper_kind TEXT, alert_id TEXT, entry_fill REAL,
      status TEXT, return_pct REAL, mfe_pct REAL, mae_pct REAL
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY, trade_id INTEGER, option_symbol TEXT, mark_at_ms INTEGER, return_pct REAL
    );
  `);
  return d;
}

function seedCase(d, over = {}) {
  const c = {
    schemaVersion: 1,
    opportunityId: "oc_test",
    underlyingSymbol: "GOOGL",
    alertId: "oa_test",
    selectedContract: { optionSymbol: FROZEN, strike: 357.5, expiration: "2026-08-07" },
    frozenTrade: { entryMid: 2.33, immutable: true },
    summary: {
      frozenEntry: 2.33, currentMark: 3.43, currentReturnPct: 47.2103,
      maxReturnPct: 47.2103, currentStatus: "CLOSED",
    },
    contractCandidates: [
      { optionSymbol: FROZEN, observedAtMs: T0, reason: "initial_contract" },
      { optionSymbol: OTHER, observedAtMs: T0 + 60_000, reason: "preferred_contract_reselected" },
    ],
    contractUpdates: [
      { previousOptionSymbol: FROZEN, newOptionSymbol: OTHER, changedAtMs: T0 + 60_000, reason: "reselected" },
    ],
    ...over,
  };
  d.prepare("INSERT INTO opportunity_cases (opportunity_id, underlying_symbol, detected_at_ms, case_json) VALUES (?,?,?,?)")
    .run("oc_test", "GOOGL", T0, JSON.stringify(c));
  d.prepare("INSERT INTO options_alerts (alert_id, option_symbol, entry_mid, state, discord_message_id) VALUES (?,?,?,?,?)")
    .run("oa_test", FROZEN, 2.33, "SENT", "1534978451721814016");
  return c;
}

function seedTrade(d, { id = 1, occ = FROZEN, entryFill = 2.33, returnPct = 47.2103 } = {}) {
  d.prepare(
    "INSERT INTO options_paper_trades (id, option_symbol, paper_kind, alert_id, entry_fill, status, return_pct) VALUES (?,?,?,?,?,?,?)",
  ).run(id, occ, "DELIVERED_ALERT_PAPER", "oa_test", entryFill, "EXITED", returnPct);
}

function seedMark(d, { tradeId = 1, occ = FROZEN, atMs = T0 + 1000, returnPct = 0 } = {}) {
  d.prepare("INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct) VALUES (?,?,?,?)")
    .run(tradeId, occ, atMs, returnPct);
}

// ── the clean case ──────────────────────────────────────────────────────────

test("a case marked only on its frozen contract verifies, alternates notwithstanding", () => {
  const d = db();
  seedCase(d);
  seedTrade(d);
  seedMark(d, { returnPct: 10 });
  seedMark(d, { atMs: T0 + 2000, returnPct: 47.2103 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.equal(r.verdict, "SAME_OCC_VERIFIED");
  assert.equal(r.publishable, true);
  assert.equal(r.frozenOptionSymbol, FROZEN);
  // The re-selected contract is still recorded — as an observation, not performance.
  assert.ok(r.distinctCandidateOccs.includes(OTHER));
  assert.equal(r.linkedPaperTrades[0].marksOffFrozen, 0);
});

// ── the contamination this session was opened to find ───────────────────────

test("an MFE the frozen contract never printed is contamination, not performance", () => {
  const d = db();
  // The case claims a peak of +185.4%, but the frozen contract's own marks topped out
  // at +47.2%. The only place +185.4% can have come from is a different instrument.
  seedCase(d, {
    summary: {
      frozenEntry: 2.33, currentMark: 3.43, currentReturnPct: 47.2103,
      maxReturnPct: 185.4077, currentStatus: "CLOSED",
    },
  });
  seedTrade(d);
  seedMark(d, { returnPct: 12 });
  seedMark(d, { atMs: T0 + 2000, returnPct: 47.2103 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.equal(r.verdict, "CROSS_CONTRACT_CONTAMINATION");
  assert.equal(r.publishable, false);
  assert.equal(r.maxReturnReproducibleOnFrozen, false);
  assert.ok(r.reasons.some((x) => x.includes("exceeds the frozen contract's best mark")));
});

test("marks recorded on a re-selected contract are reported as off-frozen", () => {
  const d = db();
  seedCase(d);
  seedTrade(d);
  seedMark(d, { returnPct: 5 });
  seedMark(d, { atMs: T0 + 3000, occ: OTHER, returnPct: 185.4077 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.equal(r.verdict, "CROSS_CONTRACT_CONTAMINATION");
  assert.equal(r.linkedPaperTrades[0].marksOffFrozen, 1);
  assert.ok(r.reasons.some((x) => x.includes("off the frozen contract")));
});

test("a mirror on a different contract than the case froze is an OCC mismatch", () => {
  const d = db();
  seedCase(d);
  seedTrade(d, { occ: OTHER });
  seedMark(d, { occ: OTHER, returnPct: 20 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.notEqual(r.verdict, "SAME_OCC_VERIFIED");
  assert.equal(r.publishable, false);
  assert.ok(r.reasons.some((x) => x.includes("not frozen OCC") || x.includes("off the frozen contract")));
});

test("two mirrors on two contracts cannot share one performance identity", () => {
  const d = db();
  seedCase(d);
  seedTrade(d, { id: 1, occ: FROZEN });
  seedTrade(d, { id: 2, occ: OTHER, entryFill: 6.4, returnPct: 3.9 });
  seedMark(d, { tradeId: 1, returnPct: 47.2103 });
  seedMark(d, { tradeId: 2, occ: OTHER, returnPct: 3.9 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.equal(r.verdict, "CROSS_CONTRACT_CONTAMINATION");
  assert.ok(r.reasons.some((x) => x.includes("performance evidence spans")));
});

// ── failing closed ──────────────────────────────────────────────────────────

test("a case with no frozen OCC is unverifiable, never verified", () => {
  const d = db();
  seedCase(d, { selectedContract: null });
  seedTrade(d);
  seedMark(d, { returnPct: 47.2103 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.equal(r.verdict, "IDENTITY_UNVERIFIABLE");
  assert.equal(r.publishable, false);
});

test("a delivered case with no paper mirror is unverifiable, not zero", () => {
  const d = db();
  seedCase(d, {
    summary: { frozenEntry: 2.33, currentMark: null, currentReturnPct: null, maxReturnPct: null, currentStatus: "CREATED" },
  });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.equal(r.verdict, "IDENTITY_UNVERIFIABLE");
  assert.equal(r.publishable, false);
  assert.ok(r.reasons.some((x) => x.includes("no linked paper mirror")));
});

test("a stated max with no supporting mark at all fails closed", () => {
  const d = db();
  seedCase(d, {
    summary: { frozenEntry: 2.33, currentMark: 3.43, currentReturnPct: 47.2103, maxReturnPct: 185.4077, currentStatus: "CLOSED" },
  });
  seedTrade(d); // mirror exists, but was never marked

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.equal(r.publishable, false);
  assert.ok(r.reasons.some((x) => x.includes("no supporting mark on the frozen contract")));
});

test("a return that does not equal (mark vs frozen entry) is contamination", () => {
  const d = db();
  seedCase(d, {
    // 3.43 against 2.33 is +47.2%, not +112%. A stated return that its own mark and
    // entry cannot produce means one of the three belongs to another instrument.
    summary: { frozenEntry: 2.33, currentMark: 3.43, currentReturnPct: 112.0, maxReturnPct: 112.0, currentStatus: "CLOSED" },
  });
  seedTrade(d);
  seedMark(d, { returnPct: 112.0 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.equal(r.verdict, "CROSS_CONTRACT_CONTAMINATION");
  assert.equal(r.realizedReturnReproducibleOnFrozen, false);
});

// ── mechanics ───────────────────────────────────────────────────────────────

test("OCC comparison normalises case and whitespace but never rewrites a symbol", () => {
  assert.equal(normalizeOcc("  o:googl260807p00357500 "), FROZEN);
  assert.equal(normalizeOcc(""), null);
  assert.equal(normalizeOcc(null), null);
  // Different strikes stay different — no fuzzy ticker/strike matching.
  assert.notEqual(normalizeOcc("O:GOOGL260807P00360000"), normalizeOcc(FROZEN));
});

test("summary counts verdicts and names the contaminated cases", () => {
  const d = db();
  seedCase(d);
  seedTrade(d);
  seedMark(d, { returnPct: 47.2103 });
  const clean = reconcileTradeIdentityOnDb(d, "oc_test");

  const d2 = db();
  seedCase(d2, {
    summary: { frozenEntry: 2.33, currentMark: 3.43, currentReturnPct: 47.2103, maxReturnPct: 185.4, currentStatus: "CLOSED" },
  });
  seedTrade(d2);
  seedMark(d2, { returnPct: 47.2103 });
  const dirty = reconcileTradeIdentityOnDb(d2, "oc_test");

  const s = summarizeTradeIdentities([clean, dirty]);
  assert.equal(s.examined, 2);
  assert.equal(s.publishable, 1);
  assert.equal(s.byVerdict.SAME_OCC_VERIFIED, 1);
  assert.equal(s.byVerdict.CROSS_CONTRACT_CONTAMINATION, 1);
  assert.deepEqual(s.contaminated, ["oc_test"]);
});

// ── the two defects must not be collapsed into one ──────────────────────────

test("a peak of 0 on a contract that only traded down is a floor artifact, not contamination", () => {
  const d = db();
  // The summary seeds maxReturnPct at 0 at open. A trade that never goes green keeps
  // that 0, so every loser silently reports its excursion floored at break-even.
  // Real defect, but the contract identity is sound — calling it cross-contract
  // contamination would be its own false claim.
  seedCase(d, {
    summary: { frozenEntry: 2.33, currentMark: 1.4, currentReturnPct: -39.9142, maxReturnPct: 0, currentStatus: "CLOSED" },
  });
  seedTrade(d, { returnPct: -39.9142 });
  seedMark(d, { returnPct: -12 });
  seedMark(d, { atMs: T0 + 2000, returnPct: -39.9142 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.ok(r.defects.includes("MAX_FLOORED_AT_ZERO"));
  assert.ok(!r.defects.includes("UNSUPPORTED_MAX_RETURN"));
  assert.notEqual(r.verdict, "CROSS_CONTRACT_CONTAMINATION");
  assert.equal(r.publishable, false);
  assert.equal(r.frozenContractBestMarkPct, -12);
});

test("a positive peak above anything the contract printed is UNSUPPORTED_MAX_RETURN", () => {
  const d = db();
  seedCase(d, {
    summary: { frozenEntry: 2.33, currentMark: 3.43, currentReturnPct: 47.2103, maxReturnPct: 185.4077, currentStatus: "CLOSED" },
  });
  seedTrade(d);
  seedMark(d, { returnPct: 47.2103 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.ok(r.defects.includes("UNSUPPORTED_MAX_RETURN"));
  assert.ok(!r.defects.includes("MAX_FLOORED_AT_ZERO"));
  assert.equal(r.verdict, "CROSS_CONTRACT_CONTAMINATION");
  assert.equal(r.frozenContractBestMarkPct, 47.2103);
});

test("a stored peak below the observed best is fine — marking can start late", () => {
  const d = db();
  seedCase(d, {
    summary: { frozenEntry: 2.33, currentMark: 3.43, currentReturnPct: 47.2103, maxReturnPct: 30, currentStatus: "CLOSED" },
  });
  seedTrade(d);
  seedMark(d, { returnPct: 47.2103 });

  const r = reconcileTradeIdentityOnDb(d, "oc_test");
  assert.equal(r.verdict, "SAME_OCC_VERIFIED");
  assert.equal(r.maxReturnReproducibleOnFrozen, true);
});

test("a missing case is reported as not found, not as a clean bill of health", () => {
  const d = db();
  const r = reconcileTradeIdentityOnDb(d, "oc_missing");
  assert.equal(r.caseFound, false);
  assert.equal(r.verdict, "IDENTITY_UNVERIFIABLE");
  assert.equal(r.publishable, false);
});
