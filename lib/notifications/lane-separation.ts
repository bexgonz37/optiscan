/**
 * lane-separation.ts — are the Discord lanes actually separate channels?
 *
 * `discordWebhookSame` has existed since content got its own webhook and nothing has
 * ever called it. That is the gap this module closes, and the gap matters because the
 * defect it detects is INVISIBLE from every other surface:
 *
 *   `contentWebhookConfigured` returns true the moment DISCORD_WEBHOOK_CONTENT holds a
 *   non-empty string. It cannot tell whether that string is a dedicated content channel
 *   or a second copy of DISCORD_WEBHOOK_RECAP. If it is the latter, content drafts are
 *   back in the owner's recap channel — the exact condition that was found in production
 *   with 1209 drafts interleaved into it — and every diagnostic reads CONFIGURED.
 *
 * A separate channel is a configuration fact, not a code fact, so it can only be checked
 * at runtime and it can only be checked by comparing the values. This module therefore
 * compares them and reports a BOOLEAN. It never returns, logs, echoes, hashes or
 * partially reveals a webhook URL — the answer to "are these the same" carries none of
 * the secret, and that is the whole reason the check can be exposed at all.
 *
 * Read-only. Sends nothing, configures nothing, and holds no delivery authority.
 */
import { discordWebhookSame, discordWebhookConfigured, type DiscordWebhookKind } from "../notifications.ts";

export const LANE_SEPARATION_VERSION = "DISCORD_LANE_SEPARATION_V1";

/**
 * The pairs that must never share a destination, and why each one matters.
 *
 * Deliberately not "every pair": two subscriber-facing option channels sharing a
 * webhook is a duplicate-message problem, while content sharing the recap channel is a
 * CLAIM problem — owner-validation results and marketing drafts have different rules
 * about what may be asserted, and one channel is how that distinction stops being
 * visible at the moment it matters most.
 */
export const MUST_BE_SEPARATE: ReadonlyArray<{
  a: DiscordWebhookKind;
  b: DiscordWebhookKind;
  why: string;
}> = Object.freeze([
  {
    a: "content", b: "recap",
    why: "Content drafts are marketing copy the owner posts by hand; the recap is the owner's "
      + "own performance record. Sharing a channel is the exact condition found in production "
      + "with 1209 drafts interleaved into the recap.",
  },
  {
    a: "content", b: "options",
    why: "Content must never appear in a trading-alert channel, where a draft would read as a callout.",
  },
  {
    a: "content", b: "watchlist",
    why: "Content must never appear in the watchlist channel.",
  },
  {
    a: "recap", b: "options",
    why: "The owner's recap is owner-only. The options channel is the delivery lane.",
  },
]);

export interface LaneSeparationCheck {
  a: DiscordWebhookKind;
  b: DiscordWebhookKind;
  /** Null when either side is unset — "not configured" is not "not separate". */
  shareOneChannel: boolean | null;
  bothConfigured: boolean;
  why: string;
}

export interface LaneSeparationReport {
  version: typeof LANE_SEPARATION_VERSION;
  checks: LaneSeparationCheck[];
  /** Pairs that are configured AND identical. Empty is the healthy state. */
  collisions: Array<{ a: string; b: string; why: string }>;
  ok: boolean;
  /** Never contains a URL, a fragment of one, or a hash of one. */
  note: string;
}

export function buildLaneSeparationReport(env: NodeJS.ProcessEnv = process.env): LaneSeparationReport {
  const checks: LaneSeparationCheck[] = MUST_BE_SEPARATE.map(({ a, b, why }) => {
    const bothConfigured = discordWebhookConfigured(a, env) && discordWebhookConfigured(b, env);
    return {
      a, b, why, bothConfigured,
      // Null, not false. An unset webhook is not evidence of separation, and reporting it
      // as "separate" would let a missing configuration read as a passing check.
      shareOneChannel: bothConfigured ? discordWebhookSame(a, b, env) : null,
    };
  });
  const collisions = checks
    .filter((c) => c.shareOneChannel === true)
    .map((c) => ({ a: String(c.a), b: String(c.b), why: c.why }));
  return {
    version: LANE_SEPARATION_VERSION,
    checks,
    collisions,
    ok: collisions.length === 0,
    note:
      "Compares webhook values and reports only whether two lanes resolve to the SAME "
      + "destination. No URL, fragment or hash is returned, logged or echoed. A pair with "
      + "either side unset reports null rather than 'separate' — a missing configuration is "
      + "not a passing check.",
  };
}
