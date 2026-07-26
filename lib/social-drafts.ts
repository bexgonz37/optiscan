/**
 * Twitter/X draft pipeline — generate copy from verified content events. NEVER auto-posts.
 */
import { buildSubscriberClaimPacket } from "./research/options/subscriber-claims.ts";
import { formatPctForCopy, labelCurrentReturn, labelRealizedReturn } from "./research/options/return-vocabulary.ts";

export interface SocialDraftRow {
  id: string;
  opportunityCaseId: string;
  eventType: string;
  symbol: string;
  contentStatus: string;
  milestonePercent: number | null;
  frozenEntry: number | null;
  returnPercent: number | null;
  occurredAtMs: number;
  draftText: string | null;
  editedText: string | null;
  alertId: string | null;
}

interface DraftDb {
  prepare(sql: string): {
    get: (...args: any[]) => any;
    all: (...args: any[]) => any[];
    run: (...args: any[]) => { changes: number };
  };
}

export type SocialDraftDb = DraftDb;

const FORBIDDEN_ACTIONABLE_PHRASES = [
  /\benter now\b/i,
  /\bbuy now\b/i,
  /\bget in now\b/i,
  /\bact now\b/i,
  /\bjoin now\b/i,
];

/** Block live-action language in milestone/social copy — past tense + frozen entry only. */
export function validateSocialDraftLanguage(text: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const re of FORBIDDEN_ACTIONABLE_PHRASES) {
    if (re.test(text)) reasons.push(`forbidden actionable phrase: ${re.source}`);
  }
  return { ok: reasons.length === 0, reasons };
}

function hasTable(db: DraftDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export function buildMilestoneDraftText(input: {
  symbol: string;
  milestonePercent: number;
  frozenEntry: number;
  alertTimePt: string;
  subscribeUrl: string;
  unrealized: boolean;
}): string {
  const retLabel = input.unrealized ? "now up" : "closed at";
  return [
    `${input.symbol.toUpperCase()} calls are ${retLabel} ${input.milestonePercent}% from our frozen Discord entry.`,
    `This setup was first called out at ${input.alertTimePt} PT.`,
    `Join the private Discord: ${input.subscribeUrl}`,
    "Education only — not financial advice. Past results do not guarantee future performance.",
  ].join("\n");
}

export function generateDraftFromContentEvent(db: DraftDb, contentEventId: string, env: NodeJS.ProcessEnv = process.env): SocialDraftRow | null {
  if (!hasTable(db, "opportunity_content_events")) return null;
  const row = db.prepare(`SELECT * FROM opportunity_content_events WHERE id=?`).get(contentEventId) as Record<string, unknown> | undefined;
  if (!row) return null;

  let alertId: string | null = null;
  if (hasTable(db, "options_alerts")) {
    const a = db
      .prepare(`SELECT alert_id FROM options_alerts WHERE opportunity_case_id=? AND state='SENT' ORDER BY sent_at_ms DESC LIMIT 1`)
      .get(String(row.opportunity_case_id)) as { alert_id?: string } | undefined;
    alertId = a?.alert_id ?? null;
  }
  if (alertId) {
    const claim = buildSubscriberClaimPacket(db, alertId);
    if (!claim.ok) return null;
  }

  const subscribeUrl = String(env.PUBLIC_SUBSCRIBE_URL ?? env.PUBLIC_APP_URL ?? "[subscription link]");
  const occurred = new Date(Number(row.occurred_at_ms)).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
  const milestone = row.milestone_percent != null ? Number(row.milestone_percent) : null;
  const frozen = row.frozen_entry != null ? Number(row.frozen_entry) : null;
  const unrealized = String(row.event_type) === "RETURN_MILESTONE_REACHED";
  const draftText =
    milestone != null && frozen != null
      ? buildMilestoneDraftText({
          symbol: String(row.symbol),
          milestonePercent: milestone,
          frozenEntry: frozen,
          alertTimePt: occurred,
          subscribeUrl,
          unrealized,
        })
      : null;

  if (draftText) {
    const lang = validateSocialDraftLanguage(draftText);
    if (!lang.ok) return null;
  }

  const payload = row.payload_json ? JSON.parse(String(row.payload_json)) : {};
  if (draftText) payload.draftText = draftText;

  db.prepare(`UPDATE opportunity_content_events SET payload_json=?, content_status='DRAFTED' WHERE id=?`).run(
    JSON.stringify(payload),
    contentEventId,
  );

  return {
    id: String(row.id),
    opportunityCaseId: String(row.opportunity_case_id),
    eventType: String(row.event_type),
    symbol: String(row.symbol),
    contentStatus: "DRAFTED",
    milestonePercent: milestone,
    frozenEntry: frozen,
    returnPercent: row.return_percent != null ? Number(row.return_percent) : null,
    occurredAtMs: Number(row.occurred_at_ms),
    draftText,
    editedText: payload.editedText ?? null,
    alertId,
  };
}

export function listPendingSocialDrafts(db: DraftDb, limit = 40): SocialDraftRow[] {
  if (!hasTable(db, "opportunity_content_events")) return [];
  const rows = db
    .prepare(
      `SELECT * FROM opportunity_content_events
       WHERE content_status IN ('PENDING','DRAFTED','APPROVED')
       ORDER BY occurred_at_ms DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((row) => {
    let draftText: string | null = null;
    let editedText: string | null = null;
    try {
      const p = row.payload_json ? JSON.parse(String(row.payload_json)) : {};
      draftText = p.draftText ?? null;
      editedText = p.editedText ?? null;
    } catch { /* ignore */ }
    return {
      id: String(row.id),
      opportunityCaseId: String(row.opportunity_case_id),
      eventType: String(row.event_type),
      symbol: String(row.symbol),
      contentStatus: String(row.content_status),
      milestonePercent: row.milestone_percent != null ? Number(row.milestone_percent) : null,
      frozenEntry: row.frozen_entry != null ? Number(row.frozen_entry) : null,
      returnPercent: row.return_percent != null ? Number(row.return_percent) : null,
      occurredAtMs: Number(row.occurred_at_ms),
      draftText,
      editedText,
      alertId: null,
    };
  });
}

export function updateDraftStatus(db: DraftDb, id: string, status: "APPROVED" | "REJECTED" | "DRAFTED", editedText?: string | null): boolean {
  if (!hasTable(db, "opportunity_content_events")) return false;
  const row = db.prepare(`SELECT payload_json FROM opportunity_content_events WHERE id=?`).get(id) as { payload_json?: string } | undefined;
  if (!row) return false;
  let payload: Record<string, unknown> = {};
  try {
    payload = row.payload_json ? JSON.parse(String(row.payload_json)) : {};
  } catch { /* ignore */ }
  if (editedText != null) payload.editedText = editedText;
  db.prepare(`UPDATE opportunity_content_events SET content_status=?, payload_json=? WHERE id=?`).run(status, JSON.stringify(payload), id);
  return true;
}

export function draftCopyText(row: SocialDraftRow): string {
  return row.editedText ?? row.draftText ?? "";
}

export function formatDraftMetrics(row: SocialDraftRow): string {
  const current = labelCurrentReturn(row.returnPercent);
  return `${current.label}: ${formatPctForCopy(current.valuePct)} — ${current.disclaimer}`;
}
