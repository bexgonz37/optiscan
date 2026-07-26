/**
 * Discord bot role sync for paid subscribers. Uses REST API only — no auto-posting.
 */
import { logDiscordRoleSyncOnDb, type BillingDb } from "./subscribers-store.ts";

export async function syncDiscordSubscriberRole(
  discordUserId: string,
  action: "grant" | "revoke",
  env: NodeJS.ProcessEnv = process.env,
  db?: BillingDb | null,
): Promise<{ ok: boolean; reason: string | null }> {
  const token = String(env.DISCORD_BOT_TOKEN ?? "").trim();
  const guildId = String(env.DISCORD_GUILD_ID ?? "").trim();
  const roleId = String(env.DISCORD_SUBSCRIBER_ROLE_ID ?? "").trim();
  if (!token || !guildId || !roleId) {
    const reason = "DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, or DISCORD_SUBSCRIBER_ROLE_ID not configured";
    if (db) logDiscordRoleSyncOnDb(db, discordUserId, action, false, reason);
    return { ok: false, reason };
  }
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`;
  try {
    const res = await fetch(url, {
      method: action === "grant" ? "PUT" : "DELETE",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    });
    const ok = res.status === 204 || res.status === 201;
    const reason = ok ? null : `Discord API ${res.status}: ${(await res.text()).slice(0, 120)}`;
    if (db) logDiscordRoleSyncOnDb(db, discordUserId, action, ok, reason);
    return { ok, reason };
  } catch (e: unknown) {
    const reason = String((e as Error)?.message ?? e).slice(0, 160);
    if (db) logDiscordRoleSyncOnDb(db, discordUserId, action, false, reason);
    return { ok: false, reason };
  }
}
