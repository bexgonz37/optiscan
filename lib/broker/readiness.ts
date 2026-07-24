/**
 * B6 — deterministic Brokerage V2 readiness evaluator.
 * Statuses follow docs/BROKER_V2_CUTOVER_POLICY.md — never subjective.
 */
import type { BrokerDb } from "./audit.ts";
import { CUTOVER_POLICY_VERSION, paperBrokerV2Enabled, paperBrokerV2ReadsEnabled, paperBrokerV2ShadowReadEnabled } from "./flags.ts";
import { resolvePaperReadSource } from "./routing.ts";
import { runHistoricalReconcileDryRun, type ReconcileDryRunReport } from "./reconcile-audit.ts";
import { summarizeShadowReadEvents } from "./shadow-read.ts";

export type ReadinessStatus =
  | "NOT_READY"
  | "OBSERVING"
  | "READY_FOR_SHADOW_READS"
  | "READY_FOR_CONTROLLED_CUTOVER";

export interface ReadinessRequirement {
  id: string;
  description: string;
  passed: boolean;
  actual: number | string | boolean | null;
  required: number | string | boolean | null;
  blocking: boolean;
  detail?: string;
}

export interface ReadinessMetrics {
  eligibleLegacyTrades: number;
  mirroredTrades: number;
  mirrorCoveragePct: number | null;
  successfullyReconciledTrades: number;
  tradeParitySuccessRatePct: number | null;
  fillPriceParityRatePct: number | null;
  realizedPnlParityRatePct: number | null;
  returnParityRatePct: number | null;
  lifecycleParityRatePct: number | null;
  auditChainCompletenessRatePct: number | null;
  equityReconciliationRatePct: number | null;
  unresolvedParityFailures: number;
  unresolvedCriticalFailures: number;
  missingV2Trades: number;
  duplicateV2Mirrors: number;
  orphanedOrders: number;
  orphanedFills: number;
  orphanedPositions: number;
  orphanedLedgerEntries: number;
  orphanedSnapshots: number;
  staleMarkCount: number;
  missingMarkCount: number;
  incompleteEquitySnapshotCount: number;
  oldestUnresolvedFailureMs: number | null;
  continuousHealthyParityMs: number | null;
  distinctTradingDaysObserved: number;
  completedMirroredRoundTrips: number;
}

export interface ReadinessReport {
  label: string;
  policyVersion: number;
  generatedAtMs: number;
  status: ReadinessStatus;
  metrics: ReadinessMetrics;
  requirements: ReadinessRequirement[];
  passedRequirements: string[];
  failedRequirements: string[];
  missingForNextStatus: string[];
  recommendedNextAction: string;
  flags: {
    dualWrite: boolean;
    shadowRead: boolean;
    v2Reads: boolean;
  };
  routing: ReturnType<typeof resolvePaperReadSource>;
  dryRun: ReconcileDryRunReport;
  shadowReadSummary: ReturnType<typeof summarizeShadowReadEvents>;
  dataQualityWarnings: string[];
  productionCutoverEnabled: false;
}

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

export interface ReadinessThresholds {
  minCompletedRoundTripsCutover: number;
  minTradingDaysCutover: number;
  minHealthyMsCutover: number;
  minCompletedRoundTripsShadow: number;
  minTradingDaysShadow: number;
  minParityRatePct: number;
  minCoveragePct: number;
  minAuditPct: number;
  minEquityReconcilePct: number;
}

export function defaultReadinessThresholds(
  env: NodeJS.ProcessEnv = process.env,
): ReadinessThresholds {
  const n = (k: string, d: number) => (Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    minCompletedRoundTripsCutover: Math.max(1, Math.floor(n("BROKER_V2_READY_MIN_TRADES", 50))),
    minTradingDaysCutover: Math.max(1, Math.floor(n("BROKER_V2_READY_MIN_DAYS", 5))),
    minHealthyMsCutover: Math.max(1, Math.floor(n("BROKER_V2_READY_MIN_HEALTHY_MS", 72 * MS_HOUR))),
    minCompletedRoundTripsShadow: Math.max(1, Math.floor(n("BROKER_V2_SHADOW_MIN_TRADES", 10))),
    minTradingDaysShadow: Math.max(1, Math.floor(n("BROKER_V2_SHADOW_MIN_DAYS", 2))),
    minParityRatePct: n("BROKER_V2_READY_MIN_PARITY_PCT", 99.5),
    minCoveragePct: n("BROKER_V2_READY_MIN_COVERAGE_PCT", 99.9),
    minAuditPct: n("BROKER_V2_READY_MIN_AUDIT_PCT", 99.9),
    minEquityReconcilePct: n("BROKER_V2_READY_MIN_EQUITY_PCT", 99.9),
  };
}

function tableExists(db: BrokerDb, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function count(db: BrokerDb, sql: string, ...args: unknown[]): number {
  const row = db.prepare(sql).get(...args) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

function rate(matched: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((matched / total) * 10000) / 100;
}

function parityKindRate(db: BrokerDb, kind: string): number | null {
  if (!tableExists(db, "broker_parity_events")) return null;
  const total = count(db, `SELECT COUNT(*) AS n FROM broker_parity_events WHERE check_kind=?`, kind);
  if (total === 0) return null;
  const ok = count(
    db,
    `SELECT COUNT(*) AS n FROM broker_parity_events WHERE check_kind=? AND matched=1`,
    kind,
  );
  return rate(ok, total);
}

function collectMetrics(db: BrokerDb, dryRun: ReconcileDryRunReport, nowMs: number): ReadinessMetrics {
  const eligible = dryRun.eligibleLegacyTrades;
  const mirrored = dryRun.mirroredTrades;
  const missing = dryRun.legacyNeverMirrored;
  const duplicates = dryRun.duplicateLegacyLinks + dryRun.duplicateMirroredFills;

  const unresolved = tableExists(db, "broker_parity_events")
    ? count(db, `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0`)
    : 0;
  const criticalKinds = [
    "fill_price",
    "realized_pnl",
    "position_lifecycle",
    "audit_chain",
    "account_equity",
  ];
  let unresolvedCritical = 0;
  for (const k of criticalKinds) {
    unresolvedCritical += tableExists(db, "broker_parity_events")
      ? count(db, `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=0 AND check_kind=?`, k)
      : 0;
  }

  const oldest = tableExists(db, "broker_parity_events")
    ? (db
        .prepare(`SELECT MIN(created_at_ms) AS m FROM broker_parity_events WHERE matched=0`)
        .get() as { m: number | null } | undefined)?.m ?? null
    : null;

  // Continuous healthy: time since last critical unmatched event (or since first mirror).
  let continuousHealthyParityMs: number | null = null;
  if (tableExists(db, "broker_parity_events")) {
    const lastFail = (
      db
        .prepare(
          `SELECT MAX(created_at_ms) AS m FROM broker_parity_events
           WHERE matched=0 AND check_kind IN ('fill_price','realized_pnl','position_lifecycle','audit_chain','account_equity')`,
        )
        .get() as { m: number | null } | undefined
    )?.m;
    const firstMirror = tableExists(db, "broker_legacy_links")
      ? ((db.prepare(`SELECT MIN(created_at_ms) AS m FROM broker_legacy_links`).get() as { m: number | null })
          ?.m ?? null)
      : null;
    const start = lastFail != null ? lastFail : firstMirror;
    if (start != null) continuousHealthyParityMs = Math.max(0, nowMs - start);
  }

  const tradingDays = tableExists(db, "broker_legacy_links")
    ? count(
        db,
        `SELECT COUNT(DISTINCT date(created_at_ms/1000, 'unixepoch')) AS n FROM broker_legacy_links`,
      )
    : 0;

  const completedRoundTrips = tableExists(db, "broker_legacy_links")
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM broker_legacy_links WHERE entry_fill_id IS NOT NULL AND exit_fill_id IS NOT NULL`,
      )
    : 0;

  const successfullyReconciled = tableExists(db, "broker_parity_events")
    ? count(
        db,
        `SELECT COUNT(DISTINCT legacy_table || ':' || legacy_id) AS n FROM broker_parity_events WHERE matched=1`,
      )
    : 0;

  const parityTotal = tableExists(db, "broker_parity_events")
    ? count(db, `SELECT COUNT(*) AS n FROM broker_parity_events`)
    : 0;
  const parityOk = tableExists(db, "broker_parity_events")
    ? count(db, `SELECT COUNT(*) AS n FROM broker_parity_events WHERE matched=1`)
    : 0;

  let auditOk = 0;
  let auditTotal = 0;
  if (tableExists(db, "broker_legacy_links")) {
    const links = (db
      .prepare(
        `SELECT account_id, evidence_chain_id, entry_order_id, entry_fill_id FROM broker_legacy_links`,
      )
      .all?.() ?? []) as Array<{
      account_id: string;
      evidence_chain_id: string | null;
      entry_order_id: string | null;
      entry_fill_id: string | null;
    }>;
    for (const l of links) {
      auditTotal += 1;
      if (l.evidence_chain_id && l.entry_order_id && l.entry_fill_id) {
        const ev = db.prepare(`SELECT 1 FROM broker_evidence_chains WHERE id=?`).get(l.evidence_chain_id);
        const ord = db
          .prepare(`SELECT 1 FROM broker_orders WHERE id=? AND account_id=?`)
          .get(l.entry_order_id, l.account_id);
        const fill = db
          .prepare(`SELECT 1 FROM broker_fills WHERE id=? AND account_id=?`)
          .get(l.entry_fill_id, l.account_id);
        if (ev && ord && fill) auditOk += 1;
      }
    }
  }

  const equityRate = parityKindRate(db, "account_equity");
  // If no equity parity events yet, treat reconstructability via dry-run equity ok flag
  const equityReconciliationRatePct =
    equityRate != null
      ? equityRate
      : dryRun.equityReconstructable
        ? 100
        : dryRun.mirroredTrades === 0
          ? null
          : 0;

  const staleMarkCount = tableExists(db, "broker_equity_snapshots")
    ? (() => {
        const rows = (db
          .prepare(`SELECT metadata_json FROM broker_equity_snapshots WHERE metadata_json IS NOT NULL`)
          .all?.() ?? []) as Array<{ metadata_json: string }>;
        let n = 0;
        for (const r of rows) {
          try {
            const m = JSON.parse(r.metadata_json);
            if (typeof m?.staleMarkCount === "number") n += m.staleMarkCount;
          } catch {
            /* ignore */
          }
        }
        return n;
      })()
    : 0;
  const missingMarkCount = tableExists(db, "broker_equity_snapshots")
    ? (() => {
        const rows = (db
          .prepare(`SELECT metadata_json FROM broker_equity_snapshots WHERE metadata_json IS NOT NULL`)
          .all?.() ?? []) as Array<{ metadata_json: string }>;
        let n = 0;
        for (const r of rows) {
          try {
            const m = JSON.parse(r.metadata_json);
            if (typeof m?.missingMarkCount === "number") n += m.missingMarkCount;
          } catch {
            /* ignore */
          }
        }
        return n;
      })()
    : 0;

  return {
    eligibleLegacyTrades: eligible,
    mirroredTrades: mirrored,
    mirrorCoveragePct: eligible > 0 ? rate(mirrored, eligible) : mirrored > 0 ? 100 : null,
    successfullyReconciledTrades: successfullyReconciled,
    tradeParitySuccessRatePct: rate(parityOk, parityTotal),
    fillPriceParityRatePct: parityKindRate(db, "fill_price"),
    realizedPnlParityRatePct: parityKindRate(db, "realized_pnl"),
    returnParityRatePct: parityKindRate(db, "return_pct"),
    lifecycleParityRatePct: parityKindRate(db, "position_lifecycle"),
    auditChainCompletenessRatePct: rate(auditOk, auditTotal),
    equityReconciliationRatePct,
    unresolvedParityFailures: unresolved,
    unresolvedCriticalFailures: unresolvedCritical,
    missingV2Trades: missing,
    duplicateV2Mirrors: duplicates,
    orphanedOrders: dryRun.orphanedOrders,
    orphanedFills: dryRun.orphanedFills,
    orphanedPositions: dryRun.orphanedPositions,
    orphanedLedgerEntries: dryRun.orphanedLedgerEntries,
    orphanedSnapshots: dryRun.orphanedSnapshots,
    staleMarkCount,
    missingMarkCount,
    incompleteEquitySnapshotCount: dryRun.incompleteEquitySnapshots,
    oldestUnresolvedFailureMs: oldest,
    continuousHealthyParityMs,
    distinctTradingDaysObserved: tradingDays,
    completedMirroredRoundTrips: completedRoundTrips,
  };
}

function pctPass(actual: number | null, required: number, haveSample: boolean): boolean {
  if (!haveSample || actual == null) return false;
  return actual + 1e-9 >= required;
}

export function evaluateBrokerV2Readiness(
  db: BrokerDb,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): ReadinessReport {
  const thresholds = defaultReadinessThresholds(env);
  const dryRun = runHistoricalReconcileDryRun(db, { nowMs, env });
  const metrics = collectMetrics(db, dryRun, nowMs);
  const routing = resolvePaperReadSource(env);
  const shadowReadSummary = summarizeShadowReadEvents(db);
  const warnings: string[] = [...dryRun.warnings];
  if (!routing.flagValidation.ok) {
    warnings.push(...routing.flagValidation.errors);
  }

  const reqs: ReadinessRequirement[] = [];
  const add = (r: ReadinessRequirement) => reqs.push(r);

  add({
    id: "no_critical_failures",
    description: "No unresolved critical reconciliation failures",
    passed: metrics.unresolvedCriticalFailures === 0,
    actual: metrics.unresolvedCriticalFailures,
    required: 0,
    blocking: true,
  });
  add({
    id: "no_orphans",
    description: "No orphaned orders, fills, positions, ledger entries, or snapshots",
    passed:
      metrics.orphanedOrders +
        metrics.orphanedFills +
        metrics.orphanedPositions +
        metrics.orphanedLedgerEntries +
        metrics.orphanedSnapshots ===
      0,
    actual:
      metrics.orphanedOrders +
      metrics.orphanedFills +
      metrics.orphanedPositions +
      metrics.orphanedLedgerEntries +
      metrics.orphanedSnapshots,
    required: 0,
    blocking: true,
  });
  add({
    id: "no_duplicate_mirrors",
    description: "No duplicate mirrored fills / legacy links",
    passed: metrics.duplicateV2Mirrors === 0,
    actual: metrics.duplicateV2Mirrors,
    required: 0,
    blocking: true,
  });

  const coverageSample = metrics.eligibleLegacyTrades > 0;
  add({
    id: "lifecycle_coverage",
    description: `Trade lifecycle / mirror coverage ≥ ${thresholds.minCoveragePct}%`,
    passed: pctPass(metrics.mirrorCoveragePct, thresholds.minCoveragePct, coverageSample),
    actual: metrics.mirrorCoveragePct,
    required: thresholds.minCoveragePct,
    blocking: false,
    detail: coverageSample ? undefined : "no_eligible_legacy_trades_yet",
  });
  add({
    id: "audit_chain_completeness",
    description: `Audit-chain completeness ≥ ${thresholds.minAuditPct}%`,
    passed: pctPass(
      metrics.auditChainCompletenessRatePct,
      thresholds.minAuditPct,
      metrics.mirroredTrades > 0,
    ),
    actual: metrics.auditChainCompletenessRatePct,
    required: thresholds.minAuditPct,
    blocking: false,
  });
  add({
    id: "equity_reconciliation",
    description: `Ledger/equity reconciliation ≥ ${thresholds.minEquityReconcilePct}%`,
    passed: pctPass(
      metrics.equityReconciliationRatePct,
      thresholds.minEquityReconcilePct,
      metrics.mirroredTrades > 0 || metrics.equityReconciliationRatePct != null,
    ),
    actual: metrics.equityReconciliationRatePct,
    required: thresholds.minEquityReconcilePct,
    blocking: false,
  });

  for (const [id, label, actual] of [
    ["fill_price_parity", "Fill-price parity", metrics.fillPriceParityRatePct],
    ["realized_pnl_parity", "Realized P&L parity", metrics.realizedPnlParityRatePct],
    ["return_parity", "Return parity", metrics.returnParityRatePct],
    ["lifecycle_parity", "Lifecycle parity", metrics.lifecycleParityRatePct],
  ] as const) {
    add({
      id,
      description: `${label} ≥ ${thresholds.minParityRatePct}% (when sample exists)`,
      passed: actual == null ? true : pctPass(actual, thresholds.minParityRatePct, true),
      actual,
      required: thresholds.minParityRatePct,
      blocking: false,
      detail: actual == null ? "no_checks_yet_skipped" : undefined,
    });
  }

  add({
    id: "sample_size_shadow",
    description: `Completed mirrored round-trips ≥ ${thresholds.minCompletedRoundTripsShadow} (shadow)`,
    passed: metrics.completedMirroredRoundTrips >= thresholds.minCompletedRoundTripsShadow,
    actual: metrics.completedMirroredRoundTrips,
    required: thresholds.minCompletedRoundTripsShadow,
    blocking: false,
  });
  add({
    id: "trading_days_shadow",
    description: `Distinct trading days ≥ ${thresholds.minTradingDaysShadow} (shadow)`,
    passed: metrics.distinctTradingDaysObserved >= thresholds.minTradingDaysShadow,
    actual: metrics.distinctTradingDaysObserved,
    required: thresholds.minTradingDaysShadow,
    blocking: false,
  });
  add({
    id: "sample_size_cutover",
    description: `Completed mirrored round-trips ≥ ${thresholds.minCompletedRoundTripsCutover} (cutover)`,
    passed: metrics.completedMirroredRoundTrips >= thresholds.minCompletedRoundTripsCutover,
    actual: metrics.completedMirroredRoundTrips,
    required: thresholds.minCompletedRoundTripsCutover,
    blocking: false,
  });
  add({
    id: "trading_days_cutover",
    description: `Distinct trading days ≥ ${thresholds.minTradingDaysCutover} (cutover)`,
    passed: metrics.distinctTradingDaysObserved >= thresholds.minTradingDaysCutover,
    actual: metrics.distinctTradingDaysObserved,
    required: thresholds.minTradingDaysCutover,
    blocking: false,
  });
  add({
    id: "healthy_duration_cutover",
    description: `Continuous healthy parity ≥ ${thresholds.minHealthyMsCutover}ms`,
    passed:
      metrics.continuousHealthyParityMs != null &&
      metrics.continuousHealthyParityMs >= thresholds.minHealthyMsCutover,
    actual: metrics.continuousHealthyParityMs,
    required: thresholds.minHealthyMsCutover,
    blocking: false,
    detail:
      metrics.continuousHealthyParityMs == null ? "no_mirror_timeline_yet" : undefined,
  });
  add({
    id: "no_missing_v2_closed",
    description: "No eligible closed legacy trades missing from V2",
    passed: dryRun.missingClosedLegacyCount === 0,
    actual: dryRun.missingClosedLegacyCount,
    required: 0,
    blocking: true,
  });

  const blockingFailed = reqs.filter((r) => r.blocking && !r.passed);
  const passedRequirements = reqs.filter((r) => r.passed).map((r) => r.id);
  const failedRequirements = reqs.filter((r) => !r.passed).map((r) => r.id);

  const shadowReqs = [
    "no_critical_failures",
    "no_orphans",
    "no_duplicate_mirrors",
    "no_missing_v2_closed",
    "sample_size_shadow",
    "trading_days_shadow",
  ];
  const cutoverReqs = [
    ...shadowReqs,
    "lifecycle_coverage",
    "audit_chain_completeness",
    "equity_reconciliation",
    "fill_price_parity",
    "realized_pnl_parity",
    "return_parity",
    "lifecycle_parity",
    "sample_size_cutover",
    "trading_days_cutover",
    "healthy_duration_cutover",
  ];

  let status: ReadinessStatus;
  if (blockingFailed.length > 0) {
    status = "NOT_READY";
  } else if (cutoverReqs.every((id) => reqs.find((r) => r.id === id)?.passed)) {
    status = "READY_FOR_CONTROLLED_CUTOVER";
  } else if (shadowReqs.every((id) => reqs.find((r) => r.id === id)?.passed)) {
    status = "READY_FOR_SHADOW_READS";
  } else {
    status = "OBSERVING";
  }

  const nextTarget =
    status === "NOT_READY"
      ? shadowReqs
      : status === "OBSERVING"
        ? shadowReqs
        : status === "READY_FOR_SHADOW_READS"
          ? cutoverReqs
          : [];
  const missingForNextStatus = nextTarget
    .filter((id) => !reqs.find((r) => r.id === id)?.passed)
    .map((id) => {
      const r = reqs.find((x) => x.id === id)!;
      return `${r.id}: need ${JSON.stringify(r.required)}, have ${JSON.stringify(r.actual)}${r.detail ? ` (${r.detail})` : ""}`;
    });

  const recommendedNextAction =
    status === "NOT_READY"
      ? "Resolve critical parity failures / orphans / duplicates; do not enable shadow or V2 reads."
      : status === "OBSERVING"
        ? `Keep dual-write soaking. Missing: ${missingForNextStatus.join(" | ") || "none"}`
        : status === "READY_FOR_SHADOW_READS"
          ? "Safe to enable PAPER_BROKER_V2_SHADOW_READ_ENABLED=1 in a controlled environment. Do not enable V2 reads yet."
          : "Human review only — READY_FOR_CONTROLLED_CUTOVER met on paper. Do NOT auto-enable PAPER_BROKER_V2_READS_ENABLED in B6.";

  // Insufficient history cannot be READY_FOR_CONTROLLED_CUTOVER — already gated by sample reqs.
  if (
    status === "READY_FOR_CONTROLLED_CUTOVER" &&
    metrics.completedMirroredRoundTrips < thresholds.minCompletedRoundTripsCutover
  ) {
    status = "OBSERVING";
    warnings.push("insufficient_sample_forced_observing");
  }

  return {
    label: "Brokerage V2 Migration Readiness — No Production Cutover",
    policyVersion: CUTOVER_POLICY_VERSION,
    generatedAtMs: nowMs,
    status,
    metrics,
    requirements: reqs,
    passedRequirements,
    failedRequirements,
    missingForNextStatus,
    recommendedNextAction,
    flags: {
      dualWrite: paperBrokerV2Enabled(env),
      shadowRead: paperBrokerV2ShadowReadEnabled(env),
      v2Reads: paperBrokerV2ReadsEnabled(env),
    },
    routing,
    dryRun,
    shadowReadSummary,
    dataQualityWarnings: warnings,
    productionCutoverEnabled: false,
  };
}
