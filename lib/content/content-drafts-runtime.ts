/**
 * lib/content/content-drafts-runtime.ts — consume PENDING opportunity_content_events, generate
 * deterministic template drafts, and deliver them to a PRIVATE Discord channel for manual review.
 * NEVER auto-posts to Twitter/X. Idempotent: only content_status='PENDING' rows are scanned, and a
 * delivered row is flipped to 'DRAFTED' with its bundle persisted, so a restart never re-delivers.
 * HARD no-op unless CONTENT_EVENTS_ENABLED=1 and a webhook is configured. Failures never throw into
 * the lifecycle/grader that emit the events.
 */
import {
  buildDraftBundle,
  eligibleCategories,
  eligibilityThresholds,
  type ContentDraftBundle,
  type ContentVars,
} from "./content-event-engine.ts";

interface RtDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
}

export interface ContentDeliverResult { ok: boolean; messageId: string | null; error: string | null }
export interface ContentDraftsDeps {
  /** Post to the private content channel. Defaults to postToDiscord(webhook:"content"). */
  send?: (content: string) => Promise<ContentDeliverResult>;
  webhookConfigured?: () => boolean;
  /** Enrich vars from the Opportunity Case JSON (relVol/flow/sector/catalyst/levels). Defaults to a
   *  best-effort reader; injectable for tests. */
  loadCaseVars?: (db: RtDb, opportunityCaseId: string) => Partial<ContentVars>;
  now?: () => number;
  maxPerScan?: number;
}

function hasTable(db: RtDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

export function contentEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTENT_EVENTS_ENABLED === "1";
}

function defaultWebhookConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(String(env.DISCORD_WEBHOOK_CONTENT ?? env.DISCORD_WEBHOOK_RECAP ?? "").trim());
}

function defaultSend(): (content: string) => Promise<ContentDeliverResult> {
  return async (content: string) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { postToDiscord } = require("@/lib/notifications");
      const r = await postToDiscord({ content }, { webhook: "content", skipPublicCheck: true });
      return { ok: true, messageId: r.messageId ?? null, error: null };
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

/** Best-effort enrichment from the Opportunity Case JSON (never throws). */
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

/** Build the ContentVars for a persisted content-event row (+ optional case enrichment). */
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

/** Deterministically build the draft bundle for one content-event row (no delivery). */
export function bundleForEventRow(
  db: RtDb,
  row: Record<string, unknown>,
  deps: ContentDraftsDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): ContentDraftBundle | null {
  const loadCaseVars = deps.loadCaseVars ?? defaultLoadCaseVars;
  const caseVars = row.opportunity_case_id ? loadCaseVars(db, String(row.opportunity_case_id)) : {};
  const vars = varsForEventRow(row, caseVars);
  const cats = eligibleCategories(String(row.event_type), vars, eligibilityThresholds(env));
  if (!cats.length) return null;
  return buildDraftBundle(cats[0], vars);
}

/** Format a bundle as one or more Discord messages (chunked under the 2000-char limit). */
export function formatBundleForDiscord(bundle: ContentDraftBundle): string[] {
  const header = `📝 **CONTENT DRAFTS — ${bundle.category}** · ${bundle.symbol}\n_Deterministic template drafts for MANUAL review. Never auto-posted. Not financial advice._`;
  const blocks = bundle.drafts.map((d, i) => [
    `**Draft ${i + 1}** (${d.charCount} chars)`,
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

export interface ContentScanResult { examined: number; delivered: number; skipped: number; failed: number }

/**
 * Scan PENDING content events, deliver deterministic draft bundles to the private channel, and mark
 * them DRAFTED. Idempotent + isolated. HARD no-op unless enabled + webhook configured.
 */
export async function runContentDraftsScan(
  db: RtDb,
  deps: ContentDraftsDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContentScanResult> {
  const out: ContentScanResult = { examined: 0, delivered: 0, skipped: 0, failed: 0 };
  if (!contentEventsEnabled(env)) return out;
  if (!hasTable(db, "opportunity_content_events")) return out;
  const webhookConfigured = deps.webhookConfigured ?? (() => defaultWebhookConfigured(env));
  if (!webhookConfigured()) return out;
  const send = deps.send ?? defaultSend();
  const now = deps.now ?? Date.now;
  const cap = deps.maxPerScan ?? 20;

  let rows: Record<string, unknown>[] = [];
  try {
    rows = db.prepare(
      "SELECT * FROM opportunity_content_events WHERE content_status='PENDING' ORDER BY occurred_at_ms ASC LIMIT ?",
    ).all(cap) as Record<string, unknown>[];
  } catch { return out; }

  for (const row of rows) {
    out.examined += 1;
    let bundle: ContentDraftBundle | null = null;
    try { bundle = bundleForEventRow(db, row, deps, env); } catch { bundle = null; }
    if (!bundle) { out.skipped += 1; continue; }

    const messages = formatBundleForDiscord(bundle);
    let ok = true;
    let lastMessageId: string | null = null;
    let lastError: string | null = null;
    for (const msg of messages) {
      const res = await send(msg);
      if (!res.ok) { ok = false; lastError = res.error; break; }
      lastMessageId = res.messageId;
    }
    if (!ok) { out.failed += 1; continue; } // leave PENDING → retried next scan

    // Mark DRAFTED + persist the bundle (idempotent: no longer PENDING, never re-delivered).
    try {
      const existing = db.prepare("SELECT payload_json FROM opportunity_content_events WHERE id=?").get(String(row.id)) as { payload_json?: string } | undefined;
      let payload: Record<string, unknown> = {};
      try { payload = existing?.payload_json ? JSON.parse(existing.payload_json) : {}; } catch { payload = {}; }
      payload.contentBundle = bundle;
      payload.contentDeliveredAtMs = now();
      payload.contentDiscordMessageId = lastMessageId;
      db.prepare("UPDATE opportunity_content_events SET content_status='DRAFTED', payload_json=? WHERE id=? AND content_status='PENDING'")
        .run(JSON.stringify(payload), String(row.id));
      out.delivered += 1;
    } catch {
      out.failed += 1;
    }
    void lastError;
  }
  return out;
}
