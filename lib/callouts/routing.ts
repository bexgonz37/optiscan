/**
 * callouts/routing.ts — deterministic Discord channel routing + path gating for
 * canonical callouts (live runtime wiring). PURE.
 *
 * Channel mapping (unless a more precise compatible mapping already exists):
 *   • option CALL horizons → options webhook
 *   • put RESEARCH horizons → options webhook (payload already labeled RESEARCH ONLY)
 *   • momentum-stock callouts → stocks webhook
 *
 * Coexistence / migration rule (safe defaults so an accidental deploy never
 * double-sends): the canonical path is LEGACY unless CALLOUT_CANONICAL_PATH is
 * explicitly set to "supervisor". Supervisor Discord delivery additionally
 * requires the existing AGENT_CALLOUT_DISCORD=1 master switch.
 */
import type { Callout } from "./callout.ts";

export type CalloutWebhook = "options" | "stocks";

/** Route a callout to its Discord channel. Stock horizon → stocks; else options. */
export function calloutWebhook(c: Pick<Callout, "horizon" | "contract">): CalloutWebhook {
  const horizon = String(c.horizon ?? "").toLowerCase();
  if (horizon === "stock" || horizon === "momentum" || horizon === "stocks") return "stocks";
  return "options";
}

export type CanonicalPath = "legacy" | "supervisor";

/** Which system owns Discord callouts. Defaults to LEGACY (safe). */
export function calloutCanonicalPath(env: NodeJS.ProcessEnv = process.env): CanonicalPath {
  return env.CALLOUT_CANONICAL_PATH === "supervisor" ? "supervisor" : "legacy";
}

/** True only when the supervisor path is canonical AND Discord auto-send is on. */
export function supervisorDiscordDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return calloutCanonicalPath(env) === "supervisor" && env.AGENT_CALLOUT_DISCORD === "1";
}

/**
 * True when the LEGACY options Discord path should stand down for a given asset
 * class because the supervisor is the canonical sender — prevents double-send.
 * Only options are owned by the supervisor; stock alerts always use legacy.
 */
export function legacyOptionsSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  return calloutCanonicalPath(env) === "supervisor";
}

/**
 * Whether the LEGACY "WATCH" heads-up may post to Discord. WATCH is a non-actionable
 * dashboard state (armed, not ready) — the desk rule is that Discord only carries
 * actionable setups, so this is OFF BY DEFAULT and can only be turned on with an
 * explicit opt-in (DISCORD_WATCH_ALERTS=1). It ALSO stands down whenever the
 * supervisor is the canonical path, so the two systems never both narrate a ticker.
 * Dashboards still show WATCH regardless — this gate is purely about Discord.
 */
export function legacyWatchDiscordEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (calloutCanonicalPath(env) === "supervisor") return false;
  return env.DISCORD_WATCH_ALERTS === "1";
}

/**
 * True when the LEGACY paper auto-entry path (autoEnterFromAlerts, which creates
 * paper trades directly from the `alerts` table) must stand down because the
 * Supervisor→paper bridge is the single authoritative paper-entry path. Without
 * this, a strong setup that both the scanner (alert) and the supervisor (callout)
 * flag would create TWO paper trades for one real setup (they dedup on different
 * keys). Mirrors legacyOptionsSuppressed so paper entry and Discord agree on who
 * owns the setup.
 */
export function legacyPaperAutoEntrySuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  return calloutCanonicalPath(env) === "supervisor";
}
