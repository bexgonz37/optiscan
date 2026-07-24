import { brokerId } from "./id.ts";
import { appendAuditEvent, type BrokerDb } from "./audit.ts";
import type { EvidenceChainInput, EvidenceChainRow } from "./types.ts";

export function createEvidenceChain(
  db: BrokerDb,
  input: EvidenceChainInput,
  createdAtMs: number = Date.now(),
): EvidenceChainRow {
  const id = brokerId("bev");
  db.prepare(
    `INSERT INTO broker_evidence_chains
      (id, market_observation_ref, strategy_evaluation_ref, candidate_ref, delivery_decision_ref,
       alert_id, opportunity_case_id, options_candidate_id, setup_candidate_id, chain_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.marketObservationRef ?? null,
    input.strategyEvaluationRef ?? null,
    input.candidateRef ?? null,
    input.deliveryDecisionRef ?? null,
    input.alertId ?? null,
    input.opportunityCaseId ?? null,
    input.optionsCandidateId ?? null,
    input.setupCandidateId ?? null,
    JSON.stringify(input.chainJson),
    createdAtMs,
  );
  appendAuditEvent(db, {
    eventKind: "EVIDENCE_CHAIN_CREATED",
    entityKind: "EVIDENCE",
    entityId: id,
    payload: {
      marketObservationRef: input.marketObservationRef ?? null,
      strategyEvaluationRef: input.strategyEvaluationRef ?? null,
      candidateRef: input.candidateRef ?? null,
      deliveryDecisionRef: input.deliveryDecisionRef ?? null,
      alertId: input.alertId ?? null,
      opportunityCaseId: input.opportunityCaseId ?? null,
    },
    createdAtMs,
  });
  return getEvidenceChain(db, id)!;
}

export function getEvidenceChain(db: BrokerDb, id: string): EvidenceChainRow | null {
  return db
    .prepare(`SELECT * FROM broker_evidence_chains WHERE id = ?`)
    .get(id) as EvidenceChainRow | null;
}

export function traceEvidenceForOrder(db: BrokerDb, orderId: string): EvidenceChainRow | null {
  const order = db
    .prepare(`SELECT evidence_chain_id FROM broker_orders WHERE id = ?`)
    .get(orderId) as { evidence_chain_id: string | null } | undefined;
  if (!order?.evidence_chain_id) return null;
  return getEvidenceChain(db, order.evidence_chain_id);
}

export function traceEvidenceForFill(db: BrokerDb, fillId: string): EvidenceChainRow | null {
  const fill = db
    .prepare(`SELECT order_id FROM broker_fills WHERE id = ?`)
    .get(fillId) as { order_id: string } | undefined;
  if (!fill) return null;
  return traceEvidenceForOrder(db, fill.order_id);
}
