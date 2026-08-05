import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateInstrumentSession,
  optionsSessionAllowsStrategy,
} from "../lib/instrument-session-authority.ts";
import { revalidateOptionsDelivery } from "../lib/options-delivery-revalidation.ts";

const at = (iso) => Date.parse(iso);

test("ordinary equity options close at 4:00 ET", () => {
  const before = evaluateInstrumentSession({ symbol: "NVDA", optionSymbol: "O:NVDA260807C00200000" }, at("2026-08-04T19:59:59Z"));
  const after = evaluateInstrumentSession({ symbol: "NVDA", optionSymbol: "O:NVDA260807C00200000" }, at("2026-08-04T20:00:00Z"));
  assert.equal(before.optionsState, "OPTIONS_REGULAR_OPEN");
  assert.equal(after.optionsState, "OPTIONS_CLOSED");
  assert.equal(after.underlyingState, "UNDERLYING_EXTENDED_HOURS");
});

test("SPY/QQQ/IWM are distinguished as 4:15 classes", () => {
  for (const symbol of ["SPY", "QQQ", "IWM"]) {
    const open = evaluateInstrumentSession({ symbol }, at("2026-08-04T20:05:00Z"));
    const closed = evaluateInstrumentSession({ symbol }, at("2026-08-04T20:15:00Z"));
    assert.equal(open.optionsState, "OPTIONS_EXTENDED_SESSION_OPEN", symbol);
    assert.equal(closed.optionsState, "OPTIONS_CLOSED", symbol);
    assert.equal(optionsSessionAllowsStrategy(open, ["regular"]), false, "regular-only strategy cannot use the 4:15 window");
    assert.equal(optionsSessionAllowsStrategy(open, ["extended"]), true, "an explicitly extended strategy may use it");
  }
});

test("Cboe GTH index products are classified separately and 0DTE fails closed after RTH", () => {
  const gth = evaluateInstrumentSession({ symbol: "SPX", optionSymbol: "O:SPX260807C06500000" }, at("2026-08-05T01:00:00Z"));
  assert.equal(gth.optionsState, "OPTIONS_EXTENDED_SESSION_OPEN");
  const expiring = evaluateInstrumentSession({ symbol: "SPXW", optionSymbol: "O:SPXW260804C06500000" }, at("2026-08-04T20:05:00Z"));
  assert.equal(expiring.optionsState, "OPTIONS_CLOSED");
});

test("a delayed regular-session option delivery is revalidated instead of replayed", () => {
  const context = {
    symbol: "NVDA", optionSymbol: "O:NVDA260807C00200000", expiration: "2026-08-07",
    candidateAtMs: at("2026-08-04T19:59:50Z"), quoteAtMs: at("2026-08-04T19:59:55Z"),
    strategySessions: ["regular"], maxCandidateAgeMs: 90_000, maxQuoteAgeMs: 90_000,
  };
  const r = revalidateOptionsDelivery(context, at("2026-08-04T20:00:01Z"));
  assert.equal(r.ok, false);
  assert.equal(r.primaryCause, "AFTER_HOURS_REPROCESSING");
});

test("an old or context-free queue item cannot become a live option alert", () => {
  assert.equal(revalidateOptionsDelivery(null, at("2026-08-04T15:00:00Z")).primaryCause, "SESSION_CLASSIFICATION_FAILURE");
  const r = revalidateOptionsDelivery({
    symbol: "NVDA", optionSymbol: "O:NVDA260807C00200000",
    candidateAtMs: at("2026-08-04T14:55:00Z"), quoteAtMs: at("2026-08-04T14:59:59Z"),
    strategySessions: ["regular"], maxCandidateAgeMs: 90_000, maxQuoteAgeMs: 90_000,
  }, at("2026-08-04T15:00:00Z"));
  assert.equal(r.ok, false);
  assert.equal(r.primaryCause, "STALE_CAPTURE");
});
