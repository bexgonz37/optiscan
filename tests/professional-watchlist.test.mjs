/**
 * tests/professional-watchlist.test.mjs — the professional premarket Watchlist:
 * deterministic setup families, real trigger levels, the publication gate, the
 * trigger lifecycle, outcome tracking, Discord copy, and the quant findings.
 */
import test from "node:test";
import assert from "node:assert/strict";

const setups = await import("../lib/research/watchlist/setup-families.ts");
const universe = await import("../lib/research/watchlist/universe.ts");
const plan = await import("../lib/research/watchlist/professional-plan.ts");
const lifecycle = await import("../lib/research/watchlist/trigger-lifecycle.ts");
const outcomes = await import("../lib/research/watchlist/outcomes.ts");
const discord = await import("../lib/research/watchlist/professional-discord.ts");
const findings = await import("../lib/research/watchlist/findings.ts");
const runner = await import("../lib/research/watchlist/professional-runner.ts");
const store = await import("../lib/research/watchlist/professional-store.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 30, 22, 0, 0);

/** Build N flat-ish daily bars so a detector has enough history. */
function baseBars(count, price, startMs = NOW - count * DAY_MS) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = startMs + i * DAY_MS;
    out.push({
      day: new Date(t).toISOString().slice(0, 10),
      o: price, h: price + 1, l: price - 1, c: price, v: 1_000_000,
      closedAtMs: t,
    });
  }
  return out;
}

function liquidity(symbol, overrides = {}) {
  return {
    symbol, openInterest: 10_000, contractVolume: 2_000, tightestSpreadPct: 3,
    observedAtMs: NOW - 1000, ...overrides,
  };
}

// ── Setup families produce deterministic CALL and PUT triggers ───────────────

test("inside-bar levels produce deterministic CALL and PUT triggers", () => {
  const bars = baseBars(30, 100);
  const prev = bars[bars.length - 2];
  prev.h = 110; prev.l = 90; prev.c = 100;
  const last = bars[bars.length - 1];
  last.h = 106; last.l = 96; last.o = 100; last.c = 101;

  const detected = setups.detectSetups({ symbol: "SPY", dailyBars: bars, nowMs: NOW });
  const inside = detected.find((s) => s.family === "INSIDE_BAR_DAILY");
  assert.ok(inside, "inside bar must be detected");
  assert.deepEqual(
    { call: inside.callTrigger.price, put: inside.putTrigger.price },
    { call: 106, put: 96 },
    "triggers must be the inside-bar high and low exactly",
  );
  assert.equal(inside.callTrigger.relation, "ABOVE");
  assert.equal(inside.putTrigger.relation, "BELOW");
  assert.equal(inside.callTrigger.sourceLevelName, "Inside-bar high");

  // Deterministic: the same input yields byte-identical output.
  const again = setups.detectSetups({ symbol: "SPY", dailyBars: bars, nowMs: NOW });
  assert.equal(JSON.stringify(detected), JSON.stringify(again));
});

test("gap-fill levels are deterministic and anchored to the real gap boundary", () => {
  const bars = baseBars(30, 100);
  const prev = bars[bars.length - 2];
  prev.c = 100; prev.h = 101; prev.l = 99;
  const last = bars[bars.length - 1];
  last.o = 106; last.l = 105; last.h = 109; last.c = 108; // unfilled gap up

  const detected = setups.detectSetups({ symbol: "AAPL", dailyBars: bars, nowMs: NOW });
  const gap = detected.find((s) => s.family === "GAP_FILL_DAILY");
  assert.ok(gap, "unfilled gap must be detected");
  assert.equal(gap.putTrigger.price, 105, "PUT trigger is the gap-session low");
  assert.equal(gap.callTrigger, null, "an unfilled gap up has no CALL trigger");
  const boundary = gap.sourceLevels.find((l) => l.name === "Gap boundary (prior close)");
  assert.equal(boundary.value, 100, "the gap boundary is the real prior close");

  // A filled gap is not a gap-fill setup.
  last.l = 98;
  const filled = setups.detectSetups({ symbol: "AAPL", dailyBars: bars, nowMs: NOW });
  assert.equal(filled.find((s) => s.family === "GAP_FILL_DAILY"), undefined);
});

test("a catalyst family never fires without an independently confirmed catalyst", () => {
  const bars = baseBars(30, 100);
  const prev = bars[bars.length - 2];
  prev.c = 100;
  const last = bars[bars.length - 1];
  last.o = 100; last.l = 99; last.h = 112; last.c = 111; // +11% move

  const noCatalyst = setups.detectSetups({ symbol: "PLTR", dailyBars: bars, nowMs: NOW });
  assert.equal(noCatalyst.find((s) => s.family === "CATALYST_MOMENTUM"), undefined,
    "price action alone must never manufacture a catalyst");

  const withCatalyst = setups.detectSetups({
    symbol: "PLTR", dailyBars: bars, nowMs: NOW,
    catalyst: {
      kind: "CATALYST", label: "Confirmed contract award", confirmedAtMs: NOW - 5000,
      source: "company release", tradingDay: last.day,
    },
  });
  const cat = withCatalyst.find((s) => s.family === "CATALYST_MOMENTUM");
  assert.ok(cat);
  assert.equal(cat.callTrigger.price, 112);
  assert.equal(cat.catalyst, "Confirmed contract award");
});

test("live-session families are withheld from the overnight and premarket phases", () => {
  const bars = baseBars(30, 100);
  const session = { vwap: 99, lastPrice: 98, lastPriceAtMs: NOW - 1000, openingRangeHigh: 101, openingRangeLow: 97 };
  for (const phase of ["OVERNIGHT", "PREMARKET"]) {
    const detected = setups.detectSetups({ symbol: "QQQ", dailyBars: bars, session, nowMs: NOW, phase });
    assert.equal(detected.some((s) => s.availability === "LIVE_SESSION"), false,
      `${phase} must not publish a VWAP or opening-range family`);
  }
  const live = setups.detectSetups({ symbol: "QQQ", dailyBars: bars, session, nowMs: NOW, phase: "LIVE_SESSION" });
  assert.ok(live.some((s) => s.family === "VWAP_RECLAIM"));
  assert.ok(live.some((s) => s.family === "OPENING_RANGE_BREAKOUT"));
});

test("evidence timestamped in the future never produces a setup", () => {
  const bars = baseBars(30, 100, NOW + DAY_MS);
  const detected = setups.detectSetups({ symbol: "SPY", dailyBars: bars, nowMs: NOW });
  assert.deepEqual(detected, [], "future-dated bars must yield nothing");
});

test("all nineteen documented setup families are supported", () => {
  assert.equal(setups.SUPPORTED_SETUP_FAMILIES.length, 19);
  for (const family of setups.SUPPORTED_SETUP_FAMILIES) {
    assert.ok(setups.SETUP_FAMILY_LABEL[family], `${family} needs a display label`);
    assert.ok(setups.SETUP_FAMILY_AVAILABILITY[family], `${family} needs an availability phase`);
  }
});

// ── Universe ────────────────────────────────────────────────────────────────

test("the Watchlist universe supports far more than SPY/QQQ/NVDA/META", () => {
  const symbols = universe.staticUniverseSymbols();
  for (const required of ["SPY", "QQQ", "IWM"]) assert.ok(symbols.includes(required), `${required} must be core`);
  assert.ok(symbols.length >= 50, `expected a broad universe, got ${symbols.length}`);
  const legacy = new Set(["SPY", "QQQ", "NVDA", "META"]);
  assert.ok(symbols.filter((s) => !legacy.has(s)).length >= 40,
    "the universe must not collapse back to the old four-symbol fallback");

  const built = universe.buildWatchlistUniverse({
    optionsLiquidity: symbols.map((s) => liquidity(s)),
    nowMs: NOW,
  });
  assert.equal(built.candidates.length, symbols.length);
  assert.ok(built.tierCounts.CORE_INDEX === 3);
  assert.ok(built.tierCounts.SECTOR_ETF > 0 && built.tierCounts.LARGE_CAP_LIQUID > 0);
});

test("a symbol without liquid-options evidence is excluded with a reason", () => {
  const built = universe.buildWatchlistUniverse({
    optionsLiquidity: [liquidity("SPY"), liquidity("QQQ", { openInterest: 10 })],
    nowMs: NOW,
  });
  assert.ok(built.candidates.some((c) => c.symbol === "SPY"));
  assert.equal(built.candidates.some((c) => c.symbol === "QQQ"), false);
  const qqq = built.excluded.find((e) => e.symbol === "QQQ");
  assert.match(qqq.reason, /Open interest/);
  const iwm = built.excluded.find((e) => e.symbol === "IWM");
  assert.equal(iwm.reason, "No options liquidity evidence", "missing evidence is never an implicit pass");
});

test("an unconfirmed catalyst never admits a symbol", () => {
  const built = universe.buildWatchlistUniverse({
    catalysts: [{ symbol: "ZZZZ", label: "", kind: "EARNINGS", confirmedAtMs: NOW - 1, source: "" }],
    optionsLiquidity: [liquidity("ZZZZ")],
    nowMs: NOW,
  });
  assert.equal(built.candidates.some((c) => c.symbol === "ZZZZ"), false);
  assert.ok(built.excluded.some((e) => e.symbol === "ZZZZ" && /not confirmed/.test(e.reason)));
});

// ── Publication gate ────────────────────────────────────────────────────────

function insideBarSetup(symbol, high, low) {
  return {
    symbol, family: "INSIDE_BAR_DAILY", familyLabel: "Inside Bar — Daily", availability: "OVERNIGHT",
    callTrigger: { side: "CALL", relation: "ABOVE", price: high, sourceLevelName: "Inside-bar high" },
    putTrigger: { side: "PUT", relation: "BELOW", price: low, sourceLevelName: "Inside-bar low" },
    reason: `${symbol} traded fully inside the prior day's range, coiling into the close.`,
    sourceLevels: [{ name: "Inside-bar high", value: high, origin: "Session 2026-07-29" }],
    evidenceAsOfMs: NOW - 1000,
    freshness: "Completed session 2026-07-29",
    catalyst: null,
    structureScore: 72,
  };
}

test("generic fallback rows never publish", () => {
  const generic = {
    symbol: "SPY", family: "INSIDE_BAR_DAILY", familyLabel: "Inside Bar — Daily", availability: "OVERNIGHT",
    callTrigger: null, putTrigger: null,
    reason: "structure_watch", sourceLevels: [], evidenceAsOfMs: 0, freshness: "", catalyst: null, structureScore: 55,
  };
  const blockers = plan.publishBlockers(generic, NOW);
  assert.ok(blockers.includes("No deterministic CALL or PUT trigger price"));
  assert.ok(blockers.includes("No source level"));

  const built = plan.buildWatchlistPlan({
    tradingDay: "2026-07-30", phase: "OVERNIGHT_PLAN", nowMs: NOW,
    universe: [{ symbol: "SPY", tiers: ["CORE_INDEX"], catalyst: null, optionsLiquidity: liquidity("SPY") }],
    setupsBySymbol: { SPY: [generic] },
  });
  assert.equal(built.rows.length, 0, "a row with no real trigger must never publish");
  assert.equal(built.needsMoreData[0].symbol, "SPY");
  assert.equal(built.needsMoreData[0].state, "NEEDS_MORE_DATA");
});

test("a VERIFY AT OPEN-only trigger cannot publish", () => {
  const row = insideBarSetup("SPY", 0, 0);
  row.callTrigger.price = 0;
  row.putTrigger = null;
  assert.ok(plan.publishBlockers(row, NOW).includes("No deterministic CALL or PUT trigger price"));
});

test("the maximum ticker count is enforced and the overflow is withheld", () => {
  const symbols = Array.from({ length: 20 }, (_, i) => `SYM${String(i).padStart(2, "0")}`);
  const built = plan.buildWatchlistPlan({
    tradingDay: "2026-07-30", phase: "OVERNIGHT_PLAN", nowMs: NOW,
    universe: symbols.map((s) => ({ symbol: s, tiers: ["LARGE_CAP_LIQUID"], catalyst: null, optionsLiquidity: liquidity(s) })),
    setupsBySymbol: Object.fromEntries(symbols.map((s) => [s, [insideBarSetup(s, 106, 96)]])),
  });
  assert.equal(built.rows.length, plan.MAX_PUBLISHED_ROWS);
  assert.ok(plan.MAX_PUBLISHED_ROWS <= 12 && plan.MIN_USEFUL_ROWS >= 8);
  assert.equal(built.needsMoreData.length, 8);
  assert.match(built.needsMoreData[0].missing[0], /publication limit/);
  assert.deepEqual(built.rows.map((r) => r.rank), Array.from({ length: 12 }, (_, i) => i + 1));
});

test("overnight and premarket plans never select an exact OCC contract", () => {
  const built = plan.buildWatchlistPlan({
    tradingDay: "2026-07-30", phase: "OVERNIGHT_PLAN", nowMs: NOW,
    universe: [{ symbol: "SPY", tiers: ["CORE_INDEX"], catalyst: null, optionsLiquidity: liquidity("SPY") }],
    setupsBySymbol: { SPY: [insideBarSetup("SPY", 106, 96)] },
  });
  assert.equal(built.rows[0].exactContract, null);
  const copy = discord.formatOvernightWatchlist(built);
  assert.equal(discord.screenWatchlistCopy(copy).ok, true, discord.screenWatchlistCopy(copy).violations.join("; "));
  assert.match(copy, /Verify exact options contracts after the market opens\./);
});

test("the premarket update reports changed levels, new setups, and invalidations", () => {
  const universeRows = ["SPY", "QQQ"].map((s) => ({ symbol: s, tiers: ["CORE_INDEX"], catalyst: null, optionsLiquidity: liquidity(s) }));
  const overnight = plan.buildWatchlistPlan({
    tradingDay: "2026-07-30", phase: "OVERNIGHT_PLAN", nowMs: NOW,
    universe: universeRows,
    setupsBySymbol: { SPY: [insideBarSetup("SPY", 106, 96)], QQQ: [insideBarSetup("QQQ", 210, 200)] },
  });
  assert.equal(overnight.rows.length, 2);

  // Premarket: SPY's premarket high has already traded through the daily level,
  // QQQ has lost its evidence, and IWM newly qualifies.
  const premarket = plan.buildWatchlistPlan({
    tradingDay: "2026-07-30", phase: "PREMARKET_UPDATE", nowMs: NOW + 1000,
    universe: [...universeRows, { symbol: "IWM", tiers: ["CORE_INDEX"], catalyst: null, optionsLiquidity: liquidity("IWM") }],
    setupsBySymbol: { SPY: [insideBarSetup("SPY", 106, 96)], QQQ: [], IWM: [insideBarSetup("IWM", 230, 220)] },
    sessionBySymbol: { SPY: { premarketHigh: 108.5, premarketLow: 95 } },
    previousPlan: overnight,
  });
  const spy = premarket.rows.find((r) => r.symbol === "SPY");
  assert.equal(spy.callAbove.price, 108.5, "the premarket high replaces a taken-out daily level");
  assert.equal(spy.callAbove.sourceLevelName, "Premarket high");
  assert.equal(spy.putBelow.price, 95, "the premarket low replaces the lower daily level");
  assert.equal(spy.changedSinceOvernight, true);
  assert.ok(spy.changes.some((c) => /premarket high/.test(c)));
  assert.deepEqual(premarket.newlyQualified, ["IWM"]);
  assert.equal(premarket.invalidated[0].symbol, "QQQ");
  assert.equal(premarket.rows.every((r) => r.state === "PREMARKET_UPDATE"), true);
});

test("every lifecycle state is represented", () => {
  assert.deepEqual(plan.WATCHLIST_STATES, [
    "OVERNIGHT_PLAN", "PREMARKET_UPDATE", "TRIGGERED_TODAY", "INVALIDATED", "NEEDS_MORE_DATA",
  ]);
});

// ── Trigger lifecycle ───────────────────────────────────────────────────────

const publishedRow = {
  symbol: "SPY", family: "INSIDE_BAR_DAILY", setupType: "Inside Bar — Daily",
  callAbove: { price: 106, sourceLevelName: "Inside-bar high" },
  putBelow: { price: 96, sourceLevelName: "Inside-bar low" },
  reason: "r", sourceLevels: [], freshness: "f", evidenceAsOfMs: NOW, catalyst: null,
  state: "OVERNIGHT_PLAN", exactContract: null, changedSinceOvernight: false, changes: [],
  rank: 1, structureScore: 72,
};

const goodEvidence = {
  optionSymbol: "O:SPY260807C00106000", bid: 2.0, ask: 2.1, quoteAgeMs: 1500,
  openInterest: 5000, contractVolume: 900, marketContextAvailable: true, revalidatedAtMs: NOW,
};

test("a triggered row still passes all live contract and delivery gates", () => {
  const observation = { symbol: "SPY", side: "CALL", price: 106.4, observedAtMs: NOW, inRegularSession: true };
  const ok = lifecycle.evaluateTriggerLifecycle(publishedRow, observation, goodEvidence);
  assert.equal(ok.triggered, true);
  assert.equal(ok.eligibleForCanonicalPath, true);
  assert.equal(ok.tradeReady, false, "a trigger is never TRADE READY");
  assert.equal(ok.requiresCanonicalDelivery, true);
  assert.deepEqual(ok.passed.sort(), lifecycle.REVALIDATION_CHECKS.slice().sort());

  const handoff = lifecycle.buildCanonicalHandoff(ok);
  assert.equal(handoff.offer, true);
  assert.match(handoff.note, /canonical options SEND path/);
  assert.equal("send" in handoff, false, "the handoff carries no delivery authority");
});

test("a trigger with no revalidated contract, a stale quote, or no context is not eligible", () => {
  const observation = { symbol: "SPY", side: "CALL", price: 106.4, observedAtMs: NOW, inRegularSession: true };
  const cases = [
    [{ ...goodEvidence, optionSymbol: null }, "EXACT_CONTRACT_REVALIDATED"],
    [{ ...goodEvidence, quoteAgeMs: 10 * 60_000 }, "FRESH_BID_ASK"],
    [{ ...goodEvidence, bid: 1.0, ask: 2.0 }, "SPREAD_ACCEPTABLE"],
    [{ ...goodEvidence, openInterest: 1 }, "LIQUIDITY_ACCEPTABLE"],
    [{ ...goodEvidence, marketContextAvailable: false }, "MARKET_CONTEXT_AVAILABLE"],
    [null, "EXACT_CONTRACT_REVALIDATED"],
  ];
  for (const [evidence, expectedCheck] of cases) {
    const res = lifecycle.evaluateTriggerLifecycle(publishedRow, observation, evidence);
    assert.equal(res.eligibleForCanonicalPath, false);
    assert.ok(res.failed.some((f) => f.check === expectedCheck), `expected ${expectedCheck} to fail`);
    assert.equal(lifecycle.buildCanonicalHandoff(res).optionSymbol, null);
  }
});

test("a level that has not traded, or traded outside the regular session, does not trigger", () => {
  const below = { symbol: "SPY", side: "CALL", price: 105.9, observedAtMs: NOW, inRegularSession: true };
  assert.equal(lifecycle.crossedPublishedLevel(publishedRow, below), false);
  const res = lifecycle.evaluateTriggerLifecycle(publishedRow, below, goodEvidence);
  assert.equal(res.triggered, false);
  assert.equal(res.eligibleForCanonicalPath, false);

  const afterHours = { symbol: "SPY", side: "CALL", price: 106.4, observedAtMs: NOW, inRegularSession: false };
  const res2 = lifecycle.evaluateTriggerLifecycle(publishedRow, afterHours, goodEvidence);
  assert.ok(res2.failed.some((f) => f.check === "IN_REGULAR_SESSION"));
});

// ── Outcome tracking ────────────────────────────────────────────────────────

const verifiedSend = {
  discordMessageId: "1234567890", optionSymbol: "O:SPY260807C00106000",
  frozenEntry: 2.05, paperMirrorId: "paper_1", sentAtMs: NOW,
};

test("Watchlist outcomes do not become subscriber results without a verified SEND", () => {
  const base = {
    row: publishedRow, tradingDay: "2026-07-30", triggeredSide: "CALL", triggeredAtMs: NOW,
    invalidated: false, sessionComplete: true,
    movement: { favorableExcursionPct: 3, adverseExcursionPct: -1, observedThroughMs: NOW },
  };
  const unverified = outcomes.buildWatchlistOutcome({ ...base, send: null });
  assert.equal(unverified.status, "TRIGGERED");
  assert.equal(unverified.favorableMovement, true);
  assert.equal(unverified.becameVerifiedSend, false);
  assert.equal(unverified.countsAsSubscriberResult, false);

  for (const missing of ["discordMessageId", "optionSymbol", "frozenEntry", "paperMirrorId", "sentAtMs"]) {
    const partial = outcomes.buildWatchlistOutcome({ ...base, send: { ...verifiedSend, [missing]: null } });
    assert.equal(partial.countsAsSubscriberResult, false, `${missing} missing must fail closed`);
    assert.ok(partial.sendVerificationGaps.length > 0);
  }

  const summary = outcomes.summarizeWatchlistOutcomes([unverified]);
  assert.equal(summary.isSubscriberPerformance, false);
  assert.match(summary.subscriberPerformanceNote, /NOT subscriber performance/);

  const verified = outcomes.buildWatchlistOutcome({ ...base, send: verifiedSend });
  assert.equal(verified.countsAsSubscriberResult, true);
  assert.equal(outcomes.summarizeWatchlistOutcomes([verified]).isSubscriberPerformance, true);
  assert.equal(outcomes.summarizeWatchlistOutcomes([]).isSubscriberPerformance, false,
    "an empty cohort is never subscriber performance");
});

test("every tracked outcome state is produced, with family and side breakdowns", () => {
  const mk = (symbol, overrides) => outcomes.buildWatchlistOutcome({
    row: { ...publishedRow, symbol },
    tradingDay: "2026-07-30", triggeredSide: null, triggeredAtMs: null,
    invalidated: false, sessionComplete: true, ...overrides,
  });
  const cohort = [
    mk("A", { triggeredSide: "CALL", triggeredAtMs: NOW, movement: { favorableExcursionPct: 5, adverseExcursionPct: -1 } }),
    mk("B", { triggeredSide: "PUT", triggeredAtMs: NOW, movement: { favorableExcursionPct: 1, adverseExcursionPct: -6 } }),
    mk("C", {}),
    mk("D", { invalidated: true, invalidationReason: "gapped through the level" }),
  ];
  assert.deepEqual(cohort.map((o) => o.status), ["TRIGGERED", "FAILED", "NEVER_TRIGGERED", "INVALIDATED"]);

  const summary = outcomes.summarizeWatchlistOutcomes(cohort);
  assert.equal(summary.sample, 4);
  assert.equal(summary.triggered, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.neverTriggered, 1);
  assert.equal(summary.invalidated, 1);
  assert.equal(summary.triggerRatePct, 50);
  assert.equal(summary.outcomeRatePct, 50);
  assert.equal(summary.conversionRatePct, 0);
  assert.equal(summary.byFamily[0].family, "INSIDE_BAR_DAILY");
  assert.deepEqual(summary.bySide.map((s) => [s.side, s.outcomeRatePct]), [["CALL", 100], ["PUT", 0]]);
});

// ── Discord copy ────────────────────────────────────────────────────────────

test("published Discord copy is grouped, capped, and free of forbidden vocabulary", () => {
  const symbols = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMD", "XLE", "XLF", "TSLA"];
  const built = plan.buildWatchlistPlan({
    tradingDay: "2026-07-30", phase: "OVERNIGHT_PLAN", nowMs: NOW,
    universe: symbols.map((s) => ({ symbol: s, tiers: ["LARGE_CAP_LIQUID"], catalyst: null, optionsLiquidity: liquidity(s) })),
    setupsBySymbol: Object.fromEntries(symbols.map((s, i) => {
      const setup = insideBarSetup(s, 100 + i, 90 + i);
      if (i % 2) { setup.family = "DAILY_BREAKOUT"; setup.familyLabel = "Daily Breakout"; setup.putTrigger = null; }
      return [s, [setup]];
    })),
    marketAlignment: "SPY bearish, QQQ bearish",
  });
  const content = discord.formatOvernightWatchlist(built);
  const screen = discord.screenWatchlistCopy(content);
  assert.equal(screen.ok, true, screen.violations.join("; "));
  assert.match(content, /__Inside Bar — Daily__/);
  assert.match(content, /__Daily Breakout__/);
  assert.match(content, /CALLS ABOVE \$\d+\.\d\d \(Inside-bar high\)/);
  assert.match(content, /PUTS BELOW \$\d+\.\d\d/);
  assert.equal((content.match(/Educational research only/g) ?? []).length, 1, "exactly one disclaimer");
  assert.ok(built.rows.length <= plan.MAX_PUBLISHED_ROWS);
});

test("the copy screen rejects filler, confidence scores, internal names, and overnight OCC", () => {
  const cases = [
    ["SPY structure_watch", "structure_watch filler"],
    ["SPY VERIFY AT OPEN", "VERIFY AT OPEN used as a trigger"],
    ["SPY confidence: 55", "generic confidence score"],
    ["SPY planStatus QUALIFIED_PLAN", "internal pipeline name"],
    ["SPY market context unavailable", "unavailable-data warning in subscriber copy"],
    ["SPY O:SPY260807C00106000", "exact OCC contract"],
    ['{ "spyTrend": "BEARISH" }', "raw object"],
  ];
  for (const [content, reason] of cases) {
    const screen = discord.screenWatchlistCopy(content);
    assert.equal(screen.ok, false, `expected ${content} to be rejected`);
    assert.ok(screen.violations.includes(reason), `expected violation ${reason}, got ${screen.violations.join("; ")}`);
  }
  const empty = discord.formatOvernightWatchlist({
    tradingDay: "2026-07-30", phase: "OVERNIGHT_PLAN", builtAtMs: NOW, planVersion: "v",
    rows: [], needsMoreData: [], invalidated: [], newlyQualified: [], marketAlignment: null,
    diagnostics: { universeConsidered: 0, setupsDetected: 0, publishedCount: 0, maxRows: 12, blockers: [] },
  });
  assert.equal(discord.screenWatchlistCopy(empty).ok, true, "the empty state must also be clean copy");
});

// ── Quant findings + AI authority ───────────────────────────────────────────

test("canonical findings exist for every required metric and stay advisory only", () => {
  const report = findings.buildWatchlistQuantFindings({
    timeWindow: "last 30 sessions",
    entryTiming: { avgAlertDelayMs: 42_000, premiumChaseCount: 9, sampleSize: 40, earlyEntryImprovementPct: 12.5 },
    lossProtection: { earlyExitImprovementPct: 8.1, sampleSize: 73, bestPolicyProfitable: false, bestPolicyLabel: "Trail 10%" },
    watchlist: {
      publishedCount: 40, triggerRatePct: 55, conversionRatePct: 30, outcomeRatePct: 48,
      byFamily: [{ family: "INSIDE_BAR_DAILY", setupType: "Inside Bar — Daily", sample: 20, triggered: 12, outcomeRatePct: 50 }],
      bySide: [{ side: "CALL", triggered: 8, outcomeRatePct: 62 }, { side: "PUT", triggered: 4, outcomeRatePct: 25 }],
      isSubscriberPerformance: false,
    },
  });
  const ids = report.metrics.map((m) => m.id);
  for (const required of [
    "watchlist.avg_alert_delay_ms",
    "watchlist.premium_chase_rate_pct",
    "watchlist.early_entry_improvement_pct",
    "watchlist.early_exit_improvement_pct",
    "watchlist.trigger_rate_pct",
    "watchlist.alert_conversion_pct",
    "watchlist.outcome_rate_pct",
    "watchlist.family.inside_bar_daily.outcome_rate_pct",
    "watchlist.side.call.outcome_rate_pct",
    "watchlist.side.put.outcome_rate_pct",
  ]) assert.ok(ids.includes(required), `missing canonical finding ${required}`);

  assert.equal(report.advisoryOnly, true);
  assert.equal(report.productionBehaviorChanged, false);
  assert.equal(report.aiAuthority, "ADVISORY_ONLY");
});

test("a negative policy is labelled less bad, never profitable", () => {
  const report = findings.buildWatchlistQuantFindings({
    timeWindow: "last 30 sessions",
    lossProtection: { earlyExitImprovementPct: 8.1, sampleSize: 73, bestPolicyProfitable: false, bestPolicyLabel: "Trail 10%" },
  });
  const warning = report.findings.find((f) => f.id === "watchlist.loss_protection_less_bad");
  assert.ok(warning, "a non-profitable best policy must carry an explicit warning");
  assert.match(warning.summary, /never be described as a winning or profitable policy/);
  assert.equal(warning.classification, "DATA_QUALITY_WARNING");
});

test("missing cohorts report null with a data gap, never a zero", () => {
  const report = findings.buildWatchlistQuantFindings({ timeWindow: "last 30 sessions" });
  for (const m of report.metrics) {
    assert.equal(m.value, null);
    assert.equal(m.qualityStatus, "MISSING_DATA");
    assert.equal(m.safeForTopLine, false);
  }
  assert.equal(report.dataGaps.length, 3);
});

test("the AI layer cannot apply scanner, entry, exit, Watchlist, or delivery changes", async () => {
  const { screenProposalSafety } = await import("../lib/ai/safety.ts");
  const forbidden = [
    { title: "Bypass the Watchlist evidence gate", problem: "too few rows", proposedChange: "bypass the evidence threshold so more rows publish" },
    { title: "Auto-apply exit change", problem: "losses", proposedChange: "automatically apply the trail policy to production" },
    { title: "Enable bearish", problem: "no puts", proposedChange: "enable bearish actionable alerts" },
    { title: "Loosen delivery", problem: "few sends", proposedChange: "disable the liquidity gate before Discord delivery" },
  ];
  for (const p of forbidden) {
    const screen = screenProposalSafety(p);
    assert.equal(screen.ok, false, `expected "${p.title}" to be dropped`);
  }

  // Structural: no Watchlist module may import an AI apply/mutation path, and no
  // AI module may import the Watchlist runner.
  const { readFileSync, readdirSync } = await import("node:fs");
  for (const file of readdirSync("lib/research/watchlist")) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(`lib/research/watchlist/${file}`, "utf8");
    assert.equal(/from ["'][^"']*ai\/(provider|advisory-chat|recommendations)/.test(src), false,
      `${file} must not import an AI generation path`);
  }
  const chat = readFileSync("lib/ai/advisory-chat.ts", "utf8");
  assert.equal(/watchlist\/professional-runner|watchlist\/professional-store/.test(chat), false,
    "the advisory chat must not reach the Watchlist writer");
});

// ── Runner: bounded, contained, off by default ──────────────────────────────

function memoryDb() {
  const tables = new Map();
  const rows = { plans: [], setupRows: [], outcomes: [] };
  return {
    exec(sql) { for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) tables.set(m[1], true); },
    prepare(sql) {
      return {
        get: (...args) => {
          if (/sqlite_master/.test(sql)) return tables.has(args[0]) ? { 1: 1 } : undefined;
          if (/FROM watchlist_professional_plans/.test(sql)) {
            return rows.plans.find((p) => p.trading_day === args[0] && p.phase === args[1]);
          }
          return undefined;
        },
        all: (...args) => {
          if (/FROM watchlist_setup_rows/.test(sql)) {
            return rows.setupRows.filter((r) => r.trading_day === args[0] && r.phase === args[1]);
          }
          if (/FROM watchlist_setup_outcomes/.test(sql)) return rows.outcomes;
          return [];
        },
        run: (...args) => {
          if (/^\s*DELETE FROM watchlist_setup_rows/.test(sql)) {
            rows.setupRows = rows.setupRows.filter((r) => !(r.trading_day === args[0] && r.phase === args[1]));
            return { changes: 0 };
          }
          if (/INSERT INTO watchlist_professional_plans/.test(sql)) {
            const [trading_day, phase, plan_version, built_at_ms, payload_json] = args;
            const existing = rows.plans.find((p) => p.trading_day === trading_day && p.phase === phase);
            if (existing) Object.assign(existing, { plan_version, built_at_ms, payload_json });
            else rows.plans.push({ trading_day, phase, plan_version, built_at_ms, payload_json });
            return { changes: 1 };
          }
          if (/INSERT INTO watchlist_setup_rows/.test(sql)) {
            const [trading_day, phase, symbol, rank, family, setup_type, call_above, put_below, state, evidence_as_of_ms, changed, payload_json] = args;
            rows.setupRows.push({ trading_day, phase, symbol, rank, family, setup_type, call_above, put_below, state, evidence_as_of_ms, changed, payload_json });
            return { changes: 1 };
          }
          if (/INSERT INTO watchlist_setup_outcomes/.test(sql)) {
            rows.outcomes.push({ payload_json: args[8] });
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      };
    },
    _rows: rows,
  };
}

test("the runner is a no-op unless it is explicitly enabled", async () => {
  const db = memoryDb();
  const res = await runner.runProfessionalWatchlistOnDb(db, {
    fetchDailyBars: async () => { throw new Error("must not fetch"); },
    fetchOptionsLiquidity: async () => { throw new Error("must not fetch"); },
    now: () => NOW,
    env: {},
  });
  assert.equal(res.ran, false);
  assert.match(res.reason, /PROFESSIONAL_WATCHLIST_ENABLED/);
  assert.equal(res.providerCalls, 0);
});

test("the runner is bounded, contains provider failures, and persists idempotently", async () => {
  const db = memoryDb();
  const bars = baseBars(30, 100);
  bars[bars.length - 2].h = 110; bars[bars.length - 2].l = 90;
  bars[bars.length - 1].h = 106; bars[bars.length - 1].l = 96; bars[bars.length - 1].c = 101;

  let dailyCalls = 0;
  const deps = {
    fetchDailyBars: async (symbol) => {
      dailyCalls += 1;
      // AMD sorts into the first bounded slice, so this exercises a real failure
      // inside the run rather than one the symbol cap already excluded.
      if (symbol === "AMD") throw new Error("provider 500");
      return bars;
    },
    fetchOptionsLiquidity: async (symbol) => liquidity(symbol),
    now: () => NOW,
    env: { PROFESSIONAL_WATCHLIST_ENABLED: "1" },
  };
  const res = await runner.runProfessionalWatchlistOnDb(db, deps, { maxSymbols: 6, providerCallBudget: 20 });
  assert.equal(res.ran, true);
  assert.ok(res.providerCalls <= 20, "the provider-call budget must bound the run");
  assert.ok(res.symbolsConsidered <= 6, "the symbol cap must bound the run");
  assert.ok(res.errors.some((e) => /AMD/.test(e)), "a provider failure is recorded, not thrown");
  assert.equal(res.persisted, true);
  assert.ok(res.plan.rows.length > 0);
  assert.equal(res.plan.rows.every((r) => r.exactContract === null), true);

  const before = db._rows.setupRows.length;
  await runner.runProfessionalWatchlistOnDb(db, deps, { maxSymbols: 6, providerCallBudget: 20 });
  assert.equal(db._rows.setupRows.length, before, "a repeat run must not duplicate rows");
  assert.equal(db._rows.plans.length, 1, "the plan upsert must be idempotent");

  const loaded = store.loadProfessionalPlanOnDb(db, res.tradingDay, "OVERNIGHT_PLAN");
  assert.equal(loaded.planVersion, res.plan.planVersion);
});

test("a persistence failure never throws into the caller", () => {
  const brokenDb = {
    exec() { throw new Error("disk full"); },
    prepare() { throw new Error("disk full"); },
  };
  const emptyPlan = {
    tradingDay: "2026-07-30", phase: "OVERNIGHT_PLAN", builtAtMs: NOW, planVersion: "v",
    rows: [], needsMoreData: [], invalidated: [], newlyQualified: [], marketAlignment: null,
    diagnostics: { universeConsidered: 0, setupsDetected: 0, publishedCount: 0, maxRows: 12, blockers: [] },
  };
  const res = store.persistProfessionalPlanOnDb(brokenDb, emptyPlan);
  assert.equal(res.persisted, false);
  assert.match(res.error, /disk full/);
  assert.deepEqual(store.loadWatchlistOutcomesOnDb(brokenDb), []);
  assert.equal(store.loadProfessionalPlanOnDb(brokenDb, "2026-07-30", "OVERNIGHT_PLAN"), null);
});
