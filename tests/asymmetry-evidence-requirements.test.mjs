/**
 * asymmetry-evidence-requirements.test.mjs — the completeness count must measure the
 * SETUP, not the wiring.
 *
 * Production evidence (2026-08-05, 200 candidates): CONFIRMING 0, HIGH_ASYMMETRY 0,
 * every case stuck at EARLY_ASYMMETRY (143) or INSUFFICIENT_EVIDENCE (49), zero
 * alerts all session, and CONFIRMING_EVIDENCE_INCOMPLETE_9 as the single largest
 * suppression reason. Root cause: lib/research/options/loop.ts hardcodes null for
 * six capture inputs, so six labels fire on every candidate and the <=3 and 0
 * thresholds are arithmetically unreachable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_REQUIREMENTS,
  UNSUPPLIED_LABELS,
  splitMissingEvidence,
  unsuppliedLabelCount,
} from "../lib/research/asymmetry/evidence-requirements.ts";
import { initialStateFor, initialStateForLabels } from "../lib/research/asymmetry/capture.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** The six labels loop.ts can never satisfy today. */
const ALWAYS_MISSING = [
  "NO_CATALYST", "NO_MARKET_ALIGNMENT", "NO_SECTOR_ALIGNMENT",
  "NO_VOLUME_ACCELERATION", "NO_COMPRESSION_STATE", "NO_LEVEL_DISTANCE",
];

test("the six permanently unsupplied labels are classified as such", () => {
  for (const label of ALWAYS_MISSING) {
    assert.ok(UNSUPPLIED_LABELS.has(label), `${label} must be marked unsupplied`);
  }
  assert.equal(unsuppliedLabelCount(), ALWAYS_MISSING.length);
});

test("a perfect setup is no longer graded against wiring it cannot control", () => {
  // Every label that fires is one the capture path never supplies.
  const split = splitMissingEvidence(ALWAYS_MISSING);
  assert.equal(split.blockingCount, 0, "none of these reflect the setup");
  assert.deepEqual(split.unsupplied.sort(), [...ALWAYS_MISSING].sort());
  assert.equal(initialStateForLabels(ALWAYS_MISSING), "HIGH_ASYMMETRY");
});

test("REGRESSION: the old arithmetic made CONFIRMING and HIGH_ASYMMETRY unreachable", () => {
  // This is what production was doing: grading on the raw count.
  assert.equal(initialStateFor(ALWAYS_MISSING.length), "EARLY_ASYMMETRY");
  assert.notEqual(initialStateFor(ALWAYS_MISSING.length), "CONFIRMING");
  // And with a couple of genuine absences on top, the observed _9.
  assert.equal(initialStateFor(9), "EARLY_ASYMMETRY");
});

test("evidence that WAS sought still grades the setup", () => {
  const split = splitMissingEvidence([...ALWAYS_MISSING, "NO_GREEKS", "NO_OPEN_INTEREST"]);
  assert.deepEqual(split.blocking.sort(), ["NO_GREEKS", "NO_OPEN_INTEREST"]);
  assert.equal(split.blockingCount, 2);
});

test("a setup missing real evidence is still demoted, not promoted", () => {
  const realAbsences = ["NO_GREEKS", "NO_OPEN_INTEREST", "NO_OPTION_VOLUME", "NO_IMPLIED_VOLATILITY"];
  assert.equal(splitMissingEvidence([...ALWAYS_MISSING, ...realAbsences]).blockingCount, 4);
  assert.equal(initialStateForLabels([...ALWAYS_MISSING, ...realAbsences]), "EARLY_ASYMMETRY");
});

test("an unrecognised label blocks rather than being silently excused", () => {
  const split = splitMissingEvidence(["NO_SOMETHING_NEW"]);
  assert.deepEqual(split.unknown, ["NO_SOMETHING_NEW"]);
  assert.equal(split.blockingCount, 1, "a new label must be classified deliberately");
});

test("unsupplied labels are reported, never discarded", () => {
  const split = splitMissingEvidence(ALWAYS_MISSING);
  assert.equal(split.unsupplied.length, 6, "the wiring debt stays visible");
});

test("every intake label has a requirement entry", () => {
  const src = read("lib/research/asymmetry/live-intake.ts");
  const declared = [...src.matchAll(/labels\.push\("([A-Z_]+)"\)/g)].map((m) => m[1]);
  assert.ok(declared.length >= 13, `expected the full label vocabulary, saw ${declared.length}`);
  const classified = new Set(EVIDENCE_REQUIREMENTS.map((r) => r.label));
  for (const label of declared) {
    assert.ok(classified.has(label), `${label} is emitted by live-intake but not classified`);
  }
});

test("gamma reaches the case instead of being dropped at the chain mapper", () => {
  const deps = read("lib/research/options/live-deps.ts");
  assert.match(deps, /gamma: c\.gamma \?\? null/, "the mapper must carry gamma through");
  const loop = read("lib/research/options/loop.ts");
  assert.match(loop, /gamma: number \| null/, "ChainContract must declare gamma");
  assert.match(loop, /gamma: res\.contract\.gamma \?\? null/, "capture must read the typed field");
});

test("null greeks stay null and never become zero", () => {
  const deps = read("lib/research/options/live-deps.ts");
  assert.doesNotMatch(deps, /gamma: c\.gamma \?\? 0/, "absent evidence must not read as 0");
  assert.doesNotMatch(deps, /delta: c\.delta \?\? 0/);
  assert.doesNotMatch(deps, /iv: c\.iv \?\? 0/);
});

test("the gate grades on the blocking subset, and its other checks are untouched", () => {
  const gate = read("lib/research/asymmetry/notification-gate.ts");
  assert.match(gate, /evidence\.blockingCount > cfg\.maxMissingEvidenceForConfirming/);
  // The hard checks that actually protect quality must all still be present.
  for (const check of [
    /UNUSABLE_SPREAD/, /WEAK_OPEN_INTEREST/, /WEAK_CONTRACT_VOLUME/,
    /INVALID_FUTURE_OPTION_QUOTE_TIMESTAMP/, /INVALID_FUTURE_UNDERLYING_QUOTE_TIMESTAMP/,
  ]) assert.match(gate, check, `${check} must survive this change`);
});
