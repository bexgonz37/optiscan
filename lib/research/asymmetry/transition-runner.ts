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
  const out: TransitionRunResult = { ran: false, reason: null, casesRead: 0, transitions: 0, notified: 0, suppressed: 0, errors: [] };
  try {
    const env = deps.env ?? process.env;
    if (env[TRANSITIONS_ENABLED_ENV] !== "1") {
      out.reason = `${TRANSITIONS_ENABLED_ENV} is not set`;
      return out;
    }
    out.ran = true;
    const cases = listCasesOnDb(db, deps.sessionDate, 500);
    out.casesRead = cases.length;

    for (const c of cases) {
      try {
        const obs = await deps.observe(c);
        if (!obs) continue;
        const to = nextState(c.state, obs, c.earlyAsk);
        if (to === c.state) continue;

        const eligible = PRIVATE_NOTIFIABLE_STATES.includes(to);
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
            missingEvidence: c.missingEvidence, setupFamilyLabel: null,
          }, { memory: deps.memory ?? sharedMemory, send: deps.send, env });
          notifyOutcome = res.outcome;
          if (res.outcome === "SENT") out.notified += 1;
          else out.suppressed += 1;
        } else {
          out.suppressed += 1;
        }

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

function chasePct(entryAsk: number | null, ask: number | null): number | null {
  if (entryAsk == null || entryAsk <= 0 || ask == null) return null;
  return Math.round(((ask - entryAsk) / entryAsk) * 1000) / 10;
}
