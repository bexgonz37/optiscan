/**
 * Checkpoint 2 — verified-only quant, mark quality, and shadow brackets.
 *
 * The failure these guard against is specific and already happened: official
 * performance was computed over a population the verifier had thrown out, and
 * horizon conclusions were drawn from one mark repeated seven times.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVerification, buildExclusionBreakdown, officialRowsOnly,
  VERIFICATION_STATUSES, OFFICIAL_STATUS, VERIFICATION_VERSION,
} from "../lib/research/options/trade-verification.ts";
import {
  classifyMarkSeries, summarizeMarkSeries, excursionsFromIndependent,
  isIndependent, MARK_QUALITY_STATUSES, INDEPENDENT_STATUSES,
  MIN_INDEPENDENT_RATE_FOR_HORIZON_ANALYSIS, MARK_VERSION,
} from "../lib/research/options/mark-quality.ts";
import {
  CANDIDATE_POLICIES, bracketMath, simulatePolicy, evaluatePolicy,
  selectForwardTestPolicy, MIN_POLICY_SAMPLE, BRACKET_FRAMEWORK_VERSION,
} from "../lib/research/options/bracket-policy.ts";

// ── §1 verification ────────────────────────────────────────────────────────

const good = (over = {}) => ({
  subscriberDelivered: true, hasPaperMirror: true, paperRowCount: 1,
  entryValid: true, exitValid: true, markValid: true, hasReturn: true, ...over,
});

test("a fully proven row is the only thing that reaches official metrics", () => {
  const r = classifyVerification(good());
  assert.equal(r.status, "VERIFIED_GRADED");
  assert.equal(r.officialEligible, true);
  assert.equal(r.version, VERIFICATION_VERSION);
  assert.equal(OFFICIAL_STATUS, "VERIFIED_GRADED");
});

test("every exclusion cause maps to its own status", () => {
  assert.equal(classifyVerification(good({ auditOnly: true })).status, "AUDIT_ONLY");
  assert.equal(classifyVerification(good({ hasPaperMirror: false })).status, "MISSING_MIRROR");
  assert.equal(classifyVerification(good({ paperRowCount: 2 })).status, "DUPLICATE");
  assert.equal(classifyVerification(good({ subscriberDelivered: false })).status, "AUDIT_ONLY");
  assert.equal(classifyVerification(good({ entryValid: false })).status, "UNVERIFIED_ENTRY");
  assert.equal(classifyVerification(good({ markValid: false })).status, "INVALID_OR_STALE_MARK");
  assert.equal(classifyVerification(good({ exitValid: false })).status, "UNVERIFIED_EXIT");
  assert.equal(classifyVerification(good({ hasReturn: false })).status, "UNGRADEABLE");
});

test("precedence is worst-cause-first so exclusions never double-count", () => {
  // Simultaneously duplicated, mirror-less and entry-less.
  const r = classifyVerification(good({ hasPaperMirror: false, paperRowCount: 3, entryValid: false }));
  assert.equal(r.status, "MISSING_MIRROR", "the most fundamental defect is reported");
});

test("a null fact is NOT PROVEN, never proven-good", () => {
  for (const k of ["subscriberDelivered", "hasPaperMirror", "entryValid", "exitValid", "markValid", "hasReturn"]) {
    const r = classifyVerification(good({ [k]: null }));
    assert.equal(r.officialEligible, false, `${k}=null must not be treated as verified`);
  }
});

test("every status is declared in the exhaustive list", () => {
  const seen = new Set([
    classifyVerification(good()).status,
    classifyVerification(good({ auditOnly: true })).status,
    classifyVerification(good({ hasPaperMirror: false })).status,
    classifyVerification(good({ paperRowCount: 2 })).status,
    classifyVerification(good({ entryValid: false })).status,
    classifyVerification(good({ markValid: false })).status,
    classifyVerification(good({ exitValid: false })).status,
    classifyVerification(good({ hasReturn: false })).status,
  ]);
  for (const s of seen) assert.ok(VERIFICATION_STATUSES.includes(s), `${s} must be declared`);
});

test("excluded rows never enter official metrics but stay visible with their P&L", () => {
  const rows = [
    { status: "VERIFIED_GRADED", pnlUsd: -100 },
    { status: "VERIFIED_GRADED", pnlUsd: 50 },
    { status: "DUPLICATE", pnlUsd: -9000 },
    { status: "INVALID_OR_STALE_MARK", pnlUsd: -60000 },
  ];
  const b = buildExclusionBreakdown(rows);
  assert.equal(b.total, 4);
  assert.equal(b.verified, 2);
  assert.equal(b.excluded, 2);
  assert.equal(b.verifiedPnlUsd, -50, "official P&L counts verified rows only");
  assert.equal(b.excludedPnlUsd, -69000, "excluded P&L is reported SEPARATELY, never netted in");
  assert.equal(b.byStatus.DUPLICATE, 1);
  assert.equal(officialRowsOnly(rows).length, 2);
});

test("a majority-unverified population is explicitly not quotable", () => {
  const rows = Array.from({ length: 553 }, (_, i) => ({
    status: i < 82 ? "VERIFIED_GRADED" : "INVALID_OR_STALE_MARK", pnlUsd: -1,
  }));
  const b = buildExclusionBreakdown(rows);
  assert.equal(b.verified, 82);
  assert.equal(b.excluded, 471, "matches the production split exactly");
  assert.equal(b.quotable, false);
  assert.match(b.note, /must never be quoted/);
});

test("quotable requires BOTH a verified majority and a minimum sample", () => {
  const tiny = buildExclusionBreakdown(Array.from({ length: 10 }, () => ({ status: "VERIFIED_GRADED", pnlUsd: 1 })));
  assert.equal(tiny.verifiedFraction, 1);
  assert.equal(tiny.quotable, false, "100% verified but only 10 rows is not quotable");
});

test("an empty population reports null, never 0%", () => {
  const b = buildExclusionBreakdown([]);
  assert.equal(b.verifiedFraction, null);
  assert.equal(b.verifiedPnlUsd, null);
  assert.equal(b.quotable, false);
});

// ── §2 mark quality ────────────────────────────────────────────────────────

const obs = (h, quoteAtMs, over = {}) => ({
  horizonMinutes: h, markObservedAtMs: quoteAtMs + 1000, quoteAtMs,
  optionSymbol: "O:NVDA260807C00200000", expectedOptionSymbol: "O:NVDA260807C00200000",
  bid: 3.0, ask: 3.1, ...over,
});

test("one quote reused across horizons is REUSED, not independent", () => {
  // The exact production pathology: 84.1% of series look like this.
  const res = classifyMarkSeries([1, 3, 5, 10, 15, 30, 60].map((h) => obs(h, 1_000_000)));
  assert.equal(res[0].status, "INDEPENDENT_FRESH", "the first observation is genuine");
  for (const r of res.slice(1)) {
    assert.equal(r.status, "REUSED_PRIOR_MARK");
    assert.equal(r.markIsIndependent, false);
    assert.equal(r.markReuseSourceHorizon, 1, "names the horizon it repeats");
    assert.equal(r.markSource, "CARRY_FORWARD");
  }
  const s = summarizeMarkSeries(res);
  assert.equal(s.independent, 1);
  assert.equal(s.reused, 6);
  assert.equal(s.degenerate, true);
  assert.equal(s.horizonsComparable, false, "no horizon claim is supportable from one observation");
});

test("reuse is detected by repeated TIMESTAMP, not repeated price", () => {
  // Two genuinely separate observations that happen to carry the same price on
  // a quiet contract must both count as independent.
  const res = classifyMarkSeries([obs(1, 1_000_000), obs(3, 1_180_000)]);
  assert.equal(res[0].markIsIndependent, true);
  assert.equal(res[1].markIsIndependent, true, "same price, different quote — still real evidence");
});

test("an independently observed but old quote is INDEPENDENT_STALE", () => {
  const res = classifyMarkSeries([obs(1, 1_000_000, { markObservedAtMs: 1_000_000 + 300_000 })]);
  assert.equal(res[0].status, "INDEPENDENT_STALE");
  assert.equal(res[0].markIsIndependent, true, "stale but still its own observation");
  assert.equal(res[0].markFreshnessMs, 300_000);
});

test("provider failures are classified apart from contract reality", () => {
  const mk = (reason) => classifyMarkSeries([obs(1, 1_000_000, { rejectedReason: reason })])[0].status;
  assert.equal(mk("PROVIDER_BUDGET"), "PROVIDER_BUDGET_BLOCKED");
  assert.equal(mk("PROVIDER_ERROR"), "PROVIDER_ERROR");
  assert.equal(mk("NO_QUOTE"), "NO_QUOTE");
  assert.equal(mk("NO_TWO_SIDED_MARKET"), "NO_QUOTE");
  assert.equal(mk("WRONG_OCC"), "WRONG_OCC");
  assert.equal(mk("FUTURE_QUOTE"), "INVALID_TIMESTAMP");
  for (const s of MARK_QUALITY_STATUSES) assert.equal(typeof s, "string");
});

test("a mark for the wrong contract is rejected even without a reason code", () => {
  const res = classifyMarkSeries([obs(1, 1_000_000, { optionSymbol: "O:AAPL260807C00200000" })]);
  assert.equal(res[0].status, "WRONG_OCC");
});

test("a backfilled mark is not independent evidence", () => {
  const res = classifyMarkSeries([obs(1, 1_000_000, { backfilled: true })]);
  assert.equal(res[0].status, "BACKFILLED");
  assert.equal(res[0].markIsIndependent, false);
  assert.equal(isIndependent("BACKFILLED"), false);
  assert.deepEqual([...INDEPENDENT_STATUSES], ["INDEPENDENT_FRESH", "INDEPENDENT_STALE"]);
});

test("a varied series is comparable across horizons", () => {
  const res = classifyMarkSeries([1, 3, 5, 10].map((h, i) => obs(h, 1_000_000 + i * 200_000)));
  const s = summarizeMarkSeries(res);
  assert.equal(s.independent, 4);
  assert.equal(s.horizonsComparable, true);
  assert.ok(s.independentRate >= MIN_INDEPENDENT_RATE_FOR_HORIZON_ANALYSIS);
  assert.equal(res[0].version, MARK_VERSION);
});

test("excursions use independent observations only, and one point is not an excursion", () => {
  const res = classifyMarkSeries([1, 3, 5].map((h) => obs(h, 1_000_000)));
  const returns = new Map([[1, -5], [3, 40], [5, 30]]);
  const e = excursionsFromIndependent(res, returns);
  assert.equal(e.independentObservations, 1, "only the 1m mark is independent");
  assert.equal(e.mfePct, -5, "the +40 came from a reused quote and must not become an MFE");
  assert.equal(e.supported, false, "one observation cannot support an excursion claim");
});

test("excursions are supported once two independent observations exist", () => {
  const res = classifyMarkSeries([obs(1, 1_000_000), obs(3, 1_200_000)]);
  const e = excursionsFromIndependent(res, new Map([[1, -5], [3, 40]]));
  assert.equal(e.supported, true);
  assert.equal(e.mfePct, 40);
  assert.equal(e.maePct, -5);
});

// ── §4/§10 brackets ────────────────────────────────────────────────────────

test("the production symmetric bracket is arithmetically unsurvivable", () => {
  const baseline = CANDIDATE_POLICIES.find((p) => p.id === "BASELINE_SYMMETRIC_45");
  const m = bracketMath(baseline, 0.1829);
  assert.equal(m.riskRewardRatio, 1);
  assert.equal(m.breakevenWinRate, 0.5);
  assert.equal(m.survivableAtWinRate, false);
  assert.ok(m.impliedExpectancyPct < -25);
});

test("asymmetric candidates lower the breakeven win rate as intended", () => {
  const be = (id) => bracketMath(CANDIDATE_POLICIES.find((p) => p.id === id), 0.1829).breakevenWinRate;
  assert.ok(be("TIGHT_STOP_20") < 0.5);
  assert.ok(be("ASYM_3R") < be("ASYM_2R"), "3R needs a lower win rate than 2R");
  assert.ok(be("ASYM_3R") < 0.26);
});

test("only INDEPENDENT marks may trigger a shadow exit", () => {
  const policy = CANDIDATE_POLICIES.find((p) => p.id === "TIGHT_STOP_20");
  // A reused mark showing -50% must not manufacture a stop that never happened.
  const out = simulatePolicy(policy, 0, [
    { atMs: 60_000, returnPct: -50, independent: false },
    { atMs: 120_000, returnPct: -5, independent: true },
  ]);
  assert.equal(out.exitReason, "END_OF_SERIES");
  assert.equal(out.returnPct, -5, "the carried-forward -50% was correctly ignored");
  assert.equal(out.independentObservations, 1);
});

test("a series with no independent marks is UNSUPPORTED, never scored as flat", () => {
  const policy = CANDIDATE_POLICIES.find((p) => p.id === "ASYM_2R");
  const out = simulatePolicy(policy, 0, [{ atMs: 1000, returnPct: -30, independent: false }]);
  assert.equal(out.supported, false);
  assert.equal(out.returnPct, null);
  assert.equal(out.exitReason, "NO_USABLE_MARKS");
});

test("a trailing policy on a single observation is unsupported, not credited", () => {
  const trail = CANDIDATE_POLICIES.find((p) => p.id === "TRAIL_15_FROM_10");
  const out = simulatePolicy(trail, 0, [{ atMs: 1000, returnPct: 30, independent: true }]);
  assert.equal(out.supported, false, "claiming a trail helped needs prices that moved between marks");
});

test("stop precedence is conservative when one tick clears several levels", () => {
  const policy = CANDIDATE_POLICIES.find((p) => p.id === "ASYM_2R"); // +50 / -25
  const out = simulatePolicy(policy, 0, [{ atMs: 1000, returnPct: -60, independent: true }]);
  assert.equal(out.exitReason, "STOP_HIT");
  assert.equal(out.returnPct, -25, "filled at the stop, not the worse observed print");
});

test("target and time exits fire on independent marks", () => {
  const t = simulatePolicy(CANDIDATE_POLICIES.find((p) => p.id === "ASYM_2R"), 0,
    [{ atMs: 1000, returnPct: 60, independent: true }]);
  assert.equal(t.exitReason, "TARGET_HIT");
  assert.equal(t.returnPct, 50);
  const tm = simulatePolicy(CANDIDATE_POLICIES.find((p) => p.id === "TIME_30_STOP_20"), 0,
    [{ atMs: 10 * 60_000, returnPct: -5, independent: true }, { atMs: 31 * 60_000, returnPct: -8, independent: true }]);
  assert.equal(tm.exitReason, "TIME_EXIT");
});

test("simulation never inspects the future to choose an exit", () => {
  // A later +200% must not retroactively prevent the earlier stop.
  const out = simulatePolicy(CANDIDATE_POLICIES.find((p) => p.id === "TIGHT_STOP_20"), 0, [
    { atMs: 60_000, returnPct: -25, independent: true },
    { atMs: 120_000, returnPct: 200, independent: true },
  ]);
  assert.equal(out.exitReason, "STOP_HIT");
  assert.equal(out.exitAtMs, 60_000);
});

test("unsimulatable rows are excluded from rates, never scored as zero", () => {
  const policy = CANDIDATE_POLICIES.find((p) => p.id === "ASYM_2R");
  const outcomes = [
    { policyId: policy.id, exitReason: "TARGET_HIT", returnPct: 50, exitAtMs: 1, mfePct: 55, independentObservations: 3, supported: true, note: "" },
    { policyId: policy.id, exitReason: "STOP_HIT", returnPct: -25, exitAtMs: 1, mfePct: 5, independentObservations: 3, supported: true, note: "" },
    { policyId: policy.id, exitReason: "NO_USABLE_MARKS", returnPct: null, exitAtMs: null, mfePct: null, independentObservations: 0, supported: false, note: "" },
  ];
  const e = evaluatePolicy(policy, outcomes);
  assert.equal(e.count, 3);
  assert.equal(e.supportedCount, 2, "the unsimulatable row is counted but not scored");
  assert.equal(e.winRate, 0.5);
  assert.equal(e.profitFactor, 2);
  assert.ok(e.sampleWarning, "below the minimum sample, a warning is mandatory");
});

test("promotion is REFUSED when independent mark coverage is too low", () => {
  const evals = CANDIDATE_POLICIES.map((p) => ({
    policyId: p.id, family: p.family, count: 200, supportedCount: 200,
    winRate: 0.4, medianReturnPct: 10, expectancyPct: 12, profitFactor: 2.5,
    stopRate: 0.4, targetHitRate: 0.4, medianMfePct: 20, medianGiveBackPts: 5,
    math: bracketMath(p, 0.4), sampleWarning: null, version: BRACKET_FRAMEWORK_VERSION,
  }));
  const r = selectForwardTestPolicy(evals, { independentRate: 0.159 });
  assert.equal(r.decision, "RESEARCH_ONLY");
  assert.match(r.rationale, /carried-forward quotes/);
});

test("promotion is REFUSED below the minimum sample even with good numbers", () => {
  const evals = [{
    policyId: "ASYM_3R", family: "ASYMMETRIC_3R", count: 10, supportedCount: 10,
    winRate: 0.6, medianReturnPct: 30, expectancyPct: 25, profitFactor: 4,
    stopRate: 0.4, targetHitRate: 0.6, medianMfePct: 40, medianGiveBackPts: 5,
    math: null, sampleWarning: "small", version: BRACKET_FRAMEWORK_VERSION,
  }];
  assert.equal(selectForwardTestPolicy(evals, { independentRate: 0.9 }).decision, "RESEARCH_ONLY");
});

test("the baseline can never be promoted as if it were a candidate", () => {
  const evals = [{
    policyId: "BASELINE_SYMMETRIC_45", family: "SYMMETRIC_BASELINE",
    count: 100, supportedCount: 100, winRate: 0.6, medianReturnPct: 10,
    expectancyPct: 5, profitFactor: 1.5, stopRate: 0.3, targetHitRate: 0.6,
    medianMfePct: 20, medianGiveBackPts: 5, math: null, sampleWarning: null,
    version: BRACKET_FRAMEWORK_VERSION,
  }];
  assert.equal(selectForwardTestPolicy(evals, { independentRate: 0.9 }).decision, "RESEARCH_ONLY");
});

test("promotion requires PF >= 1 AND positive expectancy", () => {
  const mk = (pf, exp) => [{
    policyId: "ASYM_3R", family: "ASYMMETRIC_3R", count: 100, supportedCount: 100,
    winRate: 0.3, medianReturnPct: 0, expectancyPct: exp, profitFactor: pf,
    stopRate: 0.5, targetHitRate: 0.3, medianMfePct: 10, medianGiveBackPts: 5,
    math: null, sampleWarning: null, version: BRACKET_FRAMEWORK_VERSION,
  }];
  assert.equal(selectForwardTestPolicy(mk(0.9, 5), { independentRate: 0.9 }).decision, "RESEARCH_ONLY");
  assert.equal(selectForwardTestPolicy(mk(1.5, -1), { independentRate: 0.9 }).decision, "RESEARCH_ONLY");
  assert.equal(selectForwardTestPolicy(mk(1.5, 5), { independentRate: 0.9 }).decision, "PROMOTE_TO_FORWARD_TEST");
});

test("at most ONE policy is ever selected", () => {
  const evals = ["ASYM_2R", "ASYM_3R", "TIGHT_STOP_20"].map((id, i) => ({
    policyId: id, family: "ASYMMETRIC_3R", count: 100, supportedCount: 100,
    winRate: 0.3, medianReturnPct: 0, expectancyPct: 5 + i, profitFactor: 1.5 + i,
    stopRate: 0.5, targetHitRate: 0.3, medianMfePct: 10, medianGiveBackPts: 5,
    math: null, sampleWarning: null, version: BRACKET_FRAMEWORK_VERSION,
  }));
  const r = selectForwardTestPolicy(evals, { independentRate: 0.9 });
  assert.equal(r.decision, "PROMOTE_TO_FORWARD_TEST");
  assert.equal(r.policyId, "TIGHT_STOP_20", "highest profit factor wins, and only one");
  assert.match(r.rationale, /resets to zero/);
});

// ── boundaries ─────────────────────────────────────────────────────────────

test("all three modules are pure — no DB, network, env, AI, or broker path", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of [
    "lib/research/options/trade-verification.ts",
    "lib/research/options/mark-quality.ts",
    "lib/research/options/bracket-policy.ts",
  ]) {
    const src = readFileSync(f, "utf8");
    for (const banned of ["require(", "fetch(", "prepare(", "process.env", "openai", "anthropic", "broker", "webhook"]) {
      assert.equal(src.toLowerCase().includes(banned.toLowerCase()), false, `${banned} must not appear in ${f}`);
    }
  }
});

test("shadow policies carry no send or subscriber authority", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("lib/research/options/bracket-policy.ts", "utf8");
  for (const banned of ["discord", "notify", "subscriber", "deliver"]) {
    assert.equal(new RegExp(`${banned}\\s*\\(`, "i").test(src), false, `${banned}() must not be callable from a shadow policy`);
  }
  assert.equal(MIN_POLICY_SAMPLE, 30);
});
