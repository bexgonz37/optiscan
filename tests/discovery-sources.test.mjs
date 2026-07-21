import test from "node:test";
import assert from "node:assert/strict";
import { classifyEarningsCandidate, defaultEarningsConfig } from "../lib/research/discovery/earnings.ts";
import { classifyOptionsActivity, defaultOptionsActivityConfig } from "../lib/research/discovery/options-activity.ts";

const NOW = Date.UTC(2024, 5, 3, 13, 0, 0); // arbitrary
const eCfg = defaultEarningsConfig({});
const snap = (over = {}) => ({ price: 40, prevClose: 38, dayDollarVolume: 50_000_000, relVolume: 4, gapPct: 5, optionsAvailable: true, halted: false, lastTradeAgeMs: 1000, securityType: "common", ...over });

// ── earnings discovery ──
test("3. earnings candidates are discovered from the earnings source (categories + gap + abnormal vol)", () => {
  const c = classifyEarningsCandidate({ symbol: "TGT", expectedAtMs: NOW - 3_600_000, session: "bmo", confirmed: true, provenance: "provider:x" }, snap(), NOW, eCfg);
  assert.ok(c.categories.includes("post_earnings"));
  assert.ok(c.categories.includes("earnings_gap"));
  assert.ok(c.categories.includes("abnormal_premarket_vol"));
  assert.equal(c.timingConfirmed, true);
  assert.equal(c.eligible, true);
});

test("upcoming earnings within the window are flagged; confirmed vs estimated is preserved", () => {
  const up = classifyEarningsCandidate({ symbol: "IREN", expectedAtMs: NOW + 24 * 3_600_000, session: "amc", confirmed: false, provenance: "estimate" }, snap({ gapPct: 0, relVolume: 1 }), NOW, eCfg);
  assert.ok(up.categories.includes("earnings_upcoming"));
  assert.equal(up.timingConfirmed, false, "estimated timing preserved");
});

test("11a. STALE/incorrect earnings dates are rejected (never trusted as upcoming)", () => {
  const stale = classifyEarningsCandidate({ symbol: "XYZ", expectedAtMs: NOW - 96 * 3_600_000, session: "bmo", confirmed: false, provenance: "estimate" }, snap(), NOW, eCfg);
  assert.match(stale.rejectionReason, /stale/i);
  assert.equal(stale.eligible, false);
  assert.equal(stale.categories.length, 0);
  const noTiming = classifyEarningsCandidate({ symbol: "XYZ", expectedAtMs: null, session: "unknown", confirmed: false, provenance: "estimate" }, snap(), NOW, eCfg);
  assert.match(noTiming.rejectionReason, /no earnings timing/);
});

// ── options-activity discovery ──
const oaCfg = defaultOptionsActivityConfig({});
const contract = (over = {}) => ({ side: "call", strike: 42, dte: 7, bid: 1.2, ask: 1.3, spreadPct: 8, volume: 5000, openInterest: 1000, iv: 0.6, providerTimestamp: NOW - 1000, ...over });
const oaInput = (over = {}) => ({ symbol: "IREN", underlyingPrice: 40, underlyingDollarVolume: 50_000_000, chainAvailable: true, baselineDailyOptionVolume: 2000, contracts: [contract(), contract({ strike: 45, volume: 4000 }), contract({ strike: 48, volume: 3000 })], ...over });

test("4. options-activity is discovered from authoritative chain data (vol/OI + baseline + skew)", () => {
  const r = classifyOptionsActivity(oaInput(), NOW, oaCfg);
  assert.equal(r.abstain, false, "abnormal activity detected");
  assert.equal(r.direction, "call_skew");
  assert.ok(r.liquidUnusualContracts >= 1);
  assert.ok(r.volVsBaselineRatio > 1);
});

test("12. options activity is NEVER labeled institutional/sweep flow (snapshot has no tape)", () => {
  const r = classifyOptionsActivity(oaInput(), NOW, oaCfg);
  assert.equal(r.flowClassification, "unclassified_no_trade_data");
});

test("11b. options-activity abstains on stale chain / excessive spread / zero-bid / insufficient liquidity", () => {
  assert.match(classifyOptionsActivity({ ...oaInput(), contracts: oaInput().contracts.map((c) => ({ ...c, providerTimestamp: NOW - 999_999 })) }, NOW, oaCfg).reasons.join(","), /stale_option_chain/);
  const wide = classifyOptionsActivity({ ...oaInput(), contracts: oaInput().contracts.map((c) => ({ ...c, spreadPct: 40 })) }, NOW, oaCfg);
  assert.match(wide.reasons.join(","), /insufficient_liquid_contracts/);
  const zero = classifyOptionsActivity({ ...oaInput(), contracts: oaInput().contracts.map((c) => ({ ...c, bid: 0 })) }, NOW, oaCfg);
  assert.match(zero.reasons.join(","), /insufficient_liquid_contracts/);
  assert.match(classifyOptionsActivity({ ...oaInput(), chainAvailable: false }, NOW, oaCfg).reasons.join(","), /chain_unavailable_or_no_provenance/);
});

test("balanced call/put volume is directionally AMBIGUOUS (not called a directional signal)", () => {
  const balanced = classifyOptionsActivity({ ...oaInput(), contracts: [contract({ side: "call", volume: 3000 }), contract({ side: "put", strike: 38, volume: 3000 }), contract({ side: "call", strike: 45, volume: 100 })] }, NOW, oaCfg);
  assert.equal(balanced.direction, "ambiguous");
  assert.equal(balanced.directionalImbalance, null);
  assert.ok(balanced.reasons.includes("directionally_ambiguous"));
});
