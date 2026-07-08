import test from "node:test";
import assert from "node:assert/strict";
import { marketSession, isOptionsSession, isStockSession, isMarketHoliday } from "../lib/trading-session.ts";

// Fixed ET timestamps (offsets pin the instant regardless of runner TZ).
const et = (iso) => Date.parse(iso);

test("marketSession: weekday sessions (EDT, summer)", () => {
  // Mon 2026-07-06, UTC-4
  assert.equal(marketSession(et("2026-07-06T03:59:00-04:00")), "closed");     // pre-4am
  assert.equal(marketSession(et("2026-07-06T04:00:00-04:00")), "premarket");  // premarket open
  assert.equal(marketSession(et("2026-07-06T08:15:00-04:00")), "premarket");
  assert.equal(marketSession(et("2026-07-06T09:29:59-04:00")), "premarket");
  assert.equal(marketSession(et("2026-07-06T09:30:00-04:00")), "regular");    // opening bell
  assert.equal(marketSession(et("2026-07-06T12:00:00-04:00")), "regular");
  assert.equal(marketSession(et("2026-07-06T15:59:59-04:00")), "regular");
  assert.equal(marketSession(et("2026-07-06T16:00:00-04:00")), "afterhours"); // closing bell
  assert.equal(marketSession(et("2026-07-06T19:59:00-04:00")), "afterhours");
  assert.equal(marketSession(et("2026-07-06T20:00:00-04:00")), "closed");     // AH ends
  assert.equal(marketSession(et("2026-07-06T23:30:00-04:00")), "closed");
});

test("marketSession: DST-safe (EST, winter)", () => {
  // Mon 2026-01-12, UTC-5
  assert.equal(marketSession(et("2026-01-12T08:00:00-05:00")), "premarket");
  assert.equal(marketSession(et("2026-01-12T10:00:00-05:00")), "regular");
  assert.equal(marketSession(et("2026-01-12T17:00:00-05:00")), "afterhours");
  assert.equal(marketSession(et("2026-01-12T21:00:00-05:00")), "closed");
});

test("marketSession: weekends are closed all day", () => {
  assert.equal(marketSession(et("2026-07-04T10:00:00-04:00")), "closed"); // Sat
  assert.equal(marketSession(et("2026-07-05T10:00:00-04:00")), "closed"); // Sun
  assert.equal(marketSession(et("2026-07-05T05:00:00-04:00")), "closed"); // Sun premarket hours
});

test("isOptionsSession: RTH only — never premarket/afterhours/closed", () => {
  assert.equal(isOptionsSession(et("2026-07-06T10:00:00-04:00")), true);
  assert.equal(isOptionsSession(et("2026-07-06T08:00:00-04:00")), false); // premarket
  assert.equal(isOptionsSession(et("2026-07-06T17:00:00-04:00")), false); // afterhours
  assert.equal(isOptionsSession(et("2026-07-06T22:00:00-04:00")), false); // closed
  assert.equal(isOptionsSession(et("2026-07-04T12:00:00-04:00")), false); // weekend
});

test("isStockSession: extended hours only — never RTH or closed", () => {
  assert.equal(isStockSession(et("2026-07-06T08:00:00-04:00")), true);   // premarket
  assert.equal(isStockSession(et("2026-07-06T17:00:00-04:00")), true);   // afterhours
  assert.equal(isStockSession(et("2026-07-06T10:00:00-04:00")), false);  // RTH -> options
  assert.equal(isStockSession(et("2026-07-06T22:00:00-04:00")), false);  // closed
  assert.equal(isStockSession(et("2026-07-05T08:00:00-04:00")), false);  // Sunday premarket hours
});

test("sessions partition every weekday moment: options XOR stocks XOR closed", () => {
  for (let h = 0; h < 24; h++) {
    const ms = et(`2026-07-06T${String(h).padStart(2, "0")}:15:00-04:00`);
    const s = marketSession(ms);
    const flags = [isOptionsSession(ms), isStockSession(ms), s === "closed"];
    assert.equal(flags.filter(Boolean).length, 1, `hour ${h} ET must be exactly one mode (got ${s})`);
  }
});


// ── Exchange holidays (audit P1-7/T9) ───────────────────────────────────────

test("full-day holidays are closed all day", () => {
  // Fri 2026-07-03 — Independence Day observed
  assert.equal(marketSession(et("2026-07-03T10:30:00-04:00")), "closed");
  assert.equal(marketSession(et("2026-07-03T05:00:00-04:00")), "closed");
  assert.equal(marketSession(et("2026-07-03T17:00:00-04:00")), "closed");
  // Thu 2026-11-26 — Thanksgiving (EST)
  assert.equal(marketSession(et("2026-11-26T11:00:00-05:00")), "closed");
  // Fri 2026-12-25 — Christmas
  assert.equal(marketSession(et("2026-12-25T10:00:00-05:00")), "closed");
});

test("adjacent normal weekdays are unaffected", () => {
  assert.equal(marketSession(et("2026-07-02T10:30:00-04:00")), "regular");
  assert.equal(marketSession(et("2026-07-06T10:30:00-04:00")), "regular");
  assert.equal(marketSession(et("2026-11-27T11:00:00-05:00")), "regular"); // day after Thanksgiving (half-day traded, not modeled)
});

test("no options or stock sessions on a holiday", () => {
  assert.equal(isOptionsSession(et("2026-07-03T10:30:00-04:00")), false);
  assert.equal(isStockSession(et("2026-07-03T07:00:00-04:00")), false);
});

test("MARKET_HOLIDAYS env extends the set without a deploy", () => {
  const prev = process.env.MARKET_HOLIDAYS;
  process.env.MARKET_HOLIDAYS = "2026-08-14, 2026-08-17";
  assert.equal(isMarketHoliday("2026-08-14"), true);
  assert.equal(isMarketHoliday("2026-08-17"), true);
  assert.equal(marketSession(et("2026-08-14T10:30:00-04:00")), "closed");
  if (prev == null) delete process.env.MARKET_HOLIDAYS; else process.env.MARKET_HOLIDAYS = prev;
  assert.equal(isMarketHoliday("2026-08-14"), false);
});

test("built-in holiday table covers 2025-2027", () => {
  for (const d of ["2025-12-25", "2026-01-01", "2026-09-07", "2027-11-25"]) {
    assert.equal(isMarketHoliday(d), true, d);
  }
  assert.equal(isMarketHoliday("2026-07-07"), false);
});
