import test from "node:test";
import assert from "node:assert/strict";
import { formatOnTrackRatio, mapDailyTrendRow, onTrackPct } from "../lib/accuracy-ratios.ts";

test("formatOnTrackRatio: 7 of 12", () => {
  assert.equal(formatOnTrackRatio(7, 12), "7 of 12");
});

test("onTrackPct: 7/12", () => {
  assert.equal(onTrackPct(7, 12), 7 / 12);
});

test("onTrackPct: zero total returns null", () => {
  assert.equal(onTrackPct(0, 0), null);
});

test("mapDailyTrendRow: hit rate from wins/losses", () => {
  const row = mapDailyTrendRow({ day: "2026-07-06", total: 10, wins: 6, losses: 4 });
  assert.equal(row.hitRate, 0.6);
  assert.equal(row.total, 10);
});

test("mapDailyTrendRow: no completed signals", () => {
  const row = mapDailyTrendRow({ day: "2026-07-06", total: 5, tracking: 5, live_on_track: 2 });
  assert.equal(row.hitRate, null);
  assert.equal(row.liveOnTrack, 2);
});
