import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { tradingDay } from "../lib/trading-session.ts";
import { evaluateSubscriberReadiness } from "../lib/research/subscriber-readiness.ts";
import {
  runReadinessTransition,
  setReadinessAttestationOnDb,
  sendReadinessTestNotificationOnDb,
  readReadinessStateOnDb,
} from "../lib/research/subscriber-readiness-notifier.ts";

// The test runner has no "@/" alias, so we build the exact tables the readiness evaluator queries.
// The optional data-integrity requires (schema-readiness / paper-chain / fallback-inserts) resolve
// "@/…" which the raw runner cannot load; the evaluator catches that and treats them as clean — so
// this in-memory subset is sufficient and faithful to how those signals degrade.
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE options_alerts (
    alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT,
    research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, paper_linked INTEGER NOT NULL DEFAULT 0,
    entry_quality_verdict TEXT, opportunity_fingerprint TEXT, trading_session_date TEXT, sent_at_ms INTEGER,
    discord_message_id TEXT, opportunity_case_id TEXT, entry_mid REAL,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE opportunity_cases (
    opportunity_id TEXT PRIMARY KEY, alert_id TEXT, source_path TEXT NOT NULL DEFAULT 'independent',
    delivery_decision TEXT NOT NULL DEFAULT 'DELIVERED', detected_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE options_paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
    result_class TEXT NOT NULL, entry_fill REAL, strategy TEXT, target REAL, invalidation REAL, status TEXT NOT NULL,
    paper_kind TEXT, alert_id TEXT, underlying_price REAL, return_pct REAL, exit_reason TEXT,
    mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL,
    entered_at_ms INTEGER, exit_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE options_paper_marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER, option_symbol TEXT, mark_at_ms INTEGER,
    bid REAL, ask REAL, exit_fill REAL, return_pct REAL, quote_age_ms INTEGER, created_at_ms INTEGER
  );
  CREATE TABLE opportunity_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_case_id TEXT NOT NULL, event_key TEXT NOT NULL,
    event_type TEXT NOT NULL, label TEXT NOT NULL, reached_at_ms INTEGER NOT NULL, delivered_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, UNIQUE(opportunity_case_id, event_key)
  );
  CREATE TABLE discord_deliveries (
    delivery_id TEXT PRIMARY KEY, webhook_name TEXT NOT NULL, payload_type TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE options_subscriber_readiness_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL DEFAULT 'NOT_READY', transition_id INTEGER NOT NULL DEFAULT 0,
    last_evaluated_at_ms INTEGER, last_transition_at_ms INTEGER, last_failing_gate TEXT, evidence_snapshot_json TEXT,
    ready_notified_transition_id INTEGER, revoked_notified_transition_id INTEGER, last_notification_kind TEXT,
    last_notification_status TEXT, last_notification_error TEXT, last_notification_message_id TEXT, last_notification_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE options_subscriber_readiness_attestations (
    attestation_key TEXT PRIMARY KEY, attested INTEGER NOT NULL DEFAULT 0, attested_by TEXT, note TEXT,
    attested_at_ms INTEGER, updated_at_ms INTEGER NOT NULL
  );
`);

const NOW = Date.parse("2026-07-01T15:00:00-04:00");

// Owner env for a would-be launch: independent owner, guards enforced, billing + role env present.
const READY_ENV = {
  OPTIONS_CALLOUTS_KILL: "0",
  SUBSCRIBER_OPTIONS_DISCORD_OWNER: "independent",
  ENTRY_QUALITY_GATE: "enforce",
  MARKET_SESSION_GUARD: "enforce",
  DISCORD_WEBHOOK_RECAP: "https://discord.test/webhook/recap",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  DISCORD_BOT_TOKEN: "bot_x",
  DISCORD_GUILD_ID: "guild_x",
  DISCORD_SUBSCRIBER_ROLE_ID: "role_x",
  SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS: String(Date.parse("2026-01-01T00:00:00-05:00")),
};

function reset() {
  for (const t of [
    "options_alerts", "opportunity_cases", "options_paper_trades", "options_paper_marks", "opportunity_milestones",
    "options_subscriber_readiness_state", "options_subscriber_readiness_attestations", "discord_deliveries",
  ]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table optional */ }
  }
}

/** Business weekdays in June 2026 (EDT), skipping Juneteenth 2026-06-19. */
function businessDays() {
  const days = [];
  for (let d = 1; d <= 30 && days.length < 16; d++) {
    const iso = `2026-06-${String(d).padStart(2, "0")}`;
    const ms = Date.parse(`${iso}T15:00:00-04:00`);
    const wd = new Date(ms).getUTCDay(); // 19:00Z → same calendar day; 0=Sun 6=Sat
    if (wd === 0 || wd === 6) continue;
    if (iso === "2026-06-19") continue; // Juneteenth holiday
    days.push(ms);
  }
  return days;
}

/** Seed a passing launch sample: 30 delivered+linked alerts across ≥12 days, 30 closed graded mirrors. */
function seedReady({ winners = 22, losers = 8 } = {}) {
  const days = businessDays();
  const total = winners + losers;
  for (let i = 0; i < total; i++) {
    const sentAt = days[i % days.length] + (i * 1000); // spread within the day
    const sessionDate = tradingDay(sentAt);
    const alertId = `oa_${i}`;
    const opt = `O:TEST${i}260717C00100000`;
    const caseId = `oc_${i}`;
    db.prepare(
      `INSERT INTO options_alerts
        (alert_id, candidate_symbol, strategy, option_symbol, side, research_only, state, paper_linked,
         entry_quality_verdict, opportunity_fingerprint, trading_session_date, sent_at_ms,
         discord_message_id, opportunity_case_id, entry_mid, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,0,'SENT',1,'EARLY',?,?,?,?,?,?,?,?)`,
    ).run(alertId, `SYM${i}`, "sr_reclaim", opt, "call", `fp_${i}`, sessionDate, sentAt, `discord_${i}`, caseId, 1.0, sentAt, sentAt);
    db.prepare(
      `INSERT INTO opportunity_cases (opportunity_id, alert_id, source_path, delivery_decision, detected_at_ms, created_at_ms, updated_at_ms)
       VALUES (?,?, 'independent', 'DELIVERED', ?, ?, ?)`,
    ).run(caseId, alertId, sentAt, sentAt, sentAt);

    const ret = i < winners ? 50 : -20;
    const enteredAt = sentAt;
    const exitAt = sentAt + 30 * 60_000; // closed within 60 minutes
    db.prepare(
      `INSERT INTO options_paper_trades
        (option_symbol, side, strike, expiration, dte, result_class, entry_fill, strategy, target, invalidation,
         status, paper_kind, alert_id, underlying_price, return_pct, exit_reason, entered_at_ms, exit_at_ms, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?, 'REAL_OPTION_PAPER', ?, ?, ?, ?, 'EXITED', 'DELIVERED_ALERT_PAPER', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(opt, "call", 100, "2026-07-17", 16, 1.0, "sr_reclaim", 1.5, 0.6, alertId, 100, ret, ret > 0 ? "target_hit" : "stop_hit", enteredAt, exitAt, enteredAt, exitAt);
  }
  // Milestone proof: BOTH a return-milestone AND an opportunity-closed update delivered.
  db.prepare(
    `INSERT INTO opportunity_milestones (opportunity_case_id, event_key, event_type, label, reached_at_ms, delivered_at_ms, created_at_ms, updated_at_ms)
     VALUES ('oc_1','k1','RETURN_MILESTONE','+25%', ?, ?, ?, ?)`,
  ).run(NOW, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO opportunity_milestones (opportunity_case_id, event_key, event_type, label, reached_at_ms, delivered_at_ms, created_at_ms, updated_at_ms)
     VALUES ('oc_1','k2','OPPORTUNITY_CLOSED','closed', ?, ?, ?, ?)`,
  ).run(NOW, NOW, NOW, NOW);
  // All owner attestations signed.
  for (const key of ["billing_flows_tested", "legal_checklist_complete", "no_critical_issues_ack"]) {
    setReadinessAttestationOnDb(db, key, true, { attestedBy: "owner", nowMs: NOW });
  }
}

function captureDeps() {
  const sent = [];
  return {
    sent,
    deps: {
      send: async (content) => { sent.push(content); return { ok: true, messageId: `m${sent.length}`, error: null }; },
      webhookConfigured: () => true,
      now: () => NOW,
    },
  };
}

test("NOT_READY when profitability evidence is incomplete (too few graded trades)", () => {
  reset();
  seedReady({ winners: 8, losers: 2 }); // only 10 delivered/graded → below the 20 & 30 floors
  const report = evaluateSubscriberReadiness(db, READY_ENV, NOW);
  assert.equal(report.status, "NOT_READY");
  assert.ok(report.blockingGates.includes("delivered_linked_sample"));
  assert.ok(report.blockingGates.includes("complete_grading"));
});

test("full sample transitions NOT_READY → SUBSCRIBER_READY exactly once and does not resend on restart", async () => {
  reset();
  seedReady();
  const { sent, deps } = captureDeps();

  const first = await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW });
  assert.equal(first.report.status, "SUBSCRIBER_READY", `blocked by ${first.report.blockingGates.join(",")}`);
  assert.equal(first.transitioned, true);
  assert.equal(first.notificationKind, "READY");
  assert.equal(first.notificationSent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /SUBSCRIBER READINESS ACHIEVED/);
  assert.match(sent[0], /final human review/i);

  // Second run (same evidence) = restart-equivalent: state is read from the DB, nothing resends.
  const second = await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW + 60_000 });
  assert.equal(second.transitioned, false);
  assert.equal(second.notificationSent, false);
  assert.equal(sent.length, 1, "no duplicate READY notification after restart");

  const state = readReadinessStateOnDb(db);
  assert.equal(state.status, "SUBSCRIBER_READY");
  assert.equal(state.lastNotificationStatus, "SENT");
});

test("a safety breach REVOKES immediately and names the failing gate; then returns to READY", async () => {
  reset();
  seedReady();
  const { sent, deps } = captureDeps();
  await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW });
  assert.equal(sent.length, 1);

  // Introduce a cross-session opening (a safety/integrity violation).
  db.prepare("UPDATE options_alerts SET trading_session_date='1999-01-01' WHERE alert_id='oa_0'").run();
  const revoke = await runReadinessTransition(db, deps, READY_ENV, { trigger: "intraday", nowMs: NOW + 120_000 });
  assert.equal(revoke.report.status, "NOT_READY");
  assert.equal(revoke.notificationKind, "REVOKED");
  assert.equal(sent.length, 2);
  assert.match(sent[1], /SUBSCRIBER READINESS REVOKED/);
  assert.equal(revoke.state.lastFailingGate, "no_session_violations");

  // Fix it → returns to READY with a fresh notification.
  db.prepare("UPDATE options_alerts SET trading_session_date=? WHERE alert_id='oa_0'")
    .run(tradingDay(Number(db.prepare("SELECT sent_at_ms s FROM options_alerts WHERE alert_id='oa_0'").get().s)));
  const back = await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW + 180_000 });
  assert.equal(back.report.status, "SUBSCRIBER_READY", `blocked by ${back.report.blockingGates.join(",")}`);
  assert.equal(back.notificationKind, "READY");
  assert.equal(sent.length, 3);
});

test("missing owner attestation keeps NOT_READY even when all metrics pass", async () => {
  reset();
  seedReady();
  setReadinessAttestationOnDb(db, "legal_checklist_complete", false, { nowMs: NOW });
  const { sent, deps } = captureDeps();
  const res = await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW });
  assert.equal(res.report.status, "NOT_READY");
  assert.ok(res.report.blockingGates.includes("attest_legal_checklist_complete"));
  assert.equal(sent.length, 0, "no notification while an attestation is missing");
});

test("READY promotion does NOT fire mid-session on an intraday trigger (day-boundary rule)", async () => {
  reset();
  seedReady();
  const { sent, deps } = captureDeps();
  // 11:00 ET on a weekday = REGULAR_SESSION → intraday trigger must not promote to READY.
  const midSession = Date.parse("2026-07-01T11:00:00-04:00");
  const res = await runReadinessTransition(db, deps, READY_ENV, { trigger: "intraday", nowMs: midSession });
  assert.equal(res.report.ready, true, "evidence itself is ready");
  assert.equal(res.transitioned, false, "but promotion waits for the day boundary");
  assert.equal(sent.length, 0);
});

test("manual re-evaluate CANNOT bypass gates — insufficient sample stays NOT_READY", async () => {
  reset();
  seedReady({ winners: 8, losers: 2 }); // 10 trades — below sample & grading floors
  const { sent, deps } = captureDeps();
  const res = await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW });
  assert.equal(res.report.status, "NOT_READY");
  assert.ok(res.report.blockingGates.includes("delivered_linked_sample"));
  assert.ok(res.report.blockingGates.includes("complete_grading"));
  assert.equal(sent.length, 0, "manual re-evaluate sent no premature READY");
});

test("manual re-evaluate CANNOT bypass a safety/integrity gate", async () => {
  reset();
  seedReady();
  db.prepare("UPDATE options_alerts SET trading_session_date='1999-01-01' WHERE alert_id='oa_0'").run();
  const { sent, deps } = captureDeps();
  const res = await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW });
  assert.equal(res.report.status, "NOT_READY");
  assert.ok(res.report.blockingGates.includes("no_session_violations"));
  assert.equal(sent.length, 0);
});

test("a READY transition mutates NOTHING but its own state + the one notification (isolation)", async () => {
  reset();
  seedReady();
  const envSnapshot = JSON.parse(JSON.stringify(READY_ENV));
  const { sent, deps } = captureDeps();
  const res = await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW });
  assert.equal(res.report.status, "SUBSCRIBER_READY");
  // No env mutation: cannot enable billing, roles, marketing, deploys, or Railway vars.
  assert.deepEqual(READY_ENV, envSnapshot, "env object was not mutated by a readiness transition");
  assert.equal(READY_ENV.BILLING_ENABLED, undefined);
  // The ONLY external effect is exactly one owner notification.
  assert.equal(sent.length, 1);
  // The only readiness-owned writes are the two readiness tables.
  const stateRows = db.prepare("SELECT COUNT(*) n FROM options_subscriber_readiness_state").get().n;
  assert.equal(stateRows, 1);
});

test("a FAILED send is retried WITHOUT a new edge and never double-sends the READY notice", async () => {
  reset();
  seedReady();
  const sent = [];
  let calls = 0;
  const deps = {
    send: async (content) => {
      calls += 1; sent.push(content);
      if (calls === 1) return { ok: false, messageId: null, error: "simulated 500" };
      return { ok: true, messageId: `m${calls}`, error: null };
    },
    webhookConfigured: () => true,
    now: () => NOW,
  };
  // First run: transitions to READY, but the send fails → FAILED, no notified stamp.
  const first = await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW });
  assert.equal(first.transitioned, true);
  assert.equal(first.notificationSent, false);
  let state = readReadinessStateOnDb(db);
  assert.equal(state.status, "SUBSCRIBER_READY");
  assert.equal(state.lastNotificationStatus, "FAILED");

  // Second run: NO new edge, but the owed notification is retried and now succeeds.
  const second = await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW + 5_000 });
  assert.equal(second.transitioned, false, "no second transition");
  assert.equal(second.notificationSent, true);
  assert.equal(calls, 2, "exactly one retry — the first failed, the second succeeded");
  state = readReadinessStateOnDb(db);
  assert.equal(state.status, "SUBSCRIBER_READY");
  assert.equal(state.lastNotificationStatus, "SENT");
  assert.equal(state.transitionId, 1, "still the same transition — never double-counted");

  // Third run: nothing owed → no further sends.
  await runReadinessTransition(db, deps, READY_ENV, { trigger: "manual", nowMs: NOW + 10_000 });
  assert.equal(calls, 2, "no resend once SENT");
});

test("historical alerts before launch cutoff are excluded from readiness sample", () => {
  reset();
  const cutoff = Date.parse("2026-05-01T00:00:00-04:00");
  const env = { ...READY_ENV, SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS: String(cutoff) };
  // Historical alert (before cutoff) with duplicate fingerprint
  const oldMs = Date.parse("2026-04-01T15:00:00-04:00");
  db.prepare(
    `INSERT INTO options_alerts
      (alert_id, candidate_symbol, strategy, option_symbol, side, research_only, state, paper_linked,
       entry_quality_verdict, opportunity_fingerprint, trading_session_date, sent_at_ms, created_at_ms, updated_at_ms)
     VALUES ('oa_old1', 'OLD', 'sr_reclaim', 'O:OLD', 'call', 0, 'SENT', 1, 'LATE', 'fp_dup', '2026-04-01', ?, ?, ?),
            ('oa_old2', 'OLD', 'sr_reclaim', 'O:OLD2', 'call', 0, 'SENT', 1, 'LATE', 'fp_dup', '2026-04-01', ?, ?, ?)`,
  ).run(oldMs, oldMs, oldMs, oldMs + 1000, oldMs + 1000, oldMs + 1000);
  db.prepare(
    "INSERT INTO discord_deliveries (delivery_id, webhook_name, payload_type, status) VALUES ('d_old', 'options', 'callout', 'SENT')",
  ).run();
  seedReady({ winners: 22, losers: 8 });
  const report = evaluateSubscriberReadiness(db, env, NOW);
  assert.equal(report.metrics.deliveredSent, 30, "only post-cutoff seed alerts count");
  assert.equal(report.metrics.duplicateDeliveredCount, 0, "pre-cutoff duplicate fingerprints excluded");
  assert.equal(report.metrics.deliveredSentHistorical, 2);
  assert.ok(Number(report.metrics.supervisorLegacySendsHistorical) >= 0);
});

test("test-notification sends a labeled message and NEVER changes readiness state", async () => {
  reset();
  seedReady();
  const before = readReadinessStateOnDb(db); // null — no state row yet
  const { sent, deps } = captureDeps();
  const res = await sendReadinessTestNotificationOnDb(db, deps, READY_ENV);
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /TEST/);
  const after = readReadinessStateOnDb(db);
  assert.equal(before, null);
  assert.equal(after, null, "test notification created no state row");
});
