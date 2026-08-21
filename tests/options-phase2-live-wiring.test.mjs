/**
 * options-phase2-live-wiring.test.mjs — the step that made Phase 2 reachable.
 *
 * The optionability registry, the admission queue, the miss capture and the six
 * shadows were all built and all tested in the previous phase. Every one of them
 * had zero importers outside its own test file, so every property they proved
 * was a property of a module rather than of the running system.
 *
 * These tests exercise the MONITOR. They drive real cycles through
 * `runOptionsMonitorCycle` and assert on what the live path actually did — which
 * is the only place the difference between "built" and "wired" is visible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  runOptionsMonitorCycle, optionsMonitorMetrics, optionsCoverageMetrics,
  __selectTier2SymbolsForTest, __resetOptionsMonitorForTest,
  defaultMonitorConfig, CHAIN_QUEUE_MAX, MISSED_RESAMPLE_MS,
} from "../lib/research/options/monitor.ts";
import { promotionCapacityConfig, INITIAL_ROLLOUT_PROMOTION_CEILING } from "../lib/research/options/promotion.ts";
import { chainOk } from "../lib/research/options/loop.ts";
import { admitChainRequests, DEFAULT_CHAIN_ADMISSION } from "../lib/research/options/chain-admission.ts";
import { splitChainCapacity, auditProviderLanes, laneClassOf } from "../lib/research/options/provider-lane-audit.ts";
import { ensureMissedOpportunitySchema, missedOpportunitiesForSymbol } from "../lib/research/options/missed-opportunity.ts";

const NOW = Date.parse("2026-01-15T15:00:00.000Z");
const ON = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1" };
const ADMIT = { ...ON, OPTIONS_CHAIN_ADMISSION_ENABLED: "1" };

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT, thesis_fingerprint TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT, delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0, paper_trade_id INTEGER, paper_reservation_state TEXT, discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL, quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_runtime (key TEXT PRIMARY KEY, value TEXT, updated_at_ms INTEGER NOT NULL);`);
  ensureMissedOpportunitySchema(d);
  return d;
}

/**
 * Rising bars: fresh, accelerating, above VWAP — a plausible bullish setup.
 *
 * Anchored on the caller's clock, not on NOW. A test that advances the clock by
 * a day and keeps NOW-anchored bars is testing the STALENESS reject, not the
 * thing it meant to test, and would silently pass for the wrong reason.
 */
function bars(at = NOW, n = 40, lastAgeMs = 60_000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = at - lastAgeMs - (n - 1 - i) * 60_000;
    const base = 100 + (i > n - 6 ? (i - (n - 6)) * 0.2 : 0);
    out.push({ t, o: base, h: base + 0.05, l: base - 0.05, c: base, v: i > n - 6 ? 6000 : 1000 });
  }
  return out;
}

const snap = () => ({
  price: 100, dayDollarVolume: 60_000_000, relVolume: null, velPct: null, accelPct: null,
  gapPct: null, aboveVwap: null, hodBreak: null, nearResistancePct: null,
  compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null,
});

/** A monitor wired to a controllable chain, so the outcome is the variable. */
function deps(d, getChain, over = {}) {
  return {
    now: () => NOW,
    session: () => "regular",
    getDb: () => d,
    getUnderlyingBatch: async (syms) => new Map(syms.map((x) => [x, snap()])),
    getChain,
    ...over,
    // Bars follow whatever clock the caller installed, so a multi-session test
    // is never accidentally measuring the stale-bar reject.
    getBars: async () => bars((over.now ?? (() => NOW))()),
  };
}

/** A chain fetch that failed for a stated provider reason and returned nothing. */
const chainFail = (outcome, extra = {}) => async () => ({
  outcome, contracts: [], truncated: false,
  requestedDteMin: 0, requestedDteMax: 60,
  pagesRequested: 1, pagesReceived: 1, providerRequests: 1,
  ...extra,
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1–4. THE COVERAGE ARCHITECTURE SURVIVED THE WIRING
 * ══════════════════════════════════════════════════════════════════════════*/

const UNIVERSE = 1606;
const quotes = (n = UNIVERSE) => Array.from({ length: n }, (_, i) => ({
  symbol: `SYM${i}`, price: 100, changePercent: (i % 37) * 0.35, volume: 2_000_000,
  dayHigh: 103, dayLow: 98, dayOpen: 100, prevClose: 99, bid: null, ask: null,
}));

test("1/2. full-universe cheap awareness is intact — 25 is not a visibility cap", async () => {
  __resetOptionsMonitorForTest();
  await __selectTier2SymbolsForTest({
    now: () => NOW, session: () => "regular", tier2AwarenessQuotes: () => quotes(),
  }, [], {});
  const cov = optionsCoverageMetrics(NOW);
  assert.equal(cov.eligibleOptionsUniverse, UNIVERSE, "the whole universe is still scored");
  assert.equal(cov.cheapObservationCoveragePct, 100, "cheap coverage is still complete every cycle");
  assert.equal(cov.cheapObservedThisCycle > 25, true,
    "cheap observation is far wider than the expensive slot count");
});

test("3/4. expensive deep analysis stays bounded, at or below the first-rollout ceiling", async () => {
  __resetOptionsMonitorForTest();
  const promoted = await __selectTier2SymbolsForTest({
    now: () => NOW, session: () => "regular", tier2AwarenessQuotes: () => quotes(),
    providerStats: () => ({ minuteCap: 280, callsThisMinute: 0 }),
  }, [], {});
  assert.equal(promoted.length <= 25, true, `promoted ${promoted.length}, ceiling 25`);
  assert.equal(new Set(promoted).size, promoted.length, "no symbol is deeply analysed twice");

  assert.equal(INITIAL_ROLLOUT_PROMOTION_CEILING, 25);
  assert.equal(promotionCapacityConfig({}).hardCeiling, 25,
    "the effective ceiling is the rollout ceiling, not the 120 backstop");
  // An env attempt to raise the backstop cannot escape the rollout ceiling.
  assert.equal(promotionCapacityConfig({ OPTIONS_PROMOTION_HARD_CEILING: "500" }).hardCeiling, 25,
    "the smaller of the two always binds");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5–9. OPTIONABILITY ON THE LIVE PATH
 * ══════════════════════════════════════════════════════════════════════════*/

test("5. UNKNOWN optionability is ELIGIBLE — an unseen symbol still gets its chain request", async () => {
  __resetOptionsMonitorForTest();
  const asked = [];
  await runOptionsMonitorCycle(2, ["NEWCO"], deps(db(), async (sym) => { asked.push(sym); return chainOk([]); }), ON);

  assert.deepEqual(asked, ["NEWCO"], "nothing was known about it, so it was looked at");
  const m = optionsMonitorMetrics();
  assert.equal(m.optionability.unknownRemainsEligible, true);
  assert.equal(m.optionability.chainSkippedForProvenNotOptionable, 0);
});

test("6. a PROVEN NOT_OPTIONABLE symbol stops costing chain requests", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  let asked = 0;
  // Two separate SESSIONS of a clean, wide, empty answer is the corroboration
  // threshold. A DTE span of 0-60 is wide enough for "nothing came back" to mean
  // something; 0-7 on a monthly-only name would not be.
  const wideEmpty = async () => ({
    outcome: "NO_CONTRACTS_IN_REQUESTED_RANGE", contracts: [], truncated: false,
    requestedDteMin: 0, requestedDteMax: 60, pagesRequested: 1, pagesReceived: 1, providerRequests: 1,
  });
  const day = (ms) => deps(d, async () => { asked += 1; return wideEmpty(); }, { now: () => ms });

  await runOptionsMonitorCycle(2, ["NOOPT"], day(NOW), ON);
  await runOptionsMonitorCycle(2, ["NOOPT"], day(NOW + 86_400_000), ON);
  const afterEvidence = asked;
  assert.equal(afterEvidence, 2, "both corroborating observations were genuinely paid for");

  // Third day: the verdict is in, and the request is no longer spent.
  await runOptionsMonitorCycle(2, ["NOOPT"], day(NOW + 2 * 86_400_000), ON);
  assert.equal(asked, afterEvidence, "no third chain request was issued");
  const m = optionsMonitorMetrics();
  assert.equal(m.optionability.notOptionable, 1);
  assert.equal(m.optionability.chainSkippedForProvenNotOptionable, 1, "and the saving is counted");
});

test("7. an empty NARROW DTE window can never create NOT_OPTIONABLE, however often it repeats", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  let asked = 0;
  const narrowEmpty = async () => {
    asked += 1;
    return {
      outcome: "NO_CONTRACTS_IN_REQUESTED_RANGE", contracts: [], truncated: false,
      requestedDteMin: 0, requestedDteMax: 7, pagesRequested: 1, pagesReceived: 1, providerRequests: 1,
    };
  };
  for (let i = 0; i < 10; i++) {
    await runOptionsMonitorCycle(2, ["MONTHLY"], deps(d, narrowEmpty, { now: () => NOW + i * 86_400_000 }), ON);
  }
  assert.equal(asked, 10, "it stayed eligible on every one of ten separate sessions");
  assert.equal(optionsMonitorMetrics().optionability.notOptionable, 0,
    "a 0-7 ask on a monthly-only name proves nothing about the symbol");
});

test("8. a QUOTA refusal can never create NOT_OPTIONABLE — MRNA stays eligible", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  let asked = 0;
  for (let i = 0; i < 10; i++) {
    await runOptionsMonitorCycle(2, ["MRNA"],
      deps(d, async () => { asked += 1; return (await chainFail("PROVIDER_QUOTA_EXCEEDED")()); },
        { now: () => NOW + i * 86_400_000 }), ON);
  }
  assert.equal(asked, 10, "ten quota refusals never condemned the symbol");
  const m = optionsMonitorMetrics();
  assert.equal(m.optionability.notOptionable, 0);
  assert.equal(m.zeroContract.byCause.PROVIDER_QUOTA_EXCEEDED, 10);
});

test("9. a TRUNCATED or incomplete response can never create NOT_OPTIONABLE", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  for (let i = 0; i < 10; i++) {
    await runOptionsMonitorCycle(2, ["BIGCHAIN"],
      deps(d, chainFail("CHAIN_TRUNCATED_BEFORE_RANGE", { truncated: true, pagesRequested: 4, pagesReceived: 2 }),
        { now: () => NOW + i * 86_400_000 }), ON);
  }
  const m = optionsMonitorMetrics();
  assert.equal(m.optionability.notOptionable, 0, "our own page budget is not a market fact");
  assert.equal(m.zeroContract.byCause.PROVIDER_INCOMPLETE, 10);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 10–11. ZERO-CONTRACT CAUSES STAY DISTINCT
 * ══════════════════════════════════════════════════════════════════════════*/

test("10/11. provider failures and selector failures are counted apart, never merged", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const cases = [
    ["QUOTA", chainFail("PROVIDER_QUOTA_EXCEEDED")],
    ["TIMEOUT", chainFail("PROVIDER_TIMEOUT")],
    ["TRUNC", chainFail("CHAIN_TRUNCATED_BEFORE_RANGE", { truncated: true })],
    ["WIDEEMPTY", chainFail("NO_CONTRACTS_IN_REQUESTED_RANGE")],
    ["NARROW", chainFail("NO_CONTRACTS_IN_REQUESTED_RANGE", { requestedDteMin: 0, requestedDteMax: 5 })],
  ];
  for (const [sym, chain] of cases) {
    await runOptionsMonitorCycle(2, [sym], deps(d, chain), ON);
  }

  const z = optionsMonitorMetrics().zeroContract;
  assert.equal(z.byCause.PROVIDER_QUOTA_EXCEEDED, 1);
  assert.equal(z.byCause.OTHER, 1, "the timeout, and only the timeout");
  assert.equal(z.byCause.PROVIDER_INCOMPLETE, 1);
  assert.equal(z.byCause.PROVIDER_EMPTY_RESPONSE, 1, "a clean wide empty answer");
  assert.equal(z.byCause.NO_CONTRACTS_IN_REQUESTED_DTE, 1, "a window too narrow to mean anything");

  // THE MASQUERADE THIS FORBIDS: none of the five reached a selector, so not one
  // of them may be recorded as our bands rejecting the market.
  assert.equal(z.byCause.NO_ELIGIBLE_CONTRACT, 0);
  assert.equal(z.byCause.LIQUIDITY_REJECTION, 0);
  assert.equal(z.byOrigin.SELECTOR, 0, "not one of the five reached a selector");
  assert.equal(z.byOrigin.PROVIDER, 4, "four were the market never being successfully asked");
  assert.equal(z.byOrigin.REQUEST, 1,
    "and the narrow window is its OWN origin — nothing was rejected, because nothing arrived");
});

test("11b. the operator is never told about a band that was never tested", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  await runOptionsMonitorCycle(2, ["MRNA"], deps(d, chainFail("PROVIDER_QUOTA_EXCEEDED")), ON);
  const why = d.prepare("SELECT why FROM options_candidates WHERE symbol='MRNA'").all().map((r) => r.why ?? "");
  for (const w of why) {
    if (/no eligible contract in the preferred/.test(w)) {
      assert.fail(`a quota refusal was reported as a band rejection: ${w}`);
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 12–17. CHAIN ADMISSION
 * ══════════════════════════════════════════════════════════════════════════*/

const ticket = (over = {}) => ({
  symbol: "AAA", side: "call", strategyKey: "confirmed_breakout",
  score: 0.5, researchOnly: true, tier: 2,
  requestedAtMs: NOW, deadlineMs: NOW + 60_000, attempts: 0, ...over,
});

test("12. admission never returns more than capacity, and never a negative one", () => {
  const many = Array.from({ length: 500 }, (_, i) => ticket({ symbol: `S${i}` }));
  for (const cap of [0, 1, 7, 500, -5]) {
    const r = admitChainRequests(many, cap, NOW);
    assert.equal(r.admitted.length <= Math.max(0, cap), true, `cap ${cap}`);
    assert.equal(r.admitted.length + r.deferred.length + r.expired.length, 500);
  }
});

test("13. the same setup asked twice is ONE request", () => {
  const dup = [ticket(), ticket({ requestedAtMs: NOW + 5_000 }), ticket({ requestedAtMs: NOW + 9_000 })];
  const r = admitChainRequests(dup, 10, NOW + 10_000);
  assert.equal(r.admitted.length, 1, "three tickets, one chain request");
  assert.equal(r.duplicatesCollapsed, 2);
  // Collapsing keeps the OLDEST, so de-duplication never resets accumulated age.
  assert.equal(r.admitted[0].requestedAtMs, NOW);
});

test("14. a ticket that keeps losing LEAVES — there is no retry storm", () => {
  let queue = [ticket({ deadlineMs: NOW + 10 * 60_000 })];
  const seen = [];
  // Capacity 0 forever: the worst case a starved lane can produce.
  for (let cycle = 0; cycle < 20 && queue.length; cycle++) {
    const r = admitChainRequests(queue, 0, NOW + cycle * 1_000);
    seen.push(r.deferred.length);
    queue = r.deferred;
  }
  assert.equal(queue.length, 0, "the queue drained rather than retrying forever");
  assert.equal(seen.length <= DEFAULT_CHAIN_ADMISSION.maxAttempts + 1, true,
    `abandoned after ${DEFAULT_CHAIN_ADMISSION.maxAttempts} deferrals, not after 20`);
});

test("14b. a deadline expires a ticket even when the attempt counter never fills", () => {
  const r = admitChainRequests([ticket({ deadlineMs: NOW - 1 })], 10, NOW);
  assert.equal(r.admitted.length, 0);
  assert.equal(r.expired[0].outcome, "EXPIRED_DEADLINE");
  assert.match(r.expired[0].reason, /market that moved/);
});

test("17. inside ONE fixed budget, the high-value candidate outranks the low-value one", () => {
  const mrna = ticket({ symbol: "MRNA", score: 1.0, researchOnly: false });
  const noise = Array.from({ length: 20 }, (_, i) => ticket({ symbol: `LOW${i}`, score: 0.5, researchOnly: true }));
  const r = admitChainRequests([...noise, mrna], 3, NOW);
  assert.equal(r.admitted.map((t) => t.symbol).includes("MRNA"), true,
    "the score-1.0 actionable candidate is served inside a 3-slot budget");
  assert.equal(r.admitted[0].symbol, "MRNA", "and served first");
  assert.equal(r.capacity, 3, "the budget itself did not grow");
});

test("17b. the reserve holds room for an actionable candidate on an all-research board", () => {
  // The failure ordering alone cannot fix: MRNA is not outranked, it simply
  // arrives after a lane already spent on research-only work.
  const research = Array.from({ length: 20 }, (_, i) => ticket({ symbol: `R${i}`, score: 0.9, researchOnly: true }));
  const split = splitChainCapacity(10, 0.4);
  assert.deepEqual([split.total, split.actionableReserved, split.shared], [10, 4, 6],
    "the split allocates the capacity that exists; it never creates more");

  const r = admitChainRequests(research, split.total, NOW, DEFAULT_CHAIN_ADMISSION,
    { actionableReserved: split.actionableReserved });
  assert.equal(r.admitted.length, 6, "research-only work may take the shared slots and no more");
  assert.equal(r.actionableReserved, 4, "four stayed free for a ticket not yet raised");

  // And with an actionable ticket present, the reserve is spendable.
  const withLive = admitChainRequests([...research, ticket({ symbol: "MRNA", score: 1.0, researchOnly: false })],
    split.total, NOW, DEFAULT_CHAIN_ADMISSION, { actionableReserved: split.actionableReserved });
  assert.equal(withLive.admitted.map((t) => t.symbol).includes("MRNA"), true);
});

test("12b/15. admission is DEFAULT-INACTIVE and has an explicit rollout control", () => {
  assert.equal(defaultMonitorConfig({}).chainAdmissionEnabled, false,
    "an unproven change to the live path of the primary product does not ship on by default");
  assert.equal(defaultMonitorConfig({ OPTIONS_CHAIN_ADMISSION_ENABLED: "1" }).chainAdmissionEnabled, true);
  assert.equal(optionsMonitorMetrics().chainAdmission.rolloutControl, "OPTIONS_CHAIN_ADMISSION_ENABLED=1");
});

test("15. admission BYPASSES NO GATE — a symbol failing Stage 1 never reaches a ticket", async () => {
  __resetOptionsMonitorForTest();
  const asked = [];
  const thin = {
    ...deps(db(), async (sym) => { asked.push(sym); return chainOk([]); }),
    // Below the $5M dollar-volume floor: Stage 1 rejects it before anything else.
    getUnderlyingBatch: async (syms) => new Map(syms.map((x) => [x, { ...snap(), dayDollarVolume: 1_000 }])),
  };
  await runOptionsMonitorCycle(2, ["THIN"], thin, ADMIT);
  assert.deepEqual(asked, [], "the hard gate still rejected it with admission ON");
});

test("15b. with admission ON the lane still spends within its own budget", async () => {
  __resetOptionsMonitorForTest();
  let chainCalls = 0;
  const syms = Array.from({ length: 40 }, (_, i) => `S${i}`);
  await runOptionsMonitorCycle(2, syms,
    deps(db(), async () => { chainCalls += 1; return chainOk([]); },
      { providerStats: () => ({ minuteCap: 280, callsThisMinute: 275 }) }), ADMIT);
  const m = optionsMonitorMetrics();
  assert.equal(chainCalls <= 40, true);
  assert.equal(m.chainAdmission.active, true);
  assert.equal(m.chainAdmission.queueDepth <= CHAIN_QUEUE_MAX, true, "the carry-over queue is capped");
});

test("16. no duplicate callout — one cycle produces at most one candidate row per symbol", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  await runOptionsMonitorCycle(2, ["NVDA", "NVDA", "NVDA"], deps(d, async () => chainOk([])), ADMIT);
  const rows = d.prepare("SELECT COUNT(*) n FROM options_candidates WHERE symbol='NVDA'").get().n;
  assert.equal(rows <= 1, true, `a repeated symbol produced ${rows} rows`);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 18. PROVIDER BUDGET
 * ══════════════════════════════════════════════════════════════════════════*/

test("18. no provider cap moved, and the lane audit says why deferral cannot help", () => {
  const cfg = defaultMonitorConfig({});
  assert.equal(cfg.providerBudgetPerMinute, 200);
  assert.equal(cfg.providerBudgetTier0PerMinute, 60);

  const audit = auditProviderLanes(280, null, {});
  assert.equal(audit.minuteCap, 280, "the audit reports the cap; it does not set one");
  assert.equal(audit.optionsDiscoveryReserved > 0, true, "the live options lane holds a guarantee");
  // THE PHASE-D FINDING: the mark lanes are the largest reserves after the
  // scanner and they are EVIDENCE, not deferrable. A missed mark cannot be
  // backfilled, so the deferral pool is far smaller than it looks.
  assert.equal(laneClassOf("options_paper_mark"), "EVIDENCE");
  assert.equal(laneClassOf("asymmetry_mark"), "EVIDENCE");
  assert.equal(laneClassOf("options_discovery"), "LIVE_CRITICAL");
  assert.equal(audit.yieldableReserved, 0,
    "every reserved request belongs to a live or evidence lane");
  assert.match(audit.conclusion, /spent in a better order/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 19–21. MISS CAPTURE, WITHOUT FABRICATION
 * ══════════════════════════════════════════════════════════════════════════*/

/**
 * A universe where far more names are genuinely interesting than can be
 * promoted. `quotes()` above is mostly QUIET, and a QUIET name that misses the
 * cut is the design working rather than a near miss — so it would exercise the
 * bound without exercising the capture.
 */
const contendedQuotes = (n = 200) => Array.from({ length: n }, (_, i) => ({
  symbol: `HOT${i}`, price: 100, changePercent: 9 + (i % 25) * 0.4, volume: 5_000_000,
  dayHigh: 112, dayLow: 98, dayOpen: 100, prevClose: 100, bid: null, ask: null,
}));

test("19. miss capture is bounded — a repeated state is written once, not once a cycle", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const awareDeps = {
    now: () => NOW, session: () => "regular", getDb: () => d,
    tier2AwarenessQuotes: () => contendedQuotes(200),
    providerStats: () => ({ minuteCap: 280, callsThisMinute: 0 }),
  };
  const rows = () => d.prepare("SELECT COUNT(*) n FROM options_missed_opportunities").get().n;

  await __selectTier2SymbolsForTest(awareDeps, [], {});
  const afterFirst = rows();
  assert.equal(afterFirst > 0, true, "the loop is CLOSED — something was actually written");
  assert.equal(afterFirst <= 25, true, `the per-cycle cap held: ${afterFirst} rows`);

  for (let i = 0; i < 4; i++) await __selectTier2SymbolsForTest(awareDeps, [], {});
  const afterFive = rows();

  // Four more identical cycles must not cost four more capfuls. The residual
  // growth is real and wanted: exploration rotates the promoted set, so a symbol
  // promoted in cycle 1 and passed over in cycle 2 has genuinely CHANGED state.
  // What is forbidden is 175 unpromoted names re-writing themselves every beat.
  assert.equal(afterFive < afterFirst * 2, true,
    `five cycles wrote ${afterFive} rows against ${afterFirst} for one — transitions, not states`);
  assert.equal(afterFive < 175, true,
    "and far below one row per unpromoted symbol per cycle, which is the unbounded shape");
  assert.equal(MISSED_RESAMPLE_MS, 15 * 60_000, "the same state re-samples on a slow timer");
});

test("19b. the record answers the COIN question with rank and context, not just a name", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  await __selectTier2SymbolsForTest({
    now: () => NOW, session: () => "regular", getDb: () => d,
    tier2AwarenessQuotes: () => contendedQuotes(200),
    providerStats: () => ({ minuteCap: 280, callsThisMinute: 0 }),
  }, [], {});

  const any = d.prepare("SELECT symbol FROM options_missed_opportunities LIMIT 1").get();
  assert.ok(any, "at least one skip was recorded");
  const [row] = missedOpportunitiesForSymbol(d, any.symbol, 5);
  assert.equal(typeof row.preScore, "number");
  assert.equal(row.universeSize, 200, "the rank means something because the denominator is stored");
  assert.equal(typeof row.awarenessRank, "number");
  assert.equal(typeof row.promotionCapacity, "number");
  assert.equal(row.reason, "NOT_PROMOTED");
});

test("20/21. the miss record cannot contain an option — the schema has nowhere to put one", () => {
  const d = db();
  const cols = d.prepare("PRAGMA table_info(options_missed_opportunities)").all().map((c) => c.name);
  for (const forbidden of ["option_symbol", "occ", "strike", "expiration", "premium", "return_pct", "entry_fill"]) {
    assert.equal(cols.includes(forbidden), false, `a miss record must never carry ${forbidden}`);
  }
  assert.equal(optionsMonitorMetrics().missedOpportunity.fabricationGuard.includes("no OCC"), true);
});

test("21b. a skipped symbol opens no paper trade and no alert", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  await runOptionsMonitorCycle(2, ["MRNA"], deps(d, chainFail("PROVIDER_QUOTA_EXCEEDED")), ON);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_trades").get().n, 0,
    "no chain, no contract, no paper trade");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_alerts").get().n, 0);
});
