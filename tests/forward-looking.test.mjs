import test from "node:test";
import assert from "node:assert/strict";
import { buildCallout } from "../lib/callouts/callout.ts";
import { EMITTABLE, decideEmission, isMeaningfulTransition } from "../lib/callouts/dedup.ts";
import { scoreCalloutQuality, selectForDiscord, reviewPortfolio } from "../lib/agents/portfolio.ts";
import { ownerSettings } from "../lib/owner-settings.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-07-09T15:00:00Z");

/** AgentResult factory with an entry-window verdict stashed in verifiedInputs. */
function ar(over = {}, ew = null) {
  return {
    agentId: "call_0DTE", agentVersion: 1, strategy: "zero_dte_momentum", strategyVersion: 1,
    ticker: "SPY", direction: "bullish", horizon: "0DTE", dteRange: [0, 1],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 78,
    verifiedInputs: ew ? { entryWindow: ew } : {}, requiredConditions: ["hold VWAP"], selectorProfile: "zero_dte_momentum",
    selectedContract: { optionSymbol: "O:SPY_C500", strike: 500, expiration: "2026-07-09", dte: 0, side: "call", bid: 1.1, ask: 1.2, mid: 1.15, spreadPct: 4, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    passedGates: ["spread"], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["fresh momentum, holding VWAP"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: { riskState: "RISK_ON" }, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: NOW,
    ...over,
  };
}
const ewMissed = { state: "MISSED", waitFor: "wait for pullback", validEntry: "only on pullback", doNotEnter: "do not chase", currently: "move already ran", alreadyHappened: "ran 1.8% from VWAP" };
const ewActionable = { state: "ACTIONABLE", waitFor: "enter now", validEntry: "valid now", doNotEnter: "loses VWAP", currently: "confirmed in zone", alreadyHappened: null };

// ── forward-looking fields flow to the callout ───────────────────────────────
test("callout carries forward-looking language from the entry window", () => {
  const c = buildCallout(ar({}, ewActionable));
  assert.equal(c.entryState, "ACTIONABLE");
  assert.equal(c.waitFor, "enter now");
  assert.equal(c.validEntry, "valid now");
  assert.equal(c.doNotEnter, "loses VWAP"); // from the entry window
  assert.equal(c.actionable, true);
});

// ── MISSED lifecycle (§6) ────────────────────────────────────────────────────
test("MISSED entry window is never actionable and never Discord-emittable", () => {
  const c = buildCallout(ar({ candidateStatus: "MISSED", actionability: "WATCH" }, ewMissed));
  assert.equal(c.actionable, false, "MISSED never actionable");
  assert.ok(!EMITTABLE.has("MISSED"), "MISSED is not a Discord-emittable state");
  const d = decideEmission({ ...c, status: "MISSED" }, undefined, { nowMs: NOW });
  assert.equal(d.emit, false, "a MISSED callout is not sent to Discord");
});

test("an extended/late ACTIONABLE contract is forced non-actionable at the callout", () => {
  // Even if the agent said ACTIONABLE, an EXTENDED entry window overrides it.
  const ewExtended = { ...ewMissed, state: "EXTENDED" };
  const c = buildCallout(ar({ candidateStatus: "ACTIONABLE_NOW", actionability: "ACTIONABLE" }, ewExtended));
  assert.equal(c.actionable, false, "late/extended entry can never be actionable");
});

// ── ranking: timing outranks retrospective strength (§10) ────────────────────
test("a lower-scoring EARLY VALID setup outranks a higher-scoring COMPLETED move", () => {
  const S = ownerSettings({});
  const earlyValid = buildCallout(ar({ ticker: "SPY", score: 70 }, ewActionable));
  const completed = buildCallout(ar({ ticker: "SPY", score: 95, candidateStatus: "EXTENDED", actionability: "WATCH" }, { ...ewMissed, state: "EXTENDED" }));
  assert.ok(scoreCalloutQuality(earlyValid, S) > scoreCalloutQuality(completed, S),
    "an early, valid entry must outrank a stronger-but-completed move");
});

test("extended / missed callouts are never selected for Discord", () => {
  const S = ownerSettings({});
  const extended = buildCallout(ar({ ticker: "F", candidateStatus: "EXTENDED", actionability: "WATCH" }, { ...ewMissed, state: "EXTENDED" }));
  const missed = buildCallout(ar({ ticker: "GM", candidateStatus: "MISSED", actionability: "WATCH" }, ewMissed));
  const sel = selectForDiscord([extended, missed], S);
  assert.equal(sel.eligibleKeys.size, 0, "no late setup reaches Discord");
});

// ── no oscillation back to actionable without a genuinely new setup ──────────
test("ranking + selection keep an extended move out until a NEW in-zone setup appears", () => {
  const S = ownerSettings({});
  // Same identity, still extended → not eligible.
  const stillExtended = buildCallout(ar({ candidateStatus: "EXTENDED", actionability: "WATCH" }, { ...ewMissed, state: "EXTENDED" }));
  assert.equal(selectForDiscord([stillExtended], S).eligibleKeys.size, 0);
  // Only when the entry window genuinely re-confirms (ACTIONABLE) does it qualify.
  const reconfirmed = buildCallout(ar({}, ewActionable));
  assert.equal(selectForDiscord([reconfirmed], S).eligibleKeys.size, 1);
});

// ── paper-trading alignment (§7) ─────────────────────────────────────────────
test("the callout runtime never creates paper trades (no late paper entries via callouts)", () => {
  const src = readFileSync(join(root, "lib/callouts/runtime.ts"), "utf8");
  assert.ok(!/createPaperTrade|INSERT INTO paper_trades|simulateFill/.test(src), "callout path must not open paper trades");
});

test("the paper engine keeps its pre-entry revalidation + freshness gate (unchanged)", () => {
  const src = readFileSync(join(root, "lib/paper-engine.ts"), "utf8");
  assert.match(src, /revalidat/i, "paper engine revalidates before entry");
});

// ── transitions ──────────────────────────────────────────────────────────────
test("MISSED→ACTIONABLE_NOW is a fresh emittable identity (genuine new setup), but MISSED itself never emits", () => {
  assert.equal(isMeaningfulTransition("MISSED", "ACTIONABLE_NOW"), true);
  assert.equal(EMITTABLE.has("MISSED"), false);
});
