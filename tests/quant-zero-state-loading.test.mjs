/**
 * quant-zero-state-loading.test.mjs — "not finished" must never be reported as "failed".
 *
 * Production symptom: every visit to /quant showed
 *   "Could not load Quant Lab — The snapshot request returned no data.
 *    These figures are UNKNOWN, not zero — no outcome was read."
 *
 * The API was healthy throughout (verified authenticated in production: HTTP 200,
 * ok:true, sampleSize 102, full breakdowns). The page mounts with report=null and
 * loadError=null, and the classifier treated that first paint as LOAD_FAILED — so
 * the UI accused a working backend before any request had resolved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideQuantZeroState } from "../lib/research/options/quant-zero-state.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("REGRESSION: the first paint is LOADING, not LOAD_FAILED", () => {
  const s = decideQuantZeroState({ loadError: null, report: null, pending: true });
  assert.equal(s.kind, "LOADING");
  assert.doesNotMatch(s.headline, /Could not load/);
  assert.doesNotMatch(s.detail, /returned no data/);
});

test("loading still refuses to render numbers or a sample size", () => {
  const s = decideQuantZeroState({ loadError: null, report: null, pending: true });
  assert.equal(s.metricsRenderable, false, "no metric may render before data arrives");
  assert.equal(s.sampleSizeKnown, false, "an unknown sample size must not read as 0");
  assert.match(s.detail, /UNKNOWN/, "must still say the figures are unknown, not zero");
});

test("a real fault outranks pending", () => {
  const s = decideQuantZeroState({ loadError: "HTTP 401", report: null, pending: true });
  assert.equal(s.kind, "LOAD_FAILED");
  assert.match(s.detail, /HTTP 401/, "the actual failure must be surfaced, not hidden by a spinner");
});

test("a settled empty response is still LOAD_FAILED, not LOADING", () => {
  const s = decideQuantZeroState({ loadError: null, report: null, pending: false });
  assert.equal(s.kind, "LOAD_FAILED");
  assert.match(s.detail, /returned no data/);
});

test("real production-shaped data still renders", () => {
  // Shape taken from the live authenticated response.
  const s = decideQuantZeroState({ loadError: null, report: { sampleSize: 102 }, pending: false });
  assert.equal(s.kind, "DATA_PRESENT");
  assert.equal(s.metricsRenderable, true);
  assert.equal(s.sampleSizeKnown, true);
  assert.match(s.headline, /102 verified closed outcomes/);
});

test("data arriving while a background refresh runs is not re-flagged as loading", () => {
  // `pending` means "no attempt has settled yet", not "a refresh is in flight".
  const s = decideQuantZeroState({ loadError: null, report: { sampleSize: 5 }, pending: false });
  assert.equal(s.kind, "DATA_PRESENT");
});

test("the page only claims settled once an attempt finishes, in a finally block", () => {
  const page = read("app/quant/page.tsx");
  assert.match(page, /useState\(false\)/, "settled must start false");
  assert.match(page, /finally\s*\{[^}]*setSettled\(true\)/,
    "settled must be set however the attempt ends, including on throw");
  assert.match(page, /pending: !settled/, "the classifier must receive the settled flag");
});
