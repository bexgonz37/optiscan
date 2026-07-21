import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { OPTIONS_STRATEGIES, getStrategy, tenorBand, strategyKeys, REPORT_TENOR_BUCKETS } from "../lib/research/options/strategy-catalog.ts";
import { classifyPaperResult, realOptionEntryEligible, defaultRealOptionEntryGate } from "../lib/research/options/paper-class.ts";
import { loadFittedAnalogScorer } from "../lib/research/analog/load.ts";
import { buildAiShadowPrompt, anthropicShadowCaller } from "../lib/ai/shadow-model.ts";

// ── B. strategy catalog is distinct from the +10% stock rule ──
test("options strategies exist for every required setup and NONE require a +10% move", () => {
  const keys = strategyKeys();
  for (const need of ["breakout_forming", "confirmed_breakout", "opening_range_breakout", "premarket_level_break", "sr_reclaim", "pullback_continuation", "trend_continuation", "vol_compression_expansion", "momentum_acceleration", "reversal_bounce", "failed_breakout", "earnings_continuation", "earnings_reversal", "unusual_options_activity", "index_intraday_momentum", "zero_dte_index", "short_dated_directional", "longer_dated_swing"]) {
    assert.ok(keys.includes(need), `missing strategy ${need}`);
  }
  // every strategy has its own full parameter set
  for (const s of OPTIONS_STRATEGIES) {
    assert.ok(s.entryTrigger && s.earlySignals.length > 0);
    assert.ok(s.optionsLiquidity.maxSpreadPct > 0 && s.optionsLiquidity.minOpenInterest > 0);
    assert.ok(s.preferredDte.length > 0 && s.preferredDelta.length === 2);
    assert.ok(s.chaseLimitPct > 0 && s.freshnessMaxMs > 0 && s.stop && s.targets && s.holdingHorizon);
    // NONE of the triggers demand the stock already be up 10%
    assert.ok(!/\b10%|\+10\b/.test(s.entryTrigger), `${s.key} must not require +10%`);
  }
});

test("tenor bands map DTE and the report keeps buckets separate", () => {
  assert.equal(tenorBand(0), "0dte");
  assert.equal(tenorBand(5), "1-7dte");
  assert.equal(tenorBand(12), "8-14dte");
  assert.equal(tenorBand(21), "15-30dte");
  assert.equal(tenorBand(60), "31-90dte");
  assert.equal(tenorBand(200), "longer");
  assert.equal(REPORT_TENOR_BUCKETS.length, 6);
  assert.equal(getStrategy("zero_dte_index").preferredDte[0], "0dte");
});

// ── I. paper-result classification (never combined) ──
test("classifyPaperResult separates equity / real-option / modeled / underlying-proxy", () => {
  assert.equal(classifyPaperResult({ optionSymbol: null }).class, "EQUITY_PAPER");
  assert.equal(classifyPaperResult({ optionSymbol: "O:NVDA260815C00135000", entryBid: 4.1, entryAsk: 4.3, pnlBasis: "option" }).class, "REAL_OPTION_PAPER");
  assert.equal(classifyPaperResult({ optionSymbol: "O:NVDA260815C00135000", entryBid: 4.1, entryAsk: 4.3, outcomeKind: "MODELED_OPTION" }).class, "MODELED_OPTION_RESEARCH");
  assert.equal(classifyPaperResult({ optionSymbol: "O:NVDA260815C00135000", entryBid: 4.1, entryAsk: 4.3, pnlBasis: "underlying" }).class, "UNDERLYING_PROXY_INVALID_FOR_OPTIONS_CLAIMS");
  // an options-context trade lacking a real two-sided quote is NOT certified as a real fill
  assert.equal(classifyPaperResult({ optionSymbol: "O:NVDA260815C00135000", entryBid: 0, entryAsk: null }).class, "MODELED_OPTION_RESEARCH");
});

test("realOptionEntryEligible rejects stale/zero-bid/wide/illiquid contracts", () => {
  const g = defaultRealOptionEntryGate({});
  assert.equal(realOptionEntryEligible({ optionSymbol: "O:NVDA260815C00135000", bid: 4.1, ask: 4.3, spreadPct: 4, quoteAgeMs: 1000, openInterest: 1200, volume: 300 }, g).ok, true);
  assert.match(realOptionEntryEligible({ optionSymbol: "O:NVDA260815C00135000", bid: 0, ask: 4.3, spreadPct: 4, quoteAgeMs: 1000, openInterest: 1200, volume: 300 }, g).rejections.join(","), /zero_bid/);
  assert.match(realOptionEntryEligible({ optionSymbol: "O:NVDA260815C00135000", bid: 4, ask: 9, spreadPct: 40, quoteAgeMs: 1000, openInterest: 1200, volume: 300 }, g).rejections.join(","), /spread_too_wide/);
  assert.match(realOptionEntryEligible({ optionSymbol: "O:NVDA260815C00135000", bid: 4, ask: 4.3, spreadPct: 4, quoteAgeMs: 99999, openInterest: 1200, volume: 300 }, g).rejections.join(","), /stale_quote/);
  assert.match(realOptionEntryEligible({ optionSymbol: "NOTOCC", bid: 4, ask: 4.3, spreadPct: 4, quoteAgeMs: 1000, openInterest: 1200, volume: 300 }, g).rejections.join(","), /no_valid_occ/);
});

// ── G. analog loader abstains (with reason) on a small corpus; never inert-silent ──
test("loadFittedAnalogScorer abstains with an exact reason when the corpus is too small", () => {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE setup_episodes (episode_key TEXT PRIMARY KEY, symbol TEXT, t0_ms INTEGER, direction TEXT, liquidity_tier TEXT, price_structure_json TEXT, momentum_json TEXT, volume_json TEXT, volatility_json TEXT);
          CREATE TABLE episode_labels (episode_key TEXT, horizon TEXT, target_kind TEXT, return_pct REAL, label_as_of_ms INTEGER);`);
  const r = loadFittedAnalogScorer(d, { horizon: "1d", minEpisodes: 200 });
  assert.equal(r.scorer, null);
  assert.equal(r.fit, false);
  assert.match(r.reason, /corpus too small: 0 < 200/);
});

// ── F. AI model adapter builds an authoritative-only prompt + injected provider ──
test("buildAiShadowPrompt uses only provided fields and forbids fabrication/flow claims", () => {
  const input = { symbol: "HOOD", underlying: { price: 20, dollarVolume: 3e7 }, triggerFeatures: { velPct: 1 }, earnings: null, optionsActivity: null, technicalState: null, marketContext: null, analog: null, missing: ["iv"], scannerDecision: { actionable: true, direction: "bullish" }, paperHistory: null };
  const p = buildAiShadowPrompt(input);
  assert.match(p.system, /Never invent/);
  assert.match(p.system, /sweeps\/institutional/);
  assert.ok(p.user.includes("HOOD") && p.user.includes("outputSchema"));
});

test("anthropicShadowCaller returns a costed ModelResult from an injected provider (zero real spend)", async () => {
  const provider = async () => ({ json: { classification: "ABSTAIN" }, inputTokens: 1000, outputTokens: 200 });
  const caller = anthropicShadowCaller(provider, { model: "m", timeoutMs: 1000, maxRetries: 0, usdPer1kInput: 0.001, usdPer1kOutput: 0.005 });
  const r = await caller({ symbol: "HOOD", underlying: { price: 20, dollarVolume: 3e7 }, triggerFeatures: {}, earnings: null, optionsActivity: null, technicalState: null, marketContext: null, analog: null, missing: [], scannerDecision: { actionable: true, direction: "bullish" }, paperHistory: null });
  assert.equal(r.inputTokens, 1000);
  assert.equal(r.costUsd, +((1000 / 1000) * 0.001 + (200 / 1000) * 0.005).toFixed(6));
});
