/**
 * agents/supervisor.ts — the deterministic Opportunity Orchestrator (Phase 5).
 * PURE. Given every contributing AgentResult it: dedups to ONE canonical result
 * per (ticker,direction,horizon), enforces risk vetoes, applies lifecycle
 * hysteresis, and ranks — WITHOUT ever making a blocked setup actionable because
 * several agents agree, and without letting a probability override a hard gate.
 * Every contributing result is preserved for audit.
 */
import { resultKey, STATUS_RANK, type AgentResult, type CandidateStatus } from "./types.ts";

export interface PriorState {
  candidateStatus: CandidateStatus;
  since: number;
}

export interface SupervisorInput {
  results: AgentResult[];
  previous?: Map<string, PriorState>;
  nowMs: number;
  /** Downgrades from a more-advanced status are smoothed for this long. */
  hysteresisMs?: number;
}

export interface SupervisorOutput {
  canonical: AgentResult[];
  all: AgentResult[];
  audit: { key: string; contributors: number; chosenAgent: string; status: CandidateStatus }[];
}

function statusRank(s: CandidateStatus): number {
  return STATUS_RANK[s] ?? 0;
}

/** Risk veto is absolute: an ACTIONABLE result whose risk failed becomes BLOCKED/WATCH. */
function enforceRiskVeto(r: AgentResult): AgentResult {
  if (r.actionability === "ACTIONABLE" && r.riskVerdict && !r.riskVerdict.allowed) {
    return {
      ...r,
      candidateStatus: "WATCH",
      actionability: "BLOCKED",
      reasons: [`Risk veto (supervisor): ${r.riskVerdict.failures.join("; ")}`, ...r.reasons],
      riskVerdict: { ...r.riskVerdict, vetoed: true },
    };
  }
  return r;
}

/** Pick the single best contributor for a dedup key (higher status, then score). */
function pickBest(rs: AgentResult[]): AgentResult {
  return [...rs].sort((a, b) => {
    const d = statusRank(b.candidateStatus) - statusRank(a.candidateStatus);
    if (d !== 0) return d;
    const s = (b.score ?? -Infinity) - (a.score ?? -Infinity);
    if (s !== 0) return s;
    return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0; // deterministic
  })[0];
}

/** Apply hysteresis: a brief downgrade from a more-advanced prior status is held. */
function applyHysteresis(r: AgentResult, prev: PriorState | undefined, nowMs: number, hysteresisMs: number): AgentResult {
  if (!prev) return r;
  const droppedFromAdvanced = statusRank(prev.candidateStatus) > statusRank(r.candidateStatus);
  const recent = nowMs - prev.since < hysteresisMs;
  // Never hold a hard-gate status (stale/no-contract/invalidated) — safety first.
  const hardNow = ["DATA_STALE", "NO_VALID_CONTRACT", "INVALIDATED"].includes(r.candidateStatus);
  if (droppedFromAdvanced && recent && !hardNow) {
    return { ...r, candidateStatus: prev.candidateStatus, reasons: ["(held by lifecycle hysteresis)", ...r.reasons] };
  }
  return r;
}

export function superviseResults(input: SupervisorInput): SupervisorOutput {
  const hysteresisMs = input.hysteresisMs ?? 90_000;
  const all = input.results.map(enforceRiskVeto);

  const groups = new Map<string, AgentResult[]>();
  for (const r of all) {
    const k = resultKey(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const canonical: AgentResult[] = [];
  const audit: SupervisorOutput["audit"] = [];
  for (const [key, rs] of groups) {
    let best = pickBest(rs);
    best = applyHysteresis(best, input.previous?.get(key), input.nowMs, hysteresisMs);
    canonical.push(best);
    audit.push({ key, contributors: rs.length, chosenAgent: best.agentId, status: best.candidateStatus });
  }

  // Deterministic ordering: most-advanced first, then ticker/horizon.
  canonical.sort((a, b) => statusRank(b.candidateStatus) - statusRank(a.candidateStatus)
    || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0)
    || (a.horizon < b.horizon ? -1 : a.horizon > b.horizon ? 1 : 0));

  return { canonical, all, audit };
}

/** Build the next prior-state map from canonical results (for the next tick's hysteresis). */
export function nextPriorState(canonical: AgentResult[], previous: Map<string, PriorState> | undefined, nowMs: number): Map<string, PriorState> {
  const next = new Map<string, PriorState>();
  for (const r of canonical) {
    const k = resultKey(r);
    const prev = previous?.get(k);
    // `since` resets only when the status actually changes (stable ordering / no churn).
    const since = prev && prev.candidateStatus === r.candidateStatus ? prev.since : nowMs;
    next.set(k, { candidateStatus: r.candidateStatus, since });
  }
  return next;
}
