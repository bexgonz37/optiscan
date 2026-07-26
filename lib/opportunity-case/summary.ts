/**
 * Opportunity Summary — living, deterministic projection of an Opportunity Case.
 * Downstream consumers should read this object instead of recomputing state.
 * AI may consume it later but must never modify it.
 */
import type { OpportunityEvidenceEvent } from "./evidence.ts";
import type { OpportunityLifecycleStatus, LifecycleEventType } from "./lifecycle.ts";
import { lifecycleEventLabel } from "./lifecycle.ts";

export interface OpportunityMilestoneRecord {
  eventType: LifecycleEventType;
  milestonePercent: number | null;
  label: string;
  reachedAt: string;
  reachedAtMs: number;
  contractMark: number | null;
  returnPercent: number | null;
  deliveredAt: string | null;
  discordMessageId?: string | null;
  details?: Record<string, unknown>;
}

export interface OpportunitySummary {
  currentReturnPct: number | null;
  maxReturnPct: number | null;
  currentStatus: OpportunityLifecycleStatus;
  originalThesis: string[];
  evidenceCount: number;
  latestEvidence: OpportunityEvidenceEvent | null;
  milestoneHistory: OpportunityMilestoneRecord[];
  elapsedTimeMs: number | null;
  currentConfidence: number | null;
  lastUpdatedAt: string;
  frozenEntry: number | null;
  currentMark: number | null;
  nextUndeliveredReturnMilestone: number | null;
  active: boolean;
  openedAtMs: number | null;
}

export function emptyOpportunitySummary(
  status: OpportunityLifecycleStatus = "CREATED",
  nowMs = Date.now(),
): OpportunitySummary {
  return {
    currentReturnPct: null,
    maxReturnPct: null,
    currentStatus: status,
    originalThesis: [],
    evidenceCount: 0,
    latestEvidence: null,
    milestoneHistory: [],
    elapsedTimeMs: null,
    currentConfidence: null,
    lastUpdatedAt: new Date(nowMs).toISOString(),
    frozenEntry: null,
    currentMark: null,
    nextUndeliveredReturnMilestone: null,
    active: status === "CREATED" || status === "CONFIRMED" || status === "RUNNING" || status === "EXTENDED",
    openedAtMs: null,
  };
}

export function rebuildOpportunitySummary(input: {
  status: OpportunityLifecycleStatus;
  originalThesis: string[];
  frozenEntry: number | null;
  currentMark?: number | null;
  currentReturnPct?: number | null;
  maxReturnPct?: number | null;
  evidence: OpportunityEvidenceEvent[];
  milestones: OpportunityMilestoneRecord[];
  currentConfidence?: number | null;
  openedAtMs?: number | null;
  nowMs?: number;
  returnMilestones?: number[];
}): OpportunitySummary {
  const nowMs = input.nowMs ?? Date.now();
  const openedAtMs = input.openedAtMs ?? null;
  const milestones = [...input.milestones].sort((a, b) => a.reachedAtMs - b.reachedAtMs);
  const deliveredReturn = new Set(
    milestones
      .filter((m) => m.eventType === "RETURN_MILESTONE" && m.deliveredAt && m.milestonePercent != null)
      .map((m) => m.milestonePercent as number),
  );
  const levels = input.returnMilestones ?? [25, 50, 75, 100, 150, 200];
  const next = levels.find((p) => !deliveredReturn.has(p)) ?? null;
  const evidence = [...input.evidence].sort((a, b) => b.observedAtMs - a.observedAtMs);
  return {
    currentReturnPct: input.currentReturnPct ?? null,
    maxReturnPct: input.maxReturnPct ?? null,
    currentStatus: input.status,
    originalThesis: [...input.originalThesis],
    evidenceCount: evidence.length,
    latestEvidence: evidence[0] ?? null,
    milestoneHistory: milestones,
    elapsedTimeMs: openedAtMs != null ? Math.max(0, nowMs - openedAtMs) : null,
    currentConfidence: input.currentConfidence ?? null,
    lastUpdatedAt: new Date(nowMs).toISOString(),
    frozenEntry: input.frozenEntry ?? null,
    currentMark: input.currentMark ?? null,
    nextUndeliveredReturnMilestone: next,
    active: input.status === "CREATED" || input.status === "CONFIRMED" || input.status === "RUNNING" || input.status === "EXTENDED",
    openedAtMs,
  };
}

export function appendMilestoneToSummary(
  summary: OpportunitySummary,
  event: {
    eventType: LifecycleEventType;
    milestonePercent?: number | null;
    reachedAtMs: number;
    contractMark?: number | null;
    returnPercent?: number | null;
    deliveredAt?: string | null;
    discordMessageId?: string | null;
    details?: Record<string, unknown>;
  },
  status: OpportunityLifecycleStatus,
): OpportunitySummary {
  const rec: OpportunityMilestoneRecord = {
    eventType: event.eventType,
    milestonePercent: event.milestonePercent ?? null,
    label: lifecycleEventLabel(event.eventType, event.milestonePercent),
    reachedAt: new Date(event.reachedAtMs).toISOString(),
    reachedAtMs: event.reachedAtMs,
    contractMark: event.contractMark ?? null,
    returnPercent: event.returnPercent ?? null,
    deliveredAt: event.deliveredAt ?? null,
    discordMessageId: event.discordMessageId ?? null,
    details: event.details,
  };
  const history = [...summary.milestoneHistory];
  const key = `${rec.eventType}|${rec.milestonePercent ?? ""}|${rec.label}`;
  if (!history.some((h) => `${h.eventType}|${h.milestonePercent ?? ""}|${h.label}` === key && h.reachedAtMs === rec.reachedAtMs)) {
    // For return milestones, dedupe by percent regardless of reachedAtMs
    if (rec.eventType === "RETURN_MILESTONE" && rec.milestonePercent != null) {
      if (!history.some((h) => h.eventType === "RETURN_MILESTONE" && h.milestonePercent === rec.milestonePercent)) {
        history.push(rec);
      } else {
        const idx = history.findIndex((h) => h.eventType === "RETURN_MILESTONE" && h.milestonePercent === rec.milestonePercent);
        if (idx >= 0) history[idx] = { ...history[idx], ...rec, reachedAtMs: history[idx].reachedAtMs, reachedAt: history[idx].reachedAt };
      }
    } else {
      history.push(rec);
    }
  }
  return rebuildOpportunitySummary({
    status,
    originalThesis: summary.originalThesis,
    frozenEntry: summary.frozenEntry,
    currentMark: event.contractMark ?? summary.currentMark,
    currentReturnPct: event.returnPercent ?? summary.currentReturnPct,
    maxReturnPct: summary.maxReturnPct != null && event.returnPercent != null
      ? Math.max(summary.maxReturnPct, event.returnPercent)
      : (event.returnPercent ?? summary.maxReturnPct),
    evidence: summary.latestEvidence ? [summary.latestEvidence] : [],
    milestones: history,
    currentConfidence: summary.currentConfidence,
    openedAtMs: summary.openedAtMs,
    nowMs: event.reachedAtMs,
  });
}
