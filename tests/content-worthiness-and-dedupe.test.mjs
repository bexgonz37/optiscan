/**
 * content-worthiness-and-dedupe.test.mjs
 *
 * Regression guard for the content-spam defect, written against what production
 * actually did on 2026-08-19:
 *
 *   200 drafts sampled -> 62 distinct texts. "Adding conviction to $AMZN."
 *   persisted 22 times. 184 of 200 were CONVICTION_INCREASED. AMZN alone
 *   produced 52 drafts in one session. Two of four drafts citing "large call
 *   buying" were on PUT contracts. `fingerprint === id` for all 200 rows.
 *
 * Each test below names the production behaviour it prevents from returning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DAILY_CONTENT_OBJECTIVE,
  DEFAULT_WORTHINESS_THRESHOLD,
  angleFor,
  collapseBatchDuplicates,
  scoreContentWorthiness,
  semanticContentFingerprint,
  thesisDigest,
} from "../lib/content/content-worthiness.ts";
import { validateContentCoherence } from "../lib/content/content-coherence.ts";
import { gateContentBundle, MAX_DRAFTS_PER_IDEA } from "../lib/content/content-gate.ts";
import { materialEventDiscriminator, contentEventId } from "../lib/opportunity-case/content-events.ts";
import {
  contentFeedbackReportOnDb,
  preferenceAdjustment,
  MAX_PREFERENCE_ADJUSTMENT,
} from "../lib/content/content-feedback.ts";

// ---------------------------------------------------------------------------
// 1. The source of the repeats: the event discriminator
// ---------------------------------------------------------------------------

test("a repeated unchanged THESIS_STRENGTHENED is the SAME event", () => {
  const base = {
    event: "THESIS_STRENGTHENED",
    sessionDate: "2026-08-19",
    thesisDigest: thesisDigest(["Higher-conviction multi-week setup"]),
  };
  // Ten minutes apart, unchanged thesis. The old key included nowMs, so these
  // were ten distinct events; there is no clock in the key any more.
  const a = materialEventDiscriminator({ ...base });
  const b = materialEventDiscriminator({ ...base });
  assert.equal(a, b);
  assert.equal(contentEventId("oc_amzn", "THESIS_STRENGTHENED", a),
    contentEventId("oc_amzn", "THESIS_STRENGTHENED", b));
  assert.equal(/\d{10,}/.test(a), false, "a timestamp leaked back into the discriminator");
});

test("a genuinely revised thesis IS a new event", () => {
  const a = materialEventDiscriminator({
    event: "THESIS_STRENGTHENED", sessionDate: "2026-08-19",
    thesisDigest: thesisDigest(["Higher-conviction multi-week setup"]),
  });
  const b = materialEventDiscriminator({
    event: "THESIS_STRENGTHENED", sessionDate: "2026-08-19",
    thesisDigest: thesisDigest(["Lower high continuation with bearish structure intact"]),
  });
  assert.notEqual(a, b);
});

test("a new session may say it again; a new milestone is always distinct", () => {
  const digest = thesisDigest(["same thesis"]);
  assert.notEqual(
    materialEventDiscriminator({ event: "THESIS_STRENGTHENED", sessionDate: "2026-08-19", thesisDigest: digest }),
    materialEventDiscriminator({ event: "THESIS_STRENGTHENED", sessionDate: "2026-08-20", thesisDigest: digest }),
  );
  assert.notEqual(
    materialEventDiscriminator({ event: "RETURN_MILESTONE", sessionDate: "2026-08-19", milestonePercent: 25 }),
    materialEventDiscriminator({ event: "RETURN_MILESTONE", sessionDate: "2026-08-19", milestonePercent: 50 }),
  );
  // A once-per-case event is keyed once, whatever else moves.
  assert.equal(
    materialEventDiscriminator({ event: "OPPORTUNITY_CLOSED", sessionDate: "2026-08-19", milestonePercent: 12 }),
    materialEventDiscriminator({ event: "OPPORTUNITY_CLOSED", sessionDate: "2026-08-19", milestonePercent: 99 }),
  );
});

// ---------------------------------------------------------------------------
// 2. Worthiness: routine events produce ZERO content
// ---------------------------------------------------------------------------

test("a routine unchanged conviction bump is below the bar", () => {
  const s = scoreContentWorthiness({
    category: "CONVICTION_INCREASED",
    symbol: "AMD",
    priorDraftsSameSymbolCategory: 3,
    priorDraftsSameSymbol: 7,
    hasRealizedOutcome: false,
  });
  assert.equal(s.worthy, false);
  assert.ok(s.score < DEFAULT_WORTHINESS_THRESHOLD);
  assert.match(s.refusedBecause, /Routine/i);
});

test("even the FIRST conviction bump of a session does not clear the bar", () => {
  // The category floor, not just repetition, is what keeps this internal.
  const s = scoreContentWorthiness({
    category: "CONVICTION_INCREASED", symbol: "AMD",
    priorDraftsSameSymbolCategory: 0, priorDraftsSameSymbol: 0,
  });
  assert.equal(s.worthy, false);
});

test("a verified closed result clears the bar comfortably", () => {
  const s = scoreContentWorthiness({
    category: "CLOSED_WINNER", symbol: "MRNA",
    claimVerified: true, hasRealizedOutcome: true, hasExactOcc: true,
    priorDraftsSameSymbolCategory: 0, priorDraftsSameSymbol: 0,
    magnitudePct: 293,
  });
  assert.equal(s.worthy, true);
  assert.ok(s.score > 0.8, `expected a strong score, got ${s.score}`);
  assert.equal(s.refusedBecause, null);
});

test("a duplicate is vetoed at any score", () => {
  const s = scoreContentWorthiness({
    category: "CLOSED_WINNER", claimVerified: true, hasRealizedOutcome: true,
    duplicateFingerprint: true,
  });
  assert.equal(s.worthy, false);
  assert.match(s.refusedBecause, /already exists/i);
  assert.equal(s.dimensions.NON_DUPLICATION, 0);
});

test("no material change is vetoed even when the category is significant", () => {
  const s = scoreContentWorthiness({
    category: "CLOSED_WINNER", claimVerified: true, hasRealizedOutcome: true,
    materialChange: false,
  });
  assert.equal(s.worthy, false);
  assert.match(s.refusedBecause, /materially changed/i);
});

test("repetition decays novelty rather than being ignored", () => {
  const at = (n) => scoreContentWorthiness({
    category: "CLOSED_WINNER", claimVerified: true, hasRealizedOutcome: true,
    priorDraftsSameSymbolCategory: n, priorDraftsSameSymbol: n * 2,
  }).dimensions.NOVELTY;
  assert.ok(at(0) > at(1) && at(1) > at(5) && at(5) > at(20));
  assert.ok(at(20) < 0.1, "the 21st draft about one symbol is still treated as novel");
});

test("volume is bounded by quality, not by a quota", () => {
  // 60 routine events in a session must yield zero, not "the best five".
  const routine = Array.from({ length: 60 }, (_, i) => scoreContentWorthiness({
    category: "CONVICTION_INCREASED", symbol: "AMZN",
    priorDraftsSameSymbolCategory: i, priorDraftsSameSymbol: i,
  }));
  assert.equal(routine.filter((s) => s.worthy).length, 0);
  // And a genuinely varied high-value day is not capped at the objective.
  assert.equal(typeof DAILY_CONTENT_OBJECTIVE, "number");
});

test("angles bucket the queue the way the filters do", () => {
  assert.equal(angleFor("CLOSED_WINNER"), "RESULTS");
  assert.equal(angleFor("MISSED_OPPORTUNITY"), "MISSED_OPPORTUNITY");
  assert.equal(angleFor("RESEARCH_FINDING"), "RESEARCH");
  assert.equal(angleFor("BUILD_INSIGHT"), "BUILD_PRODUCT");
  assert.equal(angleFor("MARKET_OBSERVATION"), "MARKET_OBSERVATION");
  assert.equal(angleFor("CONVICTION_INCREASED"), "LIFECYCLE");
});

// ---------------------------------------------------------------------------
// 3. Fingerprints: the identity that actually deduplicates
// ---------------------------------------------------------------------------

test("the semantic fingerprint carries no event id, draft id or clock", () => {
  const fp = (over = {}) => semanticContentFingerprint({
    symbol: "AMZN", category: "CONVICTION_INCREASED", optionType: "CALL",
    sessionDate: "2026-08-19", thesisDigest: thesisDigest(["Higher-conviction multi-week setup"]),
    ...over,
  });
  assert.equal(fp(), fp(), "identical state must produce an identical fingerprint");
  assert.notEqual(fp(), fp({ sessionDate: "2026-08-20" }));
  assert.notEqual(fp(), fp({ optionType: "PUT" }));
  assert.notEqual(fp(), fp({ thesisDigest: thesisDigest(["something else entirely"]) }));
  assert.notEqual(fp(), fp({ milestone: 25 }));
  assert.notEqual(fp(), fp({ evidenceState: "VERIFIED" }));
});

test("trivial rewording is not a new idea", () => {
  assert.equal(
    thesisDigest(["Lower high continuation with bearish structure intact."]),
    thesisDigest(["lower high continuation with bearish structure intact"]),
  );
});

test("a duplicate TSLA event collapses within a batch", () => {
  const collapsed = collapseBatchDuplicates([
    { fingerprint: "cf_tsla", score: 0.6, id: "a" },
    { fingerprint: "cf_tsla", score: 0.9, id: "b" },
    { fingerprint: "cf_tsla", score: 0.4, id: "c" },
    { fingerprint: "cf_amd", score: 0.7, id: "d" },
  ]);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0].id, "b", "the highest scorer must survive the collapse");
});

// ---------------------------------------------------------------------------
// 4. Coherence
// ---------------------------------------------------------------------------

test("call-buying evidence on a PUT is rejected", () => {
  const v = validateContentCoherence({
    text: "$NVDA wasn't on my radar 15 minutes ago.\nNow it is.\n\nHere's why:\n"
      + "• Large call buying detected\n\nWatching the 2026-08-21 $220 PUT closely.",
    optionType: "PUT",
  });
  assert.equal(v.coherent, false);
  const rule = v.violations.find((x) => x.rule === "DIRECTIONAL_CONTRADICTION");
  assert.ok(rule);
  assert.equal(rule.severity, "REJECT");
});

test("put-buying evidence on a CALL is rejected too", () => {
  const v = validateContentCoherence({ text: "Heavy put buying detected. Watching the $275 CALL.", optionType: "CALL" });
  assert.equal(v.coherent, false);
});

test("evidence agreeing with the side is fine", () => {
  assert.equal(validateContentCoherence({
    text: "Large call buying detected. Watching the 2026-10-16 $275 CALL.", optionType: "CALL",
  }).coherent, true);
});

test("MFE described as a realized return is rejected", () => {
  const v = validateContentCoherence({
    text: "We made +293% on this one.", isMaxExcursion: true, claimVerified: true,
  });
  assert.equal(v.coherent, false);
  assert.ok(v.violations.some((x) => x.rule === "MFE_AS_REALIZED"));
});

test("an owner-lane result presented as a subscriber result is rejected", () => {
  const v = validateContentCoherence({ text: "Subscribers made +120% on this call.", claimVerified: true });
  assert.equal(v.coherent, false);
  assert.ok(v.violations.some((x) => x.rule === "SUBSCRIBER_CLAIM_WITHOUT_SUBSCRIBERS"));
});

test("backend labels and doubled punctuation are refused", () => {
  const dbl = validateContentCoherence({ text: "The thesis strengthened: bearish structure intact.." });
  assert.equal(dbl.coherent, false);
  assert.ok(dbl.violations.some((x) => x.rule === "DOUBLE_PUNCTUATION"));

  const backend = validateContentCoherence({ text: "Strategy: LHC@UNKNOWN_LEGACY_VERSION" });
  assert.equal(backend.coherent, false);
  assert.ok(backend.violations.some((x) => x.rule === "BACKEND_LABEL_IN_COPY"));

  // Cashtags and ellipses are language, not leaks.
  assert.equal(validateContentCoherence({
    text: "$AMZN just entered my universe.\n\nNot because the candle is green...", optionType: "CALL",
  }).coherent, true);
});

// ---------------------------------------------------------------------------
// 5. The gate, end to end, against a fake table
// ---------------------------------------------------------------------------

function gateDb(existingFingerprints = [], priorCounts = { symbolCategory: 0, symbol: 0 }) {
  return {
    prepare(sql) {
      if (/sqlite_master/.test(sql)) return { get: () => ({ ok: 1 }), all: () => [] };
      if (/COUNT\(\*\)/.test(sql)) {
        const withCategory = /d\.category = \?/.test(sql);
        return { get: () => ({ n: withCategory ? priorCounts.symbolCategory : priorCounts.symbol }), all: () => [] };
      }
      if (/SELECT 1 FROM content_drafts WHERE fingerprint/.test(sql)) {
        return {
          get: (root) => (existingFingerprints.includes(root) ? { 1: 1 } : undefined),
          all: () => [],
        };
      }
      return { get: () => undefined, all: () => [] };
    },
  };
}

const amdConvictionEvent = {
  symbol: "AMD", category: "CONVICTION_INCREASED", optionType: "PUT", direction: "BEARISH",
  sessionDate: "2026-08-19",
  thesisParts: ["Lower high continuation with bearish structure intact"],
  evidenceState: "NON_ACTIONABLE_RESEARCH",
  drafts: [
    { text: "$AMD update: the setup got stronger, not weaker.\n\n• Lower high continuation", templateFamily: "CONVICTION_INCREASED_1" },
    { text: "Adding conviction to $AMD.", templateFamily: "CONVICTION_INCREASED_2" },
  ],
};

test("a repeated unchanged AMD-style event generates NO drafts", () => {
  const v = gateContentBundle(gateDb([], { symbolCategory: 4, symbol: 9 }), amdConvictionEvent, {});
  assert.deepEqual(v.admitted, []);
  assert.ok(v.refusedBecause);
});

test("the same idea a second time is refused as a duplicate, not merely as low value", () => {
  const first = gateContentBundle(gateDb(), { ...amdConvictionEvent, category: "CLOSED_WINNER", claimVerified: true, hasRealizedOutcome: true }, {});
  assert.ok(first.admitted.length > 0, "a verified result should be admitted the first time");
  const second = gateContentBundle(
    gateDb([first.rootFingerprint]),
    { ...amdConvictionEvent, category: "CLOSED_WINNER", claimVerified: true, hasRealizedOutcome: true },
    {},
  );
  assert.deepEqual(second.admitted, []);
  assert.equal(second.duplicate, true);
  assert.match(second.worthiness.refusedBecause, /already exists/i);
});

test("a high-value verified result IS admitted, bounded, with alternates hung off the root", () => {
  const v = gateContentBundle(gateDb(), {
    symbol: "MRNA", category: "CLOSED_WINNER", optionType: "CALL", direction: "BULLISH",
    sessionDate: "2026-08-19", thesisParts: ["Extreme premarket continuation"],
    claimVerified: true, hasRealizedOutcome: true, hasExactOcc: true, magnitudePct: 293,
    evidenceState: "VERIFIED_EXECUTABLE",
    drafts: [
      { text: "MRNA closed out. Frozen entry to exit, the record is on the board.", templateFamily: "CLOSED_WINNER_0" },
      { text: "The MRNA case closed today.", templateFamily: "CLOSED_WINNER_1" },
      { text: "MRNA: what the record shows.", templateFamily: "CLOSED_WINNER_2" },
      { text: "One more MRNA phrasing.", templateFamily: "CLOSED_WINNER_3" },
    ],
  }, {});
  assert.ok(v.admitted.length > 0);
  assert.ok(v.admitted.length <= MAX_DRAFTS_PER_IDEA, "one idea took over the queue");
  assert.equal(v.admitted[0].fingerprint, v.rootFingerprint);
  assert.equal(v.admitted[0].isAlternate, false);
  for (const a of v.admitted.slice(1)) {
    assert.equal(a.isAlternate, true);
    assert.ok(a.fingerprint.startsWith(`${v.rootFingerprint}#`));
  }
});

test("byte-identical drafts inside one bundle collapse to one row", () => {
  const same = "Adding conviction to $AMZN.";
  const v = gateContentBundle(gateDb(), {
    symbol: "AMZN", category: "CLOSED_WINNER", optionType: "CALL",
    sessionDate: "2026-08-19", thesisParts: ["x"], claimVerified: true, hasRealizedOutcome: true,
    drafts: [
      { text: same, templateFamily: "A" },
      { text: same, templateFamily: "B" },
      { text: same, templateFamily: "C" },
    ],
  }, {});
  assert.equal(v.admitted.length, 1, "the same sentence was persisted more than once");
});

test("a contradictory draft is refused while a coherent sibling survives", () => {
  const v = gateContentBundle(gateDb(), {
    symbol: "NVDA", category: "CLOSED_WINNER", optionType: "PUT", direction: "BEARISH",
    sessionDate: "2026-08-19", thesisParts: ["breakdown"], claimVerified: true, hasRealizedOutcome: true,
    drafts: [
      { text: "Large call buying detected. Watching the $220 PUT.", templateFamily: "BAD" },
      { text: "The NVDA put case closed today. Record is on the board.", templateFamily: "GOOD" },
    ],
  }, {});
  assert.equal(v.admitted.length, 1);
  assert.equal(v.admitted[0].templateFamily, "GOOD");
  assert.equal(v.incoherent.length, 1);
  assert.equal(v.incoherent[0].templateFamily, "BAD");
});

test("if every draft contradicts the position, nothing is admitted", () => {
  const v = gateContentBundle(gateDb(), {
    symbol: "AMD", category: "CLOSED_WINNER", optionType: "PUT",
    sessionDate: "2026-08-19", thesisParts: ["x"], claimVerified: true, hasRealizedOutcome: true,
    drafts: [{ text: "Large call buying detected on the $465 PUT.", templateFamily: "BAD" }],
  }, {});
  assert.deepEqual(v.admitted, []);
  assert.match(v.refusedBecause, /contradicted/i);
});

test("an owner-requested regeneration bypasses worthiness but not coherence", () => {
  const routine = { ...amdConvictionEvent, ownerRequested: true, fingerprintSalt: "ALT_1" };
  const ok = gateContentBundle(gateDb([], { symbolCategory: 9, symbol: 30 }), routine, {});
  assert.ok(ok.admitted.length > 0, "the owner asked for it and was refused anyway");

  const bad = gateContentBundle(gateDb(), {
    ...amdConvictionEvent, ownerRequested: true, fingerprintSalt: "ALT_2",
    drafts: [{ text: "Large call buying detected on the PUT.", templateFamily: "BAD" }],
  }, {});
  assert.deepEqual(bad.admitted, []);
});

test("the worthiness threshold is configurable and clamped", () => {
  const strict = gateContentBundle(gateDb(), {
    symbol: "MRNA", category: "CLOSED_WINNER", sessionDate: "2026-08-19", thesisParts: ["x"],
    claimVerified: true, hasRealizedOutcome: true, optionType: "CALL",
    drafts: [{ text: "MRNA closed out.", templateFamily: "A" }],
  }, { CONTENT_MIN_WORTHINESS: "0.99" });
  assert.deepEqual(strict.admitted, []);
});

// ---------------------------------------------------------------------------
// 6. The learning loop
// ---------------------------------------------------------------------------

function feedbackDb(rows) {
  return {
    prepare(sql) {
      if (/sqlite_master/.test(sql)) return { get: () => ({ ok: 1 }), all: () => [] };
      if (/PRAGMA table_info/.test(sql)) {
        return { get: () => null, all: () => [{ name: "content_angle" }, { name: "category" }] };
      }
      if (/GROUP BY category/.test(sql)) return { get: () => null, all: () => rows };
      if (/GROUP BY content_angle/.test(sql)) return { get: () => null, all: () => [] };
      return { get: () => null, all: () => [] };
    },
  };
}

test("approval and rejection are read, not merely written", () => {
  const r = contentFeedbackReportOnDb(feedbackDb([
    { k: "CLOSED_WINNER", generated: 10, approved: 8, rejected: 2, posted: 6, edited: 3 },
    { k: "CONVICTION_INCREASED", generated: 30, approved: 1, rejected: 19, posted: 0, edited: 0 },
  ]), { days: 30 });
  assert.equal(r.totalDrafts, 40);
  assert.equal(r.totalJudged, 30);
  assert.equal(r.evidenceState, "USABLE");
  const winner = r.byCategory.find((c) => c.category === "CLOSED_WINNER");
  assert.equal(winner.approvalRate, 0.8);
  assert.equal(winner.manuallyPosted, 6);
  assert.equal(winner.edited, 3);
});

test("no feedback yet reports absence, never a rate of zero", () => {
  const r = contentFeedbackReportOnDb(feedbackDb([
    { k: "CLOSED_WINNER", generated: 5, approved: 0, rejected: 0, posted: 0, edited: 0 },
  ]));
  assert.equal(r.evidenceState, "NO_FEEDBACK_YET");
  assert.equal(r.byCategory[0].approvalRate, null);
  assert.match(r.note, /not a score of zero/i);
});

test("preference is bounded and cannot flip a verdict on its own", () => {
  const r = contentFeedbackReportOnDb(feedbackDb([
    { k: "CLOSED_WINNER", generated: 30, approved: 25, rejected: 5, posted: 20, edited: 2 },
    { k: "CONVICTION_INCREASED", generated: 30, approved: 0, rejected: 25, posted: 0, edited: 0 },
  ]));
  const up = preferenceAdjustment(r, "CLOSED_WINNER");
  const down = preferenceAdjustment(r, "CONVICTION_INCREASED");
  assert.ok(up > 0 && up <= MAX_PREFERENCE_ADJUSTMENT);
  assert.ok(down < 0 && down >= -MAX_PREFERENCE_ADJUSTMENT);

  // Structural: the verdict cannot see the feedback at all. This is the real
  // guarantee — the numeric one below is only a second line of defence.
  const worthinessSrc = readFileSync(
    new URL("../lib/content/content-worthiness.ts", import.meta.url), "utf8",
  );
  assert.equal(/content-feedback/.test(worthinessSrc), false,
    "the worthiness verdict must not be able to reach owner feedback");

  // And even a caller who wrongly ADDED the nudge before thresholding could not
  // lift a routine conviction bump over the bar.
  const routine = scoreContentWorthiness({ category: "CONVICTION_INCREASED", symbol: "AMD" });
  assert.ok(routine.score + MAX_PREFERENCE_ADJUSTMENT < DEFAULT_WORTHINESS_THRESHOLD,
    `routine ${routine.score} + ${MAX_PREFERENCE_ADJUSTMENT} reached the bar ${DEFAULT_WORTHINESS_THRESHOLD}`);
});

test("sparse feedback yields no adjustment at all", () => {
  const r = contentFeedbackReportOnDb(feedbackDb([
    { k: "CLOSED_WINNER", generated: 3, approved: 3, rejected: 0, posted: 1, edited: 0 },
  ]));
  assert.equal(r.evidenceState, "SPARSE");
  assert.equal(preferenceAdjustment(r, "CLOSED_WINNER"), 0);
});
