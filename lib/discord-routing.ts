export type DiscordRoutingWebhookStatus = {
  options: boolean;
  stocks?: boolean;
  recap: boolean;
  ownerResearch: boolean;
  ownerActionable: boolean;
  lifecycle: boolean;
  content: boolean;
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
  lastLifecycleSendAt?: string | null;
  lastRecapSendAt?: string | null;
  lastContentSendAt?: string | null;
}): DiscordRoutingRow[] {
  const w = input.webhooks;
  const options = ready(w.options, "DISCORD_WEBHOOK_OPTIONS");
  const ownerActionable = w.ownerActionable
    ? { status: "READY" as const, error: null }
    : { status: "OPTIONAL" as const, error: "DISCORD_WEBHOOK_OWNER_ACTIONABLE not configured; owner mirror skips without recap fallback" };
  const ownerResearch = ready(w.ownerResearch, "DISCORD_WEBHOOK_OWNER_RESEARCH");
  const recap = ready(w.recap, "DISCORD_WEBHOOK_RECAP");
  const lifecycle = w.lifecycle || w.options
    ? { status: "READY" as const, error: null }
    : { status: "BLOCKED" as const, error: "DISCORD_WEBHOOK_LIFECYCLE or DISCORD_WEBHOOK_OPTIONS not configured" };
  const content = ready(w.content, "DISCORD_WEBHOOK_CONTENT");

  return [
    {
      messageType: "TRADE NOW CANDIDATE",
      destination: "Options alert webhook",
      enabled: w.options,
      lastSend: input.lastOptionsSendAt ?? null,
      ...options,
    },
    {
      messageType: "BEARISH TRADE CANDIDATE",
      destination: "Options alert webhook",
      enabled: w.options,
      lastSend: input.lastOptionsSendAt ?? null,
      ...options,
    },
    {
      messageType: "Owner actionable mirror",
      destination: "Owner actionable webhook",
      enabled: w.ownerActionable,
      lastSend: null,
      ...ownerActionable,
    },
    {
      messageType: "Verified subscriber call alert",
      destination: "Options alert webhook",
      enabled: w.options,
      lastSend: input.lastOptionsSendAt ?? null,
      ...options,
    },
    {
      messageType: "Verified subscriber put alert",
      destination: "Options alert webhook",
      enabled: w.options,
      lastSend: input.lastOptionsSendAt ?? null,
      ...options,
    },
    {
      messageType: "Almost ready / blocked / missed / shadow research",
      destination: "Owner research webhook",
      enabled: w.ownerResearch,
      lastSend: null,
      ...ownerResearch,
    },
    {
      messageType: "EOD recap / watchlist / premarket / AI recap",
      destination: "Recap webhook",
      enabled: w.recap,
      lastSend: input.lastRecapSendAt ?? null,
      ...recap,
    },
    {
      messageType: "Lifecycle milestone / stop / exit",
      destination: w.lifecycle ? "Lifecycle webhook" : "Options alert webhook fallback",
      enabled: w.lifecycle || w.options,
      lastSend: input.lastLifecycleSendAt ?? null,
      ...lifecycle,
    },
    {
      messageType: "Content draft / Twitter post suggestion",
      destination: "Content webhook",
      enabled: w.content,
      lastSend: input.lastContentSendAt ?? null,
      ...content,
    },
  ];
}
