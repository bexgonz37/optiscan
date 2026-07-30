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

function formatEtTime(timestampMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(timestampMs)).replace(" AM", " a.m.").replace(" PM", " p.m.");
}

export function formatReturnMilestoneUpdate(input: {
  symbol: string;
  optionType: "CALL" | "PUT" | string;
  strike: number | null;
  milestonePercent: number;
  summary: OpportunitySummary;
  opportunityCaseId?: string | null;
  eventLabel?: "TARGET 1 HIT" | "TARGET 2 HIT" | "NEW HIGH" | string;
  detailUrl?: string | null;
  includeInternalLink?: boolean;
  eventAtMs?: number | null;
  deliveredAtMs?: number | null;
  delayedDelivery?: boolean;
}): string {
  const sym = input.symbol.toUpperCase();
  const side = String(input.optionType || "").toUpperCase() === "PUT" ? "PUT" : "CALL";
  const entry = fmtMoney(input.summary.frozenEntry);
  const mark = fmtMoney(input.summary.currentMark);
  const label = input.eventLabel ?? `+${input.milestonePercent}% MILESTONE`;
  const delayed = input.delayedDelivery === true
    && input.eventAtMs != null
    && Number.isFinite(input.eventAtMs);
  const lines = [
    `🏁 ${sym} ${side} · ${label}`,
    "",
    ...(delayed ? [`Hit at: ${formatEtTime(input.eventAtMs as number)} ET`] : []),
    `Entry: ${entry}`,
    `${delayed ? "Mark at hit" : "Current"}: ${mark}`,
    `Move: ${fmtPct(input.summary.currentReturnPct ?? input.milestonePercent)}`,
    "",
    ...(delayed ? ["Delayed delivery after market close.", ""] : []),
    "Educational purposes only. Options are high risk.",
  ];
  if (input.includeInternalLink === true && input.detailUrl) {
    lines.push(`View details: ${input.detailUrl}`);
  }
  return lines.join("\n");
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
  detailUrl?: string | null;
  includeInternalLink?: boolean;
}): string {
  const sym = input.symbol.toUpperCase();
  const side = String(input.optionType || "").toUpperCase() === "PUT" ? "PUT" : "CALL";
  const reason = String(input.exitReason ?? "").toLowerCase();
  const stopped = input.invalidated || reason === "stop_hit";
  const targetHit = reason === "target_hit";
  const winner = !stopped && !targetHit && (input.summary.currentReturnPct ?? 0) > 0;
  const heading = stopped
    ? `⛔ ${sym} ${side} · STOPPED`
    : targetHit
      ? `🏁 ${sym} ${side} · TARGET 1 HIT`
      : winner
        ? `✅ ${sym} ${side} · CLOSED WINNER`
        : `⚪ ${sym} ${side} · CLOSED`;
  const lines = [
    heading,
    "",
    `Entry: ${fmtMoney(input.summary.frozenEntry)}`,
    `${stopped || winner ? "Exit" : "Current"}: ${fmtMoney(input.summary.currentMark)}`,
    `${stopped || winner ? "Result" : "Move"}: ${fmtPct(input.summary.currentReturnPct)}`,
    "",
    "Educational purposes only. Options are high risk.",
  ];
  if (input.includeInternalLink === true && input.detailUrl) {
    lines.push(`View details: ${input.detailUrl}`);
  }
  return lines.join("\n");
}
