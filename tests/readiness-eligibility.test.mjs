import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  classifyReadinessDuplicatesOnDb,
  classifyHistoricalPaperRowsOnDb,
  readinessSampleCutoffMs,
  resetReadinessEligibleDefaultForTests,
} from "../lib/research/readiness-sample.ts";

const CUTOFF = Date.parse("2026-07-26T23:36:55.228Z");
const ENV = { SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS: String(CUTOFF) };

test("readiness cutoff prefers SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS over milestone fallback", () => {
  resetReadinessEligibleDefaultForTests(null);
  assert.equal(readinessSampleCutoffMs(ENV), CUTOFF);
  assert.equal(readinessSampleCutoffMs({ SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS: String(CUTOFF), OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS: "999" }), CUTOFF);
  assert.equal(readinessSampleCutoffMs({ OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS: String(CUTOFF) }), CUTOFF);
  assert.equal(readinessSampleCutoffSource({ OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS: String(CUTOFF) }), "OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS_fallback");
});

test("duplicate classification separates all-time fingerprints from post-cutoff actual sends", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT, strategy TEXT, option_symbol TEXT, side TEXT,
      research_only INTEGER DEFAULT 0, state TEXT, paper_linked INTEGER, entry_quality_verdict TEXT,
      opportunity_fingerprint TEXT, trading_session_date TEXT, sent_at_ms INTEGER,
      discord_message_id TEXT, opportunity_case_id TEXT, entry_mid REAL,
      created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE opportunity_cases (opportunity_id TEXT PRIMARY KEY, source_path TEXT);
    CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT, paper_kind TEXT, status TEXT);
  `);
  const pre = CUTOFF - 86_400_000;
  const post = CUTOFF + 60_000;
  // Historical duplicate fingerprints (no discord id — not eligible)
  db.prepare(`INSERT INTO options_alerts (alert_id,candidate_symbol,strategy,option_symbol,side,research_only,state,paper_linked,entry_quality_verdict,opportunity_fingerprint,trading_session_date,sent_at_ms,discord_message_id,opportunity_case_id,entry_mid,created_at_ms,updated_at_ms) VALUES ('oa_h1','SPY','s','O:1','call',0,'SENT',1,'EARLY','fp_old','2026-07-01',?,NULL,NULL,NULL,?,?)`).run(pre, pre, pre);
  db.prepare(`INSERT INTO options_alerts (alert_id,candidate_symbol,strategy,option_symbol,side,research_only,state,paper_linked,entry_quality_verdict,opportunity_fingerprint,trading_session_date,sent_at_ms,discord_message_id,opportunity_case_id,entry_mid,created_at_ms,updated_at_ms) VALUES ('oa_h2','SPY','s','O:2','call',0,'SENT',1,'EARLY','fp_old','2026-07-01',?,NULL,NULL,NULL,?,?)`).run(pre + 1, pre + 1, pre + 1);
  db.prepare(`INSERT INTO options_alerts (alert_id,candidate_symbol,strategy,option_symbol,side,research_only,state,paper_linked,entry_quality_verdict,opportunity_fingerprint,trading_session_date,sent_at_ms,discord_message_id,opportunity_case_id,entry_mid,created_at_ms,updated_at_ms) VALUES ('oa_aapl','AAPL','s','O:3','call',0,'SENT',1,'TIMELY','fp_aapl','2026-07-27',?,?,?,?,?,?)`).run(post, "dm1", "oc1", 1.0, post, post);
  db.prepare(`INSERT INTO opportunity_cases VALUES ('oc1','independent')`).run();
  db.prepare(`INSERT INTO options_paper_trades (alert_id, paper_kind, status) VALUES ('oa_aapl','DELIVERED_ALERT_PAPER','ENTERED')`).run();

  const dup = classifyReadinessDuplicatesOnDb(db, ENV);
  assert.equal(dup.fingerprintExtrasAllTime, 1, "one extra historical fingerprint row");
  assert.equal(dup.actualDuplicateDeliveriesPostCutoff, 0, "no actual duplicate Discord sends post-cutoff");
  assert.equal(dup.sentWithoutDiscordPostCutoff, 0);

  const paper = classifyHistoricalPaperRowsOnDb(db, ENV);
  assert.equal(paper.historicalUnhealthy, 2);
  assert.equal(paper.launchSampleHealthy, 1);
  db.close();
});
