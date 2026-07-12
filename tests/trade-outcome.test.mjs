import test from "node:test";
import assert from "node:assert/strict";
import { gradeOutcome, terminalKind, breakevenToleranceDollars, OUTCOME_VERSION } from "../lib/trade-outcome.ts";

const T0 = Date.parse("2026-07-09T14:00:00Z");
const T1 = T0 + 12 * 60_000;

const filled = (over = {}) => ({
  filled: true, terminal: true,
  entryPrice: 1.00, exitPrice: 1.20, quantity: 1, multiplier: 100, direction: 1,
  entryFees: 0.65, exitFees: 0.65, entrySlippage: 0.02, exitSlippage: 0.02,
  riskAmount: 35, mfePct: 30, maePct: -5, entryAtMs: T0, exitAtMs: T1,
  ...over,
});

// (16) positive gross but negative net ⇒ LOSS
test("positive gross that goes negative after fees is a LOSS", () => {
  // gross = (1.01 − 1.00) * 100 = 1.00; fees = 3.00 ⇒ net = −2.00
  const g = gradeOutcome(filled({ exitPrice: 1.01, entryFees: 1.5, exitFees: 1.5 }));
  assert.equal(g.grossPnl, 1.0);
  assert.equal(g.netPnl, -2.0);
  assert.equal(g.grade, "LOSS");
});

// (17) breakeven tolerance is deterministic + configurable
test("breakeven tolerance is deterministic and classifies within band as BREAKEVEN", () => {
  assert.equal(breakevenToleranceDollars({}), 0.5);
  assert.equal(breakevenToleranceDollars({ OUTCOME_BREAKEVEN_TOLERANCE_DOLLARS: "2" }), 2);
  // net = gross(0.30*100=30... ) — craft a tiny net within default 0.5 tolerance:
  // entry 1.00 exit 1.013 → gross 1.30; fees 0.65+0.65=1.30 → net 0.00 → BREAKEVEN
  const g = gradeOutcome(filled({ exitPrice: 1.013, entryFees: 0.65, exitFees: 0.65 }));
  assert.ok(Math.abs(g.netPnl) <= 0.5);
  assert.equal(g.grade, "BREAKEVEN");
});

test("clear net winner is WIN, clear net loser is LOSS", () => {
  assert.equal(gradeOutcome(filled({ exitPrice: 1.5 })).grade, "WIN");
  assert.equal(gradeOutcome(filled({ exitPrice: 0.5 })).grade, "LOSS");
});

// (18) missing entry price ⇒ UNGRADABLE
test("missing entry price produces UNGRADABLE", () => {
  const g = gradeOutcome(filled({ entryPrice: null }));
  assert.equal(g.grade, "UNGRADABLE");
  assert.equal(g.gradingStatus, "UNGRADABLE");
  assert.ok(g.dataQualityReasons.includes("missing_entry_price"));
  assert.equal(g.netPnl, null);
});

// (19) missing exit price ⇒ UNGRADABLE
test("missing exit price produces UNGRADABLE", () => {
  const g = gradeOutcome(filled({ exitPrice: null }));
  assert.equal(g.grade, "UNGRADABLE");
  assert.ok(g.dataQualityReasons.includes("missing_exit_price"));
});

// (20) missing/stale exit data represented honestly (not silently dropped)
test("ungradable outcome still returns a record with reasons", () => {
  const g = gradeOutcome(filled({ exitPrice: null, exitAtMs: null }));
  assert.equal(g.gradingStatus, "UNGRADABLE");
  assert.equal(g.dataQualityStatus, "INCOMPLETE");
  assert.ok(g.dataQualityReasons.length >= 1);
  assert.equal(g.outcomeVersion, OUTCOME_VERSION);
});

// (21) fees included once; slippage not double-counted
test("net = gross − fees exactly (slippage already embedded, not subtracted again)", () => {
  const g = gradeOutcome(filled({ exitPrice: 1.5, entryFees: 0.65, exitFees: 0.65, entrySlippage: 0.05, exitSlippage: 0.05 }));
  // gross = 0.50*100 = 50; net = 50 − 1.30 = 48.70 (slippage NOT re-subtracted)
  assert.equal(g.grossPnl, 50);
  assert.equal(g.netPnl, 48.7);
  assert.equal(g.entrySlippage, 0.05); // surfaced for transparency
});

// (22) R multiple uses immutable risk amount
test("R multiple uses the immutable recorded risk amount", () => {
  const g = gradeOutcome(filled({ exitPrice: 1.5, entryFees: 0, exitFees: 0, riskAmount: 50 }));
  assert.equal(g.netPnl, 50);
  assert.equal(g.rMultiple, 1); // 50 / 50
  const noRisk = gradeOutcome(filled({ riskAmount: null }));
  assert.equal(noRisk.rMultiple, null);
  assert.ok(noRisk.dataQualityReasons.includes("risk_amount_missing"));
});

// (23) MFE/MAE pass through as recorded (never invented)
test("MFE and MAE are carried through from recorded marks only", () => {
  const g = gradeOutcome(filled({ mfePct: 42, maePct: -18 }));
  assert.equal(g.mfePct, 42);
  assert.equal(g.maePct, -18);
  const missing = gradeOutcome(filled({ mfePct: null, maePct: undefined }));
  assert.equal(missing.mfePct, null);
  assert.equal(missing.maePct, null);
});

// (24) legacy trade data is flagged, not fabricated
test("legacy trades are graded but flagged LEGACY_LIMITED", () => {
  const g = gradeOutcome(filled({ legacy: true, exitPrice: 1.5 }));
  assert.equal(g.grade, "WIN");
  assert.equal(g.dataQualityStatus, "LEGACY_LIMITED");
});

test("terminalKind maps states deterministically", () => {
  assert.equal(terminalKind("STOPPED_OUT", null), "STOP");
  assert.equal(terminalKind("TAKE_PROFIT", null), "TARGET");
  assert.equal(terminalKind("EXPIRED", null), "EXPIRATION");
  assert.equal(terminalKind("EXITED", "manual: closed by user"), "MANUAL");
  assert.equal(terminalKind("EXITED", "smart: thesis invalidated"), "SMART");
});
