/**
 * Safe, provable-only repair for independent-path paper chain links.
 * Never fabricates opportunity cases or paper mirrors.
 */
import { findOpportunityCaseIdByAlertOnDb } from "../../opportunity-case/live.ts";
import { readinessSampleCutoffMs } from "../readiness-sample.ts";

type RepairDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes: number };
  };
};

function hasTable(db: RepairDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export interface PaperChainRepairResult {
  generatedAtMs: number;
  cutoffMs: number;
  alertCaseLinksRepaired: number;
  alertsMarkedHistorical: number;
  unrecoverablePreCutoff: number;
  details: string[];
}

/**
 * Repair only provable relationships:
 * 1. alert.opportunity_case_id missing but opportunity_cases.alert_id matches → backfill alert row
 * 2. pre-cutoff alerts without case → count as historical (excluded from readiness, not deleted)
 */
export function repairProvablePaperChainLinksOnDb(
  db: RepairDb,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): PaperChainRepairResult {
  const cutoffMs = readinessSampleCutoffMs(env);
  const result: PaperChainRepairResult = {
    generatedAtMs: nowMs,
    cutoffMs,
    alertCaseLinksRepaired: 0,
    alertsMarkedHistorical: 0,
    unrecoverablePreCutoff: 0,
    details: [],
  };
  if (!hasTable(db, "options_alerts")) return result;

  const alerts = db.prepare(
    `SELECT alert_id, opportunity_case_id, sent_at_ms, paper_linked
       FROM options_alerts
      WHERE state='SENT' AND research_only=0`,
  ).all() as { alert_id: string; opportunity_case_id: string | null; sent_at_ms: number | null; paper_linked: number }[];

  for (const a of alerts) {
    const sentAt = Number(a.sent_at_ms ?? 0);
    if (a.opportunity_case_id) continue;
    const caseId = findOpportunityCaseIdByAlertOnDb(db as any, a.alert_id);
    if (caseId) {
      try {
        const ch = db.prepare(
          "UPDATE options_alerts SET opportunity_case_id=?, updated_at_ms=? WHERE alert_id=? AND opportunity_case_id IS NULL",
        ).run(caseId, nowMs, a.alert_id).changes;
        if (ch > 0) {
          result.alertCaseLinksRepaired += 1;
          result.details.push(`linked ${a.alert_id} → ${caseId}`);
        }
      } catch { /* isolated */ }
      continue;
    }
    if (sentAt > 0 && sentAt < cutoffMs) {
      result.unrecoverablePreCutoff += 1;
    }
  }

  result.alertsMarkedHistorical = result.unrecoverablePreCutoff;
  return result;
}
