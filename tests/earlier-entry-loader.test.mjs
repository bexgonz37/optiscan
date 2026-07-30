import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { loadEarlierEntryCohortOnDb } from "../lib/research/options/earlier-entry-loader.ts";

const day = "2026-07-30";
const sent = Date.parse("2026-07-30T14:00:00.000Z");
function db() { const d = new Database(":memory:"); d.exec(`
  CREATE TABLE options_alerts (alert_id TEXT, candidate_symbol TEXT, strategy TEXT, option_symbol TEXT, side TEXT, entry_mid REAL, delivered_bid REAL, delivered_ask REAL, discord_message_id TEXT, opportunity_case_id TEXT, sent_at_ms INTEGER, created_at_ms INTEGER, paper_linked INTEGER, state TEXT, research_only INTEGER);
  CREATE TABLE options_paper_trades (id INTEGER, alert_id TEXT, option_symbol TEXT, paper_kind TEXT, expiration TEXT, strike REAL);
  CREATE TABLE options_paper_marks (trade_id INTEGER, option_symbol TEXT, mark_at_ms INTEGER, bid REAL, ask REAL, quote_age_ms INTEGER);
  CREATE TABLE options_candidates (symbol TEXT, option_symbol TEXT, first_detected_at_ms INTEGER, first_ready_at_ms INTEGER, feature_snapshot_json TEXT, created_at_ms INTEGER);
`); return d; }

test("loader requires Discord proof, exact OCC, mirror, marks, and timeline without fabricating an entry", () => {
  const d = db(), occ = "O:NVDA260730C00195000";
  d.prepare("INSERT INTO options_alerts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("oa1","NVDA","vwap_reclaim",occ,"call",1,0.98,1.02,"msg","oc1",sent,sent,1,"SENT",0);
  d.prepare("INSERT INTO options_paper_trades VALUES (?,?,?,?,?,?)").run(1,"oa1",occ,"DELIVERED_ALERT_PAPER","2026-07-30",195);
  d.prepare("INSERT INTO options_paper_marks VALUES (?,?,?,?,?,?)").run(1,occ,sent+60_000,1.1,1.14,500);
  d.prepare("INSERT INTO options_paper_marks VALUES (?,?,?,?,?,?)").run(1,"O:NVDA260730C00200000",sent+60_000,2,2.1,500);
  d.prepare("INSERT INTO options_candidates VALUES (?,?,?,?,?,?)").run("NVDA",occ,sent-60_000,sent-30_000,"{}",sent-60_000);
  const out = loadEarlierEntryCohortOnDb(d,{sessionDate:day,evaluationAtMs:sent+120_000});
  assert.equal(out.cohortSize,1);
  assert.equal(out.records[0].historicalMarks.length,1,"wrong OCC mark excluded");
  assert.equal(out.records[0].eligibilityStatus,"INSUFFICIENT_EVIDENCE");
  assert.equal(out.eligibleCount,0,"midpoint-only timeline cannot become a conservative earlier entry");
});

test("loader rejects after-hours and stale marks rather than treating them as historical evidence", () => {
  const d = db(), occ = "O:NVDA260730C00195000";
  d.prepare("INSERT INTO options_alerts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("oa2","NVDA","x",occ,"call",1,1,1.04,"msg","oc",sent,sent,1,"SENT",0);
  d.prepare("INSERT INTO options_paper_trades VALUES (?,?,?,?,?,?)").run(2,"oa2",occ,"DELIVERED_ALERT_PAPER","2026-07-30",195);
  d.prepare("INSERT INTO options_paper_marks VALUES (?,?,?,?,?,?)").run(2,occ,Date.parse("2026-07-30T20:15:00Z"),1.2,1.25,0);
  d.prepare("INSERT INTO options_paper_marks VALUES (?,?,?,?,?,?)").run(2,occ,sent+60_000,1.2,1.25,120_000);
  const out = loadEarlierEntryCohortOnDb(d,{sessionDate:day,evaluationAtMs:Date.parse("2026-07-30T21:00:00Z")});
  assert.equal(out.records[0].historicalMarks.length,0);
  assert.equal(out.records[0].eligibilityStatus,"MISSING_MARKS");
});
