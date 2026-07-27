/**
 * Structured content events for a future AI writer / Twitter draft pipeline.
 * NEVER auto-posts. Creation failures must not block Discord or live alerts.
 */
import type { LifecycleEventType } from "./lifecycle.ts";

export type ContentEventType =
  | "OPPORTUNITY_OPENED"
  | "RETURN_MILESTONE_REACHED"
  | "NEW_HIGH"
  | "THESIS_STRENGTHENED"
  | "THESIS_WEAKENING"
  | "OPPORTUNITY_CLOSED"
  | "OPPORTUNITY_INVALIDATED"
  | "OPPORTUNITY_REPORT_CARD_READY"
  | "CONFIRMATION"
  | "EXIT_HIT";

export type ContentStatus = "PENDING" | "DRAFTED" | "PROCESSED" | "APPROVED" | "REJECTED";

export interface OpportunityContentEvent {
  id: string;
  opportunityCaseId: string;
  eventType: ContentEventType;
  symbol: string;
  occurredAt: string;
  frozenEntry: number | null;
  currentMark: number | null;
  returnPercent: number | null;
  milestonePercent: number | null;
  maxReturnPercent: number | null;
  direction: string;
  optionType: string;
  strike: number | null;
  expiration: string | null;
  originalThesis: string[];
  evidenceSummary: string[];
  strategyKey: string | null;
  contentStatus: ContentStatus;
  createdAt: string;
  label?: string | null;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function contentEventId(opportunityCaseId: string, eventType: string, discriminator: string): string {
  return `ce_${djb2(`${opportunityCaseId}|${eventType}|${discriminator}`)}`;
}

export function contentEventTypeFromLifecycle(event: LifecycleEventType): ContentEventType {
  switch (event) {
    case "OPPORTUNITY_OPENED":
      return "OPPORTUNITY_OPENED";
    case "CONFIRMATION":
      return "CONFIRMATION";
    case "RETURN_MILESTONE":
      return "RETURN_MILESTONE_REACHED";
    case "NEW_HIGH":
      return "NEW_HIGH";
    case "THESIS_STRENGTHENED":
      return "THESIS_STRENGTHENED";
    case "THESIS_WEAKENING":
      return "THESIS_WEAKENING";
    case "EXIT_HIT":
      return "EXIT_HIT";
    case "OPPORTUNITY_CLOSED":
      return "OPPORTUNITY_CLOSED";
    case "REPORT_CARD_READY":
      return "OPPORTUNITY_REPORT_CARD_READY";
    default:
      return "OPPORTUNITY_OPENED";
  }
}

interface CeDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
}

function hasTable(db: CeDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/** Best-effort idempotent insert. Never throws. */
export function persistContentEventOnDb(db: CeDb, ev: OpportunityContentEvent): boolean {
  try {
    if (!hasTable(db, "opportunity_content_events")) return false;
    const r = db.prepare(
      `INSERT OR IGNORE INTO opportunity_content_events
        (id, opportunity_case_id, event_type, symbol, occurred_at_ms, frozen_entry, current_mark,
         return_percent, milestone_percent, max_return_percent, direction, option_type, strike,
         expiration, original_thesis_json, evidence_summary_json, strategy_key, content_status,
         label, payload_json, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      ev.id,
      ev.opportunityCaseId,
      ev.eventType,
      ev.symbol,
      Date.parse(ev.occurredAt) || Date.now(),
      ev.frozenEntry,
      ev.currentMark,
      ev.returnPercent,
      ev.milestonePercent,
      ev.maxReturnPercent,
      ev.direction,
      ev.optionType,
      ev.strike,
      ev.expiration,
      JSON.stringify(ev.originalThesis ?? []),
      JSON.stringify(ev.evidenceSummary ?? []),
      ev.strategyKey,
      ev.contentStatus,
      ev.label ?? null,
      JSON.stringify(ev),
      Date.parse(ev.createdAt) || Date.now(),
    );
    return Number(r.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export function countPendingContentEventsOnDb(db: CeDb): number {
  try {
    if (!hasTable(db, "opportunity_content_events")) return 0;
    return Number((db.prepare("SELECT COUNT(*) n FROM opportunity_content_events WHERE content_status='PENDING'").get() as any)?.n ?? 0);
  } catch {
    return 0;
  }
}
