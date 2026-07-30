/** Isolated, best-effort prospective evidence writer. No live decision imports. */
import { tradingDay } from "../../trading-session.ts";

type Db = { prepare: (sql: string) => { run: (...args: any[]) => unknown } };

export type OptionsResearchObservation = {
  observedAtMs: number; symbol: string; source: string;
  direction?: string | null; thesisFingerprint?: string | null; opportunityCaseId?: string | null; alertId?: string | null;
  strategyFamily?: string | null; candidateState?: string | null; readinessState?: string | null; authorityState?: string | null;
  blockers?: string[] | null; underlyingPrice?: number | null; vwap?: number | null; vwapRelationship?: string | null;
  structureState?: string | null; momentumState?: string | null; relativeState?: string | null; optionSymbol?: string | null;
  optionType?: string | null; strike?: number | null; expiration?: string | null; optionBid?: number | null; optionAsk?: number | null;
  spreadPct?: number | null; quoteTimestampMs?: number | null; quoteAgeMs?: number | null; volume?: number | null;
  openInterest?: number | null; delta?: number | null; dte?: number | null; contractQualityState?: string | null;
  frozenEntry?: number | null; targetT1?: number | null; targetT2?: number | null; targetStop?: number | null;
  paperTradeId?: number | null; discordMessageId?: string | null; deliveryProofState?: string | null; freshnessState?: string | null;
};

/** Writes one factual lifecycle snapshot. Invalid input or any storage failure is intentionally a no-op. */
export function recordOptionsResearchObservation(db: Db, input: OptionsResearchObservation): boolean {
  try {
    if (!Number.isFinite(input.observedAtMs) || input.observedAtMs <= 0 || !input.symbol || !input.source) return false;
    const key = [input.thesisFingerprint ?? "-", input.optionSymbol ?? "-", input.candidateState ?? "-", input.observedAtMs].join("|");
    db.prepare(`INSERT OR IGNORE INTO options_research_observations (
      observation_key,observed_at_ms,session_date,symbol,direction,thesis_fingerprint,opportunity_case_id,alert_id,strategy_family,
      candidate_state,readiness_state,authority_state,blockers_json,underlying_price,vwap,vwap_relationship,structure_state,momentum_state,
      relative_state,option_symbol,option_type,strike,expiration,option_bid,option_ask,spread_pct,quote_timestamp_ms,quote_age_ms,
      volume,open_interest,delta,dte,contract_quality_state,frozen_entry,target_t1,target_t2,target_stop,paper_trade_id,discord_message_id,
      delivery_proof_state,source,freshness_state,created_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      key, input.observedAtMs, tradingDay(input.observedAtMs), input.symbol.toUpperCase(), input.direction ?? null,
      input.thesisFingerprint ?? null, input.opportunityCaseId ?? null, input.alertId ?? null, input.strategyFamily ?? null,
      input.candidateState ?? null, input.readinessState ?? null, input.authorityState ?? null, input.blockers ? JSON.stringify(input.blockers) : null,
      input.underlyingPrice ?? null, input.vwap ?? null, input.vwapRelationship ?? null, input.structureState ?? null, input.momentumState ?? null,
      input.relativeState ?? null, input.optionSymbol ?? null, input.optionType ?? null, input.strike ?? null, input.expiration ?? null,
      input.optionBid ?? null, input.optionAsk ?? null, input.spreadPct ?? null, input.quoteTimestampMs ?? null, input.quoteAgeMs ?? null,
      input.volume ?? null, input.openInterest ?? null, input.delta ?? null, input.dte ?? null, input.contractQualityState ?? null,
      input.frozenEntry ?? null, input.targetT1 ?? null, input.targetT2 ?? null, input.targetStop ?? null, input.paperTradeId ?? null,
      input.discordMessageId ?? null, input.deliveryProofState ?? null, input.source, input.freshnessState ?? null, Date.now(),
    );
    return true;
  } catch { return false; }
}
