/**
 * options-coverage-no-change-guards.test.mjs — the ABSOLUTE NO-CHANGE LIST.
 *
 * The coverage-recovery work touched what the options monitor LOOKS AT and what
 * the owner opening PRINTS. It was required to touch nothing else. A change to
 * observation scope is safe precisely because everything downstream still gets
 * to reject whatever it admits — which is only true while these hold.
 *
 * These are guards, not aspirations: each pins a value or a wiring fact that
 * would break if the boundary were crossed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { broadStockEligibility, stockMomentumPolicyConfig } from "../lib/stock-momentum-policy.ts";
import { computeOptionTargets, safetyBandStopPct } from "../lib/research/options/targets.ts";
import { defaultMonitorConfig } from "../lib/research/options/monitor.ts";
import { defaultTier2Config, selectOptionsStrategy } from "../lib/research/options/discovery.ts";
import { canOpenRealOptionPaper, defaultOpenPaperGate } from "../lib/research/options/paper.ts";
import { decideOptionExit, defaultGradeConfig } from "../lib/research/options/grade.ts";

/* ── 18. provider caps unchanged ───────────────────────────────────────────*/

test("18. provider caps are unchanged — no cap increase was authorised and none was taken", () => {
  const src = readFileSync(new URL("../lib/polygon-provider.js", import.meta.url), "utf8");
  assert.match(src, /POLYGON_DAILY_CALL_CAP \?\? 200000/, "daily cap still 200,000");
  assert.match(src, /POLYGON_MINUTE_CALL_CAP \?\? 280/, "minute cap still 280");
  assert.match(src, /POLYGON_GRADER_DAILY_RESERVE \?\? 5000/, "grader reserve still 5,000");

  // The monitor's own lane budgets are likewise untouched.
  const cfg = defaultMonitorConfig({});
  assert.equal(cfg.providerBudgetPerMinute, 200);
  assert.equal(cfg.providerBudgetTier0PerMinute, 60);
});

test("18b. full-universe awareness did not raise the monitor's spend knobs", () => {
  const cfg = defaultMonitorConfig({});
  assert.equal(cfg.maxSymbolsPerTier2Cycle, 25, "the expensive-slot default is unchanged");
  assert.equal(cfg.maxConcurrency, 3);
  assert.equal(cfg.tier0IntervalMs, 5_000);
  assert.equal(cfg.tier1IntervalMs, 15_000);
  assert.equal(cfg.tier2IntervalMs, 60_000);
});

/* ── 19. stock scanner unchanged ───────────────────────────────────────────*/

test("19. the regular stock scanner is untouched — its $50 / +10% rules still govern only it", () => {
  const p = stockMomentumPolicyConfig({});
  assert.equal(p.maxPrice, 50, "the $50 ceiling is exactly where it was");
  assert.equal(p.minPrice, 0.5);
  assert.equal(p.minGainFromPrevClosePct, 10, "the +10% runner rule is exactly where it was");
  assert.equal(p.minDayVolume, 500_000);

  // A $147 stock is still rejected by the STOCK lane, whatever the options lane
  // can now observe. The two lanes answer different questions and still do.
  const expensive = broadStockEligibility(
    { symbol: "MRNA", price: 147, dayVolume: 20_000_000, gainFromPrevClosePct: 133 }, p);
  assert.equal(expensive.ok, false);
  assert.equal(expensive.failedGate, "price");

  // And a name the stock lane DOES want is still accepted, so this is a
  // boundary check and not a broken import.
  const runner = broadStockEligibility(
    { symbol: "IREN", price: 12, dayVolume: 20_000_000, gainFromPrevClosePct: 14 }, p);
  assert.equal(runner.ok, true);
});

/* ── 23. timestamp validator unchanged ─────────────────────────────────────*/

test("23. the Zone-A timestamp validator is unchanged", () => {
  const src = readFileSync(new URL("../lib/research/episode/clocks.ts", import.meta.url), "utf8");
  // Pinned by content: if the validator's rules move, this fails loudly rather
  // than letting an observation-scope change quietly alter time semantics.
  assert.match(src, /ZONE_A/);
  assert.doesNotMatch(src, /awareness|preScore|promotion/i,
    "the coverage work must not have reached into clock validation");
});

/* ── 24. subscriber authority unchanged / NOT_READY ────────────────────────*/

test("24. subscriber authority is unchanged and the lane stays NOT_READY by default", () => {
  // A research-only strategy is still research-only: nothing in the coverage
  // work grants subscriber authorisation to anything it newly made visible.
  const src = readFileSync(new URL("../lib/research/options/discovery.ts", import.meta.url), "utf8");
  assert.match(src, /INDEX_STRATEGY_ACTIONABLE_ENABLED !== "1"/,
    "index strategies still default to RESEARCH_ONLY");

  // Puts remain research-only unless bearish is explicitly made actionable.
  const gate = defaultTier2Config({});
  assert.equal(gate.minDollarVol, 20_000_000, "the Tier-2 liquidity gate is unchanged");
  assert.equal(gate.minPrice, 3);
});

test("24b. a symbol becoming VISIBLE does not make it DELIVERABLE", () => {
  // The point of the whole architecture: awareness admits, strategy still rejects.
  const sel = selectOptionsStrategy({
    symbol: "COIN", nowMs: 1_000_000, session: "regular", tier: 2,
    underlying: {
      price: 300, dayDollarVolume: 700_000_000, relVolume: null, velPct: 0.1, accelPct: null,
      gapPct: null, aboveVwap: null, hodBreak: null, nearResistancePct: null,
      compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null,
    },
    optionsActivity: null, earnings: null,
  }, {});
  // Nothing about being observed produced a selected strategy from empty evidence.
  assert.equal(sel.selected, null);
  assert.match(sel.reason, /no applicable strategy/);
});

/* ── 25. no real-money execution ───────────────────────────────────────────*/

test("25. no real-money execution path exists or was opened", () => {
  const gate = defaultOpenPaperGate({});
  assert.equal(typeof gate, "object");
  // The paper lane is the only lane. Its entry builder is a simulation of a fill,
  // and nothing in the coverage work introduced an order-placing call site.
  const src = readFileSync(new URL("../lib/research/options/paper.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /place_option_order|placeOrder|submitOrder|executeTrade/i);
  assert.equal(typeof canOpenRealOptionPaper, "function", "named 'real option' but paper-only");
});

test("25b. the new coverage modules contain no order, no delivery and no provider call", () => {
  // Every module the recovery work added, coverage phase and provider-efficiency
  // phase alike. Listed explicitly rather than globbed: a new module must be
  // added here deliberately, which is the moment to ask whether it belongs.
  for (const f of [
    "awareness.ts", "promotion.ts", "optionability.ts",
    "chain-admission.ts", "missed-opportunity.ts", "provider-lane-audit.ts",
    "live-shadow.ts", "stage15-shadow.ts", "feature-semantics-shadow.ts", "rvol-shadow.ts",
  ]) {
    const src = readFileSync(new URL(`../lib/research/options/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /placeOrder|place_option_order|submitOrder/i, `${f}: no order path`);
    assert.doesNotMatch(src, /discord|webhook|sendMessage/i, `${f}: no delivery path`);
    assert.doesNotMatch(src, /fetch\(|require\(["']@\/lib\/polygon|axios/i, `${f}: no provider call`);
  }
});

/* ── production trading logic unchanged ────────────────────────────────────*/

test("targets, stops and the entry denominator are unchanged", () => {
  const plan = computeOptionTargets(3.44, "breakout_forming", {});
  assert.equal(plan.stop, 1.89, "stop is still -45% of the frozen entry");
  assert.equal(plan.t1, 4.99, "T1 is still +1R");
  assert.equal(plan.t2, 6.54, "T2 is still +2R");
  assert.equal(plan.rMultiple, 1.55);
  // The per-strategy stop (-45% here) and the global SAFETY BAND (40%) are
  // different numbers and both are unchanged.
  assert.equal(safetyBandStopPct({}), 40);
  // The denominator is the frozen midpoint, exactly as before.
  assert.match(plan.methodology, /^mid=3\.44; stop=-45% \(1\.89\); R=1\.55; T1=\+1R \(4\.99\); T2=\+2R \(6\.54\)$/);
});

/* ── 31. exit logic unchanged ──────────────────────────────────────────────*/

test("31. exit logic is unchanged — the same position and quote produce the same decision", () => {
  const pos = { entry_fill: 2.00, target: 3.00, invalidation: 1.20, entered_at_ms: 0, strategy: "breakout_forming" };
  const fresh = (bid, ask) => ({ bid, ask, quoteAgeMs: 1_000, providerTimestamp: 0 });

  // A mark at the frozen T1 exits on the target, not on a band.
  const hit = decideOptionExit(pos, fresh(3.00, 3.10), 60_000, defaultGradeConfig(), {});
  assert.equal(hit.action, "exit");
  assert.equal(hit.reason, "target_hit");

  // A mark at the frozen invalidation exits there.
  const stopped = decideOptionExit(pos, fresh(1.10, 1.20), 60_000, defaultGradeConfig(), {});
  assert.equal(stopped.action, "exit");

  // In between, it holds. Nothing in the provider-efficiency work introduced a
  // trail, a time stop, or any other reason to leave a position early — the
  // delivered lane rides a convex tail and those destroy it.
  const between = decideOptionExit(pos, fresh(2.20, 2.30), 60_000, defaultGradeConfig(), {});
  assert.equal(between.action, "hold");

  // The exit CONSTANTS are pinned, not merely the branches. A phase about
  // provider routing has no business moving a take-profit, a stop, or the
  // max-hold that already existed — and the delivered lane rides a convex tail,
  // so tightening any of them is how that lane gets destroyed.
  const g = defaultGradeConfig({});
  assert.equal(g.takeProfitPct, 60);
  assert.equal(g.stopLossPct, 40);
  assert.equal(g.maxHoldMs, 172_800_000, "the pre-existing 2-day time stop is exactly where it was");
  assert.equal(g.maxQuoteAgeMs, 900_000);

  // And no TRAILING stop was introduced. The time stop above is pre-existing and
  // pinned; a trail is a different mechanism and there is still none.
  const src = readFileSync(new URL("../lib/research/options/grade.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /trailing[_ ]?stop|trailStop/i, "no trailing stop was added");
});
