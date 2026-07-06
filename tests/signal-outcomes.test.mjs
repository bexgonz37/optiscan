import test from "node:test";
import assert from "node:assert/strict";
import { computeOptionOutcome } from "../lib/signal-outcomes.ts";

const snap = (checkpoint, mid) => ({ checkpoint, mid });

test("computeOptionOutcome: entry 1.00 -> best 1.30 = +30% win", () => {
  const o = computeOptionOutcome([
    snap("alert", 1.0), snap("live", 1.1), snap("live", 1.3), snap("live", 0.9), snap("eod", 0.5),
  ]);
  assert.equal(o.entryMid, 1.0);
  assert.equal(o.bestMid, 1.3);
  assert.equal(o.returnPct, 30);
  assert.equal(o.win, true);
});

test("computeOptionOutcome: contract bled the whole time = loss", () => {
  const o = computeOptionOutcome([snap("alert", 2.0), snap("live", 1.8), snap("eod", 1.2)]);
  assert.equal(o.returnPct, -10); // best after entry was 1.8
  assert.equal(o.win, false);
});

test("computeOptionOutcome: +14.9% is not a win at the 15% default threshold", () => {
  const o = computeOptionOutcome([snap("alert", 1.0), snap("live", 1.149)]);
  assert.equal(o.win, false);
  const custom = computeOptionOutcome([snap("alert", 1.0), snap("live", 1.149)], { winThresholdPct: 10 });
  assert.equal(custom.win, true);
});

test("computeOptionOutcome: null without entry mid or post-alert quotes", () => {
  assert.equal(computeOptionOutcome([]), null);
  assert.equal(computeOptionOutcome([snap("alert", null), snap("live", 1.2)]), null);
  assert.equal(computeOptionOutcome([snap("alert", 0), snap("live", 1.2)]), null);
  assert.equal(computeOptionOutcome([snap("alert", 1.0)]), null);
  assert.equal(computeOptionOutcome([snap("alert", 1.0), snap("live", null)]), null);
});

test("computeOptionOutcome: eod-only snapshot still measures", () => {
  const o = computeOptionOutcome([snap("alert", 1.0), snap("eod", 1.25)]);
  assert.equal(o.returnPct, 25);
  assert.equal(o.win, true);
});
