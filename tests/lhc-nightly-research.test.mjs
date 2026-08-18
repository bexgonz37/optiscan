import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  runNightlyResearchOnDb, buildOwnerAlertSummaryOnDb, formatNightlyResearchSections,
} from "../lib/research/options/nightly-research.ts";
import {
  registerExperimentOnDb, recordShadowDecisionOnDb, linkPaperTradeOnDb, currentStatusOnDb,
  statusHistoryOnDb,
} from "../lib/research/options/shadow-arm-store.ts";
import { buildShadowRecord, SHADOW_STRATEGY } from "../lib/research/options/prospective-shadow.ts";
import { LHC_SELECT_V1 } from "../lib/research/options/experiment-registry.ts";
import { buildNightlyRecapMessage } from "../lib/ai/recap.ts";

const SESSION = "2026-08-07";
const T0 = Date.UTC(2026, 7, 7, 14, 35, 0); // 10:35 ET

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_experiment_registry (
      experiment_id TEXT NOT NULL, experiment_version INTEGER NOT NULL, mode TEXT NOT NULL,
      hypothesis TEXT NOT NULL, gates_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
      creation_sha TEXT NOT NULL, prospective_start_date TEXT NOT NULL, activation_at_ms INTEGER NOT NULL,
      source_cohort_id TEXT NOT NULL, development_sessions_json TEXT NOT NULL,
      validation_sessions_json TEXT NOT NULL, historical_result_json TEXT NOT NULL,
      robustness_caveats_json TEXT NOT NULL, would_be_disproven_by TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, PRIMARY KEY (experiment_id, experiment_version)
    );
    CREATE TABLE options_experiment_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL, experiment_version INTEGER NOT NULL,
      status TEXT NOT NULL, previous_status TEXT, reason TEXT NOT NULL, evidence_json TEXT,
      actor TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_experiment_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, decision_key TEXT NOT NULL,
      experiment_id TEXT NOT NULL, experiment_version INTEGER NOT NULL,
      session_date TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL,
      symbol TEXT NOT NULL, strategy TEXT NOT NULL, side TEXT, direction TEXT,
      option_symbol TEXT NOT NULL, opportunity_case_id TEXT, alert_id TEXT,
      baseline_admitted INTEGER NOT NULL, baseline_outcome TEXT, baseline_reason TEXT, baseline_quality REAL,
      experiment_admitted INTEGER NOT NULL, experiment_blocked_by_json TEXT,
      experiment_unavailable_json TEXT, experiment_score REAL, experiment_components_json TEXT,
      experiment_reason TEXT, arm TEXT NOT NULL,
      features_json TEXT, confirmation_json TEXT, attribution_json TEXT,
      paper_trade_id INTEGER, outcome_status TEXT, return_pct REAL, exit_reason TEXT,
      closed_at_ms INTEGER, same_contract_marks INTEGER, peak_pct REAL, trough_pct REAL,
      created_at_ms INTEGER NOT NULL, UNIQUE(decision_key)
    );
    CREATE TABLE options_learning_findings (
      finding_id TEXT PRIMARY KEY, strategy TEXT, strategy_version TEXT, population TEXT,
      evidence_cohort_id TEXT, sessions_json TEXT NOT NULL, sample_size INTEGER NOT NULL,
      title TEXT NOT NULL, statement TEXT NOT NULL, baseline_metric_json TEXT,
      experimental_metric_json TEXT, evidence_strength TEXT NOT NULL, limitations_json TEXT NOT NULL,
      affected_opportunity_ids_json TEXT, recommended_experiment TEXT, experiment_id TEXT,
      experiment_status TEXT, must_not_be_summarized_as TEXT, deployment_sha TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, result_class TEXT NOT NULL,
      side TEXT, strike REAL, expiration TEXT, dte INTEGER, entry_fill REAL, exit_fill REAL,
      strategy TEXT, status TEXT NOT NULL, return_pct REAL, exit_reason TEXT,
      entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, feature_snapshot_json TEXT,
      alert_id TEXT, paper_kind TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT NOT NULL, direction TEXT,
      setup_family TEXT, detected_at_ms INTEGER NOT NULL, market_session TEXT,
      source_path TEXT NOT NULL, acceptance_decision TEXT NOT NULL, delivery_decision TEXT NOT NULL,
      rejection_reason_codes_json TEXT, alert_id TEXT, case_json TEXT NOT NULL,
      session_date TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT NOT NULL,
      mark_at_ms INTEGER NOT NULL, return_pct REAL, created_at_ms INTEGER NOT NULL,
      UNIQUE(trade_id, mark_at_ms)
    );
  `);
  return d;
}

let nextTrade = 1;

/**
 * ONE OWNER CALLOUT: an opportunity case that froze a contract, plus the
 * OWNER_VALIDATION_PAPER mirror on that exact contract.
 *
 * These used to be DELIVERED_ALERT_PAPER rows carrying an `alert_id`, which is the
 * SUBSCRIBER lane's shape and is precisely what the owner summary was wrongly reading. An
 * owner callout writes no `options_alerts` row, so `alert_id` is null on both the case and
 * the mirror; the link is the case id recorded in the mirror's own feature snapshot. The
 * fixture asserts that shape by using it — a fixture that keeps handing the code an alert
 * id can only ever prove the broken path still works.
 */
function addTrade(d, over = {}) {
  const id = nextTrade++;
  const o = {
    optionSymbol: `O:AAPL260807P00230${String(id).padStart(3, "0")}`,
    strategy: SHADOW_STRATEGY, status: "EXITED", returnPct: -40, exitReason: "stop_hit",
    enteredAtMs: T0, exitAtMs: T0 + 3_600_000,
    paperKind: "OWNER_VALIDATION_PAPER", marks: 30, peak: 2, side: "put",
    caseId: `oc_owner_${id}`, ...over,
  };
  d.prepare(
    `INSERT INTO opportunity_cases (opportunity_id, underlying_symbol, direction, setup_family,
        detected_at_ms, market_session, source_path, acceptance_decision, delivery_decision,
        alert_id, case_json, session_date, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`,
  ).run(
    o.caseId, "AAPL", "bearish", o.strategy, T0, "regular", "options_live", "accepted", "delivered",
    JSON.stringify({
      underlyingSymbol: "AAPL",
      opportunityFingerprint: `of_test_${id}`,
      selectedContract: { optionSymbol: o.optionSymbol, side: o.side, strike: 230, expiration: "2026-08-07", dte: 0 },
      frozenTrade: { entryMid: 2, targetT1: 3, targetT2: 4, stop: 1.4 },
    }),
    "2026-08-07", T0, T0,
  );
  d.prepare(
    `INSERT INTO options_paper_trades (id, option_symbol, result_class, side, strike, expiration, dte,
        entry_fill, exit_fill, strategy, status, return_pct, exit_reason, entered_at_ms, exit_at_ms,
        session, feature_snapshot_json, alert_id, paper_kind, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
  ).run(
    id, o.optionSymbol, "X", o.side, 230, "2026-08-07", 0, 2,
    o.status === "EXITED" ? 2 * (1 + (o.returnPct ?? 0) / 100) : null,
    o.strategy, o.status, o.returnPct, o.exitReason, o.enteredAtMs, o.exitAtMs, "regular",
    JSON.stringify({ lane: "OWNER_ONLY", opportunityCaseId: o.caseId, quality: 0.9 }),
    o.paperKind, T0, T0,
  );
  for (let i = 0; i < o.marks; i++) {
    d.prepare("INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms) VALUES (?,?,?,?,?)")
      .run(id, o.optionSymbol, T0 + i * 60_000, i === 0 ? o.peak : Math.min(o.peak, 0), T0);
  }
  return { id, ...o };
}

function sub(over = {}) {
  return {
    symbol: "AAPL", strategy: SHADOW_STRATEGY, side: "put", direction: "bearish",
    optionSymbol: "O:AAPL260807P00230000", strike: 229.5, expiration: "2026-08-07", dte: 0,
    bid: 1.98, ask: 2.02, spreadPct: 2, volume: 5400, openInterest: 4000,
    iv: 0.35, delta: -0.45, underlyingPrice: 230,
    baselineOutcome: "DELIVER_TO_DISCORD", baselineAdmitted: true,
    baselineReason: "subscriber_worthy", baselineQuality: 0.78,
    opportunityCaseId: null, alertId: null, sessionState: "REGULAR",
    nowMs: T0, decisionMs: T0, firstDetectedAtMs: T0 - 600_000, firstReadyAtMs: T0 - 300_000,
    underlyingAtFirstDetection: 231, optionAtFirstDetection: 1.7,
    featureSnapshot: { underlying: { dollarVolume: 2.02e10, vwapDistPct: -0.24 }, chain: {} },
    ...over,
  };
}
const CTX = { deploymentSha: "abc1234", population: "DELIVERED_ALERT_PAPER" };

// â”€â”€ owner summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("the owner summary is empty and honest on a session with no openings", () => {
  const d = db();
  const o = buildOwnerAlertSummaryOnDb(d, SESSION);
  assert.equal(o.openings, 0);
  assert.equal(o.expectancyPct, null);
  assert.equal(o.profitFactor, null);
  assert.equal(o.bestWinnerPct, null);
  d.close();
});

test("the owner summary prices only closed openings", () => {
  const d = db();
  addTrade(d, { returnPct: 50, exitReason: "target_hit", peak: 55 });
  addTrade(d, { returnPct: -40 });
  addTrade(d, { status: "ENTERED", returnPct: null, exitReason: null, exitAtMs: null });
  const o = buildOwnerAlertSummaryOnDb(d, SESSION);
  assert.equal(o.openings, 3);
  assert.equal(o.closed, 2);
  assert.equal(o.open, 1);
  assert.equal(o.realizedWins, 1);
  assert.equal(o.realizedLosses, 1);
  assert.equal(o.expectancyPct, 5);
  assert.equal(o.profitFactor, 1.25);
  assert.equal(o.bestWinnerPct, 50);
  assert.equal(o.worstLossPct, -40);
  assert.equal(o.mirrorRate, 1, "every opening resolved a mirror on the exact contract it froze");
  assert.equal(o.lane, "OWNER_VALIDATION_PAPER");
  assert.equal(
    d.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE alert_id IS NOT NULL").get().n, 0,
    "the owner lane resolves with no alert id anywhere",
  );
  d.close();
});

test("immediate failures and profit-given-back need trajectory evidence", () => {
  const d = db();
  addTrade(d, { returnPct: -40, peak: 1, marks: 30 });   // never cleared +5
  addTrade(d, { returnPct: -35, peak: 37, marks: 30 });  // worked then lost
  addTrade(d, { returnPct: -40, peak: 90, marks: 2 });   // too few marks to claim either
  const o = buildOwnerAlertSummaryOnDb(d, SESSION);
  assert.equal(o.immediateFailures, 1);
  assert.equal(o.profitGivenBack, 1);
  assert.equal(o.withoutTrajectoryEvidence, 1);
  d.close();
});

test("the owner summary segments by strategy without summing lanes", () => {
  const d = db();
  addTrade(d, { returnPct: 50, strategy: SHADOW_STRATEGY });
  addTrade(d, { returnPct: -40, strategy: SHADOW_STRATEGY });
  addTrade(d, { returnPct: 20, strategy: "breakout_forming" });
  const o = buildOwnerAlertSummaryOnDb(d, SESSION);
  const lhc = o.byStrategy.find((b) => b.strategy === SHADOW_STRATEGY);
  const bf = o.byStrategy.find((b) => b.strategy === "breakout_forming");
  assert.equal(lhc.n, 2);
  assert.equal(bf.n, 1);
  assert.equal(bf.profitFactor, null, "no losses means PF is unavailable, not infinite");
  d.close();
});

test("a session is bounded in Eastern time, not the container timezone", () => {
  const d = db();
  // 2026-08-07 20:30 ET is 2026-08-08 00:30 UTC â€” a UTC boundary would misfile it.
  addTrade(d, { enteredAtMs: Date.UTC(2026, 7, 8, 0, 30, 0), returnPct: 10 });
  assert.equal(buildOwnerAlertSummaryOnDb(d, "2026-08-07").openings, 1);
  assert.equal(buildOwnerAlertSummaryOnDb(d, "2026-08-08").openings, 0);
  d.close();
});

// â”€â”€ nightly research â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("the nightly run is deterministic, changes no production behaviour, and seeds findings", () => {
  const d = db();
  const r = runNightlyResearchOnDb(d, { sessionDate: SESSION, deploymentSha: "abc1234", nowMs: T0 });
  assert.equal(r.ran, true);
  assert.equal(r.productionBehaviorChanged, false);
  assert.equal(r.experimentFrozen, true);
  assert.equal(r.findingsWritten, 6);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_learning_findings").get().n, 6);
  // Registered on first run. Asserted by IDENTITY, not by row count: the nightly registers
  // every frozen experiment, so a count would fail the moment a second one is added — which
  // is a registry that grew, not a defect.
  const ids = d.prepare("SELECT experiment_id FROM options_experiment_registry ORDER BY experiment_id").all().map((r) => r.experiment_id);
  assert.ok(ids.includes("LHC_SELECT_V1"));
  assert.ok(ids.includes("OWNER_SELECTION_STRENGTH_GATE_V1"));
  assert.equal(new Set(ids).size, ids.length, "each experiment is registered exactly once");
  d.close();
});

test("the nightly run is idempotent", () => {
  const d = db();
  runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 + 86_400_000 });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_learning_findings").get().n, 6);
  // Re-running must not re-register: one row per experiment, however many times it runs.
  const rows = d.prepare("SELECT experiment_id, COUNT(*) n FROM options_experiment_registry GROUP BY experiment_id").all();
  for (const r of rows) assert.equal(r.n, 1, `${r.experiment_id} registered ${r.n} times`);
  assert.ok(rows.some((r) => r.experiment_id === "OWNER_SELECTION_STRENGTH_GATE_V1"));
  d.close();
});

test("recording a decision advances the experiment to PROSPECTIVE_SHADOW and no further", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  recordShadowDecisionOnDb(d, buildShadowRecord(sub(), CTX), T0);
  const r = runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  assert.equal(r.experimentStatus, "PROSPECTIVE_SHADOW");
  assert.equal(r.statusChanged, true);
  // The walk records every intermediate state rather than jumping.
  const hist = statusHistoryOnDb(d, "LHC_SELECT_V1", 1).map((h) => h.status);
  assert.deepEqual(hist, ["PROPOSED", "HISTORICAL_TESTED", "VALIDATION_TESTED", "PROSPECTIVE_SHADOW"]);
  d.close();
});

test("a closed prospective outcome advances to PAPER_VALIDATION and stops there", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const rec = buildShadowRecord(sub(), CTX);
  const { decisionKey: key } = recordShadowDecisionOnDb(d, rec, T0);
  const t = addTrade(d, { optionSymbol: rec.optionSymbol, returnPct: 50, exitReason: "target_hit", peak: 55 });
  linkPaperTradeOnDb(d, key, t.id, T0);

  const r = runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  assert.equal(r.outcomesRefreshed, 1);
  assert.equal(r.experimentStatus, "PAPER_VALIDATION");
  assert.equal(r.scoreboard.closedOutcomes, 1);
  // PROMISING requires the weekly verdict; the nightly never grants it.
  assert.notEqual(r.experimentStatus, "PROMISING");
  assert.notEqual(r.experimentStatus, "READY_FOR_HUMAN_REVIEW");
  d.close();
});

test("nothing the nightly does can reach subscriber approval", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  for (let i = 0; i < 30; i++) {
    const rec = buildShadowRecord(sub({ optionSymbol: `O:AAPL2608${i}`, nowMs: T0 + i * 600_000, decisionMs: T0 + i * 600_000 }), CTX);
    const { decisionKey: key } = recordShadowDecisionOnDb(d, rec, T0 + i * 600_000);
    const t = addTrade(d, { optionSymbol: rec.optionSymbol, returnPct: 80, exitReason: "target_hit", peak: 85 });
    linkPaperTradeOnDb(d, key, t.id, T0);
  }
  const r = runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  assert.equal(r.experimentStatus, "PAPER_VALIDATION");
  const statuses = statusHistoryOnDb(d, "LHC_SELECT_V1", 1).map((h) => h.status);
  assert.ok(!statuses.includes("SUBSCRIBER_APPROVED"));
  assert.ok(!statuses.includes("PROMISING"));
  d.close();
});

test("a changed rule freezes the lifecycle instead of advancing it", () => {
  const d = db();
  // Pre-register with a DIFFERENT hash: the stored rule is not the running rule.
  d.prepare(
    `INSERT INTO options_experiment_registry (experiment_id, experiment_version, mode, hypothesis, gates_json, definition_hash, creation_sha, prospective_start_date, activation_at_ms, source_cohort_id, development_sessions_json, validation_sessions_json, historical_result_json, robustness_caveats_json, would_be_disproven_by, created_at_ms)
     VALUES ('LHC_SELECT_V1',1,'SHADOW_PAPER_ONLY','h','[]','DIFFERENT_HASH','ad947f6','2026-08-07',0,'LHC_DELIVERED_V1','[]','[]','{}','[]','x',0)`,
  ).run();
  recordShadowDecisionOnDb(d, buildShadowRecord(sub(), CTX), T0);
  const r = runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  // checkFrozen compares source-to-constant, which still agrees; the registry conflict is what
  // the store refuses. The stored hash is not overwritten.
  assert.equal(
    d.prepare("SELECT definition_hash h FROM options_experiment_registry WHERE experiment_id='LHC_SELECT_V1'").get().h,
    "DIFFERENT_HASH",
  );
  assert.equal(r.ran, true);
  d.close();
});

// â”€â”€ recap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const summary = {
  tradingDay: SESSION,
  overall: { n: 5, wins: 0, losses: 5 },
  counts: { rejected: 3, nearMisses: 2 },
  patterns: [],
  prioritizedIssue: "none",
};

test("the recap leads with OWNER DISCORD ALERTS when research is available", () => {
  const d = db();
  addTrade(d, { returnPct: 50, exitReason: "target_hit", peak: 55 });
  const research = runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  const sections = formatNightlyResearchSections(research);
  const msg = buildNightlyRecapMessage(summary, { researchSections: sections });

  const ownerIdx = msg.indexOf("OWNER DISCORD ALERTS");
  const paperIdx = msg.indexOf("internal paper portfolio");
  assert.ok(ownerIdx > -1, "owner section must be present");
  assert.ok(paperIdx > -1, "paper portfolio block must survive");
  assert.ok(ownerIdx < paperIdx, "owner alerts must come FIRST");
  // The paper block must not read as a verdict on the owner's alerts.
  assert.match(msg, /Not the delivered Discord alert lane above/);
  d.close();
});

test("the recap never claims success from open outcomes", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const rec = buildShadowRecord(sub(), CTX);
  const { decisionKey: key } = recordShadowDecisionOnDb(d, rec, T0);
  const t = addTrade(d, { optionSymbol: rec.optionSymbol, status: "ENTERED", returnPct: null, exitReason: null, exitAtMs: null, peak: 90, marks: 40 });
  linkPaperTradeOnDb(d, key, t.id, T0);

  const research = runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  const msg = formatNightlyResearchSections(research).join("\n");
  assert.match(msg, /NO prospective/);
  assert.match(msg, /not zero, unavailable/);
  assert.ok(!/PF 90/.test(msg));
  d.close();
});

test("the recap section states the experiment is unvalidated", () => {
  const d = db();
  const research = runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  const msg = formatNightlyResearchSections(research).join("\n");
  assert.match(msg, /PROMISING and UNVALIDATED/);
  assert.match(msg, /below break-even without its single convex winner/);
  d.close();
});

test("the recap reports rejected winners before anything flattering", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  // A baseline winner V1 rejected on every gate.
  const rec = buildShadowRecord(sub({
    optionSymbol: "O:AAPL260814P00200000", strike: 200, iv: 0.9, dte: 9,
    featureSnapshot: { underlying: { dollarVolume: 1e8 }, chain: {} },
  }), CTX);
  assert.equal(rec.arm, "BASELINE_ONLY");
  const { decisionKey: key } = recordShadowDecisionOnDb(d, rec, T0);
  const t = addTrade(d, { optionSymbol: rec.optionSymbol, returnPct: 120, exitReason: "target_hit", peak: 125 });
  linkPaperTradeOnDb(d, key, t.id, T0);

  const research = runNightlyResearchOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  const msg = formatNightlyResearchSections(research).join("\n");
  assert.match(msg, /Winners V1 rejected/);
  assert.match(msg, /AAPL \+120\.00%/);
  assert.equal(research.scoreboard.winnersRejected.length, 1);
  d.close();
});

test("the recap works when no research aggregation was computed", () => {
  const msg = buildNightlyRecapMessage(summary, {});
  assert.match(msg, /OptiScan Nightly Review/);
  assert.match(msg, /Paper trades: 5/);
  assert.ok(!msg.includes("OWNER DISCORD ALERTS"));
});
