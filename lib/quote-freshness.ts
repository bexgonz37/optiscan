import { normalizeTimestamp, type TimestampUnit } from "./timestamps.ts";

export interface QuoteFreshness {
  valid: boolean;
  ageMs: number | null;
  label: string;
  sourceUnit: TimestampUnit;
  reason: string | null;
}

export function quoteFreshness(
  quoteTimestamp: number | string | bigint | Date | null | undefined,
  nowMs: number = Date.now(),
): QuoteFreshness {
  const normalized = normalizeTimestamp(quoteTimestamp, nowMs);
  if (!normalized.valid || normalized.milliseconds == null) {
    return {
      valid: false,
      ageMs: null,
      label: "Unavailable",
      sourceUnit: normalized.sourceUnit,
      reason: normalized.reason ?? "invalid quote timestamp",
    };
  }
  const ageMs = nowMs - normalized.milliseconds;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return {
      valid: false,
      ageMs: null,
      label: "Unavailable",
      sourceUnit: normalized.sourceUnit,
      reason: "quote timestamp is in the future",
    };
  }
  return {
    valid: true,
    ageMs,
    label: `${Math.round(ageMs / 1000)}s`,
    sourceUnit: normalized.sourceUnit,
    reason: null,
  };
}

export function formatQuoteFreshness(ageMs: number | null | undefined): string {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return "Unavailable";
  return `${Math.round(ageMs / 1000)}s`;
}
