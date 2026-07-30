/**
 * tests/loss-protection-shadow-boundaries.test.mjs — the two boundaries the
 * loss-protection research must never cross, asserted explicitly rather than
 * inferred from the advisory flag alone:
 *
 *  1. A deterministic weakness exit may leave BEFORE the frozen stop is reached,
 *     but only as research — the canonical outcome is untouched.
 *  2. A policy that loses less than the current policy is LESS BAD, never
 *     profitable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLossProtection } from "../lib/research/options/loss-protection-research.ts";
import { aggregateLossProtection } from "../lib/research/options/loss-protection-aggregation.ts";

const START = Date.parse("2026-07-30T14:00:00Z"); // 10:00 ET, inside the options session
const mark = (min, bid, weakening = false) => ({
  atMs: START + min * 60_000, bid, ask: bid + 0.04, quoteAgeMs: 500, weakening,
});

test("deterministic weakness may exit before the frozen stop, and only in research", () => {
  // Frozen stop is 0.70 (-30%). Two confirmed weakening ticks land at -6% and
  // -8%, well before the stop is ever touched, and the trade later reaches -40%.
  const frozenStop = 0.70;
  const trade = {
    tradeId: 1, side: "call", dte: 1, strategyFamily: "x", timeOfDay: "morning",
    entryAsk: 1.0, enteredAtMs: START, canonicalReturnPct: -40,
    marks: [mark(1, 0.94, true), mark(2, 0.92, true), mark(5, 0.70, true), mark(8, 0.60, true)],
  };
  const before = structuredClone(trade);
  const out = analyzeLossProtection([trade]);
  const report = out.trades[0];

  const weakness = report.policies.find((p) => p.policy === "Weakness exit -5%");
  assert.equal(weakness.evidenceValid, true, "two confirmed weakening ticks validate the exit");
  const weaknessExitBid = trade.entryAsk * (1 + weakness.returnPct / 100);
  assert.ok(weaknessExitBid > frozenStop,
    `the shadow weakness exit (${weaknessExitBid.toFixed(2)}) must be above the frozen stop (${frozenStop})`);

  const stopHitAtMs = report.thresholds["-30"];
  assert.ok(weakness.exitAtMs < stopHitAtMs,
    "the weakness exit must be timestamped before the frozen stop was reached");

  // Research only: the canonical outcome is unchanged and the input is untouched.
  const current = report.policies.find((p) => p.policy === "Current policy");
  assert.equal(current.returnPct, -40, "the canonical outcome must survive the replay");
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.productionBehaviorChanged, false);
  assert.deepEqual(trade, before, "the replay must not mutate the trade");
  assert.ok(out.limitations.some((l) => /No policy result changes live stops or exits/.test(l)));
});

test("a policy that merely loses less is labelled less bad, never profitable", () => {
  // Both policies are negative; the shadow policy exits at -8% versus -40%.
  const lossTrades = Array.from({ length: 5 }, (_, i) => ({
    tradeId: 100 + i, side: "call", dte: 1, strategyFamily: "x", timeOfDay: "morning",
    entryAsk: 1.0, enteredAtMs: START, canonicalReturnPct: -40,
    marks: [mark(1, 0.94, true), mark(2, 0.92, true), mark(8, 0.60, true)],
  }));

  const agg = aggregateLossProtection({ exitTrades: [], lossTrades, minimumSupportedSample: 1 });
  assert.equal(agg.productionBehaviorChanged, false);

  for (const policy of agg.policies) {
    if (policy.avgReturnPct != null && policy.avgReturnPct < 0) {
      assert.notEqual(policy.verdict, "PROFITABLE_SUPPORTED",
        `${policy.policy} is negative (${policy.avgReturnPct}%) and must never be verdict PROFITABLE_SUPPORTED`);
    }
  }
  const lessBad = agg.policies.filter((p) => p.verdict === "LESS_BAD_THAN_CURRENT");
  for (const policy of lessBad) {
    assert.ok(policy.avgReturnPct == null || policy.avgReturnPct < 0,
      "LESS_BAD_THAN_CURRENT must only ever describe a losing policy");
  }
});
