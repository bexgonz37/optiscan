import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { validateLifecycleQuote } from "../lib/research/options/lifecycle-session.ts";
import { formatReturnMilestoneUpdate } from "../lib/research/options/milestone-format.ts";
import { gradeOpenOptionPositionsOnDb } from "../lib/research/options/grade.ts";
import { assertOptionsOpeningSession } from "../lib/market-session-guard.ts";
import {
  formatEodWatchlist,
  ownerNotifyDestinationForKind,
} from "../lib/notifications/owner-research-notify.ts";

const OPEN = Date.parse("2026-07-29T19:57:00.000Z"); // 3:57 p.m. ET
const CLOSED = Date.parse("2026-07-29T20:12:00.000Z"); // 4:12 p.m. ET
const ENV = {
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  REAL_OPTION_PAPER_ENABLED: "1",
  OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "1",
  MARKET_SESSION_GUARD: "shadow",
};

function lifecycleDb() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT NOT NULL,
      side TEXT,
      strike REAL,
      expiration TEXT,
      dte INTEGER,
      entry_fill REAL,
      result_class TEXT NOT NULL,
      strategy TEXT,
      underlying_price REAL,
      target REAL,
      invalidation REAL,
      status TEXT NOT NULL,
      paper_kind TEXT,
      alert_id TEXT,
      exit_fill REAL,
      pnl REAL,
      return_pct REAL,
      exit_reason TEXT,
      exit_at_ms INTEGER,
      entered_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL,
      option_symbol TEXT NOT NULL,
      mark_at_ms INTEGER NOT NULL,
      bid REAL,
      ask REAL,
      exit_fill REAL,
      return_pct REAL,
      quote_age_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      UNIQUE(trade_id, mark_at_ms)
    );
    CREATE TABLE options_lifecycle_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_trade_id INTEGER,
      alert_id TEXT,
      option_symbol TEXT NOT NULL,
      event_type TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      quote_ts_ms INTEGER,
      observed_at_ms INTEGER NOT NULL,
      bid REAL,
      ask REAL,
      created_at_ms INTEGER NOT NULL
    );
  `);
  d.prepare(
    `INSERT INTO options_paper_trades
      (option_symbol,side,strike,expiration,dte,entry_fill,result_class,strategy,target,invalidation,
       status,paper_kind,alert_id,entered_at_ms,created_at_ms,updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "O:IREN260807P00015000",
    "put",
    15,
    "2026-08-07",
    7,
    1.95,
    "REAL_OPTION_PAPER",
    "vwap_rejection",
    2.86,
    1.17,
    "ENTERED",
    "DELIVERED_ALERT_PAPER",
    "oa_iren",
    OPEN - 30 * 60_000,
    OPEN - 30 * 60_000,
    OPEN - 30 * 60_000,
  );
  return d;
}

test("fresh 3:57 p.m. ET quote is a valid executable lifecycle event", () => {
  const result = validateLifecycleQuote({
    bid: 2.86,
    ask: 2.90,
    providerTimestamp: OPEN,
    observedAtMs: OPEN + 1_000,
    maxQuoteAgeMs: 60_000,
    env: ENV,
  });
  assert.equal(result.valid, true);
  assert.equal(result.eventAtMs, OPEN);
  assert.equal(result.delayedDelivery, false);
});

test("late delivery requires a milestone that was already persisted in-session", () => {
  const unproved = validateLifecycleQuote({
    bid: 2.86,
    ask: 2.90,
    providerTimestamp: OPEN,
    observedAtMs: CLOSED,
    maxQuoteAgeMs: 20 * 60_000,
    env: ENV,
  });
  assert.equal(unproved.valid, false);
  assert.equal(unproved.reason, "MARKET_CLOSED_OR_EVENT_TIME_UNVERIFIED");

  const proved = validateLifecycleQuote({
    bid: 2.86,
    ask: 2.90,
    providerTimestamp: OPEN,
    observedAtMs: Date.parse("2026-07-29T20:30:00.000Z"),
    maxQuoteAgeMs: 60_000,
    persistedEventAtMs: OPEN,
    persistedAtMs: OPEN + 2_000,
    env: ENV,
  });
  assert.equal(proved.valid, true);
  assert.equal(proved.delayedDelivery, true);
  assert.equal(proved.eventAtMs, OPEN, "queue replay never changes the event time");
});

test("post-close, future, and previous-session quotes cannot create a lifecycle event", () => {
  const postClose = validateLifecycleQuote({
    bid: 2.86,
    ask: 2.90,
    providerTimestamp: CLOSED,
    observedAtMs: CLOSED + 1_000,
    maxQuoteAgeMs: 60_000,
    env: ENV,
  });
  assert.equal(postClose.valid, false);
  assert.equal(postClose.reason, "QUOTE_OUTSIDE_OPTIONS_SESSION");

  const future = validateLifecycleQuote({
    bid: 2.86,
    ask: 2.90,
    providerTimestamp: OPEN + 60_000,
    observedAtMs: OPEN,
    maxQuoteAgeMs: 60_000,
    env: ENV,
  });
  assert.equal(future.valid, false);
  assert.equal(future.reason, "QUOTE_TIMESTAMP_IN_FUTURE");

  const previous = validateLifecycleQuote({
    bid: 2.86,
    ask: 2.90,
    providerTimestamp: Date.parse("2026-07-28T19:57:00.000Z"),
    observedAtMs: OPEN,
    maxQuoteAgeMs: 26 * 60 * 60_000,
    env: ENV,
  });
  assert.equal(previous.valid, false);
  assert.equal(previous.reason, "QUOTE_FROM_DIFFERENT_SESSION");
});

test("stale 4:12 p.m. mark and underlying-only movement cannot mutate paper or Discord", async () => {
  const d = lifecycleDb();
  let sends = 0;
  const result = await gradeOpenOptionPositionsOnDb(
    d,
    {
      now: () => CLOSED,
      getQuote: async () => ({
        bid: 2.86,
        ask: 2.90,
        quoteAgeMs: 1_000,
        providerTimestamp: CLOSED - 1_000,
      }),
      sendMilestone: async () => {
        sends += 1;
        return { ok: true, messageId: "should-not-send" };
      },
    },
    ENV,
  );
  assert.equal(result.graded, 0);
  assert.equal(result.held, 1);
  assert.equal(sends, 0);
  assert.equal(d.prepare("SELECT status FROM options_paper_trades").get().status, "ENTERED");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_marks").get().n, 0);
  const suppression = d.prepare(
    "SELECT decision, reason FROM options_lifecycle_observations ORDER BY id DESC LIMIT 1",
  ).get();
  assert.equal(suppression.decision, "SUPPRESSED");
  assert.equal(suppression.reason, "QUOTE_OUTSIDE_OPTIONS_SESSION");

  const noQuote = await gradeOpenOptionPositionsOnDb(
    d,
    { now: () => CLOSED, getQuote: async () => null },
    ENV,
  );
  assert.equal(noQuote.graded, 0, "underlying movement without an option quote cannot exit");
  assert.equal(d.prepare("SELECT status FROM options_paper_trades").get().status, "ENTERED");
});

test("delayed intraday copy states hit time and never implies a current executable mark", () => {
  const message = formatReturnMilestoneUpdate({
    symbol: "IREN",
    optionType: "PUT",
    strike: 15,
    milestonePercent: 46.6,
    summary: {
      frozenEntry: 1.95,
      currentMark: 2.86,
      currentReturnPct: 46.6,
    },
    eventLabel: "TARGET 1 HIT",
    eventAtMs: OPEN,
    deliveredAtMs: CLOSED,
    delayedDelivery: true,
  });
  assert.match(message, /Hit at: 3:57 p\.m\. ET/);
  assert.match(message, /Mark at hit: \$2\.86/);
  assert.match(message, /Delayed delivery after market close/);
  assert.doesNotMatch(message, /Current:/);
});

test("after-hours openings fail closed and planning remains Watchlist-only", () => {
  assert.equal(assertOptionsOpeningSession(CLOSED, ENV).ok, false);
  assert.equal(
    assertOptionsOpeningSession(CLOSED, { ...ENV, MARKET_SESSION_GUARD: "0" }).ok,
    false,
    "the hard opening boundary cannot be bypassed by a rollout flag",
  );
  assert.deepEqual(ownerNotifyDestinationForKind("next_session_watchlist"), {
    webhook: "watchlist",
    requiredEnv: "DISCORD_WEBHOOK_WATCHLIST",
    label: "watchlist",
  });
  const message = formatEodWatchlist({
    tradingDay: "2026-07-30",
    builtAtMs: CLOSED,
    planVersion: "test",
    marketContext: { spyNote: "mixed", qqqNote: "mixed", newsNote: null },
    recommendations: [{
      symbol: "IREN",
      bias: "bearish",
      setupFamily: "vwap_rejection",
      triggerLevel: 14.8,
      invalidationLevel: 15.3,
      preferredDteRange: "7-14 DTE",
      preferredMoneyness: "ATM",
      contractSelectionGuidance: "Verify after options open",
      confidence: 70,
      supportingEvidence: ["Bearish setup remains on watch"],
      mainRisk: "The stock may reclaim VWAP.",
      verifyContractAfterOpen: true,
      quoteContext: "STALE_PRIOR_SESSION",
      executable: false,
      rank: 1,
      priorContractContext: null,
      status: "VERIFY AT OPEN",
    }],
  });
  assert.match(message, /NEXT SESSION WATCHLIST/);
  assert.match(message, /VERIFY CONTRACT AFTER OPTIONS OPEN/);
  assert.doesNotMatch(message, /TRADE NOW/);
});
