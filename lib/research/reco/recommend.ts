/**
 * lib/research/reco/recommend.ts — orchestrates the Phase-E recommendation: analog evidence
 * + current chain → contract selection → recommendation card, then persists it. PURE builder
 * + OnDb persist. NO live execution, ever. Puts stay research-only (contract.ts enforces).
 */
import type { AnalogExplain } from "../analog/engine.ts";
import { selectContract, type ChainSnapshot, type ContractGates } from "./contract.ts";
import { buildCard, type RecommendationCard } from "./card.ts";

export interface RecommendInput {
  ticker: string; side: "call" | "put"; holdingDays: number;
  explain: AnalogExplain; chain: ChainSnapshot;
  eventRisk?: { earningsWithinHorizon: boolean } | null;
  regimeRelevance?: string; gates?: ContractGates; nowMs?: number; env?: NodeJS.ProcessEnv;
}

export function buildRecommendation(i: RecommendInput): RecommendationCard {
  const nowMs = i.nowMs ?? Date.now();
  const selection = selectContract({ chain: i.chain, side: i.side, holdingDays: i.holdingDays, nowMs, eventRisk: i.eventRisk ?? null, gates: i.gates, env: i.env });
  return buildCard({ ticker: i.ticker, side: i.side, holdingDays: i.holdingDays, explain: i.explain, selection, regimeRelevance: i.regimeRelevance ?? "n/a", nowMs });
}

interface RecoDb { prepare(sql: string): { run: (...a: any[]) => { changes: number } } }

function djb2(s: string): string { let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, "0"); }

/** Persist a card (idempotent per rec_id). rec_id is deterministic per ticker/side/contract/day. */
export function persistRecommendationOnDb(db: RecoDb, card: RecommendationCard, tradingDay: string, nowMs: number = Date.now()): string {
  const recId = `rec_${djb2(`${card.ticker}|${card.side}|${card.contract?.optionSymbol ?? card.abstainReason ?? card.rejectionReason ?? "none"}|${tradingDay}`)}`;
  db.prepare(
    `INSERT OR IGNORE INTO recommendations
      (rec_id, ticker, side, recommend, production_eligible, research_only, option_symbol, strike, expiration, dte, bid, ask, spread_pct,
       confidence, analog_count, effective_sample, median_outcome, dispersion, win_rate, abstain_reason, rejection_reason, outcome_basis, card_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    recId, card.ticker, card.side, card.recommend ? 1 : 0, card.productionEligible ? 1 : 0, card.researchOnly ? 1 : 0,
    card.contract?.optionSymbol ?? null, card.contract?.strike ?? null, card.contract?.expiration ?? null, card.contract?.dte ?? null,
    card.contract?.bid ?? null, card.contract?.ask ?? null, card.contract?.spreadPct ?? null,
    card.confidence, card.analogCount, card.effectiveSample, card.medianForwardOutcome, card.outcomeDispersion, card.winRate,
    card.abstainReason, card.rejectionReason, card.outcomeBasis, JSON.stringify(card), nowMs,
  );
  return recId;
}
