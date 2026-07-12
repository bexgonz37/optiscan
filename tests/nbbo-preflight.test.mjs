import test from "node:test";
import assert from "node:assert/strict";
import { parseSnapshotTickers } from "../lib/polygon-provider.js";
import { simulateFill, defaultFillConfig } from "../lib/paper-fill-model.ts";

const NOW = Date.parse("2026-07-09T15:00:00Z");

// (26) parser maps lastQuote bid/ask/timestamp correctly
test("parseSnapshotTickers maps lastQuote p/P/t to bid/ask/quoteProviderTimestamp", () => {
  const [row] = parseSnapshotTickers([
    {
      ticker: "SPY",
      lastTrade: { p: 500.12, t: NOW * 1e6 },
      lastQuote: { p: 500.10, P: 500.14, t: NOW * 1e6 },
      day: { c: 500, v: 1e6 },
      min: {},
    },
  ]);
  assert.equal(row.symbol, "SPY");
  assert.equal(row.bid, 500.10);
  assert.equal(row.ask, 500.14);
  assert.equal(row.quoteProviderTimestamp, NOW * 1e6);
});

// (27) missing lastQuote ⇒ null bid/ask (no fabrication)
test("missing lastQuote yields null bid/ask", () => {
  const [row] = parseSnapshotTickers([{ ticker: "AAPL", lastTrade: { p: 200 }, day: { c: 199 } }]);
  assert.equal(row.bid, null);
  assert.equal(row.ask, null);
});

// (27) a stock buy with no two-sided quote must NOT fill
test("simulated stock entry refuses to fill without a two-sided NBBO quote", () => {
  const cfg = defaultFillConfig({});
  const noQuote = { optionSymbol: "SPY", bid: null, ask: null, mid: null, spreadPct: null, asOfMs: NOW };
  const r = simulateFill({ side: "buy_to_open", assetClass: "stock", units: 10, limit: null, session: "regular" }, noQuote, cfg, NOW);
  assert.equal(r.filled, false);
  assert.match(r.reason, /one-sided or missing quote/);
});

test("simulated stock entry fills against a valid two-sided NBBO quote", () => {
  const cfg = defaultFillConfig({});
  const q = { optionSymbol: "SPY", bid: 20.00, ask: 20.02, mid: 20.01, spreadPct: 0.1, asOfMs: NOW };
  const r = simulateFill({ side: "buy_to_open", assetClass: "stock", units: 10, limit: null, session: "regular" }, q, cfg, NOW);
  assert.equal(r.filled, true);
  assert.ok(r.price >= 20.02, "long stock entry pays ask + slippage");
});

// Source-spec: the NBBO diagnostic is read-only and never fabricates.
test("nbboDiagnostic is a read-only count reporter (source-spec)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "lib/outcome-store.ts"), "utf8");
  assert.ok(src.includes("nbboDiagnostic"));
  assert.ok(/runtimeNbboProven/.test(src));
  assert.ok(!/INSERT|UPDATE|DELETE/i.test(src.slice(src.indexOf("nbboDiagnostic"), src.indexOf("nbboDiagnostic") + 1200)), "diagnostic must not mutate");
});
