/**
 * recap-health.ts — say WHY recap delivery is off, not merely that it is off.
 *
 * On 2026-08-03 the content pipeline generated 50 Twitter/X drafts and marked
 * every one `SKIPPED_NO_WEBHOOK`. `/api/discord/health` reported
 * `webhooks: { recap: false }`, and that was read as "the owner never set
 * DISCORD_WEBHOOK_RECAP".
 *
 * The webhook was set the whole time. Production carried a 121-character
 * `DISCORD_WEBHOOK_RECAP` **and** `DISCORD_RECAP_ENABLED=0`. `recapDeliveryEnabled`
 * folds the kill-switch into the same boolean as the webhook check
 * (`notifications.ts:77`), so a deliberate shutdown and a missing secret return
 * an identical `false`. The diagnosis that followed sent the owner to set a
 * variable that was already set, and the real cause — a kill-switch someone
 * turned on — stayed invisible.
 *
 * That gate is correct as a GATE: nothing should deliver while the switch is
 * off. It is only wrong as an EXPLANATION. This module adds the explanation and
 * changes no delivery behaviour: `canDeliver` is exactly the old boolean.
 */

export type RecapDeliveryState =
  /** Webhook present, kill-switch off. Delivery may proceed. */
  | "CONFIGURED_AND_ENABLED"
  /** Webhook present, but DISCORD_RECAP_ENABLED=0 deliberately stops delivery. */
  | "DISABLED_BY_KILL_SWITCH"
  /** No webhook URL. This is the state that was wrongly reported all along. */
  | "MISSING_CONFIGURATION"
  /** Neither a webhook nor permission to send. */
  | "MISSING_AND_DISABLED";

export interface RecapDeliveryDiagnosis {
  state: RecapDeliveryState;
  /** A webhook URL is present in the environment. Never exposes the value. */
  webhookPresent: boolean;
  /** DISCORD_RECAP_ENABLED === "0". */
  killSwitchEngaged: boolean;
  /** Identical to the pre-existing `discordWebhookConfigured("recap")` gate. */
  canDeliver: boolean;
  headline: string;
  /** What the owner would have to change. Empty when nothing is wrong. */
  ownerAction: string | null;
  /** The truthful skip reason for a draft that could not be delivered. */
  skipReason: "DELIVERED" | "SKIPPED_RECAP_DISABLED" | "SKIPPED_NO_WEBHOOK";
}

export function recapDeliveryDiagnosis(
  env: NodeJS.ProcessEnv = process.env,
): RecapDeliveryDiagnosis {
  const webhookPresent = Boolean(String(env.DISCORD_WEBHOOK_RECAP ?? "").trim());
  const killSwitchEngaged = env.DISCORD_RECAP_ENABLED === "0";
  const canDeliver = webhookPresent && !killSwitchEngaged;

  if (canDeliver) {
    return {
      state: "CONFIGURED_AND_ENABLED",
      webhookPresent, killSwitchEngaged, canDeliver,
      headline: "Recap webhook configured and enabled.",
      ownerAction: null,
      skipReason: "DELIVERED",
    };
  }

  if (webhookPresent && killSwitchEngaged) {
    return {
      state: "DISABLED_BY_KILL_SWITCH",
      webhookPresent, killSwitchEngaged, canDeliver,
      headline:
        "Recap delivery is switched OFF. The webhook is configured — DISCORD_RECAP_ENABLED=0 is stopping delivery.",
      ownerAction:
        "Set DISCORD_RECAP_ENABLED=1 (or remove it) to resume recap and Twitter/X content delivery. "
        + "Do NOT add another webhook — one is already configured.",
      skipReason: "SKIPPED_RECAP_DISABLED",
    };
  }

  if (!webhookPresent && killSwitchEngaged) {
    return {
      state: "MISSING_AND_DISABLED",
      webhookPresent, killSwitchEngaged, canDeliver,
      headline: "No recap webhook is configured, and recap delivery is also switched off.",
      ownerAction: "Set DISCORD_WEBHOOK_RECAP and set DISCORD_RECAP_ENABLED=1.",
      skipReason: "SKIPPED_NO_WEBHOOK",
    };
  }

  return {
    state: "MISSING_CONFIGURATION",
    webhookPresent, killSwitchEngaged, canDeliver,
    headline: "No recap webhook is configured.",
    ownerAction: "Set DISCORD_WEBHOOK_RECAP to the private Discord channel webhook.",
    skipReason: "SKIPPED_NO_WEBHOOK",
  };
}
