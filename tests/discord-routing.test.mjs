import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDiscordRoutingRows } from "../lib/discord-routing.ts";
import {
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

test("routing taxonomy keeps actionable, research, recap, lifecycle, and content separate", () => {
  assert.equal(ownerNotifyDestinationForKind("intraday_actionable").webhook, "owner_actionable");
  assert.equal(ownerNotifyDestinationForKind("research_only_bearish").webhook, "owner_research");
  assert.equal(ownerNotifyDestinationForKind("blocked_candidate").webhook, "owner_research");
  assert.equal(ownerNotifyDestinationForKind("missed_opportunity").webhook, "owner_research");
  assert.equal(ownerNotifyDestinationForKind("shadow_insight").webhook, "owner_research");
  assert.equal(ownerNotifyDestinationForKind("eod_watchlist").webhook, "recap");
  assert.equal(ownerNotifyDestinationForKind("premarket_plan").webhook, "recap");
});

test("missing owner research webhook does not fall back to recap", async () => {
  let posted = 0;
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "research_only_bearish",
    content: "Research-only bearish setup",
    env: {
      OWNER_RESEARCH_DISCORD_ENABLED: "1",
      DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/recap-secret",
      DISCORD_WEBHOOK_OWNER_RESEARCH: "",
    },
    postOverride: async () => {
      posted += 1;
      return { ok: true };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /DISCORD_WEBHOOK_OWNER_RESEARCH not configured/);
  assert.equal(posted, 0);
});

test("owner research webhook sends research-only bearish candidate when configured", async () => {
  let posted = 0;
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "research_only_bearish",
    content: "Research-only bearish setup",
    env: {
      OWNER_RESEARCH_DISCORD_ENABLED: "1",
      DISCORD_WEBHOOK_OWNER_RESEARCH: "https://discord.com/api/webhooks/research-secret",
    },
    postOverride: async () => {
      posted += 1;
      return { ok: true };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(posted, 1);
});

test("recap messages require recap and do not use options fallback", async () => {
  let posted = 0;
  const result = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "eod_watchlist",
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

test("webhook resolver source supports lifecycle fallback and same-webhook duplicate checks", () => {
  const notifications = read("lib/notifications.ts");
  const mirror = read("lib/notifications/owner-intraday-mirror.ts");
  assert.match(notifications, /kind === "lifecycle"\) return env\.DISCORD_WEBHOOK_LIFECYCLE \?\? env\.DISCORD_WEBHOOK_OPTIONS/);
  assert.match(notifications, /kind === "owner_research"\) return env\.DISCORD_WEBHOOK_OWNER_RESEARCH/);
  assert.match(mirror, /ownerActionableWebhook\(env\) === optionsWebhook\(env\)/);
});

test("health routing table marks live actionables outside recap and research to owner research", () => {
  const rows = buildDiscordRoutingRows({
    webhooks: {
      options: true,
      recap: true,
      ownerResearch: false,
      ownerActionable: false,
      lifecycle: false,
      content: true,
    },
    lastOptionsSendAt: "2026-07-27T14:22:10.777Z",
  });
  const tradeNow = rows.find((r) => r.messageType === "TRADE NOW CANDIDATE");
  const ownerMirror = rows.find((r) => r.messageType === "Owner actionable mirror");
  const research = rows.find((r) => r.messageType.startsWith("Almost ready"));
  const recap = rows.find((r) => r.messageType.startsWith("EOD recap"));
  const content = rows.find((r) => r.messageType.startsWith("Content draft"));
  assert.ok(tradeNow);
  assert.equal(tradeNow.destination, "Options alert webhook");
  assert.equal(tradeNow.status, "READY");
  assert.doesNotMatch(tradeNow.destination, /recap/i);
  assert.match(ownerMirror?.error ?? "", /OWNER_ACTIONABLE/);
  assert.equal(research?.destination, "Owner research webhook");
  assert.equal(research?.status, "BLOCKED");
  assert.equal(recap?.destination, "Recap webhook");
  assert.equal(content?.destination, "Content webhook");
});

test("production code has no recap fallback for owner research or content drafts", () => {
  const ownerNotify = read("lib/notifications/owner-research-notify.ts");
  const contentRuntime = read("lib/content/content-drafts-runtime.ts");
  const daily = read("lib/research/options/daily-summary.ts");
  assert.doesNotMatch(ownerNotify, /DISCORD_WEBHOOK_RECAP\s*\|\|\s*env\.DISCORD_WEBHOOK_URL/);
  assert.doesNotMatch(ownerNotify, /if\s*\(kind\s*===\s*"intraday_actionable"\)[\s\S]{0,160}webhook:\s*"recap"/);
  assert.match(contentRuntime, /webhook:\s*"content"/);
  assert.doesNotMatch(contentRuntime, /webhook:\s*"recap"/);
  assert.doesNotMatch(daily, /:\s*"options"/, "daily summary must not fallback to options");
});

test("verified subscriber call and put delivery remain on options webhook", () => {
  const delivery = read("lib/research/options/delivery.ts");
  assert.match(delivery, /webhook:\s*"options"/);
  assert.match(delivery, /formatPrivateLiveAlert/);
});

test("lifecycle delivery uses lifecycle route with options fallback in resolver", () => {
  const grade = read("lib/research/options/grade.ts");
  assert.match(grade, /webhook:\s*"lifecycle"/);
});
