/**
 * Owner lifecycle Discord: a SENT opening earns a close update; a SUPPRESSED one never does.
 *
 * Before this repair no owner callout had ever received a lifecycle update, and four
 * independent gates were each responsible on their own:
 *   1. `paper_kind !== 'DELIVERED_ALERT_PAPER'` returned early;
 *   2. the close path required `pos.alert_id`, which is null for every owner mirror;
 *   3. `isMilestoneDiscordEligibleOnDb` rejects any paper_kind but DELIVERED_ALERT_PAPER;
 *   4. it also requires `delivery_decision='DELIVERED'`, and the owner path stamps
 *      `research_only`.
 *
 * The replacement identity is the mirror's own `feature_snapshot_json.opportunityCaseId`,
 * authorised by `discord_deliveries.status='SENT'` and nothing else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { gradeOpenOptionPositionsOnDb } from "../lib/research/options/grade.ts";
import { OPPORTUNITY_CASE_SCHEMA_VERSION } from "../lib/opportunity-case/schema.ts";

const T = Date.parse("2026-08-20T17:45:00.000Z"); // 1:45 p.m. ET, mid-session
const OCC = "O:SPY260826C00640000";

const ENV = {
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  REAL_OPTION_PAPER_ENABLED: "1",
  OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "1",
  MARKET_SESSION_GUARD: "shadow",
  OPTIONS_SUBSCRIBER_EXIT_MODE: "targets_then_bands",
};

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      entry_fill REAL, result_class TEXT NOT NULL, strategy TEXT, underlying_price REAL,
      target REAL, invalidation REAL, status TEXT NOT NULL, paper_kind TEXT, alert_id TEXT,
      feature_snapshot_json TEXT,
      exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, exit_at_ms INTEGER,
      entered_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT NOT NULL,
      mark_at_ms INTEGER NOT NULL, bid REAL, ask REAL, exit_fill REAL, return_pct REAL,
      quote_age_ms INTEGER, created_at_ms INTEGER NOT NULL, UNIQUE(trade_id, mark_at_ms)
    );
    CREATE TABLE options_lifecycle_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, paper_trade_id INTEGER, alert_id TEXT,
      option_symbol TEXT NOT NULL, event_type TEXT NOT NULL, decision TEXT NOT NULL,
      reason TEXT NOT NULL, quote_ts_ms INTEGER, observed_at_ms INTEGER NOT NULL,
      bid REAL, ask REAL, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT, direction TEXT, setup_family TEXT,
      detected_at_ms INTEGER, alert_id TEXT, thesis_fingerprint TEXT, lifecycle_status TEXT,
      discord_message_id TEXT, delivery_decision TEXT, source_path TEXT,
      opening_delivered_at_ms INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER,
      case_json TEXT
    );
    CREATE TABLE discord_deliveries (
      delivery_id TEXT PRIMARY KEY, alert_id INTEGER, channel_type TEXT NOT NULL,
      webhook_name TEXT NOT NULL, payload_type TEXT NOT NULL, payload_preview TEXT,
      payload_json TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL,
      attempted_at TEXT, sent_at TEXT, status TEXT NOT NULL, http_status INTEGER,
      response_body_safe TEXT, failure_reason TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT, opportunity_case_id TEXT, thesis_fingerprint TEXT,
      lifecycle_state TEXT, delivery_context_json TEXT
    );
  `);
  return d;
}

/** An owner callout: an opportunity case, a mirror naming it, and a ledger row. */
function ownerCallout(d, {
  caseId = "oc_owner",
  status = "SENT",
  messageId = "msg_open_1",
  target = 1.55,
  invalidation = 0.95,
} = {}) {
  d.prepare(
    `INSERT INTO opportunity_cases
      (opportunity_id, underlying_symbol, direction, setup_family, detected_at_ms, alert_id,
       thesis_fingerprint, lifecycle_status, discord_message_id, delivery_decision, source_path,
       opening_delivered_at_ms, created_at_ms, updated_at_ms, case_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    caseId, "SPY", "bullish", "sr_reclaim", T - 3_600_000, null, "tf_owner", "CREATED",
    status === "SENT" ? messageId : null,
    // Deliberately the value the owner path really writes: NOT "DELIVERED". Nothing in the
    // owner lifecycle gate reads this field, and this row proves it does not.
    "research_only", "live", T - 3_600_000, T - 3_600_000, T - 3_600_000,
    JSON.stringify({
      // Real value, imported rather than typed: `parseCase` returns null on any other
      // version, and a fixture that invents its own shape proves nothing about production.
      schemaVersion: OPPORTUNITY_CASE_SCHEMA_VERSION,
      thesisFingerprint: "tf_owner",
      opportunityFingerprint: "of_owner",
      selectedContract: { optionSymbol: OCC, side: "CALL", strike: 640, expiration: "2026-08-26" },
      frozenTrade: { entryMid: 1.25, targetT1: 1.55, targetT2: 1.9, stop: 0.95 },
      summary: { frozenEntry: 1.25, currentMark: 1.25, currentReturnPct: 0, currentStatus: "CREATED", active: true },
      discord: { channelId: null, messageId: status === "SENT" ? messageId : null, threadId: null },
    }),
  );

  d.prepare(
    `INSERT INTO options_paper_trades
      (option_symbol, side, strike, expiration, dte, entry_fill, result_class, strategy,
       target, invalidation, status, paper_kind, alert_id, feature_snapshot_json,
       entered_at_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    OCC, "call", 640, "2026-08-26", 6, 1.25, "REAL_OPTION_PAPER", "sr_reclaim",
    target, invalidation, "ENTERED", "OWNER_VALIDATION_PAPER",
    // Null on purpose: no owner callout has ever written an options_alerts row.
    null,
    JSON.stringify({ lane: "OWNER_ONLY", opportunityCaseId: caseId, quality: 0.81 }),
    T - 3_600_000, T - 3_600_000, T - 3_600_000,
  );

  d.prepare(
    `INSERT INTO discord_deliveries
      (delivery_id, channel_type, webhook_name, payload_type, payload_json, idempotency_key,
       created_at, sent_at, status, failure_reason, opportunity_case_id, thesis_fingerprint,
       lifecycle_state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `dd_${caseId}`, "discord_webhook", "options", "owner_intraday_actionable",
    JSON.stringify({ content: "SPY CALL opening" }), `k_${caseId}`,
    "2026-08-20T16:45:00.000Z",
    status === "SENT" ? "2026-08-20T16:45:00.000Z" : null,
    status,
    status === "SENT" ? null : "owner_watch_discord_suppressed",
    caseId, "tf_owner", "OPENING",
  );
  return caseId;
}

/** Grade one pass with a captured Discord surface. `quote` decides target vs stop. */
async function gradeWith(d, quote) {
  const sends = [];
  const result = await gradeOpenOptionPositionsOnDb(d, {
    getQuote: async () => ({ ...quote, quoteAgeMs: 500, providerTimestamp: T }),
    now: () => T,
    sendMilestone: async (payload) => {
      sends.push(payload);
      return { ok: true, messageId: `msg_${sends.length}` };
    },
  }, ENV);
  return { result, sends };
}

// A mark well above the frozen T1 (1.55). realOptionExit sells 60% toward the bid.
const AT_TARGET = { bid: 1.70, ask: 1.78 };
// A mark below the frozen stop (0.95).
const AT_STOP = { bid: 0.60, ask: 0.66 };

test("a SENT owner opening gets a TARGET 1 HIT / CLOSED update", async () => {
  const d = db();
  ownerCallout(d, { status: "SENT" });
  const { result, sends } = await gradeWith(d, AT_TARGET);

  assert.equal(result.graded, 1);
  assert.equal(result.byReason.target_hit, 1);
  assert.equal(result.ownerClosesDelivered, 1, "the owner is told the trade closed");
  assert.equal(sends.length, 1);
  const content = String(sends[0].content);
  assert.match(content, /TARGET 1 HIT \/ CLOSED/);
  assert.match(content, /Position fully closed\. Nothing is held past Target 1\./);
  d.close();
});

test("a stop emits STOPPED / CLOSED", async () => {
  const d = db();
  ownerCallout(d, { status: "SENT" });
  const { result, sends } = await gradeWith(d, AT_STOP);

  assert.equal(result.byReason.stop_hit, 1);
  assert.equal(result.ownerClosesDelivered, 1);
  assert.match(String(sends[0].content), /STOPPED \/ CLOSED/);
  d.close();
});

test("a SUPPRESSED opening NEVER produces a lifecycle update", async () => {
  const d = db();
  ownerCallout(d, { status: "SUPPRESSED" });
  const { result, sends } = await gradeWith(d, AT_TARGET);

  assert.equal(result.graded, 1, "the position still exits and is still graded");
  assert.equal(sends.length, 0, "nothing is posted about a message the owner never got");
  assert.equal(result.ownerClosesDelivered ?? 0, 0);
  assert.equal(result.ownerCloseSkips?.opening_not_sent, 1, "the skip is reported, not silent");
  d.close();
});

test("a FAILED opening never produces a lifecycle update either", async () => {
  const d = db();
  ownerCallout(d, { caseId: "oc_failed", status: "FAILED" });
  const { sends, result } = await gradeWith(d, AT_TARGET);
  assert.equal(sends.length, 0);
  assert.equal(result.ownerCloseSkips?.opening_not_sent, 1);
  d.close();
});

test("no lifecycle update when the mirror names no case", async () => {
  const d = db();
  ownerCallout(d, { status: "SENT" });
  d.prepare("UPDATE options_paper_trades SET feature_snapshot_json=?").run(JSON.stringify({ lane: "OWNER_ONLY" }));
  const { sends, result } = await gradeWith(d, AT_TARGET);
  assert.equal(sends.length, 0);
  assert.equal(result.ownerCloseSkips?.owner_mirror_names_no_case, 1);
  d.close();
});

test("the close carries the exact contract identity of the opening", async () => {
  const d = db();
  ownerCallout(d, { status: "SENT" });
  const { sends } = await gradeWith(d, AT_TARGET);
  const content = String(sends[0].content);
  assert.match(content, /SPY 08\/26 \$640 Call/, "expiration and strike");
  assert.match(content, new RegExp(`Contract: ${OCC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "exact OCC");
  assert.match(content, /Case: oc_owner/, "tracking id");
  assert.match(content, /Lane: OWNER_ONLY/);
  d.close();
});

test("the close replies to the opening Discord message", async () => {
  const d = db();
  ownerCallout(d, { status: "SENT", messageId: "msg_open_1" });
  const { sends } = await gradeWith(d, AT_TARGET);
  assert.deepEqual(sends[0].message_reference, { message_id: "msg_open_1" });
  assert.deepEqual(sends[0].allowed_mentions, { parse: [] });
  d.close();
});

test("no close message claims Target 2, a runner, a trail or a profit lock", async () => {
  for (const quote of [AT_TARGET, AT_STOP]) {
    const d = db();
    ownerCallout(d, { status: "SENT" });
    const { sends } = await gradeWith(d, quote);
    const content = String(sends[0].content);
    assert.doesNotMatch(content, /Target 2|T2|profit.?lock|runner|trail|remaining target|let it run/i);
    d.close();
  }
});

test("an exit with no verifiable event time is recorded as a skip, not silently dropped", async () => {
  const d = db();
  ownerCallout(d, { status: "SENT" });
  const sends = [];
  // No quote at all: the position still closes at expiration, and the timestamp rules --
  // which this session does not change -- refuse to date the event. The close goes
  // unannounced, and the reason is counted so it is not mistaken for a working zero.
  const result = await gradeOpenOptionPositionsOnDb(d, {
    getQuote: async () => null,
    now: () => Date.parse("2026-08-27T20:30:00.000Z"),
    sendMilestone: async (p) => { sends.push(p); return { ok: true }; },
  }, ENV);
  assert.equal(result.byReason.expiration_no_quote, 1);
  assert.equal(sends.length, 0);
  assert.equal(result.ownerCloseSkips?.event_time_unverified, 1);
  d.close();
});

test("the subscriber lane is untouched by the owner branch", async () => {
  const d = db();
  ownerCallout(d, { status: "SENT" });
  // A DELIVERED_ALERT_PAPER row with a null alert_id, which the subscriber close path
  // requires. It must stay silent, exactly as before.
  d.prepare(
    `INSERT INTO options_paper_trades
      (option_symbol, side, strike, expiration, dte, entry_fill, result_class, strategy,
       target, invalidation, status, paper_kind, alert_id, feature_snapshot_json,
       entered_at_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "O:QQQ260826C00500000", "call", 500, "2026-08-26", 6, 1.25, "REAL_OPTION_PAPER", "sr_reclaim",
    1.55, 0.95, "ENTERED", "DELIVERED_ALERT_PAPER", null,
    JSON.stringify({ opportunityCaseId: "oc_owner" }),
    T - 3_600_000, T - 3_600_000, T - 3_600_000,
  );
  const { result, sends } = await gradeWith(d, AT_TARGET);
  assert.equal(result.graded, 2, "both positions exit");
  assert.equal(sends.length, 1, "only the owner mirror produced a message");
  assert.equal(result.closesDelivered ?? 0, 0, "the subscriber close path did not fire");
  assert.equal(result.ownerClosesDelivered, 1);
  d.close();
});
