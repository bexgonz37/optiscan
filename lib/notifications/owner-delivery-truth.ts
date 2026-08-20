/**
 * owner-delivery-truth.ts — the ONE place that answers "did the owner actually receive
 * this Discord message?"
 *
 * ── The claim this module refuses to let anything else make ──────────────────
 *
 * A callout counts as DELIVERED TO THE OWNER when, and only when, the Discord delivery
 * ledger row for its opening says `status='SENT'`. Nothing else is evidence of delivery:
 *
 *   - an owner PAPER MIRROR proves a position was tracked, not that a message was posted.
 *     `openOwnerValidationPaperOnDb` runs AFTER the send result and does not read it.
 *   - an OPPORTUNITY CASE proves a thesis was claimed. `markOwnerActionableOpeningDelivered`
 *     is called for a SUPPRESSED opening too, because the suppression path deliberately
 *     reports `sent: true` so the opening claim is not released — so `discordDeliveryStatus`
 *     reads OWNER_ACTIONABLE_DELIVERED on messages that were never posted.
 *   - a RESEARCH OBSERVATION row proves the scanner saw a setup.
 *   - `owner_research_notify_log` is an idempotency ledger; it is written on suppression too.
 *
 * On 2026-08-20 all ten owner openings had a case, a claim and (mostly) a mirror, and every
 * single one of them was `SUPPRESSED` in the ledger. Any report built on the first three
 * would have called that a ten-alert day.
 *
 * ── Why the ledger and not the webhook ───────────────────────────────────────
 *
 * `sendTrackedDiscord` writes the row BEFORE the POST, flips it to SENT only on a
 * successful response, and records SUPPRESSED / RETRYING / FAILED / NOT_CONFIGURED
 * otherwise. It is the only place in the system where the outcome of an actual HTTP POST
 * to Discord is persisted. `recordSuppressedOwnerNotify` writes the same shape with
 * `status='SUPPRESSED'`, so a suppressed opening is present and countable rather than
 * absent and invisible.
 *
 * Read-only. No provider call, no quota spend, no send authority, no writes.
 */

import { tradingDay } from "../trading-session.ts";

export const OWNER_DELIVERY_TRUTH_VERSION = "OWNER_DELIVERY_TRUTH_V1" as const;

/** The ledger `payload_type` every owner options opening is written under. */
export const OWNER_OPENING_PAYLOAD_TYPE = "owner_intraday_actionable";

/** The only ledger status that means a Discord message exists. */
export const DELIVERED_STATUS = "SENT" as const;

export interface DeliveryTruthDb {
  prepare(sql: string): { get?: (...a: any[]) => any; all?: (...a: any[]) => any[] };
}

/**
 * DELIVERED means the ledger says SENT. Everything else is NOT_SENT and is reported with
 * its own status and reason — never merged into the delivered population, and never
 * dropped, because a suppressed opening the owner never saw is the single most important
 * thing a recap can tell them.
 */
export type OwnerDeliveryState = "DELIVERED" | "NOT_SENT";

export interface OwnerOpeningDelivery {
  deliveryId: string;
  opportunityCaseId: string | null;
  thesisFingerprint: string | null;
  /** The raw ledger status, verbatim. SENT / SUPPRESSED / FAILED / RETRYING / ... */
  status: string;
  state: OwnerDeliveryState;
  /** Ledger `failure_reason`, which carries the suppression reason on a SUPPRESSED row. */
  reason: string | null;
  webhookName: string | null;
  lifecycleState: string | null;
  createdAtMs: number | null;
  sentAtMs: number | null;
  /** ET trading day of `created_at`, resolved in JS. Null when the timestamp is unusable. */
  sessionDate: string | null;
  /** First line of the payload — enough to identify the message, never the webhook URL. */
  headline: string | null;
}

function hasTable(db: DeliveryTruthDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name));
  } catch {
    return false;
  }
}

/**
 * Parse a ledger timestamp to epoch ms.
 *
 * The ledger stores `strftime('%Y-%m-%dT%H:%M:%fZ','now')` — an explicit UTC instant. It is
 * parsed here and the ET trading day is derived in JS, never in SQL: SQLite's `localtime` is
 * the container's timezone (UTC on Railway), and an ET session boundary resolved in UTC
 * moves every post-20:00 ET delivery into the next session.
 */
function tsMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1_000_000_000_000) return n;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : null;
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

/** The first non-empty line of the message, for identification in a report. */
function headlineOf(payloadJson: unknown, preview: unknown): string | null {
  const raw = str(payloadJson) ?? str(preview);
  if (!raw) return null;
  let content = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as any).content === "string") {
      content = (parsed as any).content;
    }
  } catch { /* preview is truncated JSON — fall through and use it raw */ }
  const first = content.split(/\\n|\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return first ? first.slice(0, 160) : null;
}

function toDelivery(row: Record<string, any>): OwnerOpeningDelivery {
  const status = String(row.status ?? "").trim().toUpperCase();
  const createdAtMs = tsMs(row.created_at);
  return {
    deliveryId: String(row.delivery_id),
    opportunityCaseId: str(row.opportunity_case_id),
    thesisFingerprint: str(row.thesis_fingerprint),
    status: status || "UNKNOWN",
    state: status === DELIVERED_STATUS ? "DELIVERED" : "NOT_SENT",
    reason: str(row.failure_reason),
    webhookName: str(row.webhook_name),
    lifecycleState: str(row.lifecycle_state),
    createdAtMs,
    sentAtMs: tsMs(row.sent_at),
    sessionDate: createdAtMs == null ? null : tradingDay(createdAtMs),
    headline: headlineOf(row.payload_json, row.payload_preview),
  };
}

const SELECT_COLUMNS =
  "delivery_id, opportunity_case_id, thesis_fingerprint, status, failure_reason, webhook_name,"
  + " lifecycle_state, created_at, sent_at, payload_json, payload_preview";

/**
 * Every owner opening ledger row for one case.
 *
 * Returns the list, not a single row, because a case can legitimately carry more than one
 * attempt (a SUPPRESSED opening followed by a later SENT one would be two rows) and
 * collapsing them would hide exactly the transition this session exists to make visible.
 * Ordered oldest first.
 */
export function ownerOpeningDeliveriesForCaseOnDb(
  db: DeliveryTruthDb,
  opportunityCaseId: string,
): OwnerOpeningDelivery[] {
  if (!opportunityCaseId || !hasTable(db, "discord_deliveries")) return [];
  try {
    const rows = (db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM discord_deliveries
        WHERE opportunity_case_id=? AND payload_type=?
        ORDER BY created_at ASC`,
    ).all?.(opportunityCaseId, OWNER_OPENING_PAYLOAD_TYPE) ?? []) as Record<string, any>[];
    return rows.map(toDelivery);
  } catch {
    return [];
  }
}

/**
 * THE lifecycle gate. Whether a Discord opening message actually exists for this case.
 *
 * Fails closed in every direction: no ledger, no row, an unreadable ledger, or any status
 * other than SENT all answer false. A lifecycle update on an opening the owner never
 * received would be a reply to a message that is not there, announcing the outcome of a
 * trade they were never told about.
 */
export function ownerOpeningWasSentOnDb(db: DeliveryTruthDb, opportunityCaseId: string): boolean {
  return ownerOpeningDeliveriesForCaseOnDb(db, opportunityCaseId)
    .some((d) => d.state === "DELIVERED");
}

export interface OwnerDeliveryLedger {
  version: typeof OWNER_DELIVERY_TRUTH_VERSION;
  /** Null when the window is not a single session. */
  sessionDate: string | null;
  /** Present and readable. False means every count below is 0 because nothing could be read. */
  ledgerAvailable: boolean;
  /** Ledger rows with status SENT. THE delivered population. */
  delivered: OwnerOpeningDelivery[];
  /** Ledger rows with any other status. Reported separately, never summed with the above. */
  notSent: OwnerOpeningDelivery[];
  /** Case ids that received a real Discord message. */
  deliveredCaseIds: Set<string>;
  /** Case ids whose opening was attempted and did not reach Discord. */
  notSentCaseIds: Set<string>;
  /** Raw ledger status histogram over the window. */
  byStatus: Record<string, number>;
  /** Why the not-sent rows did not send, by ledger `failure_reason`. */
  notSentByReason: Record<string, number>;
}

const EMPTY_LEDGER = (sessionDate: string | null, available: boolean): OwnerDeliveryLedger => ({
  version: OWNER_DELIVERY_TRUTH_VERSION,
  sessionDate,
  ledgerAvailable: available,
  delivered: [],
  notSent: [],
  deliveredCaseIds: new Set<string>(),
  notSentCaseIds: new Set<string>(),
  byStatus: {},
  notSentByReason: {},
});

/**
 * The owner opening ledger for one ET session, or for an open-ended window.
 *
 * Session membership is decided in JS from the parsed `created_at`, for the reason given on
 * `tsMs` above. Rows whose timestamp cannot be parsed are EXCLUDED from a session-scoped
 * window rather than defaulted into it — an unattributable delivery is not evidence that
 * today's owner received anything.
 */
export function loadOwnerDeliveryLedgerOnDb(
  db: DeliveryTruthDb,
  opts: { sessionDate?: string | null; sinceMs?: number | null; limit?: number } = {},
): OwnerDeliveryLedger {
  const sessionDate = opts.sessionDate ?? null;
  if (!hasTable(db, "discord_deliveries")) return EMPTY_LEDGER(sessionDate, false);
  const limit = Math.max(1, Math.min(20_000, opts.limit ?? 5000));

  let rows: Record<string, any>[];
  try {
    rows = (db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM discord_deliveries
        WHERE payload_type=?
        ORDER BY created_at DESC LIMIT ?`,
    ).all?.(OWNER_OPENING_PAYLOAD_TYPE, limit) ?? []) as Record<string, any>[];
  } catch {
    return EMPTY_LEDGER(sessionDate, false);
  }

  const out = EMPTY_LEDGER(sessionDate, true);
  for (const row of rows) {
    const d = toDelivery(row);
    if (sessionDate != null && d.sessionDate !== sessionDate) continue;
    if (opts.sinceMs != null && (d.createdAtMs == null || d.createdAtMs < opts.sinceMs)) continue;
    out.byStatus[d.status] = (out.byStatus[d.status] ?? 0) + 1;
    if (d.state === "DELIVERED") {
      out.delivered.push(d);
      if (d.opportunityCaseId) out.deliveredCaseIds.add(d.opportunityCaseId);
    } else {
      out.notSent.push(d);
      const reason = d.reason ?? `<no reason recorded: ${d.status}>`;
      out.notSentByReason[reason] = (out.notSentByReason[reason] ?? 0) + 1;
      if (d.opportunityCaseId) out.notSentCaseIds.add(d.opportunityCaseId);
    }
  }

  // A case that ended up SENT is delivered, full stop — an earlier suppressed attempt on the
  // same case does not make it undelivered. The row stays in `notSent` (it is a real
  // suppression that happened), but the case id is removed from the not-sent set so the two
  // id sets are disjoint and a case cannot be counted in both populations.
  for (const id of out.deliveredCaseIds) out.notSentCaseIds.delete(id);

  out.delivered.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  out.notSent.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  return out;
}
