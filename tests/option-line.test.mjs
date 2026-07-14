import test from "node:test";
import assert from "node:assert/strict";
import { buildCallout } from "../lib/callouts/callout.ts";
import {
  optionContractLine,
  optionAlertDeliverable,
  canonicalOptionContract,
  sameOptionContract,
  formatExpiryLabel,
  formatStrikeLabel,
  optionAlertPrice,
} from "../lib/callouts/option-line.ts";

const NOW = Date.parse("2026-07-14T14:42:00Z");

/** AgentResult factory: a fresh, actionable option with a known contract + quote. */
function ar(over = {}, contract = {}) {
  return {
    agentId: "call_1_5", agentVersion: 1, strategy: "swing_momentum", strategyVersion: 1,
    ticker: "NVDA", direction: "bullish", horizon: "1-5", dteRange: [1, 5],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 78,
    verifiedInputs: { spot: 182.4, entryWindow: { state: "ACTIONABLE", waitFor: "enter now", validEntry: "valid now", doNotEnter: "loses VWAP", currently: "confirmed", alreadyHappened: null } },
    requiredConditions: ["hold VWAP"], selectorProfile: "swing_momentum",
    selectedContract: { optionSymbol: "O:NVDA260717C00180000", strike: 180, expiration: "2026-07-18", dte: 4, side: "call", bid: 3.20, ask: 3.30, mid: 3.25, spreadPct: 3, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5, ...contract },
    passedGates: ["spread"], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["fresh momentum"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: NOW,
    ...over,
  };
}

// ── the exact single-line format ─────────────────────────────────────────────
test("valid CALL contract renders the exact single line (midpoint price)", () => {
  const line = optionContractLine(buildCallout(ar()));
  assert.equal(line, "$NVDA 18 JUL 26 $180 CALL $3.25");
});

test("valid PUT contract renders CALL→PUT with its own strike/price", () => {
  const c = buildCallout(ar(
    { direction: "bearish" },
    { optionSymbol: "O:SPY260717P00625000", strike: 625, expiration: "2026-07-17", side: "put", bid: 2.10, ask: 2.18, mid: 2.14 },
  ));
  // ticker still NVDA in the factory; override to SPY for realism via canonical.
  const line = optionContractLine({ ...c, ticker: "SPY" });
  assert.equal(line, "$SPY 17 JUL 26 $625 PUT $2.14");
});

test("mobile-friendly: exactly one line, no embed text, matches the desk format", () => {
  const line = optionContractLine(buildCallout(ar()));
  assert.ok(!line.includes("\n"), "single line");
  assert.match(line, /^\$[A-Z]+ \d{2} [A-Z]{3} \d{2} \$[0-9.]+ (CALL|PUT) \$[0-9]+\.[0-9]{2}$/);
});

// ── formatting helpers ───────────────────────────────────────────────────────
test("expiration formats as DD MON YY; malformed → null (never fabricated)", () => {
  assert.equal(formatExpiryLabel("2026-07-17"), "17 JUL 26");
  assert.equal(formatExpiryLabel("2026-07-07"), "07 JUL 26");
  assert.equal(formatExpiryLabel("2026-12-31"), "31 DEC 26");
  assert.equal(formatExpiryLabel("not-a-date"), null);
  assert.equal(formatExpiryLabel(null), null);
  assert.equal(formatExpiryLabel("2026-13-01"), null);
});

test("strike shows minimal decimals ($322.5, $180); non-finite → null", () => {
  assert.equal(formatStrikeLabel(322.5), "322.5");
  assert.equal(formatStrikeLabel(180), "180");
  assert.equal(formatStrikeLabel(180.0), "180");
  assert.equal(formatStrikeLabel(null), null);
});

// ── pricing policy: mid preferred, else ask, else nothing ────────────────────
test("price prefers midpoint; falls back to ask; never invents a price", () => {
  assert.deepEqual(optionAlertPrice({ mid: 3.25, ask: 3.30 }), { price: 3.25, source: "mid" });
  assert.deepEqual(optionAlertPrice({ mid: null, ask: 3.30 }), { price: 3.30, source: "ask" });
  assert.equal(optionAlertPrice({ mid: null, ask: null }), null);
  assert.equal(optionAlertPrice({ mid: 0, ask: 0 }), null);
  assert.equal(optionAlertPrice(null), null);
});

test("no midpoint but a valid ask → line uses the ask", () => {
  const line = optionContractLine(buildCallout(ar({}, { mid: null, ask: 3.30 })));
  assert.equal(line, "$NVDA 18 JUL 26 $180 CALL $3.30");
});

// ── block (never a generic alert) when the contract can't be verified ────────
test("missing contract identifier (OCC symbol) → blocked, no line", () => {
  const d = optionAlertDeliverable(buildCallout(ar({}, { optionSymbol: null })));
  assert.equal(d.ok, false);
  assert.equal(d.line, null);
  assert.match(d.reason, /OCC|contract symbol/i);
  assert.equal(optionContractLine(buildCallout(ar({}, { optionSymbol: null }))), null);
});

test("missing bid AND ask → blocked (no usable price, no fabricated price)", () => {
  const d = optionAlertDeliverable(buildCallout(ar({}, { mid: null, bid: null, ask: null })));
  assert.equal(d.ok, false);
  assert.match(d.reason, /price/i);
});

test("missing strike or expiration → blocked", () => {
  assert.equal(optionAlertDeliverable(buildCallout(ar({}, { strike: null }))).ok, false);
  assert.equal(optionAlertDeliverable(buildCallout(ar({}, { expiration: null }))).ok, false);
});

test("no selected contract at all → blocked with a clear reason", () => {
  const d = optionAlertDeliverable(buildCallout(ar({ candidateStatus: "NO_VALID_CONTRACT", actionability: "WATCH", selectedContract: null })));
  assert.equal(d.ok, false);
  assert.match(d.reason, /no selected contract/i);
});

// ── same contract for Discord and paper trading ──────────────────────────────
test("the canonical contract equals the contract object the paper bridge trades", () => {
  const c = buildCallout(ar());
  const canon = canonicalOptionContract(c);
  // Same OCC identity / strike / expiration / side the paper bridge reads off c.contract.
  assert.equal(canon.optionSymbol, c.contract.optionSymbol);
  assert.equal(canon.strike, c.contract.strike);
  assert.equal(canon.expiration, c.contract.expiration);
  assert.equal(canon.side, c.contract.side);
  assert.equal(sameOptionContract(canon, c.contract), true);
});

test("sameOptionContract rejects a mismatched contract (would be Discord A / paper B)", () => {
  const c = buildCallout(ar());
  const canon = canonicalOptionContract(c);
  assert.equal(sameOptionContract(canon, { ...c.contract, optionSymbol: "O:OTHER_C1" }), false);
  assert.equal(sameOptionContract(canon, { ...c.contract, strike: 999 }), false);
  assert.equal(sameOptionContract(canon, null), false);
  assert.equal(sameOptionContract(null, c.contract), false);
});

// ── side falls back to direction exactly like the paper bridge ───────────────
test("null contract side falls back to direction (matches paper-bridge)", () => {
  const call = canonicalOptionContract(buildCallout(ar({ direction: "bullish" }, { side: null })));
  assert.equal(call.side, "call");
  const put = canonicalOptionContract(buildCallout(ar({ direction: "bearish" }, { side: null })));
  assert.equal(put.side, "put");
});
