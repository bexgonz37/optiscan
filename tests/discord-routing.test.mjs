import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDiscordRoutingRows } from "../lib/discord-routing.ts";
import {
  formatMarketOpenConfirm,
  ownerNotifyDestinationForKind,
  sendOwnerResearchNotify,
} from "../lib/notifications/owner-research-notify.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function notifyDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE owner_research_notify_log (
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      sent_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, kind, symbol)
    );
  `);
  return db;
}

test("routing taxonomy uses Alerts Watchlist and Recaps channels", () => {
  assert.equal(ownerNotifyDestinationForKind("intraday_actionable").webhook, "options");
  assert.equal(ownerNotifyDestinationForKind("research_only_bearish").webhook, "recap");
  assert.equal(ownerNotifyDestinationForKind("blocked_candidate").webhook, "recap");
  assert.equal(ownerNotifyDestinationForKind("missed_opportunity").webhook, "recap");
  assert.equal(ownerNotifyDestinationForKind("shadow_insight").webhook, "recap");
  assert.equal(ownerNotifyDestinationForKind("next_session_watchlist").webhook, "watchlist");
  assert.equal(ownerNotifyDestinationForKind("premarket_watchlist_update").webhook, "watchlist");
  assert.equal(ownerNotifyDestinationForKind("market_open_revalidation").webhook, "watchlist");
});

test("research and missed opportunity messages require recap", async () => {
  let posted = 0;
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "research_only_bearish",
    content: "Research-only bearish setup",
    env: {
      OWNER_RESEARCH_DISCORD_ENABLED: "1",
      DISCORD_WEBHOOK_RECAP: "",
    },
    postOverride: async () => {
      posted += 1;
      return { ok: true };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /DISCORD_WEBHOOK_RECAP not configured/);
  assert.equal(posted, 0);
});

test("recap webhook sends research-only bearish candidate when configured", async () => {
  let posted = 0;
  let postedContent = "";
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "research_only_bearish",
    content: "Research-only bearish setup",
    env: {
      OWNER_RESEARCH_DISCORD_ENABLED: "1",
      DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/recap-secret",
    },
    postOverride: async (content) => {
      posted += 1;
      postedContent = content;
      return { ok: true };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(posted, 1);
  assert.match(postedContent, /RESEARCH/);
  assert.match(postedContent, /Not executable/i);
});

test("watchlist notifications reject live alert wording", async () => {
  let posted = 0;
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "market_open_revalidation",
    content: "TRADE NOW CANDIDATE on SPY",
    env: {
      OWNER_RESEARCH_DISCORD_ENABLED: "1",
      DISCORD_WEBHOOK_WATCHLIST: "https://discord.com/api/webhooks/watchlist-secret",
    },
    postOverride: async () => {
      posted += 1;
      return { ok: true };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /live-alert language/);
  assert.equal(posted, 0);
});

test("market-open revalidation watchlist does not use TRADE NOW wording", () => {
  const plan = {
    tradingDay: "2026-07-27",
    planVersion: "test",
    marketContext: { spyNote: "SPY note", qqqNote: "QQQ note" },
    recommendations: [],
  };
  const msg = formatMarketOpenConfirm(plan);
  assert.match(msg, /WATCHLIST/);
  assert.match(msg, /Not executable/);
  assert.doesNotMatch(msg, /TRADE NOW/);
});

test("actionable owner notifications require alerts webhook and never use recap only", async () => {
  let posted = 0;
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "intraday_actionable",
    content: "TRADE NOW CANDIDATE",
    symbol: "SPY",
    env: {
      OWNER_RESEARCH_DISCORD_ENABLED: "1",
      OWNER_RESEARCH_INTRADAY_ENABLED: "1",
      DISCORD_WEBHOOK_OPTIONS: "",
      DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/recap-secret",
    },
    postOverride: async () => {
      posted += 1;
      return { ok: true };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /DISCORD_WEBHOOK_OPTIONS not configured/);
  assert.equal(posted, 0);
});

test("recap messages require recap and do not use options fallback", async () => {
  let posted = 0;
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "missed_opportunity",
    content: "EOD recap",
    env: {
      OWNER_RESEARCH_DISCORD_ENABLED: "1",
      DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/options-secret",
      DISCORD_WEBHOOK_RECAP: "",
    },
    postOverride: async () => {
      posted += 1;
      return { ok: true };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /DISCORD_WEBHOOK_RECAP not configured/);
  assert.equal(posted, 0);
});

test("watchlist messages require watchlist and do not fallback to alerts or recaps", async () => {
  let posted = 0;
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "next_session_watchlist",
    content: "NEXT SESSION WATCHLIST\nWATCH only",
    env: {
      OWNER_RESEARCH_DISCORD_ENABLED: "1",
      DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/options-secret",
      DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/recap-secret",
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

test("webhook resolver source exposes options stocks watchlist recap and default kinds", () => {
  const notifications = read("lib/notifications.ts");
  const mirror = read("lib/notifications/owner-intraday-mirror.ts");
  assert.doesNotMatch(notifications, /owner_research|owner_actionable|DISCORD_WEBHOOK_OWNER|DISCORD_WEBHOOK_LIFECYCLE|DISCORD_WEBHOOK_CONTENT/);
  assert.match(mirror, /canonical_options_alert_already_sent/);
});

test("health routing table marks Alerts Watchlist and Recaps", () => {
  const rows = buildDiscordRoutingRows({
    webhooks: {
      options: true,
      watchlist: true,
      recap: true,
    },
    lastOptionsSendAt: "2026-07-27T14:22:10.777Z",
    lastWatchlistSendAt: "2026-07-27T22:00:00.000Z",
    nextWatchlistWindow: "NEXT SESSION WATCHLIST at 2026-07-28T22:00:00.000Z",
  });
  const alerts = rows.find((r) => r.messageType === "Alerts");
  const watchlist = rows.find((r) => r.messageType === "Watchlist");
  const recaps = rows.find((r) => r.messageType === "Recaps");
  assert.equal(rows.length, 3);
  assert.equal(alerts?.destination, "Alerts webhook (DISCORD_WEBHOOK_OPTIONS)");
  assert.match(alerts?.categories ?? "", /TRADE NOW/);
  assert.match(alerts?.categories ?? "", /BEARISH TRADE CANDIDATE/);
  assert.equal(watchlist?.destination, "Watchlist webhook (DISCORD_WEBHOOK_WATCHLIST)");
  assert.match(watchlist?.categories ?? "", /premarket refresh/);
  assert.equal(watchlist?.nextScheduledWindow, "NEXT SESSION WATCHLIST at 2026-07-28T22:00:00.000Z");
  assert.equal(recaps?.destination, "Recap webhook (DISCORD_WEBHOOK_RECAP)");
  assert.match(recaps?.categories ?? "", /content drafts/);
  assert.equal(rows.some((r) => /owner|lifecycle webhook|content webhook/i.test(`${r.messageType} ${r.destination} ${r.error ?? ""}`)), false);
});

test("production code routes content drafts to recap and keeps daily summary off Alerts", () => {
  const ownerNotify = read("lib/notifications/owner-research-notify.ts");
  const contentRuntime = read("lib/content/content-drafts-runtime.ts");
  const daily = read("lib/research/options/daily-summary.ts");
  assert.match(ownerNotify, /requiredEnv: "DISCORD_WEBHOOK_OPTIONS"/);
  assert.match(ownerNotify, /requiredEnv: "DISCORD_WEBHOOK_WATCHLIST"/);
  assert.match(ownerNotify, /requiredEnv: "DISCORD_WEBHOOK_RECAP"/);
  assert.match(contentRuntime, /webhook:\s*"recap"/);
  assert.doesNotMatch(contentRuntime, /webhook:\s*"content"/);
  assert.doesNotMatch(daily, /:\s*"options"/, "daily summary must not fallback to options");
});

test("verified subscriber call and put delivery remain on options webhook", () => {
  const delivery = read("lib/research/options/delivery.ts");
  assert.match(delivery, /webhook:\s*"options"/);
  assert.match(delivery, /formatPrivateLiveAlert/);
});

test("lifecycle delivery uses Alerts route", () => {
  const grade = read("lib/research/options/grade.ts");
  assert.match(grade, /webhook:\s*"options"/);
});
