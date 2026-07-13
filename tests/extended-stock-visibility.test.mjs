import test from "node:test";
import assert from "node:assert/strict";
import { buildConfigVisibility } from "../lib/runtime-status.ts";
import { stockGateConfig, stockNowOnlyEligible } from "../lib/stock-callout.ts";

function itemFor(vis, key) {
  return vis.items.find((i) => i.key === key) ?? null;
}

// ── runtime status surfaces every premarket/after-hours stock gate ────────────
test("config visibility exposes the extended-hours stock gates by name", () => {
  const vis = buildConfigVisibility({ STOCK_CALLOUTS: "1" }, {});
  for (const key of ["STOCK_CALLOUTS", "STOCK_EXTENDED_HOURS", "extended_stock_notify", "DISCORD_WEBHOOK_STOCKS"]) {
    assert.ok(itemFor(vis, key), `config surfaces ${key}`);
  }
});

test("with STOCK_CALLOUTS on but extended gates off, the blocker is explained (not just 'no data')", () => {
  const vis = buildConfigVisibility({ STOCK_CALLOUTS: "1" }, { extendedStockNotify: false, stockWebhookConfigured: false });
  const ext = itemFor(vis, "STOCK_EXTENDED_HOURS");
  assert.equal(ext.state, "disabled");
  assert.ok(ext.blocks.includes("stock_alerts"), "extended-hours gate flags stock_alerts when it blocks premarket/AH");
  // The summary spells out exactly which gate is off.
  const blockedLine = vis.summary.find((s) => /Premarket\/after-hours stock Discord is blocked/.test(s));
  assert.ok(blockedLine, "summary explains the premarket/AH blocker");
  assert.match(blockedLine, /STOCK_EXTENDED_HOURS/);
  assert.match(blockedLine, /extended_stock_notify/);
  assert.match(blockedLine, /no stock webhook/);
});

test("STOCK_EXTENDED_HOURS or PAPER_STOCK_EXTENDED_HOURS satisfies the env gate", () => {
  assert.equal(itemFor(buildConfigVisibility({ STOCK_EXTENDED_HOURS: "1" }), "STOCK_EXTENDED_HOURS").state, "enabled");
  assert.equal(itemFor(buildConfigVisibility({ PAPER_STOCK_EXTENDED_HOURS: "1" }), "STOCK_EXTENDED_HOURS").state, "enabled");
});

test("all four gates on → premarket/after-hours stock Discord reads as enabled", () => {
  const vis = buildConfigVisibility(
    { STOCK_CALLOUTS: "1", STOCK_EXTENDED_HOURS: "1" },
    { extendedStockNotify: true, stockWebhookConfigured: true },
  );
  assert.ok(vis.summary.some((s) => /Premarket\/after-hours stock Discord is enabled/.test(s)));
});

// ── the gate the config surface describes actually governs delivery ──────────
test("stock now-only gate blocks premarket/AH unless the extended-hours env flag is set", () => {
  const NOW = Date.parse("2026-07-13T12:00:00Z"); // ~08:00 ET, premarket
  const base = {
    ticker: "SMCI", direction: "bullish", price: 27.2, bid: 27.18, ask: 27.22,
    quoteAsOfMs: NOW - 2000, confidence: 82, actionableNow: true, session: "premarket", nowMs: NOW,
  };
  const off = stockNowOnlyEligible(base, stockGateConfig({}));
  assert.equal(off.ok, false);
  assert.match(off.reason, /extended-hours/);

  const on = stockNowOnlyEligible(base, stockGateConfig({ STOCK_EXTENDED_HOURS: "1" }));
  assert.equal(on.ok, true, "premarket bullish setup passes once the extended-hours flag is set");
});

test("premarket bearish stock is never actionable (long-only)", () => {
  const NOW = Date.parse("2026-07-13T12:00:00Z");
  const bear = stockNowOnlyEligible(
    { ticker: "SMCI", direction: "bearish", price: 27.2, bid: 27.18, ask: 27.22, quoteAsOfMs: NOW - 2000, confidence: 82, actionableNow: true, session: "premarket", nowMs: NOW },
    stockGateConfig({ STOCK_EXTENDED_HOURS: "1" }),
  );
  assert.equal(bear.ok, false);
});
