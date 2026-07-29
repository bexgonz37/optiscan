/**
 * lib/content/content-drafts-runtime.ts — consume PENDING opportunity_content_events,
 * generate deterministic template drafts, persist each draft, then deliver to the Recaps
 * channel for manual review.
 *
 * Guarantees:
 *  - NEVER auto-posts to Twitter/X
 *  - NEVER sends to subscriber/actionable alert delivery paths
 *  - Persists drafts BEFORE Discord delivery (and when webhook is missing)
 *  - Idempotent per-draft fingerprint — scheduler retries / restarts do not duplicate
 *  - Partial Discord failure retries only unsent drafts
 *  - Failures never throw into lifecycle/grader
 *  - Performance categories require verified subscriber claim integrity
 */
import {
  buildDraftBundle,
  eligibleCategories,
  eligibilityThresholds,
  filterCategoriesForClaim,
  TEMPLATE_VERSION,
  type ContentCategory,
  type ContentDraftBundle,
  type ContentVars,
  type CtaType,
} from "./content-event-engine.ts";
import {
  isPerformanceCategory,
  mfeDisclaimer,
  verifyContentClaimForCase,
  type ContentResultType,
} from "./claim-integrity.ts";
import { tradingDay } from "../trading-session.ts";
import { evaluateMarketSessionGuard } from "../market-session-guard.ts";
import { recapDeliveryEnabled } from "../notifications/recap-delivery-guard.ts";

interface RtDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
}

export interface ContentDeliverResult {
  ok: boolean;
  messageId: string | null;
  error: string | null;
  suppressed?: boolean;
}
export interface ContentDraftsDeps {
  send?: (content: string) => Promise<ContentDeliverResult>;
  webhookConfigured?: () => boolean;
  loadCaseVars?: (db: RtDb, opportunityCaseId: string) => Partial<ContentVars>;
  now?: () => number;
  maxPerScan?: number;
}

export type DiscordDeliveryStatus = "PENDING" | "SENT" | "FAILED" | "SKIPPED_NO_WEBHOOK";
export type DraftRowStatus = "GENERATED" | "APPROVED" | "REJECTED" | "MANUALLY_POSTED" | "EDITED";

function hasTable(db: RtDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function contentEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTENT_EVENTS_ENABLED === "1";
}

/** Content drafts route to Recaps in the three-channel Discord setup. */
export function contentWebhookConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return recapDeliveryEnabled(env) && Boolean(String(env.DISCORD_WEBHOOK_RECAP ?? "").trim());
}

export function draftFingerprint(input: {
  caseId: string;
  contentEventId: string;
  eventType: string;
  milestone: string | number | null;
  templateFamily: string;
  platform?: string;
}): string {
  const key = [
    input.caseId || "",
    input.contentEventId,
    input.eventType,
    input.milestone ?? "",
    input.templateFamily,
    input.platform ?? "twitter",
  ].join("|");
  return `cd_${djb2(key)}`;
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
        { webhook: "recap", skipPublicCheck: true, audience: "subscriber", payloadType: "content_drafts" },
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

function firstOf(json: unknown): string | null {
  try {
    const arr = typeof json === "string" ? JSON.parse(json) : json;
    if (Array.isArray(arr) && arr.length && typeof arr[0] === "string") return arr[0];
  } catch { /* ignore */ }
  return null;
}

function defaultLoadCaseVars(db: RtDb, opportunityCaseId: string): Partial<ContentVars> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadCaseJsonOnDb } = require("@/lib/opportunity-case/live");
    const oc = loadCaseJsonOnDb(db, opportunityCaseId);
    const s = oc?.summary ?? {};
    const f = oc?.features ?? oc?.marketContext ?? {};
    return {
      confidence: num(s.confidence ?? oc?.confidence),
      relativeVolume: num(f.relativeVolume ?? f.relVol),
      callFlow: num(f.callFlow),
      putFlow: num(f.putFlow),
      sector: str(f.sector ?? oc?.sector),
      catalyst: str(f.catalyst ?? oc?.catalyst),
      vwap: num(f.vwap),
      support: num(f.support),
      resistance: num(f.resistance),
      underlyingPrice: num(s.currentUnderlyingPrice ?? f.underlyingPrice),
    };
  } catch { return {}; }
}
function num(x: unknown): number | null { const n = Number(x); return Number.isFinite(n) ? n : null; }
function str(x: unknown): string | null { return typeof x === "string" && x.trim() ? x.trim() : null; }

function outsideRegularSession(nowMs: number, env: NodeJS.ProcessEnv): boolean {
  try {
    const g = evaluateMarketSessionGuard(nowMs, env);
    return g.state !== "REGULAR_SESSION" && g.state !== "POWER_HOUR" && g.state !== "OPENING_DISCOVERY" && g.state !== "EARLY_CLOSE" && g.state !== "CLOSING_WINDOW";
  } catch {
    return false;
  }
}

export function varsForEventRow(row: Record<string, unknown>, caseVars: Partial<ContentVars> = {}): ContentVars {
  return {
    symbol: row.symbol != null ? String(row.symbol) : null,
    optionType: row.option_type != null ? String(row.option_type) : null,
    strike: row.strike != null ? Number(row.strike) : null,
    expiration: row.expiration != null ? String(row.expiration) : null,
    premium: row.frozen_entry != null ? Number(row.frozen_entry) : null,
    returnPct: row.return_percent != null ? Number(row.return_percent) : null,
    milestonePercent: row.milestone_percent != null ? Number(row.milestone_percent) : null,
    maxReturnPct: row.max_return_percent != null ? Number(row.max_return_percent) : null,
    reason: firstOf(row.original_thesis_json) ?? firstOf(row.evidence_summary_json),
    ...caseVars,
  };
}

export function bundleForEventRow(
  db: RtDb,
  row: Record<string, unknown>,
  deps: ContentDraftsDeps = {},
  env: NodeJS.ProcessEnv = process.env,
  claimVerified = false,
): ContentDraftBundle | null {
  const loadCaseVars = deps.loadCaseVars ?? defaultLoadCaseVars;
  const caseVars = row.opportunity_case_id ? loadCaseVars(db, String(row.opportunity_case_id)) : {};
  const vars = varsForEventRow(row, caseVars);
  const cats = filterCategoriesForClaim(
    eligibleCategories(String(row.event_type), vars, eligibilityThresholds(env)),
    claimVerified,
  );
  if (!cats.length) return null;
  const now = deps.now ?? Date.now;
  return buildDraftBundle(cats[0], vars, {
    outsideRegularSession: outsideRegularSession(now(), env),
    appendMfeDisclaimer: isPerformanceCategory(cats[0]),
  });
}

export function formatBundleForDiscord(
  bundle: ContentDraftBundle,
  opts: { resultType?: ContentResultType | null; sessionDate?: string | null } = {},
): string[] {
  const header = [
    `📝 **CONTENT DRAFTS — OWNER ONLY — ${bundle.category}** · ${bundle.symbol}`,
    `_Deterministic template drafts for MANUAL review. Never auto-posted. Not financial advice._`,
    opts.resultType ? `_Result type: ${opts.resultType}_` : null,
    opts.sessionDate ? `_Trading session: ${opts.sessionDate}_` : null,
  ].filter(Boolean).join("\n");

  const blocks = bundle.drafts.map((d, i) => [
    `**Draft ${i + 1}** (${d.charCount} chars) · CTA: ${d.ctaType}`,
    "```",
    d.text,
    "```",
    `Hashtags: ${d.hashtags.join(" ")}`,
    `📸 Screenshot: ${d.suggestedScreenshot}`,
    `📈 Chart: ${d.suggestedChartAnnotation}`,
    `🔗 CTA: ${d.suggestedCta}`,
  ].join("\n"));

  const messages: string[] = [];
  let cur = header;
  for (const b of blocks) {
    if ((cur + "\n\n" + b).length > 1900) { messages.push(cur); cur = b; }
    else cur = cur + "\n\n" + b;
  }
  if (cur.trim().length) messages.push(cur);
  return messages;
}

function persistDraftRows(
  db: RtDb,
  row: Record<string, unknown>,
  bundle: ContentDraftBundle,
  meta: {
    alertId: string | null;
    claimPacketId: string | null;
    resultType: ContentResultType;
    frozenEntry: number | null;
    markUsed: number | null;
    originalAlertAtMs: number | null;
    tradingSessionDate: string | null;
    discordStatus: DiscordDeliveryStatus;
    nowMs: number;
  },
): { inserted: number; draftIds: string[] } {
  if (!hasTable(db, "content_drafts")) return { inserted: 0, draftIds: [] };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO content_drafts (
      id, fingerprint, content_event_id, opportunity_case_id, alert_id, claim_packet_id,
      category, template_family, template_version, platform, draft_text, char_count,
      hashtags_json, screenshot_suggestion, chart_annotation, cta_type, result_type,
      frozen_entry, mark_used, original_alert_at_ms, trading_session_date,
      status, discord_delivery_status, discord_message_id, final_copy,
      created_at_ms, updated_at_ms, approved_at_ms, rejected_at_ms, manually_posted_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let inserted = 0;
  const draftIds: string[] = [];
  const caseId = row.opportunity_case_id != null ? String(row.opportunity_case_id) : "";
  const eventId = String(row.id);
  const eventType = String(row.event_type);
  const milestone = row.milestone_percent != null ? Number(row.milestone_percent) : null;

  for (const d of bundle.drafts) {
    const fp = draftFingerprint({
      caseId,
      contentEventId: eventId,
      eventType,
      milestone,
      templateFamily: d.templateFamily,
      platform: "twitter",
    });
    const id = fp;
    const info = insert.run(
      id, fp, eventId, caseId || null, meta.alertId, meta.claimPacketId,
      bundle.category, d.templateFamily, d.templateVersion || TEMPLATE_VERSION, "twitter",
      d.text, d.charCount, JSON.stringify(d.hashtags), d.suggestedScreenshot, d.suggestedChartAnnotation,
      d.ctaType as CtaType, meta.resultType,
      meta.frozenEntry, meta.markUsed, meta.originalAlertAtMs, meta.tradingSessionDate,
      "GENERATED", meta.discordStatus, null, null,
      meta.nowMs, meta.nowMs, null, null, null,
    );
    if (info.changes > 0) inserted += 1;
    draftIds.push(id);
  }
  return { inserted, draftIds };
}

function markEventProcessed(db: RtDb, eventId: string, payloadPatch: Record<string, unknown>): void {
  try {
    const existing = db.prepare("SELECT payload_json FROM opportunity_content_events WHERE id=?").get(eventId) as { payload_json?: string } | undefined;
    let payload: Record<string, unknown> = {};
    try { payload = existing?.payload_json ? JSON.parse(existing.payload_json) : {}; } catch { payload = {}; }
    Object.assign(payload, payloadPatch);
    db.prepare(
      "UPDATE opportunity_content_events SET content_status='PROCESSED', payload_json=? WHERE id=? AND content_status IN ('PENDING','DRAFTED')",
    ).run(JSON.stringify(payload), eventId);
  } catch { /* isolated */ }
}

function unsentDrafts(db: RtDb, eventId: string): Array<{ id: string; draft_text: string; category: string; cta_type: string; char_count: number; hashtags_json: string | null; screenshot_suggestion: string | null; chart_annotation: string | null; suggested_cta?: string }> {
  if (!hasTable(db, "content_drafts")) return [];
  return db.prepare(
    `SELECT id, draft_text, category, cta_type, char_count, hashtags_json, screenshot_suggestion, chart_annotation
     FROM content_drafts
     WHERE content_event_id=? AND discord_delivery_status IN ('PENDING','FAILED')
     ORDER BY created_at_ms ASC`,
  ).all(eventId) as any[];
}

export interface ContentScanResult {
  examined: number;
  delivered: number;
  skipped: number;
  failed: number;
  persisted: number;
  skippedNoWebhook: number;
  suppressedUnverified: number;
}

/**
 * Scan PENDING content events:
 * 1. Claim-check performance categories
 * 2. Persist individual drafts (idempotent)
 * 3. Deliver to DISCORD_WEBHOOK_RECAP only (or SKIPPED_NO_WEBHOOK)
 * 4. Mark source event PROCESSED after persistence
 */
export async function runContentDraftsScan(
  db: RtDb,
  deps: ContentDraftsDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContentScanResult> {
  const out: ContentScanResult = {
    examined: 0, delivered: 0, skipped: 0, failed: 0, persisted: 0, skippedNoWebhook: 0, suppressedUnverified: 0,
  };
  if (!contentEventsEnabled(env)) return out;
  if (!hasTable(db, "opportunity_content_events")) return out;

  const webhookOk = (() => {
    try { return (deps.webhookConfigured ?? (() => contentWebhookConfigured(env)))(); }
    catch { return false; }
  })();
  const send = deps.send ?? defaultSend();
  const now = deps.now ?? Date.now;
  // A scheduled run may create several stored drafts, but it may emit at most one
  // Recap message. Additional events remain queued for the next bounded run.
  const cap = Math.min(deps.maxPerScan ?? 20, 1);

  let rows: Record<string, unknown>[] = [];
  try {
    rows = db.prepare(
      "SELECT * FROM opportunity_content_events WHERE content_status='PENDING' ORDER BY occurred_at_ms ASC LIMIT ?",
    ).all(cap) as Record<string, unknown>[];
  } catch { return out; }

  for (const row of rows) {
    out.examined += 1;
    try {
    const eventId = String(row.id);
    const caseId = row.opportunity_case_id != null ? String(row.opportunity_case_id) : null;
    const nowMs = now();

    // Peek categories to know if claim is required
    const loadCaseVars = deps.loadCaseVars ?? defaultLoadCaseVars;
    const caseVars = caseId ? loadCaseVars(db, caseId) : {};
    const vars = varsForEventRow(row, caseVars);
    const rawCats = eligibleCategories(String(row.event_type), vars, eligibilityThresholds(env));
    if (!rawCats.length) { out.skipped += 1; markEventProcessed(db, eventId, { contentSkipReason: "no_eligible_category" }); continue; }

    const needsClaim = rawCats.some((c) => isPerformanceCategory(c));
    const claim = needsClaim
      ? verifyContentClaimForCase(db, caseId, rawCats[0])
      : { ok: true, reason: null, alertId: null, claim: null, resultType: "NON_ACTIONABLE_RESEARCH" as ContentResultType, claimPacketId: null };

    if (needsClaim && !claim.ok) {
      out.suppressedUnverified += 1;
      markEventProcessed(db, eventId, {
        contentSkipReason: "unverified_performance_claim",
        claimFailReason: claim.reason,
      });
      continue;
    }

    const bundle = bundleForEventRow(db, row, deps, env, claim.ok);
    if (!bundle) {
      out.skipped += 1;
      markEventProcessed(db, eventId, { contentSkipReason: "bundle_empty_after_filters" });
      continue;
    }

    const sessionDate = tradingDay(Number(row.occurred_at_ms) || nowMs);
    const discordStatus: DiscordDeliveryStatus = webhookOk ? "PENDING" : "SKIPPED_NO_WEBHOOK";
    const persisted = persistDraftRows(db, row, bundle, {
      alertId: claim.alertId,
      claimPacketId: claim.claimPacketId,
      resultType: claim.resultType,
      frozenEntry: row.frozen_entry != null ? Number(row.frozen_entry) : claim.claim?.frozenEntry ?? null,
      markUsed: row.current_mark != null ? Number(row.current_mark) : null,
      originalAlertAtMs: claim.claim?.sentAtMs ?? (row.occurred_at_ms != null ? Number(row.occurred_at_ms) : null),
      tradingSessionDate: sessionDate,
      discordStatus,
      nowMs,
    });
    out.persisted += persisted.inserted;

    // Always mark PROCESSED after successful persistence attempt (even 0 inserts = already persisted).
    markEventProcessed(db, eventId, {
      contentBundle: bundle,
      contentPersistedAtMs: nowMs,
      resultType: claim.resultType,
      claimPacketId: claim.claimPacketId,
      mfeDisclaimer: bundle.category === "NEW_HIGH" || bundle.drafts.some((d) => /MFE|max favorable/i.test(d.text))
        ? mfeDisclaimer(vars.maxReturnPct)
        : null,
    });

    if (!webhookOk) {
      out.skippedNoWebhook += 1;
      if (hasTable(db, "content_drafts")) {
        try {
          db.prepare(
            `UPDATE content_drafts SET discord_delivery_status='SKIPPED_NO_WEBHOOK', updated_at_ms=?
             WHERE content_event_id=? AND discord_delivery_status='PENDING'`,
          ).run(nowMs, eventId);
        } catch { /* isolated */ }
      }
      continue;
    }

    // Deliver only unsent drafts (supports partial retry).
    const pending = unsentDrafts(db, eventId);
    if (!pending.length) { out.delivered += 1; continue; }

    const header = `📝 **CONTENT DRAFTS — OWNER ONLY — ${bundle.category}** · ${bundle.symbol}\n_Deterministic template drafts for MANUAL review. Never auto-posted. Not financial advice._\n_Result type: ${claim.resultType}_ · _Session: ${sessionDate}_`;
    const draftBlocks = pending.map((draft) => [
      `**Draft** (${draft.char_count} chars) · CTA: ${draft.cta_type}`,
      "```",
      draft.draft_text,
      "```",
    ].join("\n"));
    const body = [header, ...draftBlocks].join("\n\n").slice(0, 1900);
    let res: ContentDeliverResult;
    try {
      res = await send(body);
    } catch (e: any) {
      res = { ok: false, messageId: null, error: String(e?.message ?? e).slice(0, 300) };
    }
    const nextStatus = res.ok ? "SENT" : res.suppressed ? "SUPPRESSED" : "FAILED";
    for (const draft of pending) {
      try {
        db.prepare(
          `UPDATE content_drafts
           SET discord_delivery_status=?, discord_message_id=?, updated_at_ms=?
           WHERE id=?`,
        ).run(nextStatus, res.messageId, nowMs, draft.id);
      } catch { /* isolated */ }
    }
    if (res.ok) out.delivered += 1;
    else if (res.suppressed) out.skipped += 1;
    else out.failed += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}

/** Owner store helpers — list / update drafts without touching live trading paths. */
export function listContentDraftsOnDb(
  db: RtDb,
  filters: {
    limit?: number;
    symbol?: string;
    category?: string;
    status?: string;
    eventType?: string;
    sinceMs?: number;
  } = {},
): Record<string, unknown>[] {
  if (!hasTable(db, "content_drafts")) return [];
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const w: string[] = [];
  const a: unknown[] = [];
  if (filters.category) { w.push("d.category=?"); a.push(filters.category); }
  if (filters.status) { w.push("d.status=?"); a.push(filters.status); }
  if (filters.sinceMs != null) { w.push("d.created_at_ms>=?"); a.push(filters.sinceMs); }
  if (filters.symbol) { w.push("UPPER(e.symbol)=?"); a.push(String(filters.symbol).toUpperCase()); }
  if (filters.eventType) { w.push("e.event_type=?"); a.push(filters.eventType); }
  a.push(limit);
  const sql = `
    SELECT d.*, e.symbol AS symbol, e.event_type AS event_type, e.occurred_at_ms AS occurred_at_ms
    FROM content_drafts d
    LEFT JOIN opportunity_content_events e ON e.id = d.content_event_id
    ${w.length ? `WHERE ${w.join(" AND ")}` : ""}
    ORDER BY d.created_at_ms DESC
    LIMIT ?`;
  try {
    return db.prepare(sql).all(...a) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

export function getContentDraftOnDb(db: RtDb, id: string): Record<string, unknown> | null {
  if (!hasTable(db, "content_drafts")) return null;
  try {
    const row = db.prepare(
      `SELECT d.*, e.symbol AS symbol, e.event_type AS event_type, e.occurred_at_ms AS occurred_at_ms, e.payload_json AS event_payload_json
       FROM content_drafts d
       LEFT JOIN opportunity_content_events e ON e.id = d.content_event_id
       WHERE d.id=?`,
    ).get(id) as Record<string, unknown> | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export function updateContentDraftOnDb(
  db: RtDb,
  id: string,
  patch: {
    action: "approve" | "reject" | "edit" | "mark_posted" | "save_final";
    editedText?: string;
    finalCopy?: string;
  },
  nowMs = Date.now(),
): boolean {
  if (!hasTable(db, "content_drafts")) return false;
  const row = db.prepare("SELECT id, draft_text, final_copy FROM content_drafts WHERE id=?").get(id) as { id: string; draft_text: string; final_copy: string | null } | undefined;
  if (!row) return false;
  try {
    if (patch.action === "approve") {
      db.prepare(`UPDATE content_drafts SET status='APPROVED', approved_at_ms=?, updated_at_ms=? WHERE id=?`).run(nowMs, nowMs, id);
    } else if (patch.action === "reject") {
      db.prepare(`UPDATE content_drafts SET status='REJECTED', rejected_at_ms=?, updated_at_ms=? WHERE id=?`).run(nowMs, nowMs, id);
    } else if (patch.action === "edit") {
      const text = String(patch.editedText ?? "").trim();
      if (!text) return false;
      db.prepare(`UPDATE content_drafts SET status='EDITED', draft_text=?, char_count=?, final_copy=?, updated_at_ms=? WHERE id=?`)
        .run(text, text.length, text, nowMs, id);
    } else if (patch.action === "mark_posted") {
      db.prepare(`UPDATE content_drafts SET status='MANUALLY_POSTED', manually_posted_at_ms=?, updated_at_ms=? WHERE id=?`).run(nowMs, nowMs, id);
    } else if (patch.action === "save_final") {
      const final = String(patch.finalCopy ?? patch.editedText ?? "").trim();
      if (!final) return false;
      db.prepare(`UPDATE content_drafts SET final_copy=?, updated_at_ms=? WHERE id=?`).run(final, nowMs, id);
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Regenerate one draft using a different template family index for the same category.
 * Idempotent fingerprint includes templateFamily so a new row is created (old kept).
 */
export function regenerateContentDraftOnDb(
  db: RtDb,
  id: string,
  deps: ContentDraftsDeps = {},
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Record<string, unknown> | null {
  const existing = getContentDraftOnDb(db, id);
  if (!existing) return null;
  const eventId = String(existing.content_event_id);
  const event = db.prepare("SELECT * FROM opportunity_content_events WHERE id=?").get(eventId) as Record<string, unknown> | undefined;
  if (!event) return null;

  const claim = verifyContentClaimForCase(db, existing.opportunity_case_id as string, String(existing.category));
  if (isPerformanceCategory(String(existing.category)) && !claim.ok) return null;

  const bundle = bundleForEventRow(db, event, deps, env, claim.ok);
  if (!bundle) return null;

  // Prefer a template family different from the current one
  const currentFamily = String(existing.template_family ?? "");
  const alt = bundle.drafts.find((d) => d.templateFamily !== currentFamily) ?? bundle.drafts[0];
  if (!alt) return null;

  const single = { ...bundle, drafts: [alt] };
  persistDraftRows(db, event, single, {
    alertId: claim.alertId ?? (existing.alert_id as string | null) ?? null,
    claimPacketId: claim.claimPacketId,
    resultType: claim.resultType,
    frozenEntry: existing.frozen_entry != null ? Number(existing.frozen_entry) : null,
    markUsed: existing.mark_used != null ? Number(existing.mark_used) : null,
    originalAlertAtMs: existing.original_alert_at_ms != null ? Number(existing.original_alert_at_ms) : null,
    tradingSessionDate: existing.trading_session_date != null ? String(existing.trading_session_date) : null,
    discordStatus: contentWebhookConfigured(env) ? "PENDING" : "SKIPPED_NO_WEBHOOK",
    nowMs,
  });
  const fp = draftFingerprint({
    caseId: String(existing.opportunity_case_id ?? ""),
    contentEventId: eventId,
    eventType: String(event.event_type),
    milestone: event.milestone_percent != null ? Number(event.milestone_percent) : null,
    templateFamily: alt.templateFamily,
  });
  return getContentDraftOnDb(db, fp);
}

/** Structural proof: this module never imports or calls any Twitter/X posting API. */
export const TWITTER_AUTO_POST_PATHS = [] as const;
