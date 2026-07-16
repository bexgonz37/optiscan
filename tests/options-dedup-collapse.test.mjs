import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { selectForDiscord } from "../lib/agents/portfolio.ts";
import { ownerSettings } from "../lib/owner-settings.ts";
import { buildConfigVisibility } from "../lib/runtime-status.ts";
import { buildOptionsFunnel } from "../lib/live-funnel.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** Minimal ACTIONABLE_NOW callout for the portfolio layer. */
function mk(o = {}) {
  const ticker = o.ticker ?? "SPY";
  const direction = o.direction ?? "bullish";
  const horizon = o.horizon ?? "0DTE";
  return {
    key: `${ticker}|${direction}|${horizon}`,
    status: "ACTIONABLE_NOW", ticker, direction, strategyAgent: "test", horizon, dteRange: [0, 0],
    lifecycleStatus: null, reason: "clean breakout", trigger: "break high", invalidation: "loses VWAP", management: null,
    contract: { optionSymbol: `O:${ticker}C1`, strike: 100, expiration: "2026-07-17", dte: 3, side: direction === "bearish" ? "put" : "call", bid: 2.5, ask: 2.6, mid: 2.55, spreadPct: 1, delta: 0.5, iv: 0.2, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    estimatedFillNote: "fill ≈ ask", quoteFreshness: "fresh", contractScore: o.contractScore ?? 80, contractReasons: ["clean"],
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, sampleSize: 0, evidenceStatus: "NOT_TRACKED",
    expectancy: null, profitFactor: null, modelState: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    modelLabel: null, probabilityIsExperimental: false, modelVersion: null, calibration: null,
    primaryBlockingReason: null, researchOnlyWarning: null, insufficientEvidenceWarning: null,
    actionable: true, timestamp: 1, entryState: "ACTIONABLE",
  };
}

// ── Part 1: collapse canonical variants ──────────────────────────────────────

test("multiple variants of one ticker/direction collapse to the single best", () => {
  const s = ownerSettings({ SUPERVISOR_MAX_DISCORD_ALERTS: "10" });
  // Three AAPL bullish horizons, all ACTIONABLE_NOW — only the best (highest score) survives.
  const cs = [
    mk({ ticker: "AAPL", horizon: "0DTE", contractScore: 60 }),
    mk({ ticker: "AAPL", horizon: "1-5", contractScore: 90 }),
    mk({ ticker: "AAPL", horizon: "5-15", contractScore: 70 }),
  ];
  const sel = selectForDiscord(cs, s);
  assert.equal(sel.actionableBeforeCollapse, 3);
  assert.equal(sel.collapsedCount, 1, "collapsed to one AAPL bullish idea");
  assert.equal(sel.eligibleKeys.size, 1);
  assert.ok(sel.eligibleKeys.has("AAPL|bullish|1-5"), "kept the highest-quality variant");
  assert.ok(sel.suppressed.some((x) => /collapsed: lower-ranked variant/.test(x.reason)));
});

test("CALL and PUT on the same ticker are DISTINCT episodes (not collapsed together)", () => {
  const s = ownerSettings({ SUPERVISOR_MAX_DISCORD_ALERTS: "10", BEARISH_ACTIONABLE: "1" });
  const cs = [mk({ ticker: "NVDA", direction: "bullish" }), mk({ ticker: "NVDA", direction: "bearish" })];
  const sel = selectForDiscord(cs, s);
  assert.equal(sel.collapsedCount, 2, "bullish and bearish are separate ideas");
});

test("distinct tickers are never collapsed into each other", () => {
  const s = ownerSettings({ SUPERVISOR_MAX_DISCORD_ALERTS: "10" });
  const cs = ["SPY", "QQQ", "NVDA"].map((t) => mk({ ticker: t }));
  const sel = selectForDiscord(cs, s);
  assert.equal(sel.collapsedCount, 3);
  assert.equal(sel.eligibleKeys.size, 3);
});

// ── Part 2: portfolio suppression is quality-based, NOT paper-based ───────────

test("Discord eligibility (portfolio selection) never consults paper trading", () => {
  const src = read("lib/agents/portfolio.ts");
  assert.doesNotMatch(src, /paper-engine|paper-challenge|paper-bridge|createPaperTrade|challengeConfig|capitalContext/,
    "the portfolio/selection layer must not import or depend on paper affordability");
});

test("portfolioSuppressed in the runtime funnel is the top-N quality cut, not paper", () => {
  const src = read("lib/callouts/runtime.ts");
  // The 'portfolio:' suppression tag is set only for the top-ranked-selection miss.
  assert.match(src, /portfolio: not in the top-ranked Discord selection/);
  assert.match(src, /d\.reason\?\.startsWith\("portfolio:"\)/);
});

// ── Observability inconsistency: funnel uses the SAME readiness source ────────

test("config visibility reports READY when the DB-backed webhook/notify extras are passed", () => {
  const env = { STOCK_CALLOUTS: "1", STOCK_EXTENDED_HOURS: "1", SUPERVISOR_RUNTIME: "1", CALLOUT_CANONICAL_PATH: "supervisor", AGENT_CALLOUT_DISCORD: "1" };
  const withExtras = buildConfigVisibility(env, {
    extendedStockNotify: true, stockWebhookConfigured: true, optionsWebhookConfigured: true,
  });
  assert.equal(withExtras.readiness.optionsCallouts.ready, true);
  assert.equal(withExtras.readiness.stockCallouts.ready, true);
  assert.equal(withExtras.readiness.premarketNotifications.ready, true);
  // Without the extras (the old funnel bug) it wrongly reports webhooks missing.
  const withoutExtras = buildConfigVisibility(env, {});
  assert.ok(withoutExtras.readiness.stockCallouts.blockedBy.some((b) => /DISCORD_WEBHOOK_STOCKS/.test(b)));
});

test("the funnel route passes the same DB-backed extras as runtime status", () => {
  const route = read("app/api/diagnostics/funnel/route.ts");
  assert.match(route, /discordWebhookConfigured\("stocks"\)/);
  assert.match(route, /discordWebhookConfigured\("options"\)/);
  assert.match(route, /extendedStockNotifyEnabled\(\)/);
});

// ── funnel stages surface for the panel ──────────────────────────────────────

test("options funnel exposes the full pipeline stages incl. actionable/collapsed", () => {
  const f = buildOptionsFunnel({
    lastCycleAtMs: 1,
    lastFunnel: { tickersConsidered: 14, chainsOk: 14, chainsFailed: 0, tickersWithCanonical: 14, canonical: 80, actionable: 8, collapsed: 5, dedupSuppressed: 2, portfolioSuppressed: 0, emitted: 3, delivered: 3, notActionableNow: 72, contractIncomplete: 0, contractMismatch: 0, topReason: null, deliveryGateReason: null },
    lastSuppressedItems: [{ ticker: "AAPL", direction: "bullish", optionSymbol: "O:AAPLC1", status: "ACTIONABLE_NOW", previousStatus: "ACTIONABLE_NOW", suppressionReason: "no material state change", materialChange: false }],
  }, ["NVDA"], { ready: true, blockedBy: [] });
  assert.equal(f.actionable, 8);
  assert.equal(f.collapsed, 5);
  assert.equal(f.dedupSuppressed, 2);
  assert.equal(f.suppressedItems.length, 1);
  assert.equal(f.suppressedItems[0].ticker, "AAPL");
});
