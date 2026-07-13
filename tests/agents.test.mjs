import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHorizonAgent } from "../lib/agents/horizon-agent.ts";
import { superviseResults, nextPriorState } from "../lib/agents/supervisor.ts";
import { resultKey } from "../lib/agents/types.ts";
import { HORIZON_AGENTS } from "../lib/agents/registry.ts";

const NOW = Date.parse("2026-07-09T15:00:00Z");

const okSelection = (over = {}) => ({
  ok: true, profile: "zero_dte_momentum", contract: { optionSymbol: "O:SPY_C500", strike: 500, expiration: "2026-07-09", dte: 0, bid: 1.1, ask: 1.2 },
  score: 78, reasons: ["fresh momentum", "usable delta"], actionable: true, researchOnly: false, notes: [],
  marketData: { spot: 500, mid: 1.15, spreadPct: 4, delta: 0.5, openInterest: 1000, volume: 500, iv: 0.3, breakevenPct: 0.5, distFromSpotPct: 0, chainAsOfMs: NOW, contractAsOfMs: NOW },
  ...over,
});
const rejectSelection = () => ({ ok: false, profile: "zero_dte_momentum", rejectionCode: "SPREAD_TOO_WIDE", reason: "no safe contract", evaluated: 3, blockedByGate: { spread: 3 } });

const cfgCall = { agentId: "call_0DTE", agentVersion: 1, strategy: "zero_dte_momentum", strategyVersion: 1, direction: "bullish", horizon: "0DTE", dteRange: [0, 1], selectorProfile: "zero_dte_momentum" };
const cfgPut = { ...cfgCall, agentId: "put_research_0DTE", direction: "bearish" };

const freshOk = { ok: true, reason: null };

test("registry has 10 horizon agents (5 call + 5 put research)", () => {
  assert.equal(HORIZON_AGENTS.length, 10);
  assert.equal(HORIZON_AGENTS.filter((a) => a.direction === "bearish").length, 5);
  assert.equal(HORIZON_AGENTS.filter((a) => a.direction === "bullish").length, 5);
});

test("bullish agent with clean actionable selection ⇒ ACTIONABLE_NOW", () => {
  const r = evaluateHorizonAgent(cfgCall, { ticker: "spy", session: "regular", nowMs: NOW, selection: okSelection(), freshness: freshOk, riskVerdict: { allowed: true, failures: [], vetoed: false } });
  assert.equal(r.candidateStatus, "ACTIONABLE_NOW");
  assert.equal(r.actionability, "ACTIONABLE");
  assert.equal(r.researchOnly, false);
  assert.equal(r.selectedContract.optionSymbol, "O:SPY_C500");
  assert.equal(r.ticker, "SPY");
});

test("PUT agent is ALWAYS research-only even with a clean actionable selection", () => {
  const r = evaluateHorizonAgent(cfgPut, { ticker: "spy", session: "regular", nowMs: NOW, selection: okSelection({ actionable: false, researchOnly: true }), freshness: freshOk });
  assert.equal(r.actionability, "RESEARCH_ONLY");
  assert.equal(r.researchOnly, true);
  assert.notEqual(r.candidateStatus, "ACTIONABLE_NOW");
  assert.equal(r.direction, "bearish");
});

test("even if a put selection is marked actionable, the agent forces research-only", () => {
  const r = evaluateHorizonAgent(cfgPut, { ticker: "spy", session: "regular", nowMs: NOW, selection: okSelection({ actionable: true }), freshness: freshOk });
  assert.equal(r.actionability, "RESEARCH_ONLY");
  assert.equal(r.researchOnly, true);
});

test("stale data ⇒ DATA_STALE + BLOCKED regardless of selection", () => {
  const r = evaluateHorizonAgent(cfgCall, { ticker: "spy", session: "regular", nowMs: NOW, selection: okSelection(), freshness: { ok: false, reason: "quote 90s old" } });
  assert.equal(r.candidateStatus, "DATA_STALE");
  assert.equal(r.actionability, "BLOCKED");
});

test("no valid contract ⇒ NO_VALID_CONTRACT with failed gates", () => {
  const r = evaluateHorizonAgent(cfgCall, { ticker: "spy", session: "regular", nowMs: NOW, selection: rejectSelection(), freshness: freshOk });
  assert.equal(r.candidateStatus, "NO_VALID_CONTRACT");
  assert.ok(r.failedGates.includes("spread"));
});

test("risk veto downgrades an otherwise-actionable bullish setup", () => {
  const r = evaluateHorizonAgent(cfgCall, { ticker: "spy", session: "regular", nowMs: NOW, selection: okSelection(), freshness: freshOk, riskVerdict: { allowed: false, failures: ["max open positions"], vetoed: false } });
  assert.equal(r.actionability, "BLOCKED");
  assert.equal(r.candidateStatus, "WATCH");
});

test("model probability only attaches to bullish active models, never bearish", () => {
  const model = { status: "ACTIVE_VALIDATED", modelVersion: 3, probability: 0.62, calibration: "ok" };
  const bull = evaluateHorizonAgent(cfgCall, { ticker: "spy", session: "regular", nowMs: NOW, selection: okSelection(), freshness: freshOk, model, riskVerdict: { allowed: true, failures: [], vetoed: false } });
  assert.equal(bull.probability, 0.62);
  const bear = evaluateHorizonAgent(cfgPut, { ticker: "spy", session: "regular", nowMs: NOW, selection: okSelection({ actionable: false }), freshness: freshOk, model });
  assert.equal(bear.probability, null);
});

test("inactive model ⇒ no probability", () => {
  const r = evaluateHorizonAgent(cfgCall, { ticker: "spy", session: "regular", nowMs: NOW, selection: okSelection(), freshness: freshOk, model: { status: "INACTIVE_NO_TRAINABLE_DATA", modelVersion: null, probability: null, calibration: null }, riskVerdict: { allowed: true, failures: [], vetoed: false } });
  assert.equal(r.probability, null);
});

// ── Supervisor ───────────────────────────────────────────────────────────────

function res(over = {}) {
  return evaluateHorizonAgent(cfgCall, { ticker: over.ticker ?? "spy", session: "regular", nowMs: NOW, selection: over.selection ?? okSelection(), freshness: freshOk, riskVerdict: over.risk ?? { allowed: true, failures: [], vetoed: false } });
}

test("supervisor dedups to one canonical result per ticker+direction+horizon", () => {
  const a = res();
  const b = res(); // same key, duplicate
  const out = superviseResults({ results: [a, b], nowMs: NOW });
  assert.equal(out.canonical.length, 1);
  assert.equal(out.all.length, 2); // all preserved for audit
});

test("supervisor never makes a blocked setup actionable when agents agree", () => {
  const blocked = res({ risk: { allowed: false, failures: ["kill switch"], vetoed: false } });
  const out = superviseResults({ results: [blocked, blocked], nowMs: NOW });
  assert.equal(out.canonical[0].actionability, "BLOCKED");
});

test("supervisor enforces risk veto even if the agent didn't", () => {
  const leaked = { ...res(), actionability: "ACTIONABLE", candidateStatus: "ACTIONABLE_NOW", riskVerdict: { allowed: false, failures: ["exposure"], vetoed: false } };
  const out = superviseResults({ results: [leaked], nowMs: NOW });
  assert.equal(out.canonical[0].actionability, "BLOCKED");
  assert.equal(out.canonical[0].riskVerdict.vetoed, true);
});

test("hysteresis holds a brief downgrade from a more-advanced prior status", () => {
  const prior = new Map([[resultKey(res()), { candidateStatus: "ACTIONABLE_NOW", since: NOW - 1000 }]]);
  const downgraded = res({ selection: okSelection({ actionable: false, researchOnly: true }) });
  const out = superviseResults({ results: [downgraded], previous: prior, nowMs: NOW, hysteresisMs: 90_000 });
  assert.equal(out.canonical[0].candidateStatus, "ACTIONABLE_NOW"); // held
});

test("hysteresis never holds a hard-gate (stale) status", () => {
  const prior = new Map([[resultKey(res()), { candidateStatus: "ACTIONABLE_NOW", since: NOW - 1000 }]]);
  const stale = evaluateHorizonAgent(cfgCall, { ticker: "spy", session: "regular", nowMs: NOW, selection: okSelection(), freshness: { ok: false, reason: "stale" } });
  const out = superviseResults({ results: [stale], previous: prior, nowMs: NOW });
  assert.equal(out.canonical[0].candidateStatus, "DATA_STALE"); // safety first
});

test("nextPriorState resets `since` only on status change", () => {
  const r = res();
  const p1 = nextPriorState([r], undefined, NOW);
  const p2 = nextPriorState([r], p1, NOW + 5000);
  assert.equal(p2.get(resultKey(r)).since, NOW); // unchanged status keeps since
});
