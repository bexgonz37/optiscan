import test from "node:test";
import assert from "node:assert/strict";
import { tickDirection, applyHotLinger } from "../lib/tick-flash.ts";

test("tickDirection returns up/down/empty", () => {
  assert.equal(tickDirection(2, 1), "up");
  assert.equal(tickDirection(1, 2), "down");
  assert.equal(tickDirection(1, 1), "");
  assert.equal(tickDirection(null, 1), "");
});

test("applyHotLinger keeps cooled symbols within window", () => {
  const hotSince = new Map();
  const rows = [{ symbol: "A" }, { symbol: "B" }];
  const now = 100_000;
  hotSince.set("C", now - 5_000);
  const out = applyHotLinger(
    rows,
    (r) => r.symbol === "A",
    hotSince,
    now,
    20_000,
    (sym) => (sym === "C" ? { symbol: "C" } : undefined),
  );
  assert.deepEqual(out.map((r) => r.symbol), ["A", "B", "C"]);
  const out2 = applyHotLinger(rows, () => false, hotSince, now + 25_000, 20_000);
  assert.deepEqual(out2.map((r) => r.symbol), ["A", "B"]);
});
