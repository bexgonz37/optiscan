import test from "node:test";
import assert from "node:assert/strict";
import { formatQuoteFreshness, quoteFreshness } from "../lib/quote-freshness.ts";

const NOW = Date.parse("2026-07-29T14:00:00.000Z");

test("quote freshness normalizes seconds, milliseconds, microseconds, and nanoseconds", () => {
  const expected = NOW - 3_000;
  const cases = [
    Math.floor(expected / 1_000),
    expected,
    BigInt(expected) * 1_000n,
    BigInt(expected) * 1_000_000n,
  ];
  for (const raw of cases) {
    const result = quoteFreshness(raw, NOW);
    assert.equal(result.valid, true);
    assert.equal(result.ageMs, 3_000);
    assert.equal(result.label, "3s");
  }
});

test("quote freshness rejects future, negative, and missing timestamps", () => {
  for (const raw of [NOW + 1_000, -1, null]) {
    const result = quoteFreshness(raw, NOW);
    assert.equal(result.valid, false);
    assert.equal(result.ageMs, null);
    assert.equal(result.label, "Unavailable");
  }
});

test("quote freshness exposes valid fresh and stale ages without clamping them", () => {
  assert.deepEqual(
    { ageMs: quoteFreshness(NOW, NOW).ageMs, label: quoteFreshness(NOW, NOW).label },
    { ageMs: 0, label: "0s" },
  );
  const stale = quoteFreshness(NOW - 60_000, NOW);
  assert.equal(stale.valid, true);
  assert.equal(stale.ageMs, 60_000);
  assert.equal(stale.label, "60s");
});

test("freshness formatter never renders negative or impossible values", () => {
  assert.equal(formatQuoteFreshness(0), "0s");
  assert.equal(formatQuoteFreshness(3_000), "3s");
  assert.equal(formatQuoteFreshness(-1), "Unavailable");
  assert.equal(formatQuoteFreshness(Number.NaN), "Unavailable");
  assert.equal(formatQuoteFreshness(null), "Unavailable");
});
