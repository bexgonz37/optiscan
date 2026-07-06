import test from "node:test";
import assert from "node:assert/strict";
import { keyLevels } from "../lib/chart-indicators.ts";

function bar(t, o, h, l, c, v = 1000) {
  return { t, o, h, l, c, v };
}

test("keyLevels: HOD, LOD, VWAP from session bars", () => {
  const bars = [
    bar(1, 100, 101, 99.5, 100.5, 500),
    bar(2, 100.5, 102, 100, 101.5, 800),
    bar(3, 101.5, 103, 101, 102.5, 1200),
  ];
  const levels = keyLevels(bars);
  const byId = Object.fromEntries(levels.map((l) => [l.id, l]));
  assert.equal(byId.hod.price, 103);
  assert.equal(byId.lod.price, 99.5);
  assert.ok(byId.vwap);
  assert.ok(byId.vwap.price > 100 && byId.vwap.price < 103);
});

test("keyLevels: dedupes overlapping prices", () => {
  const bars = [bar(1, 50, 50, 50, 50, 100)];
  const levels = keyLevels(bars);
  assert.equal(levels.filter((l) => l.price === 50).length, 1);
});

test("keyLevels: empty bars returns empty", () => {
  assert.deepEqual(keyLevels([]), []);
});
