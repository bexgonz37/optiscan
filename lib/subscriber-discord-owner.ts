/**
 * Subscriber Discord ownership — ensures only one system posts actionable options alerts.
 * Paid beta: SUBSCRIBER_OPTIONS_DISCORD_OWNER=independent
 */
export type SubscriberOptionsDiscordOwner = "independent" | "supervisor" | "legacy";

export function subscriberOptionsDiscordOwner(env: NodeJS.ProcessEnv = process.env): SubscriberOptionsDiscordOwner {
  const raw = String(env.SUBSCRIBER_OPTIONS_DISCORD_OWNER ?? "independent").trim().toLowerCase();
  if (raw === "supervisor" || raw === "legacy") return raw;
  return "independent";
}

/** Independent options discovery owns subscriber Discord when owner=independent (default). */
export function independentOwnsSubscriberOptionsDiscord(env: NodeJS.ProcessEnv = process.env): boolean {
  return subscriberOptionsDiscordOwner(env) === "independent";
}

/** Supervisor must not post options to subscriber webhook when independent owns it. */
export function supervisorOptionsDiscordBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return independentOwnsSubscriberOptionsDiscord(env);
}

export function supervisorOptionsDiscordBlockReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!supervisorOptionsDiscordBlocked(env)) return null;
  return "SUBSCRIBER_OPTIONS_DISCORD_OWNER=independent — supervisor options Discord suppressed";
}

/** Legacy options notify path must stand down when independent owns subscriber Discord. */
export function legacyOptionsSubscriberDiscordBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return independentOwnsSubscriberOptionsDiscord(env);
}

export function subscriberDiscordOwnershipSummary(env: NodeJS.ProcessEnv = process.env): {
  owner: SubscriberOptionsDiscordOwner;
  independentOwns: boolean;
  supervisorOptionsBlocked: boolean;
  legacyOptionsBlocked: boolean;
} {
  const owner = subscriberOptionsDiscordOwner(env);
  return {
    owner,
    independentOwns: owner === "independent",
    supervisorOptionsBlocked: supervisorOptionsDiscordBlocked(env),
    legacyOptionsBlocked: legacyOptionsSubscriberDiscordBlocked(env),
  };
}
