import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scoreCalloutQuality, reconcileTheses, antiChaseCallout, selectForDiscord, reviewPortfolio,
} from "../lib/agents/portfolio.ts";
import { ownerSettings } from "../lib/owner-settings.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the callout runtime wires the portfolio layer and gates delivery on it", () => {
  const src = readFileSync(join(root, "lib/callouts/runtime.ts"), "utf8");
  assert.match(src, /reviewPortfolio\(built\)/, "runtime runs the portfolio review");
  assert.match(src, /eligible\.has\(c\.key\)/, "delivery is gated on portfolio eligibility");
  // The existing dedup/cooldown emission gate is preserved (never weakened).
  assert.match(src, /decideEmission\(c, prev\.get\(c\.key\)/);
  assert.match(src, /if \(!b\.decision\.emit \|\| !b\.discord\) continue;/);
});

/** Minimal but complete Callout for portfolio-layer tests. */
function mk(o = {}) {
  const ticker = o.ticker ?? "SPY";
  const direction = o.direction ?? "bullish";
  const status = o.status ?? "ACTIONABLE_NOW";
  const horizon = o.horizon ?? "0DTE";
  return {
    key: `${ticker}|${direction}|${horizon}`,
    status,
    ticker,
    direction,
    strategyAgent: "test-agent",
    horizon,
    dteRange: [0, 0],
    lifecycleStatus: o.lifecycleStatus ?? null,
    reason: o.reason ?? "clean breakout on volume",
    trigger: "break above prior high",
    invalidation: "loses VWAP",
    management: null,
    contract: o.contract === null ? null : {
      optionSymbol: "O:SPY260714C00755000", strike: 755, expiration: "2026-07-14", dte: 0, side: direction === "bearish" ? "put" : "call",
      bid: 2.5, ask: 2.6, mid: 2.55, spreadPct: o.spreadPct ?? 1, delta: 0.5, iv: 0.2,
      volume: o.volume ?? 500, openInterest: o.openInterest ?? 1000, breakevenPct: 0.5,
    },
    estimatedFillNote: "fill ≈ ask",
    quoteFreshness: o.quoteFreshness ?? "fresh",
    contractScore: o.contractScore ?? 80,
    contractReasons: o.contractReasons ?? ["clean"],
    marketContext: null,
    riskVerdict: { allowed: true, failures: [], vetoed: false },
    sampleSize: 0,
    evidenceStatus: o.evidenceStatus ?? "NOT_TRACKED",
    expectancy: null, profitFactor: null,
    modelState: "INACTIVE_NO_TRAINABLE_DATA",
    probability: o.probability ?? null,
    modelLabel: null, probabilityIsExperimental: false, modelVersion: null, calibration: null,
    primaryBlockingReason: null, researchOnlyWarning: null, insufficientEvidenceWarning: null,
    actionable: o.actionable ?? (status === "ACTIONABLE_NOW"),
    timestamp: 1,
  };
}

const S = ownerSettings({});

// ── ranking (§1, §5, §7) ─────────────────────────────────────────────────────
test("quality rewards fresh, liquid, actionable, core setups", () => {
  const strong = scoreCalloutQuality(mk({ ticker: "SPY", contractScore: 80 }), S);
  const stale = scoreCalloutQuality(mk({ ticker: "SPY", contractScore: 80, quoteFreshness: "stale" }), S);
  const wide = scoreCalloutQuality(mk({ ticker: "SPY", contractScore: 80, spreadPct: 12 }), S);
  const illiquid = scoreCalloutQuality(mk({ ticker: "SPY", contractScore: 80, openInterest: 20, volume: 0 }), S);
  const noContract = scoreCalloutQuality(mk({ ticker: "SPY", contractScore: 80, contract: null }), S);
  assert.ok(strong > stale, "fresh beats stale");
  assert.ok(strong > wide, "tight spread beats wide");
  assert.ok(strong > illiquid, "liquid beats illiquid");
  assert.ok(strong > noContract, "a real contract beats none");
});

test("a weak core idea does NOT outrank a powerful non-core idea", () => {
  const weakCore = scoreCalloutQuality(mk({ ticker: "SPY", contractScore: 55 }), S);
  const strongNonCore = scoreCalloutQuality(mk({ ticker: "F", contractScore: 92 }), S);
  assert.ok(strongNonCore > weakCore, "quality dominates; core is only a tie-break bonus");
});

test("core priority breaks ties in ranking", () => {
  const core = scoreCalloutQuality(mk({ ticker: "SPY", contractScore: 80 }), S);
  const nonCore = scoreCalloutQuality(mk({ ticker: "F", contractScore: 80 }), S);
  assert.ok(core > nonCore, "equal setup → core ranks higher");
});

// ── thesis reconciliation (§2) ───────────────────────────────────────────────
test("bullish-only ticker passes through unchanged", () => {
  const { theses, callouts } = reconcileTheses([mk({ direction: "bullish" })], S);
  assert.equal(theses[0].verdict, "bullish");
  assert.equal(callouts[0].status, "ACTIONABLE_NOW");
});

test("dominant thesis holds; the opposing actionable is demoted to WATCH", () => {
  const bull = mk({ ticker: "SPY", direction: "bullish", contractScore: 88 });
  const bear = mk({ ticker: "SPY", direction: "bearish", contractScore: 60 });
  const { theses, callouts } = reconcileTheses([bull, bear], S);
  assert.equal(theses[0].verdict, "bullish");
  const outBull = callouts.find((c) => c.direction === "bullish");
  const outBear = callouts.find((c) => c.direction === "bearish");
  assert.equal(outBull.status, "ACTIONABLE_NOW", "dominant thesis kept");
  assert.equal(outBear.status, "WATCH", "opposing thesis demoted");
  assert.equal(outBear.actionable, false);
  assert.match(outBear.thesisNote, /dominates/);
});

test("genuinely mixed → NO contradictory actionables; both become WATCH with a disagreement note", () => {
  const bull = mk({ ticker: "SPY", direction: "bullish", contractScore: 80 });
  const bear = mk({ ticker: "SPY", direction: "bearish", contractScore: 80 });
  const { theses, callouts } = reconcileTheses([bull, bear], S);
  assert.equal(theses[0].verdict, "mixed");
  for (const c of callouts) {
    assert.equal(c.status, "WATCH");
    assert.equal(c.actionable, false);
    assert.match(c.thesisNote, /mixed/i);
  }
});

// ── anti-chase (§4) ──────────────────────────────────────────────────────────
test("anti-chase downgrades an extended ACTIONABLE to WAIT_FOR_PULLBACK", () => {
  const extended = antiChaseCallout(mk({ status: "ACTIONABLE_NOW", reason: "already extended past entry" }));
  assert.equal(extended.status, "WAIT_FOR_PULLBACK");
  assert.equal(extended.actionable, false);
  const byLifecycle = antiChaseCallout(mk({ status: "ACTIONABLE_NOW", lifecycleStatus: "EXTENDED" }));
  assert.equal(byLifecycle.status, "WAIT_FOR_PULLBACK");
});

test("anti-chase leaves a fresh, non-extended entry actionable", () => {
  const ok = antiChaseCallout(mk({ status: "ACTIONABLE_NOW", reason: "clean break, room to run" }));
  assert.equal(ok.status, "ACTIONABLE_NOW");
  assert.equal(ok.actionable, true);
});

// ── selection / owner gating (§1, §6, §7, §9) ────────────────────────────────
test("selection caps at maxDiscordAlerts, strongest first", () => {
  const s = ownerSettings({ SUPERVISOR_MAX_DISCORD_ALERTS: "3" });
  const cs = ["SPY", "QQQ", "NVDA", "META", "AAPL"].map((t, i) => mk({ ticker: t, contractScore: 60 + i * 5 }));
  const sel = selectForDiscord(cs, s);
  assert.equal(sel.eligibleKeys.size, 3);
  // Highest contractScore (AAPL) ranks first.
  assert.equal(sel.ranking[0].ticker, "AAPL");
  assert.ok(sel.suppressed.some((x) => /outside top 3/.test(x.reason)));
});

test("min setup quality filters weak ideas", () => {
  const s = ownerSettings({ MIN_SETUP_QUALITY: "100" });
  const sel = selectForDiscord([mk({ ticker: "F", contractScore: 40 })], s);
  assert.equal(sel.eligibleKeys.size, 0);
  assert.ok(sel.suppressed.some((x) => /min setup quality/.test(x.reason)));
});

test("bearish alerts are gated by the owner switch", () => {
  const off = selectForDiscord([mk({ direction: "bearish" })], ownerSettings({}));
  assert.equal(off.eligibleKeys.size, 0);
  assert.ok(off.suppressed.some((x) => /bearish alerts disabled/.test(x.reason)));
  const on = selectForDiscord([mk({ direction: "bearish" })], ownerSettings({ BEARISH_ACTIONABLE: "1" }));
  assert.equal(on.eligibleKeys.size, 1);
});

test("early-stage alerts require the owner opt-in", () => {
  const off = selectForDiscord([mk({ status: "DEVELOPING", actionable: false })], ownerSettings({}));
  assert.ok(off.suppressed.some((x) => /early-stage/.test(x.reason)));
  const on = selectForDiscord([mk({ status: "DEVELOPING", actionable: false })], ownerSettings({ EARLY_ALERTS_ENABLED: "1" }));
  assert.equal(on.eligibleKeys.size, 1);
});

test("non-core only reaches Discord when it clearly outranks core (cap = 1)", () => {
  const s = ownerSettings({ SUPERVISOR_MAX_DISCORD_ALERTS: "1" });
  const weakCore = mk({ ticker: "SPY", contractScore: 55 });
  const strongNonCore = mk({ ticker: "F", contractScore: 92 });
  const sel = selectForDiscord([weakCore, strongNonCore], s);
  assert.deepEqual([...sel.eligibleKeys], [strongNonCore.key]);
});

test("categories gate options vs puts vs stocks", () => {
  const s = ownerSettings({ OWNER_ALERT_CATEGORIES: "stocks", BEARISH_ACTIONABLE: "1" });
  const optionCall = mk({ ticker: "SPY", direction: "bullish", horizon: "0DTE" });
  const sel = selectForDiscord([optionCall], s);
  assert.equal(sel.eligibleKeys.size, 0, "options disabled when only stocks allowed");
  assert.ok(sel.suppressed.some((x) => /category options disabled/.test(x.reason)));
});

// ── integration (§1..§7) ─────────────────────────────────────────────────────
test("reviewPortfolio: reconciles, ranks, and selects end-to-end", () => {
  const cs = [
    mk({ ticker: "SPY", direction: "bullish", contractScore: 90 }),
    mk({ ticker: "SPY", direction: "bearish", contractScore: 60 }), // opposing → demoted
    mk({ ticker: "F", direction: "bullish", contractScore: 50 }),   // weak non-core
    mk({ ticker: "NVDA", direction: "bullish", status: "ACTIONABLE_NOW", reason: "extended, already ran" }), // anti-chase
  ];
  const r = reviewPortfolio(cs, { SUPERVISOR_MAX_DISCORD_ALERTS: "2" });
  // SPY bull dominates → eligible; SPY bear demoted to WATCH (not eligible as actionable).
  assert.ok(r.eligibleKeys.has("SPY|bullish|0DTE"));
  const spyBear = r.callouts.find((c) => c.key === "SPY|bearish|0DTE");
  assert.equal(spyBear.status, "WATCH");
  // NVDA got anti-chased to a wait state.
  const nvda = r.callouts.find((c) => c.ticker === "NVDA");
  assert.equal(nvda.status, "WAIT_FOR_PULLBACK");
  // Cap respected.
  assert.ok(r.eligibleKeys.size <= 2);
  // Every callout carries a portfolio rank for the dashboard.
  assert.ok(r.callouts.every((c) => typeof c.portfolioRank === "number"));
});
