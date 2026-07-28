export type DiscordRoutingWebhookStatus = {
  options: boolean;
  watchlist: boolean;
  recap: boolean;
  stocks?: boolean;
  default?: boolean;
};

export type DiscordRoutingRow = {
  messageType: string;
  destination: string;
  enabled: boolean;
  lastSend: string | null;
  lastFailure: string | null;
  categories: string;
  nextScheduledWindow: string | null;
  schedulerStatus: string;
  status: "READY" | "OPTIONAL" | "BLOCKED" | "DISABLED";
  error: string | null;
};

function ready(enabled: boolean, missing: string): Pick<DiscordRoutingRow, "status" | "error"> {
  return enabled
    ? { status: "READY", error: null }
    : { status: "BLOCKED", error: `${missing} not configured` };
}

export function buildDiscordRoutingRows(input: {
  webhooks: DiscordRoutingWebhookStatus;
  lastOptionsSendAt?: string | null;
  lastOptionsFailureAt?: string | null;
  lastWatchlistSendAt?: string | null;
  lastWatchlistFailureAt?: string | null;
  lastRecapSendAt?: string | null;
  lastRecapFailureAt?: string | null;
  nextWatchlistWindow?: string | null;
  schedulerStatus?: string | null;
}): DiscordRoutingRow[] {
  const w = input.webhooks;
  const options = ready(w.options, "DISCORD_WEBHOOK_OPTIONS");
  const watchlist = ready(w.watchlist, "DISCORD_WEBHOOK_WATCHLIST");
  const recap = ready(w.recap, "DISCORD_WEBHOOK_RECAP");

  return [
    {
      messageType: "Alerts",
      destination: "Alerts webhook (DISCORD_WEBHOOK_OPTIONS)",
      enabled: w.options,
      lastSend: input.lastOptionsSendAt ?? null,
      lastFailure: input.lastOptionsFailureAt ?? null,
      categories: "verified calls, verified puts, TRADE NOW CANDIDATE, BEARISH TRADE CANDIDATE, lifecycle updates",
      nextScheduledWindow: null,
      schedulerStatus: "event-driven",
      ...options,
    },
    {
      messageType: "Watchlist",
      destination: "Watchlist webhook (DISCORD_WEBHOOK_WATCHLIST)",
      enabled: w.watchlist,
      lastSend: input.lastWatchlistSendAt ?? null,
      lastFailure: input.lastWatchlistFailureAt ?? null,
      categories: "next-session watchlist, premarket refresh, market-open revalidation, meaningful plan deltas",
      nextScheduledWindow: input.nextWatchlistWindow ?? null,
      schedulerStatus: input.schedulerStatus ?? "scheduler unknown",
      ...watchlist,
    },
    {
      messageType: "Recaps",
      destination: "Recap webhook (DISCORD_WEBHOOK_RECAP)",
      enabled: w.recap,
      lastSend: input.lastRecapSendAt ?? null,
      lastFailure: input.lastRecapFailureAt ?? null,
      categories: "AI recaps, missed opportunities, blocked winners, research, daily/weekly performance, content drafts",
      nextScheduledWindow: null,
      schedulerStatus: "event-driven and scheduled recaps",
      ...recap,
    },
  ];
}
