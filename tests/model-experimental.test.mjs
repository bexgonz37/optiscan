import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPERIMENTAL_LABEL,
  SETUP_SCORE_LABEL,
  requiredForValidated,
  describeModelState,
} from "../lib/model-experimental.ts";

const req = { minGraded: 200, minWins: 40, minLosses: 40, minHoldout: 50 };

function meta(over = {}) {
  return {
    trainingSample: 60, wins: 30, losses: 30, holdout: 12,
    modelVersion: 3, brier: 0.21, ece: 0.08, coverage: 0.97, reasonNotValidated: "need 200 graded outcomes (have 60)",
    ...over,
  };
}

test("mandated labels are exact and never softened", () => {
  assert.equal(EXPERIMENTAL_LABEL, "EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY");
  assert.equal(SETUP_SCORE_LABEL, "SETUP SCORE — NOT A PROBABILITY");
});

test("requiredForValidated never returns negative gaps", () => {
  const g = requiredForValidated(meta({ trainingSample: 500, wins: 100, losses: 100, holdout: 90 }), req);
  assert.deepEqual(g, { moreGraded: 0, moreWins: 0, moreLosses: 0, moreHoldout: 0 });
  const g2 = requiredForValidated(meta(), req);
  assert.equal(g2.moreGraded, 140);
  assert.equal(g2.moreWins, 10);
  assert.equal(g2.moreLosses, 10);
  assert.equal(g2.moreHoldout, 38);
});

test("validated state shows a plain probability with no experimental headline", () => {
  const d = describeModelState("ACTIVE_VALIDATED", meta(), req);
  assert.equal(d.showProbability, true);
  assert.equal(d.headline, null);
  assert.equal(d.fallbackLabel, null);
});

test("experimental state carries the exact EXPERIMENTAL label and shows probability", () => {
  const d = describeModelState("ACTIVE_EXPERIMENTAL_RESEARCH_ONLY", meta(), req);
  assert.equal(d.headline, EXPERIMENTAL_LABEL);
  assert.equal(d.showProbability, true);
  assert.ok(d.lines.some((l) => /research only/i.test(l)));
  assert.ok(d.lines.some((l) => /Not validated because/i.test(l)));
});

test("inactive state shows NO probability and the SETUP SCORE fallback label", () => {
  const d = describeModelState("INACTIVE_NO_TRAINABLE_DATA", meta({ trainingSample: 5, wins: 3, losses: 2, holdout: 1 }), req);
  assert.equal(d.showProbability, false);
  assert.equal(d.fallbackLabel, SETUP_SCORE_LABEL);
  assert.ok(d.lines.some((l) => /No probability/i.test(l)));
  assert.ok(d.lines.some((l) => /more graded/i.test(l)));
});
