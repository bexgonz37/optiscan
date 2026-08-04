/**
 * End-to-end: a TRANSIENT delivery refusal must not consume the draft, and a
 * genuine duplicate must still be terminal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runContentDraftsScan } from "../lib/content/content-drafts-runtime.ts";

const ENV = { CONTENT_EVENTS_ENABLED: "1", DISCORD_RECAP_ENABLED: "1", DISCORD_WEBHOOK_RECAP: "https://example/webhook" };
const vars = () => ({ confidence: 0.72, relativeVolume: 4.2, callFlow: 1200 });

function makeDb(eventId) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE opportunity_content_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT, event_type TEXT, symbol TEXT, occurred_at_ms INTEGER,
      frozen_entry REAL, current_mark REAL, return_percent REAL, milestone_percent REAL, max_return_percent REAL,
      direction TEXT, option_type TEXT, strike REAL, expiration TEXT, original_thesis_json TEXT,
      evidence_summary_json TEXT, strategy_key TEXT, content_status TEXT, label TEXT, payload_json TEXT, created_at_ms INTEGER
    );
    CREATE TABLE content_drafts (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, content_event_id TEXT NOT NULL,
      opportunity_case_id TEXT, alert_id TEXT, claim_packet_id TEXT, category TEXT NOT NULL,
      template_family TEXT NOT NULL, template_version TEXT NOT NULL DEFAULT 'v1', platform TEXT NOT NULL DEFAULT 'twitter',
      draft_text TEXT NOT NULL, char_count INTEGER NOT NULL, hashtags_json TEXT, screenshot_suggestion TEXT,
      chart_annotation TEXT, cta_type TEXT NOT NULL DEFAULT 'NONE', result_type TEXT,
      frozen_entry REAL, mark_used REAL, original_alert_at_ms INTEGER, trading_session_date TEXT,
      status TEXT NOT NULL DEFAULT 'GENERATED', discord_delivery_status TEXT NOT NULL DEFAULT 'PENDING',
      discord_message_id TEXT, final_copy TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      approved_at_ms INTEGER, rejected_at_ms INTEGER, manually_posted_at_ms INTEGER,
      discord_delivery_reason TEXT, discord_delivery_explanation TEXT, discord_delivery_retryable INTEGER,
      discord_delivery_detail TEXT, discord_attempt_count INTEGER NOT NULL DEFAULT 0, discord_last_attempt_at_ms INTEGER
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, opportunity_case_id TEXT, state TEXT, entry_mid REAL,
      discord_message_id TEXT, sent_at_ms INTEGER, candidate_symbol TEXT, option_symbol TEXT, side TEXT
    );
  `);
  db.prepare(
    `INSERT INTO opportunity_content_events
      (id,opportunity_case_id,event_type,symbol,occurred_at_ms,frozen_entry,direction,option_type,strike,expiration,
       original_thesis_json,evidence_summary_json,strategy_key,content_status,created_at_ms)
     VALUES (?,'oc_1','OPPORTUNITY_OPENED','AMD',1700000000000,5.2,'bullish','call',400,'08/27',
       ?,?,'sr_reclaim','PENDING',1700000000000)`,
  ).run(
    eventId,
    JSON.stringify(["Reclaimed VWAP on rising call flow"]),
    JSON.stringify(["rel vol 4.2x"]),
  );
  return db;
}

test("REGRESSION E2E: a rate-limited bundle survives and delivers on a later sweep", async () => {
  // The production defect. contentDrafts runs every 3 min; the recap guard allows
  // MAX_POSTS=2 per 10 min. Roughly 40% of sweeps were refused for budget alone,
  // and each refusal wrote SUPPRESSED — outside RETRYABLE_DELIVERY_STATES — so a
  // momentary channel budget permanently destroyed the draft.
  const db = makeDb("ce_rl");

  const s1 = await runContentDraftsScan(db, {
    send: async () => ({ ok: false, suppressed: true, messageId: null, error: "recap suppressed: rate_limited" }),
    loadCaseVars: vars,
    now: () => 1_700_000_100_000,
  }, ENV);
  assert.ok(s1.persisted > 0, "drafts were written");

  const afterRl = db.prepare(
    `SELECT discord_delivery_status s, discord_delivery_reason r,
            discord_delivery_retryable t, discord_attempt_count a FROM content_drafts`,
  ).all();
  assert.ok(afterRl.length > 0);
  for (const row of afterRl) {
    assert.equal(row.r, "SUPPRESSED_RATE_LIMIT", "the real reason is persisted");
    assert.equal(row.t, 1, "and marked retryable");
    assert.notEqual(row.s, "SUPPRESSED", "it must NOT be terminally suppressed");
    assert.equal(row.a, 1, "attempt counted");
  }

  const sent = [];
  const s2 = await runContentDraftsScan(db, {
    send: async (c) => { sent.push(c); return { ok: true, suppressed: false, messageId: "m1", error: null }; },
    loadCaseVars: vars,
    now: () => 1_700_000_200_000,
  }, ENV);
  assert.equal(s2.deferredDelivered, 1, "the rate-limited bundle is recovered");
  assert.equal(sent.length, 1);

  for (const row of db.prepare(
    "SELECT discord_delivery_status s, discord_delivery_reason r, discord_attempt_count a FROM content_drafts",
  ).all()) {
    assert.equal(row.s, "SENT");
    assert.equal(row.r, "SENT");
    assert.equal(row.a, 2, "both attempts counted");
  }
});

test("REGRESSION E2E: a DUPLICATE bundle is terminal and is never resent", async () => {
  const db = makeDb("ce_dup");

  await runContentDraftsScan(db, {
    send: async () => ({ ok: false, suppressed: true, messageId: null, error: "recap suppressed: duplicate" }),
    loadCaseVars: vars,
    now: () => 1_700_000_100_000,
  }, ENV);

  for (const row of db.prepare("SELECT discord_delivery_status s, discord_delivery_reason r FROM content_drafts").all()) {
    assert.equal(row.s, "SUPPRESSED", "a real duplicate IS terminal");
    assert.equal(row.r, "SUPPRESSED_DUPLICATE");
  }

  const sent = [];
  const again = await runContentDraftsScan(db, {
    send: async (c) => { sent.push(c); return { ok: true, suppressed: false, messageId: "m", error: null }; },
    loadCaseVars: vars,
    now: () => 1_700_000_200_000,
  }, ENV);
  assert.equal(sent.length, 0, "a duplicate is never resent");
  assert.equal(again.deferredDelivered, 0);
});

test("REGRESSION E2E: the kill switch defers drafts and names itself as the reason", async () => {
  const db = makeDb("ce_ks");
  const killed = { ...ENV, DISCORD_RECAP_ENABLED: "0" };

  const res = await runContentDraftsScan(db, {
    send: async () => { throw new Error("must not send while the kill switch is on"); },
    loadCaseVars: vars,
    now: () => 1_700_000_100_000,
  }, killed);
  assert.equal(res.skippedNoWebhook, 1);

  for (const row of db.prepare(
    "SELECT discord_delivery_status s, discord_delivery_reason r, discord_delivery_retryable t FROM content_drafts",
  ).all()) {
    assert.equal(row.s, "SKIPPED_NO_WEBHOOK", "still in the retry pool");
    assert.equal(row.r, "DISABLED_BY_KILL_SWITCH", "and says so — not 'no webhook'");
    assert.equal(row.t, 1);
  }
});
