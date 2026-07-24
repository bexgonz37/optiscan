/**
 * Strategy report cards — participation ≠ causation.
 */
export type ReportCardLifecycle = "ACTIVE" | "SHADOW" | "RESEARCH_ONLY" | "INACTIVE" | "BLOCKED" | "DEGRADED" | "RETIRED";

export interface StrategyReportCard {
  strategyId: string;
  version: string;
  lifecycle: ReportCardLifecycle;
  supportCount: number;
  conflictCount: number;
  vetoCount: number;
  insufficientDataCount: number;
  deliveredParticipation: number;
  rejectedParticipation: number;
  avgLatencyMs: number | null;
  missingDataFrequency: number;
  validationStatus: "unvalidated" | "shadow" | "forward_validated" | "approved";
  lastValidatedAtMs: number | null;
  notes: string[];
}

export function buildReportCardFromEvaluations(
  strategyId: string,
  evaluations: { signal: string; latencyMs: number; missingDataRequirements: string[]; lifecycleStatus: string }[],
  delivered = 0,
  rejected = 0,
): StrategyReportCard {
  const support = evaluations.filter((e) => e.signal === "SUPPORTIVE").length;
  const conflict = evaluations.filter((e) => e.signal === "CONFLICTING").length;
  const veto = evaluations.filter((e) => e.signal === "VETO").length;
  const insufficient = evaluations.filter((e) => e.signal === "INSUFFICIENT_DATA").length;
  const latencies = evaluations.map((e) => e.latencyMs).filter((n) => n > 0);
  const lifecycle = (evaluations[0]?.lifecycleStatus as ReportCardLifecycle) ?? "INACTIVE";

  return {
    strategyId,
    version: "1",
    lifecycle,
    supportCount: support,
    conflictCount: conflict,
    vetoCount: veto,
    insufficientDataCount: insufficient,
    deliveredParticipation: delivered,
    rejectedParticipation: rejected,
    avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    missingDataFrequency: evaluations.length ? insufficient / evaluations.length : 0,
    validationStatus: "unvalidated",
    lastValidatedAtMs: null,
    notes: ["Participation does not imply causal impact on outcomes"],
  };
}
