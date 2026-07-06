// Runs with Node's type stripping (Node >= 22.18 on by default; the test
// script also passes --experimental-strip-types for older 22.x).
import test from "node:test";
import assert from "node:assert/strict";
import { cached, cachedMaxAge, clearCache, mapLimit } from "../lib/scan-cache.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("cachedMaxAge: concurrent cold-cache callers share ONE in-flight scan", async () => {
  clearCache();
  let runs = 0;
  const fn = async () => {
    runs += 1;
    await sleep(30);
    return runs;
  };
  // momentum + unusual endpoints hitting a cold cache on the same tick
  const [a, b] = await Promise.all([
    cachedMaxAge("scan", 1000, fn),
    cachedMaxAge("scan", 1000, fn),
  ]);
  assert.equal(runs, 1, "duplicate scan ran on cold cache");
  assert.equal(a, b);
});

test("cachedMaxAge: fresh value served, stale value refreshed", async () => {
  clearCache();
  let runs = 0;
  const fn = async () => ++runs;
  await cachedMaxAge("k", 1000, fn);
  await cachedMaxAge("k", 1000, fn);
  assert.equal(runs, 1);
  await sleep(20);
  await cachedMaxAge("k", 5, fn); // maxAge 5ms -> stale -> re-run
  assert.equal(runs, 2);
});

test("cached: rejections are not cached, next caller retries", async () => {
  clearCache();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return "ok";
  };
  await assert.rejects(() => cached("f", 1000, flaky));
  assert.equal(await cached("f", 1000, flaky), "ok");
  assert.equal(calls, 2);
});

test("cached: TTL respected", async () => {
  clearCache();
  let calls = 0;
  const fn = async () => ++calls;
  assert.equal(await cached("t", 10_000, fn), 1);
  assert.equal(await cached("t", 10_000, fn), 1);
  assert.equal(calls, 1);
});

test("mapLimit bounds concurrency and preserves order", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(10);
    inFlight -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.ok(peak <= 2, `concurrency peaked at ${peak}`);
});
