import test from "node:test";
import assert from "node:assert/strict";
import { calledAgoLabel, stillMovingStatus } from "../lib/signal-live.ts";

test("calledAgoLabel: under 1 min is just now", () => {
  const t = new Date(Date.now() - 20_000).toISOString();
  assert.equal(calledAgoLabel(t), "just now");
});

test("calledAgoLabel: 5 min ago", () => {
  const t = new Date(Date.now() - 5 * 60_000).toISOString();
  assert.equal(calledAgoLabel(t), "5m ago");
});

test("stillMovingStatus: aligned fast CALL", () => {
  const s = stillMovingStatus("CALL", { shortRate: 0.3, direction: "bullish" });
  assert.equal(s.label, "Still moving");
  assert.equal(s.tone, "live");
});

test("stillMovingStatus: turned against PUT", () => {
  const s = stillMovingStatus("PUT", { shortRate: 0.25, direction: "bullish" });
  assert.equal(s.label, "Turned");
  assert.equal(s.tone, "stalled");
});
