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
import { reviewPortfolio } from "@/lib/agents/portfolio";
import { bridgeCalloutsToPaper, type BridgeSummary } from "@/lib/callouts/paper-bridge";

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
  /** Portfolio-manager telemetry: how many callouts were Discord-eligible after
   * ranking/selection, and how many were suppressed (ranked out or gated). */
  portfolioEligible?: number;
  portfolioSuppressed?: number;
  /** Supervisor→paper bridge summary (only when the authoritative cycle ran it). */
  paperBridge?: BridgeSummary;
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
  const built: Callout[] = [];
  for (const t of tickers) {
    try {
      const run = await runAgentsForTicker(t, nowMs);
      for (const r of run.supervised.canonical) built.push(buildCallout(r));
    } catch {
      // A single ticker failure never aborts the batch.
    }
  }

  // PORTFOLIO-MANAGER pass (agents/portfolio.ts): anti-chase, thesis
  // reconciliation (no contradictory bull+bear actionables per ticker), quality
  // ranking, and a top-N selection so ONLY the strongest few reach Discord. It
  // adjusts lifecycle status / thesis notes and returns the delivery-eligible set.
  const review = reviewPortfolio(built);
  const callouts = review.callouts;
  const eligible = review.eligibleKeys;

  // SUPERVISOR→PAPER BRIDGE. Runs only in the authoritative delivery cycle (never on
  // read-only API fetches) so a GET never creates trades. It is independent of Discord
  // auto-send — paper eligibility is gated purely by PAPER_TRADING_ENABLED /
  // PAPER_AUTO_ENTRY + the HIGH + ACTIONABLE_NOW + valid-now rule inside the bridge.
  let paperBridge: BridgeSummary | undefined;
  if (opts.deliver) {
    try { paperBridge = bridgeCalloutsToPaper(callouts, nowMs); }
    catch (err: any) { console.warn("[callouts] paper bridge failed:", err?.message); }
  }

  // Emission dedup runs on the reconciled callouts; a callout the portfolio did
  // NOT select is suppressed here so it is never marked emitted (it can emit later
  // if it ranks into the top selection) — the existing dedup/cooldown is untouched.
  const decisions = callouts.map((c) => {
    const d = decideEmission(c, prev.get(c.key), { nowMs });
    if (d.emit && !eligible.has(c.key)) {
      return { ...d, emit: false, kind: "suppress" as const, reason: "portfolio: not in the top-ranked Discord selection" };
    }
    return d;
  });
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
    portfolioEligible: eligible.size,
    portfolioSuppressed: review.suppressed.length,
    paperBridge,
    note: autoSend
      ? "Supervisor is the canonical Discord path — emitted callouts deliver through the tracked ledger."
      : "Supervisor Discord delivery OFF (set CALLOUT_CANONICAL_PATH=supervisor and AGENT_CALLOUT_DISCORD=1). Desktop is the active channel; payloads are preview-ready.",
  };
}
