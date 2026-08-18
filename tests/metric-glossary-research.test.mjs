/**
 * The research vocabulary in the metric glossary.
 *
 * Two things are pinned here. First, that every term the private research view puts in front
 * of the owner actually has a plain-English definition — a metric shown without one is a
 * number the reader has to already understand to use.
 *
 * Second, and more important: that the definitions stay EDUCATIONAL. A glossary is where a
 * threshold quietly becomes advice — "PF above 1 means it's ready", "P(+25) above 50% means
 * take it" — and the entries most likely to drift that way are exactly the ones about
 * readiness and probability. The screens below fail on that wording.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { METRIC_GLOSSARY, metricInfo } from "../lib/metric-glossary.ts";

/** The terms the research brief named. Every one must be defined. */
const REQUIRED = [
  "winRate", "expectancy", "profitFactor", "baselineProfitFactor", "shadowProfitFactor",
  "meanReturn", "medianReturn", "averageWinner", "averageLoser",
  "mfe", "mae", "probabilityTouch",
  "winnerRetention", "lossRejection", "profitFactorExBest", "tailDependence",
  "independentSessions", "sampleSize",
  "selectionStrength", "deliveryQuality", "rewardRemaining", "moveConsumed",
  "discoveryStage", "stopLeakage", "giveback", "exactOcc",
  "evidenceQuality", "evidenceVerdict",
];

test("every metric the research view shows has a definition", () => {
  const missing = REQUIRED.filter((k) => metricInfo(k) == null);
  assert.deepEqual(missing, [], `undefined research metrics: ${missing.join(", ")}`);
});

test("every entry answers what it is, why it matters, and which way is better", () => {
  for (const key of REQUIRED) {
    const m = metricInfo(key);
    for (const field of ["label", "what", "why", "direction", "scoring", "risk"]) {
      assert.ok(m[field] && m[field].trim().length > 0, `${key}.${field} is empty`);
    }
    assert.ok(m.what.length > 40, `${key}.what is too terse to explain anything`);
    assert.ok(m.risk.length > 40, `${key}.risk must state a real limitation`);
  }
});

test("no definition tells the owner to act", () => {
  // A glossary explains what a number means. The moment it says "take", "buy" or "you
  // should", it has become advice wearing a definition's clothes.
  const IMPERATIVE = /\b(you should (?:take|buy|sell|enter|exit)|always take|never take|buy when|sell when)\b/i;
  for (const [key, m] of Object.entries(METRIC_GLOSSARY)) {
    const text = [m.what, m.why, m.direction, m.scoring, m.risk].join(" ");
    assert.ok(!IMPERATIVE.test(text), `${key} reads as a recommendation, not a definition`);
  }
});

test("no definition claims a threshold makes anything subscriber-ready", () => {
  // The specific failure this prevents: "profit factor above 1" being written as a readiness
  // bar. Subscriber promotion lives behind an explicit human approval and no metric implies it.
  const READINESS = /(subscriber[- ]ready|ready for subscribers|safe to (?:sell|charge|launch)|approved for subscribers)/i;
  for (const [key, m] of Object.entries(METRIC_GLOSSARY)) {
    const text = [m.what, m.why, m.direction, m.scoring, m.risk].join(" ");
    assert.ok(!READINESS.test(text), `${key} implies subscriber readiness from a metric value`);
  }
});

test("the probability entry refuses to be read as realized profit", () => {
  const m = metricInfo("probabilityTouch");
  assert.match(m.risk, /NOT REALIZED PROFIT/);
  // The concrete counter-example matters more than the disclaimer: the lane really did touch
  // +25% on 54% of setups and still return PF 0.67.
  assert.match(m.risk, /0\.67|54%/);
});

test("the verdict entry states that no status is an approval", () => {
  const m = metricInfo("evidenceVerdict");
  assert.match(m.risk, /NONE OF THESE IS AN APPROVAL/);
  assert.match(m.what, /READY_FOR_HUMAN_REVIEW/);
  assert.match(m.what, /FAILED/);
  assert.ok(!/SUBSCRIBER_APPROVED/.test([m.what, m.why, m.scoring].join(" ")));
});

test("selection strength and delivery quality are defined as DIFFERENT things", () => {
  const sel = metricInfo("selectionStrength");
  const dq = metricInfo("deliveryQuality");
  assert.match(dq.risk, /NOT selection strength/);
  // The two disagreeing on one callout is the reason both exist under their own names.
  assert.match(dq.risk, /100 versus 81|100 vs 81/);
  assert.match(sel.risk, /Missing is NOT low/);
});

test("the tail-dependence and ex-best entries keep the LHC_SELECT_V1 counter-example", () => {
  assert.match(metricInfo("profitFactorExBest").why, /1\.240/);
  assert.match(metricInfo("profitFactorExBest").why, /0\.611/);
});

test("winner retention is defined as the COST of a filter, not its benefit", () => {
  const wr = metricInfo("winnerRetention");
  assert.match(wr.why, /cost side/);
  assert.match(metricInfo("lossRejection").risk, /meaningless without winner retention/);
});

test("metrics that have not discriminated anything yet say so", () => {
  // Reward remaining returns its maximum on 65 of 70 rows and discovery stage grades every
  // row PRE_TRIGGER over a 1.6-second window. Both are honest about it.
  assert.match(metricInfo("rewardRemaining").risk, /has not discriminated anything yet/);
  assert.match(metricInfo("discoveryStage").risk, /1\.6[- ]second/);
});
