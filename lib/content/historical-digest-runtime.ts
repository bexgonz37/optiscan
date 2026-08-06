/**
 * historical-digest-runtime.ts — reads held drafts, persists digests, and
 * delivers them under a bounded, owner-controlled policy.
 *
 * The pure decisions live in `historical-digest.ts`. This file owns only the
 * parts that need a database or a webhook:
 *
 *   readHeldDraftRows      held drafts joined to their events and exact OCC
 *   generateHistoricalDigest   build + persist (never delivers)
 *   deliverHistoricalDigest    render + post + record (never generates)
 *   runHistoricalDigestScan    the scheduled path, which does neither unless
 *                              the owner has enabled Discord delivery
 *
 * ## Delivery policy
 *
 * Generation is automatic and in-app. **Discord delivery is off by default** and
 * requires `CONTENT_DIGEST_DISCORD_ENABLED=1` or an explicit manual trigger.
 * That asymmetry is deliberate: the defect being repaired was unrequested
 * historical content arriving in the owner's channel, so the repair must not
 * ship a new automatic sender. In-app availability costs no interrupt.
 *
 * ## Live outranks historical
 *
 * The digest never competes with live content. The scheduled path refuses to run
 * whenever the content scan in the same tick delivered anything, and it holds its
 * own minimum interval on top. The recap channel budget is 2 posts / 10 min; a
 * digest consuming one of those slots ahead of a live closure would re-create the
 * original harm in a more organised form.
 */

import {
  buildHistoricalDigest,
  renderHistoricalDigest,
  type HeldDraftRow,
  type HistoricalDigest,
} from "./historical-digest.ts";
import { describeReason, redactForPersistence } from "./delivery-reason.ts";
import type { ContentDeliverResult } from "./content-drafts-runtime.ts";

interface RtDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
}

function hasTable(db: RtDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

function hasColumn(db: RtDb, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[])
      .some((c) => c.name === column);
  } catch { return false; }
}

function num(x: unknown): number | null {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function str(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

/** Reasons whose drafts this consumer is responsible for. */
export const DIGEST_SOURCE_REASONS = ["HELD_FOR_HISTORICAL_DIGEST", "ARCHIVED_IN_APP_ONLY"] as const;

/**
 * Read held drafts, joined to their content event and — when the case resolves
 * one — the exact OCC from `options_alerts.option_symbol`.
 *
 * Schema-tolerant by necessity: referencing a column SQLite lacks fails the
 * WHOLE statement, and a legacy database without the delivery-reason columns has
 * no held rows to read anyway. It returns [] there rather than throwing, and the
 * OCC join is dropped independently when those tables are absent.
 */
export function readHeldDraftRows(
  db: RtDb,
  opts: { includeArchive?: boolean; limit?: number } = {},
): HeldDraftRow[] {
  if (!hasTable(db, "content_drafts")) return [];
  if (!hasColumn(db, "content_drafts", "discord_delivery_reason")) return [];
  const reasons = opts.includeArchive
    ? DIGEST_SOURCE_REASONS
    : (["HELD_FOR_HISTORICAL_DIGEST"] as readonly string[]);
  const placeholders = reasons.map(() => "?").join(",");
  const canJoinOcc = hasTable(db, "opportunity_cases") && hasTable(db, "options_alerts");
  const occSelect = canJoinOcc ? "a.option_symbol AS occ" : "NULL AS occ";
  const occJoin = canJoinOcc
    ? `LEFT JOIN opportunity_cases oc ON oc.opportunity_id = d.opportunity_case_id
       LEFT JOIN options_alerts a ON a.alert_id = oc.alert_id`
    : "";
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 5000));
  try {
    const rows = db.prepare(
      `SELECT d.id AS draft_id, d.content_event_id, d.opportunity_case_id, d.category,
              d.template_family, d.template_version, d.draft_text, d.discord_delivery_reason,
              d.result_type, d.frozen_entry AS draft_frozen_entry, d.created_at_ms AS draft_created_at_ms,
              e.symbol, e.direction, e.option_type, e.strike, e.expiration,
              e.frozen_entry, e.current_mark, e.return_percent, e.max_return_percent,
              e.occurred_at_ms,
              ${occSelect}
         FROM content_drafts d
         LEFT JOIN opportunity_content_events e ON e.id = d.content_event_id
         ${occJoin}
        WHERE d.discord_delivery_reason IN (${placeholders})
        ORDER BY e.occurred_at_ms DESC, d.created_at_ms ASC
        LIMIT ?`,
    ).all(...reasons, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      draftId: String(r.draft_id),
      contentEventId: String(r.content_event_id ?? ""),
      opportunityCaseId: str(r.opportunity_case_id),
      category: String(r.category ?? "CONTENT"),
      templateFamily: str(r.template_family),
      templateVersion: str(r.template_version),
      draftText: String(r.draft_text ?? ""),
      deliveryReason: str(r.discord_delivery_reason),
      resultType: str(r.result_type),
      symbol: str(r.symbol),
      direction: str(r.direction),
      optionType: str(r.option_type),
      strike: num(r.strike),
      expiration: str(r.expiration),
      occ: str(r.occ),
      // The event's frozen entry is authoritative; the draft's copy is a
      // fallback, not an override.
      frozenEntry: num(r.frozen_entry) ?? num(r.draft_frozen_entry),
      currentMark: num(r.current_mark),
      returnPercent: num(r.return_percent),
      maxReturnPercent: num(r.max_return_percent),
      eventOccurredAtMs: num(r.occurred_at_ms),
      draftCreatedAtMs: num(r.draft_created_at_ms),
    }));
  } catch {
    return [];
  }
}

/** Opportunity cases that already received a report card in Discord. */
export function casesWithDeliveredReportCard(db: RtDb): string[] {
  if (!hasTable(db, "content_drafts")) return [];
  try {
    const rows = db.prepare(
      `SELECT DISTINCT opportunity_case_id AS id FROM content_drafts
        WHERE discord_delivery_status='SENT' AND opportunity_case_id IS NOT NULL
          AND category IN ('CLOSED_WINNER','CLOSED_LOSER','WHY_THIS_WORKED','WHY_THIS_FAILED')`,
    ).all() as { id?: unknown }[];
    return rows.map((r) => String(r.id)).filter(Boolean);
  } catch { return []; }
}

/** Canonical outcome IDs any previous digest already included. */
export function priorDigestOutcomeIds(db: RtDb): string[] {
  if (!hasTable(db, "content_digest_members")) return [];
  try {
    const rows = db.prepare(
      "SELECT DISTINCT outcome_id AS id FROM content_digest_members WHERE included=1",
    ).all() as { id?: unknown }[];
    return rows.map((r) => String(r.id)).filter(Boolean);
  } catch { return []; }
}

function persistDigest(db: RtDb, digest: HistoricalDigest, renderedText: string): boolean {
  if (!hasTable(db, "content_digests")) return false;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO content_digests
         (id, generated_at_ms, delivered_at_ms, discord_message_id, delivery_status,
          delivery_reason, trigger_source, evidence_version, covered_from_ms, covered_to_ms,
          included_count, excluded_count, duplicates_collapsed, messages_prevented,
          stats_json, rendered_text)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      digest.digestId, digest.generatedAtMs, null, null, "GENERATED",
      null, digest.trigger, digest.evidenceVersion, digest.coveredFromMs, digest.coveredToMs,
      digest.stats.includedOutcomes, digest.stats.excludedOutcomes,
      digest.stats.duplicateVariantsCollapsed, digest.stats.messagesPrevented,
      JSON.stringify(digest.stats), renderedText.slice(0, 4000),
    );
  } catch { return false; }

  if (!hasTable(db, "content_digest_members")) return true;
  for (const o of digest.included) {
    try {
      db.prepare(
        `INSERT OR REPLACE INTO content_digest_members
           (digest_id, outcome_id, included, exclusion_reason, opportunity_case_id, symbol, occ,
            result, return_percent, cause_code, cause_provable, evidence_quality,
            collapsed_variants, representative_draft_id, draft_ids_json, content_event_ids_json,
            created_at_ms)
         VALUES (?,?,1,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        digest.digestId, o.outcomeId, o.opportunityCaseId, o.symbol, o.occ,
        o.result, o.returnPercent, o.causeCode, o.causeProvable ? 1 : 0, o.evidenceQuality,
        o.collapsedVariantCount, o.representativeDraftId,
        JSON.stringify(o.draftIds), JSON.stringify(o.contentEventIds), digest.generatedAtMs,
      );
    } catch { /* isolated: one member must not lose the digest */ }
  }
  for (const e of digest.excluded) {
    try {
      db.prepare(
        `INSERT OR REPLACE INTO content_digest_members
           (digest_id, outcome_id, included, exclusion_reason, draft_ids_json, created_at_ms)
         VALUES (?,?,0,?,?,?)`,
      ).run(digest.digestId, e.outcomeId, e.reason, JSON.stringify(e.draftIds), digest.generatedAtMs);
    } catch { /* isolated */ }
  }
  return true;
}

/**
 * Mark the drafts a digest covered as consumed.
 *
 * Only drafts of INCLUDED outcomes are touched, and only their reason changes —
 * status stays SUPPRESSED, `SENT` is never written, and no row is deleted. An
 * outcome deferred by the size cap keeps `HELD_FOR_HISTORICAL_DIGEST` so the
 * next digest still finds it.
 */
export function markDraftsConsumedByDigest(
  db: RtDb,
  digest: HistoricalDigest,
  nowMs: number,
): number {
  if (!hasTable(db, "content_drafts")) return 0;
  if (!hasColumn(db, "content_drafts", "discord_delivery_reason")) return 0;
  const reason = describeReason("DELIVERED_IN_HISTORICAL_DIGEST");
  let changed = 0;
  for (const o of digest.included) {
    for (const draftId of o.draftIds) {
      try {
        const res = db.prepare(
          `UPDATE content_drafts
              SET discord_delivery_status=?, updated_at_ms=?,
                  discord_delivery_reason=?, discord_delivery_explanation=?,
                  discord_delivery_retryable=0, discord_delivery_detail=?
            WHERE id=? AND discord_delivery_reason='HELD_FOR_HISTORICAL_DIGEST'`,
        ).run(
          reason.status, nowMs, reason.code, reason.explanation,
          `included in historical learning digest ${digest.digestId}`, draftId,
        );
        changed += res?.changes ?? 0;
      } catch { /* isolated */ }
    }
  }
  return changed;
}

export interface GenerateDigestResult {
  ok: boolean;
  digest: HistoricalDigest | null;
  renderedText: string | null;
  persisted: boolean;
  reason: string | null;
}

/**
 * Build and persist one digest. Never posts anything.
 *
 * Returns `ok: false` with a reason when there is nothing to summarise — which
 * is a truthful outcome, not a failure, and is reported as such rather than as
 * an empty digest.
 */
export function generateHistoricalDigest(
  db: RtDb,
  opts: { nowMs?: number; trigger?: "SCHEDULED" | "MANUAL"; env?: NodeJS.ProcessEnv; includeArchive?: boolean } = {},
): GenerateDigestResult {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();
  const rows = readHeldDraftRows(db, { includeArchive: opts.includeArchive ?? false });
  if (!rows.length) {
    return { ok: false, digest: null, renderedText: null, persisted: false, reason: "NO_HELD_DRAFTS" };
  }
  const digest = buildHistoricalDigest({
    rows,
    nowMs,
    trigger: opts.trigger ?? "SCHEDULED",
    priorDigestOutcomeIds: priorDigestOutcomeIds(db),
    casesWithDeliveredReportCard: casesWithDeliveredReportCard(db),
    env,
  });
  if (!digest.included.length) {
    return {
      ok: false, digest, renderedText: null, persisted: false,
      reason: "ALL_HELD_OUTCOMES_ALREADY_COVERED",
    };
  }
  const renderedText = renderHistoricalDigest(digest, { appUrl: str(env.OPTISCAN_APP_URL) });
  const persisted = persistDigest(db, digest, renderedText);
  return { ok: true, digest, renderedText, persisted, reason: null };
}

/** Is automatic Discord delivery of digests enabled? Off unless explicitly on. */
export function digestDiscordEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.CONTENT_DIGEST_DISCORD_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Minimum gap between delivered digests. Bounded owner-selected schedule. */
export function digestMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CONTENT_DIGEST_MIN_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60_000;
}

function lastDeliveredDigestAtMs(db: RtDb): number | null {
  if (!hasTable(db, "content_digests")) return null;
  try {
    const r = db.prepare(
      "SELECT MAX(delivered_at_ms) AS t FROM content_digests WHERE delivery_status='DELIVERED'",
    ).get() as { t?: unknown } | undefined;
    return num(r?.t);
  } catch { return null; }
}

function defaultSend(): (content: string) => Promise<ContentDeliverResult> {
  return async (content: string) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { postToDiscord, discordWebhookConfigured } = require("@/lib/notifications");
      if (!discordWebhookConfigured("recap")) {
        return { ok: false, messageId: null, error: "DISCORD_WEBHOOK_RECAP not configured" };
      }
      const r = await postToDiscord(
        { content },
        { webhook: "recap", skipPublicCheck: true, audience: "subscriber", payloadType: "content_digest" },
      );
      return {
        ok: !r.suppressed,
        messageId: r.messageId ?? null,
        error: r.suppressed ? `recap suppressed: ${r.suppressionReason}` : null,
        suppressed: r.suppressed,
      };
    } catch (e: any) {
      return { ok: false, messageId: null, error: String(e?.message ?? e).slice(0, 300) };
    }
  };
}

export interface DeliverDigestResult {
  ok: boolean;
  digestId: string | null;
  messageId: string | null;
  draftsConsumed: number;
  error: string | null;
  skippedReason: string | null;
}

/**
 * Deliver one already-generated digest to the owner's recap channel.
 *
 * Drafts are marked consumed ONLY after a successful post. A digest that failed
 * to send must leave its outcomes held, or the content would be marked as
 * reported without ever having reached the owner — the same silent loss this
 * consumer exists to end.
 */
export async function deliverHistoricalDigest(
  db: RtDb,
  digest: HistoricalDigest,
  renderedText: string,
  deps: { send?: (content: string) => Promise<ContentDeliverResult>; now?: () => number } = {},
): Promise<DeliverDigestResult> {
  const send = deps.send ?? defaultSend();
  const nowMs = (deps.now ?? Date.now)();
  let res: ContentDeliverResult;
  try {
    res = await send(renderedText);
  } catch (e: any) {
    res = { ok: false, messageId: null, error: String(e?.message ?? e).slice(0, 300) };
  }
  if (!res.ok) {
    try {
      db.prepare(
        "UPDATE content_digests SET delivery_status=?, delivery_reason=? WHERE id=?",
      ).run(res.suppressed ? "SUPPRESSED" : "FAILED", redactForPersistence(res.error), digest.digestId);
    } catch { /* isolated */ }
    return {
      ok: false, digestId: digest.digestId, messageId: null, draftsConsumed: 0,
      error: redactForPersistence(res.error), skippedReason: null,
    };
  }
  const consumed = markDraftsConsumedByDigest(db, digest, nowMs);
  try {
    db.prepare(
      `UPDATE content_digests SET delivery_status='DELIVERED', delivered_at_ms=?, discord_message_id=?
        WHERE id=?`,
    ).run(nowMs, res.messageId, digest.digestId);
  } catch { /* isolated */ }
  return {
    ok: true, digestId: digest.digestId, messageId: res.messageId ?? null,
    draftsConsumed: consumed, error: null, skippedReason: null,
  };
}

export interface DigestScanResult {
  ran: boolean;
  generated: boolean;
  delivered: boolean;
  digestId: string | null;
  outcomesIncluded: number;
  draftsConsumed: number;
  messagesPrevented: number;
  skippedReason: string | null;
}

/**
 * The scheduled path.
 *
 * `liveDeliveredThisRun` is passed by the caller, not inferred here, because the
 * only component that knows whether live content just went out is the content
 * scan itself. When it did, this returns immediately: live always outranks
 * historical.
 */
export async function runHistoricalDigestScan(
  db: RtDb,
  deps: {
    send?: (content: string) => Promise<ContentDeliverResult>;
    now?: () => number;
    liveDeliveredThisRun?: boolean;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<DigestScanResult> {
  const nowMs = (deps.now ?? Date.now)();
  const idle: DigestScanResult = {
    ran: true, generated: false, delivered: false, digestId: null,
    outcomesIncluded: 0, draftsConsumed: 0, messagesPrevented: 0, skippedReason: null,
  };
  if (deps.liveDeliveredThisRun) return { ...idle, skippedReason: "LIVE_CONTENT_HAS_PRIORITY" };

  const gen = generateHistoricalDigest(db, { nowMs, trigger: "SCHEDULED", env });
  if (!gen.ok || !gen.digest || !gen.renderedText) {
    return { ...idle, skippedReason: gen.reason ?? "NOTHING_TO_DIGEST" };
  }
  const result: DigestScanResult = {
    ...idle,
    generated: true,
    digestId: gen.digest.digestId,
    outcomesIncluded: gen.digest.stats.includedOutcomes,
    messagesPrevented: gen.digest.stats.messagesPrevented,
  };

  if (!digestDiscordEnabled(env)) {
    return { ...result, skippedReason: "DIGEST_DISCORD_DELIVERY_DISABLED" };
  }
  const last = lastDeliveredDigestAtMs(db);
  if (last != null && nowMs - last < digestMinIntervalMs(env)) {
    return { ...result, skippedReason: "WITHIN_DIGEST_MIN_INTERVAL" };
  }
  const del = await deliverHistoricalDigest(db, gen.digest, gen.renderedText, deps);
  return {
    ...result,
    delivered: del.ok,
    draftsConsumed: del.draftsConsumed,
    skippedReason: del.ok ? null : (del.error ?? "DELIVERY_FAILED"),
  };
}

export interface DigestDiagnostics {
  heldDigestRows: number;
  archiveOnlyRows: number;
  uniqueOutcomes: number;
  digestReadyOutcomes: number;
  duplicateVariants: number;
  alreadyDeliveredEquivalents: number;
  digestsGenerated: number;
  digestsDelivered: number;
  messagesPrevented: number;
  lastDigestId: string | null;
  lastGeneratedAtMs: number | null;
  lastDeliveredAtMs: number | null;
  discordDeliveryEnabled: boolean;
  minIntervalMs: number;
}

/**
 * Read-only digest diagnostics. Issues no provider call, sends nothing, and
 * persists nothing — it builds a candidate digest in memory purely to count.
 */
export function buildDigestDiagnostics(
  db: RtDb,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): DigestDiagnostics {
  const held = readHeldDraftRows(db, { includeArchive: false });
  const all = readHeldDraftRows(db, { includeArchive: true });
  const archiveRows = all.filter((r) => r.deliveryReason === "ARCHIVED_IN_APP_ONLY");
  const candidate = buildHistoricalDigest({
    rows: held,
    nowMs,
    priorDigestOutcomeIds: priorDigestOutcomeIds(db),
    casesWithDeliveredReportCard: casesWithDeliveredReportCard(db),
    env,
  });
  const counts = (() => {
    if (!hasTable(db, "content_digests")) return { generated: 0, delivered: 0, prevented: 0 };
    try {
      const r = db.prepare(
        `SELECT COUNT(*) AS generated,
                SUM(CASE WHEN delivery_status='DELIVERED' THEN 1 ELSE 0 END) AS delivered,
                SUM(COALESCE(messages_prevented,0)) AS prevented
           FROM content_digests`,
      ).get() as Record<string, unknown> | undefined;
      return {
        generated: num(r?.generated) ?? 0,
        delivered: num(r?.delivered) ?? 0,
        prevented: num(r?.prevented) ?? 0,
      };
    } catch { return { generated: 0, delivered: 0, prevented: 0 }; }
  })();
  const last = (() => {
    if (!hasTable(db, "content_digests")) return null;
    try {
      return db.prepare(
        "SELECT id, generated_at_ms, delivered_at_ms FROM content_digests ORDER BY generated_at_ms DESC LIMIT 1",
      ).get() as Record<string, unknown> | undefined ?? null;
    } catch { return null; }
  })();

  return {
    heldDigestRows: held.length,
    archiveOnlyRows: archiveRows.length,
    uniqueOutcomes: candidate.stats.uniqueOutcomes,
    digestReadyOutcomes: candidate.stats.includedOutcomes,
    duplicateVariants: candidate.stats.duplicateVariantsCollapsed,
    alreadyDeliveredEquivalents: candidate.excluded.filter(
      (e) => e.reason === "ALREADY_DELIVERED_INDIVIDUALLY" || e.reason === "ALREADY_IN_PRIOR_DIGEST",
    ).length,
    digestsGenerated: counts.generated,
    digestsDelivered: counts.delivered,
    messagesPrevented: counts.prevented,
    lastDigestId: last ? str(last.id) : null,
    lastGeneratedAtMs: last ? num(last.generated_at_ms) : null,
    lastDeliveredAtMs: last ? num(last.delivered_at_ms) : null,
    discordDeliveryEnabled: digestDiscordEnabled(env),
    minIntervalMs: digestMinIntervalMs(env),
  };
}
