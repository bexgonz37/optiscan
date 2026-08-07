/**
 * The stop Discord publishes must be the stop that actually closes the mirrored paper position.
 * Two authorities exist: the frozen risk-model stop PRICE and the premium safety band measured
 * against the entry fill. Whichever is reached first on a falling premium is the real one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeOptionTargets, resolveGoverningStop, safetyBandStopPct } from "../lib/research/options/targets.ts";
import { decideOptionExit, defaultGradeConfig } from "../lib/research/options/grade.ts";

test("safety band default matches the grader's configured stop", () => {
  assert.equal(safetyBandStopPct({}), defaultGradeConfig({}).stopLossPct);
  assert.equal(safetyBandStopPct({ OPTIONS_PAPER_STOP_LOSS_PCT: "30" }), 30);
});

test("a -45% risk-model stop is pre-empted by the -40% band", () => {
  const tg = computeOptionTargets(3.44, "breakout_forming", {});
  assert.equal(tg.stop, 1.89, "risk model freezes the stop at -45% of the mid");

  const governing = resolveGoverningStop(3.44, tg.stop, {});
  assert.equal(governing.source, "safety_band");
  assert.equal(governing.price, 2.06);
  // -45% is unreachable: the band closes the position ~5 points of return earlier.
  assert.ok(governing.price > tg.stop);
});

test("a risk-model stop tighter than the band governs on its own", () => {
  const tg = computeOptionTargets(3.44, "momentum_acceleration", {});
  assert.equal(tg.stop, 2.24, "0DTE-style strategies stop at -35%");
  const governing = resolveGoverningStop(3.44, tg.stop, {});
  assert.equal(governing.source, "risk_model");
  assert.equal(governing.price, tg.stop);
});

test("the published stop is the price the grader actually exits on", () => {
  const entry = 3.44;
  const tg = computeOptionTargets(entry, "breakout_forming", {});
  const governing = resolveGoverningStop(entry, tg.stop, {});

  const position = {
    entry_fill: entry, target: tg.t1, invalidation: tg.stop,
    expiration: "2026-12-18", entered_at_ms: 0,
  };
  const quoteAt = (bid, ask) => ({ bid, ask, quoteAgeMs: 100 });

  // Just above the published stop the position must still be open.
  const above = decideOptionExit(position, quoteAt(governing.price + 0.06, governing.price + 0.10), 1_000, defaultGradeConfig({}), {});
  assert.equal(above.action, "hold");

  // At the published stop it must close — which is the whole point of publishing that number.
  const at = decideOptionExit(position, quoteAt(governing.price - 0.02, governing.price + 0.02), 1_000, defaultGradeConfig({}), {});
  assert.equal(at.action, "exit");
  assert.equal(at.reason, "stop_hit");
  assert.ok(at.returnPct <= -40 && at.returnPct > -45, `closed at ${at.returnPct}%, i.e. the band, not the -45% risk-model stop`);
});
