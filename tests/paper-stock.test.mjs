import test from "node:test";
import assert from "node:assert/strict";
import { decideStockEntry, evaluateStockExit, resolveStockExitFill } from "../lib/paper-stock.ts";
import { defaultFillConfig } from "../lib/paper-fill-model.ts";

const NOW = Date.parse("2026-07-10T18:00:00Z");
const cfg = defaultFillConfig({});
const q = (bid, ask, over = {}) => ({
  optionSymbol: "AAPL", bid, ask, mid: bid != null && ask != null ? +((bid + ask) / 2).toFixed(4) : null,
  spreadPct: bid && ask ? +(((ask - bid) / ((ask + bid) / 2)) * 100).toFixed(2) : null, asOfMs: NOW, ...over,
});

// ── entry: long only, verified fill ──────────────────────────────────────────

test("long entry fills at ask + slippage from a verified quote (never the tape last)", () => {
  const d = decideStockEntry({ side: "call", sessionAllowed: true, quote: q(10.0, 10.04), shares: 100, session: "regular", fillCfg: cfg, nowMs: NOW });
  assert.equal(d.action, "fill");
  assert.equal(d.toStatus, "ENTERED");
  assert.equal(d.toOrderState, "FILLED");
  assert.ok(d.fillPrice >= 10.04, "pays the ask, not the last/mid");
  assert.ok(d.events.includes("position_opened"));
});

test("short/bearish candidate is rejected — no short stock paper entry (Decision 8)", () => {
  const d = decideStockEntry({ side: "put", sessionAllowed: true, quote: q(10.0, 10.04), shares: 100, session: "regular", fillCfg: cfg, nowMs: NOW });
  assert.equal(d.action, "reject");
  assert.equal(d.fillPrice, null);
  assert.match(d.reason, /short\/bearish/);
});

test("disallowed session rejects the entry (Decision 7)", () => {
  const d = decideStockEntry({ side: "call", sessionAllowed: false, quote: q(10.0, 10.04), shares: 100, session: "afterhours", fillCfg: cfg, nowMs: NOW });
  assert.equal(d.action, "reject");
});

test("missing/one-sided quote is a terminal reject — never fabricates a fill", () => {
  const d = decideStockEntry({ side: "call", sessionAllowed: true, quote: q(null, 10.04), shares: 100, session: "regular", fillCfg: cfg, nowMs: NOW });
  assert.equal(d.action, "reject");
  assert.equal(d.toStatus, "CANCELLED");
});

test("a temporarily wide spread is a retry (not terminal) — may tighten next sweep", () => {
  const d = decideStockEntry({ side: "call", sessionAllowed: true, quote: q(10.0, 12.5), shares: 100, session: "regular", fillCfg: cfg, nowMs: NOW });
  assert.equal(d.action, "retry");
  assert.equal(d.toStatus, null);
});

test("stale quote does not fill", () => {
  const d = decideStockEntry({ side: "call", sessionAllowed: true, quote: q(10.0, 10.04, { asOfMs: NOW - 120_000 }), shares: 100, session: "regular", fillCfg: cfg, nowMs: NOW });
  assert.notEqual(d.action, "fill");
});

test("extended-hours widens slippage vs regular for the same quote", () => {
  const reg = decideStockEntry({ side: "call", sessionAllowed: true, quote: q(10.0, 10.30), shares: 100, session: "regular", fillCfg: cfg, nowMs: NOW });
  const ext = decideStockEntry({ side: "call", sessionAllowed: true, quote: q(10.0, 10.30), shares: 100, session: "premarket", fillCfg: cfg, nowMs: NOW });
  assert.equal(reg.action, "fill");
  assert.equal(ext.action, "fill");
  assert.ok(ext.slippage >= reg.slippage, "extended-hours slippage is at least the regular slippage");
});

// ── exit evaluation (pure, from the mark) ────────────────────────────────────

test("stop outranks target when both would trigger", () => {
  const d = evaluateStockExit({ movePct: -1.0, stopPct: 0.45, targetPct: 0.8, speed: 0.5, maxHold: false, maxHoldMinutes: 5 });
  assert.equal(d.kind, "stop_loss");
});

test("target triggers on a favorable mark move", () => {
  const d = evaluateStockExit({ movePct: 0.9, stopPct: 0.45, targetPct: 0.8, speed: 0.1, maxHold: false, maxHoldMinutes: 5 });
  assert.equal(d.kind, "take_profit");
});

test("tape reversal triggers a smart exit", () => {
  const d = evaluateStockExit({ movePct: 0.1, stopPct: 0.45, targetPct: 0.8, speed: -0.2, maxHold: false, maxHoldMinutes: 5 });
  assert.equal(d.kind, "smart");
});

test("max hold triggers a smart exit when nothing else does", () => {
  const d = evaluateStockExit({ movePct: 0.1, stopPct: 0.45, targetPct: 0.8, speed: 0.1, maxHold: true, maxHoldMinutes: 5 });
  assert.equal(d.kind, "smart");
});

test("no exit while inside the band", () => {
  const d = evaluateStockExit({ movePct: 0.1, stopPct: 0.45, targetPct: 0.8, speed: 0.1, maxHold: false, maxHoldMinutes: 5 });
  assert.equal(d.kind, null);
});

// ── exit fill (conservative, keep-open on unusable quote) ─────────────────────

test("exit fills at bid − slippage with fees", () => {
  const r = resolveStockExitFill({ quote: q(10.0, 10.04), shares: 100, session: "regular", fillCfg: cfg, nowMs: NOW });
  assert.equal(r.unresolved, false);
  assert.ok(r.fillPrice <= 10.0, "gives up slippage vs the bid");
});

test("unusable exit quote is unresolved → caller keeps the position open", () => {
  const r = resolveStockExitFill({ quote: q(null, 10.04), shares: 100, session: "regular", fillCfg: cfg, nowMs: NOW });
  assert.equal(r.unresolved, true);
});
