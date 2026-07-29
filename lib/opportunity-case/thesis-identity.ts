/**
 * Broad, session-scoped identity that owns opening-message behavior.
 * Exact contract and strategy identity remains in opportunity-case/identity.ts.
 */
import { tradingDay } from "../trading-session.ts";

export interface OpportunityThesisIdentity {
  symbol: string;
  direction: "BULLISH" | "BEARISH";
  optionType: "CALL" | "PUT";
  sessionDate: string;
}

export interface OpportunityThesisIdentityInput {
  symbol: string;
  side: "call" | "put";
  nowMs: number;
  direction?: "bullish" | "bearish" | "neutral" | null;
  sessionDate?: string | null;
}

function djb2(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (((hash << 5) + hash) ^ value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export function buildOpportunityThesisIdentity(
  input: OpportunityThesisIdentityInput,
): OpportunityThesisIdentity {
  const optionType = input.side === "put" ? "PUT" : "CALL";
  const direction = input.direction === "bearish"
    ? "BEARISH"
    : input.direction === "bullish"
      ? "BULLISH"
      : input.side === "put"
        ? "BEARISH"
        : "BULLISH";
  return {
    symbol: String(input.symbol ?? "").trim().toUpperCase(),
    direction,
    optionType,
    sessionDate: input.sessionDate ?? tradingDay(input.nowMs),
  };
}

export function canonicalizeOpportunityThesisIdentity(
  identity: OpportunityThesisIdentity,
): string {
  return [
    identity.symbol,
    identity.direction,
    identity.optionType,
    identity.sessionDate || "NA",
  ].join("|");
}

export function opportunityThesisFingerprint(
  identity: OpportunityThesisIdentity,
): string {
  return `ot_${djb2(canonicalizeOpportunityThesisIdentity(identity))}`;
}
