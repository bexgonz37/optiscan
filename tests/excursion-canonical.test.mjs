/**
 * tests/excursion-canonical.test.mjs
 *
 * Excursion is a claim about EVERY moment of a holding period; realized return is one
 * observation. The two need different evidence, and conflating them is what let a
 * GOOGL case whose frozen contract never printed better than +47.2103% publish a peak
 * of +185.4077%.
 *
 * Pinned here:
 *   - the canonical peak comes only from marks whose own option_symbol is the frozen OCC
 *   - a stored peak above anything the contract printed is UNSUPPORTED, not "close enough"
 *   - a stored 0 on a trade that only traded down is MAX_FLOORED_AT_ZERO, a different
 *     defect from contamination and never a real "peaked at break-even"
 *   - missing history stays null; it never becomes 0
 *   - a correction is an added record, and opportunity_cases is left untouched
 *   - an unverified case resolves to null and never falls back to the stored value
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  recomputeExcursionOnDb,
  recomputeExcursionsOnDb,
  summarizeExcursions,
  correctionFromExcursion,
  persistExcursionCorrectionOnDb,
  readExcursionCorrectionOnDb,
  runExcursionCorrectionPassOnDb,
  resolvePublishableExcursionOnDb,
  summarizeCorrections,
  MIN_MARKS_FOR_EXCURSION,
} from "../lib/opportunity-case/excursion.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const T0 = Date.parse("2026-08-07T15:30:00.000Z");
const FROZEN = "O:GOOGL260807P00357500";
const RESELECTED = "O:GOOGL260819P00355000";

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

/** Seed one delivered case + its mirror. `marks` are [returnPct, occ] pairs. */
let seq = 0;
function seed(d, opts = {}) {
  const caseId = opts.caseId ?? "oc_15gylwt";
  // Each case gets its own alert and mirror. Sharing them would let one case's marks
  // resolve onto another's frozen contract — which is the very confusion under test.
  seq += 1;
  const alertId = `oa_${caseId}`;
  const tradeId = 700 + seq;
  const c = {
    schemaVersion: 1,
    opportunityId: caseId,
    underlyingSymbol: "GOOGL",
    alertId,
    selectedContract: {
      optionSymbol: "frozenOcc" in opts ? opts.frozenOcc : FROZEN,
      side: "put", strike: 357.5, expiration: "2026-08-07",
    },
    frozenTrade: { entryMid: opts.frozenEntry ?? 2.33, immutable: true },
    summary: {
      frozenEntry: opts.frozenEntry ?? 2.33,
      currentMark: 3.43,
      currentReturnPct: 47.2103,
      maxReturnPct: "storedMax" in opts ? opts.storedMax : 47.2103,
      currentStatus: "CLOSED",
    },
  };
  d.prepare(
    `INSERT INTO opportunity_cases
      (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
       delivery_decision, case_json, created_at_ms, updated_at_ms, alert_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(caseId, "GOOGL", T0, "test", "accepted", "delivered", JSON.stringify(c), T0, T0, alertId);

  if (opts.noMirror) return caseId;

  d.prepare(
    `INSERT INTO options_paper_trades
      (id, option_symbol, side, strike, expiration, dte, result_class, entry_fill, status,
       paper_kind, alert_id, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(tradeId, FROZEN, "put", 357.5, "2026-08-07", 0, "REAL_OPTION_PAPER", 2.33, "EXITED",
    "DELIVERED_ALERT_PAPER", alertId, T0, T0);

  const marks = opts.marks ?? [];
  marks.forEach(([ret, occ], i) => {
    d.prepare(
      `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms)
       VALUES (?,?,?,?,?)`,
    ).run(tradeId, occ ?? FROZEN, T0 + (i + 1) * 60_000, ret, T0);
  });
  return caseId;
}

test("the canonical peak is the best mark ON THE FROZEN CONTRACT", () => {
  const d = db();
  const caseId = seed(d, {
    marks: [[-5, FROZEN], [12.4, FROZEN], [47.2103, FROZEN], [30.1, FROZEN]],
  });
  const e = recomputeExcursionOnDb(d, caseId);
  assert.equal(e.state, "VERIFIED_EXCURSION");
  assert.equal(e.canonicalMfePct, 47.2103);
  assert.equal(e.canonicalMaePct, -5);
  assert.equal(e.marksOnFrozen, 4);
  assert.equal(e.storedValueIsWrong, false);
});

test("the GOOGL case: re-selected marks never raise the peak", () => {
  const d = db();
  // The real shape — the frozen contract's best was +47.2103%, while the running
  // maximum drifted up on longer-dated strikes and published +185.4077%.
  const caseId = seed(d, {
    storedMax: 185.4077,
    marks: [
      [-5, FROZEN], [12.4, FROZEN], [47.2103, FROZEN], [30.1, FROZEN],
      [120.5, RESELECTED], [185.4077, RESELECTED], [160.0, "O:GOOGL260812P00357500"],
    ],
  });
  const e = recomputeExcursionOnDb(d, caseId);
  assert.equal(e.state, "UNSUPPORTED_MAX_RETURN");
  assert.equal(e.storedValueIsWrong, true);
  assert.equal(e.canonicalMfePct, 47.2103, "the truthful peak sits beside the refusal");
  assert.equal(e.storedMaxReturnPct, 185.4077, "the original is preserved, not erased");
  assert.equal(e.marksOffFrozen, 3);
});

test("a stored 0 on a trade that only traded down is floored, not observed", () => {
  const d = db();
  const caseId = seed(d, {
    storedMax: 0,
    marks: [[-12, FROZEN], [-30, FROZEN], [-55, FROZEN], [-80, FROZEN]],
  });
  const e = recomputeExcursionOnDb(d, caseId);
  assert.equal(e.state, "MAX_FLOORED_AT_ZERO");
  assert.equal(e.storedValueIsWrong, true);
  assert.equal(e.canonicalMfePct, -12, "the best moment was still a loss");
  assert.equal(e.canonicalMaePct, -80);
  assert.notEqual(e.canonicalMfePct, 0, "0 is the seed showing through, not a peak");
});

test("too few marks cannot claim an extreme, and absence is not zero", () => {
  const d = db();
  const caseId = seed(d, { marks: [[10, FROZEN], [20, FROZEN]] });
  const e = recomputeExcursionOnDb(d, caseId);
  assert.equal(e.state, "INSUFFICIENT_MARKS");
  assert.equal(e.canonicalMfePct, null, "unknown is null, never 0");
  assert.equal(e.canonicalMaePct, null);
  assert.ok(MIN_MARKS_FOR_EXCURSION > 2);
});

test("a case with no mirror reports NO_MIRROR rather than a zero excursion", () => {
  const d = db();
  const caseId = seed(d, { noMirror: true });
  const e = recomputeExcursionOnDb(d, caseId);
  assert.equal(e.state, "NO_MIRROR");
  assert.equal(e.canonicalMfePct, null);
});

test("a case that froze no contract cannot attribute any mark", () => {
  const d = db();
  const caseId = seed(d, { frozenOcc: null, marks: [[47, FROZEN], [10, FROZEN], [5, FROZEN]] });
  const e = recomputeExcursionOnDb(d, caseId);
  assert.equal(e.state, "OCC_IDENTITY_MISSING");
  assert.equal(e.canonicalMfePct, null);
});

test("a correction records the original and leaves opportunity_cases untouched", () => {
  const d = db();
  const caseId = seed(d, {
    storedMax: 185.4077,
    marks: [[-5, FROZEN], [12.4, FROZEN], [47.2103, FROZEN], [185.4077, RESELECTED]],
  });
  const before = d.prepare("SELECT case_json FROM opportunity_cases WHERE opportunity_id=?").get(caseId).case_json;

  const e = recomputeExcursionOnDb(d, caseId);
  const c = correctionFromExcursion(e, { nowMs: T0 + 999, sha: "d69a640" });
  assert.equal(persistExcursionCorrectionOnDb(d, c), true);

  const stored = readExcursionCorrectionOnDb(d, caseId);
  assert.equal(stored.originalMaxReturnPct, 185.4077);
  assert.equal(stored.evidenceState, "UNSUPPORTED_MAX_RETURN");
  assert.equal(stored.correctionSha, "d69a640");
  assert.equal(stored.correctedAtMs, T0 + 999);
  assert.ok(stored.reason.length > 0, "a correction always says why");
  assert.equal(
    stored.correctedMaxReturnPct,
    null,
    "knowing the stored value is wrong is not the same as knowing the right one",
  );

  const after = d.prepare("SELECT case_json FROM opportunity_cases WHERE opportunity_id=?").get(caseId).case_json;
  assert.equal(after, before, "history is never silently rewritten");
});

test("a verified case carries its corrected canonical value", () => {
  const d = db();
  const caseId = seed(d, { marks: [[-5, FROZEN], [12.4, FROZEN], [47.2103, FROZEN]] });
  const c = correctionFromExcursion(recomputeExcursionOnDb(d, caseId), { nowMs: T0, sha: "abc1234" });
  assert.equal(c.evidenceState, "VERIFIED_EXCURSION");
  assert.equal(c.correctedMaxReturnPct, 47.2103);
  assert.equal(c.correctedMaePct, -5);
});

test("resolvePublishableExcursion never falls back to the stored legacy value", () => {
  const d = db();
  const caseId = seed(d, {
    storedMax: 185.4077,
    marks: [[-5, FROZEN], [12.4, FROZEN], [47.2103, FROZEN], [185.4077, RESELECTED]],
  });
  const r = resolvePublishableExcursionOnDb(d, caseId);
  assert.equal(r.maxReturnPct, null, "an unsupported peak resolves to unavailable");
  assert.equal(r.state, "UNSUPPORTED_MAX_RETURN");
  assert.notEqual(r.maxReturnPct, 185.4077);
});

test("resolvePublishableExcursion returns the value when evidence is verified", () => {
  const d = db();
  const caseId = seed(d, { marks: [[-5, FROZEN], [12.4, FROZEN], [47.2103, FROZEN]] });
  const r = resolvePublishableExcursionOnDb(d, caseId);
  assert.equal(r.state, "VERIFIED_EXCURSION");
  assert.equal(r.maxReturnPct, 47.2103);
  assert.equal(r.maePct, -5);
});

test("the correction pass is repeat-safe and censuses the population", () => {
  const d = db();
  seed(d, { caseId: "oc_a", storedMax: 185.4077, marks: [[-5, FROZEN], [12, FROZEN], [47.2103, FROZEN], [185.4077, RESELECTED]] });
  seed(d, { caseId: "oc_b", storedMax: 0, marks: [[-12, FROZEN], [-30, FROZEN], [-55, FROZEN]] });
  seed(d, { caseId: "oc_c", marks: [[-5, FROZEN], [12, FROZEN], [47.2103, FROZEN]] });

  const first = runExcursionCorrectionPassOnDb(d, { nowMs: T0, sha: "sha1" });
  assert.equal(first.census.examined, 3);
  assert.equal(first.census.byState.UNSUPPORTED_MAX_RETURN, 1);
  assert.equal(first.census.byState.MAX_FLOORED_AT_ZERO, 1);
  assert.equal(first.census.byState.VERIFIED_EXCURSION, 1);
  assert.equal(first.census.storedValuesWrong, 2);
  assert.equal(first.census.publishable, 1);

  const second = runExcursionCorrectionPassOnDb(d, { nowMs: T0 + 5, sha: "sha2" });
  assert.deepEqual(second.census, first.census, "re-running changes nothing about the findings");
  assert.equal(
    d.prepare("SELECT COUNT(*) n FROM opportunity_excursion_corrections").get().n,
    3,
    "corrections are keyed by case, so a second pass updates rather than duplicates",
  );
  assert.equal(readExcursionCorrectionOnDb(d, "oc_a").correctionSha, "sha2");
});

test("summarizeExcursions counts every state without collapsing them", () => {
  const d = db();
  seed(d, { caseId: "oc_x", noMirror: true });
  seed(d, { caseId: "oc_y", marks: [[1, FROZEN], [2, FROZEN]] });
  const census = summarizeExcursions(recomputeExcursionsOnDb(d, { scope: "delivered" }));
  assert.equal(census.byState.NO_MIRROR, 1);
  assert.equal(census.byState.INSUFFICIENT_MARKS, 1);
  assert.equal(census.publishable, 0);
});

/** Three cases: one contaminated, one floored, one clean. */
function seedCensusPopulation(d) {
  seed(d, { caseId: "oc_a", storedMax: 185.4077, marks: [[-5, FROZEN], [12, FROZEN], [47.2103, FROZEN], [185.4077, RESELECTED]] });
  seed(d, { caseId: "oc_b", storedMax: 0, marks: [[-12, FROZEN], [-30, FROZEN], [-55, FROZEN]] });
  seed(d, { caseId: "oc_c", marks: [[-5, FROZEN], [12, FROZEN], [47.2103, FROZEN]] });
}

test("a dry run reports the identical census and writes nothing", () => {
  const d = db();
  seedCensusPopulation(d);

  const dry = runExcursionCorrectionPassOnDb(d, { nowMs: T0, sha: "sha1", dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.recorded, 0, "a dry run records nothing");
  assert.equal(
    d.prepare("SELECT COUNT(*) n FROM opportunity_excursion_corrections").get().n,
    0,
    "a dry run leaves the correction store empty",
  );

  const applied = runExcursionCorrectionPassOnDb(d, { nowMs: T0, sha: "sha1" });
  // The write must not change the finding. If these ever diverge, the pass is deciding
  // something at persist time that it should have decided while reading.
  assert.deepEqual(applied.census, dry.census);
  assert.deepEqual(applied.correctionCensus, dry.correctionCensus);
  assert.equal(applied.recorded, 3);
});

test("the correction census separates a provable value from a condemned one", () => {
  const d = db();
  seedCensusPopulation(d);
  const { correctionCensus: c } = runExcursionCorrectionPassOnDb(d, { nowMs: T0, sha: "sha1" });

  assert.equal(c.recorded, 3);
  // Only the VERIFIED case can supply a replacement value.
  assert.equal(c.correctedMfe, 1);
  assert.equal(c.correctedMae, 1);
  // The contaminated and the floored are both recorded WITHOUT a corrected value:
  // knowing the stored number is wrong is not knowing the right one.
  assert.equal(c.unresolved, 2);
  assert.equal(c.storedValuesCondemned, 2);
  assert.equal(c.byState.UNSUPPORTED_MAX_RETURN, 1);
  assert.equal(c.byState.MAX_FLOORED_AT_ZERO, 1);
  assert.equal(c.byState.VERIFIED_EXCURSION, 1);
});

test("an unresolved correction is never counted as a corrected value", () => {
  const rows = [
    { opportunityCaseId: "a", originalMaxReturnPct: 185, evidenceState: "UNSUPPORTED_MAX_RETURN", correctedMaxReturnPct: null, correctedMaePct: null },
    { opportunityCaseId: "b", originalMaxReturnPct: 47, evidenceState: "VERIFIED_EXCURSION", correctedMaxReturnPct: 47, correctedMaePct: -5 },
  ];
  const c = summarizeCorrections(rows);
  assert.equal(c.correctedMfe, 1);
  assert.equal(c.unresolved, 1);
  assert.equal(c.correctedMfe + c.unresolved, c.recorded, "every recorded correction is one or the other");
});
