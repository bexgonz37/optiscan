/**
 * options/instrumentation.ts — persist first-detection and delivery timing fields.
 */
import { tradingDay } from "../../trading-session.ts";

export interface CandidateInstrumentation {
  firstDetectedAtMs: number;
  underlyingAtFirstDetection: number | null;
  optionAtFirstDetection: number | null;
  sessionStateAtDetection: string | null;
  tradingSessionDate: string;
  marketStructureSnapshotJson?: string | null;
  firstReadyAtMs?: number | null;
  underlyingAtReady?: number | null;
  optionAtReady?: number | null;
  readyExpiresAtMs?: number | null;
}

export interface AlertInstrumentation {
  firstDetectedAtMs?: number | null;
  underlyingAtFirstDetection?: number | null;
  optionAtFirstDetection?: number | null;
  underlyingAtDelivery?: number | null;
  optionAtDelivery?: number | null;
  evidenceSnapshotJson?: string | null;
  sessionStateAtDelivery?: string | null;
  deliveryLatencyMs?: number | null;
  entryQualityVerdict?: string | null;
  entryQualityReasonsJson?: string | null;
  tradingSessionDate?: string | null;
  deliveredAtMs?: number | null;
}

type InstDb = { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown } };

export function readyTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const x = Number(env.OPTIONS_READY_TTL_MS);
  return Number.isFinite(x) && x > 0 ? x : 120_000;
}

export function buildCandidateInstrumentation(input: {
  nowMs: number;
  underlyingPrice: number | null;
  optionMid: number | null;
  session: string | null;
  sessionState?: string | null;
  featureSnapshot?: unknown;
  state: string;
}, env: NodeJS.ProcessEnv = process.env): CandidateInstrumentation {
  const tradingSessionDate = tradingDay(input.nowMs);
  const base: CandidateInstrumentation = {
    firstDetectedAtMs: input.nowMs,
    underlyingAtFirstDetection: input.underlyingPrice,
    optionAtFirstDetection: input.optionMid,
    sessionStateAtDetection: input.sessionState ?? input.session,
    tradingSessionDate,
    marketStructureSnapshotJson: input.featureSnapshot != null ? JSON.stringify(input.featureSnapshot) : null,
  };
  if (input.state === "READY") {
    base.firstReadyAtMs = input.nowMs;
    base.underlyingAtReady = input.underlyingPrice;
    base.optionAtReady = input.optionMid;
    base.readyExpiresAtMs = input.nowMs + readyTtlMs(env);
  }
  return base;
}

export function persistCandidateInstrumentation(db: InstDb, candidateId: number, inst: CandidateInstrumentation): void {
  try {
    db.prepare(
      `UPDATE options_candidates SET
        first_detected_at_ms=COALESCE(first_detected_at_ms, ?),
        underlying_at_first_detection=COALESCE(underlying_at_first_detection, ?),
        option_at_first_detection=COALESCE(option_at_first_detection, ?),
        session_state_at_detection=COALESCE(session_state_at_detection, ?),
        trading_session_date=COALESCE(trading_session_date, ?),
        market_structure_snapshot_json=COALESCE(market_structure_snapshot_json, ?),
        first_ready_at_ms=COALESCE(first_ready_at_ms, ?),
        underlying_at_ready=COALESCE(underlying_at_ready, ?),
        option_at_ready=COALESCE(option_at_ready, ?),
        ready_expires_at_ms=COALESCE(ready_expires_at_ms, ?)
       WHERE id=?`,
    ).run(
      inst.firstDetectedAtMs,
      inst.underlyingAtFirstDetection,
      inst.optionAtFirstDetection,
      inst.sessionStateAtDetection,
      inst.tradingSessionDate,
      inst.marketStructureSnapshotJson,
      inst.firstReadyAtMs ?? null,
      inst.underlyingAtReady ?? null,
      inst.optionAtReady ?? null,
      inst.readyExpiresAtMs ?? null,
      candidateId,
    );
  } catch { /* columns optional until migrated */ }
}

export function persistAlertInstrumentation(db: InstDb, alertId: string, inst: AlertInstrumentation): void {
  try {
    db.prepare(
      `UPDATE options_alerts SET
        first_detected_at_ms=COALESCE(first_detected_at_ms, ?),
        underlying_at_first_detection=COALESCE(underlying_at_first_detection, ?),
        option_at_first_detection=COALESCE(option_at_first_detection, ?),
        underlying_at_delivery=COALESCE(underlying_at_delivery, ?),
        option_at_delivery=COALESCE(option_at_delivery, ?),
        evidence_snapshot_json=COALESCE(evidence_snapshot_json, ?),
        session_state_at_delivery=COALESCE(session_state_at_delivery, ?),
        delivery_latency_ms=COALESCE(delivery_latency_ms, ?),
        entry_quality_verdict=COALESCE(entry_quality_verdict, ?),
        entry_quality_reasons_json=COALESCE(entry_quality_reasons_json, ?),
        trading_session_date=COALESCE(trading_session_date, ?),
        delivered_at_ms=COALESCE(delivered_at_ms, ?)
       WHERE alert_id=?`,
    ).run(
      inst.firstDetectedAtMs ?? null,
      inst.underlyingAtFirstDetection ?? null,
      inst.optionAtFirstDetection ?? null,
      inst.underlyingAtDelivery ?? null,
      inst.optionAtDelivery ?? null,
      inst.evidenceSnapshotJson ?? null,
      inst.sessionStateAtDelivery ?? null,
      inst.deliveryLatencyMs ?? null,
      inst.entryQualityVerdict ?? null,
      inst.entryQualityReasonsJson ?? null,
      inst.tradingSessionDate ?? null,
      inst.deliveredAtMs ?? null,
      alertId,
    );
  } catch { /* isolated */ }
}

export function isReadyCandidateExpired(readyExpiresAtMs: number | null | undefined, nowMs: number): boolean {
  return readyExpiresAtMs != null && nowMs > readyExpiresAtMs;
}

/** Stamp batch_entered_at_ms on the latest READY candidate rows entering a delivery batch. */
export function markCandidatesBatchEntered(db: InstDb, symbols: string[], batchEnteredAtMs: number): void {
  for (const symbol of symbols) {
    try {
      db.prepare(
        `UPDATE options_candidates SET batch_entered_at_ms=COALESCE(batch_entered_at_ms, ?)
         WHERE id = (
           SELECT id FROM options_candidates
           WHERE symbol=? AND state='READY' AND batch_entered_at_ms IS NULL
           ORDER BY created_at_ms DESC LIMIT 1
         )`,
      ).run(batchEnteredAtMs, symbol.toUpperCase());
    } catch { /* columns optional until migrated */ }
  }
}
