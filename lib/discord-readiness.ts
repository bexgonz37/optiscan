/**
 * Subscriber Discord readiness.
 *
 * Read-only operator signal for the paid-beta product surface. Subscribers only
 * see Discord, so this intentionally evaluates Discord delivery health without
 * touching scanner, ranking, gates, retries, or webhook secrets.
 */

export type SubscriberDiscordReadinessStatus = "READY" | "NEEDS_REVIEW" | "BLOCKED";

export interface DiscordReadinessInput {
  webhooks: Record<string, boolean>;
  metrics: {
    total24h: number;
    sent24h: number;
    failed24h: number;
    retrying24h: number;
    suppressed24h: number;
    notConfigured24h: number;
    stuckInFlight: number;
    lastSentAt: string | null;
    lastFailureAt: string | null;
  };
  optionsRequired?: boolean;
  stocksRequired?: boolean;
}

export interface SubscriberDiscordReadiness {
  subscriberSurface: "discord_only";
  status: SubscriberDiscordReadinessStatus;
  blockers: string[];
  reviewItems: string[];
  channels: {
    options: { configured: boolean; required: boolean; ready: boolean; blockedBy: string[] };
    stocks: { configured: boolean; required: boolean; ready: boolean; blockedBy: string[] };
    recap: { configured: boolean; subscriberDelivery: false; note: string };
  };
  metrics: DiscordReadinessInput["metrics"];
  betaVerdict: string;
}

function channelState(configured: boolean, required: boolean, name: string) {
  const blockedBy = required && !configured ? [`${name} webhook missing`] : [];
  return { configured, required, ready: blockedBy.length === 0, blockedBy };
}

export function buildSubscriberDiscordReadiness(input: DiscordReadinessInput): SubscriberDiscordReadiness {
  const optionsRequired = input.optionsRequired !== false;
  const stocksRequired = input.stocksRequired === true;
  const options = channelState(Boolean(input.webhooks.options), optionsRequired, "options");
  const stocks = channelState(Boolean(input.webhooks.stocks), stocksRequired, "stocks");
  const blockers = [...options.blockedBy, ...stocks.blockedBy];
  if (input.metrics.stuckInFlight > 0) blockers.push(`${input.metrics.stuckInFlight} Discord delivery attempt(s) stuck in flight`);

  const reviewItems: string[] = [];
  const failedOrRetrying = input.metrics.failed24h + input.metrics.retrying24h;
  if (failedOrRetrying > 0) reviewItems.push(`${failedOrRetrying} failed/retrying Discord delivery attempt(s) in the last 24h`);
  if (input.metrics.suppressed24h > 0) reviewItems.push(`${input.metrics.suppressed24h} suppressed Discord delivery attempt(s) in the last 24h`);
  if (input.metrics.notConfigured24h > 0) reviewItems.push(`${input.metrics.notConfigured24h} delivery attempt(s) found no configured webhook`);
  if (input.metrics.total24h === 0) reviewItems.push("No Discord deliveries recorded in the last 24h; quiet days are OK, but run a test before selling access.");

  const status: SubscriberDiscordReadinessStatus = blockers.length ? "BLOCKED" : reviewItems.length ? "NEEDS_REVIEW" : "READY";
  const betaVerdict = status === "READY"
    ? "Discord delivery is ready for a limited paid beta."
    : status === "NEEDS_REVIEW"
      ? "Discord delivery can be beta-ready after the review items are checked."
      : "Do not sell subscriber access until the blockers are fixed.";

  return {
    subscriberSurface: "discord_only",
    status,
    blockers,
    reviewItems,
    channels: {
      options,
      stocks,
      recap: {
        configured: Boolean(input.webhooks.recap),
        subscriberDelivery: false,
        note: "Recap is operator/reporting only and does not block subscriber alert delivery.",
      },
    },
    metrics: input.metrics,
    betaVerdict,
  };
}
