/**
 * mark-evidence-store.ts — durable per-attempt mark evidence.
 *
 * WHY A LOG AND NOT MORE COLUMNS. `asymmetry_marks` keeps at most one row per
 * (session, fingerprint, horizon) — the current best answer, replaced when a
 * transient failure is retried. Independence is a property of ATTEMPTS: how
 * many distinct provider observations we actually obtained, and how many rows
 * are the same observation carried forward. Recording that on the keyed table
 * would overwrite exactly the history that makes it measurable.
 *
 * Every write swallows its own error. Losing an evidence row is acceptable;
 * losing a mark, or letting instrumentation break the sweep, is not.
 */
import { ensureAsymmetrySchema } from "./case-store.ts";

export const MARK_EVIDENCE_VERSION = "MARK_EVIDENCE_V1" as const;

type EvidenceDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

export interface MarkEvidenceRow {
  markAttemptId: string;
  sessionDate: string;
  fingerprint: string;
  optionSymbol: string;
  underlying: string | null;
  horizonMinutes: number;

  targetAtMs: number | null;
  acceptableFromMs: number | null;
  acceptableUntilMs: number | null;

  sweepId: string | null;
  sweepStartedAtMs: number | null;
  schedulerSelectedAtMs: number | null;
  providerRequestStartedAtMs: number | null;
  providerResponseReceivedAtMs: number | null;
  observedAtMs: number | null;

  /** Kept as a STRING: 19-digit ns values exceed Number.MAX_SAFE_INTEGER. */
  rawProviderTimestamp: string | null;
  sourceField: string | null;
  inferredUnit: string | null;
  normalizedProviderTimestampMs: number | null;
  providerSkewMs: number | null;
  sweepDriftMs: number | null;
  requestLatencyMs: number | null;
  schedulerDelayMs: number | null;
  quoteAgeMs: number | null;

  bid: number | null;
  ask: number | null;
  sourceEndpoint: string | null;
  cacheStatus: string | null;

  accepted: boolean;
  independent: boolean;
  reusedFromHorizon: number | null;
  horizonMatchStatus: string | null;
  markQuality: string | null;
  rejectionReason: string | null;

  timestampPolicyVersion: string | null;
  dataQualityVersion: string | null;
}

export interface EvidenceWriteResult { ok: boolean; created: boolean; error: string | null }

/** Midpoint only when both sides exist. Never a substitute for either side. */
function midpoint(bid: number | null, ask: number | null): number | null {
  return bid != null && ask != null ? Math.round(((bid + ask) / 2) * 10_000) / 10_000 : null;
}

/** Record one attempt. Repeat-safe by attempt id. Never throws. */
export function recordMarkEvidenceOnDb(db: EvidenceDb, e: MarkEvidenceRow, nowMs: number): EvidenceWriteResult {
  try {
    ensureAsymmetrySchema(db as never);
    const raw = e.rawProviderTimestamp;
    const res = db.prepare(`
      INSERT OR IGNORE INTO asymmetry_mark_evidence (
        mark_attempt_id, session_date, fingerprint, option_symbol, underlying, horizon_minutes,
        target_at_ms, acceptable_from_ms, acceptable_until_ms,
        sweep_id, sweep_started_at_ms, scheduler_selected_at_ms,
        provider_request_started_at_ms, provider_response_received_at_ms, observed_at_ms,
        raw_provider_timestamp, raw_digit_count, source_field, inferred_unit,
        normalized_provider_timestamp_ms, provider_skew_ms, sweep_drift_ms,
        request_latency_ms, scheduler_delay_ms, quote_age_ms,
        bid, ask, midpoint, source_endpoint, cache_status,
        accepted, independent, reused_from_horizon, horizon_match_status, mark_quality, rejection_reason,
        timestamp_policy_version, mark_version, data_quality_version, created_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      e.markAttemptId, e.sessionDate, e.fingerprint, e.optionSymbol, e.underlying, e.horizonMinutes,
      e.targetAtMs, e.acceptableFromMs, e.acceptableUntilMs,
      e.sweepId, e.sweepStartedAtMs, e.schedulerSelectedAtMs,
      e.providerRequestStartedAtMs, e.providerResponseReceivedAtMs, e.observedAtMs,
      raw, raw != null ? raw.replace(/\D/g, "").length : null, e.sourceField, e.inferredUnit,
      e.normalizedProviderTimestampMs, e.providerSkewMs, e.sweepDriftMs,
      e.requestLatencyMs, e.schedulerDelayMs, e.quoteAgeMs,
      e.bid, e.ask, midpoint(e.bid, e.ask), e.sourceEndpoint, e.cacheStatus,
      e.accepted ? 1 : 0, e.independent ? 1 : 0, e.reusedFromHorizon,
      e.horizonMatchStatus, e.markQuality, e.rejectionReason,
      e.timestampPolicyVersion, MARK_EVIDENCE_VERSION, e.dataQualityVersion, nowMs,
    );
    return { ok: true, created: Number(res.changes ?? 0) > 0, error: null };
  } catch (err: unknown) {
    return { ok: false, created: false, error: String((err as Error)?.message ?? err) };
  }
}

function hasTable(db: EvidenceDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}

export interface IndependenceReport {
  sessionDate: string;
  attempts: number;
  accepted: number;
  independent: number;
  reused: number;
  independentRatePct: number | null;
  usableRatePct: number | null;
  byHorizon: Array<{ horizonMinutes: number; attempts: number; accepted: number; independent: number; independentPct: number | null }>;
  byQuality: Record<string, number>;
  byHorizonMatch: Record<string, number>;
  skew: { p50: number | null; p95: number | null; max: number | null };
  sweepDrift: { p50: number | null; p95: number | null; max: number | null };
  requestsPerIndependentMark: number | null;
  meetsGate: boolean;
  note: string;
}

/** Gate B target. Below it, horizon conclusions are not defensible. */
export const INDEPENDENT_GATE_PCT = 50;

/**
 * Measure independence from persisted evidence. READ ONLY — this is the
 * function a diagnostic calls, so it must never touch the provider.
 */
export function buildIndependenceReportOnDb(db: EvidenceDb, sessionDate: string): IndependenceReport {
  const empty: IndependenceReport = {
    sessionDate, attempts: 0, accepted: 0, independent: 0, reused: 0,
    independentRatePct: null, usableRatePct: null, byHorizon: [], byQuality: {}, byHorizonMatch: {},
    skew: { p50: null, p95: null, max: null }, sweepDrift: { p50: null, p95: null, max: null },
    requestsPerIndependentMark: null, meetsGate: false,
    note: "No mark evidence recorded yet for this session.",
  };
  if (!hasTable(db, "asymmetry_mark_evidence")) return empty;

  try {
    const rows = db.prepare(`
      SELECT horizon_minutes, accepted, independent, mark_quality, horizon_match_status,
             provider_skew_ms, sweep_drift_ms
        FROM asymmetry_mark_evidence WHERE session_date=?
    `).all(sessionDate) as Array<Record<string, unknown>>;
    if (rows.length === 0) return empty;

    const n = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const skews: number[] = [], drifts: number[] = [];
    const byHorizonMap = new Map<number, { attempts: number; accepted: number; independent: number }>();
    const byQuality: Record<string, number> = {};
    const byHorizonMatch: Record<string, number> = {};
    let accepted = 0, independent = 0, reused = 0;

    for (const r of rows) {
      const h = Number(r.horizon_minutes);
      const cur = byHorizonMap.get(h) ?? { attempts: 0, accepted: 0, independent: 0 };
      cur.attempts += 1;
      if (Number(r.accepted) === 1) { accepted += 1; cur.accepted += 1; }
      if (Number(r.independent) === 1) { independent += 1; cur.independent += 1; }
      byHorizonMap.set(h, cur);

      const q = r.mark_quality == null ? "UNKNOWN" : String(r.mark_quality);
      byQuality[q] = (byQuality[q] ?? 0) + 1;
      const m = r.horizon_match_status == null ? "UNKNOWN" : String(r.horizon_match_status);
      byHorizonMatch[m] = (byHorizonMatch[m] ?? 0) + 1;
      if (m === "REUSED_NOT_INDEPENDENT") reused += 1;

      const s = n(r.provider_skew_ms); if (s != null) skews.push(s);
      const d = n(r.sweep_drift_ms); if (d != null) drifts.push(d);
    }

    const q = (arr: number[], p: number): number | null => {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
    };
    const rate = rows.length ? (independent / rows.length) * 100 : null;

    return {
      sessionDate,
      attempts: rows.length, accepted, independent, reused,
      independentRatePct: rate == null ? null : Math.round(rate * 10) / 10,
      usableRatePct: rows.length ? Math.round((accepted / rows.length) * 1000) / 10 : null,
      byHorizon: [...byHorizonMap.entries()].sort((a, b) => a[0] - b[0]).map(([h, v]) => ({
        horizonMinutes: h, attempts: v.attempts, accepted: v.accepted, independent: v.independent,
        independentPct: v.attempts ? Math.round((v.independent / v.attempts) * 1000) / 10 : null,
      })),
      byQuality, byHorizonMatch,
      skew: { p50: q(skews, 0.5), p95: q(skews, 0.95), max: skews.length ? Math.max(...skews) : null },
      sweepDrift: { p50: q(drifts, 0.5), p95: q(drifts, 0.95), max: drifts.length ? Math.max(...drifts) : null },
      // One provider request per attempt today, so attempts is the request count.
      requestsPerIndependentMark: independent > 0 ? Math.round((rows.length / independent) * 100) / 100 : null,
      meetsGate: rate != null && rate >= INDEPENDENT_GATE_PCT,
      note: rate == null
        ? "No attempts."
        : rate >= INDEPENDENT_GATE_PCT
          ? `Independent rate ${rate.toFixed(1)}% meets the ${INDEPENDENT_GATE_PCT}% gate.`
          : `Independent rate ${rate.toFixed(1)}% is below the ${INDEPENDENT_GATE_PCT}% gate — horizon conclusions are not defensible.`,
    };
  } catch {
    return empty;
  }
}
