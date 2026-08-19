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
import { evaluateInstrumentSession } from "../instrument-session-authority.ts";
import { classifyDeliveryResult, describeReason, redactForPersistence } from "./delivery-reason.ts";
import { deriveFailureCause } from "./failure-cause.ts";
import { gateContentBundle, type ContentGateVerdict } from "./content-gate.ts";
import {
  classifyDeliveryLane,
  isOutcomeReportCategory,
  laneWindows,
  OUTCOME_REPORT_CATEGORIES,
} from "./outcome-delivery-lane.ts";

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
  /**
   * True when the bundle was rerouted (lane, dedup) WITHOUT any Discord call,
   * so it cost nothing against the channel budget. The recovery sweep uses this
   * to tell "keep scanning" from "the channel refused us, stop".
   */
  reroutedWithoutPosting?: boolean;
}
export interface ContentDraftsDeps {
  send?: (content: string) => Promise<ContentDeliverResult>;
  webhookConfigured?: () => boolean;
  loadCaseVars?: (db: RtDb, opportunityCaseId: string) => Partial<ContentVars>;
  now?: () => number;
  maxPerScan?: number;
  /**
   * How many deferred events one sweep may EXAMINE. Rerouting an old event to
   * the digest costs no Discord post, so examining many per run drains the
   * reclassification backlog quickly while still sending at most one message.
   */
  maxDeferredExaminedPerScan?: number;
}

/**
 * `SKIPPED_NO_WEBHOOK` is a RETRY BUCKET, not a diagnosis. It means "undelivered
 * and retryable", and `RETRYABLE_DELIVERY_STATES` depends on that name, so it is
 * not renamed here. It does NOT mean a webhook was missing: on 2026-08-03 all 50
 * drafts carried it while `DISCORD_WEBHOOK_RECAP` was configured and
 * `DISCORD_RECAP_ENABLED=0` was the actual cause. For the reason, ask
 * `recapDeliveryDiagnosis()` in lib/notifications/recap-health.ts — never infer
 * it from this status.
 */
export type DiscordDeliveryStatus = "PENDING" | "SENT" | "FAILED" | "SUPPRESSED" | "SKIPPED_NO_WEBHOOK";
export type DraftRowStatus = "GENERATED" | "APPROVED" | "REJECTED" | "MANUALLY_POSTED" | "EDITED";

function hasTable(db: RtDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

/**
 * Whether the delivery-reason columns exist. A database written before those
 * columns were added must keep working exactly as it did — referencing a column
 * SQLite does not have is an error, not a NULL, so the retryability filter has
 * to be omitted rather than defaulted.
 */
function hasRetryableColumn(db: RtDb): boolean {
  try {
    return (db.prepare("PRAGMA table_info(content_drafts)").all() as { name?: string }[])
      .some((c) => c.name === "discord_delivery_retryable");
  } catch { return false; }
}

/** `AND` clause excluding explicitly non-retryable rows, or "" pre-migration. */
function retryableFilter(db: RtDb): string {
  return hasRetryableColumn(db) ? " AND discord_delivery_retryable IS NOT 0" : "";
}

/**
 * Contract columns on `opportunity_content_events`, selected only when they
 * exist.
 *
 * Referencing a column SQLite does not have is an ERROR, not a NULL — it fails
 * the whole statement, and both readers here swallow errors and return empty.
 * So naming these unconditionally does not degrade on an older database file,
 * it silently blanks the drafts list entirely. Probed once per call, mirroring
 * `hasRetryableColumn` above.
 */
const EVENT_CONTRACT_COLUMNS = [
  "strike", "expiration", "option_type", "direction",
  "strategy_key", "return_percent", "max_return_percent",
] as const;

function eventContractSelect(db: RtDb): string {
  let present: string[] = [];
  try {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(opportunity_content_events)").all() as { name?: string }[])
        .map((c) => String(c.name ?? "")),
    );
    present = EVENT_CONTRACT_COLUMNS.filter((c) => cols.has(c));
  } catch { present = []; }
  return present.length ? `, ${present.map((c) => `e.${c} AS ${c}`).join(", ")}` : "";
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function contentEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTENT_EVENTS_ENABLED === "1";
}

export type ContentDeliveryPolicy =
  | "DELIVER_CURRENT_RESEARCH"
  | "DELIVER_HISTORICAL_REPORT_CARD"
  | "DELIVER_NEXT_SESSION_WATCH"
  | "ARCHIVE_STALE_RESEARCH";

/**
 * Categories whose whole purpose is to be read when the market is NOT open. They
 * make no claim about a current executable quote, so "the session is closed" is
 * their normal condition rather than a reason to suppress them.
 *
 * Found by auditing the 87 SUPPRESSED_STALE_RESEARCH rows in production: the
 * original rule treated any draft outside underlying RTH as stale, which archived
 * NEXT_SESSION_WATCH — the one message that exists specifically to be sent after
 * the close. Being genuinely stale (cross-session, expired contract, or past its
 * delivery window) still archives these; only the closed-session condition is
 * forgiven.
 */
const AFTER_HOURS_DELIVERABLE_CATEGORIES = new Set([
  "NEXT_SESSION_WATCH",
  "EDUCATIONAL_BREAKDOWN",
  "MARKET_OBSERVATION",
]);

export function classifyContentDeliveryPolicy(input: {
  category: string;
  symbol: string;
  expiration: string | null;
  sessionDate: string;
  eventOccurredAtMs: number | null;
  nowMs: number;
  env?: NodeJS.ProcessEnv;
}): { policy: ContentDeliveryPolicy; reason: string } {
  const env = input.env ?? process.env;
  const session = evaluateInstrumentSession(
    { symbol: input.symbol, expiration: input.expiration }, input.nowMs, env,
  );
  const nowDay = tradingDay(input.nowMs);
  const maxAgeRaw = Number(env.CONTENT_RESEARCH_MAX_DELIVERY_AGE_MS ?? 15 * 60_000);
  const maxAgeMs = Number.isFinite(maxAgeRaw) ? Math.max(30_000, Math.min(60 * 60_000, maxAgeRaw)) : 15 * 60_000;
  const ageMs = input.eventOccurredAtMs == null ? null : input.nowMs - input.eventOccurredAtMs;
  // Separate the two reasons a draft can be "not current". Being outside RTH is a
  // property of the CLOCK; being cross-session, expired or past its delivery window
  // is a property of the DRAFT. Only the second makes an after-hours category stale.
  const sessionClosed = session.underlyingState !== "UNDERLYING_RTH_OPEN";
  const draftIsStale = input.sessionDate !== nowDay
    || (input.expiration != null && input.expiration < nowDay)
    || ageMs == null || ageMs < 0 || ageMs > maxAgeMs;
  const historical = draftIsStale || sessionClosed;
  if (isPerformanceCategory(input.category)) {
    return historical
      ? { policy: "DELIVER_HISTORICAL_REPORT_CARD", reason: "verified performance content is historical and non-actionable" }
      : { policy: "DELIVER_CURRENT_RESEARCH", reason: "verified performance content is current" };
  }
  if (AFTER_HOURS_DELIVERABLE_CATEGORIES.has(input.category) && !draftIsStale) {
    return {
      policy: "DELIVER_NEXT_SESSION_WATCH",
      reason: sessionClosed
        ? "non-actionable after-hours category delivered for the next session"
        : "non-actionable category delivered inside its window",
    };
  }
  if (historical) {
    return { policy: "ARCHIVE_STALE_RESEARCH", reason: "live-looking research is stale, expired, cross-session, or outside underlying RTH" };
  }
  return { policy: "DELIVER_CURRENT_RESEARCH", reason: "current-session owner research inside its delivery window" };
}

/**
 * Content drafts require their OWN webhook, and route nowhere else.
 *
 * They used to require and use DISCORD_WEBHOOK_RECAP — the owner's recap channel — and in
 * production 1209 drafts were delivered into it. Owner validation results and marketing
 * drafts are different audiences with different rules about what may be claimed, and sharing
 * one channel is how the distinction stops being visible at the moment it matters most.
 *
 * With DISCORD_WEBHOOK_CONTENT unset this returns false, and the scan persists every draft
 * with SKIPPED_NO_WEBHOOK — the existing RETRY bucket, not a discard. The drafts stay in the
 * private app and the existing recovery path delivers them once the webhook is configured.
 * Nothing is lost and nothing is re-routed.
 */
export function contentWebhookConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return contentDeliveryEnabled(env) && Boolean(String(env.DISCORD_WEBHOOK_CONTENT ?? "").trim());
}

/**
 * The kill switch for content DELIVERY, defaulting to on.
 *
 * Content used to be governed by DISCORD_RECAP_ENABLED, which was correct only while it
 * shared the recap channel. Now that it has its own destination, letting the recap switch
 * silence it would be the same conflation running the other way — turning off recaps would
 * stop marketing drafts, and turning them back on would resume them, neither being what the
 * owner asked for.
 *
 * Unset means enabled, so configuring the new webhook is the only step required. Explicit
 * "0" or "false" holds drafts in the retry pool with DISABLED_BY_KILL_SWITCH as the reason.
 * `CONTENT_EVENTS_ENABLED` remains the master switch for generating drafts at all; this one
 * governs only whether generated drafts are delivered.
 */
export function contentDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.DISCORD_CONTENT_ENABLED ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false");
}

/** What the owner has to do when content is being held. Stated, never inferred from silence. */
export const NO_CONTENT_WEBHOOK_OWNER_ACTION =
  "Set DISCORD_WEBHOOK_CONTENT to a dedicated private content channel. Until then, drafts are " +
  "persisted and visible in the private app, and are never sent to the recap, alert or " +
  "subscriber channels.";

/**
 * LEGACY fingerprint, kept only because existing rows carry it and the delivery
 * and census paths still read them. It is NOT used to write new drafts: keyed on
 * `contentEventId`, which is unique per generation, it could only ever collide
 * with a literal re-run of the same generation. See
 * `semanticContentFingerprint` in content-worthiness.ts for what replaced it.
 */
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
      if (!discordWebhookConfigured("content")) {
        return { ok: false, messageId: null, error: "DISCORD_WEBHOOK_CONTENT not configured" };
      }
      const r = await postToDiscord(
        { content },
        {
          webhook: "content",
          skipPublicCheck: true,
          // `owner_admin` is the truthful audience: these are drafts for the owner to review
          // and post by hand, not anything a subscriber receives. It does NOT loosen
          // redaction — internal case ids and links are stripped either way, because
          // `includeInternalLink` is not set and sanitization requires both.
          audience: "owner_admin",
          payloadType: "content_drafts",
        },
      );
      return {
        ok: !r.suppressed,
        messageId: r.messageId ?? null,
        error: r.suppressed ? `content channel suppressed: ${r.suppressionReason}` : null,
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

/**
 * Where the peak a draft renders comes from.
 *
 * `opportunity_content_events.max_return_percent` is a copy of the case summary's
 * ratcheted `maxReturnPct`, taken at the moment the event was emitted. That is the
 * poisoned value — it is what the GOOGL draft rendered as +185.4077%. When a claim
 * check has run it supersedes the row entirely: a verified peak replaces it, and an
 * unverified one blanks it, so no template can reach a number the frozen contract
 * never printed.
 *
 * `checked: false` (no claim check ran, i.e. a non-performance category) leaves the
 * row's value alone — those templates never quote a peak.
 */
export interface VerifiedExcursionOverride {
  checked: boolean;
  maxReturnPct: number | null;
}

export function varsForEventRow(
  row: Record<string, unknown>,
  caseVars: Partial<ContentVars> = {},
  env: NodeJS.ProcessEnv = process.env,
  excursion: VerifiedExcursionOverride = { checked: false, maxReturnPct: null },
): ContentVars {
  // `reason` is the ENTRY thesis. It is kept for the categories that legitimately
  // describe why a setup was TAKEN, and mirrored to `entryThesis` so a failure
  // template can quote it under an explicit label. It must never reach a
  // "why this failed" slot — see lib/content/failure-cause.ts.
  const entryThesis = firstOf(row.original_thesis_json) ?? firstOf(row.evidence_summary_json);
  const maxReturnPct = excursion.checked
    ? excursion.maxReturnPct
    : (row.max_return_percent != null ? Number(row.max_return_percent) : null);
  const failure = deriveFailureCause(
    {
      returnPercent: row.return_percent != null ? Number(row.return_percent) : null,
      // The failure story reasons over "how far did it get before it turned", so it
      // must read the same verified peak the copy does. A floored 0 would otherwise
      // narrate "never moved in our favour" for a trade that did.
      maxReturnPercent: maxReturnPct,
      frozenEntry: row.frozen_entry != null ? Number(row.frozen_entry) : null,
      currentMark: row.current_mark != null ? Number(row.current_mark) : null,
      optionType: row.option_type != null ? String(row.option_type) : null,
      direction: row.direction != null ? String(row.direction) : null,
    },
    env,
  );
  return {
    symbol: row.symbol != null ? String(row.symbol) : null,
    optionType: row.option_type != null ? String(row.option_type) : null,
    strike: row.strike != null ? Number(row.strike) : null,
    expiration: row.expiration != null ? String(row.expiration) : null,
    premium: row.frozen_entry != null ? Number(row.frozen_entry) : null,
    returnPct: row.return_percent != null ? Number(row.return_percent) : null,
    milestonePercent: row.milestone_percent != null ? Number(row.milestone_percent) : null,
    maxReturnPct,
    reason: entryThesis,
    entryThesis,
    failureCause: failure.statement,
    ...caseVars,
  };
}

export function bundleForEventRow(
  db: RtDb,
  row: Record<string, unknown>,
  deps: ContentDraftsDeps = {},
  env: NodeJS.ProcessEnv = process.env,
  claimVerified = false,
  excursion: VerifiedExcursionOverride = { checked: false, maxReturnPct: null },
): ContentDraftBundle | null {
  const loadCaseVars = deps.loadCaseVars ?? defaultLoadCaseVars;
  const caseVars = row.opportunity_case_id ? loadCaseVars(db, String(row.opportunity_case_id)) : {};
  const vars = varsForEventRow(row, caseVars, env, excursion);
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
    /** Verdict from `content-gate.ts`. Only admitted drafts are written. */
    gate: ContentGateVerdict;
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
  // The gate decides WHAT may be written. An unworthy or duplicate idea writes
  // nothing at all — the correct output for a routine event is zero rows, not a
  // row nobody will read.
  if (!meta.gate.admitted.length) return { inserted: 0, draftIds: [] };
  const scored = hasColumn(db, "content_drafts", "content_worthiness");
  const insert = db.prepare(
    `INSERT OR IGNORE INTO content_drafts (
      id, fingerprint, content_event_id, opportunity_case_id, alert_id, claim_packet_id,
      category, template_family, template_version, platform, draft_text, char_count,
      hashtags_json, screenshot_suggestion, chart_annotation, cta_type, result_type,
      frozen_entry, mark_used, original_alert_at_ms, trading_session_date,
      status, discord_delivery_status, discord_message_id, final_copy,
      created_at_ms, updated_at_ms, approved_at_ms, rejected_at_ms, manually_posted_at_ms${scored ? ", content_worthiness, content_angle, worthiness_json, is_alternate" : ""}
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${scored ? ",?,?,?,?" : ""})`,
  );
  let inserted = 0;
  const draftIds: string[] = [];
  const caseId = row.opportunity_case_id != null ? String(row.opportunity_case_id) : "";
  const eventId = String(row.id);

  for (const a of meta.gate.admitted) {
    const d = bundle.drafts[a.index];
    if (!d) continue;
    // The fingerprint is SEMANTIC now. The old key included `contentEventId`,
    // which is unique per generation, so the UNIQUE constraint on this column
    // deduplicated nothing — in the production sample, fingerprint === id for
    // all 200 rows. A retry, a restart, or an unchanged event re-emitted ten
    // minutes later now collides here and inserts nothing.
    const fp = a.fingerprint;
    const id = fp;
    const args: any[] = [
      id, fp, eventId, caseId || null, meta.alertId, meta.claimPacketId,
      bundle.category, d.templateFamily, d.templateVersion || TEMPLATE_VERSION, "twitter",
      d.text, d.charCount, JSON.stringify(d.hashtags), d.suggestedScreenshot, d.suggestedChartAnnotation,
      d.ctaType as CtaType, meta.resultType,
      meta.frozenEntry, meta.markUsed, meta.originalAlertAtMs, meta.tradingSessionDate,
      "GENERATED", meta.discordStatus, null, null,
      meta.nowMs, meta.nowMs, null, null, null,
    ];
    if (scored) {
      args.push(
        meta.gate.worthiness.score,
        meta.gate.angle,
        JSON.stringify(meta.gate.worthiness.dimensions),
        a.isAlternate ? 1 : 0,
      );
    }
    const info = insert.run(...args);
    if (info.changes > 0) inserted += 1;
    draftIds.push(id);
  }
  return { inserted, draftIds };
}

function hasColumn(db: RtDb, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return cols.some((c) => c?.name === column);
  } catch {
    return false;
  }
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

/**
 * Delivery states that are NOT terminal.
 *
 * `SKIPPED_NO_WEBHOOK` belongs here, and its absence was a real defect. The scan
 * marks the SOURCE EVENT `PROCESSED` before it checks the webhook, so an event
 * whose drafts were skipped is never re-examined; and this query excluded
 * `SKIPPED_NO_WEBHOOK`, so the drafts were never picked up either. Every draft
 * generated while `DISCORD_WEBHOOK_RECAP` was unset therefore became permanently
 * undeliverable — configuring the webhook afterwards would deliver only FUTURE
 * content and strand everything already written.
 *
 * On 2026-08-03 production held 50 such drafts, including 6 CLOSED_WINNER and 2
 * WHY_THIS_WORKED report cards, all `SKIPPED_NO_WEBHOOK`.
 *
 * "No webhook was configured yet" is a statement about CONFIGURATION, not about
 * the draft. It is deferral, and deferral must be recoverable.
 */
const RETRYABLE_DELIVERY_STATES = ["PENDING", "FAILED", "SKIPPED_NO_WEBHOOK"] as const;

const RETRYABLE_SQL_LIST = RETRYABLE_DELIVERY_STATES.map((s) => `'${s}'`).join(",");

function unsentDrafts(db: RtDb, eventId: string): Array<{ id: string; draft_text: string; category: string; cta_type: string; char_count: number; hashtags_json: string | null; screenshot_suggestion: string | null; chart_annotation: string | null; suggested_cta?: string }> {
  if (!hasTable(db, "content_drafts")) return [];
  // A row explicitly marked non-retryable (Discord rejected the payload, attempts
  // exhausted) must not be picked up again. `IS NOT 0` keeps pre-migration rows,
  // whose retryability was never recorded, eligible as before.
  return db.prepare(
    `SELECT id, draft_text, category, cta_type, char_count, hashtags_json, screenshot_suggestion, chart_annotation
     FROM content_drafts
     WHERE content_event_id=? AND discord_delivery_status IN (${RETRYABLE_SQL_LIST})${retryableFilter(db)}
     ORDER BY created_at_ms ASC`,
  ).all(eventId) as any[];
}

/**
 * Content events holding UNDELIVERED drafts, oldest first. Read regardless of
 * the event's own `content_status`, because the event was marked PROCESSED at
 * generation time and will never appear in the PENDING scan again.
 *
 * This selected only `SKIPPED_NO_WEBHOOK`, which was correct while that was the
 * one way a draft could be deferred. It no longer is: a transient refusal now
 * parks a draft at `PENDING`, and a retryable transport failure at `FAILED`.
 * Matching one literal status would have stranded both — the same defect the
 * webhook deferral had, reintroduced one state along.
 *
 * Rows explicitly marked non-retryable are excluded.
 */
function deferredDraftEventIds(db: RtDb, limit: number): string[] {
  if (!hasTable(db, "content_drafts")) return [];
  try {
    return (db.prepare(
      `SELECT content_event_id AS id, MIN(created_at_ms) AS first_at
         FROM content_drafts
        WHERE discord_delivery_status IN (${RETRYABLE_SQL_LIST})${retryableFilter(db)}
        GROUP BY content_event_id
        ORDER BY first_at ASC LIMIT ?`,
    ).all(limit) as { id: string }[]).map((r) => String(r.id));
  } catch { return []; }
}

export interface ContentScanResult {
  examined: number;
  delivered: number;
  skipped: number;
  failed: number;
  persisted: number;
  skippedNoWebhook: number;
  suppressedUnverified: number;
  /** Bundles recovered from a period when no webhook was configured. */
  deferredDelivered: number;
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
    examined: 0, delivered: 0, skipped: 0, failed: 0, persisted: 0, skippedNoWebhook: 0,
    suppressedUnverified: 0, deferredDelivered: 0,
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

  // LIVE FIRST, then oldest-first within each group.
  //
  // Plain `occurred_at_ms ASC` meant a closure that happened 30 seconds ago
  // queued behind every older PENDING event. At one event per scan that is not
  // a small delay — it is the live message losing its slot to backlog, which is
  // precisely what made the Recaps channel useless on 2026-08-05.
  const liveCutoffMs = now() - laneWindows(env).liveMs;
  let rows: Record<string, unknown>[] = [];
  try {
    rows = db.prepare(
      `SELECT * FROM opportunity_content_events
        WHERE content_status='PENDING'
        ORDER BY CASE WHEN occurred_at_ms >= ? THEN 0 ELSE 1 END, occurred_at_ms ASC
        LIMIT ?`,
    ).all(liveCutoffMs, cap) as Record<string, unknown>[];
  } catch { return out; }

  // Events the PENDING pass already acted on this run. The recovery sweep below
  // now matches PENDING as a retryable state, so without this an event parked by
  // a transient refusal would be retried again in the SAME scan — two attempts
  // against a channel budget that just refused one.
  const handledThisRun = new Set<string>();

  for (const row of rows) {
    out.examined += 1;
    try {
    const eventId = String(row.id);
    handledThisRun.add(eventId);
    const caseId = row.opportunity_case_id != null ? String(row.opportunity_case_id) : null;
    const nowMs = now();

    // Peek categories to know if claim is required
    const loadCaseVars = deps.loadCaseVars ?? defaultLoadCaseVars;
    const caseVars = caseId ? loadCaseVars(db, caseId) : {};
    const vars = varsForEventRow(row, caseVars, env);
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

    const bundle = bundleForEventRow(db, row, deps, env, claim.ok, {
      checked: needsClaim,
      maxReturnPct: claim.verifiedMaxReturnPct ?? null,
    });
    if (!bundle) {
      out.skipped += 1;
      markEventProcessed(db, eventId, { contentSkipReason: "bundle_empty_after_filters" });
      continue;
    }

    const sessionDate = tradingDay(Number(row.occurred_at_ms) || nowMs);

    // ── CONTENT-WORTHINESS + COHERENCE + DEDUPE ─────────────────────────────
    // The step that decides whether this deserves to exist. Everything above
    // established that content COULD be made; this establishes whether it
    // SHOULD. A refusal here is a normal, healthy outcome — on a routine day
    // the correct number of drafts is zero.
    const gate = gateContentBundle(db, {
      symbol: bundle.symbol,
      category: bundle.category,
      optionType: row.option_type != null ? String(row.option_type) : null,
      direction: row.direction != null ? String(row.direction) : null,
      sessionDate,
      thesisParts: [
        firstOf(row.original_thesis_json),
        firstOf(row.evidence_summary_json),
        row.label != null ? String(row.label) : null,
      ],
      milestone: row.milestone_percent != null ? Number(row.milestone_percent) : null,
      evidenceState: claim.resultType,
      claimVerified: claim.ok && needsClaim,
      hasExactOcc: row.strike != null && row.expiration != null,
      hasRealizedOutcome: isPerformanceCategory(bundle.category),
      isMaxExcursion: bundle.category === "NEW_HIGH",
      ownerValidationOnly: true,
      magnitudePct: row.return_percent != null ? Number(row.return_percent) : null,
      eventAgeMs: Math.max(0, nowMs - (Number(row.occurred_at_ms) || nowMs)),
      drafts: bundle.drafts.map((d) => ({ text: d.text, templateFamily: d.templateFamily })),
    }, env);

    if (!gate.admitted.length) {
      out.skipped += 1;
      markEventProcessed(db, eventId, {
        contentSkipReason: gate.duplicate ? "duplicate_content_idea" : "below_content_worthiness",
        contentWorthiness: gate.worthiness.score,
        contentWorthinessRefusal: gate.refusedBecause,
        contentIncoherentDrafts: gate.incoherent.length,
      });
      continue;
    }

    const discordStatus: DiscordDeliveryStatus = webhookOk ? "PENDING" : "SKIPPED_NO_WEBHOOK";
    const persisted = persistDraftRows(db, row, bundle, {
      gate,
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
        // A kill switch that is ON and a webhook that was never configured are
        // different owner actions with different fixes. They shared a status
        // before; they no longer share a reason.
        const deferral = describeReason(
          contentDeliveryEnabled(env) ? "SKIPPED_NO_WEBHOOK" : "DISABLED_BY_KILL_SWITCH",
        );
        try {
          db.prepare(
            `UPDATE content_drafts
             SET discord_delivery_status='SKIPPED_NO_WEBHOOK', updated_at_ms=?,
                 discord_delivery_reason=?, discord_delivery_explanation=?,
                 discord_delivery_retryable=1
             WHERE content_event_id=? AND discord_delivery_status IN ('PENDING','SKIPPED_NO_WEBHOOK')`,
          ).run(nowMs, deferral.code, deferral.explanation, eventId);
        } catch {
          try {
            db.prepare(
              `UPDATE content_drafts SET discord_delivery_status='SKIPPED_NO_WEBHOOK', updated_at_ms=?
               WHERE content_event_id=? AND discord_delivery_status='PENDING'`,
            ).run(nowMs, eventId);
          } catch { /* isolated */ }
        }
      }
      continue;
    }

    // Deliver only unsent drafts (supports partial retry).
    const pending = unsentDrafts(db, eventId);
    if (!pending.length) { out.delivered += 1; continue; }

    const res = await deliverDrafts(db, send, pending, {
      category: bundle.category, symbol: bundle.symbol,
      resultType: claim.resultType, sessionDate, nowMs,
      expiration: row.expiration == null ? null : String(row.expiration),
      eventOccurredAtMs: row.occurred_at_ms == null ? null : Number(row.occurred_at_ms),
      env, eventId, caseId,
    });
    if (res.ok) out.delivered += 1;
    else if (res.suppressed) out.skipped += 1;
    else out.failed += 1;
    } catch {
      out.failed += 1;
    }
  }

  // ── Deferred recovery ────────────────────────────────────────────────
  // Drafts written while no webhook was configured are stranded: their source
  // event was marked PROCESSED at generation time, so the PENDING scan above will
  // never revisit it. Once a webhook exists, sweep them — oldest first, under the
  // same one-message-per-run cap, so recovery can never burst a backlog into the
  // channel. Nothing here regenerates or re-dates content: it delivers exactly the
  // persisted draft text, and makes no provider call.
  //
  // Two rules govern this sweep, both added after the 2026-08-05 flood:
  //
  // 1. LIVE OUTRANKS BACKLOG. If the PENDING pass above delivered something this
  //    run, recovery yields. The channel budget is 2 posts / 10 min and the job
  //    runs every 3 minutes, so a recovery message competing with live content
  //    does not merely arrive alongside it — it can consume the budget the live
  //    message needs.
  // 2. HISTORICAL DRAFTS DO NOT SPEND A SLOT. Rerouting an old event to the
  //    digest is a database write, not a Discord post, so the sweep keeps
  //    scanning until it either delivers one message or exhausts its examine
  //    budget. Otherwise 148 historical events would take 148 scans just to be
  //    reclassified, which is the same drip in slower clothing.
  if (webhookOk) {
    const liveDeliveredThisRun = out.delivered > 0;
    if (!liveDeliveredThisRun) {
      const examineBudget = Math.max(cap, Math.min(deps.maxDeferredExaminedPerScan ?? 50, 200));
      let sentOne = false;
      for (const eventId of deferredDraftEventIds(db, examineBudget)) {
        if (sentOne) break;
        if (handledThisRun.has(eventId)) continue;
        try {
          const pending = unsentDrafts(db, eventId);
          if (!pending.length) continue;
          const meta = deferredEventMeta(db, eventId);
          const res = await deliverDrafts(db, send, pending, { ...meta, nowMs: now(), env, eventId });
          if (res.ok) { out.deferredDelivered += 1; sentOne = true; }
          else if (res.suppressed) {
            out.skipped += 1;
            // A lane/dedup reroute costs no Discord post, so keep looking. A
            // transport-level suppression (rate limit, in-flight) means the
            // channel refused us and the sweep must stop.
            if (!res.reroutedWithoutPosting) sentOne = true;
          } else { out.failed += 1; sentOne = true; }
        } catch { out.failed += 1; sentOne = true; }
      }
    }
  }
  return out;
}

/** Header facts for a deferred bundle, read from persisted rows only. */
function deferredEventMeta(db: RtDb, eventId: string): {
  category: string; symbol: string; resultType: string; sessionDate: string;
  expiration: string | null; eventOccurredAtMs: number | null; caseId: string | null;
} {
  const fallback = {
    category: "CONTENT", symbol: "", resultType: "UNKNOWN", sessionDate: "",
    expiration: null, eventOccurredAtMs: null, caseId: null,
  };
  try {
    const r = db.prepare(
      `SELECT d.category AS category, d.result_type AS result_type,
              d.trading_session_date AS session_date, e.symbol AS symbol,
              e.expiration AS expiration, e.occurred_at_ms AS occurred_at_ms,
              d.opportunity_case_id AS case_id
         FROM content_drafts d
         LEFT JOIN opportunity_content_events e ON e.id = d.content_event_id
        WHERE d.content_event_id=? ORDER BY d.created_at_ms ASC LIMIT 1`,
    ).get(eventId) as Record<string, unknown> | undefined;
    if (!r) return fallback;
    return {
      category: r.category == null ? fallback.category : String(r.category),
      symbol: r.symbol == null ? fallback.symbol : String(r.symbol),
      resultType: r.result_type == null ? fallback.resultType : String(r.result_type),
      sessionDate: r.session_date == null ? fallback.sessionDate : String(r.session_date),
      expiration: r.expiration == null ? null : String(r.expiration),
      eventOccurredAtMs: r.occurred_at_ms == null ? null : Number(r.occurred_at_ms),
      caseId: r.case_id == null ? null : String(r.case_id),
    };
  } catch { return fallback; }
}

/** Write one terminal, non-retryable outcome across a set of drafts. Never throws. */
function markDrafts(
  db: RtDb,
  draftIds: string[],
  code: Parameters<typeof describeReason>[0],
  detail: string,
  nowMs: number,
): void {
  const reason = describeReason(code);
  for (const id of draftIds) {
    try {
      db.prepare(
        `UPDATE content_drafts
           SET discord_delivery_status=?, updated_at_ms=?,
               discord_delivery_reason=?, discord_delivery_explanation=?,
               discord_delivery_retryable=?, discord_delivery_detail=?,
               discord_last_attempt_at_ms=?
         WHERE id=?`,
      ).run(
        reason.status, nowMs, reason.code, reason.explanation,
        reason.retryable ? 1 : 0, detail, nowMs, id,
      );
    } catch {
      // A pre-migration database lacks the reason columns. Preserve the status
      // so the draft still leaves the retry pool rather than looping forever.
      try {
        db.prepare(`UPDATE content_drafts SET discord_delivery_status=?, updated_at_ms=? WHERE id=?`)
          .run(reason.status, nowMs, id);
      } catch { /* isolated */ }
    }
  }
}

/**
 * Has this canonical outcome already been reported to Discord?
 *
 * Keyed on the opportunity case, NOT the content event, because one closure
 * emits up to three events — `EXIT_HIT` and `OPPORTUNITY_CLOSED` both produce
 * CLOSED_*, and `OPPORTUNITY_REPORT_CARD_READY` adds WHY_THIS_*. Matching on the
 * event id is what let one closure send three messages.
 *
 * Returns false (report it) whenever the question cannot be answered, so a read
 * failure delays nothing; the dedup guard is an optimisation for the owner's
 * attention, never a gate on truthful content.
 */
function outcomeAlreadyReported(db: RtDb, caseId: string | null, excludeEventId: string): boolean {
  if (!caseId) return false;
  try {
    const cats = [...OUTCOME_REPORT_CATEGORIES].map((c) => `'${c}'`).join(",");
    const row = db.prepare(
      `SELECT 1 AS hit FROM content_drafts
        WHERE opportunity_case_id=? AND content_event_id<>?
          AND category IN (${cats}) AND discord_delivery_status='SENT'
        LIMIT 1`,
    ).get(caseId, excludeEventId) as { hit?: number } | undefined;
    return Boolean(row?.hit);
  } catch {
    return false;
  }
}

/**
 * Floor for interrupting the owner in Discord.
 *
 * Deliberately ABOVE the queue threshold. The queue is somewhere you look when
 * you choose to; Discord is an interruption. A candidate can be worth reviewing
 * without being worth a notification, and conflating the two is how a review
 * queue becomes a firehose.
 */
export function discordNoticeFloor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CONTENT_DISCORD_MIN_WORTHINESS);
  if (!Number.isFinite(raw)) return 0.7;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Null means the row predates the worthiness filter and was never scored.
 * Unknown must not silently mean "below the bar" — those rows deliver as before.
 */
function draftWorthiness(db: RtDb, id: string): number | null {
  try {
    const r = db.prepare("SELECT content_worthiness AS w FROM content_drafts WHERE id=?").get(id) as any;
    const w = Number(r?.w);
    return Number.isFinite(w) ? w : null;
  } catch {
    return null;
  }
}

/** Backend category constants are not language. */
export function humanCategory(category: string): string {
  const map: Record<string, string> = {
    CLOSED_WINNER: "closed winner",
    CLOSED_LOSER: "closed loser",
    WHY_THIS_WORKED: "post-mortem — what worked",
    WHY_THIS_FAILED: "post-mortem — what failed",
    RETURN_MILESTONE: "milestone reached",
    NEW_HIGH: "new high",
    JUST_ENTERED_RADAR: "new on the radar",
    HIGH_CONVICTION: "high conviction",
    CONVICTION_INCREASED: "conviction update",
    THESIS_WEAKENED: "thesis weakened",
    NEXT_SESSION_WATCH: "next-session watch",
    EDUCATIONAL_BREAKDOWN: "breakdown",
    MARKET_OBSERVATION: "market observation",
    MISSED_OPPORTUNITY: "missed-opportunity post-mortem",
  };
  return map[category] ?? category.toLowerCase().replace(/_/g, " ");
}

/** Render and send one bundle, then record the outcome on each draft. Never throws. */
async function deliverDrafts(
  db: RtDb,
  send: (content: string) => Promise<ContentDeliverResult>,
  pending: Array<{ id: string; draft_text: string; cta_type: string; char_count: number }>,
  meta: {
    category: string; symbol: string; resultType: string; sessionDate: string; nowMs: number;
    expiration: string | null; eventOccurredAtMs: number | null; env: NodeJS.ProcessEnv;
    eventId?: string; caseId?: string | null;
  },
): Promise<ContentDeliverResult> {
  const ids = pending.map((d) => d.id);
  const policy = classifyContentDeliveryPolicy(meta);
  if (policy.policy === "ARCHIVE_STALE_RESEARCH") {
    markDrafts(db, ids, "SUPPRESSED_STALE_RESEARCH", policy.reason, meta.nowMs);
    return { ok: false, messageId: null, error: policy.reason, suppressed: true, reroutedWithoutPosting: true };
  }

  // ── lane: may this be an individual Discord message at all? ─────────────
  // Old content is not rejected, it is rerouted. The digest builder selects on
  // these reason codes, so nothing becomes unreachable.
  const lane = classifyDeliveryLane({
    eventOccurredAtMs: meta.eventOccurredAtMs, nowMs: meta.nowMs, env: meta.env,
  });
  if (!lane.individualDeliveryAllowed) {
    markDrafts(
      db, ids,
      lane.lane === "ARCHIVE_ONLY" ? "ARCHIVED_IN_APP_ONLY" : "HELD_FOR_HISTORICAL_DIGEST",
      lane.reason, meta.nowMs,
    );
    return { ok: false, messageId: null, error: lane.reason, suppressed: true, reroutedWithoutPosting: true };
  }

  // ── one canonical outcome, one owner interrupt ──────────────────────────
  if (isOutcomeReportCategory(meta.category)
      && outcomeAlreadyReported(db, meta.caseId ?? null, meta.eventId ?? "")) {
    const detail = "another content event already delivered a report card for this closed outcome";
    markDrafts(db, ids, "SUPPRESSED_DUPLICATE_OUTCOME", detail, meta.nowMs);
    return { ok: false, messageId: null, error: detail, suppressed: true, reroutedWithoutPosting: true };
  }

  // ── one recommended variant to Discord; alternates stay in the app ──────
  // `unsentDrafts` orders by created_at_ms ASC, so the first row is template
  // family _0 — the recommended phrasing. Sending all three made one closure
  // occupy three code blocks of the owner's channel for no added information.
  const [recommended, ...alternates] = pending;
  if (!recommended) return { ok: false, messageId: null, error: "no pending drafts", suppressed: true, reroutedWithoutPosting: true };

  // ── the notice, not the draft ────────────────────────────────────
  //
  // Discord used to carry the copy itself, so every accepted idea became a code
  // block in a channel — and with nothing filtering ideas, a wall of them. The
  // PRIVATE APP is the content inbox; Discord's only job is to say the inbox has
  // something worth opening. A notice cannot be skimmed instead of reviewed,
  // cannot be posted by accident, and cannot go stale in a channel.
  const worthiness = draftWorthiness(db, recommended.id);
  if (worthiness != null && worthiness < discordNoticeFloor(meta.env)) {
    markDrafts(
      db, ids, "VARIANT_HELD_IN_APP",
      `in the review queue, below the Discord notice bar (${worthiness.toFixed(2)})`,
      meta.nowMs,
    );
    return {
      ok: false, messageId: null,
      error: "below the Discord notice bar; queued in the app",
      suppressed: true, reroutedWithoutPosting: true,
    };
  }
  const header = `📝 **1 content idea ready for review — OWNER ONLY** — ${meta.symbol} · ${humanCategory(meta.category)}`;
  const draftBlocks = [[
    worthiness != null
      ? `_Worthiness ${worthiness.toFixed(2)} · session ${meta.sessionDate}_`
      : `_Session ${meta.sessionDate}_`,
    alternates.length
      ? `_${1 + alternates.length} phrasings waiting in the private app._`
      : "_Waiting in the private app._",
    "_Never auto-posted. Open OptiScan to review, edit and post it yourself._",
  ].filter(Boolean).join("\n")];
  const deliveryLabel = policy.policy === "DELIVER_HISTORICAL_REPORT_CARD"
    ? "**HISTORICAL REPORT CARD - NON-ACTIONABLE**\n_Option results below are frozen historical evidence, not a current entry or current quote._"
    : policy.policy === "DELIVER_NEXT_SESSION_WATCH"
      ? "**NEXT-SESSION WATCH - NON-ACTIONABLE**\n_The options market is closed. Nothing below is a live entry and no quote below is current._"
      : null;
  const body = [deliveryLabel, header, ...draftBlocks].filter(Boolean).join("\n\n").slice(0, 1900);
  let res: ContentDeliverResult;
  try {
    res = await send(body);
  } catch (e: any) {
    res = { ok: false, messageId: null, error: String(e?.message ?? e).slice(0, 300) };
  }
  // The status is derived from the REASON's retryability, never from the bare
  // `suppressed` boolean. Three of the guard's six suppression verdicts are
  // transient, and writing SUPPRESSED for those dropped the draft out of
  // RETRYABLE_DELIVERY_STATES permanently. See lib/content/delivery-reason.ts.
  const reason = classifyDeliveryResult(res);
  // Only the delivered draft carries the delivery outcome. On a TRANSIENT
  // refusal every draft must stay retryable together, or the next sweep would
  // send the recommended one while its alternates were already parked; so the
  // alternates are retired only once the recommended one is genuinely SENT.
  if (reason.code === "SENT") {
    markDrafts(
      db, alternates.map((d) => d.id), "VARIANT_HELD_IN_APP",
      `alternate phrasing of delivered draft ${recommended.id}`, meta.nowMs,
    );
  }
  const recordFor = reason.code === "SENT" ? [recommended] : pending;
  for (const draft of recordFor) {
    try {
      db.prepare(
        `UPDATE content_drafts
         SET discord_delivery_status=?, discord_message_id=?, updated_at_ms=?,
             discord_delivery_reason=?, discord_delivery_explanation=?,
             discord_delivery_retryable=?, discord_delivery_detail=?,
             discord_last_attempt_at_ms=?,
             discord_attempt_count=COALESCE(discord_attempt_count,0)+1
         WHERE id=?`,
      ).run(
        reason.status,
        res.messageId,
        meta.nowMs,
        reason.code,
        reason.explanation,
        reason.retryable ? 1 : 0,
        redactForPersistence(res.error),
        meta.nowMs,
        draft.id,
      );
    } catch {
      // A pre-migration database lacks the reason columns. Preserve the original
      // write rather than losing the outcome entirely.
      try {
        db.prepare(
          `UPDATE content_drafts SET discord_delivery_status=?, discord_message_id=?, updated_at_ms=? WHERE id=?`,
        ).run(reason.status, res.messageId, meta.nowMs, draft.id);
      } catch { /* isolated */ }
    }
  }
  return res;
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
    SELECT d.*, e.symbol AS symbol, e.event_type AS event_type, e.occurred_at_ms AS occurred_at_ms${eventContractSelect(db)}
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
      `SELECT d.*, e.symbol AS symbol, e.event_type AS event_type, e.occurred_at_ms AS occurred_at_ms${eventContractSelect(db)},
              e.payload_json AS event_payload_json
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

  const bundle = bundleForEventRow(db, event, deps, env, claim.ok, {
    checked: isPerformanceCategory(String(existing.category)),
    maxReturnPct: claim.verifiedMaxReturnPct ?? null,
  });
  if (!bundle) return null;

  // Prefer a template family different from the current one
  const currentFamily = String(existing.template_family ?? "");
  const alt = bundle.drafts.find((d) => d.templateFamily !== currentFamily) ?? bundle.drafts[0];
  if (!alt) return null;

  const single = { ...bundle, drafts: [alt] };
  // Owner-requested: worthiness and duplication are already answered by the
  // fact that a person pressed the button. Coherence is not — a regenerated
  // angle that contradicts the position is still refused.
  const gate = gateContentBundle(db, {
    symbol: bundle.symbol,
    category: String(existing.category),
    optionType: event.option_type != null ? String(event.option_type) : null,
    direction: event.direction != null ? String(event.direction) : null,
    sessionDate: existing.trading_session_date != null
      ? String(existing.trading_session_date)
      : tradingDay(nowMs),
    thesisParts: [firstOf(event.original_thesis_json), firstOf(event.evidence_summary_json)],
    milestone: event.milestone_percent != null ? Number(event.milestone_percent) : null,
    evidenceState: claim.resultType,
    claimVerified: claim.ok,
    ownerRequested: true,
    fingerprintSalt: alt.templateFamily,
    drafts: [{ text: alt.text, templateFamily: alt.templateFamily }],
  }, env);
  if (!gate.admitted.length) return null;
  persistDraftRows(db, event, single, {
    gate: { ...gate, admitted: gate.admitted.map((a) => ({ ...a, index: 0 })) },
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
