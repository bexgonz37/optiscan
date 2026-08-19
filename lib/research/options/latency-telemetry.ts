/** Deterministic stage telemetry for the actual independent-options live path. */

export interface OptionsLatencyTrace {
  traceId: string;
  symbol: string;
  tier: 0 | 1 | 2;
  observationReceivedAtMs: number;
  candidateCreatedAtMs: number | null;
  strategyEvaluationCompletedAtMs: number | null;
  chainStartedAtMs: number | null;
  chainCompletedAtMs: number | null;
  contractSelectedAtMs: number | null;
  providerQuoteTimestampMs: number | null;
  providerQuoteAgeMs: number | null;
}

interface LatencyDb {
  prepare(sql: string): {
    run: (...args: any[]) => { changes: number };
    all: (...args: any[]) => any[];
  };
}

export function persistOptionsLatencyTraceOnDb(
  db: LatencyDb,
  trace: OptionsLatencyTrace,
  strategy: string | null,
  evaluationOutcome: string,
  nowMs: number,
): void {
  db.prepare(`
    INSERT INTO options_live_latency_traces (
      trace_id,symbol,tier,strategy,evaluation_outcome,
      observation_received_at_ms,candidate_created_at_ms,strategy_evaluation_completed_at_ms,
      chain_started_at_ms,chain_completed_at_ms,contract_selected_at_ms,
      provider_quote_timestamp_ms,provider_quote_age_ms,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(trace_id) DO UPDATE SET
      strategy=excluded.strategy,evaluation_outcome=excluded.evaluation_outcome,
      candidate_created_at_ms=excluded.candidate_created_at_ms,
      strategy_evaluation_completed_at_ms=excluded.strategy_evaluation_completed_at_ms,
      chain_started_at_ms=excluded.chain_started_at_ms,chain_completed_at_ms=excluded.chain_completed_at_ms,
      contract_selected_at_ms=excluded.contract_selected_at_ms,
      provider_quote_timestamp_ms=excluded.provider_quote_timestamp_ms,
      provider_quote_age_ms=excluded.provider_quote_age_ms,updated_at_ms=excluded.updated_at_ms
  `).run(
    trace.traceId, trace.symbol, trace.tier, strategy, evaluationOutcome,
    trace.observationReceivedAtMs, trace.candidateCreatedAtMs, trace.strategyEvaluationCompletedAtMs,
    trace.chainStartedAtMs, trace.chainCompletedAtMs, trace.contractSelectedAtMs,
    trace.providerQuoteTimestampMs, trace.providerQuoteAgeMs, nowMs, nowMs,
  );
}

export function markOptionsDeliveryDecisionOnDb(
  db: LatencyDb,
  traceId: string,
  atMs: number,
  finalDeliveryOutcome?: string | null,
  alertId?: string | null,
): void {
  db.prepare(`
    UPDATE options_live_latency_traces
    SET delivery_decision_at_ms=COALESCE(delivery_decision_at_ms,?),
        final_delivery_outcome=COALESCE(?,final_delivery_outcome),
        alert_id=COALESCE(?,alert_id),updated_at_ms=MAX(updated_at_ms,?)
    WHERE trace_id=?
  `).run(atMs, finalDeliveryOutcome ?? null, alertId ?? null, atMs, traceId);
}

export function markOptionsDiscordSendStartedOnDb(db: LatencyDb, traceId: string, atMs: number): void {
  db.prepare(`UPDATE options_live_latency_traces SET discord_send_started_at_ms=?,updated_at_ms=? WHERE trace_id=?`)
    .run(atMs, atMs, traceId);
}

export function markOptionsDiscordAcceptedOnDb(
  db: LatencyDb,
  traceId: string,
  atMs: number,
  alertId: string,
): void {
  db.prepare(`
    UPDATE options_live_latency_traces
    SET discord_accepted_at_ms=?,alert_id=?,final_delivery_outcome='DELIVERED',updated_at_ms=?
    WHERE trace_id=?
  `).run(atMs, alertId, atMs, traceId);
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return Math.round(sorted[rank]);
}

function distribution(values: number[]) {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0);
  return { n: clean.length, p50: percentile(clean, 0.50), p95: percentile(clean, 0.95), p99: percentile(clean, 0.99) };
}

export function optionsLatencySummaryOnDb(
  db: LatencyDb,
  nowMs = Date.now(),
  windowMs = 30 * 24 * 60 * 60_000,
): Record<string, unknown> {
  const rows = db.prepare(`
    SELECT * FROM options_live_latency_traces
    WHERE created_at_ms >= ?
    ORDER BY created_at_ms DESC
    LIMIT 10000
  `).all(nowMs - windowMs);
  const delta = (a: string, b: string) => rows
    .filter((r) => r[a] != null && r[b] != null)
    .map((r) => Number(r[b]) - Number(r[a]));
  const quoteAges = rows.filter((r) => r.provider_quote_age_ms != null).map((r) => Number(r.provider_quote_age_ms));
  return {
    available: rows.length > 0,
    bounded: true,
    windowMs,
    traces: rows.length,
    observationToCandidate: distribution(delta("observation_received_at_ms", "candidate_created_at_ms")),
    candidateToDecision: distribution(delta("candidate_created_at_ms", "delivery_decision_at_ms")),
    decisionToDiscord: distribution(delta("delivery_decision_at_ms", "discord_accepted_at_ms")),
    totalObservationToDiscord: distribution(delta("observation_received_at_ms", "discord_accepted_at_ms")),
    chainProvider: distribution(delta("chain_started_at_ms", "chain_completed_at_ms")),
    discordNetwork: distribution(delta("discord_send_started_at_ms", "discord_accepted_at_ms")),
    providerQuoteAge: distribution(quoteAges),
    slosMs: {
      observationToCandidate: { p95: 1500, p99: 3000 },
      candidateToDecision: { p95: 2000, p99: 4000 },
      decisionToDiscord: { p95: 750, p99: 1500 },
      totalObservationToDiscord: { p95: 4000, p99: 7000 },
    },
  };
}
