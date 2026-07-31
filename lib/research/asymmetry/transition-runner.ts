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
import { decideNotification, resolveNotificationStrength } from "./notification-gate.ts";
import { recordNotifyDecisionOnDb, attachNotifyOutcomeOnDb } from "./notify-journal.ts";

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
}

export interface TransitionRunResult {
  ran: boolean;
  reason: string | null;
  casesRead: number;
  transitions: number;
  notified: number;
  suppressed: number;
  /** Transitions captured and tracked but deliberately not surfaced. */
  silentCaptures: number;
  errors: string[];
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

export interface TransitionDeps {
  /** Live evidence per fingerprint. ASYNC. Null = no re-evaluation this tick. */
  observe: (c: ActiveCase) => Promise<CaseObservation | null> | CaseObservation | null;
  memory?: PrivateCaseMemory;
  send?: Parameters<typeof notifyPrivateAsymmetry>[1]["send"];
  env?: NodeJS.ProcessEnv;
  nowMs: number;
  sessionDate: string;
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
  const out: TransitionRunResult = { ran: false, reason: null, casesRead: 0, transitions: 0, notified: 0, suppressed: 0, silentCaptures: 0, errors: [] };
  try {
    const env = deps.env ?? process.env;
    if (env[TRANSITIONS_ENABLED_ENV] !== "1") {
      out.reason = `${TRANSITIONS_ENABLED_ENV} is not set`;
      return out;
    }
    out.ran = true;
    // Read-only. Reported so an alert never implies a paper trade that did not
    // open; this does not influence any paper decision.
    const permission = resolvePaperPermission(db as any, deps.sessionDate, env);
    const paperStatus = !permission.masterPaperAuthorized
      ? "DISABLED" as const
      : permission.paperEntriesAllowed ? "WAITING_FOR_ENTRY" as const : "BLOCKED" as const;
    const strength = resolveNotificationStrength(env);
    const cases = listCasesOnDb(db, deps.sessionDate, 500);
    out.casesRead = cases.length;

    for (const c of cases) {
      try {
        const obs = await deps.observe(c);
        if (!obs) continue;
        const to = nextState(c.state, obs, c.earlyAsk);
        if (to === c.state) continue;

        // CAPTURE AND SPEAK ARE SEPARATE DECISIONS. Whatever this returns, the
        // transition below is still persisted and the case stays in the
        // research population — only the Discord message is affected.
        const peakAsk = peakAskFromMarks(db, c.sessionDate, c.fingerprint);
        const chase = chasePct(c.earlyAsk, obs.ask);
        const gate = decideNotification({
          state: to, optionSymbol: c.optionSymbol,
          bid: obs.bid, ask: obs.ask, quoteAtMs: obs.quoteAtMs,
          underlyingPrice: c.underlyingPrice,
          spreadPct: obs.spreadPct, premiumChasePct: chase,
          openInterest: obs.openInterest, contractVolume: null,
          missingEvidence: c.missingEvidence, trigger: null, invalidation: null,
          // Current-validity inputs. Both come from rows the system already
          // wrote — no provider call is added to send a message.
          nowMs: deps.nowMs,
          entryAskAtCapture: c.earlyAsk,
          peakAskSinceCapture: peakAsk,
        }, strength);
        if (!gate.notify) out.silentCaptures += 1;

        // Journal the decision WITH the thresholds that produced it, before the
        // send is attempted. 120s and 50% are provisional defaults; this row is
        // the only way they can be judged later on real outcomes instead of on
        // one memorable example. A journal failure is swallowed by design.
        const journal = recordNotifyDecisionOnDb(db as any, {
          sessionDate: c.sessionDate, fingerprint: c.fingerprint, decidedAtMs: deps.nowMs,
          symbol: c.symbol, optionSymbol: c.optionSymbol, direction: c.direction,
          fromState: c.state, toState: to,
          decision: gate, config: strength,
          bid: obs.bid, ask: obs.ask, quoteAtMs: obs.quoteAtMs,
          underlyingPrice: c.underlyingPrice, spreadPct: obs.spreadPct, premiumChasePct: chase,
          openInterest: obs.openInterest, contractVolume: null,
          entryAskAtCapture: c.earlyAsk, peakAskSinceCapture: peakAsk,
          missingEvidenceCount: c.missingEvidence.length,
          firstDetectedAtMs: c.firstDetectedAtMs,
        });
        if (journal.error) out.errors.push(`${c.fingerprint}: journal ${journal.error}`);
        const eligible = gate.notify && PRIVATE_NOTIFIABLE_STATES.includes(to);
        let notifyOutcome: string | null = null;
        if (eligible) {
          const res = await notifyPrivateAsymmetry({
            fingerprint: c.fingerprint, sessionDate: c.sessionDate, symbol: c.symbol,
            direction: c.direction, optionSymbol: c.optionSymbol, state: to,
            observedAtMs: deps.nowMs,
            whyEarly: `State advanced to ${to.replace(/_/g, " ").toLowerCase()} on live evidence.`,
            premiumChasePct: chasePct(c.earlyAsk, obs.ask),
            bid: obs.bid, ask: obs.ask, spreadPct: obs.spreadPct,
            openInterest: obs.openInterest, contractVolume: null,
            trigger: null, invalidation: null,
            missingEvidence: c.missingEvidence, setupFamilyLabel: c.setupFamily,
            underlyingPrice: c.underlyingPrice, paperStatus,
          }, { memory: deps.memory ?? sharedMemory, send: deps.send, env });
          notifyOutcome = res.outcome;
          if (res.outcome === "SENT") out.notified += 1;
          else out.suppressed += 1;
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
          sentAtMs: notifyOutcome === "SENT" ? Date.now() : null,
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
