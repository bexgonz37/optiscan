/**
 * lib/research/options/daily-summary.ts — AUTOMATIC private daily summary for the options scanner.
 * Built from the DB (candidates / alerts / paper trades / heartbeat) and delivered ONCE per day to a
 * private webhook (recap, falling back to the options webhook). It is idempotent per day (deduped via
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

export interface DailySummary {
  day: string; symbolsScanned: number; candidatesFound: number;
  callsEvaluated: number; putsEvaluated: number;
  calloutsSent: number; calloutsFailed: number; tooLate: number; rejected: number; rejectionReasons: Record<string, number>;
  paperOpened: number; paperClosed: number; wins: number; losses: number; openPositions: number;
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

  const paperOpened = paperTable ? n("SELECT COUNT(*) n FROM options_paper_trades WHERE entered_at_ms>=? AND entered_at_ms<?", start, end) : 0;
  const paperClosed = paperTable ? n("SELECT COUNT(*) n FROM options_paper_trades WHERE exit_at_ms>=? AND exit_at_ms<? AND status='EXITED'", start, end) : 0;
  const wins = paperTable ? n("SELECT COUNT(*) n FROM options_paper_trades WHERE exit_at_ms>=? AND exit_at_ms<? AND status='EXITED' AND return_pct>0", start, end) : 0;
  const losses = paperTable ? n("SELECT COUNT(*) n FROM options_paper_trades WHERE exit_at_ms>=? AND exit_at_ms<? AND status='EXITED' AND return_pct<=0", start, end) : 0;
  const openPositions = paperTable ? n("SELECT COUNT(*) n FROM options_paper_trades WHERE status='ENTERED'") : 0;

  const earliness = { early: 0, during: 0, late: 0 };
  if (candTable) for (const r of db.prepare("SELECT earliness_phase p, COUNT(*) c FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<? AND earliness_phase IS NOT NULL GROUP BY earliness_phase").all(start, end) as any[]) { if (r.p === "early" || r.p === "during" || r.p === "late") (earliness as any)[r.p] = r.c; }

  const hb = readRuntimeKeyOnDb(db, "heartbeat");
  const monitorHealthy = Boolean(hb?.updatedAtMs != null && nowMs - hb.updatedAtMs < 24 * 3_600_000 && (hb.value?.running));
  const providerFailures = Number(hb?.value?.providerFailures ?? 0);

  const anyActivity = candidatesFound + symbolsScanned + paperOpened + paperClosed + calloutsSent > 0;
  if (!enabled && !anyActivity) return null; // system was disabled and did nothing → no summary

  return {
    day, symbolsScanned, candidatesFound, callsEvaluated, putsEvaluated,
    calloutsSent, calloutsFailed, tooLate, rejected, rejectionReasons,
    paperOpened, paperClosed, wins, losses, openPositions, earliness,
    providerFailures, monitorHealthy,
    note: enabled ? "Options scanner ran (paper/research only)." : "Scanner flag was off but prior activity existed.",
  };
}

/** Concise Discord message. Puts are shown as EVALUATED only (research-only; not actionable). */
export function formatDailySummaryMessage(s: DailySummary): string {
  const rej = Object.entries(s.rejectionReasons).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(", ") || "none";
  return [
    `📊 **OptiScan Options — daily summary ${s.day}**`,
    `Scanned ${s.symbolsScanned} sym's · candidates ${s.candidatesFound} · calls ${s.callsEvaluated}/puts ${s.putsEvaluated} evaluated`,
    `Callouts: sent ${s.calloutsSent}, failed ${s.calloutsFailed}, too-late ${s.tooLate}, rejected ${s.rejected}`,
    `Paper: opened ${s.paperOpened}, closed ${s.paperClosed} (W ${s.wins} / L ${s.losses}), open now ${s.openPositions}`,
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
    const { postToDiscord } = require("@/lib/notifications");
    // Prefer the private recap webhook; postToDiscord falls back internally when recap is unset.
    const webhook = String(process.env.DISCORD_WEBHOOK_RECAP ?? "").trim() ? "recap" : "options";
    await postToDiscord({ content }, { webhook, skipPublicCheck: true });
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
  return { sent: false, skipped: false, reason: `send_failed: ${res.error}` }; // day not marked → retries next tick
}
