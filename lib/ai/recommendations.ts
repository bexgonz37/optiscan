/**
 * Owner AI recommendation workflow — advisory only, never auto-applies changes.
 */
import { loadEvidencePacketOnDb } from "./evidence-packet.ts";
import { listProposalsOnDb, type ProposalRow } from "./store.ts";

export const RECOMMENDATION_STATUSES = [
  "PROPOSED",
  "NEEDS_MORE_EVIDENCE",
  "APPROVED_FOR_REPLAY",
  "REJECTED",
  "REPLAY_PASSED",
  "APPROVED_FOR_SHADOW",
  "SHADOW_PASSED",
  "APPROVED_FOR_IMPLEMENTATION",
  "IMPLEMENTED",
  "ROLLED_BACK",
] as const;

export type RecommendationStatus = typeof RECOMMENDATION_STATUSES[number];

type RecDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
};

function hasCol(db: RecDb, table: string, col: string): boolean {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col));
  } catch {
    return false;
  }
}

export interface RecommendationView extends ProposalRow {
  recommendationId: string;
  workflowStatus: RecommendationStatus;
  evidencePacketId: string | null;
  completenessPct: number | null;
  currentFormula: string | null;
  proposedFormula: string | null;
  targetFile: string | null;
  acceptanceCriteria: string | null;
  implementedCommitSha: string | null;
}

function mapStatus(raw: string | null | undefined): RecommendationStatus {
  const s = String(raw ?? "PROPOSED").toUpperCase();
  return (RECOMMENDATION_STATUSES as readonly string[]).includes(s) ? s as RecommendationStatus : "PROPOSED";
}

export function enrichProposalRow(db: RecDb, row: ProposalRow): RecommendationView {
  let extra: Record<string, unknown> = {};
  if (hasCol(db, "ai_proposals", "workflow_json")) {
    try {
      const r = db.prepare("SELECT workflow_json FROM ai_proposals WHERE id=?").get(row.id) as { workflow_json?: string } | undefined;
      extra = r?.workflow_json ? JSON.parse(r.workflow_json) : {};
    } catch { extra = {}; }
  }
  return {
    ...row,
    recommendationId: `rec_${row.id}`,
    workflowStatus: mapStatus((extra.workflowStatus as string) ?? row.status),
    evidencePacketId: (extra.evidencePacketId as string) ?? null,
    completenessPct: (extra.completenessPct as number) ?? null,
    currentFormula: (extra.currentFormula as string) ?? null,
    proposedFormula: (extra.proposedFormula as string) ?? row.proposedChange,
    targetFile: (extra.targetFile as string) ?? (row.relevantFiles[0] ?? null),
    acceptanceCriteria: (extra.acceptanceCriteria as string) ?? row.requiredTests,
    implementedCommitSha: (extra.implementedCommitSha as string) ?? null,
  };
}

export function listRecommendationsOnDb(db: RecDb, limit = 50): RecommendationView[] {
  return listProposalsOnDb(db as any, limit).map((p) => enrichProposalRow(db, p));
}

export function buildCursorExportPrompt(rec: RecommendationView, evidence: ReturnType<typeof loadEvidencePacketOnDb>): string {
  return [
    "# OptiScan advisory recommendation (human-approved implementation prompt)",
    `Recommendation ID: ${rec.recommendationId}`,
    `Workflow status: ${rec.workflowStatus}`,
    "",
    "## Problem",
    rec.problem,
    "",
    "## Proposed change",
    rec.proposedFormula ?? rec.proposedChange,
    "",
    "## Target file(s)",
    ...(rec.relevantFiles.length ? rec.relevantFiles.map((f) => `- ${f}`) : ["- (see proposal)"]),
    "",
    "## Acceptance criteria",
    rec.acceptanceCriteria ?? rec.requiredTests ?? "Add tests proving the change improves measured outcomes without breaking lane isolation.",
    "",
    "## Evidence summary",
    evidence ? JSON.stringify({
      packetId: evidence.id,
      missingData: evidence.missingData,
      lanes: evidence.lanes.map((l) => ({ lane: l.lane, n: l.sampleSize, completenessPct: l.completenessPct, expectancy: l.expectancy })),
    }, null, 2) : rec.evidence,
    "",
    "## Governance",
    "Advisory only. Do not change env flags or deploy without explicit human approval and replay/shadow verification.",
  ].join("\n");
}

export function updateRecommendationWorkflowOnDb(
  db: RecDb,
  id: number,
  patch: Partial<{
    workflowStatus: RecommendationStatus;
    decisionNotes: string;
    evidencePacketId: string;
    implementedCommitSha: string;
  }>,
  nowMs = Date.now(),
): boolean {
  if (!hasCol(db, "ai_proposals", "workflow_json")) return false;
  try {
    const row = db.prepare("SELECT workflow_json, status, decision_notes FROM ai_proposals WHERE id=?").get(id) as {
      workflow_json?: string;
      status?: string;
      decision_notes?: string | null;
    } | undefined;
    if (!row) return false;
    const wf = row.workflow_json ? JSON.parse(row.workflow_json) : {};
    if (patch.workflowStatus) wf.workflowStatus = patch.workflowStatus;
    if (patch.evidencePacketId) wf.evidencePacketId = patch.evidencePacketId;
    if (patch.implementedCommitSha) wf.implementedCommitSha = patch.implementedCommitSha;
    const status = patch.workflowStatus === "REJECTED" ? "REJECTED"
      : patch.workflowStatus === "IMPLEMENTED" ? "ACCEPTED"
        : row.status;
    db.prepare("UPDATE ai_proposals SET workflow_json=?, status=?, decision_notes=?, updated_at_ms=? WHERE id=?")
      .run(JSON.stringify(wf), status, patch.decisionNotes ?? row.decision_notes ?? null, nowMs, id);
    return true;
  } catch {
    return false;
  }
}
