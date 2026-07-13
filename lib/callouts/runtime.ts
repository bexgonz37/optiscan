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

export interface CalloutBundle {
  callout: Callout;
  decision: EmissionDecision;
  discord: DiscordCalloutPayload | null;
}

export interface CalloutsRunResult {
  bundles: CalloutBundle[];
  discordAutoSend: boolean;
  note: string;
}

export async function buildCalloutsForTickers(tickers: string[], nowMs: number = Date.now()): Promise<CalloutsRunResult> {
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
  const autoSend = process.env.AGENT_CALLOUT_DISCORD === "1";
  const bundles: CalloutBundle[] = callouts.map((c, i) => ({
    callout: c,
    decision: decisions[i],
    discord: decisions[i].emit ? formatCalloutDiscord(c) : null,
  }));

  // Persist post-cycle state (delivery ids are attached by the delivery layer;
  // here they stay null — preview only). This is what makes dedup restart-safe.
  const writes: CalloutStateWrite[] = bundles.map((b) => ({ callout: b.callout, decision: b.decision }));
  persistCalloutState(writes, nowMs);

  return {
    bundles,
    discordAutoSend: autoSend,
    note: autoSend
      ? "Discord auto-send enabled — payloads carry stable idempotency keys for the delivery ledger."
      : "Discord auto-send is OFF by default (set AGENT_CALLOUT_DISCORD=1). Desktop is the active channel; payloads are preview-ready.",
  };
}
