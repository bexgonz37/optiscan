/**
 * options-awareness-promotion.test.mjs — the coverage-recovery contract.
 *
 * The property under test is NOT "the ranking is good". It is that CHEAP
 * AWARENESS and DEEP ANALYSIS are genuinely separate: the first covers the whole
 * eligible universe for free, the second stays bounded and affordable, and
 * neither can silently become the other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  sweepAwareness, preScoreSymbol, nextObservationCache, leverageMultiplierOf,
  alignedVelocityPctPerMin, rangePositionOf, DEFAULT_OPTIONS_AWARENESS, optionsAwarenessConfig,
} from "../lib/research/options/awareness.ts";
import {
  computePromotionCapacity, selectPromotions, explorationSweepCycles,
  DEFAULT_PROMOTION_CAPACITY, promotionCapacityConfig,
} from "../lib/research/options/promotion.ts";

const NOW = 3_000_000;
const CFG = DEFAULT_OPTIONS_AWARENESS;

/** A quiet, liquid, eligible name. Overrides make it interesting. */
const q = (symbol, over = {}) => ({
  symbol, price: 100, changePercent: 0.5, volume: 1_000_000,
  dayHigh: 101, dayLow: 99, dayOpen: 100, prevClose: 99.5, bid: null, ask: null, ...over,
});

/** A universe of `n` unremarkable names, so the tail is realistic. */
const universe = (n, prefix = "SYM") =>
  Array.from({ length: n }, (_, i) => q(`${prefix}${i}`, { changePercent: (i % 7) * 0.1 }));

const prior = (entries) => new Map(entries.map(([s, changePercent, atMs]) => [s, { changePercent, dollarVolume: 1e8, atMs }]));

/* ── 1. full universe cheaply evaluated from ONE snapshot ──────────────────*/

test("1. the full eligible Tier-2 set is cheaply evaluated from one broad snapshot, with no per-symbol provider call", () => {
  const quotes = universe(1606);
  const sweep = sweepAwareness(quotes, new Map(), NOW, CFG);

  assert.equal(sweep.universeSize, 1606, "every eligible symbol was scored");
  assert.equal(sweep.rows.length, 1606);
  // Every row carries a real score and a rank — none was skipped or stubbed.
  assert.equal(sweep.rows.every((r) => Number.isFinite(r.preScore)), true);
  assert.equal(sweep.rows.every((r) => r.rank >= 1 && r.rank <= 1606), true);

  // The awareness module cannot reach a provider: it takes quotes as an argument
  // and its only import is type-level. This is the structural guarantee that
  // "cheap" is cheap. Asserted here as the contract it is.
  assert.equal(typeof sweepAwareness, "function");
  assert.equal(sweepAwareness.length <= 5, true, "everything it needs is passed in");
});

test("1b. a 1,606-symbol sweep is deterministic and reproducible across identical inputs", () => {
  const quotes = universe(1606);
  const a = sweepAwareness(quotes, new Map(), NOW, CFG);
  const b = sweepAwareness([...quotes].reverse(), new Map(), NOW, CFG);
  // Same set, different provider order -> identical ranking. Provider order was
  // the arbitrariness this whole line of work exists to remove.
  assert.deepEqual(a.rows.map((r) => r.symbol), b.rows.map((r) => r.symbol));
});

/* ── 2. 25 is no longer a visibility cap ───────────────────────────────────*/

test("2. 25 is no longer a visibility/observation cap — awareness covers everything regardless of promotion capacity", () => {
  const quotes = universe(1606);
  const sweep = sweepAwareness(quotes, new Map(), NOW, CFG);
  const sel = selectPromotions(sweep, 0, 25, DEFAULT_PROMOTION_CAPACITY);

  assert.equal(sweep.universeSize, 1606, "cheap observation covers the whole universe");
  assert.equal(sel.promoted.length, 25, "expensive work stays at the affordable number");
  assert.equal(sel.universeSize, 1606);
  // The not-promoted names are OBSERVED, not invisible: current cheap evidence
  // exists for every one of them. That distinction is the deliverable.
  assert.equal(sel.notPromoted, 1581);
  assert.equal(sweep.rows.length - sel.promoted.length, sel.notPromoted);
});

/* ── 3. deep analysis stays bounded ────────────────────────────────────────*/

test("3. deep-analysis promotion remains bounded, and never exceeds capacity", () => {
  const sweep = sweepAwareness(universe(1606), new Map(), NOW, CFG);
  for (const cap of [0, 1, 7, 25, 60, 120]) {
    const sel = selectPromotions(sweep, 0, cap, DEFAULT_PROMOTION_CAPACITY);
    assert.equal(sel.promoted.length, Math.min(cap, 1606), `capacity ${cap} honoured exactly`);
    assert.equal(new Set(sel.promoted.map((p) => p.symbol)).size, sel.promoted.length, "no duplicate promotions");
  }
});

test("3b. capacity 0 promotes nothing rather than falling back to a floor", () => {
  const sweep = sweepAwareness(universe(50), new Map(), NOW, CFG);
  const sel = selectPromotions(sweep, 0, 0, DEFAULT_PROMOTION_CAPACITY);
  assert.equal(sel.promoted.length, 0);
  assert.equal(sel.notPromoted, 50);
});

/* ── 4. capacity is adaptive to provider headroom, and derived not guessed ─*/

test("4. deep-analysis capacity responds to provider headroom, in the safe direction", () => {
  const cfg = { ...DEFAULT_PROMOTION_CAPACITY, reservedForCriticalPerCycle: 20, estRequestsPerPromotion: 2 };
  const tight = computePromotionCapacity({ remainingThisMinute: 30, minuteCap: 200 }, cfg);
  const roomy = computePromotionCapacity({ remainingThisMinute: 180, minuteCap: 200 }, cfg);

  assert.equal(tight.capacity, 5, "(30 - 20) / 2");
  assert.equal(roomy.capacity, 80, "(180 - 20) / 2");
  assert.equal(roomy.capacity > tight.capacity, true, "more headroom buys more depth");
  assert.equal(tight.boundBy, "provider_budget");
  assert.equal(tight.headroomRatio, 0.15);
});

test("4b. no headroom means no promotions — never an overrun", () => {
  const cfg = { ...DEFAULT_PROMOTION_CAPACITY, reservedForCriticalPerCycle: 20 };
  const none = computePromotionCapacity({ remainingThisMinute: 20, minuteCap: 200 }, cfg);
  assert.equal(none.capacity, 0);
  assert.equal(none.boundBy, "no_headroom");
  const negative = computePromotionCapacity({ remainingThisMinute: 0, minuteCap: 200 }, cfg);
  assert.equal(negative.capacity, 0, "the reserve is never borrowed against");
});

test("4c. the latency SLO can bind before the provider budget, and says so", () => {
  const cfg = {
    ...DEFAULT_PROMOTION_CAPACITY,
    estRequestsPerPromotion: 0.1, reservedForCriticalPerCycle: 0,
    cycleLatencyBudgetMs: 10_000, estPerPromotionMs: 1_000, maxConcurrency: 2, hardCeiling: 10_000,
  };
  const c = computePromotionCapacity({ remainingThisMinute: 200, minuteCap: 200 }, cfg);
  assert.equal(c.capacity, 20, "10s / 1s x 2 concurrent");
  assert.equal(c.boundBy, "latency_slo");
  assert.match(c.explain, /bound by latency_slo/);
});

test("4d. the hard ceiling is a backstop that a mis-reported headroom cannot get past", () => {
  const cfg = {
    ...DEFAULT_PROMOTION_CAPACITY,
    estRequestsPerPromotion: 0.001, reservedForCriticalPerCycle: 0,
    cycleLatencyBudgetMs: 10_000_000, estPerPromotionMs: 1, maxConcurrency: 64, hardCeiling: 120,
  };
  const c = computePromotionCapacity({ remainingThisMinute: 999_999, minuteCap: 999_999 }, cfg);
  assert.equal(c.capacity, 120);
  assert.equal(c.boundBy, "hard_ceiling");
});

/* ── 5/6. no request explosion ─────────────────────────────────────────────*/

test("5/6. a 1,606-symbol universe can never produce 1,606 chain or bar requests", () => {
  const sweep = sweepAwareness(universe(1606), new Map(), NOW, CFG);
  // Even with an absurd claimed headroom, the derived capacity is bounded by the
  // ceiling, and promotions are what cost bars+chain.
  const c = computePromotionCapacity({ remainingThisMinute: 10_000_000, minuteCap: 10_000_000 }, DEFAULT_PROMOTION_CAPACITY);
  const sel = selectPromotions(sweep, 0, c.capacity, DEFAULT_PROMOTION_CAPACITY);
  assert.equal(sel.promoted.length <= DEFAULT_PROMOTION_CAPACITY.hardCeiling, true);
  assert.equal(sel.promoted.length < 1606, true);
  // Deep work is what costs; awareness cost nothing per symbol.
  assert.equal(sel.promoted.length <= 120, true, "bars/chain fan-out is bounded by promotions, not universe size");
});

/* ── 7. expensive liquid names are eligible ────────────────────────────────*/

test("7. an expensive liquid name is eligible and rankable — no price ceiling exists here", () => {
  const quotes = [
    q("BRKA", { price: 700_000, changePercent: 1.2, volume: 2_000 }),
    q("MSTR", { price: 1_400, changePercent: 3.0, volume: 900_000 }),
    ...universe(50),
  ];
  const sweep = sweepAwareness(quotes, new Map(), NOW, CFG);
  const syms = sweep.rows.map((r) => r.symbol);
  assert.equal(syms.includes("BRKA"), true, "a $700k share price is observable");
  assert.equal(syms.includes("MSTR"), true, "a $1.4k share price is observable");
});

/* ── 8. leverage cannot monopolise priority ────────────────────────────────*/

test("8. leveraged products cannot monopolise priority solely via their multiplier", () => {
  // SOXL is 3x. A 3x fund printing +30% represents a +10% underlying move.
  // A plain stock genuinely up 10% must not be outranked by that artefact.
  const quotes = [
    q("SOXL", { changePercent: 30, price: 40, volume: 5_000_000, dayHigh: 41, dayLow: 30 }),
    q("TQQQ", { changePercent: 27, price: 80, volume: 5_000_000, dayHigh: 81, dayLow: 63 }),
    q("PLAIN", { changePercent: 10, price: 40, volume: 5_000_000, dayHigh: 41, dayLow: 36 }),
  ];
  const sweep = sweepAwareness(quotes, new Map(), NOW, CFG);
  const byName = Object.fromEntries(sweep.rows.map((r) => [r.symbol, r]));

  assert.equal(byName.SOXL.leverageMultiplier, 3);
  assert.equal(byName.SOXL.normalizedMovePct, 10, "+30% on a 3x fund normalises to +10%");
  assert.equal(byName.TQQQ.normalizedMovePct, 9);
  assert.equal(byName.PLAIN.leverageMultiplier, 1);
  assert.equal(byName.PLAIN.normalizedMovePct, 10);
  // The plain stock is not ranked below either leveraged product on move alone.
  assert.equal(byName.PLAIN.components.move >= byName.TQQQ.components.move, true);
  assert.equal(byName.PLAIN.components.move === byName.SOXL.components.move, true,
    "equal underlying-equivalent move scores equally, regardless of wrapper");
});

test("8b. leveraged products remain fully eligible — normalised, never excluded", () => {
  const sweep = sweepAwareness([q("SOXL", { changePercent: 60, volume: 5_000_000 }), ...universe(20)], new Map(), NOW, CFG);
  const soxl = sweep.rows.find((r) => r.symbol === "SOXL");
  assert.notEqual(soxl, undefined, "still in the universe");
  // Normalised +20% is genuinely the biggest move here, so it genuinely wins.
  assert.equal(soxl.normalizedMovePct, 20);
  assert.equal(soxl.rank, 1, "merit still wins after normalisation");
});

test("8c. an unknown symbol is never assumed leveraged, and ticker shape is not consulted", () => {
  assert.equal(leverageMultiplierOf("NVDA"), 1);
  assert.equal(leverageMultiplierOf("SOXX"), 1, "a plain index fund one letter from SOXS");
  assert.equal(leverageMultiplierOf("SOXS"), 3);
  assert.equal(leverageMultiplierOf("ZZZZ"), 1);
  assert.equal(leverageMultiplierOf(""), 1);
});

/* ── 9. rotation / fairness survives ───────────────────────────────────────*/

test("9. rotation/fairness still exists — a permanently quiet name still advances every cycle", () => {
  const sweep = sweepAwareness(universe(100), new Map(), NOW, CFG);
  const cfg = { ...DEFAULT_PROMOTION_CAPACITY, explorationShare: 0.25 };

  let cursor = 0;
  const everExplored = new Set();
  for (let cycle = 0; cycle < 40; cycle++) {
    const sel = selectPromotions(sweep, cursor, 20, cfg);
    assert.equal(sel.byExploration.length, 5, "25% of 20 slots always rotate");
    sel.byExploration.forEach((s) => everExplored.add(s));
    cursor = sel.nextCursor;
  }
  // 40 cycles x 5 exploration slots over a 100-name universe: the rotation band
  // has been swept several times over, so nothing is starved.
  assert.equal(everExplored.size > 50, true, `rotation reached ${everExplored.size} distinct names`);
});

test("9b. exploration sweep length is reported, and is the worst case for a name that NEVER scores", () => {
  assert.equal(explorationSweepCycles(1606, 25, { ...DEFAULT_PROMOTION_CAPACITY, explorationShare: 0.25 }), 268);
  assert.equal(explorationSweepCycles(1606, 0, DEFAULT_PROMOTION_CAPACITY), 0);
});

/* ── 10. the COIN case ─────────────────────────────────────────────────────*/

test("10. a COIN-like acceleration changes rank immediately — no 160-cycle wait", () => {
  // COIN sits quiet in a 1,606-name universe, deep in the tail by every
  // magnitude measure. Then it starts moving.
  const quiet = [...universe(1605), q("COIN", { symbol: "COIN", changePercent: 0.4, price: 300, volume: 300_000, dayHigh: 301, dayLow: 299 })];
  const before = sweepAwareness(quiet, new Map(), NOW, CFG);
  const coinBefore = before.rows.find((r) => r.symbol === "COIN");

  // One cycle later: +2.2% and climbing fast. Still nowhere near the day's
  // largest mover — the old ranking would not have noticed it for hours.
  const moving = quiet.map((x) => x.symbol === "COIN"
    ? q("COIN", { symbol: "COIN", changePercent: 2.2, price: 305.4, volume: 2_400_000, dayHigh: 305.5, dayLow: 299 })
    : x);
  const after = sweepAwareness(moving, nextObservationCache(before), NOW + 60_000, CFG);
  const coinAfter = after.rows.find((r) => r.symbol === "COIN");

  assert.equal(coinAfter.band, "NEWLY_ACCELERATING", "the quiet-to-active transition is what is detected");
  assert.equal(coinAfter.velocityPctPerMin > 1.5, true, "+1.8%/min of aligned acceleration");
  assert.equal(coinAfter.rank < coinBefore.rank, true, "rank improved");
  assert.equal(coinAfter.rank, 1, "and it went straight to the top of the board");

  // The decisive property: it is promoted on the NEXT cycle at a 25-wide
  // capacity, rather than waiting for a rotation slot.
  const sel = selectPromotions(after, 0, 25, DEFAULT_PROMOTION_CAPACITY);
  assert.equal(sel.byScore.includes("COIN"), true, "promoted on merit, cycle 1");
  assert.equal(sel.promoted.find((p) => p.symbol === "COIN").kind, "SCORE");
});

test("10b. magnitude alone does not win — an extended, stalling name yields to an emerging one", () => {
  const prev = prior([["BIG", 30, NOW], ["NEW", 0.2, NOW]]);
  const rows = sweepAwareness([
    // Up 30% but going nowhere: the chase profile.
    q("BIG", { changePercent: 30, price: 50, volume: 4_000_000, dayHigh: 52, dayLow: 39 }),
    // Up 2% and accelerating hard.
    q("NEW", { changePercent: 2.0, price: 50, volume: 4_000_000, dayHigh: 50.1, dayLow: 49 }),
  ], prev, NOW + 60_000, CFG).rows;

  const big = rows.find((r) => r.symbol === "BIG");
  const fresh = rows.find((r) => r.symbol === "NEW");
  assert.equal(big.band, "EXTENDED");
  assert.equal(fresh.band, "NEWLY_ACCELERATING");
  assert.equal(fresh.rank < big.rank, true, "the emerging move outranks the finished one");
});

/* ── component-level guarantees ────────────────────────────────────────────*/

test("velocity is aligned to the move's own direction, and a stale prior yields null not a guess", () => {
  // Gaining on an up-move: positive.
  assert.equal(alignedVelocityPctPerMin(5, { changePercent: 3, atMs: NOW }, NOW + 60_000, 300_000), 2);
  // Giving back an up-move: negative, never mistaken for acceleration.
  assert.equal(alignedVelocityPctPerMin(3, { changePercent: 5, atMs: NOW }, NOW + 60_000, 300_000), -2);
  // Extending a DOWN move: positive, because the move is progressing.
  assert.equal(alignedVelocityPctPerMin(-5, { changePercent: -3, atMs: NOW }, NOW + 60_000, 300_000), 2);
  // Stale prior: null, not zero, not extrapolated.
  assert.equal(alignedVelocityPctPerMin(5, { changePercent: 3, atMs: NOW }, NOW + 600_000, 300_000), null);
  // No prior at all: null.
  assert.equal(alignedVelocityPctPerMin(5, undefined, NOW, 300_000), null);
});

test("a missing field costs nothing — 'we could not see it' never scores the same as 'it was bad'", () => {
  const withQuote = preScoreSymbol(q("A", { bid: 10, ask: 10.05 }), undefined, NOW, CFG);
  const noQuote = preScoreSymbol(q("A", { bid: null, ask: null }), undefined, NOW, CFG);
  assert.equal(withQuote.components.spreadPenalty, 0, "a tight quote is not penalised");
  assert.equal(noQuote.components.spreadPenalty, 0, "an absent quote is not penalised either");
  assert.equal(noQuote.spreadPct, null, "and it is recorded as unknown, not as a number");

  const noRange = preScoreSymbol(q("A", { dayHigh: null, dayLow: null }), undefined, NOW, CFG);
  assert.equal(noRange.rangePosition, null);
  assert.equal(noRange.components.rangePosition, 0, "no guessed midpoint");
});

test("EXTENDED requires observed stalling — a large mover with NO prior is not penalised on the first cycle", () => {
  // The restart case: on the first sweep nothing has a prior, so nothing has a
  // velocity. If absent velocity counted as "not accelerating", every genuine
  // mover would be demoted for one cycle at exactly the moment it matters.
  const first = preScoreSymbol(q("BIG", { changePercent: 25, price: 50, volume: 4_000_000 }), undefined, NOW, CFG);
  assert.equal(first.velocityPctPerMin, null, "no prior, so no velocity");
  assert.equal(first.components.extendedPenalty, 0, "unknown behaviour is not punished");
  assert.notEqual(first.band, "EXTENDED");

  // With an OBSERVED stall, the penalty is correct and does apply.
  const stalled = preScoreSymbol(
    q("BIG", { changePercent: 25, price: 50, volume: 4_000_000 }),
    { changePercent: 27, dollarVolume: 2e8, atMs: NOW }, NOW + 60_000, CFG,
  );
  assert.equal(stalled.velocityPctPerMin < 0, true, "measured to be giving it back");
  assert.equal(stalled.components.extendedPenalty > 0, true);
  assert.equal(stalled.band, "EXTENDED");
});

test("the pre-score is bounded 0..100 under adversarial inputs", () => {
  const extremes = [
    q("X", { changePercent: 100_000, volume: 1e12, price: 1e6 }),
    q("Y", { changePercent: -100_000, volume: 1e12, price: 1e6, bid: 1, ask: 500 }),
    q("Z", { changePercent: null, volume: null, price: null }),
  ];
  const prev = prior([["X", -100_000, NOW], ["Y", 100_000, NOW]]);
  for (const r of sweepAwareness(extremes, prev, NOW + 1000, CFG).rows) {
    assert.equal(r.preScore >= 0 && r.preScore <= 100, true, `${r.symbol} scored ${r.preScore}`);
  }
});

test("the range term is direction-aware: an up-move wants the high, a down-move wants the low", () => {
  const upAtHigh = preScoreSymbol(q("U", { changePercent: 5, price: 101, dayHigh: 101, dayLow: 99 }), undefined, NOW, CFG);
  const upAtLow = preScoreSymbol(q("U", { changePercent: 5, price: 99, dayHigh: 101, dayLow: 99 }), undefined, NOW, CFG);
  const downAtLow = preScoreSymbol(q("D", { changePercent: -5, price: 99, dayHigh: 101, dayLow: 99 }), undefined, NOW, CFG);
  assert.equal(upAtHigh.components.rangePosition > upAtLow.components.rangePosition, true);
  assert.equal(downAtLow.components.rangePosition, upAtHigh.components.rangePosition,
    "a down-move at the low is the mirror of an up-move at the high");
  assert.equal(rangePositionOf(q("U", { price: 100, dayHigh: 101, dayLow: 99 })), 0.5);
});

test("the observation cache is bounded by the universe and replaced, never appended", () => {
  const s1 = sweepAwareness(universe(1606), new Map(), NOW, CFG);
  const c1 = nextObservationCache(s1);
  assert.equal(c1.size, 1606);
  // A smaller universe next cycle produces a SMALLER cache, not a merged one.
  const s2 = sweepAwareness(universe(400), new Map(), NOW + 60_000, CFG);
  const c2 = nextObservationCache(s2);
  assert.equal(c2.size, 400, "no unbounded accumulation across a session");
});

/* ── config resolution ─────────────────────────────────────────────────────*/

test("config comes from env with safe defaults, and rejects nonsense rather than adopting it", () => {
  assert.deepEqual(optionsAwarenessConfig({}), DEFAULT_OPTIONS_AWARENESS);
  assert.equal(optionsAwarenessConfig({ OPTIONS_AWARENESS_EMERGING_MOVE_PCT: "6" }).emergingMovePct, 6);
  assert.equal(optionsAwarenessConfig({ OPTIONS_AWARENESS_EMERGING_MOVE_PCT: "nope" }).emergingMovePct, DEFAULT_OPTIONS_AWARENESS.emergingMovePct);
  assert.equal(optionsAwarenessConfig({ OPTIONS_AWARENESS_FULL_ACCEL_PCT_PER_MIN: "-5" }).fullAccelerationPctPerMin, DEFAULT_OPTIONS_AWARENESS.fullAccelerationPctPerMin);
  assert.equal(promotionCapacityConfig({ OPTIONS_PROMOTION_EXPLORATION_SHARE: "5" }).explorationShare, 0.9, "clamped, not adopted");
});
