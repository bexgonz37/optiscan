/**
 * tests/provider-timestamp.test.mjs
 *
 * Provider clock normalization, written against REAL production values.
 *
 * The defect: Polygon returns option quote timestamps in nanoseconds and every
 * freshness check compared them to Date.now() in milliseconds. `now - ts` was
 * hugely negative, so quotes read as far in the future and High-Asymmetry
 * refused 1167/1167 candidates as EVIDENCE_FROM_FUTURE — correctly, on bad
 * input. These are the exact raw values recorded from production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeProviderTimestamp, providerTimestampMs, providerTimestampUnit,
} from "../lib/provider-timestamp.js";

// Recorded from production capture telemetry on 2026-07-31.
const REAL_NS_COIN = 1785510912137034800;
const REAL_NS_CRWV = 1785510913640033500;
const REAL_NOW_MS = 1785510921734;

test("the real production nanosecond value normalizes to the right millisecond", () => {
  const r = normalizeProviderTimestamp(REAL_NS_COIN);
  assert.equal(r.unit, "ns");
  assert.equal(r.rejected, null);
  assert.equal(r.ms, 1785510912137);
  // The whole point: it must now be in the PAST relative to the same clock.
  assert.ok(r.ms < REAL_NOW_MS, "the quote must read as past, not future");
  assert.ok(REAL_NOW_MS - r.ms < 60_000, "and be seconds old, not decades");
});

test("both recorded production samples behave identically", () => {
  for (const raw of [REAL_NS_COIN, REAL_NS_CRWV]) {
    const r = normalizeProviderTimestamp(raw);
    assert.equal(r.unit, "ns");
    assert.ok(r.ms < REAL_NOW_MS && REAL_NOW_MS - r.ms < 60_000);
  }
});

test("all four units are detected from real-shaped values", () => {
  const base = 1785510912137; // ms
  assert.equal(providerTimestampUnit(Math.floor(base / 1000)), "s");
  assert.equal(providerTimestampUnit(base), "ms");
  assert.equal(providerTimestampUnit(base * 1000), "us");
  assert.equal(providerTimestampUnit(base * 1e6), "ns");
  // Every one resolves to the same instant.
  for (const v of [Math.floor(base / 1000) * 1000, base, base * 1000, base * 1e6]) {
    assert.ok(Math.abs(providerTimestampMs(v) - base) <= 1000);
  }
});

test("A VALUE ALREADY IN MILLISECONDS IS UNCHANGED — the fix is a no-op where it was correct", () => {
  // This is what makes it safe to apply at boundaries that were already right.
  for (const ms of [1785510921734, 1600000000000, 2500000000000]) {
    assert.equal(providerTimestampMs(ms), ms);
    assert.equal(providerTimestampUnit(ms), "ms");
  }
});

test("missing, malformed, negative and non-finite input is rejected, never fabricated", () => {
  for (const [raw, expected] of [
    [null, "ABSENT"], [undefined, "ABSENT"], ["", "ABSENT"],
    ["not-a-number", "NOT_FINITE"], [NaN, "NOT_FINITE"], [Infinity, "NOT_FINITE"],
    [0, "NON_POSITIVE"], [-1785510921734, "NON_POSITIVE"],
  ]) {
    const r = normalizeProviderTimestamp(raw);
    assert.equal(r.ms, null, `${String(raw)} must yield null`);
    assert.equal(r.rejected, expected);
  }
});

test("an ambiguous magnitude is REFUSED rather than guessed", () => {
  // Between the bands: not attributable to a unit, so not a timestamp.
  for (const v of [1, 12345, 5e10, 5e13, 5e16, 9e19]) {
    const r = normalizeProviderTimestamp(v);
    assert.equal(r.ms, null, `${v} must not be coerced`);
    assert.equal(r.unit, "UNKNOWN");
  }
});

test("nothing ever falls back to the current time", () => {
  // Strip comments: the module EXPLAINS why it never fabricates now, and a
  // bare match would flag the explanation rather than any code.
  const src = stripComments(readFileSync("lib/provider-timestamp.js", "utf8"));
  assert.equal(/Date\.now\(\)/.test(src), false,
    "fabricating 'now' would turn missing data into fake freshness");
});

test("a genuinely future quote is still future after normalization", () => {
  // Normalization fixes units; it must not make real future evidence acceptable.
  const futureNs = (REAL_NOW_MS + 10 * 60_000) * 1e6;
  const r = normalizeProviderTimestamp(futureNs);
  assert.equal(r.unit, "ns");
  assert.ok(r.ms > REAL_NOW_MS, "a genuinely future timestamp must remain in the future");
});

test("a genuinely stale quote is still stale after normalization", () => {
  const staleNs = (REAL_NOW_MS - 45 * 60_000) * 1e6;
  const r = normalizeProviderTimestamp(staleNs);
  assert.ok(REAL_NOW_MS - r.ms > 30 * 60_000, "staleness must survive normalization");
});

test("no freshness threshold is changed by this module", () => {
  const src = stripComments(readFileSync("lib/provider-timestamp.js", "utf8"));
  assert.equal(/MAX_.*AGE|maxAge|threshold|STALE_MS/i.test(src), false,
    "this module converts units and nothing else");
});

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("the provider applies normalization at BOTH quote boundaries", () => {
  const src = readFileSync("lib/polygon-provider.js", "utf8");
  assert.match(src, /import \{ providerTimestampMs \} from "\.\/provider-timestamp\.js"/);
  // Only assignments that READ a raw provider field are boundaries. Re-passing
  // an already-normalized value (e.g. into recordDataSample) is not one.
  const RAW = /last_updated|sip_timestamp|lastTrade\?\.t|\bmin\.t\b|\bday\.t\b/;
  const assignments = [...src.matchAll(/providerTimestamp:\s*([^\n]+)/g)]
    .map((m) => m[1]).filter((a) => RAW.test(a));
  assert.ok(assignments.length >= 2, "both the stock and options boundaries must be covered");
  for (const a of assignments) {
    assert.match(a, /providerTimestampMs\(/, `raw value assigned without normalization: ${a}`);
    assert.equal(/numOrNull\(/.test(a), false, "the un-normalized path must be gone");
  }
});
