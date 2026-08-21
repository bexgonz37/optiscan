/**
 * options-optionability.test.mjs — the tri-state optionability contract.
 *
 * The asymmetry under test: marking a symbol NOT_OPTIONABLE by mistake makes it
 * invisible forever and nothing downstream can recover it, while leaving one
 * UNKNOWN costs a single chain request. So every rule here is built to fail
 * toward "keep looking".
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyZeroContract, applyOptionabilityObservation, shouldSpendChainRequest,
  unknownRecord, expireIfStale, summarizeZeroContractCauses,
  DEFAULT_OPTIONABILITY, optionabilityConfig,
} from "../lib/research/options/optionability.ts";

const NOW = 4_000_000_000;
const DAY = 86_400_000;

/** A chain outcome shell; overrides shape the case under test. */
const out = (over = {}) => ({
  contracts: [], outcome: "NO_CONTRACTS_IN_REQUESTED_RANGE", truncated: false,
  requestedDteMin: 0, requestedDteMax: 60, pagesRequested: 1, pagesReceived: 1, ...over,
});

const observe = (rec, classification, { contractsSeen = 0, sessionDay = "2026-08-21", nowMs = NOW } = {}) =>
  applyOptionabilityObservation(rec, { classification, contractsSeen, sessionDay, nowMs }, DEFAULT_OPTIONABILITY);

/* ── 11. UNKNOWN remains eligible ──────────────────────────────────────────*/

test("11. UNKNOWN optionability remains eligible — not knowing is a reason to look, not to be blind", () => {
  assert.equal(shouldSpendChainRequest(undefined, NOW).spend, true, "no record at all still spends");
  assert.equal(shouldSpendChainRequest(unknownRecord("COIN"), NOW).spend, true);
  const rec = unknownRecord("COIN");
  assert.equal(rec.state, "UNKNOWN");
  assert.equal(rec.source, "NONE");
  assert.equal(rec.lastVerifiedAtMs, null);
});

/* ── 12. proven NOT_OPTIONABLE avoids spend ────────────────────────────────*/

test("12. a proven NOT_OPTIONABLE avoids the chain request", () => {
  // Authoritative reference evidence is the one single-shot negative.
  const cls = classifyZeroContract(out(), { referenceKnownOptionable: false });
  assert.equal(cls.cause, "NOT_OPTIONABLE");
  assert.equal(cls.countsAsEvidence, true);

  const rec = observe(unknownRecord("NOOPT"), cls);
  assert.equal(rec.state, "NOT_OPTIONABLE");
  assert.equal(rec.source, "CONTRACT_REFERENCE");
  assert.equal(rec.lastVerifiedAtMs, NOW);

  const decision = shouldSpendChainRequest(rec, NOW);
  assert.equal(decision.spend, false, "the request is not made");
  assert.match(decision.reason, /CONTRACT_REFERENCE/);
});

test("12b. corroboration across separate SESSIONS also proves it — repeats within one day do not", () => {
  const cls = classifyZeroContract(out({ requestedDteMin: 0, requestedDteMax: 60 }));
  assert.equal(cls.cause, "PROVIDER_EMPTY_RESPONSE");
  assert.equal(cls.countsAsEvidence, true, "a clean wide-window empty IS corroborating evidence");

  // 800 attempts inside one afternoon is one observation repeated.
  let rec = unknownRecord("QUIET");
  for (let i = 0; i < 800; i++) rec = observe(rec, cls, { sessionDay: "2026-08-20" });
  assert.equal(rec.state, "UNKNOWN", "repeating a measurement does not make it more true");
  assert.equal(rec.corroboratingEmptyDays.length, 1);
  assert.equal(shouldSpendChainRequest(rec, NOW).spend, true, "still eligible");

  // A genuinely different session is a genuinely different claim.
  rec = observe(rec, cls, { sessionDay: "2026-08-21" });
  assert.equal(rec.state, "NOT_OPTIONABLE");
  assert.equal(rec.source, "CORROBORATED_EMPTY");
  assert.equal(shouldSpendChainRequest(rec, NOW).spend, false);
});

/* ── 13. a transient empty chain cannot mark NOT_OPTIONABLE ────────────────*/

test("13. a transient empty chain can never permanently mark NOT_OPTIONABLE", () => {
  // A narrow DTE window returning nothing says nothing: a monthly-only name
  // asked for 0-7 DTE is empty by construction.
  const narrow = classifyZeroContract(out({ requestedDteMin: 0, requestedDteMax: 7 }));
  assert.equal(narrow.cause, "NO_CONTRACTS_IN_REQUESTED_DTE");
  assert.equal(narrow.countsAsEvidence, false);

  let rec = unknownRecord("MONTHLY");
  for (let d = 0; d < 50; d++) rec = observe(rec, narrow, { sessionDay: `2026-06-${d}` });
  assert.equal(rec.state, "UNKNOWN", "50 sessions of a too-narrow ask still prove nothing");
  assert.equal(rec.inconclusiveObservations, 50, "but they are recorded, not silently dropped");
  assert.equal(shouldSpendChainRequest(rec, NOW).spend, true);

  // Our own page budget running out is an artifact of the request.
  const truncated = classifyZeroContract(out({ outcome: "CHAIN_TRUNCATED_BEFORE_RANGE", truncated: true }));
  assert.equal(truncated.cause, "PROVIDER_INCOMPLETE");
  assert.equal(truncated.countsAsEvidence, false);
  assert.equal(observe(unknownRecord("T"), truncated).state, "UNKNOWN");

  // Pages requested but not received: same conclusion.
  const shortPages = classifyZeroContract(out({ pagesRequested: 3, pagesReceived: 1 }));
  assert.equal(shortPages.cause, "PROVIDER_INCOMPLETE");
  assert.equal(shortPages.countsAsEvidence, false);
});

test("13b. one real contract discards every empty answer that preceded it", () => {
  const cls = classifyZeroContract(out({ requestedDteMin: 0, requestedDteMax: 60 }));
  let rec = observe(unknownRecord("LATE"), cls, { sessionDay: "2026-08-19" });
  assert.equal(rec.corroboratingEmptyDays.length, 1);

  // Options got listed. The negative evidence is now disproven, not merely outweighed.
  rec = observe(rec, cls, { contractsSeen: 42, sessionDay: "2026-08-20" });
  assert.equal(rec.state, "OPTIONABLE");
  assert.equal(rec.source, "CHAIN_CONTRACTS_SEEN");
  assert.deepEqual(rec.corroboratingEmptyDays, [], "counter cleared, so noise cannot drift it back");

  // One later empty session must not immediately re-condemn it.
  rec = observe(rec, cls, { sessionDay: "2026-08-21" });
  assert.equal(rec.state, "OPTIONABLE");
});

/* ── 14. quota refusal cannot mark NOT_OPTIONABLE ──────────────────────────*/

test("14. a quota refusal can never mark NOT_OPTIONABLE — it is a fact about us, not the symbol", () => {
  for (const code of ["PROVIDER_QUOTA_EXCEEDED", "PROVIDER_TIMEOUT", "PROVIDER_FAILURE", "PROVIDER_CONFIGURATION_MISSING"]) {
    const cls = classifyZeroContract(out({ outcome: code }));
    assert.equal(cls.cause, "OTHER", `${code} classified as OTHER`);
    assert.equal(cls.countsAsEvidence, false, `${code} is never evidence`);

    let rec = unknownRecord("MRNA");
    for (let d = 0; d < 30; d++) rec = observe(rec, cls, { sessionDay: `2026-07-${d}` });
    assert.equal(rec.state, "UNKNOWN", `${code} x30 sessions still leaves MRNA eligible`);
    assert.equal(shouldSpendChainRequest(rec, NOW).spend, true);
  }
});

test("14b. an unparseable response is ambiguous, never conclusive", () => {
  const cls = classifyZeroContract(out({ outcome: "PROVIDER_INVALID_RESPONSE" }));
  assert.equal(cls.cause, "PROVIDER_EMPTY_RESPONSE");
  assert.equal(cls.countsAsEvidence, false, "a parse failure is not a market fact");
  assert.equal(observe(unknownRecord("X"), cls).state, "UNKNOWN");
});

/* ── reference-positive short-circuit ──────────────────────────────────────*/

test("a symbol the reference says HAS options is never condemned by an empty window", () => {
  const cls = classifyZeroContract(out({ requestedDteMin: 0, requestedDteMax: 60 }), { referenceKnownOptionable: true });
  assert.equal(cls.cause, "NO_CONTRACTS_IN_REQUESTED_DTE");
  assert.equal(cls.countsAsEvidence, false);
  assert.equal(cls.wasAvoidable, true, "and the spend was avoidable — we already knew the answer");

  let rec = unknownRecord("SPY");
  for (let d = 0; d < 20; d++) rec = observe(rec, cls, { sessionDay: `2026-08-${d}` });
  assert.equal(rec.state, "UNKNOWN");
});

/* ── TTL: a verdict is not forever ─────────────────────────────────────────*/

test("a NOT_OPTIONABLE verdict expires — options do get listed on names that lacked them", () => {
  const rec = observe(unknownRecord("NEWOPT"), classifyZeroContract(out(), { referenceKnownOptionable: false }));
  assert.equal(rec.state, "NOT_OPTIONABLE");

  assert.equal(shouldSpendChainRequest(rec, NOW + 10 * DAY).spend, false, "trusted inside the TTL");
  const after = shouldSpendChainRequest(rec, NOW + 40 * DAY);
  assert.equal(after.spend, true, "re-verified after it");
  assert.match(after.reason, /re-verifying/);

  assert.equal(expireIfStale(rec, NOW + 10 * DAY).state, "NOT_OPTIONABLE");
  const expired = expireIfStale(rec, NOW + 40 * DAY);
  assert.equal(expired.state, "UNKNOWN");
  assert.match(expired.reason, /expired/);
});

/* ── contracts present is not a zero-contract outcome at all ───────────────*/

test("an outcome carrying contracts is not classified as a zero-contract case", () => {
  const cls = classifyZeroContract(out({ contracts: [{ optionSymbol: "O:X" }], outcome: "CONTRACTS_AVAILABLE" }));
  assert.equal(cls.countsAsEvidence, false);
  assert.equal(cls.wasAvoidable, false);
});

/* ── measurement: which share of the 802 is eliminable ─────────────────────*/

test("zero-contract causes are summarised, so the eliminable share is measured rather than assumed", () => {
  const sample = [
    classifyZeroContract(out(), { referenceKnownOptionable: false }),          // NOT_OPTIONABLE, avoidable
    classifyZeroContract(out(), { referenceKnownOptionable: true }),           // wrong-window, avoidable
    classifyZeroContract(out({ requestedDteMin: 0, requestedDteMax: 7 })),     // too narrow
    classifyZeroContract(out({ outcome: "PROVIDER_QUOTA_EXCEEDED" })),         // OTHER
    classifyZeroContract(out({ truncated: true })),                            // INCOMPLETE
    classifyZeroContract(out({ requestedDteMin: 0, requestedDteMax: 60 })),    // clean wide empty
  ];
  const s = summarizeZeroContractCauses(sample);
  assert.equal(s.total, 6);
  assert.equal(s.byCause.NOT_OPTIONABLE, 1);
  assert.equal(s.byCause.NO_CONTRACTS_IN_REQUESTED_DTE, 2);
  assert.equal(s.byCause.PROVIDER_INCOMPLETE, 1);
  assert.equal(s.byCause.OTHER, 1);
  assert.equal(s.byCause.PROVIDER_EMPTY_RESPONSE, 1);
  assert.equal(s.avoidable, 2);
  assert.equal(s.eliminableShare, 0.3333, "measured, not assumed — the 802 are not one thing");
});

test("config comes from env with safe floors", () => {
  assert.deepEqual(optionabilityConfig({}), DEFAULT_OPTIONABILITY);
  assert.equal(optionabilityConfig({ OPTIONS_OPTIONABILITY_CORROBORATION_DAYS: "3" }).corroborationDays, 3);
  assert.equal(optionabilityConfig({ OPTIONS_OPTIONABILITY_CORROBORATION_DAYS: "0" }).corroborationDays, 2,
    "a zero threshold would condemn on a single empty answer — refused");
});
