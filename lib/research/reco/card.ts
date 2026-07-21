/**
 * lib/research/reco/card.ts — the simple user-facing recommendation card (Analog Engine,
 * Phase E). PURE. Complex inside, simple out. It ALWAYS carries the modeled-vs-observed
 * disclosure and, when it can't act, an explicit abstention/rejection reason — it never
 * shows a contract that failed a gate or an outcome presented as a real fill.
 */
import type { AnalogExplain } from "../analog/engine.ts";
import type { SelectResult } from "./contract.ts";

export interface RecommendationCard {
  recommend: boolean;
  ticker: string;
  side: "CALL" | "PUT";
  productionEligible: boolean;
  researchOnly: boolean;
  contract: { optionSymbol: string; strike: number; expiration: string; dte: number; bid: number | null; ask: number | null; spreadPct: number | null } | null;
  entryRange: [number, number] | null;                 // marketable premium band [bid, ask]
  targets: { typicalUnderlyingMovePct: number; favorableUnderlyingMovePct: number } | null;
  invalidation: { underlyingMovePct: number; note: string } | null;
  expectedHoldingDays: number;
  confidence: number;                                   // calibrated win probability (0..1)
  analogCount: number;
  effectiveSample: number;
  medianForwardOutcome: number;
  outcomeDispersion: number;
  winRate: number;
  closestWinner: { id: string; outcome: number } | null;
  closestLoser: { id: string; outcome: number } | null;
  regimeRelevance: string;
  abstainReason: string | null;
  rejectionReason: string | null;
  outcomeBasis: string;                                 // OBSERVED underlying vs MODELED option
  modeledDisclosure: string;
  generatedAtMs: number;
}

const OUTCOME_BASIS = "Analog outcomes are OBSERVED underlying moves; the option contract is a MODELED vehicle — NOT a real historical option fill.";
const MODELED_DISCLOSURE = "Option P&L is modeled from the underlying path + current Greeks. Modeled ≠ real fill. Paper research only; no live execution.";

export interface BuildCardInput {
  ticker: string; side: "call" | "put"; holdingDays: number;
  explain: AnalogExplain; selection: SelectResult; regimeRelevance: string; nowMs: number;
}

export function buildCard(i: BuildCardInput): RecommendationCard {
  const base = {
    ticker: i.ticker.toUpperCase(), side: (i.side.toUpperCase() as "CALL" | "PUT"),
    productionEligible: false, researchOnly: i.selection.researchOnly, contract: null,
    entryRange: null, targets: null, invalidation: null, expectedHoldingDays: i.holdingDays,
    confidence: +i.explain.p.toFixed(4), analogCount: i.explain.nAnalogs, effectiveSample: i.explain.effectiveSample,
    medianForwardOutcome: i.explain.p50, outcomeDispersion: i.explain.dispersion, winRate: i.explain.winRate,
    closestWinner: i.explain.nearestWin ? { id: i.explain.nearestWin.id, outcome: i.explain.nearestWin.outcome } : null,
    closestLoser: i.explain.nearestLoss ? { id: i.explain.nearestLoss.id, outcome: i.explain.nearestLoss.outcome } : null,
    regimeRelevance: i.regimeRelevance, abstainReason: null as string | null, rejectionReason: null as string | null,
    outcomeBasis: OUTCOME_BASIS, modeledDisclosure: MODELED_DISCLOSURE, generatedAtMs: i.nowMs,
  };

  // The evidence itself abstained (no confident analog) → no recommendation, explain why.
  if (i.explain.abstain) return { ...base, recommend: false, abstainReason: i.explain.reason ?? "insufficient analog evidence" };
  // A confident thesis, but no tradeable contract cleared the gates → reject, explain why.
  if (!i.selection.ok || !i.selection.contract) {
    return { ...base, recommend: false, rejectionReason: `${i.selection.rejectedGate ?? "gate"}: ${i.selection.reason ?? "no tradeable contract"}` };
  }

  const c = i.selection.contract;
  return {
    ...base,
    recommend: true,
    productionEligible: i.selection.productionEligible,
    researchOnly: i.selection.researchOnly,
    contract: { optionSymbol: c.optionSymbol, strike: c.strike, expiration: c.expiration, dte: c.dte, bid: c.bid, ask: c.ask, spreadPct: c.spreadPct },
    entryRange: c.bid != null && c.ask != null ? [c.bid, c.ask] : null,
    targets: { typicalUnderlyingMovePct: i.explain.p50, favorableUnderlyingMovePct: i.explain.p90 },
    invalidation: { underlyingMovePct: i.explain.p10, note: "underlying move that historically preceded analog failures" },
  };
}
