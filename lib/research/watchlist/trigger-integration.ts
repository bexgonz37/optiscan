/**
 * trigger-integration.ts — the ONLY connection between a Watchlist trigger and
 * the rest of the system, and deliberately a narrow one.
 *
 * What this module does:
 *   - evaluates a crossing against the published row (trigger-lifecycle.ts)
 *   - records the research outcome (outcomes.ts / professional-store.ts)
 *   - returns a HANDOFF describing a row the canonical path MAY consider
 *
 * What this module cannot do, structurally:
 *   - send a Discord message
 *   - create, freeze, or mutate an alert, entry, stop, or target
 *   - select an option contract
 *   - write paper trades or claim a subscriber result
 *
 * It imports nothing from delivery, notifications, callouts, scanner, authority,
 * or paper modules, and a test enforces that. A triggered level therefore cannot
 * produce a subscriber SEND here: the existing canonical options SEND path
 * remains the only sender, with every one of its gates intact.
 */
import {
  buildCanonicalHandoff,
  evaluateTriggerLifecycle,
  type RevalidationEvidence,
  type TriggerObservation,
  type TriggerLifecycleResult,
} from "./trigger-lifecycle.ts";
import { buildWatchlistOutcome, type CanonicalSendEvidence, type PostTriggerMovement, type WatchlistOutcome } from "./outcomes.ts";
import { recordWatchlistOutcomeOnDb } from "./professional-store.ts";
import type { WatchlistRow } from "./professional-plan.ts";

type IntegrationDb = Parameters<typeof recordWatchlistOutcomeOnDb>[0];

export interface TriggerIntegrationResult {
  lifecycle: TriggerLifecycleResult;
  outcome: WatchlistOutcome;
  /**
   * A row the canonical path may consider. `offer` true means every
   * revalidation check passed — it does NOT mean anything will be sent.
   */
  handoff: ReturnType<typeof buildCanonicalHandoff>;
  /** Always false here. Only the canonical path can produce a subscriber send. */
  subscriberSendCreated: false;
  /** Always true. Records the architectural boundary in the returned data. */
  requiresCanonicalDelivery: true;
  outcomePersisted: boolean;
  persistError: string | null;
}

/**
 * Process one observed crossing of a published Watchlist level.
 *
 * The outcome is recorded as RESEARCH. Subscriber attribution requires a
 * verified canonical SEND, which is supplied by the delivery path afterwards —
 * never asserted here.
 */
export function processWatchlistTrigger(
  db: IntegrationDb,
  row: WatchlistRow,
  observation: TriggerObservation,
  evidence: RevalidationEvidence | null,
  opts: {
    tradingDay: string;
    nowMs: number;
    /** Verified SEND evidence, only ever supplied BY the canonical path. */
    send?: CanonicalSendEvidence | null;
    movement?: PostTriggerMovement | null;
    sessionComplete?: boolean;
  },
): TriggerIntegrationResult {
  const lifecycle = evaluateTriggerLifecycle(row, observation, evidence);

  const outcome = buildWatchlistOutcome({
    row,
    tradingDay: opts.tradingDay,
    triggeredSide: lifecycle.triggered ? observation.side : null,
    triggeredAtMs: lifecycle.triggered ? observation.observedAtMs : null,
    invalidated: false,
    send: opts.send ?? null,
    movement: opts.movement ?? null,
    sessionComplete: opts.sessionComplete ?? false,
  });

  const persist = recordWatchlistOutcomeOnDb(db, outcome, opts.nowMs);

  return {
    lifecycle,
    outcome,
    handoff: buildCanonicalHandoff(lifecycle),
    subscriberSendCreated: false,
    requiresCanonicalDelivery: true,
    outcomePersisted: persist.persisted,
    persistError: persist.error,
  };
}

/**
 * Record a published setup that was invalidated before it could trigger.
 * Research bookkeeping only.
 */
export function recordWatchlistInvalidation(
  db: IntegrationDb,
  row: WatchlistRow,
  reason: string,
  opts: { tradingDay: string; nowMs: number },
): { outcome: WatchlistOutcome; persisted: boolean } {
  const outcome = buildWatchlistOutcome({
    row,
    tradingDay: opts.tradingDay,
    triggeredSide: null,
    triggeredAtMs: null,
    invalidated: true,
    invalidationReason: reason,
    send: null,
    sessionComplete: true,
  });
  const persist = recordWatchlistOutcomeOnDb(db, outcome, opts.nowMs);
  return { outcome, persisted: persist.persisted };
}
