/**
 * Deterministic live opportunity identity for one active Discord opportunity.
 * PURE: no I/O. Entry price is intentionally excluded from identity.
 */
import { tradingDay } from "../trading-session.ts";

export type OpportunityDirection = "BULLISH" | "BEARISH";
export type OpportunityOptionType = "CALL" | "PUT";

export interface OpportunityIdentity {
  symbol: string;
  direction: OpportunityDirection;
  optionType: OpportunityOptionType;
  expiration: string;
  strike: number;
  strategyKey: string;
  sessionDate: string;
}

export interface OpportunityIdentityInput {
  symbol: string;
  side: "call" | "put";
  expiration: string;
  strike: number;
  strategyKey: string;
  nowMs: number;
  direction?: "bullish" | "bearish" | "neutral" | null;
  sessionDate?: string | null;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function directionFromSide(
  side: "call" | "put",
  direction?: "bullish" | "bearish" | "neutral" | null,
): OpportunityDirection {
  if (direction === "bearish") return "BEARISH";
  if (direction === "bullish") return "BULLISH";
  return side === "put" ? "BEARISH" : "BULLISH";
}

export function buildOpportunityIdentity(input: OpportunityIdentityInput): OpportunityIdentity {
  const optionType: OpportunityOptionType = input.side === "put" ? "PUT" : "CALL";
  return {
    symbol: String(input.symbol ?? "").trim().toUpperCase(),
    direction: directionFromSide(input.side, input.direction),
    optionType,
    expiration: String(input.expiration ?? "").trim(),
    strike: Number(input.strike),
    strategyKey: String(input.strategyKey ?? "").trim().toLowerCase(),
    sessionDate: input.sessionDate ?? tradingDay(input.nowMs),
  };
}

/** Canonical string hashed into the fingerprint. No floats except exact strike. */
export function canonicalizeOpportunityIdentity(id: OpportunityIdentity): string {
  const strike = Number.isFinite(id.strike) ? String(id.strike) : "NA";
  return [
    id.symbol,
    id.direction,
    id.optionType,
    id.expiration || "NA",
    strike,
    id.strategyKey || "NA",
    id.sessionDate || "NA",
  ].join("|");
}

export function opportunityFingerprint(id: OpportunityIdentity): string {
  return `of_${djb2(canonicalizeOpportunityIdentity(id))}`;
}

export function opportunityCaseIdForOpen(fingerprint: string, openedAtMs: number): string {
  return `oc_${djb2(`${fingerprint}|${openedAtMs}`)}`;
}

export function isActiveLifecycleStatus(status: string | null | undefined): boolean {
  return status === "CREATED" || status === "CONFIRMED" || status === "RUNNING" || status === "EXTENDED";
}
