import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { isMilestoneDiscordEligibleOnDb, resetMilestoneEligibleDefaultForTests, milestoneEligibleAfterMs } from "../lib/opportunity-case/milestone-eligibility.ts";

test("milestone eligibility blocks historical alerts before cutoff", () => {
  resetMilestoneEligibleDefaultForTests(Date.UTC(2026, 6, 20));
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, state TEXT, paper_linked INTEGER, discord_message_id TEXT,
      sent_at_ms INTEGER, research_only INTEGER
    );
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, detected_at_ms INTEGER, opening_delivered_at_ms INTEGER,
      delivery_decision TEXT, source_path TEXT
    );
  `);
  d.prepare("INSERT INTO options_alerts VALUES ('a1','SENT',1,'dm1',?,0)").run(Date.UTC(2026, 6, 15));
  d.prepare("INSERT INTO opportunity_cases VALUES ('c1', ?, ?, 'DELIVERED', 'independent')")
    .run(Date.UTC(2026, 6, 15), Date.UTC(2026, 6, 15));

  const old = isMilestoneDiscordEligibleOnDb(d, { alertId: "a1", opportunityCaseId: "c1", paperKind: "DELIVERED_ALERT_PAPER" });
  assert.equal(old.eligible, false);
  assert.match(old.reason, /cutoff|historical/);

  d.prepare("INSERT INTO options_alerts VALUES ('a2','SENT',1,'dm2',?,0)").run(Date.UTC(2026, 6, 22));
  d.prepare("INSERT INTO opportunity_cases VALUES ('c2', ?, ?, 'DELIVERED', 'independent')")
    .run(Date.UTC(2026, 6, 22), Date.UTC(2026, 6, 22));
  const fresh = isMilestoneDiscordEligibleOnDb(d, { alertId: "a2", opportunityCaseId: "c2", paperKind: "DELIVERED_ALERT_PAPER" });
  assert.equal(fresh.eligible, true);
  assert.ok(milestoneEligibleAfterMs() >= Date.UTC(2026, 6, 20));
});

test("milestone connectivity test payload is labeled TEST ONLY", async () => {
  const { optionsMilestoneConnectivityTest } = await import("../lib/research/options/delivery.ts");
  let payload = null;
  const res = await optionsMilestoneConnectivityTest({
    env: { DISCORD_WEBHOOK_OPTIONS: "https://example.invalid/webhook" },
    send: async (p) => { payload = p; return { ok: true, status: 200, latencyMs: 1, messageId: "t1" }; },
    replyToMessageId: "parent-1",
  });
  assert.equal(res.ok, true);
  assert.match(String(payload.content), /TEST ONLY — NOT A TRADE/);
  assert.equal(payload.message_reference.message_id, "parent-1");
});
