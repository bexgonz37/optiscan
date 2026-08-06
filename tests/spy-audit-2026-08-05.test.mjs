/**
 * tests/spy-audit-2026-08-05.test.mjs
 *
 * The audit record is frozen evidence. These tests do not re-derive the market
 * data — they guard the properties that make the record trustworthy, so a later
 * edit cannot quietly turn a measurement into a claim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SPY_AUDIT_VERSION, VERIFIED_MISSED_WINNERS, REJECTED_BUT_GOOD, ALERT_SCORECARD,
  FIRST_HIGH_ASYMMETRY_ALERT, COUNTER_RECONCILIATION, ROOT_CAUSES, PROPOSED_FIX,
  PLAIN_SUMMARY,
} from "../lib/research/asymmetry/spy-audit-2026-08-05.ts";

test("the audit is versioned", () => {
  assert.match(SPY_AUDIT_VERSION, /^SPY_AUDIT_2026_08_05_V\d+$/);
});

// ── The winners are winners by the ask-to-bid rule ──────────────────────────

test("every verified winner has a payable ask and a hittable bid", () => {
  for (const w of VERIFIED_MISSED_WINNERS) {
    assert.ok(w.decisionAsk > 0, `${w.occ} needs a real entry ask`);
    assert.ok(w.peakBid > 0, `${w.occ} needs a real exit bid`);
    assert.ok(w.peakBidSize >= 10, `${w.occ} exit bid must have real size, got ${w.peakBidSize}`);
  }
});

test("no winner rests on an effectively-zero entry", () => {
  for (const w of VERIFIED_MISSED_WINNERS) {
    assert.ok(w.decisionAsk > 0.02, `${w.occ} entered at ${w.decisionAsk} — a penny entry is not fillable size`);
  }
});

test("the stated return is exactly ask-to-bid, recomputed", () => {
  for (const w of VERIFIED_MISSED_WINNERS) {
    const expected = ((w.peakBid - w.decisionAsk) / w.decisionAsk) * 100;
    assert.ok(Math.abs(expected - w.mfePct) < 1.0,
      `${w.occ}: stated ${w.mfePct}% but ask ${w.decisionAsk} -> bid ${w.peakBid} is ${expected.toFixed(1)}%`);
  }
});

test("every winner is materially large — the bar is not 'ticked up'", () => {
  for (const w of VERIFIED_MISSED_WINNERS) assert.ok(w.mfePct >= 50, `${w.occ} only ${w.mfePct}%`);
});

test("the apparent gain is always reported alongside, and is always the larger number", () => {
  for (const w of VERIFIED_MISSED_WINNERS) {
    assert.ok(w.apparentGainPct > w.mfePct,
      `${w.occ}: an apparent gain that is not larger than the executable one needs no debunking`);
  }
});

test("NOTHING is claimed as a verified 10,000% winner", () => {
  assert.equal(PLAIN_SUMMARY.contractsWithVerified10000Pct, 0);
  for (const w of VERIFIED_MISSED_WINNERS) {
    assert.ok(w.mfePct < 1000, `${w.occ} claims ${w.mfePct}% — that needs its own evidence`);
  }
});

// ── The direction finding ───────────────────────────────────────────────────

test("every verified missed winner on this session is a PUT", () => {
  const calls = VERIFIED_MISSED_WINNERS.filter((w) => w.side === "call");
  assert.equal(calls.length, 0,
    "SPY's best up-leg was +0.30%; a verified call winner here would contradict the underlying reconstruction");
});

test("the summary answers the call question directly rather than deflecting", () => {
  assert.match(PLAIN_SUMMARY.question, /calls/i);
  assert.match(PLAIN_SUMMARY.answer, /0\.30%/);
});

// ── The rejected-but-good case ──────────────────────────────────────────────

test("the rejected-but-good case names the ceiling that rejected it", () => {
  assert.equal(REJECTED_BUT_GOOD.rejectedReason, "ENTRY_TOO_LATE_6M");
  assert.equal(REJECTED_BUT_GOOD.ceilingThatRejectedItMs, 30_000);
  assert.ok(REJECTED_BUT_GOOD.mfePct > 50);
  assert.ok(REJECTED_BUT_GOOD.spreadPct < 5, "the point is that it was liquid, not that it was cheap");
});

// ── The scorecard is not flattering itself ─────────────────────────────────

test("the alert scorecard reports the bad numbers", () => {
  assert.ok(ALERT_SCORECARD.expectancyPct < 0, "an expectancy that is not negative would contradict the sample");
  assert.ok(ALERT_SCORECARD.profitFactor < 1);
  assert.ok(ALERT_SCORECARD.immediateFailurePct > 50);
  assert.ok(ALERT_SCORECARD.scored <= ALERT_SCORECARD.sampled);
  assert.ok(ALERT_SCORECARD.sampled < ALERT_SCORECARD.alertsIssuedTotal,
    "a sample must be declared as smaller than the population");
});

test("the sessions with no alerts are recorded as such, not omitted", () => {
  const s = ALERT_SCORECARD.perSession.find((x) => x.session === "2026-08-05");
  assert.equal(s.alerts, 0);
  assert.equal(s.goodPct, null, "null means not measured, never 0%");
});

// ── The first alert ─────────────────────────────────────────────────────────

test("the first High-Asymmetry alert is fully identified and its delivery evidenced", () => {
  assert.equal(FIRST_HIGH_ASYMMETRY_ALERT.symbol, "NFLX");
  assert.equal(FIRST_HIGH_ASYMMETRY_ALERT.occ, "O:NFLX260807P00074000");
  assert.equal(FIRST_HIGH_ASYMMETRY_ALERT.strategy, "pullback_continuation",
    "NOT sr_reclaim — that came from the truncated one-row sample");
  assert.equal(FIRST_HIGH_ASYMMETRY_ALERT.delivered, true);
  assert.match(FIRST_HIGH_ASYMMETRY_ALERT.deliveryEvidence, /SENT/);
});

test("one good alert is not reported as proof the gate is right", () => {
  assert.match(FIRST_HIGH_ASYMMETRY_ALERT.plainLanguage, /One alert is one alert/);
});

// ── The counter reconciliation ──────────────────────────────────────────────

test("the counter disagreement names an authority and proves it", () => {
  assert.equal(COUNTER_RECONCILIATION.authoritative, "ratio.notified");
  assert.equal(COUNTER_RECONCILIATION.authoritativeValue, 1);
  assert.equal(COUNTER_RECONCILIATION.historyChanged, false,
    "counters may be fixed; the historical record may not be edited to agree with them");
  assert.match(COUNTER_RECONCILIATION.proof, /limit=1000/);
});

// ── The proposed fix is honest about itself ────────────────────────────────

test("the proposed fix is OFF and says so", () => {
  assert.equal(PROPOSED_FIX.defaultState, "OFF");
  assert.equal(PROPOSED_FIX.verdict, "DO NOT ENABLE YET");
});

test("the fix reports the replay numbers that argue AGAINST it", () => {
  const r = PROPOSED_FIX.replay;
  assert.ok(r.recoveredReachedPlus25Pct - r.baselineReachedPlus25Pct < 5,
    "the marginal +25% improvement is the reason it is not enabled and must stay visible");
  assert.ok(r.recoveredMedianMaePct < r.baselineMedianMfePct);
  assert.match(PROPOSED_FIX.verdictReason, /MEDIAN/);
});

test("the fix declares a demotion trigger and its remaining evidence gap", () => {
  assert.ok(PROPOSED_FIX.demotionTrigger.length > 40);
  assert.match(PROPOSED_FIX.evidenceStillMissing, /0DTE/);
  assert.match(PROPOSED_FIX.providerCostImpact, /^Zero/);
});

// ── Root causes are ranked and honest about status ─────────────────────────

test("the dominant root cause is the one that explains most misses, and is unfixed", () => {
  assert.match(ROOT_CAUSES[0].cause, /0DTE/);
  assert.match(ROOT_CAUSES[0].explains, /11 of the 12/);
  assert.equal(ROOT_CAUSES[0].status, "PROVEN, NOT YET FIXED");
});

test("every root cause carries an evidence grade", () => {
  for (const c of ROOT_CAUSES) {
    assert.ok(["NBBO_VERIFIED", "JOURNAL", "TRADE_DERIVED", "SAMPLED"].includes(c.evidence), c.cause);
  }
});
