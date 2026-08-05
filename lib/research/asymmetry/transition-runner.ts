/**
 * transition-runner.ts — re-evaluates open cases, persists deterministic state
 * changes, and surfaces eligible ones to the owner-private channel.
 *
 *   runAsymmetryTransitions()
 *     -> listCasesOnDb()            [read]
 *     -> nextState()                [pure, deterministic]
 *     -> recordTransitionOnDb()     [write]
 *     -> notifyPrivateAsymmetry()   [only on eligible changes]
 *
 * Never throws. Every case is evaluated inside its own try/catch so one bad row
 * cannot abort the sweep, and the whole sweep is wrapped again so it can never
 * reach the caller. Off by default.
 *
 * AI HAS NO INVOLVEMENT. Every transition is a readable rule over persisted
 * evidence — the state a case lands in is reproducible from its row alone.
 */
import { listCasesOnDb, recordTransitionOnDb, type ActiveCase } from "./case-store.ts";
import { notifyPrivateAsymmetry, createPrivateCaseMemory, PRIVATE_NOTIFIABLE_STATES, type PrivateCaseMemory } from "./private-notify.ts";
import type { AsymmetryResearchState } from "./states.ts";
import { resolvePaperPermission } from "./paper/activation.ts";
import { decideNotification, resolveStrategyNotificationStrength } from "./notification-gate.ts";
import { recordNotifyDecisionOnDb, attachNotifyOutcomeOnDb } from "./notify-journal.ts";
import { isOptionsQuoteSession } from "../../market-session-guard.ts";
import { evaluateInstrumentSession, optionsSessionAllowsStrategy } from "../../instrument-session-authority.ts";

export const TRANSITIONS_ENABLED_ENV = "HIGH_ASYMMETRY_CAPTURE_ENABLED";

type RunnerDb = Parameters<typeof listCasesOnDb>[0];

/** Live evidence for one case at re-evaluation time. Absent = unknown. */
export interface CaseObservation {
  fingerprint: string;
  bid: number | null;
  ask: number | null;
  quoteAtMs: number | null;
  /** True when the published trigger level has traded. */
  triggered: boolean;
  /** True when the setup is explicitly dead. */
  invalidated: boolean;
  spreadPct: number | null;
  openInterest: number | null;
  contractVolume?: number | null;
  dte?: number | null;
  delta?: number | null;
  currentUnderlyingPrice?: number | null;
  underlyingQuoteAtMs?: number | null;
}

export interface TransitionRunResult {
  ran: boolean;
  reason: string | null;
  casesRead: number;
  /** Cases actually observed this sweep, after the quote budget. */
  casesObserved: number;
  /** Cases skipped because the sweep's quote budget was spent. */
  casesDeferredForBudget: number;
  transitions: number;
  notified: number;
  suppressed: number;
  /** Transitions captured and tracked but deliberately not surfaced. */
  silentCaptures: number;
  errors: string[];
}

/**
 * Quote requests one transition sweep may spend.
 *
 * WHY A BUDGET EXISTS HERE AT ALL. This sweep re-observes every open case on
 * every tick. Measured against real production load — 395 open cases on a
 * 60-second cadence — that is 395 requests a minute against a 280/minute cap
 * and ~154,000 a day against a 200,000/day cap SHARED WITH THE LIVE SCANNER.
 * Before the single-contract fix it was ~1,119 a minute and ~436,000 a day, so
 * the daily budget was exhausted mid-session and every research quote after
 * that failed. Research must degrade gracefully, never starve the scanner.
 *
 * When the budget is spent the remaining cases are DEFERRED, not failed: they
 * keep their state, stay in the population, and are first in line next sweep.
 */
export const DEFAULT_MAX_QUOTES_PER_SWEEP = 120;

export function resolveSweepQuoteBudget(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ASYM_MAX_QUOTES_PER_SWEEP);
  if (!Number.isFinite(n)) return DEFAULT_MAX_QUOTES_PER_SWEEP;
  return Math.max(0, Math.min(2_000, Math.floor(n)));
}

/**
 * Round-robin cursor so the budget does not always land on the same cases.
 * Module-scoped, like the notifier memory. Resetting on redeploy is harmless —
 * it only restarts the rotation.
 *
 * Fairness is a correctness property, not a nicety: a case that is never
 * observed can never transition, so a fixed-order budget would permanently
 * freeze everything past the cutoff.
 */
const sweepCursor = new Map<string, number>();

/**
 * Order cases so the ones waiting longest are served first, then wrap.
 * Pure and deterministic given a cursor.
 */
export function rotateForBudget<T>(cases: readonly T[], cursor: number, budget: number): {
  selected: T[]; nextCursor: number; deferred: number;
} {
  if (cases.length === 0 || budget <= 0) return { selected: [], nextCursor: cursor, deferred: cases.length };
  if (budget >= cases.length) return { selected: [...cases], nextCursor: 0, deferred: 0 };
  const start = ((cursor % cases.length) + cases.length) % cases.length;
  const selected: T[] = [];
  for (let i = 0; i < budget; i++) selected.push(cases[(start + i) % cases.length]);
  return { selected, nextCursor: (start + budget) % cases.length, deferred: cases.length - budget };
}

/**
 * The deterministic transition rule. Pure and total: every input maps to
 * exactly one state, and the same input always yields the same state.
 *
 * Precedence is fixed and deliberately ordered worst-first, so a case that is
 * simultaneously dead and chased reports the more fundamental problem.
 */
export function nextState(
  current: AsymmetryResearchState,
  obs: CaseObservation,
  entryAsk: number | null,
): AsymmetryResearchState {
  if (obs.invalidated) return "INVALIDATED";

  const bid = num(obs.bid);
  const ask = num(obs.ask);
  const noQuote = bid == null || ask == null || bid <= 0 || ask < bid;
  const spread = num(obs.spreadPct);
  const oi = num(obs.openInterest);
  if (noQuote || (spread != null && spread > 35) || (oi != null && oi < 1)) return "LIQUIDITY_FAILURE";

  // Premium chase: the contract has already expanded beyond the early entry, so
  // it is no longer an EARLY opportunity for anyone entering now.
  if (entryAsk != null && entryAsk > 0 && ask != null) {
    const expansion = ((ask - entryAsk) / entryAsk) * 100;
    if (expansion >= 25) return "PREMIUM_CHASE";
  }

  if (obs.triggered) return "TRIGGERED";

  // Otherwise a case only ever advances, never silently regresses to a weaker
  // state on a noisy tick.
  const rank: Record<string, number> = { INSUFFICIENT_EVIDENCE: 0, EARLY_ASYMMETRY: 1, CONFIRMING: 2, HIGH_ASYMMETRY: 3 };
  if (current in rank) {
    const promoted = rank[current] < 3 ? (["EARLY_ASYMMETRY", "CONFIRMING", "HIGH_ASYMMETRY"] as const)[Math.min(2, rank[current])] : "HIGH_ASYMMETRY";
    return promoted as AsymmetryResearchState;
  }
  return current;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function decisionFor(
  c: ActiveCase,
  obs: CaseObservation,
  to: AsymmetryResearchState,
  peakAsk: number | null,
  chase: number | null,
  nowMs: number,
  strength: ReturnType<typeof resolveStrategyNotificationStrength>,
) {
  return decideNotification({
    state: to, setupFamily: c.setupFamily, direction: c.direction,
    optionSymbol: c.optionSymbol,
    bid: obs.bid, ask: obs.ask, quoteAtMs: obs.quoteAtMs,
    underlyingPrice: c.underlyingPrice,
    spreadPct: obs.spreadPct, premiumChasePct: chase,
    openInterest: obs.openInterest, contractVolume: obs.contractVolume ?? null,
    missingEvidence: c.missingEvidence, trigger: null, invalidation: null,
    nowMs,
    entryAskAtCapture: c.earlyAsk,
    peakAskSinceCapture: peakAsk,
    firstDetectedAtMs: c.firstDetectedAtMs,
    dte: obs.dte ?? null,
    delta: obs.delta ?? c.capturedDelta,
    currentUnderlyingPrice: obs.currentUnderlyingPrice ?? null,
    underlyingQuoteAtMs: obs.underlyingQuoteAtMs ?? null,
    underlyingMoveBeforeDetectionPct: c.priorMovePct,
    roomToNextLevelPct: c.roomToNextLevelPct,
    targetT1: c.targetT1,
    targetStop: c.targetStop,
  }, strength);
}

export interface TransitionDeps {
  /** Live evidence per fingerprint. ASYNC. Null = no re-evaluation this tick. */
  observe: (c: ActiveCase) => Promise<CaseObservation | null> | CaseObservation | null;
  memory?: PrivateCaseMemory;
  send?: Parameters<typeof notifyPrivateAsymmetry>[1]["send"];
  env?: NodeJS.ProcessEnv;
  nowMs: number;
  /** Wall clock used again at each final send boundary. */
  clock?: () => number;
  sessionDate: string;
  /** Overrides the env-resolved per-sweep quote budget. For tests. */
  maxQuotesPerSweep?: number;
}

/** Module-scoped notifier memory so dedupe survives across sweeps. */
const sharedMemory = createPrivateCaseMemory();

/**
 * Sweep open cases. Never throws.
 */
export async function runAsymmetryTransitions(
  db: RunnerDb,
  deps: TransitionDeps,
): Promise<TransitionRunResult> {
  const out: TransitionRunResult = {
    ran: false, reason: null, casesRead: 0, casesObserved: 0, casesDeferredForBudget: 0,
    transitions: 0, notified: 0, suppressed: 0, silentCaptures: 0, errors: [],
  };
  try {
    const env = deps.env ?? process.env;
    if (env[TRANSITIONS_ENABLED_ENV] !== "1") {
      out.reason = `${TRANSITIONS_ENABLED_ENV} is not set`;
      return out;
    }
    if (!isOptionsQuoteSession(deps.nowMs, env)) {
      out.reason = "OPTIONS_SESSION_CLOSED";
      return out;
    }
    out.ran = true;
    // Read-only. Reported so an alert never implies a paper trade that did not
    // open; this does not influence any paper decision.
    const permission = resolvePaperPermission(db as any, deps.sessionDate, env);
    const paperStatus = !permission.masterPaperAuthorized
      ? "DISABLED" as const
      : permission.paperEntriesAllowed ? "WAITING_FOR_ENTRY" as const : "BLOCKED" as const;
    const allCases = listCasesOnDb(db, deps.sessionDate, 500);
    out.casesRead = allCases.length;

    // Spend a bounded number of quote requests per sweep, rotating so every
    // case is observed within ceil(N / budget) sweeps instead of the first N
    // winning forever.
    const budget = deps.maxQuotesPerSweep ?? resolveSweepQuoteBudget(env);
    const cursor = sweepCursor.get(deps.sessionDate) ?? 0;
    const { selected: cases, nextCursor, deferred } = rotateForBudget(allCases, cursor, budget);
    sweepCursor.set(deps.sessionDate, nextCursor);
    out.casesDeferredForBudget = deferred;

    const evaluations: Array<{
      c: ActiveCase;
      obs: CaseObservation;
      to: AsymmetryResearchState;
      peakAsk: number | null;
      chase: number | null;
      strength: ReturnType<typeof resolveStrategyNotificationStrength>;
      gate: ReturnType<typeof decideNotification>;
    }> = [];
    for (const c of cases) {
      try {
        const obs = await deps.observe(c);
        // A null observation is "no evidence this tick" — a missing quote, or a
        // request we declined to pay for. Never read as a dead setup.
        if (!obs) continue;
        out.casesObserved += 1;
        const to = nextState(c.state, obs, c.earlyAsk);
        if (to === c.state) continue;

        // CAPTURE AND SPEAK ARE SEPARATE DECISIONS. Whatever this returns, the
        // transition below is still persisted and the case stays in the
        // research population — only the Discord message is affected.
        const peakAsk = peakAskFromMarks(db, c.sessionDate, c.fingerprint);
        const chase = chasePct(c.earlyAsk, obs.ask);
        const strength = resolveStrategyNotificationStrength(c.setupFamily, env);
        const gate = decideNotification({
          state: to, setupFamily: c.setupFamily, direction: c.direction,
          optionSymbol: c.optionSymbol,
          bid: obs.bid, ask: obs.ask, quoteAtMs: obs.quoteAtMs,
          underlyingPrice: c.underlyingPrice,
          spreadPct: obs.spreadPct, premiumChasePct: chase,
          openInterest: obs.openInterest, contractVolume: obs.contractVolume ?? null,
          missingEvidence: c.missingEvidence, trigger: null, invalidation: null,
          // Current-validity inputs. Both come from rows the system already
          // wrote — no provider call is added to send a message.
          nowMs: deps.nowMs,
          entryAskAtCapture: c.earlyAsk,
          peakAskSinceCapture: peakAsk,
          firstDetectedAtMs: c.firstDetectedAtMs,
          dte: obs.dte ?? null,
          delta: obs.delta ?? c.capturedDelta,
          currentUnderlyingPrice: obs.currentUnderlyingPrice ?? null,
          underlyingQuoteAtMs: obs.underlyingQuoteAtMs ?? null,
          underlyingMoveBeforeDetectionPct: c.priorMovePct,
          roomToNextLevelPct: c.roomToNextLevelPct,
          targetT1: c.targetT1,
          targetStop: c.targetStop,
        }, strength);
        if (!gate.notify) out.silentCaptures += 1;

        evaluations.push({ c, obs, to, peakAsk, chase, strength, gate });
      } catch (err: any) {
        // One bad observation must never abort the sweep.
        out.errors.push(`${c.fingerprint}: ${String(err?.message ?? err)}`);
      }
    }

    // Scarce immediate-message slots go to the strongest current decisions in
    // this sweep. Research persistence is unaffected: every evaluation below
    // is still journalled and transitioned, regardless of rank or send result.
    evaluations.sort((a, b) => {
      const eligible = Number(b.gate.notify) - Number(a.gate.notify);
      if (eligible !== 0) return eligible;
      const score = (b.gate.qualityScore ?? -1) - (a.gate.qualityScore ?? -1);
      if (score !== 0) return score;
      return b.c.firstDetectedAtMs - a.c.firstDetectedAtMs;
    });

    for (const evaluated of evaluations) {
      const { c, obs, to, peakAsk, chase, strength, gate } = evaluated;
      try {

        // Journal the decision WITH the thresholds that produced it, before the
        // send is attempted. Strategy thresholds and decision metrics travel
        // together so they can be judged on outcomes. A journal failure is
        // swallowed by design.
        const journal = recordNotifyDecisionOnDb(db as any, {
          sessionDate: c.sessionDate, fingerprint: c.fingerprint, decidedAtMs: deps.nowMs,
          symbol: c.symbol, optionSymbol: c.optionSymbol, direction: c.direction,
          fromState: c.state, toState: to,
          decision: gate, config: strength,
          bid: obs.bid, ask: obs.ask, quoteAtMs: obs.quoteAtMs,
          underlyingPrice: c.underlyingPrice, spreadPct: obs.spreadPct, premiumChasePct: chase,
          openInterest: obs.openInterest, contractVolume: obs.contractVolume ?? null,
          entryAskAtCapture: c.earlyAsk, peakAskSinceCapture: peakAsk,
          missingEvidenceCount: c.missingEvidence.length,
          firstDetectedAtMs: c.firstDetectedAtMs,
          setupFamily: c.setupFamily,
          currentUnderlyingPrice: obs.currentUnderlyingPrice ?? null,
          underlyingQuoteAtMs: obs.underlyingQuoteAtMs ?? null,
          dte: obs.dte ?? null,
          delta: obs.delta ?? c.capturedDelta,
          underlyingMoveBeforeDetectionPct: c.priorMovePct,
          roomToNextLevelPct: c.roomToNextLevelPct,
          targetT1: c.targetT1,
          targetStop: c.targetStop,
        });
        if (journal.error) out.errors.push(`${c.fingerprint}: journal ${journal.error}`);
        const eligible = gate.notify && PRIVATE_NOTIFIABLE_STATES.includes(to);
        let notifyOutcome: string | null = null;
        let sentAtMs: number | null = null;
        let discordMessageId: string | null = null;
        const deliveryNowMs = deps.clock?.() ?? deps.nowMs;
        const deliverySession = evaluateInstrumentSession(
          { symbol: c.symbol, optionSymbol: c.optionSymbol }, deliveryNowMs, env,
        );
        const deliveryGate = decisionFor(c, obs, to, peakAsk, chase, deliveryNowMs, strength);
        if (eligible) {
          if (!optionsSessionAllowsStrategy(deliverySession, strength.strategySessions)) {
            notifyOutcome = `SUPPRESSED_SESSION:${deliverySession.optionsState}`;
            out.suppressed += 1;
          } else if (!deliveryGate.notify) {
            notifyOutcome = `DELIVERY_REVALIDATION:${deliveryGate.action}:${deliveryGate.reason}`;
            out.suppressed += 1;
          } else {
            const res = await notifyPrivateAsymmetry({
              fingerprint: c.fingerprint, sessionDate: c.sessionDate, symbol: c.symbol,
              direction: c.direction, optionSymbol: c.optionSymbol, state: to,
              observedAtMs: deliveryNowMs,
              quoteAtMs: obs.quoteAtMs,
              underlyingQuoteAtMs: obs.underlyingQuoteAtMs ?? null,
              maxQuoteAgeMs: strength.maxQuoteAgeAtNotifyMs,
              maxUnderlyingQuoteAgeMs: strength.maxUnderlyingQuoteAgeAtNotifyMs,
              strategySessions: strength.strategySessions,
              whyEarly: `State advanced to ${to.replace(/_/g, " ").toLowerCase()} on live evidence.`,
              premiumChasePct: chasePct(c.earlyAsk, obs.ask),
              bid: obs.bid, ask: obs.ask, spreadPct: obs.spreadPct,
              openInterest: obs.openInterest, contractVolume: obs.contractVolume ?? null,
              trigger: null, invalidation: null,
              missingEvidence: c.missingEvidence, setupFamilyLabel: c.setupFamily,
              underlyingPrice: c.underlyingPrice, paperStatus,
            }, {
              memory: deps.memory ?? sharedMemory, send: deps.send, env,
              now: () => deliveryNowMs,
            });
            notifyOutcome = res.outcome;
            sentAtMs = res.outcome === "SENT" ? (res.acceptedAtMs ?? deliveryNowMs) : null;
            discordMessageId = res.discordMessageId;
            if (res.outcome === "SENT") out.notified += 1;
            else out.suppressed += 1;
          }
        } else {
          out.suppressed += 1;
          notifyOutcome = gate.reason;
        }

        // Close the journal row with what delivery actually did. Send latency
        // is the gap between DECIDING and Discord accepting — the part of
        // capture-to-notify delay that belongs to us, not to the provider.
        attachNotifyOutcomeOnDb(db as any, {
          sessionDate: c.sessionDate, fingerprint: c.fingerprint,
          toState: to, decidedAtMs: deps.nowMs,
        }, {
          notifyOutcome: notifyOutcome ?? "UNKNOWN",
          sentAtMs,
          deliveryRecheckedAtMs: deliveryNowMs,
          deliveryAction: deliveryGate.action,
          deliveryReason: deliveryGate.reason,
          optionsSessionState: deliverySession.optionsState,
          underlyingSessionState: deliverySession.underlyingState,
          discordMessageId,
        });

        const rec = recordTransitionOnDb(db, {
          sessionDate: c.sessionDate, fingerprint: c.fingerprint,
          fromState: c.state, toState: to, occurredAtMs: deps.nowMs,
          reason: null, notified: notifyOutcome === "SENT", notifyOutcome,
        });
        if (rec.created) out.transitions += 1;
        if (rec.error) out.errors.push(`${c.fingerprint}: ${rec.error}`);
      } catch (err: any) {
        // One bad case must never abort the sweep.
        out.errors.push(`${c.fingerprint}: ${String(err?.message ?? err)}`);
      }
    }
    return out;
  } catch (err: any) {
    out.errors.push(String(err?.message ?? err));
    return out;
  }
}

/**
 * Highest ask recorded since capture, from persisted marks. Read-only and
 * cheap; returns null when nothing was marked, which the gate treats as "no
 * rollover evidence" rather than as no rollover.
 */
function peakAskFromMarks(db: RunnerDb, sessionDate: string, fingerprint: string): number | null {
  try {
    const row = db.prepare(
      "SELECT MAX(ask) a FROM asymmetry_marks WHERE session_date=? AND fingerprint=? AND rejected_reason IS NULL",
    ).get(sessionDate, fingerprint) as { a?: number } | undefined;
    const v = Number(row?.a);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function chasePct(entryAsk: number | null, ask: number | null): number | null {
  if (entryAsk == null || entryAsk <= 0 || ask == null) return null;
  return Math.round(((ask - entryAsk) / entryAsk) * 1000) / 10;
}
