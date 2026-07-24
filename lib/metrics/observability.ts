/**
 * Observability sprint read model — funnel + persistOk + gate latency.
 * Read-only; never affects live gates.
 */
import { buildIndependentOptionsFunnelOnDb, listFunnelExplorerIdsOnDb, loadFunnelOpportunityTraceOnDb } from "./funnel-attribution.ts";
import { buildGateLatencyReportOnDb } from "./gate-latency.ts";
import { METRIC_DICTIONARY } from "./dictionary.ts";
import { summarizePersistOkFailures } from "./persist-ok-diagnostics.ts";
import { momentumDiagnosticsForDay } from "../momentum-diagnostics.ts";
import { tradingDay } from "../trading-session.ts";

interface ObsDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

function independentCaptureOnDb(db: ObsDb, startMs: number, endMs: number): {
  available: boolean;
  ratePct: number | null;
  sent: number;
  ready: number;
  source: string;
} {
  try {
    const ready = Number((db.prepare(
      "SELECT COUNT(*) n FROM options_candidates WHERE state='READY' AND created_at_ms >= ? AND created_at_ms < ?",
    ).get(startMs, endMs) as any)?.n ?? 0);
    const sent = Number((db.prepare(
      "SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND created_at_ms >= ? AND created_at_ms < ?",
    ).get(startMs, endMs) as any)?.n ?? 0);
    return {
      available: ready > 0,
      ratePct: ready > 0 ? Math.round((sent / ready) * 1000) / 10 : null,
      sent,
      ready,
      source: "options_alerts.SENT / options_candidates.READY (INDEPENDENT_OPTIONS)",
    };
  } catch {
    return { available: false, ratePct: null, sent: 0, ready: 0, source: "tables unavailable" };
  }
}

export function buildObservabilityReportOnDb(db: ObsDb, nowMs = Date.now()) {
  const windowEndMs = nowMs;
  const windowStartMs = nowMs - 24 * 60 * 60_000;
  const day = tradingDay(nowMs);

  const funnel = buildIndependentOptionsFunnelOnDb(db, windowStartMs, windowEndMs, { maxOpportunities: 80 });
  const gateLatency = buildGateLatencyReportOnDb(db, windowStartMs, windowEndMs);
  const explorerIds = listFunnelExplorerIdsOnDb(db, windowStartMs, windowEndMs, 40);
  const independentCapture = independentCaptureOnDb(db, windowStartMs, windowEndMs);

  const momentumRows = momentumDiagnosticsForDay(day, db as any);
  const persistRows = momentumRows
    .filter((r) => r.decision === "NEAR_MISS" && /blocked:\s*persistOk/i.test(String(r.reason ?? "")))
    .map((r) => {
      let gateDiagnostics: unknown = null;
      if (r.gateDiagnosticsJson) {
        try {
          gateDiagnostics = JSON.parse(r.gateDiagnosticsJson);
        } catch {
          gateDiagnostics = null;
        }
      }
      return {
        reason: r.reason,
        gateDiagnostics,
        firstFailedGate: (gateDiagnostics as any)?.firstFailedGate ?? null,
      };
    });
  const persistOk = summarizePersistOkFailures(persistRows);

  return {
    generatedAtMs: nowMs,
    windowStartMs,
    windowEndMs,
    tradingDay: day,
    metricDictionaryVersion: Object.keys(METRIC_DICTIONARY).length,
    independentCapture,
    persistOk,
    funnel: {
      pipeline: funnel.pipeline,
      stages: funnel.stages,
      notes: funnel.notes,
      opportunityCount: funnel.opportunities.length,
    },
    gateLatency,
    explorer: {
      ids: explorerIds,
      note: "Developer Funnel Explorer — select an id to load full lifecycle. Observability only.",
    },
    corrections: [
      "Opportunity Capture (Supervisor) no longer falls back to paper candidates/created.",
      "When supervisor canonical=0, capture is n/a — not 0%.",
      "Missed Fast Movers uses persisted momentum NEAR_MISS only (not in-memory ring).",
      "Gate breakdown no longer double-counts raw momentum_diagnostics rows.",
      "Independent Options capture is reported separately from Supervisor Options.",
    ],
  };
}

export function loadExplorerDetailOnDb(db: ObsDb, opportunityId: string) {
  return loadFunnelOpportunityTraceOnDb(db, opportunityId);
}
