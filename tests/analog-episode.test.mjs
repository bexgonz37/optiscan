import test from "node:test";
import assert from "node:assert/strict";
import { episodeKeyOf, maxFeatureAsOf, FEATURE_SCHEMA_VERSION, HORIZONS } from "../lib/research/episode/schema.ts";
import { validateEpisodeNoLookahead, validateLabelForward, assertForwardBars } from "../lib/research/episode/leakage.ts";
import { computeUnderlyingLabel, computeModeledOptionLabel } from "../lib/research/episode/labels.ts";

function episode(over = {}) {
  return {
    source: "replay", symbol: "nvda", t0Ms: 1000, tradingDay: "2026-07-10", session: "regular",
    todBucket: "open", assetClass: "stock", direction: "bullish", regimeLabel: "trend", regimeModelVersion: 1,
    liquidityTier: "high", validityTier: "PRODUCTION_QUALITY",
    blocks: {
      priceStructure: { asOfMs: 1000, values: { vwapPos: 0.3 } },
      momentum: { asOfMs: 900, values: { vel5m: 1.2 } },
      volume: { asOfMs: 1000, values: { rvol: 4.1 } },
    },
    missing: ["optionsContext"], gateResults: { freshness: { passed: true } },
    featureSchemaVersion: FEATURE_SCHEMA_VERSION, provenance: { run: "seed" }, ...over,
  };
}
// entry 100 @ t0=1000; bars strictly forward; bull target 105 / stop 97.
const bars = [
  { t: 2000, o: 100, h: 103, l: 99, c: 102, v: 1 },
  { t: 3000, o: 102, h: 106, l: 101, c: 105, v: 1 },
  { t: 4000, o: 105, h: 104, l: 98, c: 100, v: 1 },
];

// ── schema ───────────────────────────────────────────────────────────────────
test("episode key is deterministic and reproducible", () => {
  assert.equal(episodeKeyOf("replay", "NVDA", 1000), episodeKeyOf("replay", "nvda", 1000));
  assert.notEqual(episodeKeyOf("replay", "NVDA", 1000), episodeKeyOf("replay", "NVDA", 2000));
  assert.equal(HORIZONS.length, 8);
});

test("maxFeatureAsOf returns the latest block time (the leakage-guard value)", () => {
  assert.equal(maxFeatureAsOf(episode()), 1000);
  assert.equal(maxFeatureAsOf(episode({ blocks: {} })), 0);
});

// ── leakage guard (adversarial) ──────────────────────────────────────────────
test("valid episode passes the no-look-ahead guard", () => {
  assert.equal(validateEpisodeNoLookahead(episode()).ok, true);
});

test("a Zone-A block computed AFTER t0 is rejected as look-ahead", () => {
  const bad = episode({ blocks: { momentum: { asOfMs: 1500, values: {} } } });
  const v = validateEpisodeNoLookahead(bad);
  assert.equal(v.ok, false);
  assert.match(v.violations.join(" "), /look-ahead/);
});

test("a label using data at/<= t0 is rejected; strictly-forward is accepted", () => {
  assert.equal(validateLabelForward({ labelAsOfMs: 1000 }, 1000).ok, false);
  assert.equal(validateLabelForward({ labelAsOfMs: 1001 }, 1000).ok, true);
});

test("assertForwardBars throws on any bar at/<= t0", () => {
  assert.throws(() => assertForwardBars([{ t: 1000 }], 1000), /look-ahead/);
  assert.doesNotThrow(() => assertForwardBars([{ t: 1001 }], 1000));
});

// ── underlying labels ────────────────────────────────────────────────────────
test("underlying label math is correct and side-aware (bullish)", () => {
  const l = computeUnderlyingLabel({ t0Ms: 1000, horizon: "1h", entryPrice: 100, side: "bullish", forwardBars: bars, horizonEndMs: 4000, targetPct: 5, stopPct: 3 });
  assert.equal(l.targetBeforeStop, "TARGET");
  assert.equal(l.timeToTargetMs, 2000);
  assert.equal(l.mfePct, 6);          // max (106-100)/100
  assert.equal(l.maePct, -2);         // min (98-100)/100
  assert.equal(l.returnPct, 0);       // last close 100 vs entry 100
  assert.equal(l.outcomeKind, "REAL_UNDERLYING");
  assert.equal(l.labelAsOfMs, 4000);
});

test("underlying label excludes any bar at/<= t0 (no leakage into the label)", () => {
  const withPast = [{ t: 500, o: 100, h: 200, l: 100, c: 200, v: 1 }, ...bars]; // t=500 <= t0 must be ignored
  const l = computeUnderlyingLabel({ t0Ms: 1000, horizon: "1h", entryPrice: 100, side: "bullish", forwardBars: withPast, horizonEndMs: 4000, targetPct: 5, stopPct: 3 });
  assert.equal(l.mfePct, 6, "the pre-t0 bar's 200 high did not leak into MFE");
});

test("no forward bars in window → null label (never fabricated)", () => {
  assert.equal(computeUnderlyingLabel({ t0Ms: 1000, horizon: "15m", entryPrice: 100, side: "bullish", forwardBars: bars, horizonEndMs: 1000, targetPct: 5, stopPct: 3 }), null);
});

// ── modeled option label ─────────────────────────────────────────────────────
test("modeled option label is flagged MODELED and carries its assumptions", () => {
  const l = computeModeledOptionLabel({ t0Ms: 1000, horizon: "1h", targetKind: "OPTION_ATM_CALL", underlyingEntry: 100, forwardBars: bars, horizonEndMs: 4000, entryPremium: 2, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.1, entryIV: 0.5 });
  assert.equal(l.outcomeKind, "MODELED_OPTION");
  assert.equal(l.targetKind, "OPTION_ATM_CALL");
  assert.match(l.modelAssumptions.note, /MODELED/);
  assert.equal(l.modelAssumptions.method, "greeks_taylor_reprice");
  assert.ok(Number.isFinite(l.returnPct));
  assert.equal(l.gapPct, null, "gap not defined for a modeled option path");
});
