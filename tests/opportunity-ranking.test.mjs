/**
 * tests/opportunity-ranking.test.mjs
 *
 * Opportunity cases persisted rank=null, rankExplanation=null and rejectedContracts=[],
 * so "why did 774P beat 770P" was structurally unanswerable from stored evidence. These
 * tests pin the ranking objective's three load-bearing properties:
 *
 *   1. missing data is never scored as zero;
 *   2. it never overrides directional authority or hard gates;
 *   3. the comparison is persisted and explainable, winner and runners-up alike.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  rankOne,
  rankOpportunities,
  explainOutranking,
  persistRankBreakdownOnDb,
  RANKING_VERSION,
  COMPONENT_WEIGHTS,
  PENALTY_WEIGHTS,
} from "../lib/research/options/opportunity-ranking.ts";
import { getStrategy } from "../lib/research/options/strategy-catalog.ts";

const base = (over = {}) => ({
  candidateId: "c1",
  symbol: "SPY",
  strategy: "lower_high_continuation",
  direction: "bearish",
  side: "put",
  optionSymbol: "O:SPY260807P00770000",
  strategyScore: 1,
  fractionMove: 0.2,
  rewardRemainingPct: 35,
  invalidationDistancePct: 6,
  premiumExpansionPct: 3,
  candidateAgeMs: 60_000,
  relVolume: 2,
  levelProximityPct: 0.3,
  compression: true,
  marketAligned: true,
  sectorAligned: true,
  hasCatalyst: false,
  bid: 2.21,
  ask: 2.22,
  spreadPct: 0.45,
  quoteAgeMs: 2_000,
  delta: -0.456,
  gamma: 0.04,
  iv: 0.22,
  thetaPerDayPct: 6,
  dte: 1,
  openInterest: 10786,
  optionVolume: 42816,
  expectedMovePct: 1.1,
  estimatedCapacity: 200,
  strategyDef: getStrategy("lower_high_continuation"),
  authoritativeDirection: null,
  hardBlockers: [],
  ...over,
});

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE opportunity_rank_breakdown (
      id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL, ranking_version TEXT NOT NULL,
      symbol TEXT NOT NULL, session_date TEXT, strategy TEXT, direction TEXT, option_symbol TEXT,
      rank INTEGER NOT NULL, is_selected INTEGER NOT NULL DEFAULT 0, total_score REAL,
      components_json TEXT, penalties_json TEXT, unavailable_json TEXT, hard_blockers_json TEXT,
      outranked_reason TEXT, rejected_reason TEXT, created_at_ms INTEGER NOT NULL
    );
  `);
  return d;
}

// ── Missing data must never become zero ─────────────────────────────────────

test("a missing component is excluded from the mean, not scored as zero", () => {
  const full = rankOne(base());
  const missing = rankOne(base({ gamma: null, iv: null, expectedMovePct: null }));
  assert.ok(missing.unavailable.includes("gammaForHorizon"));
  assert.ok(missing.unavailable.includes("moveCoverage"));
  // If missing were treated as zero the score would COLLAPSE. It should stay close.
  assert.ok(
    Math.abs((missing.totalScore ?? 0) - (full.totalScore ?? 0)) < 0.12,
    `missing evidence must not crater the score: ${missing.totalScore} vs ${full.totalScore}`,
  );
  assert.ok(missing.evidenceCompleteness < full.evidenceCompleteness, "but completeness must drop");
});

test("evidence completeness is evidence strength, not probability of profit", () => {
  const r = rankOne(base());
  assert.equal(r.evidenceCompleteness, 1, "every component present");
  const sparse = rankOne(base({ compression: null, hasCatalyst: null, marketAligned: null, sectorAligned: null }));
  assert.ok(sparse.evidenceCompleteness < 1);
  // Completeness is independent of how good the setup is.
  assert.notEqual(sparse.evidenceCompleteness, sparse.totalScore);
});

test("missing EXECUTION evidence is penalised; missing nice-to-haves are not", () => {
  const noExec = rankOne(base({ spreadPct: null, openInterest: null, quoteAgeMs: null, delta: null }));
  assert.ok(noExec.penalties.some((p) => p.key === "missingCriticalEvidence"));
  const noCatalyst = rankOne(base({ hasCatalyst: null }));
  assert.ok(!noCatalyst.penalties.some((p) => p.key === "missingCriticalEvidence"));
});

// ── Hard gates and directional authority are never scored around ────────────

test("a direction conflicting with symbol authority is hard-blocked, not merely down-ranked", () => {
  const r = rankOne(base({ authoritativeDirection: "bullish" }));
  assert.equal(r.totalScore, null, "a blocked candidate has no score at all");
  assert.ok(r.hardBlockers.some((b) => b.startsWith("DIRECTION_CONFLICT")));
});

test("an excellent contract still loses to a hard blocker", () => {
  const great = base({ candidateId: "great", authoritativeDirection: "bullish" });
  const ordinary = base({ candidateId: "ordinary", strategyScore: 0.5, rewardRemainingPct: 12, spreadPct: 4 });
  const res = rankOpportunities([great, ordinary]);
  assert.equal(res.selected.candidateId, "ordinary");
  assert.equal(res.blocked.length, 1);
  assert.equal(res.blocked[0].candidateId, "great");
  assert.match(res.rejectedReasons[0].reason, /DIRECTION_CONFLICT/);
});

test("pre-existing hard blockers are preserved and fatal", () => {
  const r = rankOne(base({ hardBlockers: ["UNUSABLE_SPREAD_26.0"] }));
  assert.equal(r.totalScore, null);
  assert.deepEqual(r.hardBlockers, ["UNUSABLE_SPREAD_26.0"]);
  assert.equal(r.penalties.length, 0, "a blocked candidate is not also penalty-scored");
});

// ── Penalties express the failure modes the audit actually found ────────────

test("a spectacular-looking but untradeable lottery contract is penalised and explained", () => {
  const lottery = base({
    candidateId: "lottery",
    ask: 0.05, bid: 0.01, spreadPct: 80,
    delta: -0.04, openInterest: 12, estimatedCapacity: 3,
    levelProximityPct: 6, expectedMovePct: 1.1, thetaPerDayPct: 45,
  });
  const sane = base({ candidateId: "sane" });
  const res = rankOpportunities([lottery, sane]);
  assert.equal(res.selected.candidateId, "sane");
  const l = res.runnersUp.find((r) => r.candidateId === "lottery");
  const keys = l.penalties.map((p) => p.key);
  for (const expected of ["wideSpread", "lotteryDistance", "thetaBurn", "poorCapacity"]) {
    assert.ok(keys.includes(expected), `expected penalty ${expected}, got ${keys.join(",")}`);
  }
  assert.match(res.outrankedReasons[0].reason, /vs/);
});

test("premium chase is measured against the strategy's own chase limit", () => {
  const def = getStrategy("lower_high_continuation");
  const overLimit = rankOne(base({ premiumExpansionPct: def.chaseLimitPct * 100 + 40 }));
  assert.ok(overLimit.penalties.some((p) => p.key === "premiumChase"));
  const underLimit = rankOne(base({ premiumExpansionPct: 1 }));
  assert.ok(!underLimit.penalties.some((p) => p.key === "premiumChase"));
});

test("weak reward remaining and late detection are penalised", () => {
  const r = rankOne(base({ rewardRemainingPct: 4, candidateAgeMs: 40 * 60_000 }));
  const keys = r.penalties.map((p) => p.key);
  assert.ok(keys.includes("weakRewardRemaining"));
  assert.ok(keys.includes("lateDetection"));
});

test("an earlier entry outranks an identical but later one", () => {
  const early = base({ candidateId: "early", fractionMove: 0.1, rewardRemainingPct: 45 });
  const late = base({ candidateId: "late", fractionMove: 0.8, rewardRemainingPct: 8 });
  const res = rankOpportunities([late, early]);
  assert.equal(res.selected.candidateId, "early");
});

// ── Determinism, explanation, persistence ───────────────────────────────────

test("ranking is deterministic and totally ordered, with no positional tie-break luck", () => {
  const a = base({ candidateId: "aaa" });
  const b = base({ candidateId: "bbb" });
  const first = rankOpportunities([a, b]);
  const reversed = rankOpportunities([b, a]);
  assert.equal(first.selected.candidateId, reversed.selected.candidateId,
    "input order must not decide the winner");
  assert.equal(first.selected.candidateId, "aaa", "ties break on candidateId, deterministically");
});

test("the winner's margin over each runner-up names the components responsible", () => {
  const winner = rankOne(base({ candidateId: "w", spreadPct: 0.4, openInterest: 20000 }));
  const loser = rankOne(base({ candidateId: "l", spreadPct: 9, openInterest: 50 }));
  const why = explainOutranking(winner, loser);
  assert.match(why, /stronger on/);
  assert.ok(/spread|liquidity/.test(why), `expected spread/liquidity in: ${why}`);
});

test("the whole comparison is persisted — winner, runners-up and blocked alike", () => {
  const d = db();
  const res = rankOpportunities([
    base({ candidateId: "win" }),
    base({ candidateId: "second", spreadPct: 5, rewardRemainingPct: 15 }),
    base({ candidateId: "blocked", authoritativeDirection: "bullish" }),
  ]);
  const { written } = persistRankBreakdownOnDb(d, {
    decisionId: "dec_1", symbol: "SPY", sessionDate: "2026-08-06", result: res, nowMs: 1,
  });
  assert.equal(written, 3);
  const rowsOut = d.prepare("SELECT * FROM opportunity_rank_breakdown ORDER BY is_selected DESC, rank").all();
  assert.equal(rowsOut.length, 3);
  assert.equal(rowsOut[0].is_selected, 1);
  assert.equal(rowsOut[0].ranking_version, RANKING_VERSION);
  assert.ok(JSON.parse(rowsOut[0].components_json).length > 0, "component scores are stored");
  const blocked = rowsOut.find((r) => r.option_symbol && JSON.parse(r.hard_blockers_json).length);
  assert.ok(blocked, "the blocked candidate is stored too");
  assert.match(blocked.rejected_reason, /DIRECTION_CONFLICT/);
  const runner = rowsOut.find((r) => r.outranked_reason);
  assert.ok(runner, "the runner-up carries the reason it lost");
});

test("weights are declared constants and sum to a sane total", () => {
  const total = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `component weights should sum to 1, got ${total}`);
  assert.ok(Object.keys(PENALTY_WEIGHTS).length >= 8);
  // Execution reality must not be a rounding error next to setup quality: the audited
  // population failed on execution, not on setup recognition.
  const exec = COMPONENT_WEIGHTS.spread + COMPONENT_WEIGHTS.liquidity
    + COMPONENT_WEIGHTS.quoteFreshness + COMPONENT_WEIGHTS.capacity + COMPONENT_WEIGHTS.premiumRealism;
  const setup = COMPONENT_WEIGHTS.strategyFit + COMPONENT_WEIGHTS.earliness
    + COMPONENT_WEIGHTS.rewardRemaining + COMPONENT_WEIGHTS.levelProximity + COMPONENT_WEIGHTS.compression;
  assert.ok(exec >= setup, `execution ${exec} should not be weighted below setup ${setup}`);
});

test("an empty candidate set yields no selection rather than throwing", () => {
  const res = rankOpportunities([]);
  assert.equal(res.selected, null);
  assert.deepEqual(res.runnersUp, []);
  assert.deepEqual(res.outrankedReasons, []);
});
