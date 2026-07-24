/**
 * B6 — shadow-read comparisons. Legacy remains the user-visible response.
 * V2 is calculated in parallel; mismatches stored as broker_parity_events.
 */
import type { BrokerDb } from "./audit.ts";
import { recordParityEvent } from "./parity.ts";
import { paperBrokerV2ShadowReadEnabled } from "./flags.ts";

export type ShadowMetricKey =
  | "trade_count"
  | "open_position_count"
  | "realized_pnl"
  | "unrealized_pnl"
  | "account_equity"
  | "win_rate"
  | "profit_factor"
  | "drawdown"
  | "equity_curve_start"
  | "equity_curve_end"
  | "api_latency_ms";

export interface ShadowCompareInput {
  legacyTable?: string;
  legacyId?: string | number;
  accountId?: string | null;
  metrics: Partial<Record<ShadowMetricKey, { legacy: unknown; v2: unknown; tolerance?: number }>>;
  legacyLatencyMs?: number;
  v2LatencyMs?: number;
}

const KIND_PREFIX = "shadow_read_";

export function shadowCheckKind(metric: ShadowMetricKey): string {
  return `${KIND_PREFIX}${metric}`;
}

/**
 * Record shadow-read parity events. Never mutates the legacy response payload.
 * Returns mismatch count.
 */
export function recordShadowReadComparison(
  db: BrokerDb,
  input: ShadowCompareInput,
  env: NodeJS.ProcessEnv = process.env,
): { recorded: number; mismatches: string[] } {
  if (!paperBrokerV2ShadowReadEnabled(env)) {
    return { recorded: 0, mismatches: [] };
  }
  const mismatches: string[] = [];
  let recorded = 0;
  const legacyTable = input.legacyTable ?? "shadow_read";
  const legacyId = input.legacyId ?? "batch";

  for (const [key, pair] of Object.entries(input.metrics) as Array<
    [ShadowMetricKey, { legacy: unknown; v2: unknown; tolerance?: number }]
  >) {
    if (!pair) continue;
    const kind = shadowCheckKind(key) as import("./parity.ts").ParityCheckKind;
    const r = recordParityEvent(db, {
      accountId: input.accountId,
      legacyTable,
      legacyId,
      brokerEntityKind: "SHADOW_READ",
      brokerEntityId: key,
      checkKind: kind,
      expected: pair.legacy,
      actual: pair.v2,
      tolerance: pair.tolerance ?? 0.01,
      detail: {
        shadowRead: true,
        metric: key,
        legacyLatencyMs: input.legacyLatencyMs ?? null,
        v2LatencyMs: input.v2LatencyMs ?? null,
        responseSourceUnchanged: "LEGACY",
      },
    });
    recorded += 1;
    if (!r.matched) mismatches.push(key);
  }

  if (input.legacyLatencyMs != null && input.v2LatencyMs != null) {
    recordParityEvent(db, {
      accountId: input.accountId,
      legacyTable,
      legacyId,
      brokerEntityKind: "SHADOW_READ",
      brokerEntityId: "api_latency_ms",
      checkKind: shadowCheckKind("api_latency_ms") as import("./parity.ts").ParityCheckKind,
      expected: input.legacyLatencyMs,
      actual: input.v2LatencyMs,
      tolerance: 1e9, // latency compare is observational — always "match" for rate math; store both
      detail: {
        shadowRead: true,
        metric: "api_latency_ms",
        observational: true,
        deltaMs: input.v2LatencyMs - input.legacyLatencyMs,
      },
    });
    recorded += 1;
  }

  return { recorded, mismatches };
}

/**
 * Helper for routes: given a legacy payload factory and optional V2 factory,
 * always return legacy to the client when shadow mode is on; record diffs.
 */
export function withShadowReadCompare<T extends Record<string, unknown>>(
  db: BrokerDb,
  env: NodeJS.ProcessEnv,
  opts: {
    buildLegacy: () => T;
    buildV2Metrics?: () => Partial<Record<ShadowMetricKey, unknown>> | null;
    extractLegacyMetrics?: (legacy: T) => Partial<Record<ShadowMetricKey, unknown>>;
    accountId?: string | null;
  },
): T & { source: "LEGACY"; shadowCompared: boolean } {
  const t0 = Date.now();
  const legacy = opts.buildLegacy();
  const legacyLatencyMs = Date.now() - t0;

  let shadowCompared = false;
  if (paperBrokerV2ShadowReadEnabled(env) && opts.buildV2Metrics) {
    const t1 = Date.now();
    let v2Metrics: Partial<Record<ShadowMetricKey, unknown>> | null = null;
    try {
      v2Metrics = opts.buildV2Metrics();
    } catch {
      v2Metrics = null;
    }
    const v2LatencyMs = Date.now() - t1;
    const legacyMetrics = opts.extractLegacyMetrics?.(legacy) ?? {};
    if (v2Metrics) {
      const metrics: ShadowCompareInput["metrics"] = {};
      for (const key of Object.keys({ ...legacyMetrics, ...v2Metrics }) as ShadowMetricKey[]) {
        if (legacyMetrics[key] === undefined && v2Metrics[key] === undefined) continue;
        metrics[key] = { legacy: legacyMetrics[key] ?? null, v2: v2Metrics[key] ?? null };
      }
      recordShadowReadComparison(
        db,
        { accountId: opts.accountId, metrics, legacyLatencyMs, v2LatencyMs },
        env,
      );
      shadowCompared = true;
    }
  }

  return { ...legacy, source: "LEGACY" as const, shadowCompared };
}

export function summarizeShadowReadEvents(db: BrokerDb): {
  events: number;
  mismatches: number;
  byMetric: Array<{ metric: string; checks: number; mismatches: number }>;
} {
  const has = Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_parity_events'`).get(),
  );
  if (!has) return { events: 0, mismatches: 0, byMetric: [] };

  const rows = (db
    .prepare(
      `SELECT check_kind, matched, COUNT(*) AS n FROM broker_parity_events
       WHERE check_kind LIKE 'shadow_read_%'
       GROUP BY check_kind, matched`,
    )
    .all?.() ?? []) as Array<{ check_kind: string; matched: number; n: number }>;

  const map = new Map<string, { checks: number; mismatches: number }>();
  let events = 0;
  let mismatches = 0;
  for (const r of rows) {
    const metric = r.check_kind.replace(/^shadow_read_/, "");
    const cur = map.get(metric) ?? { checks: 0, mismatches: 0 };
    cur.checks += r.n;
    events += r.n;
    if (!r.matched) {
      cur.mismatches += r.n;
      mismatches += r.n;
    }
    map.set(metric, cur);
  }
  return {
    events,
    mismatches,
    byMetric: [...map.entries()].map(([metric, v]) => ({ metric, ...v })),
  };
}
