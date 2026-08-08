/**
 * lib/research/options/daily-summary.ts — AUTOMATIC private daily summary for the options scanner.
 * Built from the DB (candidates / alerts / paper trades / heartbeat) and delivered ONCE per day to a
 * private recap webhook. It is idempotent per day (deduped via
 * the options_runtime 'last_summary_day' key) and carries the PAPER/BETA label.
 *
 * HARD RULE: do NOT send a summary when the system was disabled for the day (flag off AND no activity).
 * HARD no-op unless INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1. Nothing here is a real-money action.
 */
import { researchFlags } from "../flags.ts";
import { BETA_LABEL } from "./delivery.ts";
import { readRuntimeKeyOnDb, writeRuntimeKeyOnDb } from "./runtime.ts";

interface SumDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }
const has = (db: SumDb, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));

/** Columns actually present on a table — the recap must query the schema that exists. */
function columnsOf(db: SumDb, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => String(c.name)));
  } catch {
    return new Set<string>();
  }
}

export interface DailySummary {
  day: string; symbolsScanned: number; candidatesFound: number;
  callsEvaluated: number; putsEvaluated: number;
  calloutsSent: number; calloutsFailed: number; tooLate: number; rejected: number; rejectionReasons: Record<string, number>;
  paperOpened: number; paperClosed: number; wins: number; losses: number; openPositions: number;
  /**
   * OWNER PRIVATE VALIDATION — a separate audience from subscriber callouts and never blended
   * into them. Owner openings are delivered via owner_research_notify and land in
   * discord_deliveries + OWNER_VALIDATION_PAPER; they never write an options_alerts row, so
   * every subscriber-population count above is structurally blind to them. On 2026-08-07 that
   * blindness printed "Callouts: sent 0" on a day with three delivered owner openings.
   */
  owner: {
    sent: number; failed: number;
    /**
     * null means the split could not be derived from persisted rows — NOT that zero
     * calls were sent. A recap that prints 0 for an unknown is the failure this whole
     * block exists to stop making.
     */
    calls: number | null; puts: number | null;
    mirrored: number; open: number; closed: number; wins: number; losses: number;
  };
  earliness: { early: number; during: number; late: number };
  providerFailures: number; monitorHealthy: boolean; note: string;
}

/** ET calendar day (YYYY-MM-DD) for a timestamp — the summary window is one ET trading day. */
export function etDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
}
function dayRangeMs(day: string): { start: number; end: number } {
  // ET midnight → next midnight, approximated at UTC-4/-5; use 04:00Z..+24h which covers the ET day.
  const start = Date.parse(`${day}T04:00:00Z`);
  return { start, end: start + 24 * 3_600_000 };
}

/**
 * Build the day's summary from the DB. Returns null when the system was disabled for the day (flag off
 * AND zero activity) — the caller then sends nothing, per the hard rule.
 */
export function buildDailySummaryOnDb(db: SumDb, nowMs: number, env: NodeJS.ProcessEnv = process.env): DailySummary | null {
  const day = etDay(nowMs);
  const { start, end } = dayRangeMs(day);
  const enabled = researchFlags(env).independentOptionsDiscovery;
  const n = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any)?.n ?? 0);

  const candTable = has(db, "options_candidates");
  const paperTable = has(db, "options_paper_trades");
  const alertTable = has(db, "options_alerts");

  const candidatesFound = candTable ? n("SELECT COUNT(*) n FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<? AND selected_strategy IS NOT NULL", start, end) : 0;
  const symbolsScanned = candTable ? n("SELECT COUNT(DISTINCT symbol) n FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<?", start, end) : 0;
  const callsEvaluated = candTable ? n("SELECT COUNT(*) n FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<? AND side='call'", start, end) : 0;
  const putsEvaluated = candTable ? n("SELECT COUNT(*) n FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<? AND side='put'", start, end) : 0;

  const rejectionReasons: Record<string, number> = {};
  if (candTable) for (const r of db.prepare("SELECT why, COUNT(*) c FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<? AND state='REJECTED' AND why IS NOT NULL GROUP BY why ORDER BY c DESC LIMIT 8").all(start, end) as any[]) rejectionReasons[String(r.why).slice(0, 60)] = r.c;

  const calloutsSent = alertTable ? n("SELECT COUNT(*) n FROM options_alerts WHERE created_at_ms>=? AND created_at_ms<? AND state='SENT'", start, end) : 0;
  const calloutsFailed = alertTable ? n("SELECT COUNT(*) n FROM options_alerts WHERE created_at_ms>=? AND created_at_ms<? AND state='SEND_FAILED'", start, end) : 0;
  const tooLate = alertTable ? n("SELECT COUNT(*) n FROM options_alerts WHERE created_at_ms>=? AND created_at_ms<? AND state='TOO_LATE'", start, end) : 0;
  const rejected = alertTable ? n("SELECT COUNT(*) n FROM options_alerts WHERE created_at_ms>=? AND created_at_ms<? AND state='REJECTED'", start, end) : 0;

  // OWNER PRIVATE VALIDATION — counted from its own tables, never from options_alerts.
  const deliveryTable = has(db, "discord_deliveries");
  const ownerWhereOn = (q: string) =>
    `${q}payload_type='owner_intraday_actionable' AND ${q}lifecycle_state='OPENING' AND ${q}created_at>=? AND ${q}created_at<?`;
  const ownerWhere = ownerWhereOn("");
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const ownerSent = deliveryTable ? n(`SELECT COUNT(*) n FROM discord_deliveries WHERE ${ownerWhere} AND status='SENT'`, startIso, endIso) : 0;
  const ownerFailed = deliveryTable ? n(`SELECT COUNT(*) n FROM discord_deliveries WHERE ${ownerWhere} AND status='FAILED'`, startIso, endIso) : 0;

  // The call/put split has to come from a column that exists. discord_deliveries has
  // never had `option_side` — createDiscordDelivery does not write one — so asking for
  // it threw "no such column" and took the WHOLE recap down with it, not just this
  // split. The side lives on the opportunity case the delivery already references.
  const ownerSideSplit = ((): { calls: number | null; puts: number | null } => {
    if (!deliveryTable || !has(db, "opportunity_cases")) return { calls: null, puts: null };
    const dd = columnsOf(db, "discord_deliveries");
    if (!dd.has("opportunity_case_id")) return { calls: null, puts: null };
    try {
      const rows = db.prepare(
        `SELECT LOWER(COALESCE(
                  json_extract(oc.case_json, '$.selectedContract.side'),
                  CASE json_extract(oc.case_json, '$.direction')
                    WHEN 'bullish' THEN 'call' WHEN 'bearish' THEN 'put' ELSE NULL END
                )) AS side,
                COUNT(*) AS c
           FROM discord_deliveries dd
           JOIN opportunity_cases oc ON oc.opportunity_id = dd.opportunity_case_id
          WHERE ${ownerWhereOn("dd.")} AND dd.status='SENT'
          GROUP BY side`,
      ).all(startIso, endIso) as { side: string | null; c: number }[];
      let calls = 0;
      let puts = 0;
      for (const r of rows) {
        if (r.side === "call") calls += Number(r.c);
        else if (r.side === "put") puts += Number(r.c);
      }
      return { calls, puts };
    } catch {
      // Unknown, not zero.
      return { calls: null, puts: null };
    }
  })();
  const ownerCalls = ownerSideSplit.calls;
  const ownerPuts = ownerSideSplit.puts;

  const O = "paper_kind='OWNER_VALIDATION_PAPER'";
  const ownerMirrored = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${O} AND entered_at_ms>=? AND entered_at_ms<?`, start, end) : 0;
  const ownerOpen = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${O} AND status='ENTERED'`) : 0;
  const ownerClosed = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${O} AND exit_at_ms>=? AND exit_at_ms<? AND status='EXITED'`, start, end) : 0;
  const ownerWins = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${O} AND exit_at_ms>=? AND exit_at_ms<? AND status='EXITED' AND return_pct>0`, start, end) : 0;
  const ownerLosses = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${O} AND exit_at_ms>=? AND exit_at_ms<? AND status='EXITED' AND return_pct<=0`, start, end) : 0;

  // SUBSCRIBER-facing paper stats use ONLY DELIVERED_ALERT_PAPER — research trades never blend in.
  const D = "paper_kind='DELIVERED_ALERT_PAPER'";
  const paperOpened = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${D} AND entered_at_ms>=? AND entered_at_ms<?`, start, end) : 0;
  const paperClosed = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${D} AND exit_at_ms>=? AND exit_at_ms<? AND status='EXITED'`, start, end) : 0;
  const wins = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${D} AND exit_at_ms>=? AND exit_at_ms<? AND status='EXITED' AND return_pct>0`, start, end) : 0;
  const losses = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${D} AND exit_at_ms>=? AND exit_at_ms<? AND status='EXITED' AND return_pct<=0`, start, end) : 0;
  const openPositions = paperTable ? n(`SELECT COUNT(*) n FROM options_paper_trades WHERE ${D} AND status='ENTERED'`) : 0;

  const earliness = { early: 0, during: 0, late: 0 };
  if (candTable) for (const r of db.prepare("SELECT earliness_phase p, COUNT(*) c FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<? AND earliness_phase IS NOT NULL GROUP BY earliness_phase").all(start, end) as any[]) { if (r.p === "early" || r.p === "during" || r.p === "late") (earliness as any)[r.p] = r.c; }

  const hb = readRuntimeKeyOnDb(db, "heartbeat");
  const monitorHealthy = Boolean(hb?.updatedAtMs != null && nowMs - hb.updatedAtMs < 24 * 3_600_000 && (hb.value?.running));
  const providerFailures = Number(hb?.value?.providerFailures ?? 0);

  // Owner activity is real activity: a day with owner openings is never "did nothing".
  const anyActivity = candidatesFound + symbolsScanned + paperOpened + paperClosed + calloutsSent + ownerSent > 0;
  if (!enabled && !anyActivity) return null; // system was disabled and did nothing → no summary

  return {
    day, symbolsScanned, candidatesFound, callsEvaluated, putsEvaluated,
    calloutsSent, calloutsFailed, tooLate, rejected, rejectionReasons,
    paperOpened, paperClosed, wins, losses, openPositions, earliness,
    owner: {
      sent: ownerSent, failed: ownerFailed, calls: ownerCalls, puts: ownerPuts,
      mirrored: ownerMirrored, open: ownerOpen, closed: ownerClosed,
      wins: ownerWins, losses: ownerLosses,
    },
    providerFailures, monitorHealthy,
    note: enabled ? "Options scanner ran (paper/research only)." : "Scanner flag was off but prior activity existed.",
  };
}

/** Concise Discord message. Puts are shown as EVALUATED only (research-only; not actionable). */
export function formatDailySummaryMessage(s: DailySummary): string {
  const rej = Object.entries(s.rejectionReasons).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(", ") || "none";
  return [
    `📊 **DAILY RECAP — OptiScan Options ${s.day}**`,
    `Scanned ${s.symbolsScanned} sym's · candidates ${s.candidatesFound} · calls ${s.callsEvaluated}/puts ${s.putsEvaluated} evaluated`,
    `SUBSCRIBER callouts: sent ${s.calloutsSent}, failed ${s.calloutsFailed}, too-late ${s.tooLate}, rejected ${s.rejected}`,
    `SUBSCRIBER paper (delivered mirrors): opened ${s.paperOpened}, closed ${s.paperClosed} (W ${s.wins} / L ${s.losses}), open now ${s.openPositions}`,
    `OWNER validation: sent ${s.owner.sent} (${s.owner.calls ?? "?"} CALL / ${s.owner.puts ?? "?"} PUT`
      + `${s.owner.calls == null ? " — split unavailable, not zero" : ""}), failed ${s.owner.failed}`,
    `OWNER paper (exact mirrors): ${s.owner.mirrored} of ${s.owner.sent} mirrored, closed ${s.owner.closed} (W ${s.owner.wins} / L ${s.owner.losses}), open now ${s.owner.open}`
      + (s.owner.sent > s.owner.mirrored ? ` ⚠️ ${s.owner.sent - s.owner.mirrored} owner opening(s) left NO paper evidence` : ""),
    `Earliness: early ${s.earliness.early} · during ${s.earliness.during} · late ${s.earliness.late}`,
    `Provider failures ${s.providerFailures} · monitor ${s.monitorHealthy ? "healthy ✅" : "degraded ⚠️"}`,
    `Top rejections: ${rej}`,
    BETA_LABEL,
  ].join("\n");
}

export interface SummaryDeps { getDb: () => any; send?: (content: string) => Promise<{ ok: boolean; error: string | null }>; now?: () => number }

async function defaultSend(content: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { discordWebhookConfigured, postToDiscord } = require("@/lib/notifications");
    if (!discordWebhookConfigured("recap")) return { ok: false, error: "DISCORD_WEBHOOK_RECAP not configured" };
    const sent = await postToDiscord(
      { content },
      {
        webhook: "recap",
        skipPublicCheck: true,
        audience: "subscriber",
        payloadType: "options_daily_summary",
        idempotencyKey: `options_daily_summary:${content.slice(0, 80)}`,
      },
    );
    if (sent.suppressed) return { ok: false, error: `recap suppressed: ${sent.suppressionReason}` };
    return { ok: true, error: null };
  } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/**
 * Send the daily summary at most once per ET day. Idempotent via the 'last_summary_day' runtime key —
 * safe to call every grader tick. Sends nothing when disabled+idle. HARD no-op unless the scanner flag
 * is on. A send failure is recorded (day NOT marked) so it can retry, but never throws.
 */
export async function maybeSendDailySummary(deps: SummaryDeps, env: NodeJS.ProcessEnv = process.env): Promise<{ sent: boolean; skipped: boolean; reason: string }> {
  if (!researchFlags(env).independentOptionsDiscovery) return { sent: false, skipped: true, reason: "disabled" };
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const day = etDay(nowMs);
  // Only after a configurable send hour (ET), so the summary covers a full day. Default 16:10 ET (post-close).
  const hourEt = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(nowMs)));
  const sendAfterHour = Number.isFinite(Number(env.OPTIONS_SUMMARY_HOUR_ET)) ? Number(env.OPTIONS_SUMMARY_HOUR_ET) : 16;
  if (hourEt < sendAfterHour) return { sent: false, skipped: true, reason: "before_summary_hour" };
  let db: any;
  try { db = deps.getDb(); } catch { return { sent: false, skipped: true, reason: "no_db" }; }
  const last = readRuntimeKeyOnDb(db, "last_summary_day");
  if (last?.value === day) return { sent: false, skipped: true, reason: "already_sent_today" };

  const summary = buildDailySummaryOnDb(db, nowMs, env);
  if (!summary) { writeRuntimeKeyOnDb(db, "last_summary_day", day, nowMs); return { sent: false, skipped: true, reason: "system_disabled_no_activity" }; }
  const send = deps.send ?? defaultSend;
  const res = await send(formatDailySummaryMessage(summary));
  if (res.ok) { writeRuntimeKeyOnDb(db, "last_summary_day", day, nowMs); return { sent: true, skipped: false, reason: "sent" }; }
  if (/recap suppressed/i.test(String(res.error ?? ""))) {
    writeRuntimeKeyOnDb(db, "last_summary_day", day, nowMs);
    return { sent: false, skipped: true, reason: String(res.error) };
  }
  return { sent: false, skipped: false, reason: `send_failed: ${res.error}` }; // day not marked → retries next tick
}
