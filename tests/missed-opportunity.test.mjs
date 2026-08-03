/**
 * tests/missed-opportunity.test.mjs — the Missed Opportunity Agent's guarantees.
 *
 * The properties asserted here are the ones that make the subsystem safe to run
 * unattended against production evidence:
 *
 *  1. ask→bid is the ONLY basis that can produce an executable return; the
 *     flattering bases exist but are quarantined as diagnostics.
 *  2. No future leakage — an exit is always strictly after its entry, and the
 *     entry is never re-chosen with hindsight.
 *  3. An unverified claim can never be classified as a pipeline miss.
 *  4. A correct rejection is never recorded as a defect.
 *  5. The module cannot send, trade, or mutate production — asserted by import
 *     boundary, not by convention.
 *  6. Persistence is repeat-safe: replaying a session yields one row, not two.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

import {
  verifyExecutableReturns,
  findEntry,
  normalizeSeries,
  inferExecutableNotionalUsd,
} from "../lib/research/missed-opportunity/returns.ts";
import {
  classifyCase,
  causeFromReason,
  allCausesFromReason,
} from "../lib/research/missed-opportunity/classify.ts";
import {
  reconstructRegularScanner,
  reconstructHighAsymmetry,
  reconstructSymbol,
  extractConsideredOccs,
} from "../lib/research/missed-opportunity/reconstruct.ts";
import {
  ensureMissedOpportunitySchema,
  saveMissedOpportunityCase,
  listMissedOpportunityCases,
  missedOpportunityId,
  rootCauseTally,
} from "../lib/research/missed-opportunity/store.ts";
import {
  MISSED_OPPORTUNITY_CASE_VERSION,
  emptyLaneDecision,
} from "../lib/research/missed-opportunity/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = join(HERE, "..", "lib", "research", "missed-opportunity");

const T0 = Date.UTC(2026, 7, 3, 14, 0, 0);
const min = (n) => T0 + n * 60_000;

function obs(atMs, bid, ask, extra = {}) {
  return {
    atMs,
    bid,
    ask,
    midpoint: bid != null && ask != null ? (bid + ask) / 2 : null,
    lastTrade: extra.lastTrade ?? null,
    quoteTimestampMs: extra.quoteTimestampMs ?? atMs,
    volume: extra.volume ?? null,
    openInterest: extra.openInterest ?? null,
  };
}

// ---------------------------------------------------------------- returns

test("executable return is ask-entry to later bid, never ask-to-ask", () => {
  const series = [
    obs(min(0), 1.00, 1.10),
    obs(min(10), 2.00, 2.20),
    obs(min(20), 3.00, 3.30),
  ];
  const r = verifyExecutableReturns(series, min(0));
  // Paid 1.10, sold 3.00 => +172.7%. NOT 3.30/1.10 = +200%.
  assert.equal(r.entryAsk, 1.1);
  assert.equal(r.exitBid, 3);
  assert.ok(Math.abs(r.executableReturnPct - 172.7273) < 0.01, `got ${r.executableReturnPct}`);

  const askToAsk = r.diagnostics.find((d) => d.basis === "ASK_TO_ASK");
  assert.ok(askToAsk, "ask-to-ask diagnostic must exist");
  assert.ok(askToAsk.returnPct > r.executableReturnPct, "diagnostic must be the flattering one");
});

test("a wide spread cannot manufacture an executable winner", () => {
  // Midpoint runs +900%; the bid never leaves the entry ask.
  const series = [
    obs(min(0), 0.10, 1.00),
    obs(min(30), 1.00, 20.00),
  ];
  const r = verifyExecutableReturns(series, min(0));
  assert.equal(r.entryAsk, 1);
  assert.equal(r.exitBid, 1);
  assert.equal(r.executableReturnPct, 0, "paid 1.00, best bid 1.00 => 0%");
  const mid = r.diagnostics.find((d) => d.basis === "MIDPOINT");
  assert.ok(mid.returnPct > 900, "midpoint diagnostic inflates, and is labelled as such");
});

test("no future leakage: the exit is strictly after the entry", () => {
  const series = [obs(min(0), 5.00, 5.20), obs(min(10), 1.00, 1.10)];
  // Entering at min(10) must not be allowed to sell into the min(0) bid of 5.00.
  const r = verifyExecutableReturns(series, min(10));
  assert.equal(r.entryAtMs, min(10));
  assert.equal(r.exitBid, null, "there is no observation after the entry");
  assert.equal(r.executableReturnPct, null);
});

test("entry is the first executable ask, not the cheapest one", () => {
  const series = [obs(min(0), 1.90, 2.00), obs(min(5), 0.40, 0.50), obs(min(9), 3.00, 3.10)];
  const r = verifyExecutableReturns(series, min(0));
  assert.equal(r.entryAsk, 2.0, "hindsight would have picked 0.50");
  assert.ok(r.executableReturnPct < 60);
});

test("threshold ladder records first reach, and never-reached stays null", () => {
  const series = [
    obs(min(0), 0.95, 1.00),
    obs(min(4), 1.30, 1.35),   // +30% on bid
    obs(min(9), 2.10, 2.20),   // +110%
    obs(min(30), 2.05, 2.15),
  ];
  const r = verifyExecutableReturns(series, min(0));
  assert.equal(r.ladder.pct25, 4 * 60_000);
  assert.equal(r.ladder.pct100, 9 * 60_000);
  assert.equal(r.ladder.pct200, null, "never reached +200% on the bid");
  assert.equal(r.ladder.pct2000, null);
});

test("MAE is measured on the executable path and can be negative", () => {
  const series = [obs(min(0), 0.95, 1.00), obs(min(5), 0.20, 0.30), obs(min(20), 1.50, 1.60)];
  const r = verifyExecutableReturns(series, min(0));
  assert.equal(r.maePct, -80, "bid fell to 0.20 against a 1.00 ask entry");
  assert.equal(r.mfePct, 50);
});

test("an isolated peak is flagged rather than trusted", () => {
  const series = [
    obs(min(0), 0.95, 1.00),
    obs(min(5), 1.00, 1.05),
    obs(min(6), 9.00, 9.50),  // lone spike
    obs(min(7), 1.02, 1.07),
  ];
  const r = verifyExecutableReturns(series, min(0));
  assert.equal(r.singleObservationPeak, true, "a one-observation peak must be visible to the caller");
});

test("empty and unusable series degrade to null, never to zero", () => {
  assert.equal(verifyExecutableReturns([], min(0)).executableReturnPct, null);
  assert.equal(verifyExecutableReturns([obs(min(0), null, null)], min(0)).executableReturnPct, null);
  assert.equal(findEntry([obs(min(0), 1, null)], min(0)), null);
  assert.equal(normalizeSeries([obs(min(5), 1, 2), obs(min(1), 1, 2)])[0].atMs, min(1));
});

test("executable notional is null when size is unknown", () => {
  assert.equal(inferExecutableNotionalUsd(obs(min(0), 1, 1.1)), null);
  assert.equal(inferExecutableNotionalUsd(null), null);
  const withVol = inferExecutableNotionalUsd(obs(min(0), 1, 1.1, { volume: 10_000 }));
  assert.ok(withVol > 0);
});

// ---------------------------------------------------------------- classify

function reconstructionFixture(over = {}) {
  return {
    symbol: "SPY",
    sessionDate: "2026-08-03",
    regularScanner: { ...emptyLaneDecision(), ...(over.regularScanner ?? {}) },
    highAsymmetry: { ...emptyLaneDecision(), ...(over.highAsymmetry ?? {}) },
    alerts: over.alerts ?? [],
    deliveryDecisions: over.deliveryDecisions ?? [],
    observations: over.observations ?? [],
    hasAnyEvidence: over.hasAnyEvidence ?? true,
  };
}

function classifyFixture(over = {}) {
  return classifyCase({
    reconstruction: reconstructionFixture(over.reconstruction ?? {}),
    executableReturnPct: over.executableReturnPct ?? 2500,
    verdict: over.verdict ?? "VERIFIED_EXECUTABLE",
    thresholdPct: over.thresholdPct ?? 200,
    hadQuoteEvidence: over.hadQuoteEvidence ?? true,
    budgetPlausibleCause: over.budgetPlausibleCause ?? false,
    winnerDirection: over.winnerDirection ?? "CALL",
  });
}

test("an unverified claim is never diagnosed as a pipeline miss", () => {
  const noQuotes = classifyFixture({ hadQuoteEvidence: false });
  assert.equal(noQuotes.rootCause, "INSUFFICIENT_EVIDENCE");
  assert.equal(noQuotes.failureFamily, "NO_FAILURE_ESTABLISHED");

  const belowThreshold = classifyFixture({ executableReturnPct: 40, thresholdPct: 200 });
  assert.equal(belowThreshold.rootCause, "NOT_A_VERIFIED_EXTREME_WINNER");
  assert.equal(belowThreshold.recoverability, "CORRECTLY_REJECTED");
});

test("midpoint-only and last-trade-only claims cannot become misses", () => {
  for (const verdict of ["MIDPOINT_ONLY", "LAST_TRADE_ONLY", "ASK_SIDE_ONLY"]) {
    const c = classifyFixture({ verdict });
    assert.equal(c.rootCause, "NOT_A_VERIFIED_EXTREME_WINNER", verdict);
  }
  const bad = classifyFixture({ verdict: "BAD_PRINT" });
  assert.equal(bad.recoverability, "CORRECTLY_REJECTED");
});

test("a symbol never observed is OUTSIDE_DISCOVERY_UNIVERSE", () => {
  const c = classifyFixture({ reconstruction: { hasAnyEvidence: false } });
  assert.equal(c.rootCause, "OUTSIDE_DISCOVERY_UNIVERSE");
  assert.equal(c.recoverability, "MISSED_DUE_TO_SYSTEM_DEFECT");
});

test("correct rejections are classified as correct, not as defects", () => {
  const spread = classifyFixture({
    reconstruction: { regularScanner: { observationCount: 5, terminalReason: "contract gate: spread_too_wide,insufficient_oi" } },
  });
  assert.equal(spread.rootCause, "SPREAD_REJECTION_CORRECT");
  assert.equal(spread.recoverability, "CORRECTLY_REJECTED");
  assert.equal(spread.failureFamily, "CORRECT_REJECTION");

  const late = classifyFixture({
    reconstruction: { regularScanner: { observationCount: 5, terminalReason: "late_phase_fraction_move (0.96 >= 0.75)" } },
  });
  assert.equal(late.rootCause, "EXTENSION_REJECTION_CORRECT");
  assert.equal(late.recoverability, "CORRECTLY_REJECTED");
});

test("the delta/DTE band miss is a contract-selection failure, not a setup failure", () => {
  const c = classifyFixture({
    reconstruction: { regularScanner: { observationCount: 40, terminalReason: "no eligible contract in the preferred delta/DTE band" } },
  });
  assert.equal(c.rootCause, "WRONG_DTE");
  assert.equal(c.failureFamily, "CONTRACT_SELECTION_FAILURE");
  assert.equal(c.recoverability, "WRONG_CONTRACT_SELECTED");
});

test("stale data is a system defect and never a strategy verdict", () => {
  const c = classifyFixture({
    reconstruction: { regularScanner: { observationCount: 9, terminalReason: "status DATA_STALE is not a Discord-emittable state" } },
  });
  assert.equal(c.rootCause, "DATA_MISSING");
  assert.equal(c.recoverability, "MISSED_DUE_TO_SYSTEM_DEFECT");
});

test("provider-budget refusal is recorded before strategy is blamed", () => {
  const c = classifyFixture({
    budgetPlausibleCause: true,
    reconstruction: { regularScanner: { observationCount: 3, terminalReason: "no eligible contract in the preferred delta/DTE band" } },
  });
  assert.ok(c.secondaryCauses.includes("PROVIDER_BUDGET_BLOCKED"));
});

test("High-Asymmetry capture without promotion is its own cause", () => {
  const c = classifyFixture({
    reconstruction: {
      hasAnyEvidence: true,
      highAsymmetry: { observationCount: 2, readyCount: 0, selectedOcc: "O:SPY260803C00640000" },
    },
  });
  assert.equal(c.rootCause, "HIGH_ASYMMETRY_CAPTURED_NOT_PROMOTED");
});

test("an alert on a different contract is ALERTED_BUT_WRONG_CONTRACT", () => {
  const c = classifyFixture({
    reconstruction: {
      regularScanner: { observationCount: 5, selectedOcc: "O:SPY260803C00650000" },
      alerts: [{ alertId: "a1", occSymbol: "O:SPY260803C00700000", side: "CALL", state: "SENT", sentAtMs: min(5), entryMid: 1, deliveredAsk: 1.1, researchOnly: false }],
    },
  });
  assert.equal(c.rootCause, "ALERTED_BUT_WRONG_CONTRACT");
  assert.equal(c.recoverability, "WRONG_CONTRACT_SELECTED");
});

test("reason patterns match production strings verbatim", () => {
  assert.equal(causeFromReason("contract gate: insufficient_oi").cause, "LIQUIDITY_REJECTION_CORRECT");
  assert.equal(causeFromReason("below VWAP on CALL; CALL while materially below VWAP").cause, "WRONG_DIRECTION");
  assert.equal(causeFromReason("BEARISH_WATCH: unsupported_bearish_strategy:sr_reclaim").cause, "WRONG_STRATEGY_CLASSIFICATION");
  assert.equal(causeFromReason(""), null);
  assert.equal(causeFromReason(null), null);
  assert.ok(allCausesFromReason("contract gate: spread_too_wide,stale_quote,insufficient_oi").length >= 2);
});

// ---------------------------------------------------------------- reconstruct

function seedDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE options_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT,
      selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL,
      considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT,
      chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT,
      earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE asymmetry_cases (
      session_date TEXT NOT NULL, fingerprint TEXT NOT NULL, symbol TEXT NOT NULL,
      direction TEXT NOT NULL, option_symbol TEXT NOT NULL, state TEXT NOT NULL,
      first_detected_at_ms INTEGER NOT NULL, early_ask REAL, early_bid REAL, early_spread_pct REAL,
      setup_family TEXT, scanner_version TEXT, evidence_json TEXT NOT NULL,
      missing_evidence TEXT NOT NULL, normal_qualified_at_ms INTEGER, normal_ask REAL,
      PRIMARY KEY (session_date, fingerprint)
    );
  `);
  return db;
}

test("reconstruction reports the terminal reason the funnel ended on", () => {
  const db = seedDb();
  const ins = db.prepare(
    `INSERT INTO options_candidates (symbol, direction, state, why, option_symbol, selected_strategy, created_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  );
  ins.run("SPY", "bullish", "REJECTED", "contract gate: insufficient_oi", "O:SPY260803C00640000", "momentum", min(1));
  ins.run("SPY", "bullish", "REJECTED", "contract gate: insufficient_oi", "O:SPY260803C00640000", "momentum", min(2));
  ins.run("SPY", "bullish", "REJECTED", "no eligible contract in the preferred delta/DTE band", null, "momentum", min(3));

  const lane = reconstructRegularScanner(db, "SPY", min(0), min(60));
  assert.equal(lane.observationCount, 3);
  assert.equal(lane.rejectedCount, 3);
  assert.equal(lane.readyCount, 0);
  assert.equal(lane.direction, "bullish");
  assert.equal(
    lane.terminalReason,
    "no eligible contract in the preferred delta/DTE band",
    "the LAST non-ready reason, not the most frequent one",
  );
  assert.ok(lane.consideredOccs.includes("O:SPY260803C00640000"));
});

test("an empty lane is 'no recorded observation', not a fabricated decision", () => {
  const db = seedDb();
  const lane = reconstructRegularScanner(db, "NVDA", min(0), min(60));
  assert.equal(lane.observationCount, 0);
  assert.equal(lane.terminalReason, null);
  assert.equal(lane.direction, null);
  assert.equal(lane.selectedOcc, null);
});

test("a missing table yields an empty lane rather than throwing", () => {
  const db = new Database(":memory:");
  const rc = reconstructSymbol(db, "SPY", "2026-08-03", min(0), min(60));
  assert.equal(rc.hasAnyEvidence, false);
  assert.equal(rc.regularScanner.observationCount, 0);
  assert.equal(rc.highAsymmetry.observationCount, 0);
});

test("High-Asymmetry capture without subscriber qualification is visible", () => {
  const db = seedDb();
  db.prepare(
    `INSERT INTO asymmetry_cases (session_date, fingerprint, symbol, direction, option_symbol, state,
       first_detected_at_ms, setup_family, evidence_json, missing_evidence, normal_qualified_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("2026-08-03", "fp1", "NVDA", "CALL", "O:NVDA260807C00190000", "HIGH_ASYMMETRY", min(4), "momentum_acceleration", "{}", "[]", null);

  const lane = reconstructHighAsymmetry(db, "NVDA", "2026-08-03");
  assert.equal(lane.observationCount, 1);
  assert.equal(lane.readyCount, 0);
  assert.equal(lane.direction, "CALL");
  assert.equal(lane.terminalReason, "high_asymmetry_case_never_qualified_in_subscriber_pipeline");
});

test("considered contracts are extracted without guessing at unknown shapes", () => {
  assert.deepEqual(extractConsideredOccs('["O:SPY260803C00640000"]'), ["O:SPY260803C00640000"]);
  assert.deepEqual(extractConsideredOccs('[{"occ":"O:QQQ260803C00580000"}]'), ["O:QQQ260803C00580000"]);
  assert.deepEqual(extractConsideredOccs("not json"), []);
  assert.deepEqual(extractConsideredOccs(null), []);
  assert.deepEqual(extractConsideredOccs('["definitely not an occ"]'), []);
});

// ---------------------------------------------------------------- store

function caseFixture(over = {}) {
  const now = min(0);
  const symbol = over.symbol ?? "SPY";
  const occ = over.occSymbol ?? "O:SPY260803C00640000";
  return {
    missedOpportunityId: missedOpportunityId("2026-08-03", symbol, occ),
    caseVersion: MISSED_OPPORTUNITY_CASE_VERSION,
    symbol, sessionDate: "2026-08-03", direction: "CALL", occSymbol: occ,
    expiration: "2026-08-03", strike: 640, dte: 0,
    externalClaim: { claimed: true, claimedReturnPct: 2000, source: null, alertIdentified: false, verdict: "UNVERIFIED_EXTERNAL_CLAIM" },
    verified: {
      executableReturnPct: null, basis: null, measured: [], ladder: {},
      mfePct: null, maePct: null, entrySpreadPct: null, entryVolume: null,
      entryOpenInterest: null, maxExecutableBid: null, executableNotionalUsd: null,
    },
    timeline: {
      earliestValidSetupAtMs: null, earliestExecutableContractAtMs: null,
      optiscanFirstSeenAtMs: null, asymmetryFirstSeenAtMs: null, localHighAtMs: null,
    },
    regularScanner: emptyLaneDecision(),
    highAsymmetry: emptyLaneDecision(),
    betterAlternativeOcc: null,
    rootCause: over.rootCause ?? "INSUFFICIENT_EVIDENCE",
    secondaryCauses: [],
    failureFamily: "NO_FAILURE_ESTABLISHED",
    recoverability: over.recoverability ?? "INSUFFICIENT_EVIDENCE",
    evidenceQuality: "PARTIAL",
    systemState: { providerMinutesObserved: 0, providerRequestsInWindow: 0, providerQuotaBlocksInWindow: 0, admissionPct: null, budgetPlausibleCause: false, notes: [] },
    quantFinding: null, aiAdvisory: null, experimentId: null, feedbackProposalId: null,
    status: "RESEARCH_ONLY", productionChanged: false,
    createdAtMs: now, updatedAtMs: now,
  };
}

test("saving the same case twice is repeat-safe", () => {
  const db = new Database(":memory:");
  ensureMissedOpportunitySchema(db);
  ensureMissedOpportunitySchema(db); // idempotent

  const first = saveMissedOpportunityCase(db, caseFixture());
  assert.equal(first.ok, true);
  assert.equal(first.created, true);

  const second = saveMissedOpportunityCase(db, caseFixture());
  assert.equal(second.ok, true);
  assert.equal(second.created, false, "a replay updates, it does not duplicate");

  const rows = listMissedOpportunityCases(db, { sessionDate: "2026-08-03" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "SPY");
});

test("every stored case records that production did not change", () => {
  const db = new Database(":memory:");
  saveMissedOpportunityCase(db, caseFixture());
  const row = db.prepare("SELECT production_changed FROM missed_opportunity_cases").get();
  assert.equal(row.production_changed, 0);
});

test("the defect tally excludes correct rejections", () => {
  const db = new Database(":memory:");
  saveMissedOpportunityCase(db, caseFixture({ symbol: "SPY", occSymbol: "O:SPY1", rootCause: "WRONG_DTE", recoverability: "WRONG_CONTRACT_SELECTED" }));
  saveMissedOpportunityCase(db, caseFixture({ symbol: "QQQ", occSymbol: "O:QQQ1", rootCause: "SPREAD_REJECTION_CORRECT", recoverability: "CORRECTLY_REJECTED" }));

  const tally = rootCauseTally(db, "2026-08-01");
  assert.equal(tally.length, 1, "only the real defect is counted");
  assert.equal(tally[0].rootCause, "WRONG_DTE");
});

test("listing from a database with no table returns empty, not an error", () => {
  const db = new Database(":memory:");
  assert.deepEqual(listMissedOpportunityCases(db), []);
  assert.deepEqual(rootCauseTally(db, "2026-08-01"), []);
});

// ---------------------------------------------------------------- boundaries

test("the agent cannot send, trade, or mutate production", () => {
  const files = readdirSync(MODULE_DIR).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 4);

  // Import paths that would give this subsystem authority it must never hold.
  const FORBIDDEN = [
    /from\s+["'].*discord/i,
    /from\s+["'].*notification/i,
    /from\s+["'].*\/deliver/i,
    /from\s+["'].*paper-engine/i,
    /from\s+["'].*broker/i,
    /from\s+["'].*scan-core/i,
    /from\s+["'].*\/ai\//i,
  ];

  for (const f of files) {
    const src = readFileSync(join(MODULE_DIR, f), "utf8");
    for (const re of FORBIDDEN) {
      assert.equal(re.test(src), false, `${f} must not import ${re}`);
    }
    // No write DDL/DML against production tables.
    assert.equal(/\b(DROP|DELETE\s+FROM|TRUNCATE)\b/i.test(src), false, `${f} contains destructive SQL`);
    for (const table of ["options_candidates", "options_alerts", "asymmetry_cases", "options_paper_trades"]) {
      assert.equal(
        new RegExp(`(INSERT\\s+INTO|UPDATE)\\s+${table}`, "i").test(src),
        false,
        `${f} must never write to ${table}`,
      );
    }
  }
});
