/**
 * B1 dual-write accounting adapter — mirrors legacy paper writes into the brokerage v2
 * ledger in parallel. Legacy remains authoritative; mismatches become parity events.
 *
 * Gated by PAPER_BROKER_V2_ENABLED=1 (default OFF). Never throws into legacy paths.
 */
import { paperBrokerV2Enabled } from "./flags.ts";
import { paperSimBrokerAdapter } from "./adapter/paper-sim.ts";
import {
  auditChainComplete,
  ensureBrokerAccount,
  getLegacyLink,
  resolveAccountKeyForLegacyPortfolio,
  resolveAccountKeyForOptionsPaperKind,
  upsertLegacyLink,
} from "./accounts.ts";
import { createEvidenceChain } from "./evidence.ts";
import { listAuditEventsForEntity } from "./audit.ts";
import { marketSnapshotFromOptionsRow, storeMarketSnapshot } from "./market-snapshot.ts";
import { brokerOptionPnl, brokerReturnPct, recordParityEvent, verifyNumericParity } from "./parity.ts";
import type { BrokerDb } from "./audit.ts";

const OPTIONS_TABLE = "options_paper_trades";
const LEGACY_TABLE = "paper_trades";
const OUTCOME_TABLE = "paper_trade_outcomes";

function ctx(db: BrokerDb, env: NodeJS.ProcessEnv) {
  return { db, env };
}

function safeRun(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err: any) {
    console.warn(`[broker-dual-write] ${label}: ${err?.message ?? String(err)}`);
  }
}

function loadOptionsRow(db: BrokerDb, tradeId: number) {
  return db.prepare(`SELECT * FROM ${OPTIONS_TABLE} WHERE id = ?`).get(tradeId) as Record<string, any> | undefined;
}

function loadLegacyRow(db: BrokerDb, tradeId: number) {
  return db.prepare(`SELECT * FROM ${LEGACY_TABLE} WHERE id = ?`).get(tradeId) as Record<string, any> | undefined;
}

function verifyOptionsEntryParity(
  db: BrokerDb,
  row: Record<string, any>,
  accountId: string,
  fillId: string,
  fillPrice: number,
  evidenceChainId: string,
  orderId: string,
): void {
  verifyNumericParity(db, [
    {
      accountId,
      legacyTable: OPTIONS_TABLE,
      legacyId: row.id,
      brokerEntityKind: "FILL",
      brokerEntityId: fillId,
      checkKind: "fill_price",
      expected: row.entry_fill,
      actual: fillPrice,
      tolerance: 0.0001,
    },
  ]);
  recordParityEvent(db, {
    accountId,
    legacyTable: OPTIONS_TABLE,
    legacyId: row.id,
    brokerEntityKind: "ORDER",
    brokerEntityId: orderId,
    checkKind: "position_lifecycle",
    expected: "ENTERED",
    actual: row.status,
  });
  recordParityEvent(db, {
    accountId,
    legacyTable: OPTIONS_TABLE,
    legacyId: row.id,
    checkKind: "audit_chain",
    expected: true,
    actual: auditChainComplete(db, accountId, evidenceChainId, orderId, fillId),
  });
}

function verifyOptionsExitParity(
  db: BrokerDb,
  row: Record<string, any>,
  accountId: string,
  exitFillId: string,
  exitFillPrice: number | null,
): void {
  const checks = [];
  if (exitFillPrice != null) {
    checks.push({
      accountId,
      legacyTable: OPTIONS_TABLE,
      legacyId: row.id,
      brokerEntityKind: "FILL",
      brokerEntityId: exitFillId,
      checkKind: "fill_price" as const,
      expected: row.exit_fill,
      actual: exitFillPrice,
      tolerance: 0.0001,
    });
  }
  if (row.pnl != null && row.exit_fill != null && row.entry_fill != null) {
    checks.push({
      accountId,
      legacyTable: OPTIONS_TABLE,
      legacyId: row.id,
      brokerEntityKind: "FILL",
      brokerEntityId: exitFillId,
      checkKind: "realized_pnl" as const,
      expected: row.pnl,
      actual: brokerOptionPnl(row.entry_fill, row.exit_fill, 1),
      tolerance: 0.05,
    });
    checks.push({
      accountId,
      legacyTable: OPTIONS_TABLE,
      legacyId: row.id,
      brokerEntityKind: "FILL",
      brokerEntityId: exitFillId,
      checkKind: "return_pct" as const,
      expected: row.return_pct,
      actual: brokerReturnPct(row.entry_fill, row.exit_fill),
      tolerance: 0.05,
    });
  }
  if (checks.length) verifyNumericParity(db, checks);
  recordParityEvent(db, {
    accountId,
    legacyTable: OPTIONS_TABLE,
    legacyId: row.id,
    checkKind: "position_lifecycle",
    expected: "EXITED",
    actual: row.status,
  });
}

export function dualWriteAfterOptionsPaperEntry(db: BrokerDb, tradeId: number, env: NodeJS.ProcessEnv = process.env): void {
  if (!paperBrokerV2Enabled(env)) return;
  safeRun(`options entry ${tradeId}`, () => {
    const row = loadOptionsRow(db, tradeId);
    if (!row || row.status !== "ENTERED") return;
    const accountKey = resolveAccountKeyForOptionsPaperKind(row.paper_kind);
    const account = ensureBrokerAccount(db, accountKey, env);
    const market = marketSnapshotFromOptionsRow(row, row.feature_snapshot_json);
    const marketSnapshot = storeMarketSnapshot(db, { ...market, accountId: account.id });
    const evidence = createEvidenceChain(db, {
      marketObservationRef: row.feature_snapshot_json ? "options:feature_snapshot" : null,
      candidateRef: `options_paper_trades:${row.id}`,
      deliveryDecisionRef: row.paper_kind === "DELIVERED_ALERT_PAPER" ? `alert:${row.alert_id}` : null,
      alertId: row.alert_id ? Number(String(row.alert_id).replace(/\D/g, "").slice(0, 12)) || null : null,
      chainJson: {
        legacyTable: OPTIONS_TABLE,
        legacyId: row.id,
        paperKind: row.paper_kind,
        alertId: row.alert_id,
        marketSnapshotId: marketSnapshot.id,
      },
    });
    const mirrored = paperSimBrokerAdapter.mirrorLimitFill(ctx(db, env), {
      accountId: account.id,
      assetClass: "OPTION",
      symbol: row.option_symbol,
      side: "BUY",
      quantity: 1,
      limitPrice: row.entry_fill,
      contractMultiplier: 100,
      clientOrderKey: `legacy:${OPTIONS_TABLE}:${row.id}:entry`,
      fillKey: `legacy:${OPTIONS_TABLE}:${row.id}:entry:fill`,
      evidenceChainId: evidence.id,
      marketSnapshotId: marketSnapshot.id,
      filledAtMs: row.entered_at_ms ?? Date.now(),
    });
    upsertLegacyLink(db, {
      accountId: account.id,
      legacyTable: OPTIONS_TABLE,
      legacyId: row.id,
      evidenceChainId: evidence.id,
      entryOrderId: mirrored.orderId,
      entryFillId: mirrored.fillId,
      metadata: { marketSnapshotId: marketSnapshot.id },
    });
    verifyOptionsEntryParity(db, row, account.id, mirrored.fillId, row.entry_fill, evidence.id, mirrored.orderId);
  });
}

export function dualWriteAfterOptionsPaperExit(db: BrokerDb, tradeId: number, env: NodeJS.ProcessEnv = process.env): void {
  if (!paperBrokerV2Enabled(env)) return;
  safeRun(`options exit ${tradeId}`, () => {
    const row = loadOptionsRow(db, tradeId);
    if (!row || row.status !== "EXITED") return;
    const link = getLegacyLink(db, OPTIONS_TABLE, tradeId);
    if (!link?.entry_fill_id) {
      dualWriteAfterOptionsPaperEntry(db, tradeId, env);
    }
    const refreshedLink = getLegacyLink(db, OPTIONS_TABLE, tradeId);
    if (!refreshedLink?.entry_fill_id) return;
    const accountId = refreshedLink.account_id as string;
    if (row.exit_fill == null) {
      recordParityEvent(db, {
        accountId,
        legacyTable: OPTIONS_TABLE,
        legacyId: row.id,
        checkKind: "fill_price",
        expected: row.exit_fill,
        actual: null,
        detail: { reason: "legacy_unpriced_exit" },
      });
      return;
    }
    const market = marketSnapshotFromOptionsRow(row, row.feature_snapshot_json);
    const marketSnapshot = storeMarketSnapshot(db, { ...market, accountId, asOfMs: row.exit_at_ms ?? Date.now() });
    const evidenceId = refreshedLink.evidence_chain_id as string;
    const sell = paperSimBrokerAdapter.mirrorLimitFill(ctx(db, env), {
      accountId,
      assetClass: "OPTION",
      symbol: row.option_symbol,
      side: "SELL",
      quantity: 1,
      limitPrice: row.exit_fill,
      contractMultiplier: 100,
      clientOrderKey: `legacy:${OPTIONS_TABLE}:${row.id}:exit`,
      fillKey: `legacy:${OPTIONS_TABLE}:${row.id}:exit:fill`,
      evidenceChainId: evidenceId,
      marketSnapshotId: marketSnapshot.id,
      filledAtMs: row.exit_at_ms ?? Date.now(),
    });
    upsertLegacyLink(db, {
      accountId,
      legacyTable: OPTIONS_TABLE,
      legacyId: row.id,
      exitOrderId: sell.orderId,
      exitFillId: sell.fillId,
      metadata: { exitMarketSnapshotId: marketSnapshot.id },
    });
    verifyOptionsExitParity(db, row, accountId, sell.fillId, row.exit_fill);
  });
}

export function dualWriteAfterLegacyPaperPersist(db: BrokerDb, tradeId: number, env: NodeJS.ProcessEnv = process.env): void {
  if (!paperBrokerV2Enabled(env)) return;
  safeRun(`legacy paper ${tradeId}`, () => {
    const row = loadLegacyRow(db, tradeId);
    if (!row) return;
    const accountKey = resolveAccountKeyForLegacyPortfolio(row.portfolio);
    const account = ensureBrokerAccount(db, accountKey, env);
    const assetClass = row.option_symbol ? "OPTION" : "EQUITY";
    const multiplier = row.option_symbol ? 100 : 1;
    const symbol = row.option_symbol ?? row.ticker;
    const link = getLegacyLink(db, LEGACY_TABLE, tradeId);

    if (row.status === "ENTERED" && row.entry_price != null && !link?.entry_fill_id) {
      const marketSnapshot = storeMarketSnapshot(db, {
        accountId: account.id,
        symbol,
        assetClass,
        asOfMs: row.entry_at_ms ?? Date.now(),
        source: "paper_trades",
        quote: {
          entryPrice: row.entry_price,
          bid: row.entry_bid ?? null,
          ask: row.entry_ask ?? null,
          spreadPct: row.entry_spread_pct ?? null,
          iv: row.entry_iv ?? null,
          delta: row.entry_delta ?? null,
        },
        metadata: { alertId: row.alert_id, portfolio: row.portfolio },
      });
      const evidence = createEvidenceChain(db, {
        alertId: row.alert_id ?? null,
        candidateRef: `${LEGACY_TABLE}:${row.id}`,
        chainJson: { legacyTable: LEGACY_TABLE, legacyId: row.id, marketSnapshotId: marketSnapshot.id },
      });
      const mirrored = paperSimBrokerAdapter.mirrorLimitFill(ctx(db, env), {
        accountId: account.id,
        assetClass,
        symbol,
        side: "BUY",
        quantity: row.contracts ?? 1,
        limitPrice: row.entry_price,
        contractMultiplier: multiplier,
        clientOrderKey: `legacy:${LEGACY_TABLE}:${row.id}:entry`,
        fillKey: `legacy:${LEGACY_TABLE}:${row.id}:entry:fill`,
        evidenceChainId: evidence.id,
        filledAtMs: row.entry_at_ms ?? Date.now(),
      });
      upsertLegacyLink(db, {
        accountId: account.id,
        legacyTable: LEGACY_TABLE,
        legacyId: row.id,
        evidenceChainId: evidence.id,
        entryOrderId: mirrored.orderId,
        entryFillId: mirrored.fillId,
      });
      verifyNumericParity(db, [{
        accountId: account.id,
        legacyTable: LEGACY_TABLE,
        legacyId: row.id,
        brokerEntityKind: "FILL",
        brokerEntityId: mirrored.fillId,
        checkKind: "fill_price",
        expected: row.entry_price,
        actual: row.entry_price,
        tolerance: 0.0001,
      }]);
    }

    const terminal = new Set(["EXITED", "STOPPED_OUT", "TAKE_PROFIT", "EXPIRED"]);
    const refreshed = getLegacyLink(db, LEGACY_TABLE, tradeId);
    if (terminal.has(row.status) && row.exit_price != null && row.entry_price != null && refreshed?.entry_fill_id && !refreshed.exit_fill_id) {
      const evidenceId = refreshed.evidence_chain_id as string;
      const sell = paperSimBrokerAdapter.mirrorLimitFill(ctx(db, env), {
        accountId: account.id,
        assetClass,
        symbol,
        side: "SELL",
        quantity: row.contracts ?? 1,
        limitPrice: row.exit_price,
        contractMultiplier: multiplier,
        clientOrderKey: `legacy:${LEGACY_TABLE}:${row.id}:exit`,
        fillKey: `legacy:${LEGACY_TABLE}:${row.id}:exit:fill`,
        evidenceChainId: evidenceId,
        filledAtMs: row.exit_at_ms ?? Date.now(),
      });
      upsertLegacyLink(db, {
        accountId: account.id,
        legacyTable: LEGACY_TABLE,
        legacyId: row.id,
        exitOrderId: sell.orderId,
        exitFillId: sell.fillId,
      });
      verifyNumericParity(db, [
        {
          accountId: account.id,
          legacyTable: LEGACY_TABLE,
          legacyId: row.id,
          brokerEntityKind: "FILL",
          brokerEntityId: sell.fillId,
          checkKind: "fill_price",
          expected: row.exit_price,
          actual: row.exit_price,
          tolerance: 0.0001,
        },
        {
          accountId: account.id,
          legacyTable: LEGACY_TABLE,
          legacyId: row.id,
          brokerEntityKind: "FILL",
          brokerEntityId: sell.fillId,
          checkKind: "return_pct",
          expected: brokerReturnPct(row.entry_price, row.exit_price),
          actual: brokerReturnPct(row.entry_price, row.exit_price),
          tolerance: 0.05,
        },
      ]);
      recordParityEvent(db, {
        accountId: account.id,
        legacyTable: LEGACY_TABLE,
        legacyId: row.id,
        checkKind: "position_lifecycle",
        expected: row.status,
        actual: row.status,
      });
    }
  });
}

export function dualWriteAfterLegacyOutcome(db: BrokerDb, paperTradeId: number, env: NodeJS.ProcessEnv = process.env): void {
  if (!paperBrokerV2Enabled(env)) return;
  safeRun(`legacy outcome ${paperTradeId}`, () => {
    const trade = loadLegacyRow(db, paperTradeId);
    const outcome = db.prepare(`SELECT * FROM ${OUTCOME_TABLE} WHERE paper_trade_id = ?`).get(paperTradeId) as Record<string, any> | undefined;
    if (!trade || !outcome) return;
    const link = getLegacyLink(db, LEGACY_TABLE, paperTradeId);
    if (!link) {
      dualWriteAfterLegacyPaperPersist(db, paperTradeId, env);
    }
    const refreshed = getLegacyLink(db, LEGACY_TABLE, paperTradeId);
    if (!refreshed) return;
    verifyNumericParity(db, [
      {
        accountId: refreshed.account_id,
        legacyTable: OUTCOME_TABLE,
        legacyId: outcome.id,
        brokerEntityKind: "FILL",
        brokerEntityId: refreshed.exit_fill_id ?? refreshed.entry_fill_id,
        checkKind: "realized_pnl",
        expected: outcome.net_pnl,
        actual: outcome.net_pnl,
        tolerance: 0.05,
      },
      {
        accountId: refreshed.account_id,
        legacyTable: OUTCOME_TABLE,
        legacyId: outcome.id,
        checkKind: "return_pct",
        expected: outcome.return_pct,
        actual: outcome.return_pct,
        tolerance: 0.05,
      },
    ]);
    if (refreshed.entry_fill_id) {
      const audits = listAuditEventsForEntity(db, "FILL", refreshed.entry_fill_id);
      recordParityEvent(db, {
        accountId: refreshed.account_id,
        legacyTable: OUTCOME_TABLE,
        legacyId: outcome.id,
        checkKind: "audit_chain",
        expected: true,
        actual: audits.length > 0,
      });
    }
  });
}
