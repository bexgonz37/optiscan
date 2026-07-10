import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTimestamp, toMs, toIso, TS_MAX_FUTURE_SKEW_MS } from "../lib/timestamps.ts";

// Fixed "now" so plausibility checks are deterministic.
const NOW = Date.parse("2026-07-10T15:00:00.000Z");
const BASE_S = 1720627200;               // 2024-07-10T16:00:00Z in seconds
const BASE_MS = 1720627200000;

const n = (v) => normalizeTimestamp(v, NOW);

test("Unix seconds → ms", () => {
  const r = n(BASE_S);
  assert.equal(r.valid, true);
  assert.equal(r.sourceUnit, "seconds");
  assert.equal(r.milliseconds, BASE_MS);
});

test("Unix milliseconds unchanged", () => {
  const r = n(BASE_MS);
  assert.equal(r.sourceUnit, "milliseconds");
  assert.equal(r.milliseconds, BASE_MS);
});

test("Polygon microseconds → /1,000", () => {
  const r = n(1720627200000000);
  assert.equal(r.sourceUnit, "microseconds");
  assert.equal(r.milliseconds, BASE_MS);
});

test("Polygon nanoseconds → /1,000,000 (the live bug)", () => {
  const r = n(1720627200000000000);
  assert.equal(r.sourceUnit, "nanoseconds");
  assert.equal(r.milliseconds, BASE_MS);
  assert.equal(r.iso, "2024-07-10T16:00:00.000Z");
});

test("bigint nanoseconds scale in bigint space before Number conversion", () => {
  const r = n(1720627200123456789n);
  assert.equal(r.valid, true);
  assert.equal(r.sourceUnit, "nanoseconds");
  assert.equal(r.milliseconds, 1720627200123);
});

test("numeric strings in every unit", () => {
  assert.equal(n(String(BASE_S)).milliseconds, BASE_MS);
  assert.equal(n(String(BASE_MS)).milliseconds, BASE_MS);
  assert.equal(n("1720627200000000000").milliseconds, BASE_MS);
});

test("fractional-seconds float classifies as seconds (not 1970 garbage)", () => {
  const r = n(1720627200.123);
  assert.equal(r.sourceUnit, "seconds");
  assert.equal(r.milliseconds, 1720627200123);
});

test("ISO strings and Date objects", () => {
  assert.equal(n("2024-07-10T16:00:00.000Z").milliseconds, BASE_MS);
  assert.equal(n("2024-07-10T16:00:00.000Z").sourceUnit, "iso");
  assert.equal(n(new Date(BASE_MS)).milliseconds, BASE_MS);
  assert.equal(n(new Date(BASE_MS)).sourceUnit, "date");
});

test("null / undefined / zero / negative reject cleanly", () => {
  for (const [v, why] of [[null, "missing"], [undefined, "missing"], [0, "zero or negative"], [-BASE_MS, "zero or negative"]]) {
    const r = n(v);
    assert.equal(r.valid, false, String(v));
    assert.equal(r.milliseconds, null);
    assert.equal(r.iso, null);
    assert.ok(r.reason, "reason provided");
  }
});

test("NaN, Infinity, malformed strings, invalid Dates reject cleanly", () => {
  assert.equal(n(NaN).valid, false);
  assert.equal(n(Infinity).valid, false);
  assert.equal(n("not-a-date").valid, false);
  assert.equal(n("").valid, false);
  assert.equal(n(new Date("garbage")).valid, false);
});

test("implausibly old and too-future values reject", () => {
  assert.equal(n(Date.parse("1999-12-31T00:00:00Z")).valid, false, "before 2000 minimum");
  const future = NOW + TS_MAX_FUTURE_SKEW_MS + 60_000;
  assert.equal(n(future).valid, false, "beyond future skew");
  const okFuture = NOW + TS_MAX_FUTURE_SKEW_MS - 1000;
  assert.equal(n(okFuture).valid, true, "small clock skew tolerated");
});

test("NEVER throws Invalid time value — brutal input sweep", () => {
  const inputs = [
    null, undefined, 0, -1, NaN, Infinity, -Infinity, "", "garbage", "1e999",
    9e307, 123n, -5n, 99999999999999999999999999n, new Date("bad"),
    "  1720627200  ", {}.toString, "0.0", ".5", 1720627200000000000,
  ];
  for (const v of inputs) {
    assert.doesNotThrow(() => normalizeTimestamp(v, NOW), `threw on ${String(v)}`);
    assert.doesNotThrow(() => toIso(v, NOW), `toIso threw on ${String(v)}`);
  }
});

test("integration: freshness service uses the central normalizer (ns quote is NOT NO_DATA-aged)", async () => {
  const { normalizeProviderTimestampMs } = await import("../lib/data-freshness.ts");
  // A nanosecond quote timestamp 5 seconds ago must yield a ~5s age, not null/garbage.
  const fiveSecAgoNs = BigInt(NOW - 5000) * 1_000_000n;
  const ms = normalizeProviderTimestampMs(fiveSecAgoNs, NOW);
  assert.equal(ms, NOW - 5000, "ns timestamp normalized to correct ms");
  // and a truly stale one still reads as old — blocking must keep working
  const hourAgoNs = BigInt(NOW - 3_600_000) * 1_000_000n;
  assert.equal(normalizeProviderTimestampMs(hourAgoNs, NOW), NOW - 3_600_000);
});

test("integration: move-timing age math survives a raw nanosecond leak", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../lib/move-timing.ts", import.meta.url), "utf8");
  assert.ok(src.includes("toMs(input.dataTimestampMs"), "move-timing must normalize defensively");
});
