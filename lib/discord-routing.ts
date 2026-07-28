export type DiscordRoutingWebhookStatus = {
  options: boolean;
  recap: boolean;
  stocks?: boolean;
  default?: boolean;
};

export type DiscordRoutingRow = {
  messageType: string;
  destination: string;
  enabled: boolean;
  lastSend: string | null;
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
  lastRecapSendAt?: string | null;
}): DiscordRoutingRow[] {
  const w = input.webhooks;
  const options = ready(w.options, "DISCORD_WEBHOOK_OPTIONS");
  const recap = ready(w.recap, "DISCORD_WEBHOOK_RECAP");

  return [
    {
      messageType: "Alerts: actionable calls / TRADE NOW CANDIDATE",
      destination: "Alerts webhook (DISCORD_WEBHOOK_OPTIONS)",
      enabled: w.options,
      lastSend: input.lastOptionsSendAt ?? null,
      ...options,
    },
    {
      messageType: "Alerts: actionable puts / BEARISH TRADE CANDIDATE",
      destination: "Alerts webhook (DISCORD_WEBHOOK_OPTIONS)",
      enabled: w.options,
      lastSend: input.lastOptionsSendAt ?? null,
      ...options,
    },
    {
      messageType: "Alerts: verified call and put alerts",
      destination: "Alerts webhook (DISCORD_WEBHOOK_OPTIONS)",
      enabled: w.options,
      lastSend: input.lastOptionsSendAt ?? null,
      ...options,
    },
    {
      messageType: "Alerts: lifecycle updates (T1, T2, high, thesis, stop, exit, closed)",
      destination: "Alerts webhook (DISCORD_WEBHOOK_OPTIONS)",
      enabled: w.options,
      lastSend: input.lastOptionsSendAt ?? null,
      ...options,
    },
    {
      messageType: "Recaps: AI / research / watchlists / planning",
      destination: "Recap webhook (DISCORD_WEBHOOK_RECAP)",
      enabled: w.recap,
      lastSend: input.lastRecapSendAt ?? null,
      ...recap,
    },
    {
      messageType: "Recaps: almost-ready / blocked / missed opportunities",
      destination: "Recap webhook (DISCORD_WEBHOOK_RECAP)",
      enabled: w.recap,
      lastSend: input.lastRecapSendAt ?? null,
      ...recap,
    },
    {
      messageType: "Recaps: content ideas / daily summaries",
      destination: "Recap webhook (DISCORD_WEBHOOK_RECAP)",
      enabled: w.recap,
      lastSend: input.lastRecapSendAt ?? null,
      ...recap,
    },
  ];
}
