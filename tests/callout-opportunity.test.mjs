import test from "node:test";
import assert from "node:assert/strict";
import { gradeOpportunity, opportunityConfig } from "../lib/callout-opportunity.ts";

const ENV = { OPPORTUNITY_MIN_FAVORABLE_PCT: "25" };

test("a contract that ran +40% before expiration is a HIT opportunity even if the paper trade lost", () => {
  // Realized P&L is irrelevant here — this grades whether the CALLOUT was ever right.
  const r = gradeOpportunity({ filled: true, peakFavorablePct: 40, window: "to_expiration" }, ENV);
  assert.equal(r.opportunityGrade, "HIT");
  assert.equal(r.hadProfitOpportunity, true);
  assert.equal(r.window, "to_expiration");
  assert.equal(r.peakFavorablePct, 40);
});

test("a contract that only ticked +8% never presented a bookable opportunity → NONE", () => {
  const r = gradeOpportunity({ filled: true, peakFavorablePct: 8, window: "to_expiration" }, ENV);
  assert.equal(r.opportunityGrade, "NONE");
  assert.equal(r.hadProfitOpportunity, false);
});

test("exactly at threshold counts as a HIT", () => {
  const r = gradeOpportunity({ filled: true, peakFavorablePct: 25, window: "held" }, ENV);
  assert.equal(r.opportunityGrade, "HIT");
});

test("unfilled callout is UNGRADABLE, never a fabricated number", () => {
  const r = gradeOpportunity({ filled: false, peakFavorablePct: null, window: "none" }, ENV);
  assert.equal(r.opportunityGrade, "UNGRADABLE");
  assert.equal(r.peakFavorablePct, null);
  assert.equal(r.hadProfitOpportunity, false);
});

test("filled but no marks recorded → UNGRADABLE (honest, not zero)", () => {
  const r = gradeOpportunity({ filled: true, peakFavorablePct: null, window: "held" }, ENV);
  assert.equal(r.opportunityGrade, "UNGRADABLE");
  assert.equal(r.peakFavorablePct, null);
});

test("held-window-only peak is graded but its window is reported honestly", () => {
  const r = gradeOpportunity({ filled: true, peakFavorablePct: 30, window: "held" }, ENV);
  assert.equal(r.opportunityGrade, "HIT");
  assert.equal(r.window, "held");
  assert.match(r.reasons.join(" "), /held window only/i);
});

test("threshold is env-configurable and defaults to 25", () => {
  assert.equal(opportunityConfig({}).minFavorablePct, 25);
  assert.equal(opportunityConfig({ OPPORTUNITY_MIN_FAVORABLE_PCT: "50" }).minFavorablePct, 50);
  // A +30% runner is a HIT at the default but NONE if we demand +50%.
  assert.equal(gradeOpportunity({ filled: true, peakFavorablePct: 30, window: "to_expiration" }, {}).opportunityGrade, "HIT");
  assert.equal(gradeOpportunity({ filled: true, peakFavorablePct: 30, window: "to_expiration" }, { OPPORTUNITY_MIN_FAVORABLE_PCT: "50" }).opportunityGrade, "NONE");
});
