import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stockNowOnlyEligible, stockCompactCard, formatStockCalloutDiscord, stockSpreadPct, stockGateConfig,
} from "../lib/stock-callout.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-07-13T16:48:00Z");
const CFG = stockGateConfig({});

/** A HIGH-confidence, actionable, fresh NBBO long stock setup in regular hours. */
function si(over = {}) {
  return {
    ticker: "SMCI", direction: "bullish", price: 27.18, bid: 27.18, ask: 27.24,
    quoteAsOfMs: NOW - 1000, confidence: 78, actionableNow: true, session: "regular", nowMs: NOW, ...over,
  };
}

// ── eligibility (now-only) ───────────────────────────────────────────────────
test("HIGH + ACTIONABLE_NOW + fresh two-sided NBBO in regular hours is eligible", () => {
  assert.equal(stockNowOnlyEligible(si(), CFG).ok, true);
});

test("WATCH / not-actionable does not send", () => {
  assert.equal(stockNowOnlyEligible(si({ actionableNow: false }), CFG).ok, false);
});

test("stale quote does not send", () => {
  assert.equal(stockNowOnlyEligible(si({ quoteAsOfMs: NOW - 60_000 }), CFG).ok, false);
});

test("missing/one-sided NBBO does not send (NO VALID ENTRY)", () => {
  const r = stockNowOnlyEligible(si({ ask: null }), CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /two-sided|NBBO/i);
});

test("wide spread does not send", () => {
  assert.equal(stockNowOnlyEligible(si({ bid: 26.0, ask: 27.5 }), CFG).ok, false);
});

test("low confidence does not send", () => {
  assert.equal(stockNowOnlyEligible(si({ confidence: 40 }), CFG).ok, false);
});

test("bearish/short direction does not send (long-only stock alerts)", () => {
  assert.equal(stockNowOnlyEligible(si({ direction: "bearish" }), CFG).ok, false);
});

test("closed / disallowed extended session does not send", () => {
  assert.equal(stockNowOnlyEligible(si({ session: "closed" }), CFG).ok, false);
  assert.equal(stockNowOnlyEligible(si({ session: "premarket" }), CFG).ok, false);
  assert.equal(stockNowOnlyEligible(si({ session: "premarket" }), stockGateConfig({ STOCK_EXTENDED_HOURS: "1" })).ok, true);
});

// ── compact card ─────────────────────────────────────────────────────────────
test("compact stock card shows verified price and a live NBBO entry range", () => {
  const card = stockCompactCard(si());
  assert.equal(card.headline, "SMCI STOCK · HIGH CONFIDENCE");
  assert.equal(card.price, "$27.18");
  assert.equal(card.entry, "$27.18–$27.24");
  assert.equal(card.status, "ACTIONABLE NOW");
  assert.equal(card.session, "Regular Market");
});

test("no two-sided quote → entry shows NO VALID ENTRY (no fabricated price)", () => {
  assert.equal(stockCompactCard(si({ bid: null })).entry, "NO VALID ENTRY");
});

test("discord payload is compact and free of options clutter", () => {
  const p = formatStockCalloutDiscord(si());
  assert.match(p.embed.title, /SMCI STOCK · HIGH CONFIDENCE/);
  assert.match(p.embed.description, /Price: \$27\.18/);
  assert.match(p.embed.description, /Entry: \$27\.18–\$27\.24/);
  assert.match(p.embed.description, /Status: ACTIONABLE NOW/);
  assert.ok(!/OCC|Δ|delta|IV |contract/i.test(p.embed.description), "no options technicals");
});

test("stockSpreadPct computes from the NBBO, null when one-sided", () => {
  assert.ok(stockSpreadPct(27.18, 27.24) < 1);
  assert.equal(stockSpreadPct(27.18, null), null);
});

// ── delivery routing (source-spec) ───────────────────────────────────────────
test("stock alerts route only through the stocks webhook and use the compact card", () => {
  const src = readFileSync(join(root, "lib/notifications.ts"), "utf8");
  assert.match(src, /stockNowOnlyEligible/, "now-only gate applied before sending");
  assert.match(src, /formatStockCalloutDiscord/, "compact stock card used");
  assert.match(src, /webhook: DiscordWebhookKind = "stocks"/, "stocks webhook only for stock alerts");
});

test("options and stock webhook routing stay separate", () => {
  const src = readFileSync(join(root, "lib/callouts/routing.ts"), "utf8");
  assert.match(src, /return "stocks"/, "stock horizon routes to stocks");
  assert.match(src, /return "options"/, "everything else routes to options");
});
