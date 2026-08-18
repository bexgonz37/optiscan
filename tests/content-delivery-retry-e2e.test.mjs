/**
 * End-to-end: a TRANSIENT delivery refusal must not consume the draft, and a
 * genuine duplicate must still be terminal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runContentDraftsScan } from "../lib/content/content-drafts-runtime.ts";

// Content now requires its own dedicated webhook; the recap one no longer enables delivery.
const ENV = {
  CONTENT_EVENTS_ENABLED: "1",
  DISCORD_RECAP_ENABLED: "1",
  DISCORD_WEBHOOK_RECAP: "https://example/webhook",
  DISCORD_WEBHOOK_CONTENT: "https://example/content-webhook",
};
const vars = () => ({ confidence: 0.72, relativeVolume: 4.2, callFlow: 1200 });
const CONTENT_EVENT_MS = Date.parse("2026-08-04T14:58:20Z");
const CONTENT_NOW_MS = Date.parse("2026-08-04T15:00:00Z");

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
     VALUES (?,'oc_1','OPPORTUNITY_OPENED','AMD',${CONTENT_EVENT_MS},5.2,'bullish','call',400,'2026-08-07',
       ?,?,'sr_reclaim','PENDING',${CONTENT_EVENT_MS})`,
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
    now: () => CONTENT_NOW_MS,
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
    now: () => CONTENT_NOW_MS + 100_000,
  }, ENV);
  assert.equal(s2.deferredDelivered, 1, "the rate-limited bundle is recovered");
  assert.equal(sent.length, 1);

  // CONTRACT CHANGE (2026-08-05 flood fix): one bundle delivers ONE message
  // carrying the recommended phrasing. The alternates are retired to
  // VARIANT_HELD_IN_APP once — and only once — the recommended draft is really
  // SENT, so a rate limit still returns the whole bundle to the queue intact.
  const rows = db.prepare(
    "SELECT discord_delivery_status s, discord_delivery_reason r, discord_attempt_count a FROM content_drafts",
  ).all();
  const delivered = rows.filter((r) => r.s === "SENT");
  assert.equal(delivered.length, 1, "exactly one draft is delivered");
  assert.equal(delivered[0].r, "SENT");
  assert.equal(delivered[0].a, 2, "both attempts counted on the delivered draft");
  for (const row of rows.filter((r) => r.s !== "SENT")) {
    assert.equal(row.r, "VARIANT_HELD_IN_APP", "alternates are held in the app");
    assert.equal(row.s, "SUPPRESSED", "and are not left in a retryable state");
  }
});

test("REGRESSION E2E: a DUPLICATE bundle is terminal and is never resent", async () => {
  const db = makeDb("ce_dup");

  await runContentDraftsScan(db, {
    send: async () => ({ ok: false, suppressed: true, messageId: null, error: "recap suppressed: duplicate" }),
    loadCaseVars: vars,
    now: () => CONTENT_NOW_MS,
  }, ENV);

  for (const row of db.prepare("SELECT discord_delivery_status s, discord_delivery_reason r FROM content_drafts").all()) {
    assert.equal(row.s, "SUPPRESSED", "a real duplicate IS terminal");
    assert.equal(row.r, "SUPPRESSED_DUPLICATE");
  }

  const sent = [];
  const again = await runContentDraftsScan(db, {
    send: async (c) => { sent.push(c); return { ok: true, suppressed: false, messageId: "m", error: null }; },
    loadCaseVars: vars,
    now: () => CONTENT_NOW_MS + 100_000,
  }, ENV);
  assert.equal(sent.length, 0, "a duplicate is never resent");
  assert.equal(again.deferredDelivered, 0);
});

test("REGRESSION E2E: the kill switch defers drafts and names itself as the reason", async () => {
  const db = makeDb("ce_ks");
  // Content has its own kill switch now. DISCORD_RECAP_ENABLED governs the recap channel,
  // which content no longer uses, and must not silence a channel it does not own.
  const killed = { ...ENV, DISCORD_CONTENT_ENABLED: "0" };

  const res = await runContentDraftsScan(db, {
    send: async () => { throw new Error("must not send while the kill switch is on"); },
    loadCaseVars: vars,
    now: () => CONTENT_NOW_MS,
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

test("REGRESSION: turning recaps off does NOT silence the content channel", async () => {
  const db = makeDb("ce_recap_off");
  const sent = [];
  const res = await runContentDraftsScan(db, {
    send: async (c) => { sent.push(c); return { ok: true, suppressed: false, messageId: "m", error: null }; },
    loadCaseVars: vars,
    now: () => CONTENT_NOW_MS,
  }, { ...ENV, DISCORD_RECAP_ENABLED: "0" });
  assert.equal(res.skippedNoWebhook, 0, "the recap switch must not govern a channel it does not own");
  assert.ok(sent.length >= 1);
});
