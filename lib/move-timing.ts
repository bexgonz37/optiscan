export type MoveClassification =
  | "FRESH_MOVE"
  | "CONTINUATION"
  | "PULLBACK_SETUP"
  | "OLD_MOVE"
  | "EXTENDED"
  | "STALE_SIGNAL"
  | "NO_CURRENT_MOMENTUM";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function classifyMoveTiming(input: {
  direction?: "bullish" | "bearish" | "choppy" | string | null;
  shortRate?: number | null;
  instantRate?: number | null;
  surge?: number | null;
  relVol?: number | null;
  hodBreak?: boolean | null;
  lodBreak?: boolean | null;
  aboveVwap?: boolean | null;
  movePct?: number | null;
  signalDetectedAtMs?: number | null;
  lastConfirmedAtMs?: number | null;
  moveBeganAtMs?: number | null;
  dataTimestampMs?: number | null;
  nowMs?: number;
  recencyWindowMs?: number;
}): {
  classification: MoveClassification;
  statusLabel: string;
  actionable: boolean;
  signalAgeSeconds: number | null;
  moveAgeSeconds: number | null;
  reasons: string[];
} {
  const nowMs = input.nowMs ?? Date.now();
  const recencyWindowMs = input.recencyWindowMs ?? 5 * 60_000;
  const dir = input.direction === "bearish" ? "bearish" : input.direction === "bullish" ? "bullish" : "choppy";
  const alignedRate = isNum(input.shortRate)
    ? (dir === "bullish" ? input.shortRate : dir === "bearish" ? -input.shortRate : 0)
    : null;
  const alignedInstant = isNum(input.instantRate)
    ? (dir === "bullish" ? input.instantRate : dir === "bearish" ? -input.instantRate : 0)
    : null;
  const levelBreak = dir === "bullish" ? Boolean(input.hodBreak) : dir === "bearish" ? Boolean(input.lodBreak) : false;
  const volumeOk = (isNum(input.surge) && input.surge >= 1.25) || (isNum(input.relVol) && input.relVol >= 1.5);
  const liveMomentum = (alignedRate != null && alignedRate >= 0.12) || (alignedInstant != null && alignedInstant >= 0.15);
  const confirmedAt = input.lastConfirmedAtMs ?? (liveMomentum || levelBreak ? nowMs : null);
  const signalAt = input.signalDetectedAtMs ?? confirmedAt ?? null;
  const moveBeganAt = input.moveBeganAtMs ?? confirmedAt ?? null;
  const signalAgeSeconds = signalAt == null ? null : Math.max(0, Math.round((nowMs - signalAt) / 1000));
  const moveAgeSeconds = moveBeganAt == null ? null : Math.max(0, Math.round((nowMs - moveBeganAt) / 1000));
  const dataAgeSeconds = input.dataTimestampMs == null ? null : Math.max(0, Math.round((nowMs - input.dataTimestampMs) / 1000));
  const reasons: string[] = [];

  if (dataAgeSeconds != null && dataAgeSeconds > 90) {
    reasons.push(`Data is ${dataAgeSeconds}s old.`);
    return { classification: "STALE_SIGNAL", statusLabel: "DATA STALE", actionable: false, signalAgeSeconds, moveAgeSeconds, reasons };
  }
  if (dir === "choppy") {
    reasons.push("No clear live direction.");
    return { classification: "NO_CURRENT_MOMENTUM", statusLabel: "NO CURRENT MOMENTUM", actionable: false, signalAgeSeconds, moveAgeSeconds, reasons };
  }
  if (!liveMomentum) {
    reasons.push("Daily direction is not enough; recent 1-3 minute momentum is not active.");
    return { classification: "NO_CURRENT_MOMENTUM", statusLabel: "NO CURRENT MOMENTUM", actionable: false, signalAgeSeconds, moveAgeSeconds, reasons };
  }
  if (confirmedAt != null && nowMs - confirmedAt > recencyWindowMs) {
    reasons.push(`Last confirmation is ${Math.round((nowMs - confirmedAt) / 60000)} minutes old.`);
    return { classification: "OLD_MOVE", statusLabel: "OLD MOVE — WAIT FOR NEW SETUP", actionable: false, signalAgeSeconds, moveAgeSeconds, reasons };
  }
  if (moveAgeSeconds != null && moveAgeSeconds > 15 * 60 && !levelBreak) {
    reasons.push("The main move began earlier and no fresh level break is active.");
    return { classification: "OLD_MOVE", statusLabel: "OLD MOVE — WAIT FOR NEW SETUP", actionable: false, signalAgeSeconds, moveAgeSeconds, reasons };
  }
  if (Math.abs(Number(input.movePct ?? 0)) >= 8 && !levelBreak) {
    reasons.push("The day move is already large and no fresh trigger level is breaking.");
    return { classification: "EXTENDED", statusLabel: "EXTENDED — DO NOT CHASE", actionable: false, signalAgeSeconds, moveAgeSeconds, reasons };
  }
  if (!volumeOk) {
    reasons.push("Momentum needs current volume confirmation.");
    return { classification: "NO_CURRENT_MOMENTUM", statusLabel: "NO CURRENT MOMENTUM", actionable: false, signalAgeSeconds, moveAgeSeconds, reasons };
  }

  reasons.push(levelBreak ? "Fresh level break with live speed." : "Live speed and volume are aligned right now.");
  return {
    classification: levelBreak ? "FRESH_MOVE" : "CONTINUATION",
    statusLabel: levelBreak ? "FRESH MOVE" : "CONTINUATION",
    actionable: true,
    signalAgeSeconds,
    moveAgeSeconds,
    reasons,
  };
}
