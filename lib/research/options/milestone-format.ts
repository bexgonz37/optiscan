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

const mmdd = (iso: string): string => {
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}` : String(iso);
};

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

/**
 * Discord copy when a position closes. Replies to the opening alert when possible.
 *
 * ── The lifecycle this message is allowed to describe ────────────────────────
 *
 * Production risk logic exits the ENTIRE position at Target 1 (`decideOptionExit`: the
 * first branch that matches sets status EXITED and writes an exit fill). There is no
 * partial exit, no runner, and no profit-lock anywhere in the live path. So every close
 * this function describes is terminal, and it says so: `TARGET 1 HIT / CLOSED`,
 * `STOPPED / CLOSED`, `TIME STOP / CLOSED`, `EXPIRED / CLOSED`. A bare "TARGET 1 HIT"
 * reads as a milestone in an ongoing trade and invites the reader to wonder what happens
 * at Target 2 — the answer is nothing, because there is no position left.
 *
 * The message also repeats the exact contract identity. A lifecycle update that names only
 * the symbol and side cannot be matched to its opening when two strikes on one underlying
 * are live, which is precisely when getting it wrong matters.
 */
export function formatOpportunityClosedUpdate(input: {
  symbol: string;
  optionType: "CALL" | "PUT" | string;
  strike: number | null;
  /** The exact OCC the opening named. Carried verbatim so identity survives the lifecycle. */
  optionSymbol?: string | null;
  expiration?: string | null;
  summary: OpportunitySummary;
  exitReason?: string | null;
  opportunityCaseId?: string | null;
  invalidated?: boolean;
  detailUrl?: string | null;
  includeInternalLink?: boolean;
  /** Which lane this close belongs to, when it is not the subscriber lane. */
  lane?: string | null;
}): string {
  const sym = input.symbol.toUpperCase();
  const side = String(input.optionType || "").toUpperCase() === "PUT" ? "PUT" : "CALL";
  const reason = String(input.exitReason ?? "").toLowerCase();
  const stopped = input.invalidated || reason === "stop_hit";
  const targetHit = reason === "target_hit";
  const timeStop = reason === "time_stop";
  const expired = reason === "expiration" || reason === "expiration_no_quote";
  const winner = !stopped && !targetHit && (input.summary.currentReturnPct ?? 0) > 0;
  const heading = stopped
    ? `⛔ ${sym} ${side} · STOPPED / CLOSED`
    : targetHit
      ? `🏁 ${sym} ${side} · TARGET 1 HIT / CLOSED`
      : timeStop
        ? `⏹️ ${sym} ${side} · TIME STOP / CLOSED`
        : expired
          ? `⚪ ${sym} ${side} · EXPIRED / CLOSED`
          : winner
            ? `✅ ${sym} ${side} · CLOSED WINNER`
            : `⚪ ${sym} ${side} · CLOSED`;
  const contractLine = [
    input.expiration ? mmdd(input.expiration) : null,
    input.strike != null && Number.isFinite(input.strike) ? `$${Number(input.strike.toFixed(2))}` : null,
    side === "PUT" ? "Put" : "Call",
  ].filter(Boolean).join(" ");
  const lines = [
    heading,
    "",
    ...(contractLine.trim() ? [`${sym} ${contractLine}`] : []),
    ...(input.optionSymbol ? [`Contract: ${input.optionSymbol}`] : []),
    // The internal case id rides along on OWNER-lane copy only, exactly as the opening
    // does: `formatPrivateLiveAlert` prints `Case:` for non-subscriber-grade openings and
    // omits it for subscriber-grade ones. Subscriber-facing lifecycle copy carries no
    // internal identifier, and a test asserts that.
    ...(input.lane && input.opportunityCaseId ? [`Case: ${input.opportunityCaseId}`] : []),
    ...(input.lane ? [`Lane: ${input.lane}`] : []),
    `Entry: ${fmtMoney(input.summary.frozenEntry)} (frozen entry)`,
    `Exit: ${fmtMoney(input.summary.currentMark)}`,
    `Result: ${fmtPct(input.summary.currentReturnPct)}`,
    // Stated once, plainly, so no reader is left holding a position the system already
    // closed. This is the whole reason Target 2 is never presented as a live target.
    "Position fully closed. Nothing is held past Target 1.",
    "",
    "Educational purposes only. Options are high risk.",
  ];
  if (input.includeInternalLink === true && input.detailUrl) {
    lines.push(`View details: ${input.detailUrl}`);
  }
  return lines.join("\n");
}
