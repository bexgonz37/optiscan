/**
 * Canonical candidate → Discord funnel attribution.
 * OBSERVABILITY ONLY — never changes delivery decisions.
 *
 * Stages (independent options path):
 *   Observed → Qualified → Strategy Selected → Candidate Created
 *   → Delivery Decision → Delivery Attempted → Discord Sent
 *
 * Supervisor path is reported separately and never mixed into these counts
 * without an explicit pipeline label.
 */

export type FunnelPipeline = "INDEPENDENT_OPTIONS" | "SUPERVISOR_OPTIONS" | "STOCK_MOMENTUM";

export type FunnelStageId =
  | "observed"
  | "qualified"
  | "strategy_selected"
  | "candidate_created"
  | "delivery_decision"
  | "delivery_attempted"
  | "discord_sent";

export interface FunnelStageEvent {
  stage: FunnelStageId;
  atMs: number | null;
  latencyFromPrevMs: number | null;
  latencyFromOriginMs: number | null;
  ok: boolean;
  rejectionReason: string | null;
  gate: string | null;
  detail?: Record<string, unknown>;
}

export interface FunnelOpportunityTrace {
  id: string;
  pipeline: FunnelPipeline;
  symbol: string;
  strategy: string | null;
  side: string | null;
  tradingDay: string | null;
  originMs: number | null;
  terminalStage: FunnelStageId;
  terminalOk: boolean;
  stages: FunnelStageEvent[];
  totalLatencyMs: number | null;
}

export interface FunnelAggregateStage {
  stage: FunnelStageId;
  count: number;
  droppedFromPrev: number;
  topRejectionReasons: Array<{ reason: string; count: number }>;
  avgLatencyFromPrevMs: number | null;
  p95LatencyFromPrevMs: number | null;
}

export interface CanonicalFunnelReport {
  pipeline: FunnelPipeline;
  windowStartMs: number;
  windowEndMs: number;
  stages: FunnelAggregateStage[];
  opportunities: FunnelOpportunityTrace[];
  notes: string[];
}

interface FunnelDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
  };
}

const hasTable = (db: FunnelDb, name: string): boolean => {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
  } catch {
    return false;
  }
};

function pctile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function avg(xs: number[]): number | null {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

function countReasons(reasons: string[]): Array<{ reason: string; count: number }> {
  const m = new Map<string, number>();
  for (const r of reasons) m.set(r, (m.get(r) ?? 0) + 1);
  return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8);
}

/**
 * Build independent-options funnel for a time window from persisted tables.
 */
export function buildIndependentOptionsFunnelOnDb(
  db: FunnelDb,
  windowStartMs: number,
  windowEndMs: number,
  opts: { maxOpportunities?: number } = {},
): CanonicalFunnelReport {
  const notes: string[] = [
    "Pipeline: INDEPENDENT_OPTIONS — never mixed with supervisor options_diagnostics or stock momentum.",
    "Stage counts use persisted options_candidates / options_delivery_decisions / options_alerts.",
  ];
  const empty: CanonicalFunnelReport = {
    pipeline: "INDEPENDENT_OPTIONS",
    windowStartMs,
    windowEndMs,
    stages: [],
    opportunities: [],
    notes,
  };
  if (!hasTable(db, "options_candidates")) {
    notes.push("options_candidates table missing");
    return empty;
  }

  const candidates = db.prepare(
    `SELECT id, symbol, selected_strategy, side, state, why, score, latency_json, created_at_ms, option_symbol
     FROM options_candidates
     WHERE created_at_ms >= ? AND created_at_ms < ?
     ORDER BY created_at_ms DESC
     LIMIT 5000`,
  ).all(windowStartMs, windowEndMs) as any[];

  const decisions = hasTable(db, "options_delivery_decisions")
    ? (db.prepare(
        `SELECT id, symbol, strategy, side, outcome, reason, quality, alert_id,
                delivery_attempted, delivery_sent, final_delivery_outcome, final_delivery_reason,
                delivery_attempted_at_ms, delivery_completed_at_ms, created_at_ms
         FROM options_delivery_decisions
         WHERE created_at_ms >= ? AND created_at_ms < ?
         ORDER BY created_at_ms DESC
         LIMIT 5000`,
      ).all(windowStartMs, windowEndMs) as any[])
    : [];

  const alerts = hasTable(db, "options_alerts")
    ? (db.prepare(
        `SELECT alert_id, candidate_symbol, strategy, side, state, failure_reason,
                latency_ms, attempted_at_ms, sent_at_ms, created_at_ms
         FROM options_alerts
         WHERE created_at_ms >= ? AND created_at_ms < ?
         ORDER BY created_at_ms DESC
         LIMIT 5000`,
      ).all(windowStartMs, windowEndMs) as any[])
    : [];

  const alertById = new Map(alerts.map((a) => [String(a.alert_id), a]));
  // Match decisions to candidates by symbol+strategy nearest in time (bounded).
  const decisionsBySym = new Map<string, any[]>();
  for (const d of decisions) {
    const k = `${String(d.symbol).toUpperCase()}|${String(d.strategy ?? "")}`;
    if (!decisionsBySym.has(k)) decisionsBySym.set(k, []);
    decisionsBySym.get(k)!.push(d);
  }

  const maxOpp = opts.maxOpportunities ?? 100;
  const opportunities: FunnelOpportunityTrace[] = [];

  for (const c of candidates.slice(0, maxOpp)) {
    const originMs = Number(c.created_at_ms) || null;
    const stages: FunnelStageEvent[] = [];
    const push = (
      stage: FunnelStageId,
      atMs: number | null,
      ok: boolean,
      rejectionReason: string | null,
      gate: string | null,
      detail?: Record<string, unknown>,
    ) => {
      const prev = stages[stages.length - 1];
      const latencyFromPrevMs =
        atMs != null && prev?.atMs != null ? Math.max(0, atMs - prev.atMs) : null;
      const latencyFromOriginMs =
        atMs != null && originMs != null ? Math.max(0, atMs - originMs) : null;
      stages.push({
        stage,
        atMs,
        latencyFromPrevMs,
        latencyFromOriginMs,
        ok,
        rejectionReason,
        gate,
        detail,
      });
    };

    // Observed: candidate row exists
    push("observed", originMs, true, null, null, { candidateId: c.id, state: c.state });

    // Qualified: not REJECTED at creation for liquidity/stale/etc.
    const why = c.why == null ? null : String(c.why);
    const rejectedEarly = String(c.state).toUpperCase() === "REJECTED";
    push(
      "qualified",
      originMs,
      !rejectedEarly || Boolean(c.selected_strategy),
      rejectedEarly && !c.selected_strategy ? why : null,
      rejectedEarly && !c.selected_strategy ? "candidate_reject" : null,
    );

    // Strategy selected
    const hasStrategy = Boolean(c.selected_strategy);
    push(
      "strategy_selected",
      originMs,
      hasStrategy,
      hasStrategy ? null : why ?? "no_strategy",
      hasStrategy ? null : "strategy_match",
      { strategy: c.selected_strategy, score: c.score },
    );

    // Candidate created (READY-ish)
    const ready = String(c.state).toUpperCase() === "READY" || String(c.state).toUpperCase() === "SENT";
    push(
      "candidate_created",
      originMs,
      ready || hasStrategy,
      ready || hasStrategy ? null : why,
      ready || hasStrategy ? null : "candidate_state",
      { state: c.state, optionSymbol: c.option_symbol },
    );

    const key = `${String(c.symbol).toUpperCase()}|${String(c.selected_strategy ?? "")}`;
    const nearby = (decisionsBySym.get(key) ?? []).filter(
      (d) => Math.abs(Number(d.created_at_ms) - Number(c.created_at_ms)) < 15 * 60_000,
    );
    const d = nearby[0] ?? null;

    if (d) {
      const decisionOk = String(d.outcome) === "DELIVER_TO_DISCORD";
      push(
        "delivery_decision",
        Number(d.created_at_ms) || null,
        decisionOk,
        decisionOk ? null : String(d.reason ?? d.outcome),
        decisionOk ? null : String(d.outcome),
        { quality: d.quality, finalDeliveryOutcome: d.final_delivery_outcome },
      );

      const attempted = Boolean(d.delivery_attempted) || String(d.outcome) === "DELIVER_TO_DISCORD";
      push(
        "delivery_attempted",
        d.delivery_attempted_at_ms != null ? Number(d.delivery_attempted_at_ms) : Number(d.created_at_ms) || null,
        attempted && decisionOk,
        attempted && decisionOk ? null : String(d.final_delivery_reason ?? d.reason ?? "not_attempted"),
        attempted && decisionOk ? null : "delivery_attempt",
      );

      const alert = d.alert_id ? alertById.get(String(d.alert_id)) : null;
      const sent =
        Boolean(d.delivery_sent) ||
        String(alert?.state).toUpperCase() === "SENT" ||
        String(d.final_delivery_outcome) === "DELIVERED";
      push(
        "discord_sent",
        alert?.sent_at_ms != null
          ? Number(alert.sent_at_ms)
          : d.delivery_completed_at_ms != null
            ? Number(d.delivery_completed_at_ms)
            : null,
        sent,
        sent ? null : String(alert?.failure_reason ?? d.final_delivery_reason ?? "not_sent"),
        sent ? null : String(alert?.state ?? d.final_delivery_outcome ?? "discord"),
        { alertId: d.alert_id, latencyMs: alert?.latency_ms ?? null },
      );
    } else {
      push("delivery_decision", null, false, "no_delivery_decision_row", "delivery_decision");
      push("delivery_attempted", null, false, "no_delivery_decision_row", "delivery_attempt");
      push("discord_sent", null, false, "no_delivery_decision_row", "discord");
    }

    const lastOk = [...stages].reverse().find((s) => s.ok);
    const terminal = stages[stages.length - 1];
    opportunities.push({
      id: `cand_${c.id}`,
      pipeline: "INDEPENDENT_OPTIONS",
      symbol: String(c.symbol),
      strategy: c.selected_strategy == null ? null : String(c.selected_strategy),
      side: c.side == null ? null : String(c.side),
      tradingDay: null,
      originMs,
      terminalStage: lastOk?.stage ?? "observed",
      terminalOk: Boolean(terminal?.ok),
      stages,
      totalLatencyMs: terminal?.latencyFromOriginMs ?? null,
    });
  }

  const stageOrder: FunnelStageId[] = [
    "observed",
    "qualified",
    "strategy_selected",
    "candidate_created",
    "delivery_decision",
    "delivery_attempted",
    "discord_sent",
  ];

  const stages: FunnelAggregateStage[] = [];
  let prevCount = 0;
  for (let i = 0; i < stageOrder.length; i++) {
    const stage = stageOrder[i];
    const okEvents = opportunities.map((o) => o.stages.find((s) => s.stage === stage)).filter((s) => s?.ok);
    const allEvents = opportunities.map((o) => o.stages.find((s) => s.stage === stage)).filter(Boolean) as FunnelStageEvent[];
    const count = okEvents.length;
    const failReasons = allEvents.filter((s) => !s.ok && s.rejectionReason).map((s) => String(s.rejectionReason));
    const latencies = allEvents.map((s) => s.latencyFromPrevMs).filter((x): x is number => typeof x === "number");
    const sorted = [...latencies].sort((a, b) => a - b);
    stages.push({
      stage,
      count,
      droppedFromPrev: i === 0 ? 0 : Math.max(0, prevCount - count),
      topRejectionReasons: countReasons(failReasons),
      avgLatencyFromPrevMs: avg(latencies),
      p95LatencyFromPrevMs: pctile(sorted, 95),
    });
    prevCount = count;
  }

  // Also include raw table counts for reconciliation
  notes.push(
    `Raw window counts: candidates=${candidates.length}, decisions=${decisions.length}, alerts=${alerts.length}, traces=${opportunities.length}`,
  );

  return {
    pipeline: "INDEPENDENT_OPTIONS",
    windowStartMs,
    windowEndMs,
    stages,
    opportunities,
    notes,
  };
}

/** Load a single opportunity lifecycle for Funnel Explorer. */
export function loadFunnelOpportunityTraceOnDb(
  db: FunnelDb,
  opportunityId: string,
): FunnelOpportunityTrace | null {
  // opportunityId formats: cand_<id> | alert_<alert_id> | opp_<opportunity_id>
  if (opportunityId.startsWith("cand_") && hasTable(db, "options_candidates")) {
    const id = Number(opportunityId.slice(5));
    if (!Number.isFinite(id)) return null;
    const row = db.prepare("SELECT created_at_ms FROM options_candidates WHERE id=?").get(id) as any;
    if (!row) return null;
    const t = Number(row.created_at_ms);
    const report = buildIndependentOptionsFunnelOnDb(db, t - 60_000, t + 60_000, { maxOpportunities: 500 });
    return report.opportunities.find((o) => o.id === opportunityId) ?? null;
  }

  if (opportunityId.startsWith("opp_") && hasTable(db, "opportunity_cases")) {
    const oid = opportunityId.slice(4);
    const row = db.prepare("SELECT case_json, detected_at_ms, underlying_symbol, delivery_decision FROM opportunity_cases WHERE opportunity_id=?").get(oid) as any;
    if (!row) return null;
    let caseJson: any = {};
    try {
      caseJson = JSON.parse(row.case_json || "{}");
    } catch {
      caseJson = {};
    }
    const originMs = Number(row.detected_at_ms) || null;
    const delivered = String(row.delivery_decision) === "delivered";
    const stages: FunnelStageEvent[] = [
      { stage: "observed", atMs: originMs, latencyFromPrevMs: null, latencyFromOriginMs: 0, ok: true, rejectionReason: null, gate: null },
      {
        stage: "discord_sent",
        atMs: originMs,
        latencyFromPrevMs: null,
        latencyFromOriginMs: 0,
        ok: delivered,
        rejectionReason: delivered ? null : String(row.delivery_decision ?? "not_delivered"),
        gate: delivered ? null : "opportunity_case_delivery",
        detail: { rejectionReasonCodes: caseJson.rejectionReasonCodes ?? null },
      },
    ];
    return {
      id: opportunityId,
      pipeline: "INDEPENDENT_OPTIONS",
      symbol: String(row.underlying_symbol ?? caseJson.underlyingSymbol ?? "?"),
      strategy: caseJson.strategy ?? null,
      side: caseJson.side ?? null,
      tradingDay: null,
      originMs,
      terminalStage: delivered ? "discord_sent" : "observed",
      terminalOk: delivered,
      stages,
      totalLatencyMs: 0,
    };
  }

  return null;
}

export function listFunnelExplorerIdsOnDb(
  db: FunnelDb,
  windowStartMs: number,
  windowEndMs: number,
  limit = 50,
): Array<{ id: string; symbol: string; strategy: string | null; state: string; createdAtMs: number }> {
  if (!hasTable(db, "options_candidates")) return [];
  return (db.prepare(
    `SELECT id, symbol, selected_strategy, state, created_at_ms
     FROM options_candidates
     WHERE created_at_ms >= ? AND created_at_ms < ?
     ORDER BY created_at_ms DESC LIMIT ?`,
  ).all(windowStartMs, windowEndMs, limit) as any[]).map((r) => ({
    id: `cand_${r.id}`,
    symbol: String(r.symbol),
    strategy: r.selected_strategy == null ? null : String(r.selected_strategy),
    state: String(r.state),
    createdAtMs: Number(r.created_at_ms),
  }));
}
