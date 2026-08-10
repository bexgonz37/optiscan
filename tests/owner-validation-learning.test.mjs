/**
 * tests/owner-validation-learning.test.mjs
 *
 * Owner alerts are the primary forward-validation population. The nightly AI excluded
 * OWNER_VALIDATION_PAPER entirely, so on a day whose only deliveries were 16 owner
 * openings it saw an empty session and had nothing to learn from.
 *
 * Two requirements pull against each other and both are pinned here:
 *
 *   INCLUDED — the owner lane reaches Evidence Learning at all.
 *   NOT BLENDED — it arrives as its own audience. An owner validation trade is not a
 *   subscriber delivery, and pooling their expectancies would describe a population
 *   that has never existed.
 *
 * Also pinned: realized performance and trajectory quality are answered separately.
 * A VERIFIED +47% realized winner whose mark series is too thin to place a peak stays
 * a winner, and its MFE is reported as unmeasured rather than guessed.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  refreshEvidenceLearningOnDb,
  evidenceLearningSnapshotOnDb,
} from "../lib/ai/evidence-learning.ts";
import { excursionForPaperTradeOnDb } from "../lib/opportunity-case/excursion.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const T0 = Date.parse("2026-08-10T15:30:00.000Z");
const OCC = "O:QQQ260816C00750000";

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

let nextId = 0;
function seedTrade(d, { paperKind, occ = OCC, returnPct = 47.2103, marks = [] }) {
  nextId += 1;
  const id = 900 + nextId;
  d.prepare(
    `INSERT INTO options_paper_trades
      (id, option_symbol, side, strike, expiration, dte, result_class, entry_fill, status,
       return_pct, paper_kind, strategy, entered_at_ms, exit_at_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, occ, "call", 750, "2026-08-16", 6, "REAL_OPTION_PAPER", 2.33, "EXITED",
    returnPct, paperKind, "momentum_acceleration", T0, T0 + 600_000, T0, T0);
  marks.forEach((pct, i) => {
    d.prepare(
      `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms)
       VALUES (?,?,?,?,?)`,
    ).run(id, occ, T0 + (i + 1) * 60_000, pct, T0);
  });
  return id;
}

test("an owner validation trade reaches Evidence Learning", () => {
  const d = db();
  seedTrade(d, { paperKind: "OWNER_VALIDATION_PAPER", marks: [-5, 12, 47.2103] });

  refreshEvidenceLearningOnDb(d, { nowMs: T0 + 900_000 });
  const rows = d.prepare("SELECT audience, source_kind FROM evidence_learning_examples").all();
  assert.equal(rows.length, 1, "the owner lane is no longer invisible to the nightly");
  assert.equal(rows[0].audience, "OWNER_VALIDATION");
  assert.equal(rows[0].source_kind, "owner_validation");
});

test("the owner lane is never blended into the delivered lane", () => {
  const d = db();
  seedTrade(d, { paperKind: "OWNER_VALIDATION_PAPER", marks: [-5, 12, 47.2103] });
  seedTrade(d, { paperKind: "DELIVERED_ALERT_PAPER", marks: [-2, 8, 30] });
  seedTrade(d, { paperKind: "RESEARCH_ONLY_PAPER", marks: [1, 2, 3] });

  refreshEvidenceLearningOnDb(d, { nowMs: T0 + 900_000 });
  const snap = evidenceLearningSnapshotOnDb(d);

  assert.equal(snap.examples.ownerValidation, 1);
  assert.equal(snap.examples.delivered, 1);
  assert.equal(snap.examples.researchOnly, 1);
  assert.equal(snap.examples.total, 3);

  const audiences = d.prepare("SELECT DISTINCT audience FROM evidence_learning_examples ORDER BY audience")
    .all().map((r) => r.audience);
  assert.deepEqual(audiences, ["DELIVERED", "OWNER_VALIDATION", "RESEARCH_ONLY"]);
});

test("a realized winner with too few marks keeps the win and loses only the peak", () => {
  const d = db();
  // Two marks: a realized +47.2103% is sound, but two moments cannot place an extreme.
  const id = seedTrade(d, { paperKind: "OWNER_VALIDATION_PAPER", returnPct: 47.2103, marks: [12, 47.2103] });

  const e = excursionForPaperTradeOnDb(d, id, OCC);
  assert.equal(e.state, "INSUFFICIENT_MARKS");
  assert.equal(e.mfePct, null);
  assert.equal(e.maePct, null);

  refreshEvidenceLearningOnDb(d, { nowMs: T0 + 900_000 });
  const row = d.prepare("SELECT final_return_pct, final_outcome, mfe_pct, mae_pct, missing_fields_json FROM evidence_learning_examples").get();

  assert.equal(row.final_return_pct, 47.2103, "the realized return survives intact");
  assert.equal(row.final_outcome, "WIN", "a weak excursion never demotes a realized winner");
  assert.equal(row.mfe_pct, null, "an unmeasured excursion is null, not a number");
  assert.equal(row.mae_pct, null);

  const missing = JSON.parse(row.missing_fields_json);
  assert.ok(missing.includes("mfePct"), "the AI is told the peak was not measured");
  assert.ok(missing.includes("maePct"));
});

test("a densely marked trade reports its excursion", () => {
  const d = db();
  const id = seedTrade(d, { paperKind: "OWNER_VALIDATION_PAPER", marks: [-8, 12, 47.2103, 30] });

  const e = excursionForPaperTradeOnDb(d, id, OCC);
  assert.equal(e.state, "VERIFIED_EXCURSION");
  assert.equal(e.mfePct, 47.2103);
  assert.equal(e.maePct, -8);

  refreshEvidenceLearningOnDb(d, { nowMs: T0 + 900_000 });
  const row = d.prepare("SELECT mfe_pct, mae_pct, missing_fields_json FROM evidence_learning_examples").get();
  assert.equal(row.mfe_pct, 47.2103);
  assert.equal(row.mae_pct, -8);
  assert.ok(!JSON.parse(row.missing_fields_json).includes("mfePct"));
});

test("marks on another contract cannot supply this trade's excursion", () => {
  const d = db();
  const id = seedTrade(d, { paperKind: "OWNER_VALIDATION_PAPER", marks: [-8, 12, 47.2103] });
  // A longer-dated strike's prices, recorded against the same trade id.
  for (const pct of [120, 185.4077, 160]) {
    d.prepare(
      `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms)
       VALUES (?,?,?,?,?)`,
    ).run(id, "O:QQQ260918C00750000", T0 + 900_000 + pct, pct, T0);
  }

  const e = excursionForPaperTradeOnDb(d, id, OCC);
  assert.equal(e.marksOnContract, 3, "only same-contract marks count");
  assert.equal(e.mfePct, 47.2103, "a foreign price cannot become this trade's peak");
});
