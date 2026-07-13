/**
 * callouts/runtime.ts — turns supervised agent results into canonical callouts
 * (Phase 6). Impure orchestration only: it reuses the agent runtime + the PURE
 * callout/dedup/discord modules. Prior emission state lives on globalThis so
 * dedup/cooldown survive across requests within a process.
 *
 * Discord AUTO-SEND is gated off by default (AGENT_CALLOUT_DISCORD=1). Until then
 * the desktop surface is the active channel and this returns the ready-to-send
 * payloads + emission decisions (idempotency keys included) without sending — no
 * fabricated delivery, and the existing alert Discord ledger is untouched.
 */
import { runAgentsForTicker } from "@/lib/agents/runtime";
import { buildCallout, type Callout } from "@/lib/callouts/callout";
import { decideEmission, nextCalloutState, type PriorCallout, type EmissionDecision } from "@/lib/callouts/dedup";
import { formatCalloutDiscord, type DiscordCalloutPayload } from "@/lib/callouts/discord-format";

type G = typeof globalThis & { __optiscanCalloutState?: Map<string, PriorCallout> };

function priorState(): Map<string, PriorCallout> {
  const g = globalThis as G;
  g.__optiscanCalloutState ??= new Map();
  return g.__optiscanCalloutState;
}

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
  const prev = priorState();
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

  // Advance dedup state for the next tick (records emission times).
  const next = nextCalloutState(callouts, decisions, prev, nowMs);
  const g = globalThis as G;
  g.__optiscanCalloutState = next;

  return {
    bundles,
    discordAutoSend: autoSend,
    note: autoSend
      ? "Discord auto-send enabled — payloads carry stable idempotency keys for the delivery ledger."
      : "Discord auto-send is OFF by default (set AGENT_CALLOUT_DISCORD=1). Desktop is the active channel; payloads are preview-ready.",
  };
}
