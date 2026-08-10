/**
 * tests/cohort-probability.test.mjs
 *
 * HISTORICAL_COHORT_V1. The whole module exists to make one refusal automatic:
 *
 *     AI CONFIDENCE IS NOT A PROBABILITY, AND NEITHER IS A SMALL SAMPLE.
 *
 * So most of these tests assert that a number is ABSENT. That is the point — the
 * failure this guards against is a rate computed off four trades being quoted as
 * "P(+50%) = 75%", and the only defence is that the rate never exists.
 *
 * The two admission rules are deliberately different and are tested apart: trajectory
 * claims need a VERIFIED excursion, realized claims need only a verified closed
 * outcome. Requiring the stronger evidence for the weaker claim would discard realized
 * returns that reconcile perfectly.
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  loadCohortMembersOnDb,
  selectCohort,
  computeCohortStatistics,
  cohortIdFor,
  dteBucketOf,
  moneynessBucketOf,
  MIN_TRADES_FOR_PROBABILITY,
  MIN_SESSIONS_FOR_PROBABILITY,
} from "../lib/research/options/cohort-probability.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const T0 = Date.parse("2026-08-03T14:00:00.000Z");
const DAY = 86_400_000;

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

let seq = 0;
/**
 * One closed mirror with same-contract marks.
 * `marks` drives the excursion; `returnPct`/`status` drive the realized outcome.
 */
function seedTrade(d, {
  sessionDate, returnPct = 20, status = "EXITED", marks = [-5, 20, 35],
  strategy = "breakout", side = "call", dte = 4, symbol = "NVDA",
} = {}) {
  seq += 1;
  const caseId = `oc_${seq}`;
  const alertId = `oa_${seq}`;
  const occ = `O:${symbol}2608${String(10 + (seq % 20)).padStart(2, "0")}C00${100 + seq}000`;
  const atMs = T0 + seq * 60_000;

  d.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
        delivery_decision, case_json, created_at_ms, updated_at_ms, alert_id, session_date)
     VALUES (?,?,?,'scanner','accepted','delivered','{}',?,?,?,?)`,
  ).run(caseId, symbol, atMs, atMs, atMs, alertId, sessionDate);

  const info = d.prepare(
    `INSERT INTO options_paper_trades
       (option_symbol, side, strike, expiration, dte, result_class, entry_fill, status, return_pct,
        strategy, paper_kind, alert_id, created_at_ms, updated_at_ms)
     VALUES (?,?,180,'2026-08-14',?,'REAL_OPTION_PAPER',2.0,?,?,?,'DELIVERED_ALERT_PAPER',?,?,?)`,
  ).run(occ, side, dte, status, status === "EXITED" ? returnPct : null, strategy, alertId, atMs, atMs);

  marks.forEach((ret, i) => {
    d.prepare(
      `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms)
       VALUES (?,?,?,?,?)`,
    ).run(Number(info.lastInsertRowid), occ, atMs + (i + 1) * 60_000, ret, atMs);
  });
  return caseId;
}

/** N trades spread over `sessions` distinct session dates. */
function seedPopulation(d, { trades, sessions, marks, returnPct }) {
  for (let i = 0; i < trades; i++) {
    const day = new Date(T0 + (i % sessions) * DAY).toISOString().slice(0, 10);
    seedTrade(d, {
      sessionDate: day,
      marks: typeof marks === "function" ? marks(i) : marks,
      returnPct: typeof returnPct === "function" ? returnPct(i) : returnPct,
    });
  }
}

const stats = (d, key = {}) => computeCohortStatistics(selectCohort(loadCohortMembersOnDb(d, {}), key), key);

test("a small sample yields counts but never a probability", () => {
  const d = db();
  // Three marks each — genuinely VERIFIED excursions, just four of them.
  seedPopulation(d, { trades: 4, sessions: 2, marks: [-5, 30, 60], returnPct: 55 });
  const s = stats(d);

  assert.equal(s.excursionSample.verdict, "INSUFFICIENT_EVIDENCE");
  const p50 = s.milestoneProbabilities.find((m) => m.milestone === 50);
  // The COUNT is a true statement about four trades and is reported.
  assert.equal(p50.of, 4);
  assert.equal(p50.reached, 4);
  // The RATE is not, and does not exist.
  assert.equal(p50.probability, null, "3-of-4 must never become P(+50%) = 0.75");
  assert.equal(s.expectedMfePct, null);
  assert.equal(s.profitFactor, null);
});

test("enough trades across too few sessions is still insufficient", () => {
  const d = db();
  // 24 trades, all from ONE morning. Twenty trades from one market is one observation.
  seedPopulation(d, { trades: 24, sessions: 1, marks: [-5, 20, 60], returnPct: 30 });
  const s = stats(d);

  assert.ok(s.excursionSample.trades >= MIN_TRADES_FOR_PROBABILITY);
  assert.equal(s.excursionSample.independentSessions, 1);
  assert.equal(s.excursionSample.verdict, "INSUFFICIENT_EVIDENCE");
  assert.ok(
    s.excursionSample.reason.includes(String(MIN_SESSIONS_FOR_PROBABILITY)),
    "the refusal names the floor it failed",
  );
  assert.equal(s.milestoneProbabilities[0].probability, null);
});

test("clearing BOTH floors produces real empirical rates", () => {
  const d = db();
  // 25 trades over 5 sessions. Every third one runs to +60%.
  seedPopulation(d, {
    trades: 25, sessions: 5,
    marks: (i) => (i % 3 === 0 ? [-5, 30, 60] : [-8, 5, 12]),
    returnPct: (i) => (i % 3 === 0 ? 55 : -20),
  });
  const s = stats(d);

  assert.equal(s.excursionSample.verdict, "SUPPORTED");
  assert.equal(s.realizedSample.verdict, "SUPPORTED");
  assert.equal(s.sessions.length, 5);

  const p50 = s.milestoneProbabilities.find((m) => m.milestone === 50);
  assert.equal(p50.reached, 9, "9 of 25 printed a same-contract mark at or above +50%");
  assert.equal(p50.probability, 0.36);
  const p10 = s.milestoneProbabilities.find((m) => m.milestone === 10);
  assert.equal(p10.probability, 1, "every trade reached +10% at some point");

  assert.ok(s.expectedMfePct != null && s.profitFactor != null);
  assert.ok(s.winRate != null && s.winRate > 0 && s.winRate < 1);
});

test("an unverified excursion is excluded from trajectory but keeps its realized outcome", () => {
  const d = db();
  // 25 realized outcomes over 5 sessions, but only two marks each — never enough to
  // claim an extreme. Realized is one observation and stands on its own.
  seedPopulation(d, { trades: 25, sessions: 5, marks: [-5, 40], returnPct: 33 });
  const s = stats(d);

  assert.equal(s.excursionSample.trades, 0, "two marks cannot support a maximum");
  assert.equal(s.excursionSample.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(s.expectedMfePct, null);

  // The realized half is untouched — this is the failure mode that suppressed dozens of
  // sound returns in order to avoid one false peak.
  assert.equal(s.realizedSample.verdict, "SUPPORTED");
  assert.equal(s.expectedRealizedReturnPct, 33);
  assert.equal(s.winRate, 1);
});

test("an open trade contributes no realized outcome and no zero", () => {
  const d = db();
  seedPopulation(d, { trades: 25, sessions: 5, marks: [-5, 20, 60], returnPct: 40 });
  for (let i = 0; i < 10; i++) {
    seedTrade(d, { sessionDate: "2026-08-09", status: "ENTERED", marks: [-2, 3, 8] });
  }
  const s = stats(d);
  assert.equal(s.realizedSample.trades, 25, "the ten open trades are not realized outcomes");
  assert.equal(s.expectedRealizedReturnPct, 40, "and they do not drag the expectancy toward zero");
});

test("tail dependence is reported beside the profit factor, not instead of it", () => {
  const d = db();
  // One enormous winner carrying an otherwise losing set.
  seedPopulation(d, {
    trades: 25, sessions: 5,
    marks: [-20, 5],
    returnPct: (i) => (i === 0 ? 900 : -20),
  });
  const s = stats(d);
  assert.equal(s.realizedSample.verdict, "SUPPORTED");
  assert.ok(s.profitFactor > 1, "the set looks profitable");
  assert.equal(s.profitFactorWithoutTopWinner, 0, "and it is entirely one trade");
  assert.ok(s.tailFrequency > 0);
});

test("a null in the cohort key means do-not-cut, not match-missing", () => {
  const d = db();
  seedTrade(d, { sessionDate: "2026-08-03", strategy: "breakout" });
  seedTrade(d, { sessionDate: "2026-08-04", strategy: "lower_high" });
  const all = loadCohortMembersOnDb(d, {});

  assert.equal(selectCohort(all, {}).length, 2, "an empty key selects everything");
  assert.equal(selectCohort(all, { strategyKey: null }).length, 2, "an explicit null does not filter");
  assert.equal(selectCohort(all, { strategyKey: "breakout" }).length, 1);
  // Every member here HAS a discovery stage of null (no pre-move row). Cutting on a
  // stage must select none of them rather than all of them.
  assert.equal(selectCohort(all, { discoveryStage: "PRE_TRIGGER" }).length, 0);
});

test("the cohort id is stable and order-independent", () => {
  const a = cohortIdFor({ side: "CALL", strategyKey: "breakout", dteBucket: null });
  const b = cohortIdFor({ strategyKey: "breakout", side: "CALL" });
  assert.equal(a, b, "the same cut is the same cohort however the key was written");
  assert.ok(a.startsWith("HISTORICAL_COHORT_V1:"), "the id carries its version");
  assert.equal(cohortIdFor({}), "HISTORICAL_COHORT_V1:ALL");
});

test("an empty database refuses cleanly instead of throwing", () => {
  const d = db();
  const s = stats(d);
  assert.equal(s.excursionSample.trades, 0);
  assert.equal(s.realizedSample.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(s.expectedRealizedReturnPct, null);
  assert.deepEqual(s.sessions, []);
  assert.ok(s.limitations.length > 0, "the limitations travel with the result");
});

test("bucket helpers are total: absent inputs bucket to null, never to a default", () => {
  assert.equal(dteBucketOf(null), null);
  assert.equal(dteBucketOf(0), "0DTE");
  assert.equal(dteBucketOf(30), "22DTE+");
  assert.equal(moneynessBucketOf(null), null);
  assert.equal(moneynessBucketOf(0.4), "ATM");
  assert.equal(moneynessBucketOf(-0.4), "ATM", "moneyness is bucketed by distance, not by sign");
  assert.equal(moneynessBucketOf(20), "FAR_OTM");
});

// ── the pooling trap ─────────────────────────────────────────────────────────
//
// Measured live at 4beb355: the ALL cohort reported profit factor 0.5246 over 642
// "verified realized outcomes". Those 642 spanned DELIVERED_ALERT_PAPER,
// OWNER_VALIDATION_PAPER, RESEARCH_ONLY_PAPER and ZERO_DTE_RESEARCH_PAPER — four lanes
// with different gates, audiences and selection rules that have never coexisted as one
// tradeable population. The number is arithmetically correct and describes nothing.

function seedLaneTrade(d, { sessionDate, paperKind, returnPct }) {
  seq += 1;
  const alertId = `oa_lane_${seq}`;
  const occ = `O:X2608${String(10 + (seq % 20)).padStart(2, "0")}C00${100 + seq}000`;
  const atMs = T0 + seq * 60_000;
  d.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
        delivery_decision, case_json, created_at_ms, updated_at_ms, alert_id, session_date)
     VALUES (?,?,?,'scanner','accepted','delivered','{}',?,?,?,?)`,
  ).run(`oc_lane_${seq}`, "X", atMs, atMs, atMs, alertId, sessionDate);
  d.prepare(
    `INSERT INTO options_paper_trades
       (option_symbol, side, strike, expiration, dte, result_class, entry_fill, status, return_pct,
        strategy, paper_kind, alert_id, created_at_ms, updated_at_ms)
     VALUES (?,'call',180,'2026-08-14',4,'REAL_OPTION_PAPER',2.0,'EXITED',?,'s',?,?,?,?)`,
  ).run(occ, returnPct, paperKind, alertId, atMs, atMs);
}

test("a cohort spanning lanes says so, and the per-lane figures disagree with the pooled one", () => {
  const d = db();
  // A profitable delivered lane and an unprofitable research lane.
  for (let i = 0; i < 25; i++) {
    const day = new Date(T0 + (i % 5) * DAY).toISOString().slice(0, 10);
    seedLaneTrade(d, { sessionDate: day, paperKind: "DELIVERED_ALERT_PAPER", returnPct: 60 });
    seedLaneTrade(d, { sessionDate: day, paperKind: "RESEARCH_ONLY_PAPER", returnPct: -40 });
  }
  const all = loadCohortMembersOnDb(d, {});

  const pooled = computeCohortStatistics(selectCohort(all, {}), {});
  assert.equal(pooled.pooledAcrossLanes, true);
  assert.equal(pooled.lanesIncluded.length, 2);
  assert.ok(
    pooled.limitations.some((l) => l.includes("POOLED ACROSS")),
    "the pooled figure carries its own refutation",
  );

  const delivered = computeCohortStatistics(
    selectCohort(all, { paperKind: "DELIVERED_ALERT_PAPER" }),
    { paperKind: "DELIVERED_ALERT_PAPER" },
  );
  const research = computeCohortStatistics(
    selectCohort(all, { paperKind: "RESEARCH_ONLY_PAPER" }),
    { paperKind: "RESEARCH_ONLY_PAPER" },
  );

  assert.equal(delivered.pooledAcrossLanes, false);
  assert.equal(delivered.winRate, 1, "the delivered lane never lost");
  assert.equal(research.winRate, 0, "the research lane never won");
  // The pooled win rate is 0.5 — a rate belonging to neither lane and to no strategy
  // anyone could have traded.
  assert.equal(pooled.winRate, 0.5);
  assert.notEqual(pooled.winRate, delivered.winRate);
  assert.notEqual(pooled.winRate, research.winRate);
});

test("a single-lane cohort states its lane instead of a pooling warning", () => {
  const d = db();
  for (let i = 0; i < 25; i++) {
    seedLaneTrade(d, {
      sessionDate: new Date(T0 + (i % 5) * DAY).toISOString().slice(0, 10),
      paperKind: "OWNER_VALIDATION_PAPER", returnPct: 15,
    });
  }
  const s = computeCohortStatistics(
    selectCohort(loadCohortMembersOnDb(d, {}), { paperKind: "OWNER_VALIDATION_PAPER" }),
    { paperKind: "OWNER_VALIDATION_PAPER" },
  );
  assert.equal(s.pooledAcrossLanes, false);
  assert.deepEqual(s.lanesIncluded, ["OWNER_VALIDATION_PAPER"]);
  assert.ok(s.limitations.some((l) => l.startsWith("Single lane:")));
  assert.ok(s.cohortId.includes("paperKind=OWNER_VALIDATION_PAPER"), "the lane is part of the cohort identity");
});
