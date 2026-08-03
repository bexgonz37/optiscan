/**
 * discovery-monitor.ts — the alarm that would have caught 2026-08-03 the same day.
 *
 * The defect was not subtle in hindsight: SPY produced 98 bullish candidate rows
 * and zero priced calls, for six and a half hours, in silence. Nothing in the
 * system considered "this lane is directionally bullish and has never once
 * reached a call contract" to be worth saying out loud, so the owner found out
 * from Twitter.
 *
 * This monitor is that missing sentence. It is deterministic, reads PERSISTED
 * EVIDENCE ONLY, and makes zero provider calls — it can therefore run while the
 * minute cap is saturated, including when the thing it is reporting on is the
 * budget.
 *
 * IT HAS NO AUTHORITY. It may raise a diagnostic case and notify the owner
 * privately. It may not send a subscriber alert, choose a contract, weaken a
 * gate, alter production, or bypass the regular scanner. A directional lane
 * producing no contracts is a claim that discovery is broken, never a claim that
 * a trade should be taken.
 */
import { indicatesDiscoveryDefect, type ContractFunnelEvidence } from "./contract-discovery.ts";

export type DiscoveryAlertKind =
  | "BULLISH_CANDIDATES_NO_CALLS"
  | "BEARISH_CANDIDATES_NO_PUTS"
  | "WRONG_SIDE_ONLY"
  | "PAGE_LIMIT_REPEATED"
  | "NO_ELIGIBLE_CONTRACT_SPIKE"
  | "GREEKS_MISSING_ON_SIDE"
  | "RANKING_EMPTY_AFTER_VALID_CANDIDATES";

export type DiscoverySeverity = "INFO" | "WARN" | "CRITICAL";

export interface DiscoveryAlert {
  kind: DiscoveryAlertKind;
  severity: DiscoverySeverity;
  symbol: string;
  windowMs: number;
  candidatesSeen: number;
  contractsPriced: number;
  message: string;
  /** Always false. Recorded so the invariant is auditable, not merely promised. */
  subscriberGateBypassed: boolean;
  evidenceSample: string[];
}

export interface MonitorThresholds {
  /** Candidates on one side before "zero contracts" is material rather than quiet. */
  minCandidates: number;
  /** Share of candidates ending with no eligible contract that counts as a spike. */
  noEligibleRateWarn: number;
  /** Repeated page-limit hits before truncation is called out. */
  pageLimitCount: number;
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  minCandidates: 10,
  noEligibleRateWarn: 0.5,
  pageLimitCount: 3,
};

/**
 * Evaluate one symbol's contract-funnel evidence over a window.
 *
 * `candidatesSeen` counts candidates that REACHED contract discovery on the given
 * side — a lane that never produced a directional candidate is quiet, not broken,
 * and reporting it would train the owner to ignore this monitor.
 */
export function evaluateDiscoveryHealth(
  symbol: string,
  side: "call" | "put",
  evidence: ContractFunnelEvidence[],
  windowMs: number,
  thresholds: MonitorThresholds = DEFAULT_THRESHOLDS,
): DiscoveryAlert[] {
  const alerts: DiscoveryAlert[] = [];
  const mine = evidence.filter((e) => e.requestedSide === side);
  const candidatesSeen = mine.length;
  if (candidatesSeen === 0) return alerts;

  const priced = mine.filter((e) => e.terminalReason === "CONTRACT_SELECTED").length;
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  const sample = (list: ContractFunnelEvidence[]): string[] =>
    [...new Set(list.map((e) => e.terminalReason))].slice(0, 5);

  // 1. The 2026-08-03 signature: a directional lane that never reached a contract.
  if (candidatesSeen >= thresholds.minCandidates && priced === 0) {
    alerts.push({
      kind: side === "call" ? "BULLISH_CANDIDATES_NO_CALLS" : "BEARISH_CANDIDATES_NO_PUTS",
      severity: "CRITICAL",
      symbol, windowMs, candidatesSeen, contractsPriced: 0,
      message:
        `${symbol} generated ${candidatesSeen} ${side === "call" ? "bullish" : "bearish"} candidates in ` +
        `${minutes} minutes, but zero ${side}s reached pricing. Contract discovery may be incomplete. ` +
        `No subscriber gate was bypassed.`,
      subscriberGateBypassed: false,
      evidenceSample: sample(mine),
    });
  }

  // 2. The provider returned the wrong side, or nothing on the side we asked for.
  const wrongSide = mine.filter(
    (e) => e.terminalReason === "NO_CALLS_RETURNED" ||
      e.terminalReason === "NO_PUTS_RETURNED" ||
      e.terminalReason === "WRONG_SIDE_RETURNED",
  );
  if (wrongSide.length > 0) {
    alerts.push({
      kind: "WRONG_SIDE_ONLY",
      severity: "CRITICAL",
      symbol, windowMs, candidatesSeen, contractsPriced: priced,
      message:
        `${symbol}: ${wrongSide.length}/${candidatesSeen} ${side} searches received no ${side} contracts ` +
        `from the provider. This is a discovery fault, not an absence of opportunity.`,
      subscriberGateBypassed: false,
      evidenceSample: sample(wrongSide),
    });
  }

  // 3. Greeks missing across a whole side — the measured 0DTE cause.
  const greeksMissing = mine.filter((e) => e.greeksMissingOnSide);
  if (greeksMissing.length >= thresholds.minCandidates) {
    alerts.push({
      kind: "GREEKS_MISSING_ON_SIDE",
      severity: greeksMissing.some((e) => e.terminalReason !== "CONTRACT_SELECTED") ? "WARN" : "INFO",
      symbol, windowMs, candidatesSeen, contractsPriced: priced,
      message:
        `${symbol}: ${greeksMissing.length}/${candidatesSeen} ${side} searches found tradeable contracts ` +
        `with NO provider greeks. Selection fell back to the moneyness proxy where a spot price existed.`,
      subscriberGateBypassed: false,
      evidenceSample: sample(greeksMissing),
    });
  }

  // 4. Repeated truncation.
  const truncated = mine.filter(
    (e) => e.pageLimitReached || e.terminalReason === "CHAIN_TRUNCATION_SUSPECTED" || e.terminalReason === "PAGE_LIMIT_REACHED",
  );
  if (truncated.length >= thresholds.pageLimitCount) {
    alerts.push({
      kind: "PAGE_LIMIT_REPEATED",
      severity: "WARN",
      symbol, windowMs, candidatesSeen, contractsPriced: priced,
      message: `${symbol}: chain page limit reached on ${truncated.length} ${side} searches — discovery may be truncated.`,
      subscriberGateBypassed: false,
      evidenceSample: sample(truncated),
    });
  }

  // 5. A spike in no-eligible-contract that is NOT explained by correct rejection.
  const defective = mine.filter((e) => indicatesDiscoveryDefect(e));
  const rate = defective.length / candidatesSeen;
  if (candidatesSeen >= thresholds.minCandidates && rate >= thresholds.noEligibleRateWarn && priced > 0) {
    alerts.push({
      kind: "NO_ELIGIBLE_CONTRACT_SPIKE",
      severity: "WARN",
      symbol, windowMs, candidatesSeen, contractsPriced: priced,
      message:
        `${symbol}: ${(rate * 100).toFixed(1)}% of ${side} searches ended in a discovery fault ` +
        `(${defective.length}/${candidatesSeen}). Correct rejections are excluded from this rate.`,
      subscriberGateBypassed: false,
      evidenceSample: sample(defective),
    });
  }

  // 6. Contracts arrived and were tradeable, but ranking received nothing.
  const emptyRanking = mine.filter((e) => e.twoSided > 0 && e.rankedCount === 0 && e.terminalReason !== "CONTRACT_SELECTED");
  if (emptyRanking.length >= thresholds.minCandidates) {
    alerts.push({
      kind: "RANKING_EMPTY_AFTER_VALID_CANDIDATES",
      severity: "CRITICAL",
      symbol, windowMs, candidatesSeen, contractsPriced: priced,
      message:
        `${symbol}: ${emptyRanking.length} ${side} searches had two-sided markets but ranking received zero contracts.`,
      subscriberGateBypassed: false,
      evidenceSample: sample(emptyRanking),
    });
  }

  return alerts;
}

/** Highest severity first, so an owner reading the top line reads the worst news. */
export function rankAlerts(alerts: DiscoveryAlert[]): DiscoveryAlert[] {
  const order: Record<DiscoverySeverity, number> = { CRITICAL: 0, WARN: 1, INFO: 2 };
  return [...alerts].sort((a, b) => order[a.severity] - order[b.severity]);
}
