export {
  paperBrokerV2Enabled,
  paperBrokerV2ShadowReadEnabled,
  paperBrokerV2ReadsEnabled,
  requirePaperBrokerV2,
  validateBrokerV2FlagCombination,
  assertBrokerV2FlagsSafe,
  CUTOVER_POLICY_VERSION,
} from "./flags.ts";
export { resolvePaperReadSource, rollbackV2ReadsToLegacy } from "./routing.ts";
export type { PaperReadSource, PaperReadRoute } from "./routing.ts";
export { evaluateBrokerV2Readiness, defaultReadinessThresholds } from "./readiness.ts";
export type { ReadinessStatus, ReadinessReport, ReadinessRequirement, ReadinessMetrics } from "./readiness.ts";
export {
  generateDailyReadinessReportIfDue,
  buildDailyReadinessSummary,
  buildSoakPeriodSummary,
  listDailyReadinessReports,
  getDailyReadinessReport,
  runBrokerReadinessSoakJob,
  SOAK_REPORT_VERSION,
} from "./soak-report.ts";
export type { DailyReadinessSummary, SoakPeriodSummary } from "./soak-report.ts";
export {
  runHistoricalReconcileDryRun,
  resolveReadinessEligibleAfterMs,
} from "./reconcile-audit.ts";
export type { ReconcileDryRunReport, ReconcileDryRunFinding } from "./reconcile-audit.ts";
export {
  recordShadowReadComparison,
  withShadowReadCompare,
  summarizeShadowReadEvents,
  shadowCheckKind,
} from "./shadow-read.ts";
export type { ShadowMetricKey, ShadowCompareInput } from "./shadow-read.ts";
export {
  BROKER_REQUIRED_TABLES,
  BROKER_SCHEMA_DDL,
  BROKER_COLUMN_MIGRATIONS,
} from "./schema-ddl.ts";
export { BROKER_RECORD_SCHEMA_VERSION, BROKER_SCHEMA_VERSION } from "./types.ts";
export type { BrokerRequiredTable } from "./schema-ddl.ts";
export * from "./types.ts";
export {
  computeBalances,
  computePositions,
  estimateOrderNotional,
  roundMoney,
  roundQty,
} from "./ledger.ts";
export { createEvidenceChain, getEvidenceChain, traceEvidenceForFill, traceEvidenceForOrder } from "./evidence.ts";
export { appendAuditEvent, listAuditEventsForEntity } from "./audit.ts";
export {
  openAccount,
  depositCash,
  submitOrder,
  fillOrder,
  applyMark,
  snapshotEquity,
  getAccountState,
  listLedgerEntries,
} from "./engine.ts";
export { ensureBrokerSchemaOnDb, ensureBrokerColumnMigrations, listMissingBrokerTables } from "./schema-migrate.ts";
export { storeMarketSnapshot, marketSnapshotFromOptionsRow } from "./market-snapshot.ts";
export { paperSimBrokerAdapter, PaperSimBrokerAdapter } from "./adapter/paper-sim.ts";
export type { BrokerAdapter, BrokerAdapterContext, LimitFillRequest } from "./adapter/contract.ts";
export {
  ensureBrokerAccount,
  openingBalanceUsd,
  resolveAccountKeyForOptionsPaperKind,
  resolveAccountKeyForLegacyPortfolio,
  getLegacyLink,
  upsertLegacyLink,
  auditChainComplete,
} from "./accounts.ts";
export {
  dualWriteAfterOptionsPaperEntry,
  dualWriteAfterOptionsPaperExit,
  dualWriteAfterLegacyPaperPersist,
  dualWriteAfterLegacyOutcome,
} from "./dual-write.ts";
export { recordParityEvent, verifyNumericParity, valuesMatch } from "./parity.ts";
export { buildParityDashboardReport } from "./parity-report.ts";
export type { ParityDashboardReport, WindowStats, ParityFailureDetail, EquityMarkObservability } from "./parity-report.ts";
export {
  sizeFromBuyingPower,
  defaultBuyingPowerConfig,
  readBuyingPowerSnapshot,
} from "./buying-power.ts";
export type { BuyingPowerConfig, SizeFromBuyingPowerResult } from "./buying-power.ts";
export {
  computeAccountEquity,
  snapshotAccountEquity,
  readEquityCurve,
  computeDollarPositions,
  computeRealizedPnlDollars,
} from "./equity.ts";
export type { AccountEquity, DollarPosition, SnapshotCompleteness } from "./equity.ts";
export {
  decideMark,
  defaultMarkPolicyConfig,
  MARK_POLICY_VERSION,
  conservativeLongMark,
  contractMultiplier,
} from "./mark-policy.ts";
export { reconcileAccountEquity, reconcileAccountOnDb, reconcileCloseTransfer } from "./reconcile.ts";
export type { ReconciliationCheck, ReconciliationReport } from "./reconcile.ts";
export { BROKER_V2_SURFACE_LABEL, brokerV2DisabledPayload } from "./surface.ts";
export { parseOccSymbol, underlyingFromSymbol } from "./occ.ts";
export type { ParsedOccSymbol } from "./occ.ts";
export {
  resolveBrokerAccount,
  listBrokerAccounts,
  buildAccountSummary,
  buildPositionsPayload,
  buildOrdersPayload,
  buildFillsPayload,
  buildLedgerPayload,
  buildEquityCurvePayload,
  buildStatsPayload,
  buildEvidenceDrilldown,
  parsePaperApiFilters,
} from "./paper-read.ts";
export type { PaperApiFilters } from "./paper-read.ts";
export {
  ANALYTICS_METHODOLOGY_VERSION,
  ANALYTICS_SURFACE_LABEL,
  KELLY_ADVISORY_ONLY,
  defaultAnalyticsPolicy,
} from "./analytics-policy.ts";
export {
  buildAnalyticsReport,
  computePerformanceMetrics,
  computeRiskMetrics,
  computeOptionsBreakdown,
  computeExposureMetrics,
  computeKellyInputs,
  computeDrawdownStats,
  dailyReturns,
  loadEquityPoints,
} from "./analytics.ts";
export type { AnalyticsFilters, EquityPoint } from "./analytics.ts";
export { listClosedRoundTrips, filterRoundTrips, dteBucket } from "./trades.ts";
export type { RoundTripTrade, ExitClass } from "./trades.ts";
