/**
 * tests/high-asymmetry-alert-copy.test.mjs
 *
 * Owner-private High-Asymmetry alert copy.
 *
 * The complaint was fair: the old message led with `O:AAPL260803P00300000` and
 * read like debug output. A trader needs symbol, expiry, strike, side and entry
 * — the OCC is a machine key and belongs in a footer.
 *
 * These tests hold the line on the two things that could quietly go wrong while
 * making it prettier: never inventing an entry price, and never implying a
 * paper trade that did not happen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseOccSymbol, contractDisplay, entryDisplay, formatStrike, contractFooter,
} from "../lib/research/asymmetry/contract-format.ts";
import { buildPrivateMessage, riskLine, PRIVATE_NOTIFIABLE_STATES } from "../lib/research/asymmetry/private-notify.ts";

const PUT_OCC = "O:AAPL260803P00300000";
const CALL_OCC = "O:NVDA260807C00200000";
const T0 = Date.parse("2026-07-31T14:00:00.000Z");

const candidate = (over = {}) => ({
  fingerprint: "fp", sessionDate: "2026-07-31", symbol: "AAPL", direction: "PUT",
  optionSymbol: PUT_OCC, state: "HIGH_ASYMMETRY", observedAtMs: T0,
  whyEarly: "Detected before any sourced structural confirmation.",
  premiumChasePct: 4.2, bid: 3.4, ask: 3.5, spreadPct: 2.9,
  openInterest: 4200, contractVolume: 900, trigger: "Loses 299.50 on the 5-minute close",
  invalidation: "Reclaims 302.00", missingEvidence: [], setupFamilyLabel: null,
  underlyingPrice: 301.12, paperStatus: "WAITING_FOR_ENTRY", ...over,
});

// ── Contract formatting ─────────────────────────────────────────────────────

test("an OCC becomes the way a trader says it", () => {
  const p = parseOccSymbol(PUT_OCC);
  assert.equal(p.underlying, "AAPL");
  assert.equal(p.expirationShort, "08/03");
  assert.equal(p.expirationIso, "2026-08-03");
  assert.equal(p.strike, 300);
  assert.equal(p.side, "Put");
  assert.equal(p.display, "AAPL 08/03 $300 Put");
});

test("calls format the same way", () => {
  assert.equal(parseOccSymbol(CALL_OCC).display, "NVDA 08/07 $200 Call");
});

test("fractional strikes keep their cents, whole strikes do not gain them", () => {
  assert.equal(formatStrike(300), "$300");
  assert.equal(formatStrike(302.5), "$302.5");
  assert.equal(parseOccSymbol("O:AAPL260803P00302500").display, "AAPL 08/03 $302.5 Put");
});

test("a malformed OCC returns null rather than a half-parsed contract", () => {
  for (const bad of ["", null, undefined, "AAPL", "O:AAPL", "O:AAPL2608XXP00300000", "O:AAPL261303P00300000"]) {
    assert.equal(parseOccSymbol(bad), null, `${String(bad)} must not parse`);
  }
  // A wrong strike in an alert is worse than an unreadable one.
  assert.equal(contractDisplay("O:BAD"), "O:BAD");
  assert.equal(contractDisplay(null, "AAPL"), "AAPL (contract unavailable)");
});

// ── Entry formatting ────────────────────────────────────────────────────────

test("ENTRY IS NEVER INVENTED", () => {
  assert.equal(entryDisplay(3.4, 3.5), "$3.40–$3.50", "a real two-sided quote gives a range");
  assert.equal(entryDisplay(null, 3.5), "$3.50", "one known ask prints one price, not a fake range");
  assert.equal(entryDisplay(0, 3.5), "$3.50", "a zero bid is not a range boundary");
  assert.equal(entryDisplay(3.6, 3.5), "$3.50", "a crossed quote does not print backwards");
  assert.equal(entryDisplay(3.4, null), "awaiting valid quote", "no ask means no entry, stated plainly");
  assert.equal(entryDisplay(null, null), "awaiting valid quote");
});

test("a missing quote says so in the message instead of printing a number", () => {
  const msg = buildPrivateMessage(candidate({ bid: null, ask: null }));
  assert.match(msg, /Entry: awaiting valid quote/);
  assert.equal(/Entry: \$0/.test(msg), false, "an unknown entry must never render as $0");
});

// ── Message body ────────────────────────────────────────────────────────────

test("the PUT message leads with the human contract, not the OCC", () => {
  const msg = buildPrivateMessage(candidate());
  const body = msg.split("Research only")[0];
  assert.match(msg, /\*\*HIGH ASYMMETRY — PUT\*\*/);
  assert.match(body, /AAPL 08\/03 \$300 Put/);
  assert.match(body, /Entry: \$3\.40–\$3\.50/);
  assert.match(body, /Underlying: \$301\.12/);
  assert.match(body, /State: HIGH_ASYMMETRY/);
  assert.equal(body.includes(PUT_OCC), false, "the raw OCC must not appear in the body");
});

test("the raw OCC survives, in the footer only", () => {
  const msg = buildPrivateMessage(candidate());
  assert.ok(msg.includes(PUT_OCC), "the OCC must still be available to verify a mark");
  assert.match(msg, new RegExp(`Research only[^\\n]*\`${PUT_OCC}\``), "and only after the disclaimer");
  assert.equal(contractFooter(PUT_OCC), `\`${PUT_OCC}\``);
});

test("a CALL renders correctly end to end", () => {
  const msg = buildPrivateMessage(candidate({
    symbol: "NVDA", direction: "CALL", optionSymbol: CALL_OCC, underlyingPrice: 198.4,
  }));
  assert.match(msg, /\*\*HIGH ASYMMETRY — CALL\*\*/);
  assert.match(msg, /NVDA 08\/07 \$200 Call/);
});

test("the message stays short and structured", () => {
  const msg = buildPrivateMessage(candidate());
  assert.ok(msg.length < 900, `message should stay concise, got ${msg.length}`);
  for (const section of ["Why:", "Confirmation:", "Invalidation:", "Risk:", "Paper:"]) {
    assert.ok(msg.includes(section), `${section} must be present`);
  }
  const whyBullets = msg.split("Why:")[1].split("Confirmation:")[0].trim().split("\n").filter(Boolean);
  assert.ok(whyBullets.length <= 3, `at most three Why bullets, got ${whyBullets.length}`);
});

test("missing underlying, trigger and invalidation degrade honestly", () => {
  const msg = buildPrivateMessage(candidate({ underlyingPrice: null, trigger: null, invalidation: null }));
  assert.match(msg, /Underlying: unavailable/);
  assert.match(msg, /no published trigger level recorded/);
  assert.match(msg, /no invalidation level recorded/);
  assert.equal(/Underlying: \$/.test(msg), false, "an absent price must not be fabricated");
});

// ── Risk line ───────────────────────────────────────────────────────────────

test("the risk line reports the WORST measured problem first", () => {
  assert.match(riskLine(candidate({ spreadPct: 34 })), /Wide spread 34\.0%/);
  assert.match(riskLine(candidate({ spreadPct: 3, premiumChasePct: 41 })), /Premium chase \+41\.0%/);
  assert.match(riskLine(candidate({ spreadPct: 3, premiumChasePct: 2, openInterest: 12 })), /Thin open interest \(12\)/);
  assert.match(riskLine(candidate({ spreadPct: 3, premiumChasePct: 2, openInterest: 900, contractVolume: 4 })), /Low contract volume \(4\)/);
  assert.match(riskLine(candidate({ spreadPct: 3, premiumChasePct: 2, missingEvidence: ["openInterest", "vwap"] })), /Incomplete evidence: openInterest, vwap/);
});

test("the risk line never claims a condition it did not measure", () => {
  const r = riskLine(candidate({ spreadPct: null, premiumChasePct: null, openInterest: null, contractVolume: null, missingEvidence: [] }));
  assert.match(r, /not fully verified/);
  assert.equal(/spread \d/.test(r), false, "an unmeasured spread must not be described");
});

// ── Paper status ────────────────────────────────────────────────────────────

test("PAPER STATUS NEVER IMPLIES A TRADE THAT DID NOT OPEN", () => {
  for (const status of ["OPENED", "WAITING_FOR_ENTRY", "BLOCKED", "DISABLED"]) {
    assert.match(buildPrivateMessage(candidate({ paperStatus: status })), new RegExp(`Paper: ${status}`));
  }
  // An unset status is the most conservative value, not the most flattering.
  assert.match(buildPrivateMessage(candidate({ paperStatus: undefined })), /Paper: DISABLED/);
  assert.equal(/Paper: OPENED/.test(buildPrivateMessage(candidate({ paperStatus: null }))), false);
});

test("the runner reports paper status from the real permission, not a guess", () => {
  const src = readFileSync("lib/research/asymmetry/transition-runner.ts", "utf8");
  assert.match(src, /resolvePaperPermission/);
  assert.match(src, /paperEntriesAllowed \? "WAITING_FOR_ENTRY"/);
  assert.match(src, /masterPaperAuthorized[\s\S]{0,80}"DISABLED"/);
});

// ── Routing safety, unchanged by this phase ─────────────────────────────────

test("subscriber routing remains impossible", () => {
  const src = readFileSync("lib/research/asymmetry/private-notify.ts", "utf8");
  // The subscriber webhooks are named ONLY to be refused.
  assert.match(src, /FORBIDDEN_WEBHOOK_ENV/);
  assert.match(src, /REFUSED_SUBSCRIBER_WEBHOOK/);
  assert.equal(/postToDiscord|sendTrackedDiscord|notifyNewAlert/.test(src), false);
  // And no eligibility rule was touched while reformatting.
  // Pinned to what production actually surfaces today. This phase reformats
  // copy only; changing which states notify is explicitly out of scope.
  assert.deepEqual(
    [...PRIVATE_NOTIFIABLE_STATES].sort(),
    ["CONFIRMING", "EARLY_ASYMMETRY", "HIGH_ASYMMETRY", "TRIGGERED"],
  );
});

test("the copy never promises profit", () => {
  const msg = buildPrivateMessage(candidate());
  assert.match(msg, /Research only\. Options are high risk\./);
  assert.equal(/guarantee|profit|will make|can't lose|sure thing/i.test(msg), false);
});
