import test from "node:test";
import assert from "node:assert/strict";
import { extractFeatures, featureNames, featureCoverage, FEATURE_SCHEMA_VERSION, VOCAB } from "../lib/model-features.ts";

test("feature names are deterministic and sorted", () => {
  const a = featureNames();
  const b = featureNames();
  assert.deepEqual(a, b);
  assert.deepEqual(a, [...a].sort());
});

test("known categorical one-hots exactly one column and clears the missing flag", () => {
  const fv = extractFeatures({ session: "regular" });
  const on = fv.names.filter((n, i) => n.startsWith("session=") && fv.values[i] === 1);
  assert.deepEqual(on, ["session=REGULAR"]);
  assert.equal(fv.values[fv.names.indexOf("session__missing")], 0);
  assert.equal(fv.missing.session, false);
});

test("out-of-vocabulary / missing categorical sets the missing indicator", () => {
  const fv = extractFeatures({ session: "lunar_eclipse" });
  assert.equal(fv.values[fv.names.indexOf("session__missing")], 1);
  assert.equal(fv.missing.session, true);
  for (const cat of VOCAB.session) assert.equal(fv.values[fv.names.indexOf(`session=${cat}`)], 0);
});

test("numeric feature carries value + missing indicator", () => {
  const present = extractFeatures({ entryDelta: 0.5 });
  assert.equal(present.values[present.names.indexOf("num:entryDelta")], 0.5);
  assert.equal(present.values[present.names.indexOf("num:entryDelta__missing")], 0);
  const absent = extractFeatures({});
  assert.equal(absent.values[absent.names.indexOf("num:entryDelta__missing")], 1);
});

test("NaN/Infinity numerics are treated as missing (never injected)", () => {
  const fv = extractFeatures({ entryDelta: NaN, entryIv: Infinity });
  assert.equal(fv.missing.entryDelta, true);
  assert.equal(fv.missing.entryIv, true);
  assert.equal(fv.values[fv.names.indexOf("num:entryDelta")], 0);
});

test("vector length matches the schema and is stable across inputs", () => {
  const a = extractFeatures({ strategy: "zero_dte_momentum" });
  const b = extractFeatures({});
  assert.equal(a.values.length, featureNames().length);
  assert.equal(a.values.length, b.values.length);
  assert.equal(a.schemaVersion, FEATURE_SCHEMA_VERSION);
});

test("extraction is deterministic and property-order independent", () => {
  const a = extractFeatures({ session: "regular", direction: "call", dteBucket: "0DTE" });
  const b = extractFeatures({ dteBucket: "0DTE", direction: "call", session: "regular" });
  assert.deepEqual(a.values, b.values);
});

test("coverage reflects present whitelisted fields", () => {
  const full = extractFeatures({
    strategy: "zero_dte_momentum", direction: "call", session: "regular", todBucket: "open",
    dteBucket: "0DTE", deltaBand: "0.45-0.55", spreadBand: "tight", relVolBucket: "2-4",
    vwapState: "above", moveClassification: "breakout", instrument: "option",
    ctxRiskState: "risk_on", ctxStructure: "trending", ctxVolatility: "low",
    dteAtEntry: 0, entryDelta: 0.5, entrySpreadPct: 2, relVol: 3, entryIv: 0.4, selectionScore: 80,
  });
  assert.equal(featureCoverage(full), 1);
  assert.ok(featureCoverage(extractFeatures({})) < 0.1);
});
