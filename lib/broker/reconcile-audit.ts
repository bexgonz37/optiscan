/**
 * B6 — dry-run historical reconciliation of legacy vs V2.
 * Never rewrites or deletes financial history.
 */
import type { BrokerDb } from "./audit.ts";
import { appendAuditEvent } from "./audit.ts";

export interface ReconcileDryRunFinding {
  code: string;
  severity: "critical" | "warn";
  message: string;
  legacyTable?: string;
  legacyId?: string;
  brokerEntityId?: string | null;
}

export interface ReconcileDryRunReport {
  dryRun: true;
  version: number;
  generatedAtMs: number;
  /** When set, only legacy trades at/after this entry time are readiness-eligible. */
  eligibleAfterMs: number | null;
  eligibleLegacyTrades: number;
  mirroredTrades: number;
  legacyNeverMirrored: number;
  /** Closed eligible trades with no V2 link (blocks readiness). */
  missingClosedLegacyCount: number;
  /** Closed trades before the soak eligibility window — observed, not readiness-blocking. */
  preWindowUnmirroredClosed: number;
  v2WithoutLegacySource: number;
  mismatchedEntriesOrExits: number;
  mismatchedQuantities: number;
  mismatchedRealizedPnl: number;
  incompleteEvidenceChains: number;
  duplicateLegacyLinks: number;
  duplicateMirroredFills: number;
  missingMarketSnapshots: number;
  missingLedgerEvents: number;
  orphanedOrders: number;
  orphanedFills: number;
  orphanedPositions: number;
  orphanedLedgerEntries: number;
  orphanedSnapshots: number;
  incompleteEquitySnapshots: number;
  equityReconstructable: boolean;
  findings: ReconcileDryRunFinding[];
  warnings: string[];
  auditEventId: string | null;
}

const DRY_RUN_VERSION = 2;

/** Resolve soak/readiness eligibility floor from env (forward dual-write window). */
export function resolveReadinessEligibleAfterMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.BROKER_V2_READINESS_ELIGIBLE_AFTER_MS;
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function legacyEntryMs(row: Record<string, any>): number | null {
  for (const key of ["entered_at_ms", "entry_at_ms", "created_at_ms", "opened_at_ms"]) {
    const n = Number(row[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function tableExists(db: BrokerDb, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function count(db: BrokerDb, sql: string, ...args: unknown[]): number {
  return Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
}

function isClosedLegacyOptions(row: Record<string, any>): boolean {
  const status = String(row.status ?? "").toUpperCase();
  return (
    status === "CLOSED" ||
    status === "EXITED" ||
    row.exit_fill != null ||
    row.exited_at_ms != null ||
    row.exit_price != null
  );
}

function isClosedLegacyPaper(row: Record<string, any>): boolean {
  const status = String(row.status ?? "").toUpperCase();
  return status === "CLOSED" || status === "FLAT" || row.exit_price != null || row.exit_at_ms != null;
}

/**
 * Dry-run compare eligible legacy history against V2 links/ledger.
 * Emits a non-mutating audit event recording the run.
 */
export function runHistoricalReconcileDryRun(
  db: BrokerDb,
  opts: {
    nowMs?: number;
    recordAudit?: boolean;
    eligibleAfterMs?: number | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): ReconcileDryRunReport {
  const nowMs = opts.nowMs ?? Date.now();
  const eligibleAfterMs =
    opts.eligibleAfterMs !== undefined
      ? opts.eligibleAfterMs
      : resolveReadinessEligibleAfterMs(opts.env ?? process.env);
  const findings: ReconcileDryRunFinding[] = [];
  const warnings: string[] = [];
  if (eligibleAfterMs != null) {
    warnings.push(`readiness_eligible_after_ms=${eligibleAfterMs}`);
  }

  let eligible = 0;
  let mirrored = 0;
  let legacyNeverMirrored = 0;
  let missingClosed = 0;
  let preWindowUnmirroredClosed = 0;
  let mismatchedEntries = 0;
  let mismatchedQty = 0;
  let mismatchedPnl = 0;
  let incompleteEvidence = 0;
  let missingSnapshots = 0;
  let missingLedger = 0;

  const hasLinks = tableExists(db, "broker_legacy_links");
  const hasOptions = tableExists(db, "options_paper_trades");
  const hasPaper = tableExists(db, "paper_trades");

  mirrored = hasLinks ? count(db, `SELECT COUNT(*) AS n FROM broker_legacy_links`) : 0;

  const scanLegacy = (table: string, closedFn: (r: Record<string, any>) => boolean) => {
    if (!tableExists(db, table)) return;
    const rows = (db.prepare(`SELECT * FROM ${table}`).all?.() ?? []) as Array<Record<string, any>>;
    for (const row of rows) {
      const id = String(row.id);
      const entryMs = legacyEntryMs(row);
      const inWindow =
        eligibleAfterMs == null || entryMs == null || entryMs >= eligibleAfterMs;
      if (!inWindow) {
        // Pre-soak history: observe only; dual-write was not active yet.
        const link = hasLinks
          ? (db
              .prepare(`SELECT id FROM broker_legacy_links WHERE legacy_table=? AND legacy_id=?`)
              .get(table, id) as { id: string } | undefined)
          : undefined;
        if (!link && closedFn(row)) {
          preWindowUnmirroredClosed += 1;
        }
        continue;
      }
      eligible += 1;
      const link = hasLinks
        ? (db
            .prepare(`SELECT * FROM broker_legacy_links WHERE legacy_table=? AND legacy_id=?`)
            .get(table, id) as Record<string, any> | undefined)
        : undefined;
      if (!link) {
        legacyNeverMirrored += 1;
        findings.push({
          code: "legacy_never_mirrored",
          severity: closedFn(row) ? "critical" : "warn",
          message: `${table}:${id} has no broker_legacy_links row`,
          legacyTable: table,
          legacyId: id,
        });
        if (closedFn(row)) missingClosed += 1;
        continue;
      }
      if (!link.evidence_chain_id || !link.entry_order_id || !link.entry_fill_id) {
        incompleteEvidence += 1;
        findings.push({
          code: "incomplete_evidence_chain",
          severity: "critical",
          message: `${table}:${id} link missing evidence/order/fill`,
          legacyTable: table,
          legacyId: id,
          brokerEntityId: link.id,
        });
      }
      if (closedFn(row) && !link.exit_fill_id) {
        mismatchedEntries += 1;
        findings.push({
          code: "mismatched_exit",
          severity: "critical",
          message: `${table}:${id} closed in legacy but no exit_fill_id in V2 link`,
          legacyTable: table,
          legacyId: id,
          brokerEntityId: link.id,
        });
      }
      if (link.entry_fill_id) {
        const fill = db.prepare(`SELECT quantity, price FROM broker_fills WHERE id=?`).get(link.entry_fill_id) as
          | { quantity: number; price: number }
          | undefined;
        if (!fill) {
          missingLedger += 1;
          findings.push({
            code: "missing_entry_fill",
            severity: "critical",
            message: `entry_fill_id ${link.entry_fill_id} missing`,
            legacyTable: table,
            legacyId: id,
          });
        } else {
          const legacyQty = Number(row.contracts ?? row.quantity ?? row.qty ?? NaN);
          if (Number.isFinite(legacyQty) && Math.abs(legacyQty - Number(fill.quantity)) > 1e-6) {
            mismatchedQty += 1;
            findings.push({
              code: "mismatched_quantity",
              severity: "critical",
              message: `${table}:${id} qty legacy=${legacyQty} v2=${fill.quantity}`,
              legacyTable: table,
              legacyId: id,
            });
          }
        }
        const fillRow = db
          .prepare(`SELECT market_snapshot_id FROM broker_fills WHERE id=?`)
          .get(link.entry_fill_id) as { market_snapshot_id: string | null } | undefined;
        if (fillRow && !fillRow.market_snapshot_id) {
          missingSnapshots += 1;
          findings.push({
            code: "missing_market_snapshot",
            severity: "warn",
            message: `fill ${link.entry_fill_id} has no market_snapshot_id`,
            legacyTable: table,
            legacyId: id,
          });
        }
      }
      if (link.exit_fill_id && row.pnl_dollars != null) {
        const entry = db
          .prepare(`SELECT price, quantity, contract_multiplier FROM broker_fills WHERE id=?`)
          .get(link.entry_fill_id) as
          | { price: number; quantity: number; contract_multiplier: number }
          | undefined;
        const exit = db.prepare(`SELECT price FROM broker_fills WHERE id=?`).get(link.exit_fill_id) as
          | { price: number }
          | undefined;
        if (entry && exit) {
          const v2Pnl =
            (exit.price - entry.price) * entry.quantity * (entry.contract_multiplier || 100);
          if (Math.abs(Number(row.pnl_dollars) - v2Pnl) > 0.05) {
            mismatchedPnl += 1;
            findings.push({
              code: "mismatched_realized_pnl",
              severity: "critical",
              message: `${table}:${id} pnl legacy=${row.pnl_dollars} v2≈${v2Pnl}`,
              legacyTable: table,
              legacyId: id,
            });
          }
        }
      }
    }
  };

  if (hasOptions) scanLegacy("options_paper_trades", isClosedLegacyOptions);
  if (hasPaper) scanLegacy("paper_trades", isClosedLegacyPaper);
  if (!hasOptions && !hasPaper) {
    warnings.push("no_legacy_trade_tables_present");
  }
  if (preWindowUnmirroredClosed > 0) {
    warnings.push(
      `pre_window_unmirrored_closed=${preWindowUnmirroredClosed} (excluded from readiness; set BROKER_V2_READINESS_ELIGIBLE_AFTER_MS)`,
    );
  }

  let v2WithoutLegacy = 0;
  if (hasLinks && tableExists(db, "broker_orders")) {
    v2WithoutLegacy = count(
      db,
      `SELECT COUNT(*) AS n FROM broker_orders o
       WHERE NOT EXISTS (
         SELECT 1 FROM broker_legacy_links l
         WHERE l.entry_order_id = o.id OR l.exit_order_id = o.id
       )`,
    );
    if (v2WithoutLegacy > 0) {
      findings.push({
        code: "v2_without_legacy_source",
        severity: "warn",
        message: `${v2WithoutLegacy} V2 orders have no legacy link (may be native V2)`,
      });
    }
  }

  const duplicateLegacyLinks = hasLinks
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT legacy_table, legacy_id, COUNT(*) c FROM broker_legacy_links
           GROUP BY legacy_table, legacy_id HAVING c > 1
         )`,
      )
    : 0;

  const duplicateMirroredFills = tableExists(db, "broker_fills")
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT account_id, fill_key, COUNT(*) c FROM broker_fills
           GROUP BY account_id, fill_key HAVING c > 1
         )`,
      )
    : 0;

  const orphanedFills = tableExists(db, "broker_fills")
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM broker_fills f
         WHERE NOT EXISTS (SELECT 1 FROM broker_orders o WHERE o.id = f.order_id)`,
      )
    : 0;
  const orphanedOrders = tableExists(db, "broker_orders")
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM broker_orders o
         WHERE NOT EXISTS (SELECT 1 FROM broker_accounts a WHERE a.id = o.account_id)`,
      )
    : 0;
  const orphanedLedgerEntries = tableExists(db, "broker_ledger_entries")
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM broker_ledger_entries e
         WHERE NOT EXISTS (SELECT 1 FROM broker_accounts a WHERE a.id = e.account_id)`,
      )
    : 0;
  const orphanedSnapshots = tableExists(db, "broker_equity_snapshots")
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM broker_equity_snapshots s
         WHERE NOT EXISTS (SELECT 1 FROM broker_accounts a WHERE a.id = s.account_id)`,
      )
    : 0;
  const orphanedPositions = tableExists(db, "broker_position_snapshots")
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM broker_position_snapshots p
         WHERE NOT EXISTS (SELECT 1 FROM broker_accounts a WHERE a.id = p.account_id)`,
      )
    : 0;

  if (orphanedFills)
    findings.push({ code: "orphaned_fills", severity: "critical", message: `${orphanedFills} orphaned fills` });
  if (orphanedOrders)
    findings.push({ code: "orphaned_orders", severity: "critical", message: `${orphanedOrders} orphaned orders` });
  if (orphanedLedgerEntries)
    findings.push({
      code: "orphaned_ledger",
      severity: "critical",
      message: `${orphanedLedgerEntries} orphaned ledger rows`,
    });
  if (orphanedSnapshots)
    findings.push({
      code: "orphaned_snapshots",
      severity: "critical",
      message: `${orphanedSnapshots} orphaned equity snapshots`,
    });
  if (orphanedPositions)
    findings.push({
      code: "orphaned_positions",
      severity: "critical",
      message: `${orphanedPositions} orphaned position snapshots`,
    });
  if (duplicateLegacyLinks)
    findings.push({
      code: "duplicate_legacy_links",
      severity: "critical",
      message: `${duplicateLegacyLinks} duplicate links`,
    });
  if (duplicateMirroredFills)
    findings.push({
      code: "duplicate_fills",
      severity: "critical",
      message: `${duplicateMirroredFills} duplicate fills`,
    });

  const incompleteEquitySnapshots = tableExists(db, "broker_equity_snapshots")
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM broker_equity_snapshots WHERE completeness_status IN ('INCOMPLETE','PARTIAL')`,
      )
    : 0;

  let equityReconstructable = true;
  if (tableExists(db, "broker_accounts") && tableExists(db, "broker_ledger_entries")) {
    const accounts = (db.prepare(`SELECT id FROM broker_accounts`).all?.() ?? []) as Array<{ id: string }>;
    for (const a of accounts) {
      const ledgers = count(db, `SELECT COUNT(*) AS n FROM broker_ledger_entries WHERE account_id=?`, a.id);
      if (ledgers === 0) continue;
      const snaps = count(db, `SELECT COUNT(*) AS n FROM broker_equity_snapshots WHERE account_id=?`, a.id);
      if (snaps === 0) {
        equityReconstructable = false;
        findings.push({
          code: "equity_not_reconstructable",
          severity: "critical",
          message: `account ${a.id} has ledger entries but no equity snapshots`,
        });
      }
    }
  }

  let auditEventId: string | null = null;
  if (opts.recordAudit !== false) {
    try {
      auditEventId = appendAuditEvent(db, {
        eventKind: "RECONCILE_DRY_RUN",
        entityKind: "ACCOUNT",
        entityId: "broker_v2_reconcile_dry_run",
        payload: {
          version: DRY_RUN_VERSION,
          eligibleAfterMs,
          eligible,
          mirrored,
          legacyNeverMirrored,
          missingClosed,
          preWindowUnmirroredClosed,
          findingCount: findings.length,
          dryRun: true,
        },
        createdAtMs: nowMs,
      });
    } catch {
      warnings.push("audit_event_not_recorded");
    }
  }

  return {
    dryRun: true,
    version: DRY_RUN_VERSION,
    generatedAtMs: nowMs,
    eligibleAfterMs,
    eligibleLegacyTrades: eligible,
    mirroredTrades: mirrored,
    legacyNeverMirrored,
    missingClosedLegacyCount: missingClosed,
    preWindowUnmirroredClosed,
    v2WithoutLegacySource: v2WithoutLegacy,
    mismatchedEntriesOrExits: mismatchedEntries,
    mismatchedQuantities: mismatchedQty,
    mismatchedRealizedPnl: mismatchedPnl,
    incompleteEvidenceChains: incompleteEvidence,
    duplicateLegacyLinks,
    duplicateMirroredFills,
    missingMarketSnapshots: missingSnapshots,
    missingLedgerEvents: missingLedger,
    orphanedOrders,
    orphanedFills,
    orphanedPositions,
    orphanedLedgerEntries,
    orphanedSnapshots,
    incompleteEquitySnapshots,
    equityReconstructable,
    findings: findings.slice(0, 200),
    warnings,
    auditEventId,
  };
}
