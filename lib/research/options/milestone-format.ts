/**
 * Concise Discord copy for Opportunity lifecycle updates.
 * Reads from Opportunity Summary — does not invent performance.
 */
import type { OpportunitySummary } from "../../opportunity-case/summary.ts";

function fmtMoney(n: number | null | undefined): string {
  return n != null && Number.isFinite(n) ? `$${n.toFixed(2)}` : "n/a";
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export function formatReturnMilestoneUpdate(input: {
  symbol: string;
  optionType: "CALL" | "PUT" | string;
  strike: number | null;
  milestonePercent: number;
  summary: OpportunitySummary;
  opportunityCaseId?: string | null;
}): string {
  const sym = input.symbol.toUpperCase();
  const strike = input.strike != null ? String(input.strike) : "?";
  const side = String(input.optionType || "").toUpperCase() === "PUT" ? "P" : "C";
  const entry = fmtMoney(input.summary.frozenEntry);
  const mark = fmtMoney(input.summary.currentMark);
  const high = input.summary.maxReturnPct != null && input.summary.frozenEntry != null
    ? fmtMoney(input.summary.frozenEntry * (1 + input.summary.maxReturnPct / 100))
    : "n/a";
  const thesis = (input.summary.originalThesis ?? []).slice(0, 3).map((t) => `• ${t}`).join("\n");
  const ref = input.opportunityCaseId ? `\nRef: ${input.opportunityCaseId}` : "";
  return [
    `**${sym} UPDATE**`,
    `The original ${sym} ${strike}${side} opportunity is now up ${input.milestonePercent}%.`,
    `Entry: ${entry}`,
    `Current mark: ${mark}`,
    `High since alert: ${high}`,
    thesis ? `Original thesis:\n${thesis}` : null,
    ref,
  ].filter(Boolean).join("\n");
}

/** Discord copy when an Opportunity Case closes (exit / invalidate). Replies to the opening alert when possible. */
export function formatOpportunityClosedUpdate(input: {
  symbol: string;
  optionType: "CALL" | "PUT" | string;
  strike: number | null;
  summary: OpportunitySummary;
  exitReason?: string | null;
  opportunityCaseId?: string | null;
  invalidated?: boolean;
}): string {
  const sym = input.symbol.toUpperCase();
  const strike = input.strike != null ? String(input.strike) : "?";
  const side = String(input.optionType || "").toUpperCase() === "PUT" ? "P" : "C";
  const status = input.invalidated ? "INVALIDATED" : "CLOSED";
  const reason = input.exitReason ? String(input.exitReason).replace(/_/g, " ") : null;
  const ref = input.opportunityCaseId ? `\nRef: ${input.opportunityCaseId}` : "";
  return [
    `**${sym} CLOSED**`,
    `The original ${sym} ${strike}${side} opportunity is now ${status}.`,
    reason ? `Exit: ${reason}` : null,
    `Entry: ${fmtMoney(input.summary.frozenEntry)}`,
    `Final mark: ${fmtMoney(input.summary.currentMark)}`,
    `Final return: ${fmtPct(input.summary.currentReturnPct)}`,
    `High since alert: ${fmtPct(input.summary.maxReturnPct)}`,
    `Evidence attached: ${input.summary.evidenceCount}`,
    ref,
  ].filter(Boolean).join("\n");
}
