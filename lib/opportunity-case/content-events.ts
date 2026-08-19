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

/**
 * What makes THIS emission a different event from the last one.
 *
 * The discriminator used to be `${event}|${milestone}|${nowMs}`. With the clock
 * in the key, `contentEventId` returned a fresh id every single time and the
 * `INSERT OR IGNORE` in `persistContentEventOnDb` — the whole idempotency
 * mechanism — could never collide. A long-lived AMD or AMZN case emitted an
 * unbounded stream of distinct `THESIS_STRENGTHENED` rows, one per repeat
 * evaluation, forever. Production on 2026-08-19: 66 events behind 200 drafts,
 * 52 of them for AMZN in a single session.
 *
 * The identity of an event is WHAT CHANGED, so the discriminator is built from
 * the changed state and never from the clock. Each branch names the thing that
 * makes a second occurrence genuinely a second occurrence:
 *
 *  - RETURN_MILESTONE — the milestone itself. +50% is not +25%.
 *  - NEW_HIGH — the high, bucketed, so tick-by-tick noise is one event but a
 *    real leg up is a new one.
 *  - THESIS_STRENGTHENED / THESIS_WEAKENING — the session plus a digest of the
 *    thesis text. Repeating an unchanged thesis is the same event; genuinely
 *    revising it is a new one, and tomorrow is allowed to say it again.
 *  - Everything else happens once per case by nature, so it is keyed once.
 *
 * PURE. The `sessionDate` and any digest are supplied by the caller.
 */
export function materialEventDiscriminator(input: {
  event: LifecycleEventType;
  sessionDate: string;
  milestonePercent?: number | null;
  maxReturnPercent?: number | null;
  thesisDigest?: string | null;
}): string {
  const digest = String(input.thesisDigest ?? "none");
  switch (input.event) {
    case "RETURN_MILESTONE":
      return `m:${input.milestonePercent ?? "none"}`;
    case "NEW_HIGH": {
      const high = Number(input.maxReturnPercent);
      // 10-point buckets: a genuine new leg is a new event, a marginal tick is not.
      const bucket = Number.isFinite(high) ? Math.floor(high / 10) * 10 : "none";
      return `h:${input.sessionDate}|${bucket}`;
    }
    case "THESIS_STRENGTHENED":
    case "THESIS_WEAKENING":
      return `t:${input.sessionDate}|${digest}`;
    default:
      // OPPORTUNITY_OPENED, CONFIRMATION, EXIT_HIT, OPPORTUNITY_CLOSED,
      // REPORT_CARD_READY — one per case, by definition of the lifecycle.
      return `once:${input.event}`;
  }
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
