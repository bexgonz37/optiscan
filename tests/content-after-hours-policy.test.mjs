/**
 * content-after-hours-policy.test.mjs — after-hours content must be suppressed for
 * being STALE, never merely for the market being shut.
 *
 * Found by reconciling the 87 SUPPRESSED_STALE_RESEARCH rows in production: the
 * first version of this rule treated any draft outside underlying RTH as stale,
 * which archived NEXT_SESSION_WATCH — the one category that exists specifically to
 * be read after the close.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyContentDeliveryPolicy } from "../lib/content/content-drafts-runtime.ts";

const RTH = Date.parse("2026-08-05T17:00:00Z");      // 13:00 ET, open
const CLOSED = Date.parse("2026-08-05T22:00:00Z");   // 18:00 ET, closed
const DAY = "2026-08-05";

const at = (nowMs, over = {}) => classifyContentDeliveryPolicy({
  category: "NEXT_SESSION_WATCH",
  symbol: "SPY",
  expiration: null,
  sessionDate: DAY,
  eventOccurredAtMs: nowMs - 60_000,
  nowMs,
  ...over,
});

test("a next-session watch is delivered after the close, not archived", () => {
  const r = at(CLOSED);
  assert.equal(r.policy, "DELIVER_NEXT_SESSION_WATCH");
});

test("after-hours categories still archive when the draft itself is stale", () => {
  // Cross-session: generated on a previous trading day.
  assert.equal(at(CLOSED, { sessionDate: "2026-08-03" }).policy, "ARCHIVE_STALE_RESEARCH");
  // Expired contract.
  assert.equal(at(CLOSED, { expiration: "2026-08-04" }).policy, "ARCHIVE_STALE_RESEARCH");
  // Past its delivery window.
  assert.equal(at(CLOSED, { eventOccurredAtMs: CLOSED - 90 * 60_000 }).policy, "ARCHIVE_STALE_RESEARCH");
  // No timestamp at all — cannot prove freshness, so it must not go out.
  assert.equal(at(CLOSED, { eventOccurredAtMs: null }).policy, "ARCHIVE_STALE_RESEARCH");
});

test("a live-looking research category is still archived after the close", () => {
  // HIGH_CONVICTION reads as a current call to action, so the close must suppress it.
  const r = at(CLOSED, { category: "HIGH_CONVICTION" });
  assert.equal(r.policy, "ARCHIVE_STALE_RESEARCH");
});

test("live-looking research still delivers during RTH inside its window", () => {
  assert.equal(at(RTH, { category: "HIGH_CONVICTION" }).policy, "DELIVER_CURRENT_RESEARCH");
});

test("verified performance content becomes a labelled historical report card", () => {
  const r = at(CLOSED, { category: "CLOSED_WINNER" });
  assert.equal(r.policy, "DELIVER_HISTORICAL_REPORT_CARD");
});

test("performance content generated during RTH is still current", () => {
  assert.equal(at(RTH, { category: "CLOSED_WINNER" }).policy, "DELIVER_CURRENT_RESEARCH");
});

test("the after-hours lane is labelled NON-ACTIONABLE in the delivered body", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "lib/content/content-drafts-runtime.ts"),
    "utf8",
  );
  assert.match(src, /DELIVER_NEXT_SESSION_WATCH[^]*NEXT-SESSION WATCH - NON-ACTIONABLE/,
    "the next-session lane must announce that it is not a live entry");
  assert.match(src, /The options market is closed\./,
    "the label must state the session is closed");
});
