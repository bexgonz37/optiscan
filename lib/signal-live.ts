/**
 * Live signal context — when a call fired and whether the tape is still moving.
 */

import { alertAgeMinutes, MIN_SPEED_PCT_PER_MIN, type OptionSide } from "./trade-verdict.ts";

export function calledAgoLabel(alertTime?: string | null, nowMs = Date.now()): string | null {
  const m = alertAgeMinutes({ alert_time: alertTime ?? null }, nowMs);
  if (m == null) return null;
  if (m < 1) return "just now";
  return `${m}m ago`;
}

export function calledAgoLong(alertTime?: string | null, nowMs = Date.now()): string | null {
  const short = calledAgoLabel(alertTime, nowMs);
  if (!short) return null;
  return short === "just now" ? "Called just now" : `Called ${short}`;
}

export type MomentumTone = "live" | "slow" | "stalled" | "na";

export interface MomentumStatus {
  label: string;
  tone: MomentumTone;
}

/** Is the live tape still moving the signal's way? */
export function stillMovingStatus(
  side: OptionSide,
  tape?: { shortRate?: number | null; direction?: string | null } | null,
): MomentumStatus {
  if (!tape) return { label: "—", tone: "na" };

  const rate = tape.shortRate ?? 0;
  const abs = Math.abs(rate);
  const fast = abs >= MIN_SPEED_PCT_PER_MIN;

  if (side === "NONE") {
    if (fast) return { label: "Moving", tone: "live" };
    if (abs > 0.04) return { label: "Slowing", tone: "slow" };
    return { label: "Stalled", tone: "stalled" };
  }

  const wantUp = side === "CALL";
  const aligned =
    wantUp
      ? rate > 0 && (tape.direction === "bullish" || rate > 0)
      : rate < 0 && (tape.direction === "bearish" || rate < 0);

  if (aligned && fast) return { label: "Still moving", tone: "live" };
  if (aligned && abs > 0.04) return { label: "Slowing", tone: "slow" };
  if (!aligned && fast) return { label: "Turned", tone: "stalled" };
  return { label: "Stalled", tone: "stalled" };
}

export function sideFromAlert(alert: { option_side?: string | null; direction?: string | null }): OptionSide {
  const s = String(alert.option_side ?? "").toLowerCase();
  if (s.startsWith("p")) return "PUT";
  if (s.startsWith("c")) return "CALL";
  const d = String(alert.direction ?? "").toLowerCase();
  if (d === "bearish") return "PUT";
  if (d === "bullish") return "CALL";
  return "NONE";
}
