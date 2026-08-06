/**
 * The 2026-08-05 Recaps flood, as regressions.
 *
 * Measured in production at cb1fc98 before the fix:
 *   - 449 undelivered drafts across 148 content events, draining 1 event/scan
 *   - 63 canonical outcomes had produced 265 delivered drafts
 *   - oc_4pu17q (IWM) alone carried 9 drafts with 9 consecutive message snowflakes
 *   - oc_kmzobp (NVDA) sent CLOSED_LOSER at 02:38:30Z then WHY_THIS_FAILED at 02:44:48Z
 *
 * Each test below pins one of the multipliers shut.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  runContentDraftsScan,
  varsForEventRow,
  listContentDraftsOnDb,
  getContentDraftOnDb,
} from "../lib/content/content-drafts-runtime.ts";
import {
  classifyDeliveryLane,
  isOutcomeReportCategory,
  outcomeFingerprint,
} from "../lib/content/outcome-delivery-lane.ts";
import {
  deriveFailureCause,
  validateFailureExplanation,
} from "../lib/content/failure-cause.ts";
import { buildDraftBundle } from "../lib/content/content-event-engine.ts";

const NOW = Date.parse("2026-08-05T20:00:00.000Z");
const ENV = { CONTENT_EVENTS_ENABLED: "1", DISCORD_RECAP_ENABLED: "1", DISCORD_WEBHOOK_RECAP: "https://example.invalid/hook" };

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE opportunity_content_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT, event_type TEXT, symbol TEXT,
      occurred_at_ms INTEGER, frozen_entry REAL, current_mark REAL, return_percent REAL,
      milestone_percent REAL, max_return_percent REAL, direction TEXT, option_type TEXT,
      strike REAL, expiration TEXT, original_thesis_json TEXT, evidence_summary_json TEXT,
      strategy_key TEXT, content_status TEXT, label TEXT, payload_json TEXT, created_at_ms INTEGER
    );
    CREATE TABLE content_drafts (
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, content_event_id TEXT, opportunity_case_id TEXT,
      alert_id TEXT, claim_packet_id TEXT, category TEXT, template_family TEXT, template_version TEXT,
      platform TEXT, draft_text TEXT, char_count INTEGER, hashtags_json TEXT, screenshot_suggestion TEXT,
      chart_annotation TEXT, cta_type TEXT, result_type TEXT, frozen_entry REAL, mark_used REAL,
      original_alert_at_ms INTEGER, trading_session_date TEXT, status TEXT,
      discord_delivery_status TEXT, discord_message_id TEXT, final_copy TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER, approved_at_ms INTEGER, rejected_at_ms INTEGER,
      manually_posted_at_ms INTEGER, discord_delivery_reason TEXT, discord_delivery_explanation TEXT,
      discord_delivery_retryable INTEGER, discord_delivery_detail TEXT,
      discord_attempt_count INTEGER DEFAULT 0, discord_last_attempt_at_ms INTEGER
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, opportunity_case_id TEXT, state TEXT, entry_mid REAL,
      discord_message_id TEXT, sent_at_ms INTEGER, candidate_symbol TEXT, option_symbol TEXT, side TEXT
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT, paper_kind TEXT, entry_fill REAL,
      status TEXT, return_pct REAL, last_mark_return_pct REAL, mfe_pct REAL, mae_pct REAL,
      option_symbol TEXT, side TEXT, strike REAL, expiration TEXT, exit_reason TEXT
    );
  `);
  return db;
}

/**
 * A verified subscriber claim for one case. Performance categories are
 * hard-gated on this, so without it the scan suppresses before it ever reaches
 * the delivery logic these tests are about.
 */
function seedClaim(db, caseId) {
  const alertId = `a_${caseId}`;
  db.prepare(
    `INSERT INTO options_alerts (alert_id, opportunity_case_id, state, entry_mid, discord_message_id, sent_at_ms, candidate_symbol, option_symbol, side)
     VALUES (?,?,'SENT',3.15,'dmsg',1700000000000,'AAPL','AAPL260803P00305000','put')`,
  ).run(alertId, caseId);
  db.prepare(
    `INSERT INTO options_paper_trades (alert_id, paper_kind, entry_fill, status, return_pct, last_mark_return_pct, mfe_pct, option_symbol, side, strike, expiration)
     VALUES (?,'DELIVERED_ALERT_PAPER',3.15,'CLOSED',-48.5714,-48.5714,55.5556,'AAPL260803P00305000','put',305,'08/03')`,
  ).run(alertId);
}

/** Seed one closure event. Mirrors the real AAPL row ce_1k0xr40. */
function seedClose(db, { id, caseId, eventType, occurredAtMs = NOW - 60_000, maxReturn = null }) {
  db.prepare(
    `INSERT INTO opportunity_content_events
      (id,opportunity_case_id,event_type,symbol,occurred_at_ms,frozen_entry,current_mark,return_percent,
       max_return_percent,direction,option_type,strike,expiration,original_thesis_json,evidence_summary_json,
       strategy_key,content_status,created_at_ms)
     VALUES (?,?,?,'AAPL',?,3.15,1.62,-48.5714,?,'bearish','PUT',305,'2026-08-03',?,?,'lower_high_continuation','PENDING',?)`,
  ).run(
    id, caseId, eventType, occurredAtMs, maxReturn,
    JSON.stringify(["Lower high continuation with bearish structure intact."]),
    JSON.stringify(["repeat_ready_signal"]),
    occurredAtMs,
  );
  if (!db.prepare("SELECT 1 FROM options_alerts WHERE opportunity_case_id=?").get(caseId)) seedClaim(db, caseId);
}

const claimOk = () => ({ confidence: 0.72 });

function capture() {
  const sent = [];
  return {
    sent,
    deps: {
      send: async (c) => { sent.push(c); return { ok: true, messageId: `m${sent.length}`, error: null }; },
      webhookConfigured: () => true,
      loadCaseVars: claimOk,
      now: () => NOW,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

test("one canonical outcome cannot produce multiple Discord report cards", async () => {
  const db = makeDb();
  // Exactly the production shape: EXIT_HIT and OPPORTUNITY_CLOSED both map to
  // CLOSED_LOSER, and REPORT_CARD_READY adds WHY_THIS_FAILED — three events,
  // one closure. Verified on oc_4pu17q (IWM) and oc_kmzobp (NVDA).
  seedClose(db, { id: "ce_exit", caseId: "oc_dup", eventType: "EXIT_HIT" });
  seedClose(db, { id: "ce_closed", caseId: "oc_dup", eventType: "OPPORTUNITY_CLOSED" });
  seedClose(db, { id: "ce_card", caseId: "oc_dup", eventType: "OPPORTUNITY_REPORT_CARD_READY" });

  const { sent, deps } = capture();
  for (let i = 0; i < 6; i++) await runContentDraftsScan(db, deps, ENV);

  assert.equal(sent.length, 1, "one closure yields exactly one Discord message");

  const sentRows = db.prepare(
    "SELECT COUNT(*) n FROM content_drafts WHERE opportunity_case_id='oc_dup' AND discord_delivery_status='SENT'",
  ).get().n;
  assert.equal(sentRows, 1, "and exactly one draft row records a delivery");

  const dupReason = db.prepare(
    `SELECT COUNT(*) n FROM content_drafts
      WHERE opportunity_case_id='oc_dup' AND discord_delivery_reason='SUPPRESSED_DUPLICATE_OUTCOME'`,
  ).get().n;
  assert.ok(dupReason > 0, "the later events are recorded as duplicate outcomes, not lost");

  // Nothing was deleted: every generated draft is still queryable.
  const total = db.prepare("SELECT COUNT(*) n FROM content_drafts WHERE opportunity_case_id='oc_dup'").get().n;
  assert.ok(total >= 6, `all drafts preserved (found ${total})`);
});

test("the three copy variants are never three Discord-visible items", async () => {
  const db = makeDb();
  seedClose(db, { id: "ce_v", caseId: "oc_v", eventType: "OPPORTUNITY_CLOSED" });

  const { sent, deps } = capture();
  await runContentDraftsScan(db, deps, ENV);

  assert.equal(sent.length, 1);
  const body = sent[0];
  const codeBlocks = (body.match(/```/g) || []).length / 2;
  assert.equal(codeBlocks, 1, "one draft body, not three");
  assert.match(body, /alternate phrasing/i, "the alternates are pointed at, not pasted");

  const held = db.prepare(
    "SELECT COUNT(*) n FROM content_drafts WHERE discord_delivery_reason='VARIANT_HELD_IN_APP'",
  ).get().n;
  assert.ok(held >= 1, "alternates are retained in the app");
});

test("old backlog cannot flood Discord — it is rerouted to the digest instead", async () => {
  const db = makeDb();
  // Production's actual shape at cb1fc98: drafts already written and sitting in
  // a retryable state, waiting for the recovery sweep. 449 of them across 148
  // events, all historical. Before the fix that was 148 further Discord
  // messages at one per scan.
  const old = NOW - 5 * 24 * 60 * 60_000;
  for (let i = 0; i < 20; i++) {
    seedClose(db, { id: `ce_old${i}`, caseId: `oc_old${i}`, eventType: "OPPORTUNITY_CLOSED", occurredAtMs: old + i });
    db.prepare("UPDATE opportunity_content_events SET content_status='PROCESSED' WHERE id=?").run(`ce_old${i}`);
    for (let v = 0; v < 3; v++) {
      db.prepare(
        `INSERT INTO content_drafts
          (id, fingerprint, content_event_id, opportunity_case_id, category, template_family,
           template_version, platform, draft_text, char_count, cta_type, result_type,
           status, discord_delivery_status, discord_delivery_retryable, created_at_ms, updated_at_ms)
         VALUES (?,?,?,?, 'CLOSED_LOSER', ?, 'v1','twitter', ?, 20, 'NONE','REALIZED_CLOSED_RETURN',
                 'GENERATED','SKIPPED_NO_WEBHOOK',1, ?, ?)`,
      ).run(`cd_old${i}_${v}`, `cd_old${i}_${v}`, `ce_old${i}`, `oc_old${i}`, `CLOSED_LOSER_${v}`, `old draft ${i}.${v}`, old + i, old + i);
    }
  }

  const { sent, deps } = capture();
  for (let i = 0; i < 3; i++) await runContentDraftsScan(db, deps, ENV);

  assert.equal(sent.length, 0, "no historical outcome is delivered individually");

  const digest = db.prepare(
    "SELECT COUNT(DISTINCT content_event_id) n FROM content_drafts WHERE discord_delivery_reason='HELD_FOR_HISTORICAL_DIGEST'",
  ).get().n;
  assert.equal(digest, 20, "the whole backlog is reclassified in bulk, not one per scan");

  const retryable = db.prepare(
    "SELECT COUNT(*) n FROM content_drafts WHERE discord_delivery_status IN ('PENDING','FAILED','SKIPPED_NO_WEBHOOK')",
  ).get().n;
  assert.equal(retryable, 0, "and nothing is left queued to drip out later");

  // Preservation: every draft still exists, with its text and timestamps intact.
  const total = db.prepare("SELECT COUNT(*) n FROM content_drafts").get().n;
  assert.equal(total, 60, "no draft was deleted");
  const sample = db.prepare("SELECT draft_text, created_at_ms FROM content_drafts WHERE id='cd_old3_1'").get();
  assert.equal(sample.draft_text, "old draft 3.1");
  assert.equal(sample.created_at_ms, old + 3);
});

test("live content outranks historical backlog", async () => {
  const db = makeDb();
  const old = NOW - 20 * 60 * 60_000; // inside RECENT_RECOVERY, individually deliverable
  seedClose(db, { id: "ce_back", caseId: "oc_back", eventType: "OPPORTUNITY_CLOSED", occurredAtMs: old });

  const { deps } = capture();
  await runContentDraftsScan(db, deps, ENV); // drains the backlog event into SENT

  // Now a fresh closure arrives alongside another recoverable one.
  seedClose(db, { id: "ce_back2", caseId: "oc_back2", eventType: "OPPORTUNITY_CLOSED", occurredAtMs: old });
  seedClose(db, { id: "ce_live", caseId: "oc_live", eventType: "OPPORTUNITY_CLOSED", occurredAtMs: NOW - 30_000 });

  const live = capture();
  await runContentDraftsScan(db, live.deps, ENV);

  assert.equal(live.sent.length, 1, "one message this run");
  assert.match(live.sent[0], /AAPL/);
  const liveSent = db.prepare(
    "SELECT COUNT(*) n FROM content_drafts WHERE opportunity_case_id='oc_live' AND discord_delivery_status='SENT'",
  ).get().n;
  assert.equal(liveSent, 1, "and it is the LIVE outcome, not the backlog one");
});

test("a future-dated event is not treated as live", () => {
  const future = classifyDeliveryLane({ eventOccurredAtMs: NOW + 60 * 60_000, nowMs: NOW });
  assert.equal(future.lane, "HISTORICAL_DIGEST");
  assert.equal(future.individualDeliveryAllowed, false);

  const missing = classifyDeliveryLane({ eventOccurredAtMs: null, nowMs: NOW });
  assert.equal(missing.individualDeliveryAllowed, false, "unprovable freshness is not freshness");
});

test("lane windows nest even when misconfigured", () => {
  const env = { CONTENT_LANE_LIVE_MS: "86400000", CONTENT_LANE_RECENT_MS: "1000" };
  const d = classifyDeliveryLane({ eventOccurredAtMs: NOW - 2000, nowMs: NOW, env });
  assert.equal(d.lane, "LIVE_CURRENT");
  const d2 = classifyDeliveryLane({ eventOccurredAtMs: NOW - 2 * 86_400_000, nowMs: NOW, env });
  assert.equal(d2.individualDeliveryAllowed, false, "a bad config cannot promote old backlog to live");
});

// ── failure-explanation grounding ───────────────────────────────────────────

test("the entry thesis is never rendered as the failure cause", () => {
  const vars = varsForEventRow({
    symbol: "AAPL", option_type: "PUT", strike: 305, expiration: "2026-08-03",
    frozen_entry: 3.15, current_mark: 1.62, return_percent: -48.5714, max_return_percent: 55.5556,
    original_thesis_json: JSON.stringify(["Lower high continuation with bearish structure intact."]),
    direction: "bearish",
  });
  const bundle = buildDraftBundle("WHY_THIS_FAILED", vars, {});
  assert.ok(bundle && bundle.drafts.length);

  for (const d of bundle.drafts) {
    // The exact production string, in the exact position that made it a claim.
    assert.doesNotMatch(
      d.text,
      /(Why \$AAPL failed:[\s\S]*|the setup broke when |honest read: )Lower high continuation with bearish structure intact/,
      `entry thesis reprinted as cause: ${d.text}`,
    );
  }

  // The verified cause IS present, because the evidence supports it.
  assert.ok(
    bundle.drafts.some((d) => /55\.6%|gave back|giving back/i.test(d.text)),
    "the derived PROFIT_GIVEN_BACK cause is stated instead",
  );
});

test("PROFIT_GIVEN_BACK is derived from persisted marks, not interpreted", () => {
  const c = deriveFailureCause({ returnPercent: -48.5714, maxReturnPercent: 55.5556, frozenEntry: 3.15, currentMark: 1.62 });
  assert.equal(c.code, "PROFIT_GIVEN_BACK");
  assert.equal(c.grade, "VERIFIED_PRIMARY_CAUSE");
  assert.equal(c.provable, true);
  assert.deepEqual(c.evidenceFields, ["maxReturnPercent", "returnPercent"]);
});

test("THESIS_FAILED_IMMEDIATELY when the position never traded above entry", () => {
  const c = deriveFailureCause({ returnPercent: -60, maxReturnPercent: -5, frozenEntry: 2, currentMark: 0.8 });
  assert.equal(c.code, "THESIS_FAILED_IMMEDIATELY");
  assert.equal(c.provable, true);
});

test("no derivable cause says so plainly instead of inventing one", () => {
  const c = deriveFailureCause({ returnPercent: -12, maxReturnPercent: 5, frozenEntry: 2, currentMark: 1.76 });
  assert.equal(c.code, "INSUFFICIENT_EVIDENCE");
  assert.equal(c.provable, false);
  assert.match(c.statement, /verified root cause has not yet been established/i);
  assert.match(c.statement, /-12%/);
});

test("a missing max mark cannot manufacture a cause", () => {
  const c = deriveFailureCause({ returnPercent: -30, maxReturnPercent: null, frozenEntry: 2, currentMark: 1.4 });
  assert.equal(c.code, "INSUFFICIENT_EVIDENCE", "null is not zero and must not imply THESIS_FAILED_IMMEDIATELY");
});

test("contradictory failure language is rejected", () => {
  const v = validateFailureExplanation(
    "Lower high continuation with bearish structure intact.",
    { optionType: "PUT" },
  );
  assert.equal(v.ok, false);
  assert.equal(v.violation, "CONTRADICTORY_FAILURE_EXPLANATION");

  const call = validateFailureExplanation("Breakout held and buyers kept control.", { optionType: "CALL" });
  assert.equal(call.ok, false);
  assert.equal(call.violation, "CONTRADICTORY_FAILURE_EXPLANATION");
});

test("a bare market condition is rejected as unsupported", () => {
  const v = validateFailureExplanation("VWAP rejected the move.", { optionType: "PUT" });
  assert.equal(v.ok, false);
  assert.equal(v.violation, "UNSUPPORTED_FAILURE_EXPLANATION");
});

test("a derived, evidence-backed cause passes grounding", () => {
  const c = deriveFailureCause({ returnPercent: -48.5714, maxReturnPercent: 55.5556, frozenEntry: 3.15, currentMark: 1.62 });
  assert.equal(validateFailureExplanation(c.statement, { optionType: "PUT" }).ok, true);

  const insufficient = deriveFailureCause({ returnPercent: -12, maxReturnPercent: 5, frozenEntry: 2, currentMark: 1.76 });
  assert.equal(validateFailureExplanation(insufficient.statement, { optionType: "PUT" }).ok, true);
});

// ── fingerprint ─────────────────────────────────────────────────────────────

test("the outcome fingerprint collapses phrasings but not distinct contracts", () => {
  const a = outcomeFingerprint({ canonicalOutcomeId: "oc_1", occ: "AAPL260803P00305000", resultType: "REALIZED_CLOSED_RETURN" });
  const b = outcomeFingerprint({ canonicalOutcomeId: "oc_1", occ: "AAPL260803P00305000", resultType: "REALIZED_CLOSED_RETURN" });
  const other = outcomeFingerprint({ canonicalOutcomeId: "oc_1", occ: "AAPL260803P00310000", resultType: "REALIZED_CLOSED_RETURN" });
  assert.equal(a, b, "same closure, same fingerprint");
  assert.notEqual(a, other, "a different contract is a different outcome");
});

test("milestone categories are not collapsed into the closure", () => {
  assert.equal(isOutcomeReportCategory("CLOSED_LOSER"), true);
  assert.equal(isOutcomeReportCategory("WHY_THIS_FAILED"), true);
  assert.equal(isOutcomeReportCategory("RETURN_MILESTONE"), false);
  assert.equal(isOutcomeReportCategory("NEW_HIGH"), false);
});

test("the drafts API exposes the contract a report card claims", async () => {
  // Without these fields an audit cannot ask "does the displayed contract match
  // the persisted one?" — the question any realized-return claim must survive.
  // Discord renders the contract from the bundle at generation time, so the API
  // omitting it left no way to cross-check an unusual-looking strike.
  const db = makeDb();
  seedClose(db, { id: "ce_occ", caseId: "oc_occ", eventType: "OPPORTUNITY_CLOSED" });
  const { deps } = capture();
  await runContentDraftsScan(db, deps, ENV);

  const [row] = listContentDraftsOnDb(db, { limit: 5 });
  assert.ok(row, "a draft exists");
  assert.equal(row.strike, 305);
  assert.equal(row.expiration, "2026-08-03");
  assert.equal(String(row.option_type).toUpperCase(), "PUT");
  assert.equal(row.direction, "bearish");
  assert.equal(row.strategy_key, "lower_high_continuation");
  assert.equal(Math.round(row.return_percent * 100) / 100, -48.57);

  const detail = getContentDraftOnDb(db, String(row.id));
  assert.equal(detail.strike, 305, "the detail endpoint carries it too");
  assert.equal(detail.max_return_percent, null, "and absence is still absence");
});

test("a LEGACY events schema still lists drafts instead of blanking them", () => {
  // Referencing a column SQLite does not have fails the whole statement, and
  // both readers swallow errors and return empty. Naming the contract columns
  // unconditionally therefore did not degrade on an older database file — it
  // blanked the drafts list completely. Caught by the census suite, which seeds
  // exactly this minimal schema.
  const db = new Database(":memory:");
  db.exec(`
    -- No strike/expiration/option_type/direction/strategy_key/return_percent.
    -- payload_json IS present because the detail reader has always selected it;
    -- leaving it out would test a pre-existing gap rather than this change.
    CREATE TABLE opportunity_content_events (
      id TEXT PRIMARY KEY, symbol TEXT, event_type TEXT, occurred_at_ms INTEGER, payload_json TEXT
    );
    CREATE TABLE content_drafts (
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, content_event_id TEXT, opportunity_case_id TEXT,
      category TEXT, template_family TEXT, template_version TEXT, platform TEXT,
      draft_text TEXT, char_count INTEGER, cta_type TEXT, status TEXT,
      discord_delivery_status TEXT, created_at_ms INTEGER, updated_at_ms INTEGER
    );
  `);
  db.prepare("INSERT INTO opportunity_content_events (id,symbol,event_type,occurred_at_ms,payload_json) VALUES ('e1','AAPL','OPPORTUNITY_CLOSED',1,'{}')").run();
  db.prepare(
    `INSERT INTO content_drafts (id,fingerprint,content_event_id,category,template_family,template_version,platform,draft_text,char_count,cta_type,status,discord_delivery_status,created_at_ms,updated_at_ms)
     VALUES ('d1','d1','e1','CLOSED_LOSER','CLOSED_LOSER_0','v1','twitter','text',4,'NONE','GENERATED','SENT',1,1)`,
  ).run();

  const rows = listContentDraftsOnDb(db, { limit: 10 });
  assert.equal(rows.length, 1, "the pre-migration schema still returns its drafts");
  assert.equal(rows[0].id, "d1");
  assert.equal(rows[0].strike, undefined, "the absent column is simply not selected");

  assert.equal(getContentDraftOnDb(db, "d1")?.id, "d1", "the detail reader survives it too");
});
