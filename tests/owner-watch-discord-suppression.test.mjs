import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ownerWatchDiscordSuppressed,
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

const OWNER_WATCH = [
  "🔬 QQQ PUT · OWNER WATCH · OWNER_ONLY · NOT SUBSCRIBER-APPROVED",
  "",
  "QQQ 08/21 $713 Put",
].join("\n");

const baseEnv = {
  OWNER_RESEARCH_DISCORD_ENABLED: "1",
  OWNER_RESEARCH_INTRADAY_ENABLED: "1",
  DISCORD_WEBHOOK_OPTIONS: "https://discord.test/hook",
};

// On 2026-08-19 the owner received five OWNER WATCH observations in the actionable
// Alerts channel and zero actionable callouts. The observation is research; the
// channel is for trade notifications.

test("suppression is OFF by default", () => {
  assert.equal(ownerWatchDiscordSuppressed({}), false);
  assert.equal(ownerWatchDiscordSuppressed({ OWNER_WATCH_DISCORD_SUPPRESSED: "0" }), false);
  assert.equal(ownerWatchDiscordSuppressed({ OWNER_WATCH_DISCORD_SUPPRESSED: "1" }), true);
});

test("with suppression OFF an OWNER WATCH observation still posts (no silent change)", async () => {
  let posted = 0;
  const res = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "intraday_actionable",
    content: OWNER_WATCH,
    symbol: "fp:OPENING",
    researchObservation: true,
    env: { ...baseEnv },
    postOverride: async () => { posted += 1; return { ok: true, messageId: "m1", deliveryId: "d1" }; },
  });
  assert.equal(posted, 1, "unchanged until the owner opts in");
  assert.equal(res.sent, true);
});

test("with suppression ON the Discord post is skipped but the send still reports delivered", async () => {
  let posted = 0;
  const res = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "intraday_actionable",
    content: OWNER_WATCH,
    symbol: "fp:OPENING",
    researchObservation: true,
    env: { ...baseEnv, OWNER_WATCH_DISCORD_SUPPRESSED: "1" },
    postOverride: async () => { posted += 1; return { ok: true }; },
  });
  assert.equal(posted, 0, "nothing reaches the Alerts channel");
  // sent:true is load-bearing — a false here releases the opportunity opening
  // claim, which would break owner-mirror linkage and PRE_MOVE_DISCOVERY_V2.
  assert.equal(res.sent, true, "the opening lifecycle must still advance");
  assert.equal(res.skipped, false);
  assert.equal(res.reason, "owner_watch_discord_suppressed");
  assert.equal(res.messageId, null, "no Discord message exists to reference");
});

test("suppression never touches a notify that is not a research observation", async () => {
  let posted = 0;
  const res = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "intraday_actionable",
    content: "🟢 SPY CALL ALERT",
    symbol: "fp2:OPENING",
    // researchObservation omitted — a subscriber-grade callout
    env: { ...baseEnv, OWNER_WATCH_DISCORD_SUPPRESSED: "1" },
    postOverride: async () => { posted += 1; return { ok: true, messageId: "m2" }; },
  });
  assert.equal(posted, 1, "an actionable callout is never suppressed by this flag");
  assert.equal(res.sent, true);
});

test("suppression is idempotent per day like a real send", async () => {
  const db = notifyDb();
  const env = { ...baseEnv, OWNER_WATCH_DISCORD_SUPPRESSED: "1" };
  const opts = {
    db, kind: "intraday_actionable", content: OWNER_WATCH, symbol: "fp:OPENING",
    researchObservation: true, env, postOverride: async () => ({ ok: true }),
  };
  const first = await sendOwnerResearchNotify({ ...opts });
  const second = await sendOwnerResearchNotify({ ...opts });
  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.match(second.reason, /already sent/);
});

test("the owner-private opening path is marked as a research observation", () => {
  const dd = read("lib/research/options/delivery-decision.ts");
  assert.ok(/researchObservation: true/.test(dd), "sendOwnerPrivateOpening tags its notify");
  // Both callers of sendOwnerPrivateOpening are non-subscriber by construction.
  assert.ok(/readiness_gate:NOT_SUBSCRIBER_APPROVED/.test(dd));
});

test("suppressed observations are still written to the delivery ledger", () => {
  const n = read("lib/notifications/owner-research-notify.ts");
  assert.ok(/recordSuppressedOwnerNotify/.test(n), "a ledger row is recorded");
  assert.ok(/status: "SUPPRESSED"/.test(n), "with the established SUPPRESSED status");
  assert.ok(/payloadType: `owner_\$\{kind\}`/.test(n), "same payload_type so audits still find it");
});
