/**
 * Opportunity Case persistence — append-friendly, idempotent by opportunity_id.
 */
import { parseCase, serializeCase, type OpportunityCase } from "./schema.ts";

interface CaseDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
}

export function persistOpportunityCaseOnDb(db: CaseDb, c: OpportunityCase): { inserted: boolean; updated: boolean } {
  const existing = db.prepare("SELECT opportunity_id FROM opportunity_cases WHERE opportunity_id=?").get(c.opportunityId);
  const json = serializeCase(c);
  if (existing) {
    db.prepare(
      `UPDATE opportunity_cases SET
        underlying_symbol=?, direction=?, setup_family=?, detected_at_ms=?, market_session=?, source_path=?,
        acceptance_decision=?, delivery_decision=?, rejection_reason_codes_json=?, alert_id=?,
        case_json=?, updated_at_ms=?
       WHERE opportunity_id=?`,
    ).run(
      c.underlyingSymbol, c.direction, c.setupFamily, c.detectedAtMs, c.marketSession, c.sourcePath,
      c.acceptanceDecision, c.deliveryDecision, JSON.stringify(c.rejectionReasonCodes), c.alertId,
      json, c.updatedAtMs, c.opportunityId,
    );
    return { inserted: false, updated: true };
  }
  db.prepare(
    `INSERT INTO opportunity_cases (
      opportunity_id, underlying_symbol, direction, setup_family, detected_at_ms, market_session, source_path,
      acceptance_decision, delivery_decision, rejection_reason_codes_json, alert_id, case_json, created_at_ms, updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    c.opportunityId, c.underlyingSymbol, c.direction, c.setupFamily, c.detectedAtMs, c.marketSession, c.sourcePath,
    c.acceptanceDecision, c.deliveryDecision, JSON.stringify(c.rejectionReasonCodes), c.alertId, json, c.createdAtMs, c.updatedAtMs,
  );
  return { inserted: true, updated: false };
}

export function loadOpportunityCaseOnDb(db: CaseDb, opportunityId: string): OpportunityCase | null {
  const row = db.prepare("SELECT case_json FROM opportunity_cases WHERE opportunity_id=?").get(opportunityId) as { case_json?: string } | undefined;
  if (!row?.case_json) return null;
  return parseCase(row.case_json);
}

export function listRecentOpportunityCasesOnDb(db: CaseDb, limit = 50): OpportunityCase[] {
  const rows = db.prepare(
    "SELECT case_json FROM opportunity_cases ORDER BY detected_at_ms DESC LIMIT ?",
  ).all(limit) as { case_json: string }[];
  return rows.map((r) => parseCase(r.case_json)).filter((c): c is OpportunityCase => c != null);
}

export function countOpportunityCasesByDeliveryOnDb(db: CaseDb, sinceMs: number): Record<string, number> {
  const rows = db.prepare(
    "SELECT delivery_decision, COUNT(*) n FROM opportunity_cases WHERE detected_at_ms >= ? GROUP BY delivery_decision",
  ).all(sinceMs) as { delivery_decision: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.delivery_decision] = Number(r.n);
  return out;
}
