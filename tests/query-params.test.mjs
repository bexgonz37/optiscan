/**
 * tests/query-params.test.mjs
 *
 * The absent-parameter case is the whole point. `Number(null)` is 0 and
 * `Number.isFinite(0)` is true, so the widespread "parse then fall back if not
 * finite" idiom silently clamps an ABSENT parameter to the minimum instead of
 * using its own documented default.
 *
 * On /api/research/asymmetry/timing that turned a default of 200 into 1, and
 * every counter derived from the row list reported a one-row session: a real
 * High-Asymmetry alert was reported as `notifiedCaptures: 0`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { intParam } from "../lib/query-params.ts";

const params = (qs) => new URL(`https://x.test/?${qs}`).searchParams;

test("an ABSENT parameter yields the fallback, not the clamped zero", () => {
  assert.equal(intParam(params(""), "limit", 200, 1, 1000), 200);
});

test("the naive idiom this replaces would have returned the minimum", () => {
  // Documents the exact defect so a future refactor cannot reintroduce it.
  const raw = params("").get("limit");
  const naive = Number(raw);
  assert.equal(naive, 0, "Number(null) is 0");
  assert.equal(Number.isFinite(naive), true, "...and 0 is finite, so the fallback never runs");
  assert.notEqual(Math.max(1, Math.min(1000, naive)), 200, "the naive path cannot reach its own default");
});

test("an EMPTY parameter yields the fallback", () => {
  assert.equal(intParam(params("limit="), "limit", 200, 1, 1000), 200);
  assert.equal(intParam(params("limit=%20%20"), "limit", 200, 1, 1000), 200);
});

test("a non-numeric parameter yields the fallback", () => {
  assert.equal(intParam(params("limit=all"), "limit", 200, 1, 1000), 200);
  assert.equal(intParam(params("limit=NaN"), "limit", 200, 1, 1000), 200);
});

test("a supplied value is used", () => {
  assert.equal(intParam(params("limit=37"), "limit", 200, 1, 1000), 37);
});

test("a supplied value is clamped to the bounds", () => {
  assert.equal(intParam(params("limit=99999"), "limit", 200, 1, 1000), 1000);
  assert.equal(intParam(params("limit=-5"), "limit", 200, 1, 1000), 1);
});

test("a supplied zero is honoured as a value and clamped, not read as absent", () => {
  assert.equal(intParam(params("limit=0"), "limit", 200, 1, 1000), 1);
});

test("fractional values truncate rather than producing a fractional LIMIT", () => {
  assert.equal(intParam(params("limit=12.9"), "limit", 200, 1, 1000), 12);
});

test("Infinity is not finite and falls back", () => {
  assert.equal(intParam(params("limit=Infinity"), "limit", 200, 1, 1000), 200);
});
