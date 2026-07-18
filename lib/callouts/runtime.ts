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
import { decideEmission, isMeaningfulTransition, type EmissionDecision } from "@/lib/callouts/dedup";
import { formatCalloutDiscord, type DiscordCalloutPayload } from "@/lib/callouts/discord-format";
import { loadPriorCallouts, persistCalloutState, type CalloutStateWrite } from "@/lib/callouts/state-store";
import { calloutWebhook, supervisorDiscordDeliveryEnabled, optionsDeliveryGateReason } from "@/lib/callouts/routing";
import { nowOnlyActionable } from "@/lib/callouts/eligibility";
import { optionAlertDeliverable, canonicalOptionContract, sameOptionContract } from "@/lib/callouts/option-line";
import { deliverCalloutDiscord, discordWebhookConfigured } from "@/lib/notifications";
import { reviewPortfolio } from "@/lib/agents/portfolio";
import { bridgeCalloutsToPaper, type BridgeSummary } from "@/lib/callouts/paper-bridge";
import { envConcurrency, mapLimit } from "@/lib/bounded-concurrency";
import { routeAgentResults, type RouterSummary } from "@/lib/research/router";
import type { AgentResult } from "@/lib/agents/types";

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
  /** Research lane-router summary (only when the authoritative cycle ran it; empty when flag off). */
  laneRouting?: RouterSummary;
  execution: {
    requestedTickers: string[];
    concurrency: number;
    tickerResults: Array<{ ticker: string; ok: boolean; durationMs: number; canonical: number; error?: string }>;
    succeeded: number;
    failed: number;
    durationMs: number;
  };
  /** Deterministic options-funnel counts for persistent diagnostics. */
  funnel: CalloutFunnel;
  /** Per-suppressed-item diagnostics (why each canonical candidate did not emit). */
  suppressedItems?: SuppressedCalloutItem[];
}

export interface CalloutFunnel {
  tickersConsidered: number;
  chainsOk: number;
  chainsFailed: number;
  tickersWithCanonical: number;
  canonical: number;
  /** Raw ACTIONABLE_NOW candidates before collapse (multiple variants per ticker). */
  actionable: number;
  /** Candidates after collapse-to-best-per-(ticker,direction) — the ranked set. */
  collapsed: number;
  portfolioSuppressed: number;
  dedupSuppressed: number;
  emitted: number;
  delivered: number;
  notActionableNow: number;
  contractIncomplete: number;
  contractMismatch: number;
  discordAutoSend: boolean;
  /** Non-null when emitted>0 but delivery is blocked by config (the key "no alerts" cause). */
  deliveryGateReason: string | null;
  topReason: string | null;
}

/** Per-suppressed-item diagnostics — WHY each canonical candidate did not emit. */
export interface SuppressedCalloutItem {
  key: string;
  ticker: string;
  direction: string;
  optionSymbol: string | null;
  status: string;
  previousStatus: string | null;
  previousEmitMs: number | null;
  suppressionReason: string;
  materialChange: boolean;
}


export interface BuildCalloutsOptions {
  /** Actually deliver emitted callouts to Discord (requires config + gating). */
  deliver?: boolean;
}

/** Convert the formatter's { content, embed? } into a Discord webhook payload.
 * Options callouts are a single content line with no embed; stock cards carry one. */
function toWebhookPayload(p: DiscordCalloutPayload): Record<string, unknown> {
  return p.embed ? { content: p.content, embeds: [p.embed] } : { content: p.content };
}

export async function buildCalloutsForTickers(
  tickers: string[],
  nowMs: number = Date.now(),
  opts: BuildCalloutsOptions = {},
): Promise<CalloutsRunResult> {
  const runStarted = Date.now();
  const requestedTickers = [...new Set((tickers ?? []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
  const concurrency = envConcurrency(process.env, "SUPERVISOR_CHAIN_CONCURRENCY", 3, 12);
  // Prior lifecycle/dedup state is hydrated from SQLite (survives restarts).
  const prev = loadPriorCallouts();
  const runResults = await mapLimit(requestedTickers, concurrency, async (t) => {
    const started = Date.now();
    try {
      const run = await runAgentsForTicker(t, nowMs);
      return {
        ticker: t,
        ok: true,
        durationMs: Date.now() - started,
        canonical: run.supervised.canonical.length,
        callouts: run.supervised.canonical.map((r) => buildCallout(r)),
        // Raw canonical agent verdicts — consumed ONLY by the flag-gated research
        // lane router below (never by the Discord/paper production path).
        results: run.supervised.canonical as AgentResult[],
      };
    } catch (err: any) {
      // A single ticker failure never aborts the batch.
      return {
        ticker: t,
        ok: false,
        durationMs: Date.now() - started,
        canonical: 0,
        error: String(err?.message ?? err).slice(0, 180),
        callouts: [] as Callout[],
        results: [] as AgentResult[],
      };
    }
  });
  const built = runResults.flatMap((r) => r.callouts);
  const allResults = runResults.flatMap((r) => r.results ?? []);
  const tickerResults = runResults.map(({ callouts, results, ...r }) => r);

  // PORTFOLIO-MANAGER pass (agents/portfolio.ts): anti-chase, thesis
  // reconciliation (no contradictory bull+bear actionables per ticker), quality
  // ranking, and a top-N selection so ONLY the strongest few reach Discord. It
  // adjusts lifecycle status / thesis notes and returns the delivery-eligible set.
  const review = reviewPortfolio(built);
  const callouts = review.callouts;
  const eligible = review.eligibleKeys;

  // RESEARCH LANE ROUTER (Phase 2). Branches research from the RAW canonical agent
  // verdicts BEFORE Discord dedup + production eligibility run below. Authoritative
  // cycle only, and a HARD no-op unless LANE_ROUTER_ENABLED=1. It only writes
  // diagnostics (setup_candidates / lane_routes) — it never sends Discord and never
  // creates a trade — so it cannot alter the production Discord/paper path.
  let laneRouting: RouterSummary | undefined;
  if (opts.deliver) {
    try { laneRouting = routeAgentResults(allResults, nowMs); }
    catch (err: any) { console.warn("[callouts] lane router failed:", err?.message); }
  }

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
      // Defense-in-depth: Discord carries ACTIONABLE_NOW setups ONLY. Even though
      // the portfolio selection already restricts emission to the actionable-now
      // set, re-assert the shared now-only rule at the delivery boundary so a
      // future dedup/portfolio regression can never leak a WAIT/WATCH/NEAR/
      // MISSED/EXTENDED/RESEARCH_ONLY callout to Discord.
      if (!nowOnlyActionable(b.callout).ok) {
        b.deliveryStatus = "skipped: not actionable-now at delivery";
        continue;
      }
      const webhook = calloutWebhook(b.callout);
      // Options carry the exact selected contract or nothing. Block (never send a
      // generic/incomplete options alert) when the contract can't be verified, and
      // assert the published contract is the SAME one the paper bridge trades — both
      // read Callout.contract, so a divergence here means a code regression.
      if (webhook === "options") {
        const deliverable = optionAlertDeliverable(b.callout);
        if (!deliverable.ok) {
          b.deliveryStatus = `skipped: CONTRACT DATA INCOMPLETE — ${deliverable.reason}`;
          continue;
        }
        if (!sameOptionContract(canonicalOptionContract(b.callout), b.callout.contract)) {
          b.deliveryStatus = "skipped: contract identity mismatch (Discord vs paper)";
          continue;
        }
      }
      try {
        const res = await deliverCalloutDiscord({
          webhook,
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

  // Deterministic options funnel for persistent diagnostics. Delivery-stage skips are
  // read from the exact deliveryStatus strings set in the loop above so a code change
  // there is reflected here. portfolio vs dedup suppression is split by the reason tag.
  const emittedCount = decisions.filter((d) => d.emit).length;
  const suppressed = decisions.filter((d) => !d.emit);
  const portfolioSuppressed = suppressed.filter((d) => d.reason?.startsWith("portfolio:")).length;
  const dedupSuppressed = suppressed.length - portfolioSuppressed;
  // Per-suppressed-item diagnostics: for every canonical candidate that did NOT emit,
  // record ticker/direction/OCC + the prior state + the exact reason + whether a
  // material change was detected. Makes "canonical but not emitted" fully explainable.
  const suppressedItems: SuppressedCalloutItem[] = callouts
    .map((c, i) => ({ c, d: decisions[i] }))
    .filter((x) => !x.d.emit)
    .map(({ c, d }): SuppressedCalloutItem => {
      const prior = prev.get(c.key);
      return {
        key: c.key,
        ticker: c.ticker,
        direction: c.direction,
        optionSymbol: c.contract?.optionSymbol ?? null,
        status: c.status,
        previousStatus: prior?.status ?? null,
        previousEmitMs: prior?.lastEmitMs ?? null,
        suppressionReason: d.reason,
        materialChange: prior ? isMeaningfulTransition(prior.status, c.status) : true,
      };
    });
  const notActionableNow = bundles.filter((b) => b.deliveryStatus?.startsWith("skipped: not actionable-now")).length;
  const contractIncomplete = bundles.filter((b) => b.deliveryStatus?.startsWith("skipped: CONTRACT DATA INCOMPLETE")).length;
  const contractMismatch = bundles.filter((b) => b.deliveryStatus?.startsWith("skipped: contract identity mismatch")).length;
  const tickersWithCanonical = runResults.filter((r) => (r.canonical ?? 0) > 0).length;
  const gateReason = optionsDeliveryGateReason(process.env, discordWebhookConfigured("options"));
  const funnel: CalloutFunnel = {
    tickersConsidered: requestedTickers.length,
    chainsOk: tickerResults.filter((r) => r.ok).length,
    chainsFailed: tickerResults.filter((r) => !r.ok).length,
    tickersWithCanonical,
    canonical: callouts.length,
    actionable: review.actionableBeforeCollapse,
    collapsed: review.collapsedCount,
    portfolioSuppressed,
    dedupSuppressed,
    emitted: emittedCount,
    delivered,
    notActionableNow,
    contractIncomplete,
    contractMismatch,
    discordAutoSend: autoSend,
    deliveryGateReason: emittedCount > 0 && delivered === 0 ? gateReason : (autoSend ? null : gateReason),
    topReason: null,
  };
  funnel.topReason = deriveFunnelTopReason(funnel);

  return {
    bundles,
    discordAutoSend: autoSend,
    delivered,
    portfolioEligible: eligible.size,
    portfolioSuppressed: review.suppressed.length,
    paperBridge,
    laneRouting,
    execution: {
      requestedTickers,
      concurrency,
      tickerResults,
      succeeded: tickerResults.filter((r) => r.ok).length,
      failed: tickerResults.filter((r) => !r.ok).length,
      durationMs: Date.now() - runStarted,
    },
    funnel,
    suppressedItems: suppressedItems.slice(0, 100),
    note: autoSend
      ? "Supervisor is the canonical Discord path — emitted callouts deliver through the tracked ledger."
      : "Supervisor Discord delivery OFF (set CALLOUT_CANONICAL_PATH=supervisor and AGENT_CALLOUT_DISCORD=1). Desktop is the active channel; payloads are preview-ready.",
  };
}

/** One-line deterministic diagnosis of where this cycle's options funnel narrowed. */
function deriveFunnelTopReason(f: CalloutFunnel): string {
  if (f.emitted > 0 && f.delivered === 0 && f.deliveryGateReason) return `delivery blocked by config: ${f.deliveryGateReason}`;
  if (f.canonical === 0 && f.tickersConsidered > 0) return "no canonical callout (agent/selector/entry-window rejected all candidates)";
  if (f.emitted === 0 && f.canonical > 0) return `canonical but not emitted (portfolio ${f.portfolioSuppressed} / dedup ${f.dedupSuppressed})`;
  if (f.delivered === 0 && f.emitted > 0) return `emitted but not delivered (not-actionable-now ${f.notActionableNow}, contract-incomplete ${f.contractIncomplete}, mismatch ${f.contractMismatch})`;
  if (f.delivered > 0) return `${f.delivered} delivered`;
  return "idle cycle";
}
