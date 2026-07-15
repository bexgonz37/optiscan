/**
 * ai/recap.ts — the optional private nightly Discord recap.
 *
 * `buildNightlyRecapMessage` is a PURE formatter: concise + mobile-friendly, every
 * value drawn from the deterministic nightly summary (never the LLM, never a
 * fabricated figure). `deliverNightlyRecapOnDb` is the testable delivery core — it
 * routes the recap ONLY to the private recap webhook (DISCORD_WEBHOOK_RECAP), never
 * the paid options/stock callout channels, and records an ai_job_runs audit row.
 * The Discord dependency is injectable so the delivery path is unit-testable.
 */
import type { NightlySummary } from "./nightly-summary.ts";
import type { AiConfig } from "./config.ts";
import { recordAiJobRunOnDb, listLessonsOnDb, type DbLike } from "./store.ts";

export interface RecapContext {
  /** Newest deterministic lesson title for the day, if any. */
  topLesson?: string | null;
  /** Absolute AI Lab URL (PUBLIC_APP_URL + /ai) when configured, else null. */
  reportUrl?: string | null;
}

/** Build the recap message from deterministic stored values only. PURE. */
export function buildNightlyRecapMessage(summary: NightlySummary, ctx: RecapContext = {}): string {
  const o = summary.overall;
  const total = o.n;
  const wins = o.wins;
  const losses = o.losses;
  const openUngradable = Math.max(0, total - wins - losses);
  const optionsBlocked = summary.counts.rejected;
  const nearMisses = summary.momentum?.nearMisses ?? summary.counts.nearMisses;

  const lines = [
    "**OptiScan Nightly Review**",
    `Trades: ${total} | Wins: ${wins} | Losses: ${losses} | Open/Ungradable: ${openUngradable}`,
    `Options candidates blocked: ${optionsBlocked}`,
    `Momentum near misses: ${nearMisses ?? "n/a"}`,
  ];
  // The single most important thing to surface if it happened: a mis-configured,
  // silent options delivery path (actionable callouts that physically could not send).
  if (summary.options && summary.options.configBlockedCycles > 0) {
    lines.push(`⚠️ Options delivery blocked by config: ${summary.options.topDeliveryGateReason ?? "supervisor delivery off"}`);
  }
  lines.push(`Top issue: ${summary.prioritizedIssue ?? "none"}`);
  if (ctx.topLesson) lines.push(`Top lesson: ${ctx.topLesson}`);
  lines.push(`Full report: ${ctx.reportUrl ?? "AI Lab (set PUBLIC_APP_URL for a link)"}`);
  return lines.join("\n");
}

/** Injectable Discord surface — matches the relevant slice of lib/notifications. */
export interface RecapNotif {
  discordWebhookConfigured?: (kind: string) => boolean;
  postToDiscord: (payload: { content: string }, opts: { webhook: string; skipPublicCheck?: boolean }) => Promise<unknown>;
}

export interface DeliverRecapOptions {
  /** Discord surface; defaults to the real lib/notifications (lazy). */
  notif?: RecapNotif;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}

export interface DeliverRecapResult {
  posted: boolean;
  webhook: "recap" | null;
  reason?: string;
}

function lazyNotif(): RecapNotif {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/notifications");
}

/**
 * Deliver the deterministic recap. Routed ONLY to the recap webhook. If that
 * webhook is not configured this is a no-op that records a SKIPPED_DISABLED audit
 * row (the stored report is untouched; AI Lab surfaces the status). Never throws
 * on the "missing webhook" path; a genuine post failure propagates to the caller,
 * which already wraps recap delivery in try/catch. PURE except db + notif.
 */
export async function deliverNightlyRecapOnDb(
  db: DbLike,
  summary: NightlySummary,
  cfg: AiConfig,
  opts: DeliverRecapOptions = {},
): Promise<DeliverRecapResult> {
  const notif = opts.notif ?? lazyNotif();
  const nowMs = opts.nowMs ?? Date.now();

  if (!notif.discordWebhookConfigured?.("recap")) {
    recordAiJobRunOnDb(db, {
      jobType: "recap", model: cfg.recapModel, status: "SKIPPED_DISABLED",
      errorCategory: "disabled", error: "DISCORD_WEBHOOK_RECAP not configured", nowMs,
    });
    return { posted: false, webhook: null, reason: "recap webhook not configured" };
  }

  const base = String((opts.env ?? process.env).PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  const topLesson = (() => {
    try { return listLessonsOnDb(db, 1)[0]?.title ?? null; } catch { return null; }
  })();
  const content = buildNightlyRecapMessage(summary, { topLesson, reportUrl: base ? `${base}/ai` : null });
  await notif.postToDiscord({ content }, { webhook: "recap", skipPublicCheck: true });
  recordAiJobRunOnDb(db, { jobType: "recap", model: cfg.recapModel, status: "SUCCESS", errorCategory: "none", nowMs });
  return { posted: true, webhook: "recap" };
}
