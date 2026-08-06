/**
 * tests/strategy-selection-reachability.test.mjs
 *
 * A strategy that can NEVER be selected, at any market state, for any symbol, is a
 * detection defect — not a market fact.
 *
 * `selectOptionsStrategy` takes ONE winner, `applicable[0]`, ordered by
 * `matched.length / earlySignals.length`. That is a RATIO, and Array#sort is stable in
 * V8, so ties previously resolved by CATALOG ARRAY POSITION. Because a strategy's score
 * depends only on its OWN signals, activating exactly its own signal set is the provably
 * optimal witness for it — which makes reachability DECIDABLE:
 *
 *     S was unselectable  <=>  some EARLIER catalog entry's signal set ⊆ S's signal set
 *
 * That silently killed both strategies written for SPY/QQQ 0DTE:
 *     zero_dte_index          ["opening_range_development","above_vwap","price_acceleration"]
 *     index_intraday_momentum ["above_vwap","price_acceleration"]
 * both dominated by pullback_continuation ["price_acceleration","above_vwap"] at index 5.
 *
 * And because `planPartitions` reads ONLY the selected strategy's `preferredDte`, SPY/QQQ
 * always resolved to pullback_continuation (1-7dte, 8-14dte), so a 0DTE partition was
 * never requested. Production, 2026-08-06: of SPY's seven funnel strategy stages, the only
 * one that fetched a same-day expiry was vwap_rejection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OPTIONS_STRATEGIES, getStrategy } from "../lib/research/options/strategy-catalog.ts";
import { selectOptionsStrategy, scoreStrategies, isIndexSymbol } from "../lib/research/options/discovery.ts";
import { planPartitions } from "../lib/research/options/contract-discovery.ts";

/**
 * Strategies that no market state can ever select, by the decidable criterion above.
 * Restricted to strategies that share the candidate's symbol scope, because an
 * index-scoped strategy is not competing with core strategies on a core symbol.
 */
function unselectableStrategies() {
  const dead = [];
  for (let i = 0; i < OPTIONS_STRATEGIES.length; i++) {
    const s = OPTIONS_STRATEGIES[i];
    const mine = new Set(s.earlySignals);
    const dominators = [];
    for (let j = 0; j < i; j++) {
      const t = OPTIONS_STRATEGIES[j];
      if (!t.earlySignals.length) continue;
      if (!t.earlySignals.every((sig) => mine.has(sig))) continue;
      // Strictly fewer matched signals loses the new tie-break, so it cannot dominate.
      if (t.earlySignals.length < s.earlySignals.length) continue;
      // On an index symbol an index-scoped strategy outranks a non-index one.
      if (s.symbolScope === "index" && t.symbolScope !== "index") continue;
      dominators.push(t.key);
    }
    if (dominators.length) dead.push({ key: s.key, dominators });
  }
  return dead;
}

const spyCandidate = (over = {}) => ({
  symbol: "SPY",
  session: "regular",
  underlying: {
    velPct: 0.4, accelPct: 0.3, aboveVwap: true, openingRange: true,
    nearResistancePct: null, nearSupportPct: null, compressionPct: null, relVolume: null,
    hodBreak: false, lodBreak: false, premarketLevelTest: false, realizedVolExpanding: false,
    ...over,
  },
});

// ── The regression ──────────────────────────────────────────────────────────

test("REPRODUCES THE DEFECT'S FIX: the SPY 0DTE setup now selects zero_dte_index", () => {
  // The strategy's own entryTrigger, verbatim: opening range developing, above VWAP,
  // price accelerating, on an index symbol, in the regular session.
  const sel = selectOptionsStrategy(spyCandidate());
  assert.equal(sel.selected?.key, "zero_dte_index");
  assert.equal(sel.selected?.preferredDte, "0dte", "the selected strategy must permit a same-day partition");
});

test("the selected 0DTE strategy actually produces a 0DTE partition", () => {
  const sel = selectOptionsStrategy(spyCandidate());
  const parts = planPartitions("call", sel.selected.key);
  assert.ok(parts.length > 0, "partitions must be planned");
  assert.ok(
    parts.some((p) => p.dteMin === 0 && p.dteMax === 0),
    `expected a 0-0dte partition, got ${parts.map((p) => p.label).join(", ")}`,
  );
});

test("without an opening range, SPY selects index_intraday_momentum, which also permits 0DTE", () => {
  const sel = selectOptionsStrategy(spyCandidate({ openingRange: false }));
  assert.equal(sel.selected?.key, "index_intraday_momentum");
  assert.ok(
    getStrategy(sel.selected.key).preferredDte.includes("0dte"),
    "index intraday momentum must permit same-day expiry",
  );
});

// ── Scope is respected: this must not leak onto ordinary symbols ────────────

test("index-scoped strategies are refused on non-index symbols", () => {
  const nvda = { ...spyCandidate(), symbol: "NVDA" };
  const scores = scoreStrategies(nvda);
  for (const key of ["zero_dte_index", "index_intraday_momentum"]) {
    const s = scores.find((x) => x.key === key);
    assert.equal(s.applicable, false, `${key} must not apply to NVDA`);
    assert.match(s.rejection, /index-scoped strategy on non-index symbol/);
  }
  // NVDA keeps the behaviour it had before this change.
  assert.equal(selectOptionsStrategy(nvda).selected?.key, "pullback_continuation");
});

test("isIndexSymbol covers the tier-0 ETFs only", () => {
  for (const s of ["SPY", "QQQ", "IWM", "DIA", "spy"]) assert.equal(isIndexSymbol(s), true, s);
  for (const s of ["NVDA", "AAPL", "SPXS", ""]) assert.equal(isIndexSymbol(s), false, s);
});

// ── Unproven strategies must not reach subscribers on a wiring fix ──────────

test("index strategies are RESEARCH_ONLY until explicitly enabled", () => {
  const off = selectOptionsStrategy(spyCandidate(), { env: {} });
  assert.equal(off.selected?.key, "zero_dte_index");
  assert.equal(off.selected?.researchOnly, true, "no forward record yet — must stay research-only");

  const on = selectOptionsStrategy(spyCandidate(), { env: { INDEX_STRATEGY_ACTIONABLE_ENABLED: "1" } });
  assert.equal(on.selected?.researchOnly, false, "explicit opt-in makes it actionable");
});

test("a core-symbol call selection is unaffected by the index gate", () => {
  const nvda = { ...spyCandidate(), symbol: "NVDA" };
  const sel = selectOptionsStrategy(nvda, { env: {} });
  assert.equal(sel.selected?.researchOnly, false, "an ordinary bullish core selection stays actionable");
});

// ── The guard that stops this recurring ─────────────────────────────────────

test("GUARD: no strategy is unselectable, except the known catalog duplicate", () => {
  const dead = unselectableStrategies();
  // trend_continuation's earlySignals are IDENTICAL to pullback_continuation's
  // (["above_vwap","price_acceleration"] vs ["price_acceleration","above_vwap"]) and both
  // are core-scoped, so NOTHING at decision time can tell them apart. That is a catalog
  // design question — the two need distinct signals, or one should be retired — and it is
  // deliberately NOT papered over with an invented discriminator.
  const KNOWN_DUPLICATES = ["trend_continuation"];
  const unexpected = dead.filter((d) => !KNOWN_DUPLICATES.includes(d.key));
  assert.deepEqual(
    unexpected,
    [],
    `unselectable strategies must be fixed or explicitly acknowledged: ${JSON.stringify(unexpected)}`,
  );
  // And the known list must not silently grow.
  assert.deepEqual(dead.map((d) => d.key), KNOWN_DUPLICATES);
});

test("GUARD: every 0DTE-permitting strategy is reachable, except the known duplicate", () => {
  const dead = new Set(unselectableStrategies().map((d) => d.key));
  const zeroDte = OPTIONS_STRATEGIES.filter((s) => s.preferredDte.includes("0dte"));
  assert.ok(zeroDte.length >= 10, "sanity: the catalog still declares 0DTE strategies");
  const unreachable = zeroDte.filter((s) => dead.has(s.key)).map((s) => s.key);
  assert.deepEqual(unreachable, [], `0DTE strategies must be selectable: ${unreachable.join(", ")}`);
});
