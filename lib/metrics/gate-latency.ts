/**
 * Per-gate / stage latency aggregations — OBSERVABILITY ONLY.
 */

export interface LatencyStats {
  n: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** Time waiting before processing began (when instrumented). */
  avgQueueDelayMs: number | null;
  /** End-to-end from origin to terminal event. */
  avgCumulativeMs: number | null;
}

export interface GateLatencyRow {
  gate: string;
  pipeline: string;
  stats: LatencyStats;
  source: string;
  available: boolean;
  limitation?: string;
}

interface LatDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

const hasTable = (db: LatDb, name: string): boolean => {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
  } catch {
    return false;
  }
};

function statsFrom(values: number[], queueDelays: number[] = [], cumulatives: number[] = []): LatencyStats {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = queueDelays.filter((v) => Number.isFinite(v));
  const c = cumulatives.filter((v) => Number.isFinite(v));
  const pct = (p: number) => {
    if (!xs.length) return null;
    const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
    return xs[idx];
  };
  const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  return {
    n: xs.length,
    avgMs: avg(xs),
    p50Ms: pct(50),
    p95Ms: pct(95),
    p99Ms: pct(99),
    avgQueueDelayMs: avg(q),
    avgCumulativeMs: avg(c.length ? c : xs),
  };
}

export function buildGateLatencyReportOnDb(
  db: LatDb,
  windowStartMs: number,
  windowEndMs: number,
): GateLatencyRow[] {
  const rows: GateLatencyRow[] = [];

  if (hasTable(db, "momentum_diagnostics")) {
    const md = db.prepare(
      `SELECT first_seen_ms, eval_at_ms, first_actionable_ms, discord_delivered_ms, trigger_to_discord_ms, decision, reason
       FROM momentum_diagnostics
       WHERE eval_at_ms >= ? AND eval_at_ms < ?`,
    ).all(windowStartMs, windowEndMs) as any[];

    const discovery: number[] = [];
    const toDiscord: number[] = [];
    const cumulative: number[] = [];
    for (const r of md) {
      if (r.first_seen_ms != null && r.eval_at_ms != null) {
        discovery.push(Math.max(0, Number(r.eval_at_ms) - Number(r.first_seen_ms)));
      }
      if (r.trigger_to_discord_ms != null) toDiscord.push(Number(r.trigger_to_discord_ms));
      if (r.first_seen_ms != null && r.discord_delivered_ms != null) {
        cumulative.push(Math.max(0, Number(r.discord_delivered_ms) - Number(r.first_seen_ms)));
      }
    }
    rows.push({
      gate: "stock_discovery_to_eval",
      pipeline: "STOCK_MOMENTUM",
      stats: statsFrom(discovery, [], cumulative),
      source: "momentum_diagnostics.first_seen_ms → eval_at_ms",
      available: discovery.length > 0,
    });
    rows.push({
      gate: "stock_trigger_to_discord",
      pipeline: "STOCK_MOMENTUM",
      stats: statsFrom(toDiscord, [], cumulative),
      source: "momentum_diagnostics.trigger_to_discord_ms",
      available: toDiscord.length > 0,
    });

    // PersistOk near-miss eval lag (proxy for staleness at rejection)
    const persistLag: number[] = [];
    for (const r of md) {
      if (/blocked:\s*persistOk/i.test(String(r.reason ?? "")) && r.first_seen_ms != null && r.eval_at_ms != null) {
        persistLag.push(Math.max(0, Number(r.eval_at_ms) - Number(r.first_seen_ms)));
      }
    }
    rows.push({
      gate: "persistOk_rejection_cumulative",
      pipeline: "STOCK_MOMENTUM",
      stats: statsFrom(persistLag),
      source: "NEAR_MISS blocked:persistOk first_seen→eval",
      available: persistLag.length > 0,
      limitation: "Sync gate eval time is microseconds; this measures how long the symbol had been observed before rejection.",
    });
  }

  if (hasTable(db, "options_alerts")) {
    const alerts = db.prepare(
      `SELECT latency_ms, attempted_at_ms, sent_at_ms, created_at_ms, state
       FROM options_alerts
       WHERE created_at_ms >= ? AND created_at_ms < ?`,
    ).all(windowStartMs, windowEndMs) as any[];
    const lat = alerts.map((a) => Number(a.latency_ms)).filter((n) => Number.isFinite(n));
    const queue: number[] = [];
    const cum: number[] = [];
    for (const a of alerts) {
      if (a.attempted_at_ms != null && a.created_at_ms != null) {
        queue.push(Math.max(0, Number(a.attempted_at_ms) - Number(a.created_at_ms)));
      }
      if (a.sent_at_ms != null && a.created_at_ms != null) {
        cum.push(Math.max(0, Number(a.sent_at_ms) - Number(a.created_at_ms)));
      }
    }
    rows.push({
      gate: "options_alert_delivery",
      pipeline: "INDEPENDENT_OPTIONS",
      stats: statsFrom(lat, queue, cum),
      source: "options_alerts.latency_ms / attempted_at_ms / sent_at_ms",
      available: lat.length > 0 || cum.length > 0,
    });
  }

  if (hasTable(db, "options_delivery_decisions")) {
    const dd = db.prepare(
      `SELECT created_at_ms, delivery_attempted_at_ms, delivery_completed_at_ms, outcome
       FROM options_delivery_decisions
       WHERE created_at_ms >= ? AND created_at_ms < ?`,
    ).all(windowStartMs, windowEndMs) as any[];
    const attemptLag: number[] = [];
    const completeLag: number[] = [];
    for (const d of dd) {
      if (d.delivery_attempted_at_ms != null) {
        attemptLag.push(Math.max(0, Number(d.delivery_attempted_at_ms) - Number(d.created_at_ms)));
      }
      if (d.delivery_completed_at_ms != null) {
        completeLag.push(Math.max(0, Number(d.delivery_completed_at_ms) - Number(d.created_at_ms)));
      }
    }
    rows.push({
      gate: "delivery_decision_to_attempt",
      pipeline: "INDEPENDENT_OPTIONS",
      stats: statsFrom(attemptLag, attemptLag, completeLag),
      source: "options_delivery_decisions.created_at_ms → delivery_attempted_at_ms",
      available: attemptLag.length > 0,
    });
  }

  // Monitor in-memory detection→decision is not persisted; document gap.
  rows.push({
    gate: "monitor_detection_to_decision",
    pipeline: "INDEPENDENT_OPTIONS",
    stats: statsFrom([]),
    source: "optionsMonitorMetrics().detectionToDecisionMs (in-memory only)",
    available: false,
    limitation: "p50/p95 exist on live monitor metrics but are not persisted across restarts. See /api/research/options/pipeline-health for live values.",
  });

  return rows;
}
