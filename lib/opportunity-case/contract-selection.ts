/**
 * Contract selection with explicit rejection reason codes.
 */
import type { RejectedContract, SelectedContract } from "./schema.ts";

export interface ContractCandidate {
  optionSymbol: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  delta: number | null;
  openInterest: number | null;
  volume: number | null;
}

export interface ContractSelectionConfig {
  maxSpreadPct: number;
  minOpenInterest: number;
  minVolume: number;
  maxQuoteAgeMs: number;
}

export const DEFAULT_CONTRACT_SELECTION_CONFIG: ContractSelectionConfig = {
  maxSpreadPct: 12,
  minOpenInterest: 100,
  minVolume: 10,
  maxQuoteAgeMs: 120_000,
};

export interface ContractSelectionResult {
  selected: SelectedContract | null;
  rejected: RejectedContract[];
}

export function selectContractWithAudit(
  candidates: ContractCandidate[],
  cfg: ContractSelectionConfig = DEFAULT_CONTRACT_SELECTION_CONFIG,
  nowMs = Date.now(),
  quoteTimestamps: Record<string, number> = {},
): ContractSelectionResult {
  const rejected: RejectedContract[] = [];
  const viable: ContractCandidate[] = [];

  for (const c of candidates) {
    if ((c.bid ?? 0) <= 0 || (c.ask ?? 0) <= 0) {
      rejected.push({ optionSymbol: c.optionSymbol, reasonCode: "no_two_sided_quote", explanation: "Missing usable bid/ask" });
      continue;
    }
    if (c.spreadPct != null && c.spreadPct > cfg.maxSpreadPct) {
      rejected.push({ optionSymbol: c.optionSymbol, reasonCode: "spread_too_wide", explanation: `Spread ${c.spreadPct}% > ${cfg.maxSpreadPct}%` });
      continue;
    }
    if ((c.openInterest ?? 0) < cfg.minOpenInterest) {
      rejected.push({ optionSymbol: c.optionSymbol, reasonCode: "insufficient_open_interest", explanation: `OI ${c.openInterest ?? 0} < ${cfg.minOpenInterest}` });
      continue;
    }
    if ((c.volume ?? 0) < cfg.minVolume) {
      rejected.push({ optionSymbol: c.optionSymbol, reasonCode: "insufficient_volume", explanation: `Volume ${c.volume ?? 0} < ${cfg.minVolume}` });
      continue;
    }
    const ts = quoteTimestamps[c.optionSymbol];
    if (ts != null && nowMs - ts > cfg.maxQuoteAgeMs) {
      rejected.push({ optionSymbol: c.optionSymbol, reasonCode: "stale_quote", explanation: "Quote exceeded max age" });
      continue;
    }
    viable.push(c);
  }

  if (viable.length === 0) return { selected: null, rejected };

  const best = viable.sort((a, b) => (a.spreadPct ?? 999) - (b.spreadPct ?? 999))[0];
  return {
    selected: {
      optionSymbol: best.optionSymbol,
      side: best.side,
      strike: best.strike,
      expiration: best.expiration,
      dte: best.dte,
      bid: best.bid,
      ask: best.ask,
      spreadPct: best.spreadPct,
      delta: best.delta,
      openInterest: best.openInterest,
      volume: best.volume,
      selectionReason: "lowest_spread_among_viable",
    },
    rejected,
  };
}
