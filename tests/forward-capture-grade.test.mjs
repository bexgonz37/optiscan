import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { classifyStrategy } from "../lib/research/forward/schema.ts";
import { buildForwardRecommendation, persistForwardRecommendationOnDb, forwardRecId } from "../lib/research/forward/capture.ts";
import { gradeForwardOutcome, persistForwardOutcomeOnDb } from "../lib/research/forward/grade.ts";

function db() {
  const d = new Database(":memory:");
  const ddl = `
    CREATE TABLE IF NOT EXISTS forward_recommendations (rec_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, captured_at_ms INTEGER NOT NULL, trading_day TEXT NOT NULL, symbol TEXT NOT NULL, strategy_key TEXT NOT NULL, direction TEXT NOT NULL, side TEXT NOT NULL, production_eligible INTEGER NOT NULL, research_only INTEGER NOT NULL, underlying_price REAL NOT NULL, observed_at_ms INTEGER NOT NULL, contract_json TEXT, entry_zone_json TEXT, max_chase_pct REAL, confidence REAL, analog_count INTEGER, effective_sample INTEGER, catalyst TEXT, technical_state_json TEXT, gates_passed_json TEXT, rejection_reason TEXT, abstain_reason TEXT, outcome_basis TEXT, provenance_json TEXT, created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS forward_outcomes (rec_id TEXT NOT NULL, horizon TEXT NOT NULL, label_as_of_ms INTEGER NOT NULL, return_pct REAL, win INTEGER, mfe_pct REAL, mae_pct REAL, outcome_kind TEXT NOT NULL, created_at_ms INTEGER NOT NULL, UNIQUE(rec_id, horizon));`;
  d.exec(ddl); d.exec(ddl);
  return d;
}
const card = (over = {}) => ({
  recommend: true, ticker: "nvda", side: "CALL", productionEligible: true, researchOnly: false,
  contract: { optionSymbol: "O:NVDA260815C00135000", strike: 135, expiration: "2026-08-15", dte: 5, bid: 4.1, ask: 4.3, spreadPct: 4.7 },
  entryRange: [4.1, 4.3], confidence: 0.61, analogCount: 41, effectiveSample: 33,
  rejectionReason: null, abstainReason: null, outcomeBasis: "OBSERVED underlying / MODELED vehicle", ...over,
});
const ctx = { underlyingPrice: 134, observedAtMs: 1000, direction: "bullish", catalyst: "breakout", gatesPassed: ["spread", "oi"], maxChasePct: 0.5, backtestReportId: "phaseD_1" };

test("classifyStrategy buckets by direction × vehicle × tenor", () => {
  assert.equal(classifyStrategy({ direction: "bullish", vehicle: "call", dte: 0 }).key, "bullish_call_0dte");
  assert.equal(classifyStrategy({ direction: "bearish", vehicle: "put", dte: 5 }).key, "bearish_put_short");
  assert.equal(classifyStrategy({ direction: "bullish", vehicle: "call", dte: 30 }).key, "bullish_call_longer");
  assert.equal(classifyStrategy({ direction: "bullish", vehicle: "stock" }).key, "bullish_stock");
});

test("capture is immutable: written once, a second capture never overwrites", () => {
  const d = db();
  const rec = buildForwardRecommendation(card(), ctx, 2000);
  assert.equal(rec.recId, forwardRecId("NVDA", 2000, "bullish_call_short"));
  const r1 = persistForwardRecommendationOnDb(d, rec, 2000);
  assert.equal(r1.inserted, true);
  // a mutated re-capture at the SAME decision time must be ignored (immutability)
  const mutated = buildForwardRecommendation(card({ confidence: 0.99 }), ctx, 2000);
  const r2 = persistForwardRecommendationOnDb(d, mutated, 3000);
  assert.equal(r2.inserted, false);
  assert.equal(d.prepare("SELECT confidence FROM forward_recommendations WHERE rec_id=?").get(rec.recId).confidence, 0.61, "original preserved");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM forward_recommendations").get().n, 1);
});

test("gradeForwardOutcome is side-aware and forward-only", () => {
  const upBars = [{ t: 2000, o: 100, h: 101, l: 99.5, c: 100 }, { t: 3000, o: 100, h: 106, l: 100, c: 105 }];
  const call = gradeForwardOutcome({ recId: "r", side: "call", capturedAtMs: 1500, entryPrice: 100, horizon: "1d", forwardBars: upBars, horizonEndMs: 3000 });
  assert.ok(call && call.win && call.returnPct > 0, "call wins on an up move");
  const put = gradeForwardOutcome({ recId: "r", side: "put", capturedAtMs: 1500, entryPrice: 100, horizon: "1d", forwardBars: upBars, horizonEndMs: 3000 });
  assert.ok(put && !put.win && put.returnPct < 0, "put loses on the same up move (side-aware)");
});

test("grade refuses a window that is not reached, and persist refuses a look-ahead label", () => {
  const d = db();
  // horizon end not reached by the bars → null
  const partial = gradeForwardOutcome({ recId: "r", side: "call", capturedAtMs: 1500, entryPrice: 100, horizon: "1d", forwardBars: [{ t: 2000, o: 100, h: 100, l: 100, c: 100 }], horizonEndMs: 9999 });
  assert.equal(partial, null);
  // persist guard: label_as_of must be AFTER capture
  const refused = persistForwardOutcomeOnDb(d, 5000, { recId: "r", horizon: "1d", labelAsOfMs: 4000, returnPct: 1, win: true, mfePct: 1, maePct: 0, outcomeKind: "REAL_UNDERLYING" }, 6000);
  assert.equal(refused.refused, true);
  const ok = persistForwardOutcomeOnDb(d, 5000, { recId: "r", horizon: "1d", labelAsOfMs: 6000, returnPct: 1, win: true, mfePct: 1, maePct: 0, outcomeKind: "REAL_UNDERLYING" }, 7000);
  assert.equal(ok.inserted, true);
});
