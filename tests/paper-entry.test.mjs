import test from "node:test";
import assert from "node:assert/strict";
import { decideEntryFill, decideMark, resolveExitFill } from "../lib/paper-entry.ts";
import { defaultFillConfig } from "../lib/paper-fill-model.ts";
import { buildPaperExplanation } from "../lib/paper-explain.ts";

const NOW = Date.parse("2026-07-10T18:00:00Z");
const cfg = defaultFillConfig({});
const q = (bid, ask, over = {}) => ({
  optionSymbol: "O:X", bid, ask, mid: bid != null && ask != null ? +((bid + ask) / 2).toFixed(4) : null,
  spreadPct: bid && ask ? +(((ask - bid) / ((ask + bid) / 2)) * 100).toFixed(2) : null, asOfMs: NOW, ...over,
});
const okReval = (over = {}) => ({ ok: true, actionable: true, researchOnly: false, revalidatedContract: {}, reason: "ok", drift: null, ...over });
const badReval = (over = {}) => ({ ok: false, actionable: false, researchOnly: true, revalidatedContract: null, reason: "spread too wide", rejectionCode: "SPREAD_TOO_WIDE", drift: null, ...over });

// ── entry gating ─────────────────────────────────────────────────────────────

test("valid revalidation + marketable quote → FILL via the conservative model", () => {
  const d = decideEntryFill({ revalidation: okReval(), quote: q(1.10, 1.20), limit: 1.25, contracts: 1, session: "regular", fillCfg: cfg, nowMs: NOW, entryWindowExpired: false });
  assert.equal(d.action, "fill");
  assert.equal(d.toStatus, "ENTERED");
  assert.equal(d.toOrderState, "FILLED");
  assert.ok(d.fillPrice > 1.20, "pays ask + slippage, not mid");
  assert.ok(d.events.includes("position_opened"));
});

test("failed revalidation → REJECT, never fills, never substitutes", () => {
  const d = decideEntryFill({ revalidation: badReval(), quote: q(1.10, 1.20), limit: 1.25, contracts: 1, session: "regular", fillCfg: cfg, nowMs: NOW, entryWindowExpired: false });
  assert.equal(d.action, "reject");
  assert.equal(d.toOrderState, "REJECTED");
  assert.equal(d.fillPrice, null);
  assert.ok(d.events.includes("validation_failed"));
});

test("research-only (non-actionable) revalidation never opens a position", () => {
  const d = decideEntryFill({ revalidation: okReval({ actionable: false, researchOnly: true }), quote: q(1.1, 1.2), limit: 1.25, contracts: 1, session: "regular", fillCfg: cfg, nowMs: NOW, entryWindowExpired: false });
  assert.equal(d.action, "reject");
});

test("ask above limit → WAIT (still PENDING), not a fill", () => {
  const d = decideEntryFill({ revalidation: okReval(), quote: q(1.30, 1.40), limit: 1.25, contracts: 1, session: "regular", fillCfg: cfg, nowMs: NOW, entryWindowExpired: false });
  assert.equal(d.action, "wait");
  assert.equal(d.toOrderState, "PENDING");
});

test("entry window lapsed → CANCELLED via timeout", () => {
  const d = decideEntryFill({ revalidation: okReval(), quote: q(1.1, 1.2), limit: 1.25, contracts: 1, session: "regular", fillCfg: cfg, nowMs: NOW, entryWindowExpired: true });
  assert.equal(d.toStatus, "CANCELLED");
  assert.ok(d.events.includes("timeout"));
});

// ── marks ────────────────────────────────────────────────────────────────────

test("missing quote → mark_missing, position kept open (no exit)", () => {
  const m = decideMark(q(null, 1.2), cfg, NOW);
  assert.equal(m.markable, false);
  assert.equal(m.event, "mark_missing");
});

test("stale quote → mark_stale, position kept open (no fabricated exit)", () => {
  const m = decideMark(q(1.1, 1.2, { asOfMs: NOW - 120_000 }), cfg, NOW);
  assert.equal(m.markable, false);
  assert.equal(m.event, "mark_stale");
});

test("fresh quote → mark_updated at the mid", () => {
  const m = decideMark(q(1.1, 1.2), cfg, NOW);
  assert.equal(m.markable, true);
  assert.equal(m.event, "mark_updated");
  assert.equal(m.mark, 1.15);
});

// ── exit fills ───────────────────────────────────────────────────────────────

test("stop/target exit fills at bid − slippage with fees", () => {
  const trade = { optionType: "call", strike: 500, contracts: 2, lastMark: 1.5 };
  const r = resolveExitFill({ decision: { kind: "stop_loss", reason: "stop", fillPrice: 1.4 }, trade, quote: q(1.40, 1.50), underlying: 500, session: "regular", fillCfg: cfg, nowMs: NOW });
  assert.equal(r.unresolved, false);
  assert.ok(r.fillPrice < 1.40, "gives up slippage vs the bid");
  assert.ok(r.fees > 0);
});

test("expiration settles at intrinsic value from the underlying (ITM)", () => {
  const trade = { optionType: "call", strike: 500, contracts: 1, lastMark: 0.2 };
  const r = resolveExitFill({ decision: { kind: "expired", reason: "exp", fillPrice: 0 }, trade, quote: q(null, null), underlying: 503.5, session: "closed", fillCfg: cfg, nowMs: NOW });
  assert.equal(r.fillPrice, 3.5, "intrinsic, not the last mark");
});

test("expiration OTM settles worthless", () => {
  const trade = { optionType: "call", strike: 500, contracts: 1, lastMark: 0.4 };
  const r = resolveExitFill({ decision: { kind: "expired", reason: "exp", fillPrice: 0 }, trade, quote: q(null, null), underlying: 497, session: "closed", fillCfg: cfg, nowMs: NOW });
  assert.equal(r.fillPrice, 0);
});

test("expiration with no underlying falls back to last mark (documented)", () => {
  const trade = { optionType: "call", strike: 500, contracts: 1, lastMark: 0.55 };
  const r = resolveExitFill({ decision: { kind: "expired", reason: "exp", fillPrice: 0 }, trade, quote: q(null, null), underlying: null, session: "closed", fillCfg: cfg, nowMs: NOW });
  assert.equal(r.fillPrice, 0.55);
  assert.match(r.note, /last mark/);
});

test("exit against an unusable quote is unresolved → caller keeps the position open", () => {
  const trade = { optionType: "call", strike: 500, contracts: 1, lastMark: 1.2 };
  const r = resolveExitFill({ decision: { kind: "stop_loss", reason: "stop", fillPrice: 1.1 }, trade, quote: q(null, 1.2), underlying: 500, session: "regular", fillCfg: cfg, nowMs: NOW });
  assert.equal(r.unresolved, true);
});

// ── paper explanation (deterministic, reuses shared rejection wording) ───────

test("explanation: filled open position reads ACTIONABLE with cost impact", () => {
  const e = buildPaperExplanation({
    ticker: "SPY", side: "call", status: "ENTERED", orderState: "FILLED", positionState: "OPEN",
    thesis: "HOD break", entryPrice: 1.22, entrySlippage: 0.02, entryFees: 0.65, revalidationOk: true,
    drift: { spreadWidened: true, spreadPctAtAlert: 2.5, spreadPctNow: 3.1, midMovePct: 4 },
  });
  assert.equal(e.actionabilityStatus, "ACTIONABLE");
  assert.match(e.fillOrReject, /Filled at \$1.22/);
  assert.match(e.costImpact, /slippage/);
  assert.match(e.revalidated, /spread 2.5%→3.1%/);
});

test("explanation: rejected entry cites the revalidation reason, not a fake contract", () => {
  const e = buildPaperExplanation({
    ticker: "SPY", side: "call", status: "CANCELLED", orderState: "REJECTED", positionState: null,
    revalidationOk: false, revalidationCode: "CONTRACT_DISAPPEARED", revalidationReason: "contract gone",
  });
  assert.equal(e.actionabilityStatus, "NO_VALID_CONTRACT");
  assert.match(e.revalidated, /no longer in the chain/);
});
