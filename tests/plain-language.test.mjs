/**
 * plain-language.test.mjs
 *
 * The private app was rendering internal constants as though they were English.
 * `OWNER_VALIDATION_PAPER` was a card subtitle, a 32-character definition hash
 * was in the reading path, and raw experiment ids were headings. None of those
 * strings is wrong — a constant chosen so two modules agree is simply not a
 * phrase chosen so a person understands it.
 *
 * These tests protect two properties: the constants are named, and naming them
 * does not make them unavailable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SHADOW_ONLY_BANNER,
  knownConstants,
  plainExperiment,
  plainLabel,
} from "../lib/research/plain-language.ts";
import { METRIC_GLOSSARY } from "../lib/metric-glossary.ts";

/** The literal strings the brief asked to keep off the primary UI. */
const JARGON = [
  "OWNER_VALIDATION_PAPER",
  "RESEARCH_ONLY",
  "UNKNOWN_LEGACY_VERSION",
  "INSUFFICIENT_EVIDENCE",
  "NON_ACTIONABLE_RESEARCH",
  "NOT_ADMITTED_TO_UNIVERSE",
  "ADMITTED_NOT_QUOTED",
];

test("every named constant gets language, not a de-shouted constant", () => {
  for (const raw of JARGON) {
    const p = plainLabel(raw);
    assert.notEqual(p.label, raw, `${raw} was rendered as itself`);
    assert.equal(/^[A-Z0-9_]+$/.test(p.label), false, `${p.label} is still shouting`);
    assert.equal(p.raw, raw, "the raw constant must be preserved for technical details");
  }
});

test("the distinction that matters most is spelled out", () => {
  // Owner-lane results are not subscriber results. If one sentence on this page
  // has to be right, it is this one.
  const owner = plainLabel("OWNER_VALIDATION_PAPER");
  assert.match(owner.meaning, /no result in this lane is a subscriber result/i);
  assert.match(plainLabel("NOT_ADMITTED_TO_UNIVERSE").meaning, /No return can be claimed/i);
  // "Not enough evidence" must not read as "it did not work".
  assert.match(plainLabel("INSUFFICIENT_EVIDENCE").meaning, /Not a negative result/i);
});

test("an unknown constant is de-shouted rather than leaked or dropped", () => {
  const p = plainLabel("SOME_BRAND_NEW_STATE");
  assert.equal(p.label, "Some brand new state");
  assert.equal(p.raw, "SOME_BRAND_NEW_STATE");
  assert.equal(plainLabel(null).label, "Unknown");
  assert.equal(plainLabel("").raw, "");
});

test("each frozen experiment has a purpose a person can read", () => {
  for (const id of [
    "OWNER_SELECTION_STRENGTH_GATE_V1",
    "PRE_MOVE_DISCOVERY_V2",
    "EXTREME_PREMARKET_DISCOVERY_V1",
  ]) {
    const p = plainExperiment(id);
    assert.equal(p.experimentId, id);
    assert.ok(p.title.length > 10, `${id} has no readable title`);
    assert.ok(p.purpose.length > 40, `${id} has no readable purpose`);
    assert.equal(/^[A-Z0-9_]+$/.test(p.title), false, `${id}'s title is the id`);
    // "If it works" must never promise that it will.
    assert.equal(/\bwill (be|become|change)\b/i.test(p.ifItWorks), false,
      `${id} promises an outcome it has not earned`);
  }
});

test("an unregistered experiment degrades instead of pretending", () => {
  const p = plainExperiment("SOMETHING_V9");
  assert.equal(p.title, "Something v9");
  assert.match(p.purpose, /No plain-English description/i);
});

test("this module never redefines a metric — the glossary owns those", () => {
  // `metric-glossary.ts` is the single source for metric wording and a separate
  // test forbids components from restating it. Two vocabularies for the same
  // concept is the defect, not the fix.
  const src = readFileSync(new URL("../lib/research/plain-language.ts", import.meta.url), "utf8");
  for (const metricKey of Object.keys(METRIC_GLOSSARY)) {
    const asConstant = metricKey.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    assert.equal(knownConstants().includes(asConstant), false,
      `${asConstant} belongs to the metric glossary, not to this module`);
  }
  assert.equal(/METRIC_GLOSSARY/.test(src), false, "plain-language must not embed glossary wording");
});

test("the shadow banner is one fixed sentence, so it is recognised not read", () => {
  assert.match(SHADOW_ONLY_BANNER, /SHADOW ONLY/);
  assert.match(SHADOW_ONLY_BANNER, /DOES NOT CHANGE LIVE CALLOUTS/);
});

// ---------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------

const RCC = readFileSync(new URL("../components/ResearchCommandCenter.tsx", import.meta.url), "utf8");

test("the primary reading path renders plain labels, not raw constants", () => {
  // The experiment card's heading is the plain title.
  assert.match(RCC, /title=\{x\.plainTitle/);
  // Status badges go through the translator.
  assert.match(RCC, /plainLabel\(x\.status\)/);
  assert.match(RCC, /plainLabel\(e\.population\)/);
  // And the strings that used to be in the reading path are gone from it.
  assert.equal(/OWNER VALIDATION \/ PAPER-TRACKED/.test(RCC), false);
  assert.equal(/REALIZED: \{e\.evidenceState\}/.test(RCC), false);
});

test("identifiers stay available under technical details", () => {
  // Naming a constant must not make it unreachable: the hash is how "the rule
  // did not move while its evidence accumulated" is checked.
  const idx = RCC.indexOf("Technical details");
  assert.ok(idx > 0, "no technical-details disclosure on the experiment card");
  const block = RCC.slice(idx, idx + 900);
  assert.match(block, /x\.experimentId/);
  assert.match(block, /x\.definitionHash/);
  assert.match(block, /x\.authority/);
});

test("the page shows every shadow experiment, not only the first", () => {
  assert.match(RCC, /r\.shadowExperiments\.map/);
  const builder = readFileSync(
    new URL("../lib/research/options/research-command-center.ts", import.meta.url), "utf8",
  );
  // PRE_MOVE_V2 and EXTREME_PREMARKET were real and invisible; an experiment
  // whose progress cannot be seen is one that cannot be decided about.
  assert.match(builder, /PRE_MOVE_DISCOVERY_V2/);
  assert.match(builder, /EXTREME_PREMARKET_DISCOVERY_V1/);
  assert.match(builder, /buildOtherExperimentPanels/);
});

test("a missed opportunity never shows an option return it did not have", () => {
  // The literal fallback text for an unquoted mover. A zero here would be a
  // claim; a blank is the truth.
  assert.match(RCC, /never quoted/);
  const builder = readFileSync(
    new URL("../lib/research/options/research-command-center.ts", import.meta.url), "utf8",
  );
  assert.match(builder, /attainableMfePct: m\.ladder\?\.mfePct \?\? null/);
});

test("the content queue states that nothing posts itself", () => {
  assert.match(RCC, /nothing posts itself/i);
  assert.match(RCC, /r\.contentQueue\.awaitingReview/);
});
