import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stockNowOnlyEligible, stockCompactCard, formatStockCalloutDiscord, stockSpreadPct, stockGateConfig,
  stockExtensionReason, stockVwapDistPct,
} from "../lib/stock-callout.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-07-13T16:48:00Z");
const CFG = stockGateConfig({});

/** A HIGH-confidence, actionable, fresh NBBO long stock setup in regular hours. */
function si(over = {}) {
  return {
    ticker: "SMCI", direction: "bullish", price: 27.18, bid: 27.18, ask: 27.24,
    movePct: 2.1, vwap: 27.0, vwapDistPct: 0.67,
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

test("missing quote timestamp does not send (MISSING_QUOTE_TIMESTAMP)", () => {
  const r = stockNowOnlyEligible(si({ quoteAsOfMs: null }), CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /MISSING_QUOTE_TIMESTAMP/);
});

test("invalid quote timestamp does not send (MISSING_QUOTE_TIMESTAMP)", () => {
  const r = stockNowOnlyEligible(si({ quoteAsOfMs: Number.NaN }), CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /MISSING_QUOTE_TIMESTAMP/);
});

test("missing/one-sided NBBO does not send (NO VALID ENTRY)", () => {
  const r = stockNowOnlyEligible(si({ ask: null }), CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /two-sided|NBBO/i);
});

test("crossed quote does not send (NO VALID ENTRY)", () => {
  const r = stockNowOnlyEligible(si({ bid: 27.5, ask: 27.0 }), CFG);
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

test("anti-chase blocks stock moves that already ran too far on the day", () => {
  const r = stockNowOnlyEligible(si({ ticker: "USO", movePct: 10.2, vwapDistPct: 1.1 }), CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /day move/);
});

test("anti-chase blocks stock moves too far above VWAP", () => {
  const r = stockNowOnlyEligible(si({ movePct: 3.2, vwapDistPct: 3.0 }), CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /VWAP/);
});

test("anti-chase can be loosened or disabled by env thresholds", () => {
  assert.equal(stockNowOnlyEligible(si({ movePct: 10.2, vwapDistPct: 3.0 }), stockGateConfig({ STOCK_MAX_DAY_RUN_PCT: "12", STOCK_MAX_VWAP_EXT_PCT: "4" })).ok, true);
  assert.equal(stockNowOnlyEligible(si({ movePct: 10.2, vwapDistPct: 3.0 }), stockGateConfig({ STOCK_MAX_DAY_RUN_PCT: "0", STOCK_MAX_VWAP_EXT_PCT: "0" })).ok, true);
});

test("anti-chase fails open for missing extension fields only", () => {
  assert.equal(stockExtensionReason(si({ movePct: null, vwap: null, vwapDistPct: null }), CFG), null);
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

test("stockVwapDistPct computes signed VWAP extension from real price and VWAP", () => {
  assert.equal(stockVwapDistPct({ price: 104, vwap: 100 }), 4);
  assert.equal(stockVwapDistPct({ price: 96, vwap: 100 }), -4);
  assert.equal(stockVwapDistPct({ price: 104, vwap: null }), null);
});

// ── delivery routing (source-spec) ───────────────────────────────────────────
test("stock alerts route only through the stocks webhook and use the compact card", () => {
  const src = readFileSync(join(root, "lib/notifications.ts"), "utf8");
  assert.match(src, /stockNowOnlyEligible/, "now-only gate applied before sending");
  assert.match(src, /formatStockCalloutDiscord/, "compact stock card used");
  assert.match(src, /STOCK_CALLOUTS !== "1"/, "STOCK_CALLOUTS=1 required");
  assert.match(src, /discordWebhookConfigured\(webhook\)/, "stock webhook must be configured");
  assert.match(src, /webhook: DiscordWebhookKind = "stocks"/, "stocks webhook only for stock alerts");
});

test("stock capture persists VWAP extension for Discord and paper parity", () => {
  const capture = readFileSync(join(root, "lib/stock-capture.ts"), "utf8");
  assert.match(capture, /stockVwapDistPct/, "computes signed VWAP extension");
  assert.match(capture, /vwapAtAlert: sig\.vwap/, "persists numeric VWAP");
  assert.match(capture, /vwapDistPctAtAlert: vwapDistPct/, "persists signed VWAP distance");
  assert.match(capture, /vwap: sig\.vwap, vwapDistPct/, "passes VWAP extension into Discord gate");

  const store = readFileSync(join(root, "lib/alert-store.ts"), "utf8");
  assert.match(store, /vwap_at_alert/);
  assert.match(store, /vwap_dist_pct_at_alert/);
  assert.match(store, /above_vwap/);
});

test("stock paper scalps use the same anti-chase gate before creating trades", () => {
  const src = readFileSync(join(root, "lib/paper-engine.ts"), "utf8");
  assert.match(src, /stockExtensionReason/, "paper path imports shared anti-chase helper");
  assert.match(src, /vwap_dist_pct_at_alert/, "paper path uses persisted VWAP extension");
  assert.match(src, /stock scalp refused: \$\{extensionReason\}/, "paper path records terminal chase refusal");
});

test("supervisor Discord boundary re-checks now-only actionability", () => {
  const src = readFileSync(join(root, "lib/callouts/runtime.ts"), "utf8");
  assert.match(src, /nowOnlyActionable/);
  assert.match(src, /if \(!nowOnlyActionable\(b\.callout\)\.ok\) continue;/);
});

test("stock scanner path keeps its own cooldown to avoid duplicate-cycle resends", () => {
  const src = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.match(src, /stockCooldownUntil/, "stock path has a dedicated cooldown");
  assert.match(src, /if \(stockEnabled\) tasks\.push\(handleStockTrigger/, "stock trigger is gated by STOCK_CALLOUTS");
});

test("options and stock webhook routing stay separate", () => {
  const src = readFileSync(join(root, "lib/callouts/routing.ts"), "utf8");
  assert.match(src, /return "stocks"/, "stock horizon routes to stocks");
  assert.match(src, /return "options"/, "everything else routes to options");
});
