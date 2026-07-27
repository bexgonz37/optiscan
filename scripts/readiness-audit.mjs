/**
 * Readiness sample audit — explains duplicate/supervisor/profitability contamination.
 * Usage: node scripts/readiness-audit.mjs [db-path]
 */
import Database from "better-sqlite3";
import { evaluateSubscriberReadiness } from "../lib/research/subscriber-readiness.ts";
import { readinessSampleCutoffMs } from "../lib/research/readiness-sample.ts";

const dbPath = process.argv[2] || process.env.DATABASE_PATH || "data/optiscan.db";
const env = { ...process.env };
const cutoffMs = readinessSampleCutoffMs(env);
const cutoffIso = new Date(cutoffMs).toISOString();

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error("Cannot open DB:", dbPath, err.message);
  process.exit(1);
}

const sampleSql =
  "state='SENT' AND research_only=0 AND sent_at_ms IS NOT NULL AND sent_at_ms >= ?";

const allSent = db.prepare("SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND research_only=0").get().n;
const sampleSent = db.prepare(`SELECT COUNT(*) n FROM options_alerts WHERE ${sampleSql}`).get(cutoffMs).n;
const preCutoff = allSent - sampleSent;

const dupGroups = db.prepare(
  `SELECT COALESCE(opportunity_fingerprint, candidate_symbol || '|' || side || '|' || strategy || '|' || option_symbol) fp,
          COUNT(*) c,
          SUM(CASE WHEN sent_at_ms >= ? THEN 1 ELSE 0 END) post,
          SUM(CASE WHEN sent_at_ms < ? OR sent_at_ms IS NULL THEN 1 ELSE 0 END) pre
     FROM options_alerts
    WHERE state='SENT' AND research_only=0
    GROUP BY fp
   HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 20`,
).all(cutoffMs, cutoffMs);

const dupPost = db.prepare(
  `SELECT COALESCE(SUM(dupes),0) n FROM (
     SELECT COUNT(*) - 1 AS dupes FROM options_alerts WHERE ${sampleSql}
     GROUP BY COALESCE(opportunity_fingerprint, candidate_symbol || '|' || side || '|' || strategy || '|' || option_symbol)
     HAVING COUNT(*) > 1
   )`,
).get(cutoffMs).n;

const dupAll = db.prepare(
  `SELECT COALESCE(SUM(dupes),0) n FROM (
     SELECT COUNT(*) - 1 AS dupes FROM options_alerts WHERE state='SENT' AND research_only=0
     GROUP BY COALESCE(opportunity_fingerprint, candidate_symbol || '|' || side || '|' || strategy || '|' || option_symbol)
     HAVING COUNT(*) > 1
   )`,
).get().n;

const supervisorAll = db.prepare(
  "SELECT COUNT(*) n FROM discord_deliveries WHERE webhook_name='options' AND payload_type='callout' AND status='SENT'",
).get().n;
const supervisorPost = db.prepare(
  `SELECT COUNT(*) n FROM discord_deliveries
    WHERE webhook_name='options' AND payload_type='callout' AND status='SENT'
      AND (CAST(strftime('%s', created_at) AS INTEGER) * 1000) >= ?`,
).get(cutoffMs).n;

const missingCase = db.prepare(
  `SELECT COUNT(*) n FROM options_alerts a
    LEFT JOIN opportunity_cases oc ON oc.alert_id = a.alert_id
   WHERE a.state='SENT' AND a.research_only=0 AND a.sent_at_ms >= ?
     AND a.opportunity_case_id IS NULL AND oc.opportunity_id IS NULL`,
).get(cutoffMs).n;

const missingCasePre = db.prepare(
  `SELECT COUNT(*) n FROM options_alerts a
    LEFT JOIN opportunity_cases oc ON oc.alert_id = a.alert_id
   WHERE a.state='SENT' AND a.research_only=0 AND a.sent_at_ms IS NOT NULL AND a.sent_at_ms < ?
     AND a.opportunity_case_id IS NULL AND oc.opportunity_id IS NULL`,
).get(cutoffMs).n;

const report = evaluateSubscriberReadiness(db, env);

console.log(JSON.stringify({
  cutoffMs,
  cutoffIso,
  alerts: { allSent, sampleSent, preCutoff },
  duplicates: { allTimeExtra: dupAll, postCutoffExtra: dupPost, topGroups: dupGroups },
  supervisorLegacy: { allTime: supervisorAll, postCutoff: supervisorPost, preCutoff: supervisorAll - supervisorPost },
  missingCase: { postCutoff: missingCase, preCutoff: missingCasePre },
  readinessMetrics: report.metrics,
  blockingGates: report.blockingGates,
}, null, 2));

db.close();
