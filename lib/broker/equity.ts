/**
 * B3 — dollar account equity, equity curve, and reconciliation.
 * Snapshots are append-only; balances never overwrite.
 */
import { brokerId } from "./id.ts";
import { appendAuditEvent, type BrokerDb } from "./audit.ts";
import {
  computeBalances,
  roundMoney,
} from "./ledger.ts";
import { listLedgerEntries } from "./queries.ts";
import { BROKER_RECORD_SCHEMA_VERSION, type AssetClass, type LedgerEntryRow, type PositionSide } from "./types.ts";
import { MARK_POLICY_VERSION, contractMultiplier } from "./mark-policy.ts";

export type SnapshotCompleteness = "COMPLETE" | "INCOMPLETE" | "PARTIAL";

export interface DollarPosition {
  assetClass: AssetClass;
  symbol: string;
  side: PositionSide;
  quantity: number;
  averageCost: number;
  costBasisDollars: number;
  marketPrice: number | null;
  marketValueDollars: number;
  unrealizedPnlDollars: number;
  multiplier: number;
  markStatus: string;
  evidenceChainId: string | null;
}

export interface AccountEquity {
  accountId: string;
  asOfMs: number;
  cash: number;
  reserved: number;
  buyingPower: number;
  grossPositionValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalEquity: number;
  highWaterMark: number;
  drawdownDollars: number;
  drawdownPct: number;
  openPositionCount: number;
  positions: DollarPosition[];
  ledgerSequenceThrough: number;
  completeness: SnapshotCompleteness;
  missingMarkCount: number;
  staleMarkCount: number;
  markPolicyVersion: number;
  recordSchemaVersion: number;
}

export interface EquitySnapshotRow {
  id: string;
  account_id: string;
  snapshot_at_ms: number;
  cash_balance: number;
  reserved_balance: number;
  buying_power: number;
  gross_position_value: number;
  net_equity: number;
  unrealized_pnl: number;
  realized_pnl_cumulative: number;
  high_water_mark: number | null;
  drawdown_dollars: number | null;
  drawdown_pct: number | null;
  completeness_status: string | null;
  mark_policy_version: number | null;
  ledger_sequence_through: number;
  record_schema_version: number;
  metadata_json: string | null;
}

function evidenceMapFromOrders(db: BrokerDb, accountId: string): Map<string, string | null> {
  const rows = (db
    .prepare(
      `SELECT o.asset_class, o.symbol, o.evidence_chain_id, o.contract_multiplier
       FROM broker_orders o WHERE o.account_id = ? AND o.evidence_chain_id IS NOT NULL`,
    )
    .all?.(accountId) ?? []) as Array<{
    asset_class: string;
    symbol: string;
    evidence_chain_id: string;
    contract_multiplier: number;
  }>;
  const map = new Map<string, string | null>();
  for (const r of rows) map.set(`${r.asset_class}:${r.symbol}`, r.evidence_chain_id);
  return map;
}

function multiplierMapFromOrders(db: BrokerDb, accountId: string): Map<string, number> {
  const rows = (db
    .prepare(
      `SELECT asset_class, symbol, contract_multiplier FROM broker_orders WHERE account_id = ? ORDER BY created_at_ms ASC`,
    )
    .all?.(accountId) ?? []) as Array<{ asset_class: string; symbol: string; contract_multiplier: number }>;
  const map = new Map<string, number>();
  for (const r of rows) map.set(`${r.asset_class}:${r.symbol}`, r.contract_multiplier || contractMultiplier(r.asset_class));
  return map;
}

export interface MarkState {
  price: number | null;
  status: string;
}

function latestMarkStates(db: BrokerDb, accountId: string): Map<string, MarkState> {
  const rows = (db
    .prepare(
      `SELECT asset_class, symbol, mark_price, mark_source, metadata_json, marked_at_ms
       FROM broker_marks WHERE account_id = ? ORDER BY marked_at_ms ASC`,
    )
    .all?.(accountId) ?? []) as Array<{
    asset_class: string;
    symbol: string;
    mark_price: number;
    mark_source: string;
    metadata_json: string | null;
  }>;
  const map = new Map<string, MarkState>();
  for (const r of rows) {
    let status = "OK";
    if (r.metadata_json) {
      try {
        const m = JSON.parse(r.metadata_json) as { status?: string };
        if (m.status) status = m.status;
      } catch {
        /* ignore */
      }
    } else if (r.mark_source === "WORTHLESS") status = "WORTHLESS";
    map.set(`${r.asset_class}:${r.symbol}`, { price: r.mark_price, status });
  }
  return map;
}

/**
 * Reconstruct dollar positions from ledger + marks.
 * Options use contract multiplier (default 100) so equity is in dollars, not premium points.
 */
export function computeDollarPositions(
  entries: LedgerEntryRow[],
  marks: Map<string, MarkState>,
  multipliers: Map<string, number>,
  evidenceBySymbol: Map<string, string | null> = new Map(),
): DollarPosition[] {
  type Lot = {
    assetClass: AssetClass;
    symbol: string;
    quantity: number;
    /** Premium units (price × contracts) before multiplier. */
    costBasisPremium: number;
    evidenceChainId: string | null;
  };
  const lots = new Map<string, Lot>();

  for (const e of entries) {
    if (e.asset_class === "CASH" || !e.symbol) continue;
    const key = `${e.asset_class}:${e.symbol}`;
    const lot = lots.get(key) ?? {
      assetClass: e.asset_class,
      symbol: e.symbol,
      quantity: 0,
      costBasisPremium: 0,
      evidenceChainId: evidenceBySymbol.get(key) ?? null,
    };
    if (e.quantity_delta > 0) {
      lot.costBasisPremium += (e.price ?? 0) * e.quantity_delta;
      lot.quantity += e.quantity_delta;
    } else if (e.quantity_delta < 0) {
      const sellQty = Math.abs(e.quantity_delta);
      const avg = lot.quantity > 0 ? lot.costBasisPremium / lot.quantity : 0;
      lot.costBasisPremium -= avg * sellQty;
      lot.quantity += e.quantity_delta;
      if (Math.abs(lot.quantity) <= 1e-9) {
        lot.quantity = 0;
        lot.costBasisPremium = 0;
      }
    }
    lots.set(key, lot);
  }

  const out: DollarPosition[] = [];
  for (const lot of lots.values()) {
    if (Math.abs(lot.quantity) < 1e-9) continue;
    const side: PositionSide = lot.quantity > 0 ? "LONG" : "SHORT";
    const qty = Math.abs(lot.quantity);
    const avgCost = qty > 0 ? lot.costBasisPremium / qty : 0;
    const mult = multipliers.get(`${lot.assetClass}:${lot.symbol}`) ?? contractMultiplier(lot.assetClass);
    const markState = marks.get(`${lot.assetClass}:${lot.symbol}`);
    const mark = markState?.price ?? null;
    const markStatus = markState?.status ?? (mark == null ? "MISSING" : "OK");
    const usable = mark != null && markStatus !== "MISSING" && markStatus !== "ONE_SIDED";
    const marketValueDollars = usable ? roundMoney(mark! * qty * mult) : 0;
    const costBasisDollars = roundMoney(avgCost * qty * mult);
    const unrealized =
      usable
        ? roundMoney((mark! - avgCost) * qty * mult * (side === "LONG" ? 1 : -1))
        : 0;
    out.push({
      assetClass: lot.assetClass,
      symbol: lot.symbol,
      side,
      quantity: qty,
      averageCost: roundMoney(avgCost),
      costBasisDollars,
      marketPrice: usable ? mark : null,
      marketValueDollars,
      unrealizedPnlDollars: unrealized,
      multiplier: mult,
      markStatus,
      evidenceChainId: lot.evidenceChainId,
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * Realized P&L in dollars from closed lots + fee entries.
 * Walks the ledger chronologically, matching sells against average cost.
 */
export function computeRealizedPnlDollars(
  entries: LedgerEntryRow[],
  multipliers: Map<string, number>,
): number {
  type Lot = { qty: number; costPremium: number };
  const lots = new Map<string, Lot>();
  let realized = 0;

  for (const e of entries) {
    if (e.entry_kind === "FEE") {
      realized += e.cash_delta; // fees are negative cash
      continue;
    }
    if (e.entry_kind === "REALIZED_PNL") {
      realized += e.cash_delta;
      continue;
    }
    if (!e.symbol || e.asset_class === "CASH") continue;
    const key = `${e.asset_class}:${e.symbol}`;
    const mult = multipliers.get(key) ?? contractMultiplier(e.asset_class);
    const lot = lots.get(key) ?? { qty: 0, costPremium: 0 };

    if (e.entry_kind === "BUY_FILL" && e.quantity_delta > 0) {
      lot.costPremium += (e.price ?? 0) * e.quantity_delta;
      lot.qty += e.quantity_delta;
      lots.set(key, lot);
    } else if (e.entry_kind === "SELL_FILL" && e.quantity_delta < 0) {
      const sellQty = Math.abs(e.quantity_delta);
      const avg = lot.qty > 0 ? lot.costPremium / lot.qty : 0;
      const proceeds = (e.price ?? 0) * sellQty * mult;
      const cost = avg * sellQty * mult;
      realized += proceeds - cost;
      lot.costPremium -= avg * sellQty;
      lot.qty -= sellQty;
      if (lot.qty <= 1e-9) {
        lot.qty = 0;
        lot.costPremium = 0;
      }
      lots.set(key, lot);
    }
  }
  return roundMoney(realized);
}

function priorHighWaterMark(db: BrokerDb, accountId: string): number {
  const row = db
    .prepare(
      `SELECT MAX(COALESCE(high_water_mark, net_equity)) AS hwm
       FROM broker_equity_snapshots WHERE account_id = ?`,
    )
    .get(accountId) as { hwm: number | null } | undefined;
  return row?.hwm != null && Number.isFinite(row.hwm) ? row.hwm : 0;
}

export function computeAccountEquity(
  db: BrokerDb,
  accountId: string,
  asOfMs: number = Date.now(),
): AccountEquity {
  const entries = listLedgerEntries(db, accountId);
  const balances = computeBalances(entries);
  const multipliers = multiplierMapFromOrders(db, accountId);
  const marks = latestMarkStates(db, accountId);
  const evidence = evidenceMapFromOrders(db, accountId);
  const positions = computeDollarPositions(entries, marks, multipliers, evidence);

  let missingMarkCount = 0;
  let staleMarkCount = 0;
  for (const p of positions) {
    if (p.markStatus === "MISSING" || p.markStatus === "ONE_SIDED" || p.markStatus === "MARKET_CLOSED" && p.marketPrice == null) {
      missingMarkCount += 1;
    }
    if (p.markStatus === "STALE" || p.markStatus === "WIDE_SPREAD") staleMarkCount += 1;
  }

  const grossPositionValue = roundMoney(positions.reduce((s, p) => s + p.marketValueDollars, 0));
  const unrealizedPnl = roundMoney(positions.reduce((s, p) => s + p.unrealizedPnlDollars, 0));
  const realizedPnl = computeRealizedPnlDollars(entries, multipliers);
  const totalEquity = roundMoney(balances.cash + grossPositionValue);

  const priorHwm = priorHighWaterMark(db, accountId);
  const highWaterMark = roundMoney(Math.max(priorHwm, totalEquity));
  const drawdownDollars = roundMoney(Math.max(0, highWaterMark - totalEquity));
  const drawdownPct =
    highWaterMark > 0 ? roundMoney((drawdownDollars / highWaterMark) * 100) : 0;

  let completeness: SnapshotCompleteness = "COMPLETE";
  if (missingMarkCount > 0 && missingMarkCount < positions.length) completeness = "PARTIAL";
  if (missingMarkCount > 0 && (positions.length === 0 || missingMarkCount === positions.length)) {
    completeness = positions.length === 0 ? "COMPLETE" : "INCOMPLETE";
  }
  if (staleMarkCount > 0 && completeness === "COMPLETE") completeness = "PARTIAL";

  return {
    accountId,
    asOfMs,
    cash: balances.cash,
    reserved: balances.reserved,
    buyingPower: balances.buyingPower,
    grossPositionValue,
    unrealizedPnl,
    realizedPnl,
    totalEquity,
    highWaterMark,
    drawdownDollars,
    drawdownPct,
    openPositionCount: positions.length,
    positions,
    ledgerSequenceThrough: balances.ledgerSequenceThrough,
    completeness,
    missingMarkCount,
    staleMarkCount,
    markPolicyVersion: MARK_POLICY_VERSION,
    recordSchemaVersion: BROKER_RECORD_SCHEMA_VERSION,
  };
}

export function snapshotAccountEquity(
  db: BrokerDb,
  accountId: string,
  opts: {
    refKind?: string;
    refId?: string;
    asOfMs?: number;
    source?: string;
  } = {},
): { id: string; equity: AccountEquity } {
  const asOfMs = opts.asOfMs ?? Date.now();
  const equity = computeAccountEquity(db, accountId, asOfMs);
  const id = brokerId("beq");
  const meta = {
    source: opts.source ?? "b3_equity",
    refKind: opts.refKind ?? "SYSTEM",
    refId: opts.refId ?? accountId,
    markPolicyVersion: equity.markPolicyVersion,
    missingMarkCount: equity.missingMarkCount,
    staleMarkCount: equity.staleMarkCount,
    openPositionCount: equity.openPositionCount,
    positions: equity.positions.map((p) => ({
      symbol: p.symbol,
      assetClass: p.assetClass,
      qty: p.quantity,
      mark: p.marketPrice,
      mv: p.marketValueDollars,
      upnl: p.unrealizedPnlDollars,
      markStatus: p.markStatus,
    })),
  };

  db.prepare(
    `INSERT INTO broker_equity_snapshots
      (id, account_id, snapshot_at_ms, cash_balance, reserved_balance, buying_power,
       gross_position_value, net_equity, unrealized_pnl, realized_pnl_cumulative,
       high_water_mark, drawdown_dollars, drawdown_pct, completeness_status, mark_policy_version,
       ledger_sequence_through, record_schema_version, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    accountId,
    asOfMs,
    equity.cash,
    equity.reserved,
    equity.buyingPower,
    equity.grossPositionValue,
    equity.totalEquity,
    equity.unrealizedPnl,
    equity.realizedPnl,
    equity.highWaterMark,
    equity.drawdownDollars,
    equity.drawdownPct,
    equity.completeness,
    equity.markPolicyVersion,
    equity.ledgerSequenceThrough,
    BROKER_RECORD_SCHEMA_VERSION,
    JSON.stringify(meta),
  );

  appendAuditEvent(db, {
    accountId,
    eventKind: "EQUITY_SNAPSHOT_RECORDED",
    entityKind: "EQUITY",
    entityId: id,
    payload: {
      totalEquity: equity.totalEquity,
      completeness: equity.completeness,
      highWaterMark: equity.highWaterMark,
      drawdownPct: equity.drawdownPct,
    },
    createdAtMs: asOfMs,
  });

  return { id, equity };
}

/** Equity curve from immutable snapshots (dollar equity, not cumulative %). */
export function readEquityCurve(
  db: BrokerDb,
  accountId: string,
  opts: { fromMs?: number; limit?: number } = {},
): Array<{
  snapshotId: string;
  atMs: number;
  totalEquity: number;
  cash: number;
  grossPositionValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  highWaterMark: number | null;
  drawdownPct: number | null;
  completeness: string | null;
}> {
  const limit = opts.limit ?? 500;
  const fromMs = opts.fromMs;
  const rows = (
    fromMs != null
      ? db
          .prepare(
            `SELECT id, snapshot_at_ms, cash_balance, gross_position_value, net_equity,
                    unrealized_pnl, realized_pnl_cumulative, high_water_mark, drawdown_pct, completeness_status
             FROM broker_equity_snapshots
             WHERE account_id = ? AND snapshot_at_ms >= ?
             ORDER BY snapshot_at_ms ASC LIMIT ?`,
          )
          .all?.(accountId, fromMs, limit)
      : db
          .prepare(
            `SELECT id, snapshot_at_ms, cash_balance, gross_position_value, net_equity,
                    unrealized_pnl, realized_pnl_cumulative, high_water_mark, drawdown_pct, completeness_status
             FROM broker_equity_snapshots
             WHERE account_id = ?
             ORDER BY snapshot_at_ms ASC LIMIT ?`,
          )
          .all?.(accountId, limit)
  ) as Array<Record<string, any>>;

  return (rows ?? []).map((r) => ({
    snapshotId: r.id,
    atMs: r.snapshot_at_ms,
    totalEquity: r.net_equity,
    cash: r.cash_balance,
    grossPositionValue: r.gross_position_value,
    unrealizedPnl: r.unrealized_pnl,
    realizedPnl: r.realized_pnl_cumulative,
    highWaterMark: r.high_water_mark ?? null,
    drawdownPct: r.drawdown_pct ?? null,
    completeness: r.completeness_status ?? null,
  }));
}
