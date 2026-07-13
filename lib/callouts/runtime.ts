/**
 * callouts/runtime.ts — turns supervised agent results into canonical callouts
 * (Phase 6 + live runtime wiring). Impure orchestration only: it reuses the agent
 * runtime + the PURE callout/dedup/discord modules. Prior emission state is now
 * PERSISTED in SQLite (callout_state) so dedup/cooldown/lifecycle survive process
 * and worker restarts and horizontal scaling — a restart never resends an
 * unchanged callout.
 *
 * Discord AUTO-SEND is gated off by default (AGENT_CALLOUT_DISCORD=1). Until then
 * the desktop surface is the active channel and this returns the ready-to-send
 * payloads + emission decisions (idempotency keys included) without sending — no
 * fabricated delivery, and the existing alert Discord ledger is untouched.
 */
import { runAgentsForTicker } from "@/lib/agents/runtime";
import { buildCallout, type Callout } from "@/lib/callouts/callout";
import { decideEmission, type EmissionDecision } from "@/lib/callouts/dedup";
import { formatCalloutDiscord, type DiscordCalloutPayload } from "@/lib/callouts/discord-format";
import { loadPriorCallouts, persistCalloutState, type CalloutStateWrite } from "@/lib/callouts/state-store";
import { calloutWebhook, supervisorDiscordDeliveryEnabled } from "@/lib/callouts/routing";
import { deliverCalloutDiscord } from "@/lib/notifications";

export interface CalloutBundle {
  callout: Callout;
  decision: EmissionDecision;
  discord: DiscordCalloutPayload | null;
  deliveryId?: string | null;
  deliveryStatus?: string | null;
}

export interface CalloutsRunResult {
  bundles: CalloutBundle[];
  discordAutoSend: boolean;
  delivered: number;
  note: string;
}

export interface BuildCalloutsOptions {
  /** Actually deliver emitted callouts to Discord (requires config + gating). */
  deliver?: boolean;
}

/** Convert the formatter's { content, embed } into a Discord webhook payload. */
function toWebhookPayload(p: DiscordCalloutPayload): Record<string, unknown> {
  return { content: p.content, embeds: [p.embed] };
}

export async function buildCalloutsForTickers(
  tickers: string[],
  nowMs: number = Date.now(),
  opts: BuildCalloutsOptions = {},
): Promise<CalloutsRunResult> {
  // Prior lifecycle/dedup state is hydrated from SQLite (survives restarts).
  const prev = loadPriorCallouts();
  const callouts: Callout[] = [];
  for (const t of tickers) {
    try {
      const run = await runAgentsForTicker(t, nowMs);
      for (const r of run.supervised.canonical) callouts.push(buildCallout(r));
    } catch {
      // A single ticker failure never aborts the batch.
    }
  }

  const decisions = callouts.map((c) => decideEmission(c, prev.get(c.key), { nowMs }));
  const autoSend = supervisorDiscordDeliveryEnabled();
  const bundles: CalloutBundle[] = callouts.map((c, i) => ({
    callout: c,
    decision: decisions[i],
    discord: decisions[i].emit ? formatCalloutDiscord(c) : null,
    deliveryId: null,
    deliveryStatus: null,
  }));

  // Deliver ONE tracked message per emitted canonical opportunity/horizon — only
  // when explicitly asked AND the supervisor path is the canonical Discord sender.
  let delivered = 0;
  if (opts.deliver && autoSend) {
    for (const b of bundles) {
      if (!b.decision.emit || !b.discord) continue;
      try {
        const res = await deliverCalloutDiscord({
          webhook: calloutWebhook(b.callout),
          payload: toWebhookPayload(b.discord),
          idempotencyKey: b.decision.idempotencyKey,
        });
        b.deliveryId = res.deliveryId ?? null;
        b.deliveryStatus = res.status;
        if (res.sent) delivered++;
      } catch {
        // Delivery failure is recorded in the ledger; never abort the cycle.
      }
    }
  }

  // Persist post-cycle state (with any delivery ids). Restart-safe dedup.
  const writes: CalloutStateWrite[] = bundles.map((b) => ({
    callout: b.callout, decision: b.decision, deliveryId: b.deliveryId, deliveryStatus: b.deliveryStatus,
  }));
  persistCalloutState(writes, nowMs);

  return {
    bundles,
    discordAutoSend: autoSend,
    delivered,
    note: autoSend
      ? "Supervisor is the canonical Discord path — emitted callouts deliver through the tracked ledger."
      : "Supervisor Discord delivery OFF (set CALLOUT_CANONICAL_PATH=supervisor and AGENT_CALLOUT_DISCORD=1). Desktop is the active channel; payloads are preview-ready.",
  };
}
