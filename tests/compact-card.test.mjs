import test from "node:test";
import assert from "node:assert/strict";
import { buildCallout, containsBannedLanguage } from "../lib/callouts/callout.ts";
import { formatCalloutDiscord } from "../lib/callouts/discord-format.ts";
import { compactCard, confidenceTier, estimatedEntryPrice, entryStatusLabel } from "../lib/callouts/confidence.ts";
import { selectForDiscord } from "../lib/agents/portfolio.ts";
import { ownerSettings } from "../lib/owner-settings.ts";

const NOW = Date.parse("2026-07-13T14:42:00Z");

/** AgentResult factory: a fresh, actionable NVDA call with a known spot + quote. */
function ar(over = {}, spot = 182.4) {
  return {
    agentId: "call_1_5", agentVersion: 1, strategy: "swing_momentum", strategyVersion: 1,
    ticker: "NVDA", direction: "bullish", horizon: "1-5", dteRange: [1, 5],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 78,
    verifiedInputs: { spot }, requiredConditions: ["hold VWAP"], selectorProfile: "swing_momentum",
    selectedContract: { optionSymbol: "O:NVDA_C185", strike: 185, expiration: "2026-07-17", dte: 4, side: "call", bid: 2.10, ask: 2.18, mid: 2.14, spreadPct: 3, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    passedGates: ["spread"], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["fresh momentum, holding VWAP"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: NOW,
    ...over,
  };
}

// ── exact contract fields on the compact card ────────────────────────────────
test("compact card shows exact strike, expiration, DTE, underlying, bid/ask/mid", () => {
  const card = compactCard(buildCallout(ar()));
  assert.match(card.contract, /NVDA \$185 Call/);    // exact strike
  assert.equal(card.expiration, "Jul 17");            // exact expiration
  assert.equal(card.dte, "4");                        // exact DTE
  assert.equal(card.stock, "$182.40");                // underlying at alert time
  assert.equal(card.optionQuote, "$2.10 bid / $2.18 ask");
  assert.equal(card.optionMid, "$2.14");              // midpoint
});

test("underlying price flows onto the callout from the verified spot", () => {
  assert.equal(buildCallout(ar()).underlyingPrice, 182.4);
  assert.equal(buildCallout(ar({}, null)).underlyingPrice, null); // never fabricated
});

// ── estimated entry uses verified quote data (paper-fill model) ──────────────
test("estimated entry = ask + bounded slippage from the verified quote", () => {
  // ask 2.18 + min((2.18-2.10)*0.25=0.02, cap 0.05) = 2.20
  const c = buildCallout(ar());
  assert.equal(c.estimatedEntry, 2.20);
  assert.equal(compactCard(c).estimatedEntry, "$2.20");
});

test("estimated entry is NEVER an old price when there is no valid entry now", () => {
  // A waiting setup keeps a fresh quote but must not present a tradable entry.
  const c = buildCallout(ar({ candidateStatus: "WAIT_FOR_PULLBACK", actionability: "WATCH" }));
  assert.equal(entryStatusLabel(c), "WAIT FOR PULLBACK");
  assert.equal(compactCard(c).estimatedEntry, "NO VALID ENTRY YET");
});

// ── missing / stale quote → NO VALID ENTRY, no fabricated price ──────────────
test("missing quote produces NO VALID ENTRY and no fabricated price", () => {
  const c = buildCallout(ar({ candidateStatus: "NO_VALID_CONTRACT", actionability: "BLOCKED", researchOnly: true, selectedContract: null }));
  const card = compactCard(c);
  assert.equal(card.status, "NO VALID ENTRY");
  assert.equal(card.estimatedEntry, "NO VALID ENTRY YET");
  assert.equal(estimatedEntryPrice(c), null);
  assert.ok(!/\$NaN|\$undefined/.test(JSON.stringify(card)), "no fabricated price rendered");
});

test("stale quote produces NO VALID ENTRY (no entry off a stale price)", () => {
  const c = buildCallout(ar({ candidateStatus: "DATA_STALE", actionability: "BLOCKED", freshness: { ok: false, reason: "quote 45s old" } }));
  assert.equal(estimatedEntryPrice(c), null);
  assert.equal(compactCard(c).estimatedEntry, "NO VALID ENTRY YET");
});

// ── confidence tiers ─────────────────────────────────────────────────────────
test("a fully-verified, in-window actionable setup is HIGH confidence", () => {
  assert.equal(confidenceTier(buildCallout(ar())), "HIGH");
});

test("a wide-spread or stale setup is not HIGH", () => {
  assert.notEqual(confidenceTier(buildCallout(ar({ selectedContract: { ...ar().selectedContract, spreadPct: 40 } }))), "HIGH");
  assert.equal(confidenceTier(buildCallout(ar({ candidateStatus: "DATA_STALE", actionability: "BLOCKED", freshness: { ok: false, reason: "stale" } }))), "LOW");
});

// ── Discord delivery gate: only HIGH actionable send ─────────────────────────
test("only HIGH-confidence actionable setups reach Discord; medium/low stay dashboard-only", () => {
  const S = ownerSettings({});
  const high = buildCallout(ar());
  assert.equal(confidenceTier(high), "HIGH");
  assert.equal(selectForDiscord([high], S).eligibleKeys.size, 1, "HIGH sends");

  const medium = buildCallout(ar({ candidateStatus: "WAIT_FOR_PULLBACK", actionability: "WATCH" }));
  assert.notEqual(confidenceTier(medium), "HIGH");
  const sel = selectForDiscord([medium], S);
  assert.equal(sel.eligibleKeys.size, 0, "non-HIGH stays in the dashboard");
  assert.ok(sel.suppressed.some((x) => /not HIGH confidence/.test(x.reason)));
});

// ── model-inactive setup score is not a probability ──────────────────────────
test("model-inactive setup score is labeled NOT a probability", () => {
  const card = compactCard(buildCallout(ar()));
  assert.equal(card.setupScoreLine, "SETUP SCORE — NOT A WIN PROBABILITY: 78");
  const p = formatCalloutDiscord(buildCallout(ar()));
  assert.ok(!/p\(win\)/.test(p.embed.description), "no probability shown when model inactive");
});

// ── advanced hidden by default ───────────────────────────────────────────────
test("advanced technical detail is hidden by default and appears only when enabled", () => {
  const c = buildCallout(ar());
  const def = formatCalloutDiscord(c);
  assert.equal(def.embed.fields.length, 0);
  assert.ok(!/O:NVDA_C185/.test(JSON.stringify(def)), "OCC symbol hidden by default");
  const adv = formatCalloutDiscord(c, { DISCORD_ADVANCED_DETAILS: "1" });
  assert.ok(adv.embed.fields.length > 0);
  assert.ok(/O:NVDA_C185/.test(JSON.stringify(adv)), "OCC symbol available under Advanced");
});

test("compact card never contains banned/guarantee language", () => {
  const p = formatCalloutDiscord(buildCallout(ar()));
  assert.ok(!containsBannedLanguage(JSON.stringify(p)));
});
