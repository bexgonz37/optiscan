import test from "node:test";
import assert from "node:assert/strict";
import { mergeStableSymbolOrder } from "../lib/stable-order.ts";

test("stable order keeps existing names in place and appends entrants", () => {
  assert.deepEqual(
    mergeStableSymbolOrder(["NVDA", "TSLA", "AMD"], ["AMD", "NVDA", "AAPL"], false),
    ["NVDA", "AMD", "AAPL"],
  );
});

test("stable order adopts the ranked order only on a scheduled resort", () => {
  assert.deepEqual(
    mergeStableSymbolOrder(["NVDA", "TSLA", "AMD"], ["AMD", "NVDA", "TSLA"], true),
    ["AMD", "NVDA", "TSLA"],
  );
});
