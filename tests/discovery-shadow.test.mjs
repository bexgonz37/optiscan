import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { classifyEligibility, defaultEligibilityConfig } from "../lib/research/discovery/eligibility.ts";
import { mergeAndGate, summarize } from "../lib/research/discovery/discover.ts";
import { persistDiscoveryShadowOnDb, readShadowReportOnDb, recordDiscoveryShadow } from "../lib/research/shadow/store.ts";

const cfg = defaultEligibilityConfig({});
const good = { symbol: "IREN", securityType: "common", price: 12, dayDollarVolume: 50_000_000, halted: false, lastTradeAgeMs: 1000 };

test("eligibility passes a clean liquid common stock", () => {
  const r = classifyEligibility(good, cfg);
  assert.equal(r.eligible, true);
  assert.equal(r.optionsChecked, false, "no option fields ⇒ options gates skipped");
});

test("eligibility excludes the required junk categories", () => {
  assert.deepEqual(classifyEligibility({ ...good, securityType: "warrant" }, cfg).eligible, false);
  assert.match(classifyEligibility({ ...good, securityType: "otc" }, cfg).exclusions.join(","), /security_type_otc/);
  assert.match(classifyEligibility({ ...good, symbol: "ABCDW" }, cfg).exclusions.join(","), /warrant_shape/);
  assert.match(classifyEligibility({ ...good, halted: true }, cfg).exclusions.join(","), /halted/);
  assert.match(classifyEligibility({ ...good, price: 0.2 }, cfg).exclusions.join(","), /price_too_low/);
  assert.match(classifyEligibility({ ...good, dayDollarVolume: 1000 }, cfg).exclusions.join(","), /insufficient_dollar_volume/);
  assert.match(classifyEligibility({ ...good, lastTradeAgeMs: 999999 }, cfg).exclusions.join(","), /stale_underlying/);
});

test("options gates run only when chain data is present", () => {
  assert.match(classifyEligibility({ ...good, optionBid: 0 }, cfg).exclusions.join(","), /zero_bid_contract/);
  assert.match(classifyEligibility({ ...good, optionSpreadPct: 40 }, cfg).exclusions.join(","), /extreme_option_spread/);
  assert.match(classifyEligibility({ ...good, optionChainAgeMs: 999999 }, cfg).exclusions.join(","), /stale_option_chain/);
});

test("mergeAndGate unions sources, keeps the freshest print, and summarizes", () => {
  const merged = mergeAndGate([
    { symbol: "ASTS", source: "market_snapshot", price: 20, dayDollarVolume: 30_000_000, changePctFromPrevClose: 12, observedAtMs: 1000 },
    { symbol: "ASTS", source: "gainers", price: 21, dayDollarVolume: 31_000_000, changePctFromPrevClose: 14, observedAtMs: 2000 },
    { symbol: "ZZZW", source: "market_snapshot", price: 3, dayDollarVolume: 100, changePctFromPrevClose: 50, observedAtMs: 1000 },
  ], cfg);
  const asts = merged.find((m) => m.symbol === "ASTS");
  assert.deepEqual(asts.sources.sort(), ["gainers", "market_snapshot"]);
  assert.equal(asts.price, 21, "freshest observation wins");
  assert.equal(asts.eligible, true);
  const zzz = merged.find((m) => m.symbol === "ZZZW");
  assert.equal(zzz.eligible, false); // warrant-shape + insufficient volume
  const s = summarize(merged);
  assert.equal(s.total, 2); assert.equal(s.eligible, 1); assert.equal(s.rejected, 1);
  assert.ok(s.bySource.market_snapshot >= 1);
});

function shadowDb() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE discovery_shadow (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, sources_json TEXT, price REAL, change_pct REAL, rel_volume REAL, dollar_volume REAL, eligible INTEGER NOT NULL, exclusions_json TEXT, options_checked INTEGER NOT NULL DEFAULT 0, observed_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL);`);
  return d;
}

test("persist + read shadow report (discovery coverage + top exclusions)", () => {
  const d = shadowDb();
  const merged = mergeAndGate([
    { symbol: "RKLB", source: "market_snapshot", price: 25, dayDollarVolume: 40_000_000, changePctFromPrevClose: 8, observedAtMs: 1 },
    { symbol: "JUNKW", source: "market_snapshot", price: 2, dayDollarVolume: 500, changePctFromPrevClose: 60, observedAtMs: 1 },
  ], cfg);
  assert.equal(persistDiscoveryShadowOnDb(d, merged, 100), 2);
  const rep = readShadowReportOnDb(d);
  assert.equal(rep.discovery.total, 2);
  assert.equal(rep.discovery.eligible, 1);
  assert.ok(rep.discovery.topExclusions.length >= 1);
  assert.match(rep.note, /No alerts/);
});

test("live hook is a HARD no-op unless the flag is set", () => {
  const res = recordDiscoveryShadow([], 1, {}); // flag absent
  assert.equal(res.recorded, 0);
  assert.match(res.reason, /BROAD_DISCOVERY_SHADOW_ENABLED/);
});
