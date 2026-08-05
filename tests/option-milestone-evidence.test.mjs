import test from "node:test";
import assert from "node:assert/strict";
import { verifiedOptionMilestoneSnapshots } from "../lib/option-milestone-evidence.ts";

const OCC = "O:SPY260804C00600000";
const NOW = Date.parse("2026-08-04T19:55:00Z");
const snap = (checkpoint, at, mid, optionSymbol = OCC) => ({
  checkpoint, optionSymbol, bid: mid - 0.02, ask: mid + 0.02, mid, takenAt: new Date(at).toISOString(),
});

test("an opening snapshot alone cannot produce an option milestone", () => {
  assert.equal(verifiedOptionMilestoneSnapshots([snap("alert", NOW - 5 * 60_000, 1)], OCC, NOW), null);
});

test("a stale or wrong-OCC live mark cannot be described as current", () => {
  assert.equal(verifiedOptionMilestoneSnapshots([
    snap("alert", NOW - 10 * 60_000, 1), snap("live", NOW - 2 * 60_000, 1.3),
  ], OCC, NOW), null);
  assert.equal(verifiedOptionMilestoneSnapshots([
    snap("alert", NOW - 10 * 60_000, 1), snap("live", NOW - 5_000, 1.3, "O:SPY260804P00600000"),
  ], OCC, NOW), null);
});

test("a fresh executable exact-OCC mark can support a milestone", () => {
  const r = verifiedOptionMilestoneSnapshots([
    snap("alert", NOW - 10 * 60_000, 1), snap("live", NOW - 5_000, 1.3),
  ], OCC, NOW);
  assert.ok(r);
  assert.equal(r.live.length, 1);
});
