import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMarketSessionGuard,
  assertSubscriberDeliveryAllowed,
  assertSubscriberScanAllowed,
  isEarlyCloseDay,
  isSameTradingSession,
} from "../lib/market-session-guard.ts";

test("weekend is closed with no subscriber scan or delivery", () => {
  const sat = Date.parse("2026-07-25T15:00:00-04:00"); // Saturday
  const g = evaluateMarketSessionGuard(sat, {});
  assert.equal(g.subscriberScanAllowed, false);
  assert.equal(g.subscriberDeliveryAllowed, false);
  assert.match(g.state, /CLOSED/);
});

test("regular session Monday open allows scan and delivery", () => {
  const mon = Date.parse("2026-07-20T14:00:00-04:00"); // Mon 10:00 ET
  const g = evaluateMarketSessionGuard(mon, {});
  assert.equal(g.subscriberScanAllowed, true);
  assert.equal(g.subscriberDeliveryAllowed, true);
});

test("US market holiday Jul 3 2026 is closed", () => {
  const hol = Date.parse("2026-07-03T14:00:00-04:00");
  const g = evaluateMarketSessionGuard(hol, {});
  assert.equal(g.subscriberDeliveryAllowed, false);
  assert.match(g.state, /HOLIDAY|CLOSED/);
});

test("early close calendar includes 2026-11-27", () => {
  assert.equal(isEarlyCloseDay("2026-11-27", {}), true);
});

test("assertSubscriberDeliveryAllowed fails closed after regular close", () => {
  const after = Date.parse("2026-07-20T21:00:00-04:00"); // 9pm ET
  const r = assertSubscriberDeliveryAllowed(after, { MARKET_SESSION_GUARD: "enforce" });
  assert.equal(r.ok, false);
});

test("MARKET_SESSION_GUARD=0 bypasses enforcement helpers", () => {
  const after = Date.parse("2026-07-20T21:00:00-04:00");
  assert.equal(assertSubscriberScanAllowed(after, { MARKET_SESSION_GUARD: "0" }).ok, true);
  assert.equal(assertSubscriberDeliveryAllowed(after, { MARKET_SESSION_GUARD: "0" }).ok, true);
});

test("isSameTradingSession compares candidate date to current session", () => {
  const mon = Date.parse("2026-07-20T14:00:00-04:00");
  assert.equal(isSameTradingSession("2026-07-20", mon), true);
  assert.equal(isSameTradingSession("2026-07-19", mon), false);
  assert.equal(isSameTradingSession(null, mon), false);
});
