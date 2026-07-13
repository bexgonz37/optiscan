import test from "node:test";
import assert from "node:assert/strict";
import { buildCallout, containsBannedLanguage, BANNED_PHRASES } from "../lib/callouts/callout.ts";
import { decideEmission, isMeaningfulTransition, calloutIdempotencyKey, nextCalloutState, EMITTABLE } from "../lib/callouts/dedup.ts";
import { formatCalloutDiscord } from "../lib/callouts/discord-format.ts";

const NOW = Date.parse("2026-07-09T15:00:00Z");

function ar(over = {}) {
  return {
    agentId: "call_0DTE", agentVersion: 1, strategy: "zero_dte_momentum", strategyVersion: 1,
    ticker: "SPY", direction: "bullish", horizon: "0DTE", dteRange: [0, 1],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 78,
    verifiedInputs: {}, requiredConditions: ["hold VWAP"], selectorProfile: "zero_dte_momentum",
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

test("bullish actionable callout is actionable and free of banned language", () => {
  const c = buildCallout(ar());
  assert.equal(c.actionable, true);
  assert.equal(c.status, "ACTIONABLE_NOW");
  assert.ok(!containsBannedLanguage(JSON.stringify(c)));
});

test("put callout is always research-only, never actionable", () => {
  const c = buildCallout(ar({ direction: "bearish", candidateStatus: "RESEARCH_ONLY", actionability: "RESEARCH_ONLY", researchOnly: true, selectedContract: { ...ar().selectedContract, side: "put" } }));
  assert.equal(c.actionable, false);
  assert.ok(c.researchOnlyWarning);
  assert.match(c.researchOnlyWarning, /RESEARCH ONLY/);
});

test("insufficient-evidence warning present until established", () => {
  assert.ok(buildCallout(ar()).insufficientEvidenceWarning);
  const est = buildCallout(ar({ evidenceStatus: "ESTABLISHED_EVIDENCE", statisticsSnapshot: { evidenceStatus: "ESTABLISHED_EVIDENCE", evidenceSummary: "", gradedSampleSize: 120 } }));
  assert.equal(est.insufficientEvidenceWarning, null);
});

test("expectancy/profit factor only surface for an established sample", () => {
  const notEst = buildCallout(ar(), { expectancy: 12, profitFactor: 1.8 });
  assert.equal(notEst.expectancy, null);
  assert.equal(notEst.profitFactor, null);
  const est = buildCallout(ar({ evidenceStatus: "ESTABLISHED_EVIDENCE" }), { expectancy: 12, profitFactor: 1.8 });
  assert.equal(est.expectancy, 12);
  assert.equal(est.profitFactor, 1.8);
});

test("BANNED_PHRASES are detected", () => {
  assert.equal(containsBannedLanguage("this is a guaranteed winner"), true);
  assert.equal(containsBannedLanguage("clean momentum setup"), false);
  assert.ok(BANNED_PHRASES.includes("easy money"));
});

// ── Dedup / transitions ──────────────────────────────────────────────────────

test("first emittable observation ⇒ emit new", () => {
  const c = buildCallout(ar());
  const d = decideEmission(c, undefined, { nowMs: NOW });
  assert.equal(d.emit, true);
  assert.equal(d.kind, "new");
});

test("unchanged status ⇒ suppress (no minor-oscillation spam)", () => {
  const c = buildCallout(ar());
  const d = decideEmission(c, { status: "ACTIONABLE_NOW", lastEmitMs: NOW - 1000 }, { nowMs: NOW });
  assert.equal(d.emit, false);
  assert.equal(d.kind, "suppress");
});

test("material transition ⇒ emit update", () => {
  const c = buildCallout(ar({ candidateStatus: "ACTIONABLE_NOW" }));
  const d = decideEmission(c, { status: "NEAR_TRIGGER", lastEmitMs: NOW - 60000 }, { nowMs: NOW });
  assert.equal(d.emit, true);
  assert.equal(d.kind, "update");
});

test("non-emittable status ⇒ suppress (desktop shows it, Discord does not)", () => {
  const c = buildCallout(ar({ candidateStatus: "DATA_STALE", actionability: "BLOCKED", freshness: { ok: false, reason: "stale" } }));
  const d = decideEmission(c, undefined, { nowMs: NOW });
  assert.equal(d.emit, false);
});

test("idempotency key is stable per (opportunity, status)", () => {
  const c = buildCallout(ar());
  assert.equal(calloutIdempotencyKey(c), "callout:SPY|bullish|0DTE:ACTIONABLE_NOW");
  const c2 = buildCallout(ar({ candidateStatus: "EXTENDED" }));
  assert.notEqual(calloutIdempotencyKey(c), calloutIdempotencyKey(c2));
});

test("meaningful transition table", () => {
  assert.equal(isMeaningfulTransition("NEAR_TRIGGER", "ACTIONABLE_NOW"), true);
  assert.equal(isMeaningfulTransition("ACTIONABLE_NOW", "INVALIDATED"), true);
  assert.equal(isMeaningfulTransition("ACTIONABLE_NOW", "ACTIONABLE_NOW"), false);
  assert.ok(EMITTABLE.has("RESEARCH_ONLY"));
});

test("nextCalloutState records emission times deterministically", () => {
  const c = buildCallout(ar());
  const d = decideEmission(c, undefined, { nowMs: NOW });
  const state = nextCalloutState([c], [d], undefined, NOW);
  assert.equal(state.get(c.key).status, "ACTIONABLE_NOW");
  assert.equal(state.get(c.key).lastEmitMs, NOW);
});

// ── Discord formatting ───────────────────────────────────────────────────────

test("discord payload has ordered sections and no banned language", () => {
  const p = formatCalloutDiscord(buildCallout(ar()));
  const names = p.embed.fields.map((f) => f.name);
  assert.deepEqual(names.slice(0, 6), ["Why now", "Trigger", "Contract", "Risk / invalidation", "Evidence", "Model"]);
  assert.ok(!containsBannedLanguage(JSON.stringify(p)));
  assert.match(p.embed.description, /outcomes are uncertain/);
});

test("discord hides probability when the model is inactive", () => {
  const p = formatCalloutDiscord(buildCallout(ar()));
  const model = p.embed.fields.find((f) => f.name === "Model");
  assert.match(model.value, /no probability shown/);
});

test("discord put callout is labeled research", () => {
  const p = formatCalloutDiscord(buildCallout(ar({ direction: "bearish", candidateStatus: "RESEARCH_ONLY", researchOnly: true, actionability: "RESEARCH_ONLY", selectedContract: { ...ar().selectedContract, side: "put" } })));
  assert.match(p.embed.title, /PUT \(research\)/);
  assert.match(p.embed.description, /RESEARCH ONLY/);
});
