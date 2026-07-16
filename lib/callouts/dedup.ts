/**
 * callouts/dedup.ts — deterministic callout deduplication + transition gating
 * (Phase 6). PURE. Guarantees exactly ONE message per (opportunity, meaningful
 * state): no per-agent duplicates (the Supervisor already deduped), no Simple/
 * Advanced duplicates (both render the same object), no spam from minor score
 * oscillation, and no duplicates from retries or scanner cycles (a stable
 * idempotency key per state feeds the existing delivery ledger).
 */
import type { Callout, CalloutStatus } from "./callout.ts";
import { tradingDay } from "../trading-session.ts";

/** Statuses worth pushing to Discord (desktop shows everything). */
export const EMITTABLE: ReadonlySet<CalloutStatus> = new Set<CalloutStatus>([
  "ACTIONABLE_NOW", "NEAR_TRIGGER", "DEVELOPING", "WAIT_FOR_PULLBACK", "EXTENDED",
  "RESEARCH_ONLY", "INVALIDATED",
]);

/** Meaningful transitions that warrant a follow-up update message. */
const MEANINGFUL: ReadonlySet<string> = new Set([
  "DEVELOPING>NEAR_TRIGGER",
  "NEAR_TRIGGER>ACTIONABLE_NOW",
  "DEVELOPING>ACTIONABLE_NOW",
  "WAIT_FOR_PULLBACK>ACTIONABLE_NOW",
  "ACTIONABLE_NOW>EXTENDED",
  "ACTIONABLE_NOW>INVALIDATED",
  "NEAR_TRIGGER>INVALIDATED",
  "NO_VALID_CONTRACT>ACTIONABLE_NOW",
  "NO_VALID_CONTRACT>NEAR_TRIGGER",
  "DATA_STALE>ACTIONABLE_NOW",
  "DATA_STALE>NEAR_TRIGGER",
  "MODEL_INACTIVE>MODEL_EXPERIMENTAL",
  "MODEL_EXPERIMENTAL>ACTIONABLE_NOW",
]);

export function isMeaningfulTransition(from: CalloutStatus, to: CalloutStatus): boolean {
  if (from === to) return false;
  if (MEANINGFUL.has(`${from}>${to}`)) return true;
  // Any first-time move INTO an emittable status is meaningful.
  return EMITTABLE.has(to);
}

export interface PriorCallout {
  status: CalloutStatus;
  lastEmitMs: number;
}

export interface EmissionDecision {
  emit: boolean;
  kind: "new" | "update" | "suppress";
  idempotencyKey: string;
  reason: string;
}

/**
 * One stable key per (opportunity, status, TRADING DAY) — retries/cycles within a
 * session dedup; a real state change is a new key; and a NEW trading day is a new
 * key so a recurring actionable setup can re-alert once per session. This mirrors
 * the paper bridge's day-stamped `candidateIdempotencyKey`; without the day the
 * delivery ledger would suppress today's first alert for anything that already
 * fired on a prior day, which is a silent cross-day zero-notification failure.
 */
export function calloutIdempotencyKey(c: Callout, nowMs: number = Date.now()): string {
  return `callout:${c.key}:${c.status}:${tradingDay(nowMs)}`;
}

/**
 * Decide whether to emit a Discord message for this callout given its prior state.
 * Cooldown suppresses re-emitting the SAME status within the window.
 */
export function decideEmission(c: Callout, prior: PriorCallout | undefined, opts: { nowMs: number; cooldownMs?: number }): EmissionDecision {
  const cooldownMs = opts.cooldownMs ?? 5 * 60_000;
  const idempotencyKey = calloutIdempotencyKey(c, opts.nowMs);

  if (!EMITTABLE.has(c.status)) {
    return { emit: false, kind: "suppress", idempotencyKey, reason: `status ${c.status} is not a Discord-emittable state` };
  }
  if (!prior) {
    return { emit: true, kind: "new", idempotencyKey, reason: "first emittable observation of this opportunity" };
  }
  // A new trading day is a new actionable episode. Never carry a prior session's
  // emission forward as "unchanged": if the last emission was on an earlier
  // trading day, re-open the episode and emit once (the day-scoped idempotency
  // key keeps the delivery ledger from double-sending within the same session).
  if (prior.lastEmitMs > 0 && tradingDay(prior.lastEmitMs) !== tradingDay(opts.nowMs)) {
    return { emit: true, kind: "new", idempotencyKey, reason: "new trading-day episode (prior emission was a previous session)" };
  }
  if (prior.status === c.status) {
    return { emit: false, kind: "suppress", idempotencyKey, reason: "no material state change (minor score oscillation suppressed)" };
  }
  if (!isMeaningfulTransition(prior.status, c.status)) {
    return { emit: false, kind: "suppress", idempotencyKey, reason: `transition ${prior.status}→${c.status} is not material` };
  }
  if (opts.nowMs - prior.lastEmitMs < cooldownMs && prior.status === c.status) {
    return { emit: false, kind: "suppress", idempotencyKey, reason: "within cooldown for the same status" };
  }
  return { emit: true, kind: "update", idempotencyKey, reason: `material transition ${prior.status}→${c.status}` };
}

/** Advance the prior-state map after emission decisions (deterministic). */
export function nextCalloutState(callouts: Callout[], decisions: EmissionDecision[], previous: Map<string, PriorCallout> | undefined, nowMs: number): Map<string, PriorCallout> {
  const next = new Map<string, PriorCallout>(previous ? [...previous] : []);
  callouts.forEach((c, i) => {
    const d = decisions[i];
    const prev = next.get(c.key);
    const lastEmitMs = d.emit ? nowMs : (prev?.lastEmitMs ?? 0);
    next.set(c.key, { status: c.status, lastEmitMs });
  });
  return next;
}
