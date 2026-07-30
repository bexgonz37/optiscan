import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildOptionsSessionAuditOnDb } from "../lib/research/options/session-audit.ts";

const day = "2026-07-30";
const open = Date.parse("2026-07-30T13:30:00.000Z");

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_candidates (id INTEGER PRIMARY KEY, symbol TEXT, option_symbol TEXT, state TEXT, why TEXT, created_at_ms INTEGER);
    CREATE TABLE options_delivery_decisions (id INTEGER PRIMARY KEY, outcome TEXT, reason TEXT, final_delivery_reason TEXT, created_at_ms INTEGER);
    CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, option_symbol TEXT, state TEXT, research_only INTEGER, discord_message_id TEXT, opportunity_case_id TEXT, entry_mid REAL, paper_linked INTEGER, failure_reason TEXT, created_at_ms INTEGER);
    CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY, alert_id TEXT, option_symbol TEXT, paper_kind TEXT);
  `);
  return d;
}

test("session audit is ET-bounded and never upgrades SENT without complete proof", () => {
  const d = db();
  d.prepare("INSERT INTO options_candidates VALUES (?,?,?,?,?,?)").run(1, "NVDA", "O:NVDA260730C00195000", "READY", null, open + 1);
  d.prepare("INSERT INTO options_candidates VALUES (?,?,?,?,?,?)").run(2, "AVGO", null, "REJECTED", "contract gate: spread_too_wide", open + 2);
  d.prepare("INSERT INTO options_candidates VALUES (?,?,?,?,?,?)").run(3, "OLD", "O:OLD", "READY", null, open - 1);
  d.prepare("INSERT INTO options_delivery_decisions VALUES (?,?,?,?,?)").run(1, "DELIVER_TO_DISCORD", "selected", "DELIVERED", open + 3);
  d.prepare("INSERT INTO options_delivery_decisions VALUES (?,?,?,?,?)").run(2, "RESEARCH_ONLY", "below_subscriber_threshold", "SKIPPED", open + 4);
  d.prepare("INSERT INTO options_delivery_decisions VALUES (?,?,?,?,?)").run(3, "REJECT", "contract gate", "REJECTED", open + 5);
  d.prepare("INSERT INTO options_delivery_decisions VALUES (?,?,?,?,?)").run(4, "REJECT", "matching_active_thesis", "matching_active_thesis", open + 6);
  d.prepare("INSERT INTO options_alerts VALUES (?,?,?,?,?,?,?,?,?,?)").run("verified", "O:NVDA260730C00195000", "SENT", 0, "msg-1", "oc-1", 1.25, 1, null, open + 7);
  d.prepare("INSERT INTO options_paper_trades VALUES (?,?,?,?)").run(1, "verified", "O:NVDA260730C00195000", "DELIVERED_ALERT_PAPER");
  d.prepare("INSERT INTO options_alerts VALUES (?,?,?,?,?,?,?,?,?,?)").run("unverified", "O:AVGO260730P00380000", "SENT", 0, null, "oc-2", 2.5, 0, null, open + 8);
  d.prepare("INSERT INTO options_alerts VALUES (?,?,?,?,?,?,?,?,?,?)").run("paper-fail", "O:QQQ260730P00670000", "REJECTED", 0, null, null, null, 0, "paper_reservation_failed", open + 9);
  d.prepare("INSERT INTO options_alerts VALUES (?,?,?,?,?,?,?,?,?,?)").run("outside", "O:OLD", "SENT", 0, "old", "old", 1, 1, null, open - 1);

  const audit = buildOptionsSessionAuditOnDb(d, day);
  assert.equal(audit.sessionBounds.regularOpenMs, open);
  assert.equal(audit.funnel.candidatesDetected, 2);
  assert.equal(audit.funnel.candidatesWithExactOcc, 1);
  assert.equal(audit.funnel.readyCandidates, 1);
  assert.equal(audit.funnel.candidatesRanked, 4);
  assert.equal(audit.funnel.optionsAlertsSent, 2);
  assert.equal(audit.funnel.verifiedDiscordOpeningProof, 1);
  assert.equal(audit.classifications.unverifiedSent, 1);
  assert.equal(audit.classifications.deduplicated, 1);
  assert.equal(audit.classifications.paperLinkFailure, 1);
  assert.equal(audit.productionBehaviorChanged, false);
  assert.match(audit.warnings.join(" "), /unverified/i);
});

test("session audit exposes missing tables as warnings instead of inventing counts", () => {
  const d = new Database(":memory:");
  const audit = buildOptionsSessionAuditOnDb(d, day);
  assert.equal(audit.dataCompleteness.complete, false);
  assert.equal(audit.funnel.optionsAlertsSent, 0);
  assert.ok(audit.dataCompleteness.missingTables.includes("options_alerts"));
});
