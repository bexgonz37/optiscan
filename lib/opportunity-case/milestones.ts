/**
 * Deterministic lifecycle / return-milestone evaluation for Opportunity Cases.
 * Highest newly reached return milestone is the only one delivered immediately.
 */
import type { OpportunityLifecycleStatus, LifecycleEventType } from "./lifecycle.ts";
import { lifecycleEventLabel, nextLifecycleStatus } from "./lifecycle.ts";
import type { OpportunityMilestoneRecord } from "./summary.ts";

export const DEFAULT_RETURN_MILESTONES = [20, 30, 50, 75, 100] as const;

export function returnMilestonesFromEnv(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = String(env.OPTIONS_RETURN_MILESTONES ?? "").trim();
  if (!raw) return [...DEFAULT_RETURN_MILESTONES];
  const parsed = raw.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? [...new Set(parsed)].sort((a, b) => a - b) : [...DEFAULT_RETURN_MILESTONES];
}

export function computeReturnPercent(frozenEntry: number, currentMark: number): number | null {
  if (!(frozenEntry > 0) || !Number.isFinite(frozenEntry) || !Number.isFinite(currentMark)) return null;
  return +(((currentMark - frozenEntry) / frozenEntry) * 100).toFixed(4);
}

/** All return thresholds crossed by returnPct (for analytics). */
export function crossedReturnMilestones(returnPct: number, levels: number[]): number[] {
  return levels.filter((p) => returnPct + 1e-9 >= p);
}

/**
 * Highest newly reached undelivered milestone.
 * Jump +20 → +58 yields only 50 (not 25 then 50).
 */
export function highestNewReturnMilestone(
  returnPct: number,
  alreadyReachedOrDelivered: Iterable<number>,
  levels: number[],
): number | null {
  const have = new Set(alreadyReachedOrDelivered);
  const newly = levels.filter((p) => returnPct + 1e-9 >= p && !have.has(p));
  if (newly.length === 0) return null;
  return newly[newly.length - 1];
}

export interface MilestoneRow {
  opportunityCaseId: string;
  eventType: LifecycleEventType;
  milestonePercent: number | null;
  label: string;
  reachedAtMs: number;
  contractMark: number | null;
  returnPercent: number | null;
  deliveredAtMs: number | null;
  claimToken: string | null;
  discordMessageId: string | null;
  detailsJson: string | null;
}

interface MsDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
  exec?: (sql: string) => void;
}

function hasTable(db: MsDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function milestoneKey(eventType: string, milestonePercent: number | null, reachedAtMs?: number): string {
  if (eventType === "RETURN_MILESTONE") return `RETURN_MILESTONE:${milestonePercent ?? "none"}`;
  if (eventType === "NEW_HIGH") return `NEW_HIGH:${reachedAtMs ?? "x"}`;
  if (eventType === "THESIS_STRENGTHENED" || eventType === "THESIS_WEAKENING") {
    return `${eventType}:${reachedAtMs ?? "x"}`;
  }
  return `${eventType}:none`;
}

export function persistReachedMilestoneOnDb(
  db: MsDb,
  row: {
    opportunityCaseId: string;
    eventType: LifecycleEventType;
    milestonePercent?: number | null;
    reachedAtMs: number;
    contractMark?: number | null;
    returnPercent?: number | null;
    details?: Record<string, unknown>;
  },
): boolean {
  if (!hasTable(db, "opportunity_milestones")) return false;
  const label = lifecycleEventLabel(row.eventType, row.milestonePercent);
  const eventKey = milestoneKey(row.eventType, row.milestonePercent ?? null, row.reachedAtMs);
  try {
    const r = db.prepare(
      `INSERT OR IGNORE INTO opportunity_milestones
        (opportunity_case_id, event_key, event_type, milestone_percent, label, reached_at_ms, contract_mark,
         return_percent, delivered_at_ms, claim_token, discord_message_id, details_json, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.opportunityCaseId,
      eventKey,
      row.eventType,
      row.milestonePercent ?? null,
      label,
      row.reachedAtMs,
      row.contractMark ?? null,
      row.returnPercent ?? null,
      null,
      null,
      null,
      row.details ? JSON.stringify(row.details) : null,
      row.reachedAtMs,
      row.reachedAtMs,
    );
    return Number(r.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Atomically claim delivery for a milestone. Returns true only for the winning claimer.
 * Idempotent: already-delivered rows never claim again.
 */
export function claimMilestoneDeliveryOnDb(
  db: MsDb,
  opportunityCaseId: string,
  eventType: LifecycleEventType,
  milestonePercent: number | null,
  claimToken: string,
  nowMs: number,
): boolean {
  if (!hasTable(db, "opportunity_milestones")) return false;
  try {
    const r = db.prepare(
      `UPDATE opportunity_milestones
       SET claim_token=?, updated_at_ms=?
       WHERE opportunity_case_id=? AND event_type=?
         AND ((milestone_percent IS NULL AND ? IS NULL) OR milestone_percent=?)
         AND delivered_at_ms IS NULL
         AND (claim_token IS NULL OR claim_token=?)`,
    ).run(
      claimToken,
      nowMs,
      opportunityCaseId,
      eventType,
      milestonePercent,
      milestonePercent,
      claimToken,
    );
    return Number(r.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export function markMilestoneDeliveredOnDb(
  db: MsDb,
  opportunityCaseId: string,
  eventType: LifecycleEventType,
  milestonePercent: number | null,
  discordMessageId: string | null,
  nowMs: number,
): void {
  if (!hasTable(db, "opportunity_milestones")) return;
  try {
    db.prepare(
      `UPDATE opportunity_milestones
       SET delivered_at_ms=?, discord_message_id=?, updated_at_ms=?
       WHERE opportunity_case_id=? AND event_type=?
         AND ((milestone_percent IS NULL AND ? IS NULL) OR milestone_percent=?)`,
    ).run(nowMs, discordMessageId, nowMs, opportunityCaseId, eventType, milestonePercent, milestonePercent);
  } catch { /* isolated */ }
}

export function releaseMilestoneClaimOnDb(
  db: MsDb,
  opportunityCaseId: string,
  eventType: LifecycleEventType,
  milestonePercent: number | null,
  claimToken: string,
  nowMs: number,
): void {
  if (!hasTable(db, "opportunity_milestones")) return;
  try {
    db.prepare(
      `UPDATE opportunity_milestones
       SET claim_token=NULL, updated_at_ms=?
       WHERE opportunity_case_id=? AND event_type=?
         AND ((milestone_percent IS NULL AND ? IS NULL) OR milestone_percent=?)
         AND claim_token=? AND delivered_at_ms IS NULL`,
    ).run(nowMs, opportunityCaseId, eventType, milestonePercent, milestonePercent, claimToken);
  } catch { /* isolated */ }
}

export function listMilestonesForCaseOnDb(db: MsDb, opportunityCaseId: string): OpportunityMilestoneRecord[] {
  if (!hasTable(db, "opportunity_milestones")) return [];
  try {
    const rows = db.prepare(
      `SELECT event_type, milestone_percent, label, reached_at_ms, contract_mark, return_percent,
              delivered_at_ms, discord_message_id, details_json
       FROM opportunity_milestones WHERE opportunity_case_id=? ORDER BY reached_at_ms ASC`,
    ).all(opportunityCaseId) as any[];
    return rows.map((r) => ({
      eventType: r.event_type as LifecycleEventType,
      milestonePercent: r.milestone_percent == null ? null : Number(r.milestone_percent),
      label: String(r.label),
      reachedAt: new Date(Number(r.reached_at_ms)).toISOString(),
      reachedAtMs: Number(r.reached_at_ms),
      contractMark: r.contract_mark == null ? null : Number(r.contract_mark),
      returnPercent: r.return_percent == null ? null : Number(r.return_percent),
      deliveredAt: r.delivered_at_ms == null ? null : new Date(Number(r.delivered_at_ms)).toISOString(),
      discordMessageId: r.discord_message_id == null ? null : String(r.discord_message_id),
      details: (() => { try { return JSON.parse(String(r.details_json ?? "null")); } catch { return undefined; } })(),
    }));
  } catch {
    return [];
  }
}

export function reachedReturnPercentsOnDb(db: MsDb, opportunityCaseId: string): number[] {
  return listMilestonesForCaseOnDb(db, opportunityCaseId)
    .filter((m) => m.eventType === "RETURN_MILESTONE" && m.milestonePercent != null)
    .map((m) => m.milestonePercent as number);
}

export function evaluateReturnMilestones(input: {
  returnPct: number;
  priorReached: number[];
  levels: number[];
}): { crossed: number[]; deliverPercent: number | null } {
  const crossed = crossedReturnMilestones(input.returnPct, input.levels);
  const deliverPercent = highestNewReturnMilestone(input.returnPct, input.priorReached, input.levels);
  return { crossed, deliverPercent };
}

export function statusAfterReturn(current: OpportunityLifecycleStatus | null, returnPct: number): OpportunityLifecycleStatus {
  return nextLifecycleStatus({
    current,
    event: returnPct >= 50 ? "RETURN_MILESTONE" : "NEW_HIGH",
    returnPct,
    extendedThresholdPct: 50,
  });
}

export { milestoneKey };
