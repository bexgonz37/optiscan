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
import type { NightlyResearchResult } from "../research/options/nightly-research.ts";

export interface RecapContext {
  /** Newest deterministic lesson title for the day, if any. */
  topLesson?: string | null;
  /** Absolute AI Lab URL (PUBLIC_APP_URL + /ai) when configured, else null. */
  reportUrl?: string | null;
  /**
   * Pre-formatted deterministic sections from the OptiScan research aggregation, led by
   * OWNER DISCORD ALERTS. Rendered above the paper-portfolio block.
   */
  researchSections?: string[];
}

/**
 * One evidence-grounded line splitting the day's losses into "never traded above
 * entry" vs "was profitable then closed red". Returns null when the summary predates
 * these counters or there were no losses — never guesses.
 */
function lossBreakdownLine(summary: NightlySummary): string | null {
  const never = summary.neverProfitable;
  const gaveBack = summary.profitableThenLost;
  const unknown = summary.lossesWithoutExcursionEvidence ?? 0;
  if (typeof never !== "number" || typeof gaveBack !== "number") return null;
  if (never + gaveBack + unknown === 0) return null;
  const parts = [`${never} never traded above entry`, `${gaveBack} were profitable then closed red`];
  if (unknown > 0) parts.push(`${unknown} without excursion evidence`);
  return `Losses: ${parts.join(" · ")}`;
}

/**
 * Build the recap message from deterministic stored values only. PURE.
 *
 * When the OptiScan research aggregation is available, its OWNER DISCORD ALERTS section leads
 * the message. That ordering is the fix for a real defect: the internal paper portfolio and the
 * delivered Discord lane are disjoint populations that have coincidentally been the same size,
 * and an unlabelled paper-portfolio line at the top read as a verdict on the owner's alerts on a
 * day when the delivered lane was profitable. The paper-portfolio block is kept, below, labelled.
 */
export function buildNightlyRecapMessage(summary: NightlySummary, ctx: RecapContext = {}): string {
  const o = summary.overall;
  const total = o.n;
  const wins = o.wins;
  const losses = o.losses;
  const openUngradable = Math.max(0, total - wins - losses);
  const optionsBlocked = summary.counts.rejected;
  const nearMisses = summary.momentum?.nearMisses ?? summary.counts.nearMisses;

  // The counts below come from the internal paper portfolio, NOT from the alerts that
  // were delivered to Discord — those are separate lanes with separate contracts. The
  // label is explicit because an unlabelled "Trades: 5 | Wins: 0 | Losses: 5" reads as
  // a verdict on the day's Discord alerts, which it is not.
  const lines = ["**OptiScan Nightly Review**"];

  // PRIMARY section: the alerts the owner actually received. Everything below it is a
  // different population and says so.
  if (ctx.researchSections?.length) {
    lines.push(...ctx.researchSections, "");
  }

  lines.push(
    // "PRIMARY" only holds when this block leads. Once the owner section is above it, this is
    // the secondary lane and says so — the label has to track the actual ordering.
    ctx.researchSections?.length
      ? `_Lane: internal paper portfolio. Not the delivered Discord alert lane above._`
      : `_Lane: internal paper portfolio (PRIMARY). Not the delivered Discord alert lane._`,
    `Paper trades: ${total} | Wins: ${wins} | Losses: ${losses} | Open/Ungradable: ${openUngradable}`,
  );
  const lossBreakdown = lossBreakdownLine(summary);
  if (lossBreakdown) lines.push(lossBreakdown);
  lines.push(
    `Options candidates blocked: ${optionsBlocked}`,
    `Momentum near misses: ${nearMisses ?? "n/a"}`,
  );
  // The single most important thing to surface if it happened: a mis-configured,
  // silent options delivery path (actionable callouts that physically could not send).
  if (summary.options && summary.options.configBlockedCycles > 0) {
    lines.push(`⚠️ Options delivery blocked by config: ${summary.options.topDeliveryGateReason ?? "supervisor delivery off"}`);
  }
  lines.push(`Top issue: ${summary.prioritizedIssue ?? "none"}`);
  if (ctx.topLesson) lines.push(`Top lesson: ${ctx.topLesson}`);
  return lines.join("\n");
}

/** Injectable Discord surface — matches the relevant slice of lib/notifications. */
export interface RecapNotif {
  discordWebhookConfigured?: (kind: string) => boolean;
  postToDiscord: (
    payload: { content: string },
    opts: {
      webhook: string;
      skipPublicCheck?: boolean;
      audience?: "subscriber";
      payloadType?: string;
      idempotencyKey?: string;
    },
  ) => Promise<unknown>;
}

export interface DeliverRecapOptions {
  /** Discord surface; defaults to the real lib/notifications (lazy). */
  notif?: RecapNotif;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  /** Deterministic OptiScan research aggregation, when it was computed. */
  research?: NightlyResearchResult | null;
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

  const topLesson = (() => {
    try { return listLessonsOnDb(db, 1)[0]?.title ?? null; } catch { return null; }
  })();
  const researchSections = (() => {
    if (!opts.research) return undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { formatNightlyResearchSections } = require("@/lib/research/options/nightly-research");
      return formatNightlyResearchSections(opts.research) as string[];
    } catch { return undefined; }
  })();
  const content = buildNightlyRecapMessage(summary, { topLesson, researchSections });
  const sent: any = await notif.postToDiscord(
    { content },
    {
      webhook: "recap",
      skipPublicCheck: true,
      audience: "subscriber",
      payloadType: "nightly_ai_recap",
      idempotencyKey: `nightly_ai_recap:${summary.tradingDay}`,
    },
  );
  if (sent?.suppressed) {
    recordAiJobRunOnDb(db, {
      jobType: "recap", model: cfg.recapModel, status: "SKIPPED_DISABLED",
      errorCategory: "disabled", error: `recap suppressed: ${sent.suppressionReason ?? "guard"}`, nowMs,
    });
    return { posted: false, webhook: null, reason: sent.suppressionReason ?? "recap suppressed" };
  }
  recordAiJobRunOnDb(db, { jobType: "recap", model: cfg.recapModel, status: "SUCCESS", errorCategory: "none", nowMs });
  return { posted: true, webhook: "recap" };
}
