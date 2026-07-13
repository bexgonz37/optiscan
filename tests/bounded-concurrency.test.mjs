import test from "node:test";
import assert from "node:assert/strict";
import { mapLimit, envConcurrency } from "../lib/bounded-concurrency.ts";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("mapLimit runs work with a bounded parallel ceiling and preserves input order", async () => {
  let active = 0;
  let maxActive = 0;
  const result = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(n === 1 ? 20 : 1);
    active -= 1;
    return n * 10;
  });
  assert.equal(maxActive, 2);
  assert.deepEqual(result, [10, 20, 30, 40, 50]);
});

test("envConcurrency clamps supervisor chain concurrency", () => {
  assert.equal(envConcurrency({ SUPERVISOR_CHAIN_CONCURRENCY: "4" }, "SUPERVISOR_CHAIN_CONCURRENCY", 3, 12), 4);
  assert.equal(envConcurrency({ SUPERVISOR_CHAIN_CONCURRENCY: "99" }, "SUPERVISOR_CHAIN_CONCURRENCY", 3, 12), 12);
  assert.equal(envConcurrency({ SUPERVISOR_CHAIN_CONCURRENCY: "0" }, "SUPERVISOR_CHAIN_CONCURRENCY", 3, 12), 3);
});
