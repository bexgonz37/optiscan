import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFingerprint,
  canonicalize,
  humanReadable,
  strategyVersionFor,
  FINGERPRINT_VERSION,
  DIMENSION_KEYS,
} from "../lib/setup-fingerprint.ts";

const ENTRY = Date.parse("2026-07-09T14:00:00Z"); // 10:00 ET → OPEN bucket

const base = () => ({
  strategy: "zero_dte_momentum",
  instrument: "option",
  optionType: "call",
  triggerFamily: "TRADE",
  session: "regular",
  entryAtMs: ENTRY,
  dte: 0,
  delta: 0.48,
  spreadPct: 2.5,
  relVol: 3.1,
  aboveVwap: true,
  lifecycleState: "actionable",
  selectorProfile: "zero_dte_momentum",
  momentum: 5,
  moveClassification: "breakout",
});

// (1) identical inputs → identical fingerprint
test("identical inputs produce the same fingerprint id", () => {
  const a = buildFingerprint(base());
  const b = buildFingerprint(base());
  assert.equal(a.id, b.id);
  assert.match(a.id, /^sf1_[0-9a-f]{16}$/);
});

// (2) object property order does not change the fingerprint
test("property order does not change the fingerprint", () => {
  const a = buildFingerprint(base());
  // Rebuild the same input with keys inserted in a different order.
  const reordered = {};
  for (const k of Object.keys(base()).reverse()) reordered[k] = base()[k];
  const b = buildFingerprint(reordered);
  assert.equal(a.id, b.id);
  assert.equal(a.canonical, b.canonical);
});

// (3) determinism across calls (restart/process stability of a pure sha256)
test("fingerprint is deterministic across repeated builds", () => {
  const ids = new Set();
  for (let i = 0; i < 25; i++) ids.add(buildFingerprint(base()).id);
  assert.equal(ids.size, 1);
});

// (4) different fingerprint versions create distinguishable identifiers
test("fingerprint version participates in canonical payload and id", () => {
  const fp = buildFingerprint(base());
  assert.ok(fp.canonical.includes(`|v${FINGERPRINT_VERSION}|`));
  assert.ok(fp.id.startsWith(`sf${FINGERPRINT_VERSION}_`));
  assert.notEqual(canonicalize(fp.dimensions, 1), canonicalize(fp.dimensions, 2));
});

// (5) strategy-version changes are preserved and change identity
test("strategy version is preserved in dimensions and affects the id", () => {
  const known = buildFingerprint(base());
  assert.equal(known.dimensions.strategyVersion, String(strategyVersionFor("zero_dte_momentum")));
  const unknown = buildFingerprint({ ...base(), strategy: "totally_new_profile" });
  assert.equal(unknown.dimensions.strategyVersion, "0"); // unknown ⇒ version 0
  assert.notEqual(known.id, unknown.id);
});

// (6) case differences are canonicalized
test("casing is normalized (lower vs upper produce same id)", () => {
  const a = buildFingerprint({ ...base(), session: "REGULAR", strategy: "ZERO_DTE_MOMENTUM" });
  const b = buildFingerprint({ ...base(), session: "regular", strategy: "zero_dte_momentum" });
  // strategy is a registry key (case-sensitive for version) but its dimension is uppercased;
  // both map to the same enum + same version, so ids match.
  assert.equal(a.id, b.id);
});

// (7) null optional dimensions remain explicit (NA)
test("stock trade leaves option-only dimensions explicitly NA", () => {
  const fp = buildFingerprint({
    strategy: "momentum_stock", instrument: "stock", optionType: "call",
    session: "regular", entryAtMs: ENTRY, dte: null, delta: null, spreadPct: null,
    relVol: 2, aboveVwap: false,
  });
  assert.equal(fp.dimensions.dteBucket, null);
  assert.equal(fp.dimensions.deltaBand, null);
  assert.equal(fp.dimensions.direction, "LONG");
  assert.ok(fp.canonical.includes("deltaBand=NA"));
});

// (8) NaN and Infinity are rejected/normalized safely
test("NaN and Infinity are rejected to NA with a data-quality reason", () => {
  const fp = buildFingerprint({ ...base(), delta: NaN, spreadPct: Infinity, relVol: -Infinity });
  assert.equal(fp.dimensions.deltaBand, null);
  assert.equal(fp.dimensions.spreadBand, null);
  assert.equal(fp.dimensions.relVolBucket, null);
  assert.ok(fp.dataQualityReasons.includes("delta_invalid"));
  assert.ok(fp.dataQualityReasons.includes("spread_invalid"));
  // A NaN-laden build must still yield a valid, stable id.
  assert.match(fp.id, /^sf1_[0-9a-f]{16}$/);
});

// (9) future/exit fields cannot enter a fingerprint
test("unknown/exit fields have no channel into the fingerprint", () => {
  const clean = buildFingerprint(base());
  const polluted = buildFingerprint({
    ...base(),
    exitPrice: 9.99, exitReason: "take_profit", netPnl: 500, mfePct: 80, maePct: -10,
    exitAtMs: ENTRY + 1_000_000, finalVolume: 1e9,
  });
  assert.equal(clean.id, polluted.id, "exit/future fields must not affect the fingerprint");
});

// (25) canonical dimensions remain human-readable
test("human-readable summary is legible and skips NA", () => {
  const fp = buildFingerprint(base());
  const h = humanReadable(fp.dimensions);
  assert.ok(h.includes("strategy=ZERO_DTE_MOMENTUM"));
  assert.ok(h.includes("session=REGULAR"));
  assert.ok(!h.includes("=NA"));
});

test("dimension key set is fixed and complete", () => {
  const fp = buildFingerprint(base());
  assert.deepEqual(Object.keys(fp.dimensions).sort(), [...DIMENSION_KEYS].sort());
});
