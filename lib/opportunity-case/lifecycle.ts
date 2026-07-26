/**
 * Deterministic post-delivery Opportunity Case lifecycle transitions.
 * AI must never call into this module for decisions.
 */
export type OpportunityLifecycleStatus =
  | "CREATED"
  | "CONFIRMED"
  | "RUNNING"
  | "EXTENDED"
  | "CLOSED"
  | "INVALIDATED";

export const ACTIVE_LIFECYCLE_STATUSES: readonly OpportunityLifecycleStatus[] = [
  "CREATED",
  "CONFIRMED",
  "RUNNING",
  "EXTENDED",
] as const;

export const TERMINAL_LIFECYCLE_STATUSES: readonly OpportunityLifecycleStatus[] = [
  "CLOSED",
  "INVALIDATED",
] as const;

export type LifecycleEventType =
  | "OPPORTUNITY_OPENED"
  | "CONFIRMATION"
  | "RETURN_MILESTONE"
  | "NEW_HIGH"
  | "THESIS_STRENGTHENED"
  | "THESIS_WEAKENING"
  | "EXIT_HIT"
  | "OPPORTUNITY_CLOSED"
  | "REPORT_CARD_READY";

export interface LifecycleTransitionInput {
  current: OpportunityLifecycleStatus | null | undefined;
  event: LifecycleEventType;
  returnPct?: number | null;
  extendedThresholdPct?: number;
}

/** Pure transition table. Unknown/illegal transitions keep the current status. */
export function nextLifecycleStatus(input: LifecycleTransitionInput): OpportunityLifecycleStatus {
  const cur = input.current ?? "CREATED";
  if (cur === "CLOSED" || cur === "INVALIDATED") return cur;

  switch (input.event) {
    case "OPPORTUNITY_OPENED":
      return cur === "CREATED" ? "CREATED" : cur;
    case "CONFIRMATION":
      return cur === "CREATED" ? "CONFIRMED" : cur;
    case "RETURN_MILESTONE":
    case "NEW_HIGH": {
      const ext = input.extendedThresholdPct ?? 50;
      if ((input.returnPct ?? 0) >= ext) return "EXTENDED";
      if (cur === "CREATED" || cur === "CONFIRMED") return "RUNNING";
      return cur;
    }
    case "THESIS_STRENGTHENED":
      if (cur === "CREATED") return "CONFIRMED";
      if (cur === "CONFIRMED") return "RUNNING";
      return cur;
    case "THESIS_WEAKENING":
      return cur;
    case "EXIT_HIT":
    case "OPPORTUNITY_CLOSED":
      return "CLOSED";
    case "REPORT_CARD_READY":
      return "CLOSED";
    default:
      return cur;
  }
}

export function lifecycleEventLabel(event: LifecycleEventType, milestonePercent?: number | null): string {
  switch (event) {
    case "OPPORTUNITY_OPENED":
      return "Opportunity Opened";
    case "CONFIRMATION":
      return "Confirmation";
    case "RETURN_MILESTONE":
      return milestonePercent != null ? `+${milestonePercent}%` : "Return Milestone";
    case "NEW_HIGH":
      return "New High";
    case "THESIS_STRENGTHENED":
      return "Thesis Strengthened";
    case "THESIS_WEAKENING":
      return "Thesis Weakening";
    case "EXIT_HIT":
      return "Exit Hit";
    case "OPPORTUNITY_CLOSED":
      return "Opportunity Closed";
    case "REPORT_CARD_READY":
      return "Report Card Ready";
    default:
      return String(event);
  }
}
