/**
 * Brokerage parity dashboard report — aggregates dual-write agreement metrics.
 * Read-only. Developer/research surface only.
 */
import type { BrokerDb } from "./audit.ts";
import { paperBrokerV2Enabled } from "./flags.ts";

export type WindowKey = "h24" | "d7" | "lifetime";

export interface WindowStats {
  window: WindowKey;
  fromMs: number | null;
  toMs: number;
  mirroredTrades: number;
  parityChecks: number;
  paritySuccesses: number;
  parityFailures: number;
  successRatePct: number | null;
  fillPriceDiffs: number;
  realizedPnlDiffs: number;
  returnPctDiffs: number;
  lifecycleMismatches: number;
  missingAuditChain: number;
  avgReconciliationLatencyMs: number | null;
  /** B3 — equity / mark observability */
  equityDiffs: number;
  unrealizedPnlDiffs: number;
  missingMarkCounts: number;
  staleMarkCounts: number;
  incompleteSnapshotCounts: number;
}

export interface EquityMarkObservability {
  incompleteSnapshots: number;
  partialSnapshots: number;
  completeSnapshots: number;
  missingMarkEvents: number;
  staleMarkEvents: number;
  latestEquityByAccount: Array<{
    accountId: string;
    accountKey: string | null;
    totalEquity: number;
    realizedPnl: number;
    unrealizedPnl: number;
    completeness: string | null;
    atMs: number;
  }>;
}

export interface ParityFailureDetail {
  id: string;
  createdAtMs: number;
  legacyTable: string;
  legacyTradeId: string;
  brokerEntityKind: string | null;
  brokerEntityId: string | null;
  checkKind: string;
  expectedValue: unknown;
  actualValue: unknown;
  timestamp: number;
  evidenceChainId: string | null;
  evidenceChain: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
  reconciliationLatencyMs: number | null;
}

export interface ParityDashboardReport {
  generatedAtMs: number;
  dualWriteEnabled: boolean;
  windows: Record<WindowKey, WindowStats>;
  recentFailures: ParityFailureDetail[];
  equityMarks: EquityMarkObservability;
  summary: string;
}

const MS_DAY = 86_400_000;

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function windowFrom(key: WindowKey, nowMs: number): number | null {
  if (key === "h24") return nowMs - MS_DAY;
  if (key === "d7") return nowMs - 7 * MS_DAY;
  return null;
}

function buildWindowStats(db: BrokerDb, key: WindowKey, nowMs: number): WindowStats {
  const fromMs = windowFrom(key, nowMs);
  const timeClause = fromMs == null ? "" : " AND created_at_ms >= ?";
  const timeArgs = fromMs == null ? [] : [fromMs];

  const hasParity = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_parity_events'").get(),
  );
  const hasLinks = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_legacy_links'").get(),
  );

  if (!hasParity) {
    return {
      window: key,
      fromMs,
      toMs: nowMs,
      mirroredTrades: 0,
      parityChecks: 0,
      paritySuccesses: 0,
      parityFailures: 0,
      successRatePct: null,
      fillPriceDiffs: 0,
      realizedPnlDiffs: 0,
      returnPctDiffs: 0,
      lifecycleMismatches: 0,
      missingAuditChain: 0,
      avgReconciliationLatencyMs: null,
      equityDiffs: 0,
      unrealizedPnlDiffs: 0,
      missingMarkCounts: 0,
      staleMarkCounts: 0,
      incompleteSnapshotCounts: 0,
    };
  }

  const n = (sql: string, args: unknown[] = []) =>
    Number((db.prepare(sql).get(...args) as { n?: number } | undefined)?.n ?? 0);

  const parityChecks = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE 1=1${timeClause}`,
    timeArgs,
  );
  const paritySuccesses = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=1${timeClause}`,
    timeArgs,
  );
  const parityFailures = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0${timeClause}`,
    timeArgs,
  );
  const fillPriceDiffs = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0 AND check_kind='fill_price'${timeClause}`,
    timeArgs,
  );
  const realizedPnlDiffs = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0 AND check_kind='realized_pnl'${timeClause}`,
    timeArgs,
  );
  const returnPctDiffs = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0 AND check_kind='return_pct'${timeClause}`,
    timeArgs,
  );
  const lifecycleMismatches = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0 AND check_kind='position_lifecycle'${timeClause}`,
    timeArgs,
  );
  const missingAuditChain = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0 AND check_kind='audit_chain'${timeClause}`,
    timeArgs,
  );
  const equityDiffs = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0 AND check_kind='account_equity'${timeClause}`,
    timeArgs,
  );
  const unrealizedPnlDiffs = n(
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0 AND check_kind='unrealized_pnl'${timeClause}`,
    timeArgs,
  );

  let incompleteSnapshotCounts = 0;
  let missingMarkCounts = 0;
  let staleMarkCounts = 0;
  const hasEquity = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_equity_snapshots'").get(),
  );
  if (hasEquity) {
    const snapTime = fromMs == null ? "" : " AND snapshot_at_ms >= ?";
    incompleteSnapshotCounts = n(
      `SELECT COUNT(*) AS n FROM broker_equity_snapshots
       WHERE completeness_status IN ('INCOMPLETE','PARTIAL')${snapTime}`,
      timeArgs,
    );
    const metaRows = (db
      .prepare(
        `SELECT metadata_json FROM broker_equity_snapshots WHERE metadata_json IS NOT NULL${snapTime}`,
      )
      .all?.(...timeArgs) ?? []) as Array<{ metadata_json: string }>;
    for (const row of metaRows) {
      const m = parseJson(row.metadata_json) as Record<string, unknown> | null;
      if (typeof m?.missingMarkCount === "number") missingMarkCounts += m.missingMarkCount;
      if (typeof m?.staleMarkCount === "number") staleMarkCounts += m.staleMarkCount;
    }
  }

  let mirroredTrades = 0;
  if (hasLinks) {
    mirroredTrades = n(
      `SELECT COUNT(*) AS n FROM broker_legacy_links WHERE 1=1${fromMs == null ? "" : " AND created_at_ms >= ?"}`,
      timeArgs,
    );
  }

  const latencyRows = (db
    .prepare(
      `SELECT detail_json FROM broker_parity_events WHERE detail_json IS NOT NULL${timeClause}`,
    )
    .all?.(...timeArgs) ?? []) as Array<{ detail_json: string }>;

  const latencies: number[] = [];
  for (const row of latencyRows) {
    const d = parseJson(row.detail_json) as Record<string, unknown> | null;
    const lat = d?.reconciliationLatencyMs;
    if (typeof lat === "number" && Number.isFinite(lat) && lat >= 0) latencies.push(lat);
  }
  const avgReconciliationLatencyMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;

  return {
    window: key,
    fromMs,
    toMs: nowMs,
    mirroredTrades,
    parityChecks,
    paritySuccesses,
    parityFailures,
    successRatePct:
      parityChecks > 0 ? Math.round((paritySuccesses / parityChecks) * 10_000) / 100 : null,
    fillPriceDiffs,
    realizedPnlDiffs,
    returnPctDiffs,
    lifecycleMismatches,
    missingAuditChain,
    avgReconciliationLatencyMs,
    equityDiffs,
    unrealizedPnlDiffs,
    missingMarkCounts,
    staleMarkCounts,
    incompleteSnapshotCounts,
  };
}

function listRecentFailures(db: BrokerDb, limit = 50): ParityFailureDetail[] {
  const hasParity = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_parity_events'").get(),
  );
  if (!hasParity) return [];

  const rows = (db
    .prepare(
      `SELECT id, account_id, legacy_table, legacy_id, broker_entity_kind, broker_entity_id,
              check_kind, expected_value, actual_value, detail_json, created_at_ms
       FROM broker_parity_events
       WHERE matched=0
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    )
    .all?.(limit) ?? []) as Array<Record<string, any>>;

  const hasLinks = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_legacy_links'").get(),
  );
  const hasEvidence = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_evidence_chains'").get(),
  );

  return rows.map((r) => {
    const detail = parseJson(r.detail_json) as Record<string, unknown> | null;
    let evidenceChainId: string | null =
      (typeof detail?.evidenceChainId === "string" ? detail.evidenceChainId : null) ?? null;
    let evidenceChain: Record<string, unknown> | null = null;

    if (!evidenceChainId && hasLinks) {
      const link = db
        .prepare(
          `SELECT evidence_chain_id FROM broker_legacy_links WHERE legacy_table=? AND legacy_id=?`,
        )
        .get(r.legacy_table, String(r.legacy_id)) as { evidence_chain_id?: string } | undefined;
      evidenceChainId = link?.evidence_chain_id ?? null;
    }
    if (evidenceChainId && hasEvidence) {
      const ev = db
        .prepare(`SELECT * FROM broker_evidence_chains WHERE id=?`)
        .get(evidenceChainId) as Record<string, any> | undefined;
      if (ev) {
        evidenceChain = {
          id: ev.id,
          marketObservationRef: ev.market_observation_ref,
          strategyEvaluationRef: ev.strategy_evaluation_ref,
          candidateRef: ev.candidate_ref,
          deliveryDecisionRef: ev.delivery_decision_ref,
          alertId: ev.alert_id,
          opportunityCaseId: ev.opportunity_case_id,
          chainJson: parseJson(ev.chain_json),
          createdAtMs: ev.created_at_ms,
        };
      }
    }

    const latency =
      typeof detail?.reconciliationLatencyMs === "number" ? detail.reconciliationLatencyMs : null;

    return {
      id: r.id,
      createdAtMs: r.created_at_ms,
      legacyTable: r.legacy_table,
      legacyTradeId: String(r.legacy_id),
      brokerEntityKind: r.broker_entity_kind ?? null,
      brokerEntityId: r.broker_entity_id ?? null,
      checkKind: r.check_kind,
      expectedValue: parseJson(r.expected_value),
      actualValue: parseJson(r.actual_value),
      timestamp: r.created_at_ms,
      evidenceChainId,
      evidenceChain,
      detail,
      reconciliationLatencyMs: latency,
    };
  });
}

export function buildParityDashboardReport(
  db: BrokerDb,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): ParityDashboardReport {
  const windows: Record<WindowKey, WindowStats> = {
    h24: buildWindowStats(db, "h24", nowMs),
    d7: buildWindowStats(db, "d7", nowMs),
    lifetime: buildWindowStats(db, "lifetime", nowMs),
  };
  const recentFailures = listRecentFailures(db, 50);
  const equityMarks = buildEquityMarkObservability(db);
  const enabled = paperBrokerV2Enabled(env);
  const life = windows.lifetime;
  let summary: string;
  if (!enabled) {
    summary =
      "PAPER_BROKER_V2_ENABLED=0 — dual-write inactive. Parity dashboard is read-only over any stored events.";
  } else if (life.parityChecks === 0) {
    summary = "Dual-write enabled but no parity checks recorded yet.";
  } else if (life.parityFailures === 0) {
    summary = `Parity healthy: ${life.paritySuccesses}/${life.parityChecks} checks matched (100%). Incomplete snapshots: ${life.incompleteSnapshotCounts}.`;
  } else {
    summary = `Parity attention: ${life.parityFailures} failure(s) of ${life.parityChecks} checks (${life.successRatePct ?? 0}% success). Equity diffs: ${life.equityDiffs}.`;
  }

  return {
    generatedAtMs: nowMs,
    dualWriteEnabled: enabled,
    windows,
    recentFailures,
    equityMarks,
    summary,
  };
}

function buildEquityMarkObservability(db: BrokerDb): EquityMarkObservability {
  const empty: EquityMarkObservability = {
    incompleteSnapshots: 0,
    partialSnapshots: 0,
    completeSnapshots: 0,
    missingMarkEvents: 0,
    staleMarkEvents: 0,
    latestEquityByAccount: [],
  };
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_equity_snapshots'").get()) {
    return empty;
  }
  const n = (sql: string) => Number((db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
  const incompleteSnapshots = n(
    `SELECT COUNT(*) AS n FROM broker_equity_snapshots WHERE completeness_status='INCOMPLETE'`,
  );
  const partialSnapshots = n(
    `SELECT COUNT(*) AS n FROM broker_equity_snapshots WHERE completeness_status='PARTIAL'`,
  );
  const completeSnapshots = n(
    `SELECT COUNT(*) AS n FROM broker_equity_snapshots WHERE completeness_status='COMPLETE' OR completeness_status IS NULL`,
  );

  let missingMarkEvents = 0;
  let staleMarkEvents = 0;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_marks'").get()) {
    const marks = (db.prepare(`SELECT metadata_json, mark_source FROM broker_marks`).all?.() ?? []) as Array<{
      metadata_json: string | null;
      mark_source: string;
    }>;
    for (const m of marks) {
      let status = m.mark_source === "WORTHLESS" ? "WORTHLESS" : "OK";
      if (m.metadata_json) {
        try {
          status = (JSON.parse(m.metadata_json) as { status?: string }).status ?? status;
        } catch {
          /* ignore */
        }
      }
      if (status === "MISSING" || status === "ONE_SIDED") missingMarkEvents += 1;
      if (status === "STALE" || status === "WIDE_SPREAD") staleMarkEvents += 1;
    }
  }

  const latest = (db
    .prepare(
      `SELECT e.account_id, a.account_key, e.net_equity, e.realized_pnl_cumulative, e.unrealized_pnl,
              e.completeness_status, e.snapshot_at_ms
       FROM broker_equity_snapshots e
       LEFT JOIN broker_accounts a ON a.id = e.account_id
       WHERE e.snapshot_at_ms = (
         SELECT MAX(e2.snapshot_at_ms) FROM broker_equity_snapshots e2 WHERE e2.account_id = e.account_id
       )
       ORDER BY e.snapshot_at_ms DESC
       LIMIT 20`,
    )
    .all?.() ?? []) as Array<Record<string, any>>;

  return {
    incompleteSnapshots,
    partialSnapshots,
    completeSnapshots,
    missingMarkEvents,
    staleMarkEvents,
    latestEquityByAccount: latest.map((r) => ({
      accountId: r.account_id,
      accountKey: r.account_key ?? null,
      totalEquity: r.net_equity,
      realizedPnl: r.realized_pnl_cumulative,
      unrealizedPnl: r.unrealized_pnl,
      completeness: r.completeness_status ?? null,
      atMs: r.snapshot_at_ms,
    })),
  };
}
