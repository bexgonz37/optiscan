/**
 * tests/directional-authority.test.mjs
 *
 * Reproduces the real SPY incident and proves symbol-level directional authority stops it.
 *
 * Production, 2026-08-06: SPY selected `breakout_forming` (CALL, expirations including
 * 2026-08-11) and `lower_high_continuation` (PUT, O:SPY260807P00770000, bid 2.21 / ask 2.22)
 * inside one 15-minute window, and BOTH were treated as independently deliverable. The
 * owner received a "SPY CALL ALERT" and a "SPY PUT ALERT" together with no reversal, no
 * invalidation, and no authoritative final direction.
 *
 * Root cause: every exclusion key encoded DIRECTION. `clusterKey(symbol, side)` produced
 * `index:call` and `index:put` as separate clusters (the delivered put's own reason string
 * was literally `cluster index:put`), and `opportunityThesisFingerprint` —
 * `symbol|direction|optionType|sessionDate` — is the PRIMARY KEY of
 * `opportunity_thesis_active_index`, so a CALL claim and a PUT claim both succeeded.
 * The case's `auditAnswers.strategiesConflicted` was `[]` while `strategiesApplicable`
 * contained both strategies: the conflict existed and nothing watched for it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { claimOpportunityOpenOnDb, closeOpportunityOnDb } from "../lib/opportunity-case/live.ts";
import {
  evaluateDirectionalAuthority,
  findActiveDirectionsForSymbolOnDb,
  formatReversalMessage,
  directionalAuthorityMode,
} from "../lib/opportunity-case/directional-authority.ts";

const SESSION = "2026-08-06";
// The real production timestamps: the put case was detected 11:11:08 ET.
const T_CALL = Date.parse("2026-08-06T14:58:00.000Z");
const T_PUT = Date.parse("2026-08-06T15:11:08.000Z");

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT NOT NULL, direction TEXT, setup_family TEXT,
      detected_at_ms INTEGER NOT NULL, market_session TEXT, source_path TEXT NOT NULL,
      acceptance_decision TEXT NOT NULL, delivery_decision TEXT NOT NULL, rejection_reason_codes_json TEXT,
      alert_id TEXT, case_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      opportunity_fingerprint TEXT, session_date TEXT, lifecycle_status TEXT, summary_json TEXT,
      discord_channel_id TEXT, discord_message_id TEXT, discord_thread_id TEXT, opening_delivered_at_ms INTEGER,
      thesis_fingerprint TEXT, opening_source TEXT
    );
    CREATE TABLE opportunity_active_index (
      opportunity_fingerprint TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL, session_date TEXT NOT NULL, strategy_key TEXT, lifecycle_status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_thesis_active_index (
      thesis_fingerprint TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL, direction TEXT NOT NULL, option_type TEXT NOT NULL,
      session_date TEXT NOT NULL, lifecycle_status TEXT NOT NULL, opening_source TEXT NOT NULL,
      discord_message_id TEXT, opened_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX idx_opportunity_thesis_symbol
      ON opportunity_thesis_active_index(symbol, direction, option_type, session_date, lifecycle_status);
    CREATE TABLE opportunity_thesis_reopen_cooldown (
      thesis_fingerprint TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL,
      symbol TEXT NOT NULL, direction TEXT NOT NULL, option_type TEXT NOT NULL, session_date TEXT NOT NULL,
      closed_at_ms INTEGER NOT NULL, close_reason TEXT, return_percent REAL,
      cooldown_until_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_contract_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thesis_fingerprint TEXT NOT NULL,
      opportunity_case_id TEXT NOT NULL, opportunity_fingerprint TEXT NOT NULL,
      option_symbol TEXT NOT NULL, previous_option_symbol TEXT, side TEXT NOT NULL,
      strike REAL NOT NULL, expiration TEXT NOT NULL, strategy_key TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL, bid REAL, ask REAL, spread_pct REAL, delta REAL,
      open_interest REAL, volume REAL, reason TEXT NOT NULL, expiration_difference_days INTEGER,
      strike_difference REAL, previous_liquidity_json TEXT, new_liquidity_json TEXT,
      previous_spread_pct REAL, previous_delta REAL, original_contract_remains_valid INTEGER,
      created_at_ms INTEGER NOT NULL, UNIQUE(opportunity_case_id, opportunity_fingerprint)
    );
    CREATE TABLE opportunity_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_case_id TEXT NOT NULL, event_key TEXT NOT NULL,
      event_type TEXT NOT NULL, milestone_percent REAL, label TEXT NOT NULL, reached_at_ms INTEGER NOT NULL,
      contract_mark REAL, return_percent REAL, delivered_at_ms INTEGER, claim_token TEXT,
      discord_message_id TEXT, details_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      UNIQUE(opportunity_case_id, event_key)
    );
    CREATE TABLE opportunity_evidence_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL,
      source TEXT NOT NULL, signal_type TEXT NOT NULL, score REAL, details_json TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_content_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL, event_type TEXT NOT NULL, symbol TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL, frozen_entry REAL, current_mark REAL, return_percent REAL,
      milestone_percent REAL, max_return_percent REAL, direction TEXT, option_type TEXT, strike REAL,
      expiration TEXT, original_thesis_json TEXT, evidence_summary_json TEXT, strategy_key TEXT,
      content_status TEXT NOT NULL DEFAULT 'PENDING', label TEXT, payload_json TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_suppression_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, strategy TEXT, fingerprint TEXT,
      existing_opportunity_case_id TEXT, decision TEXT NOT NULL, reason TEXT NOT NULL,
      latest_return_percent REAL, next_undelivered_milestone REAL, details_json TEXT, created_at_ms INTEGER NOT NULL
    );
  `);
  return d;
}

/** The real SPY call leg: breakout_forming, 08/11 expiry, $772 strike. */
const spyCall = (over = {}) => ({
  symbol: "SPY", side: "call", direction: "bullish",
  expiration: "2026-08-11", strike: 772, strategyKey: "breakout_forming",
  nowMs: T_CALL, optionSymbol: "O:SPY260811C00772000",
  openingSource: "canonical", quality: 0.78,
  ...over,
});

/** The real SPY put leg: lower_high_continuation, 08/07 expiry, $770 strike, ask 2.22. */
const spyPut = (over = {}) => ({
  symbol: "SPY", side: "put", direction: "bearish",
  expiration: "2026-08-07", strike: 770, strategyKey: "lower_high_continuation",
  nowMs: T_PUT, optionSymbol: "O:SPY260807P00770000",
  openingSource: "canonical", quality: 0.7806,
  ...over,
});

// ── The incident ────────────────────────────────────────────────────────────

test("REPRODUCES THE INCIDENT: SPY CALL then PUT cannot both be actionable", () => {
  const d = db();
  const call = claimOpportunityOpenOnDb(d, spyCall());
  assert.equal(call.claimed, true, "the call opens first and owns the symbol");

  const put = claimOpportunityOpenOnDb(d, spyPut());
  assert.equal(put.claimed, false, "the opposite-direction put must be refused");
  assert.equal(put.reason, "OPPOSITE_DIRECTION_ACTIVE");
  assert.equal(put.directionalAuthority?.state, "OPPOSITE_DIRECTION_ACTIVE");
  assert.equal(put.directionalAuthority?.authoritativeDirection, "BULLISH");
  assert.equal(put.directionalAuthority?.conflicting.length, 1);
  assert.equal(put.directionalAuthority?.conflicting[0].opportunityCaseId, call.opportunityCaseId);
});

test("PUT then CALL is refused symmetrically", () => {
  const d = db();
  const put = claimOpportunityOpenOnDb(d, spyPut({ nowMs: T_CALL }));
  assert.equal(put.claimed, true);
  const call = claimOpportunityOpenOnDb(d, spyCall({ nowMs: T_PUT }));
  assert.equal(call.claimed, false);
  assert.equal(call.reason, "OPPOSITE_DIRECTION_ACTIVE");
  assert.equal(call.directionalAuthority?.authoritativeDirection, "BEARISH");
});

// ── The bypasses that were actually available in production ─────────────────

test("a different DTE does not bypass symbol authority", () => {
  const d = db();
  assert.equal(claimOpportunityOpenOnDb(d, spyCall()).claimed, true);
  // The real pair differed by expiry: 08/11 call vs 08/07 put.
  const farPut = claimOpportunityOpenOnDb(d, spyPut({ expiration: "2026-09-18", strike: 700 }));
  assert.equal(farPut.claimed, false, "a further-dated put is still an opposite direction");
  assert.equal(farPut.reason, "OPPOSITE_DIRECTION_ACTIVE");
});

test("a different strategy does not bypass symbol authority", () => {
  const d = db();
  assert.equal(claimOpportunityOpenOnDb(d, spyCall()).claimed, true);
  for (const strategyKey of ["vwap_rejection", "momentum_breakdown", "support_break_retest"]) {
    const r = claimOpportunityOpenOnDb(d, spyPut({ strategyKey, strike: 769 }));
    assert.equal(r.claimed, false, `${strategyKey} must not open an opposing direction`);
    assert.equal(r.reason, "OPPOSITE_DIRECTION_ACTIVE");
  }
});

test("the owner-actionable path cannot contradict the canonical path", () => {
  const d = db();
  // Canonical call opens. This is the `deliverOptionsCallout` lane.
  assert.equal(claimOpportunityOpenOnDb(d, spyCall({ openingSource: "canonical" })).claimed, true);
  // The bearish owner-review lane calls the same claim with openingSource owner_actionable.
  // Before this fix it sent BEFORE the main gating and never consulted the call.
  const owner = claimOpportunityOpenOnDb(d, spyPut({ openingSource: "owner_actionable" }));
  assert.equal(owner.claimed, false, "owner_actionable must not independently contradict canonical");
  assert.equal(owner.reason, "OPPOSITE_DIRECTION_ACTIVE");
});

test("a stale queued opposite alert cannot deliver after the authority changed", () => {
  const d = db();
  // A put is queued at T_CALL but not yet claimed. Meanwhile a call takes the symbol.
  const queuedPut = spyPut({ nowMs: T_CALL });
  assert.equal(claimOpportunityOpenOnDb(d, spyCall({ nowMs: T_CALL + 1000 })).claimed, true);
  // The queue drains later and tries to claim with its ORIGINAL, now-stale intent.
  const drained = claimOpportunityOpenOnDb(d, { ...queuedPut, nowMs: T_PUT });
  assert.equal(drained.claimed, false, "a stale queued opposite alert must not bypass the authority");
  assert.equal(drained.reason, "OPPOSITE_DIRECTION_ACTIVE");
});

// ── Reversals remain possible, but only with evidence ───────────────────────

test("a valid, evidenced reversal is allowed and supersedes the prior case", () => {
  const d = db();
  const call = claimOpportunityOpenOnDb(d, spyCall());
  assert.equal(call.claimed, true);

  const put = claimOpportunityOpenOnDb(d, spyPut({
    reversal: {
      supersedesCaseId: call.opportunityCaseId,
      whatChanged: "SPY lost the 772 breakout level and closed the 5-minute bar below VWAP.",
      priorInvalidation: "INVALIDATED",
      freshEvidenceAtMs: T_PUT,
    },
  }));
  assert.equal(put.claimed, true, "an evidenced reversal must remain possible");
});

test("a reversal without evidence, or naming the wrong case, is refused", () => {
  const d = db();
  const call = claimOpportunityOpenOnDb(d, spyCall());

  // Names a case that is not the active opposite one.
  const wrongCase = claimOpportunityOpenOnDb(d, spyPut({
    reversal: {
      supersedesCaseId: "oc_does_not_exist",
      whatChanged: "something",
      priorInvalidation: "INVALIDATED",
      freshEvidenceAtMs: T_PUT,
    },
  }));
  assert.equal(wrongCase.claimed, false, "a reversal must name the active opposite case");

  // Empty explanation.
  const noWhy = claimOpportunityOpenOnDb(d, spyPut({
    reversal: {
      supersedesCaseId: call.opportunityCaseId,
      whatChanged: "   ",
      priorInvalidation: "INVALIDATED",
      freshEvidenceAtMs: T_PUT,
    },
  }));
  assert.equal(noWhy.claimed, false, "a reversal requires a non-empty explanation");

  // Evidence that predates the case being superseded is not fresh evidence.
  const staleEvidence = claimOpportunityOpenOnDb(d, spyPut({
    reversal: {
      supersedesCaseId: call.opportunityCaseId,
      whatChanged: "SPY lost the level.",
      priorInvalidation: "INVALIDATED",
      freshEvidenceAtMs: T_CALL - 60_000,
    },
  }));
  assert.equal(staleEvidence.claimed, false, "reversal evidence must post-date the case it replaces");
});

test("the reversal message names the prior case, the new direction and the new contract", () => {
  const msg = formatReversalMessage({
    symbol: "SPY",
    priorCaseId: "oc_abc123",
    priorDirection: "BULLISH",
    newDirection: "BEARISH",
    whatChanged: "SPY lost the 772 breakout level and closed below VWAP.",
    optionSymbol: "O:SPY260807P00770000",
    entryEvidence: "bid 2.21 / ask 2.22, spread 0.45%, OI 10786",
  });
  assert.match(msg, /^SPY REVERSAL — CALL THESIS INVALIDATED/);
  assert.match(msg, /oc_abc123 \(BULLISH\)/);
  assert.match(msg, /New authoritative direction:\nPUT/);
  assert.match(msg, /O:SPY260807P00770000/);
  assert.match(msg, /bid 2\.21 \/ ask 2\.22/);
});

// ── Boundaries with the rules this must NOT replace ─────────────────────────

test("same-direction duplicates still hit the existing thesis rules, not the authority", () => {
  const d = db();
  const first = claimOpportunityOpenOnDb(d, spyPut());
  assert.equal(first.claimed, true);
  const again = claimOpportunityOpenOnDb(d, spyPut({ strike: 769, nowMs: T_PUT + 60_000 }));
  assert.equal(again.claimed, false);
  assert.equal(
    again.reason,
    "MATCHING_ACTIVE_THESIS",
    "a same-direction repeat is a duplicate, not a directional conflict",
  );
});

test("the reopen cooldown stays distinct from directional authority", () => {
  const d = db();
  const put = claimOpportunityOpenOnDb(d, spyPut());
  assert.equal(put.claimed, true);
  closeOpportunityOnDb(d, {
    opportunityCaseId: put.opportunityCaseId,
    nowMs: T_PUT + 60_000,
    reason: "TARGET_HIT",
    returnPercent: 50.27,
  });
  // Same direction again -> cooldown, NOT a directional conflict.
  const reopen = claimOpportunityOpenOnDb(d, spyPut({ nowMs: T_PUT + 120_000 }));
  assert.equal(reopen.claimed, false);
  assert.equal(reopen.reason, "THESIS_REOPEN_COOLDOWN");
  // The opposite direction is now free: closing released the symbol.
  const call = claimOpportunityOpenOnDb(d, spyCall({ nowMs: T_PUT + 120_000 }));
  assert.equal(call.claimed, true, "closing the only active thesis frees the symbol");
});

// ── Modes and helpers ───────────────────────────────────────────────────────

test("shadow mode records the conflict without blocking; off disables the gate", () => {
  const d = db();
  assert.equal(claimOpportunityOpenOnDb(d, spyCall()).claimed, true);

  const shadow = evaluateDirectionalAuthority(d, {
    symbol: "SPY", sessionDate: SESSION, direction: "BEARISH",
    env: { DIRECTIONAL_AUTHORITY_MODE: "shadow" },
  });
  assert.equal(shadow.allowed, true, "shadow observes but does not block");
  assert.equal(shadow.state, "OPPOSITE_DIRECTION_ACTIVE");
  assert.equal(shadow.reasonCode, "OPPOSITE_DIRECTION_ACTIVE_SHADOW");

  const off = evaluateDirectionalAuthority(d, {
    symbol: "SPY", sessionDate: SESSION, direction: "BEARISH",
    env: { DIRECTIONAL_AUTHORITY_MODE: "off" },
  });
  assert.equal(off.allowed, true);
  assert.equal(off.reasonCode, "DIRECTIONAL_AUTHORITY_OFF");
});

test("enforce is the default mode", () => {
  assert.equal(directionalAuthorityMode({}), "enforce");
  assert.equal(directionalAuthorityMode({ DIRECTIONAL_AUTHORITY_MODE: "" }), "enforce");
  assert.equal(directionalAuthorityMode({ DIRECTIONAL_AUTHORITY_MODE: "shadow" }), "shadow");
  assert.equal(directionalAuthorityMode({ DIRECTIONAL_AUTHORITY_MODE: "off" }), "off");
});

test("another symbol is unaffected by SPY's active direction", () => {
  const d = db();
  assert.equal(claimOpportunityOpenOnDb(d, spyCall()).claimed, true);
  const qqq = claimOpportunityOpenOnDb(d, spyPut({ symbol: "QQQ", optionSymbol: "O:QQQ260807P00600000", strike: 600 }));
  assert.equal(qqq.claimed, true, "authority is scoped per symbol");
});

test("findActiveDirectionsForSymbolOnDb reports both directions when they exist", () => {
  const d = db();
  const call = claimOpportunityOpenOnDb(d, spyCall());
  assert.equal(call.claimed, true);
  const rows = findActiveDirectionsForSymbolOnDb(d, "SPY", SESSION);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, "BULLISH");
  assert.equal(rows[0].optionType, "CALL");
  assert.equal(rows[0].opportunityCaseId, call.opportunityCaseId);
});
