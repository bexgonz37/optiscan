import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  independentOwnsSubscriberOptionsDiscord,
  supervisorOptionsDiscordBlocked,
} from "../lib/subscriber-discord-owner.ts";
import { supervisorDiscordDeliveryEnabled } from "../lib/callouts/routing.ts";
import { buildSubscriberClaimPacket } from "../lib/research/options/subscriber-claims.ts";
import { DEFAULT_RETURN_MILESTONES } from "../lib/opportunity-case/milestones.ts";
import { buildMilestoneDraftText } from "../lib/social-drafts.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  Database = null;
}

test("independent owner blocks supervisor options Discord", () => {
  const env = { SUBSCRIBER_OPTIONS_DISCORD_OWNER: "independent", CALLOUT_CANONICAL_PATH: "supervisor", AGENT_CALLOUT_DISCORD: "1" };
  assert.equal(independentOwnsSubscriberOptionsDiscord(env), true);
  assert.equal(supervisorOptionsDiscordBlocked(env), true);
  assert.equal(supervisorDiscordDeliveryEnabled(env), false);
});

test("discord routes require auth helper", () => {
  assert.match(read("app/api/discord/deliveries/route.ts"), /requireApiToken/);
  assert.match(read("app/api/discord/retry-failed/route.ts"), /requireApiToken/);
  assert.match(read("app/api/discord/health/route.ts"), /requireApiToken/);
  assert.match(read("app/api/system/overview/route.ts"), /requireApiToken/);
  assert.match(read("app/api/opportunities/route.ts"), /requireApiToken/);
});

test("default milestones are 20/30/50/75/100", () => {
  assert.deepEqual([...DEFAULT_RETURN_MILESTONES], [20, 30, 50, 75, 100]);
});

test("milestone draft never implies every subscriber max return", () => {
  const text = buildMilestoneDraftText({
    symbol: "NVDA",
    milestonePercent: 50,
    frozenEntry: 1.2,
    alertTimePt: "7:12 AM",
    subscribeUrl: "https://example.com/subscribe",
    unrealized: true,
  });
  assert.match(text, /frozen Discord entry/);
  assert.match(text, /not financial advice/i);
  assert.doesNotMatch(text, /every subscriber/i);
});

test("claim gate rejects non-SENT alert", { skip: !Database }, () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT, state TEXT, entry_mid REAL, sent_at_ms INTEGER,
      option_symbol TEXT, side TEXT, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT,
      discord_message_id TEXT, opportunity_case_id TEXT
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY, alert_id TEXT, paper_kind TEXT, entry_fill REAL, status TEXT,
      option_symbol TEXT, side TEXT, strike REAL, expiration TEXT, return_pct REAL, mfe_pct REAL, mae_pct REAL,
      exit_reason TEXT, last_mark_return_pct REAL
    );
  `);
  db.prepare(`INSERT INTO options_alerts (alert_id, candidate_symbol, state, entry_mid) VALUES ('a1','NVDA','READY',1.5)`).run();
  const packet = buildSubscriberClaimPacket(db, "a1");
  assert.equal(packet.ok, false);
  assert.match(packet.reason ?? "", /not SENT/);
});

test("claim gate accepts SENT + DELIVERED mirror", { skip: !Database }, () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT, state TEXT, entry_mid REAL, sent_at_ms INTEGER,
      option_symbol TEXT, side TEXT, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT,
      discord_message_id TEXT, opportunity_case_id TEXT
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY, alert_id TEXT, paper_kind TEXT, entry_fill REAL, status TEXT,
      option_symbol TEXT, side TEXT, strike REAL, expiration TEXT, return_pct REAL, mfe_pct REAL, mae_pct REAL,
      exit_reason TEXT, last_mark_return_pct REAL
    );
  `);
  db.prepare(`INSERT INTO options_alerts (alert_id, candidate_symbol, state, entry_mid, sent_at_ms, discord_message_id) VALUES ('a2','NVDA','SENT',1.5,1000,'msg1')`).run();
  db.prepare(`INSERT INTO options_paper_trades (id, alert_id, paper_kind, entry_fill, status, option_symbol, side) VALUES (1,'a2','DELIVERED_ALERT_PAPER',1.5,'ENTERED','O:NVDA','call')`).run();
  const packet = buildSubscriberClaimPacket(db, "a2");
  assert.equal(packet.ok, true);
  assert.equal(packet.frozenEntry, 1.5);
});

test("polygon grader reserve env documented", () => {
  assert.match(read(".env.railway.example"), /POLYGON_GRADER_DAILY_RESERVE/);
  assert.match(read("lib/polygon-provider.js"), /graderDailyReserve/);
});

test("social drafts API wired", () => {
  assert.match(read("app/api/social-drafts/route.ts"), /never auto-posted/);
  assert.match(read("app/social-drafts/page.tsx"), /never auto-posted/);
});

test("billing webhook route exists", () => {
  assert.match(read("app/api/billing/stripe-webhook/route.ts"), /verifyStripeWebhookSignature/);
});
