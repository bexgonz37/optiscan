import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatEodWatchlist,
  formatMarketOpenConfirm,
  formatPremarketPlan,
  ownerNotifyDestinationForKind,
  sendOwnerResearchNotify,
} from "../lib/notifications/owner-research-notify.ts";
import {
  markWatchlistVersionOnDb,
  persistWatchlistVersionOnDb,
} from "../lib/research/overnight/next-session-plan.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function db() {
  return new Database(":memory:");
}

function notifyDb() {
  const database = db();
  database.exec(`
    CREATE TABLE owner_research_notify_log (
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      sent_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, kind, symbol)
    );
  `);
  return database;
}

function plan(overrides = {}) {
  return {
    tradingDay: "2026-07-27",
    builtAtMs: Date.parse("2026-07-27T22:00:00.000Z"),
    planVersion: "test-plan",
    marketContext: {
      spyNote: "SPY closed above VWAP",
      qqqNote: "QQQ relative strength improving",
      newsNote: "NVDA earnings catalyst watch",
    },
    recommendations: [
      {
        symbol: "NVDA",
        bias: "bearish",
        setupFamily: "failed_breakout",
        triggerLevel: 171.5,
        invalidationLevel: 174.2,
        preferredDteRange: "1-7DTE",
        preferredMoneyness: "ATM",
        contractSelectionGuidance: "Verify exact contract after options open",
        confidence: 82,
        supportingEvidence: ["ranked bearish pressure", "earnings catalyst watch"],
        mainRisk: "gap reversal",
        verifyContractAfterOpen: true,
        quoteContext: "STALE_PRIOR_SESSION",
        executable: false,
        rank: 1,
        priorContractContext: null,
      },
      {
        symbol: "MSFT",
        bias: "bullish",
        setupFamily: "orb_continuation",
        triggerLevel: 515,
        invalidationLevel: 510,
        preferredDteRange: "1-7DTE",
        preferredMoneyness: "ATM",
        contractSelectionGuidance: "Verify exact contract after options open",
        confidence: 74,
        supportingEvidence: ["relative strength"],
        mainRisk: "index fade",
        verifyContractAfterOpen: true,
        quoteContext: "STALE_PRIOR_SESSION",
        executable: false,
        rank: 2,
        priorContractContext: null,
      },
    ],
    ...overrides,
  };
}

test("watchlist kinds route only to Watchlist webhook", () => {
  assert.equal(ownerNotifyDestinationForKind("next_session_watchlist").webhook, "watchlist");
  assert.equal(ownerNotifyDestinationForKind("premarket_watchlist_update").webhook, "watchlist");
  assert.equal(ownerNotifyDestinationForKind("market_open_revalidation").webhook, "watchlist");
});

test("watchlist message labels never use live alert wording", () => {
  const p = plan();
  const eod = formatEodWatchlist(p);
  const premarket = formatPremarketPlan(p);
  const open = formatMarketOpenConfirm(p, ["NVDA rank 3->1"]);
  assert.match(eod, /NEXT SESSION WATCHLIST/);
  assert.match(premarket, /PREMARKET WATCHLIST UPDATE/);
  assert.match(premarket, /VERIFY EXACT CONTRACT AFTER OPTIONS OPEN/);
  assert.match(open, /MARKET-OPEN REVALIDATION/);
  assert.match(open, /Confirm fresh bid\/ask/);
  for (const message of [eod, premarket, open]) {
    assert.doesNotMatch(message, /TRADE NOW|BEARISH TRADE CANDIDATE|VERIFIED OPTIONS ALERT|live entry/i);
  }
});

test("missing Watchlist webhook skips without falling back to Alerts or Recaps", async () => {
  let posted = 0;
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "premarket_watchlist_update",
    content: formatPremarketPlan(plan()),
    env: {
      OWNER_RESEARCH_DISCORD_ENABLED: "1",
      DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/options",
      DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/recap",
      DISCORD_WEBHOOK_WATCHLIST: "",
    },
    postOverride: async () => {
      posted += 1;
      return { ok: true };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /DISCORD_WEBHOOK_WATCHLIST not configured/);
  assert.equal(posted, 0);
});

test("canonical watchlist versions suppress unchanged duplicates", () => {
  const database = db();
  const first = persistWatchlistVersionOnDb(database, plan(), {
    kind: "next_session_watchlist",
    sourceWindow: "1800_et",
  });
  const second = persistWatchlistVersionOnDb(database, plan(), {
    kind: "next_session_watchlist",
    sourceWindow: "1800_et",
  });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  markWatchlistVersionOnDb(database, second.versionId, "SUPPRESSED_UNCHANGED", Date.parse("2026-07-27T22:05:00.000Z"));
  const row = database.prepare("SELECT status FROM watchlist_versions WHERE version_id=?").get(second.versionId);
  assert.equal(row.status, "SUPPRESSED_UNCHANGED");
});

test("meaningful watchlist delta sends when rank or symbols materially change", () => {
  const database = db();
  persistWatchlistVersionOnDb(database, plan(), {
    kind: "premarket_watchlist_update",
    sourceWindow: "0830_et",
  });
  const changedPlan = plan({
    recommendations: [
      { ...plan().recommendations[1], rank: 1 },
      { ...plan().recommendations[0], rank: 3 },
      { ...plan().recommendations[0], symbol: "TSLA", rank: 2, bias: "bullish", confidence: 67 },
    ],
  });
  const delta = persistWatchlistVersionOnDb(database, changedPlan, {
    kind: "market_open_revalidation",
    sourceWindow: "0935_0940_et",
    compareAnyKind: true,
  });
  assert.equal(delta.changed, true);
  assert.ok(delta.reasons.some((reason) => /symbol added TSLA|NVDA rank/.test(reason)));
});

test("scheduler source defines requested ET windows and holiday guard", () => {
  const sched = read("lib/scheduler.ts");
  assert.match(sched, /18 \* 60/);
  assert.match(sched, /8 \* 60 \+ 30/);
  assert.match(sched, /9 \* 60 \+ 35/);
  assert.match(sched, /isMarketHoliday/);
  assert.match(sched, /isEarlyCloseDay/);
  assert.match(sched, /DISCORD_WEBHOOK_WATCHLIST not configured/);
});
