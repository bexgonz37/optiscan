import test from "node:test";
import assert from "node:assert/strict";
import { parseRobinhoodCsv } from "../lib/robinhood-csv.ts";

test("parseRobinhoodCsv: parses option buy row", () => {
  const csv = `Activity Date,Process Date,Settle Date,Instrument,Description,Trans Code,Quantity,Price,Amount
3/15/2025,3/15/2025,3/17/2025,SPY,SPY 3/15/2025 Call $580.00,BTO,1,2.50,-250.00`;
  const { rows, errors } = parseRobinhoodCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, "SPY");
  assert.equal(rows[0].side, "call");
  assert.equal(rows[0].entryPrice, 2.5);
});

test("parseRobinhoodCsv: dedup key stable", () => {
  const csv = `Activity Date,Instrument,Description,Trans Code,Quantity,Price,Amount
3/15/2025,SPY,SPY 3/15/2025 Put $570.00,BTO,2,1.20,-240.00`;
  const { rows } = parseRobinhoodCsv(csv);
  assert.ok(rows[0].dedupKey.includes("SPY"));
});
