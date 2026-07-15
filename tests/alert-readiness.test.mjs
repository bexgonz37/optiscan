import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildConfigVisibility } from "../lib/runtime-status.ts";
import { nightlyRunKey, weeklyRunKey, nextNightlyEligibleMs, nextWeeklyEligibleMs } from "../lib/ai/schedule.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }

const ALL_ON_ENV = {
  SUPERVISOR_RUNTIME: "1", CALLOUT_CANONICAL_PATH: "supervisor", AGENT_CALLOUT_DISCORD: "1",
  STOCK_CALLOUTS: "1", STOCK_EXTENDED_HOURS: "1",
};
const ALL_ON_EXTRAS = { optionsWebhookConfigured: true, stockWebhookConfigured: true, extendedStockNotify: true, session: "regular" };

// ── alert-readiness rollup ────────────────────────────────────────────────────
test("all gates on ⇒ options + stock + premarket all READY, no blockers", () => {
  const { readiness } = buildConfigVisibility(ALL_ON_ENV, ALL_ON_EXTRAS);
  assert.equal(readiness.optionsCallouts.ready, true);
  assert.deepEqual(readiness.optionsCallouts.blockedBy, []);
  assert.equal(readiness.stockCallouts.ready, true);
  assert.equal(readiness.premarketNotifications.ready, true);
  assert.equal(readiness.session, "regular");
});

test("everything off ⇒ each channel lists its exact blockers", () => {
  const { readiness } = buildConfigVisibility({}, { session: "closed" });
  assert.equal(readiness.optionsCallouts.ready, false);
  assert.deepEqual(readiness.optionsCallouts.blockedBy, [
    "SUPERVISOR_RUNTIME != 1",
    "CALLOUT_CANONICAL_PATH != supervisor",
    "AGENT_CALLOUT_DISCORD != 1",
    "DISCORD_WEBHOOK_OPTIONS missing",
  ]);
  assert.deepEqual(readiness.stockCallouts.blockedBy, ["STOCK_CALLOUTS != 1", "DISCORD_WEBHOOK_STOCKS missing"]);
  assert.ok(readiness.premarketNotifications.blockedBy.includes("extended_stock_notify setting off (enable in Settings)"));
  assert.ok(readiness.premarketNotifications.blockedBy.some((b) => /STOCK_EXTENDED_HOURS/.test(b)));
});

test("options-only gap: master switch on but webhook missing is reported", () => {
  const { readiness } = buildConfigVisibility(
    { SUPERVISOR_RUNTIME: "1", CALLOUT_CANONICAL_PATH: "supervisor", AGENT_CALLOUT_DISCORD: "1" },
    { optionsWebhookConfigured: false },
  );
  assert.equal(readiness.optionsCallouts.ready, false);
  assert.deepEqual(readiness.optionsCallouts.blockedBy, ["DISCORD_WEBHOOK_OPTIONS missing"]);
});

test("premarket blocked when stock on but extended-hours gates off", () => {
  const { readiness } = buildConfigVisibility(
    { STOCK_CALLOUTS: "1" },
    { stockWebhookConfigured: true, extendedStockNotify: false, session: "pre" },
  );
  assert.equal(readiness.stockCallouts.ready, true); // regular-hours stock is fine
  assert.equal(readiness.premarketNotifications.ready, false);
  assert.ok(readiness.premarketNotifications.blockedBy.some((b) => /STOCK_EXTENDED_HOURS/.test(b)));
  assert.ok(readiness.premarketNotifications.blockedBy.includes("extended_stock_notify setting off (enable in Settings)"));
});

test("config items now include a DISCORD_WEBHOOK_OPTIONS presence entry", () => {
  const { items } = buildConfigVisibility({}, { optionsWebhookConfigured: false });
  const item = items.find((i) => i.key === "DISCORD_WEBHOOK_OPTIONS");
  assert.ok(item, "DISCORD_WEBHOOK_OPTIONS item present");
  assert.equal(item.state, "missing");
  assert.ok(item.blocks.includes("options_alerts"));
});

// ── AI schedule: next eligible run (rising edge, TZ-safe) ──────────────────────
test("nextNightlyEligibleMs lands on a real nightly window opening", () => {
  const nowMs = Date.UTC(2026, 6, 15, 16, 0, 0); // Wed 12:00 ET-ish, before cutoff
  const next = nextNightlyEligibleMs(nowMs);
  assert.equal(typeof next, "number");
  assert.ok(next > nowMs);
  assert.ok(nightlyRunKey(next) != null, "the window is open at the returned ms");
  assert.ok(nightlyRunKey(next - 5 * 60_000) == null, "and it is a rising edge (closed 5 min earlier)");
});

test("nextWeeklyEligibleMs lands on a real weekly window opening", () => {
  const nowMs = Date.UTC(2026, 6, 15, 16, 0, 0); // Wednesday
  const next = nextWeeklyEligibleMs(nowMs);
  assert.equal(typeof next, "number");
  assert.ok(next > nowMs);
  assert.ok(weeklyRunKey(next) != null);
  assert.ok(weeklyRunKey(next - 5 * 60_000) == null);
});

// ── AI overview surfaces schedule + flags (real schema db) ─────────────────────
test("aiOverview exposes schedule (next run) + flags + cost against a fresh DB", { skip: !Database }, async () => {
  const { aiOverviewOnDb } = await import("../lib/ai/overview.ts");
  const schema = read("lib/db.ts").match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const db = new Database(":memory:");
  db.exec(schema);
  const o = aiOverviewOnDb(db, {}, Date.UTC(2026, 6, 15, 16, 0, 0));
  assert.equal(o.flags.enabled, false, "AI off by default");
  assert.equal(typeof o.schedule.nextNightlyEligibleMs, "number");
  assert.equal(typeof o.schedule.nextWeeklyEligibleMs, "number");
  assert.equal(o.schedule.lastNightlyDay, null, "no reports yet");
  assert.ok("spendUsd" in o.cost && "usage" in o.cost, "cost + token usage present");
  db.close();
});

// ── safe Discord test endpoint (explicit TEST message, auth-gated) ─────────────
test("/api/discord/test is auth-gated and supports both webhooks", () => {
  const route = read("app/api/discord/test/route.ts");
  assert.ok(/checkApiToken/.test(route), "auth-gated");
  assert.ok(/kind === "stocks"/.test(route), "supports stocks webhook");
});

test("sendDiscordTest sends an explicit TEST message, not a fabricated actionable alert", () => {
  const notif = read("lib/notifications.ts");
  const fn = notif.match(/export async function sendDiscordTest[\s\S]*?\n}/)[0];
  assert.ok(/test:.*channel is connected/i.test(fn), "explicit test line");
  assert.ok(/payloadType: "test"/.test(fn), "labeled as a test payload");
  assert.ok(!/capture_action|actionable|TRADE/i.test(fn), "no fabricated actionable-alert fields");
});
