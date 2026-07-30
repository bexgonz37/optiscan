import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePeakAndExit } from "../lib/research/social/peak-reconciliation.ts";

const IN_SESSION = Date.parse("2026-07-29T15:00:00.000Z");
const env = { MARKET_HOLIDAYS: "" };
const mark = (bid, ask = bid, at = IN_SESSION) => ({ markAtMs: at, bid, ask, quoteAgeMs: 0, createdAtMs: at });

test("a contemporaneous executable exit can raise canonical peak without losing raw bid MFE", () => {
  const result = reconcilePeakAndExit({ frozenEntry: 2, trackedPct: 52, exitFill: 3.04, exitAtMs: IN_SESSION, status: "CLOSED", env, marks: [mark(3, 3.2)] });
  assert.equal(result.exitClass, "VERIFIED_EXECUTABLE_EXIT");
  assert.equal(result.highestVerifiedBidReturnPct, 50);
  assert.equal(result.canonicalPeakPct, 52);
  assert.ok(result.invariantOk);
});

test("unsupported, stale, after-hours, and future evidence cannot raise a peak", () => {
  const base = { frozenEntry: 2, trackedPct: 80, exitFill: 3.6, exitAtMs: IN_SESSION, status: "CLOSED", env };
  const unsupported = reconcilePeakAndExit({ ...base, marks: [mark(3, 3.1, IN_SESSION - 10 * 60_000)] });
  assert.equal(unsupported.usableForPublicDrafts, false);
  const stale = reconcilePeakAndExit({ ...base, marks: [{ ...mark(3, 3.1), quoteAgeMs: 9999999 }] });
  assert.equal(stale.usableForPublicDrafts, false);
  const afterHours = reconcilePeakAndExit({ ...base, exitAtMs: Date.parse("2026-07-29T20:15:00.000Z"), marks: [mark(3.6)] });
  assert.equal(afterHours.exitClass, "AFTER_HOURS_EXIT");
  const future = reconcilePeakAndExit({ ...base, marks: [{ ...mark(3.6), createdAtMs: IN_SESSION - 1 }] });
  assert.equal(future.usableForPublicDrafts, false);
});
