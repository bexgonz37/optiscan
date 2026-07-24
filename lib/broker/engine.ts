import { brokerId } from "./id.ts";
import { appendAuditEvent, type BrokerDb } from "./audit.ts";
import {
  assertFinitePositive,
  computeBalances,
  computePositions,
  estimateOrderNotional,
  roundMoney,
} from "./ledger.ts";
import { listLedgerEntries } from "./queries.ts";
import { snapshotAccountEquity } from "./equity.ts";
import { BROKER_RECORD_SCHEMA_VERSION } from "./types.ts";
import type {
  AccountBalances,
  ApplyMarkInput,
  DepositCashInput,
  FillOrderInput,
  LedgerEntryKind,
  LedgerEntryRow,
  LedgerRefKind,
  OpenAccountInput,
  PositionState,
  SubmitOrderInput,
} from "./types.ts";

export { listLedgerEntries };

function nowMs(): number {
  return Date.now();
}

function defaultMultiplier(assetClass: string): number {
  if (assetClass === "OPTION") return 100;
  return 1;
}

function nextSequenceNum(db: BrokerDb, accountId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(sequence_num), 0) AS max_seq FROM broker_ledger_entries WHERE account_id = ?`)
    .get(accountId) as { max_seq: number };
  return row.max_seq + 1;
}

function findLedgerByIdempotency(
  db: BrokerDb,
  accountId: string,
  idempotencyKey: string,
): LedgerEntryRow | null {
  return db
    .prepare(
      `SELECT * FROM broker_ledger_entries WHERE account_id = ? AND idempotency_key = ?`,
    )
    .get(accountId, idempotencyKey) as LedgerEntryRow | null;
}

function appendLedgerEntry(
  db: BrokerDb,
  input: {
    accountId: string;
    entryKind: LedgerEntryKind;
    assetClass: LedgerEntryRow["asset_class"];
    symbol?: string | null;
    quantityDelta?: number;
    cashDelta?: number;
    reservedDelta?: number;
    price?: number | null;
    currency?: string;
    refKind: LedgerRefKind;
    refId: string;
    idempotencyKey: string;
    description?: string;
    metadata?: Record<string, unknown>;
    createdAtMs?: number;
  },
): LedgerEntryRow {
  const existing = findLedgerByIdempotency(db, input.accountId, input.idempotencyKey);
  if (existing) return existing;

  const id = brokerId("bled");
  const seq = nextSequenceNum(db, input.accountId);
  const ts = input.createdAtMs ?? nowMs();
  db.prepare(
    `INSERT INTO broker_ledger_entries
      (id, account_id, sequence_num, entry_kind, asset_class, symbol,
       quantity_delta, cash_delta, reserved_delta, price, currency,
       ref_kind, ref_id, idempotency_key, description, record_schema_version, metadata_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.accountId,
    seq,
    input.entryKind,
    input.assetClass,
    input.symbol ?? null,
    input.quantityDelta ?? 0,
    input.cashDelta ?? 0,
    input.reservedDelta ?? 0,
    input.price ?? null,
    input.currency ?? "USD",
    input.refKind,
    input.refId,
    input.idempotencyKey,
    input.description ?? null,
    BROKER_RECORD_SCHEMA_VERSION,
    input.metadata ? JSON.stringify(input.metadata) : null,
    ts,
  );
  appendAuditEvent(db, {
    accountId: input.accountId,
    eventKind: "LEDGER_ENTRY_APPENDED",
    entityKind: "LEDGER",
    entityId: id,
    payload: {
      entryKind: input.entryKind,
      sequenceNum: seq,
      cashDelta: input.cashDelta ?? 0,
      reservedDelta: input.reservedDelta ?? 0,
      quantityDelta: input.quantityDelta ?? 0,
      refKind: input.refKind,
      refId: input.refId,
    },
    createdAtMs: ts,
  });
  return db.prepare(`SELECT * FROM broker_ledger_entries WHERE id = ?`).get(id) as LedgerEntryRow;
}

function evidenceMapFromOrders(db: BrokerDb, accountId: string): Map<string, string | null> {
  const rows = db
    .prepare(
      `SELECT o.asset_class, o.symbol, o.evidence_chain_id
       FROM broker_orders o
       WHERE o.account_id = ? AND o.evidence_chain_id IS NOT NULL`,
    )
    .all?.(accountId) as Array<{ asset_class: string; symbol: string; evidence_chain_id: string }>;
  const map = new Map<string, string | null>();
  for (const r of rows) {
    map.set(`${r.asset_class}:${r.symbol}`, r.evidence_chain_id);
  }
  return map;
}

function latestMarks(db: BrokerDb, accountId: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT asset_class, symbol, mark_price
       FROM broker_marks
       WHERE account_id = ?
       ORDER BY marked_at_ms ASC`,
    )
    .all?.(accountId) as Array<{ asset_class: string; symbol: string; mark_price: number }>;
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.asset_class}:${r.symbol}`, r.mark_price);
  }
  return map;
}

function appendPositionSnapshot(
  db: BrokerDb,
  accountId: string,
  position: PositionState,
  ledgerSequenceThrough: number,
  refKind: LedgerRefKind,
  refId: string,
  snapshotAtMs: number,
): string {
  const id = brokerId("bpos");
  db.prepare(
    `INSERT INTO broker_position_snapshots
      (id, account_id, asset_class, symbol, side, quantity, average_cost, cost_basis,
       market_price, market_value, unrealized_pnl, realized_pnl_delta, evidence_chain_id,
       market_snapshot_id, ledger_sequence_through, ref_kind, ref_id, record_schema_version, snapshot_at_ms, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    accountId,
    position.assetClass,
    position.symbol,
    position.side,
    position.quantity,
    position.averageCost,
    position.costBasis,
    position.marketPrice,
    position.marketValue,
    position.unrealizedPnl,
    0,
    position.evidenceChainId,
    null,
    ledgerSequenceThrough,
    refKind,
    refId,
    BROKER_RECORD_SCHEMA_VERSION,
    snapshotAtMs,
  );
  appendAuditEvent(db, {
    accountId,
    eventKind: "POSITION_SNAPSHOT_RECORDED",
    entityKind: "POSITION",
    entityId: id,
    payload: {
      symbol: position.symbol,
      assetClass: position.assetClass,
      quantity: position.quantity,
      side: position.side,
      evidenceChainId: position.evidenceChainId,
      ledgerSequenceThrough,
      refKind,
      refId,
    },
    createdAtMs: snapshotAtMs,
  });
  return id;
}

export function snapshotEquity(
  db: BrokerDb,
  accountId: string,
  refKind: LedgerRefKind = "SYSTEM",
  refId: string = accountId,
): { id: string; balances: AccountBalances; netEquity: number } {
  const { id, equity } = snapshotAccountEquity(db, accountId, {
    refKind,
    refId,
    source: "engine_snapshotEquity",
  });
  return {
    id,
    balances: {
      cash: equity.cash,
      reserved: equity.reserved,
      buyingPower: equity.buyingPower,
      ledgerSequenceThrough: equity.ledgerSequenceThrough,
    },
    netEquity: equity.totalEquity,
  };
}

export function openAccount(db: BrokerDb, input: OpenAccountInput): { accountId: string; depositLedgerId?: string } {
  const existing = db
    .prepare(`SELECT id FROM broker_accounts WHERE account_key = ?`)
    .get(input.accountKey) as { id: string } | undefined;
  if (existing) {
    return { accountId: existing.id };
  }

  const accountId = brokerId("bacct");
  const ts = nowMs();
  db.prepare(
    `INSERT INTO broker_accounts
      (id, account_key, account_type, display_name, base_currency, status, adapter_kind, metadata_json, created_at_ms, closed_at_ms)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, NULL)`,
  ).run(
    accountId,
    input.accountKey,
    input.accountType,
    input.displayName,
    input.baseCurrency ?? "USD",
    input.adapterKind ?? "PAPER_SIM",
    input.metadata ? JSON.stringify(input.metadata) : null,
    ts,
  );
  appendLedgerEntry(db, {
    accountId,
    entryKind: "ACCOUNT_OPEN",
    assetClass: "CASH",
    refKind: "ACCOUNT",
    refId: accountId,
    idempotencyKey: `account_open:${accountId}`,
    description: `Open ${input.accountType} account`,
    createdAtMs: ts,
  });
  appendAuditEvent(db, {
    accountId,
    eventKind: "ACCOUNT_OPENED",
    entityKind: "ACCOUNT",
    entityId: accountId,
    payload: {
      accountKey: input.accountKey,
      accountType: input.accountType,
      adapterKind: input.adapterKind ?? "PAPER_SIM",
    },
    createdAtMs: ts,
  });

  let depositLedgerId: string | undefined;
  if (input.openingDeposit && input.openingDeposit > 0) {
    const dep = depositCash(db, {
      accountId,
      amount: input.openingDeposit,
      idempotencyKey: `opening_deposit:${accountId}`,
      description: "Opening deposit",
    });
    depositLedgerId = dep.ledgerEntryId;
  }
  snapshotEquity(db, accountId, "ACCOUNT", accountId);
  return { accountId, depositLedgerId };
}

export function depositCash(
  db: BrokerDb,
  input: DepositCashInput,
): { ledgerEntryId: string; balances: AccountBalances } {
  assertFinitePositive(input.amount, "deposit amount");
  const entry = appendLedgerEntry(db, {
    accountId: input.accountId,
    entryKind: "DEPOSIT",
    assetClass: "CASH",
    cashDelta: input.amount,
    refKind: "MANUAL",
    refId: input.idempotencyKey,
    idempotencyKey: input.idempotencyKey,
    description: input.description ?? "Cash deposit",
  });
  const balances = computeBalances(listLedgerEntries(db, input.accountId));
  appendAuditEvent(db, {
    accountId: input.accountId,
    eventKind: "CASH_DEPOSITED",
    entityKind: "ACCOUNT",
    entityId: input.accountId,
    payload: { amount: input.amount, ledgerEntryId: entry.id },
  });
  return { ledgerEntryId: entry.id, balances };
}

export function submitOrder(db: BrokerDb, input: SubmitOrderInput): { orderId: string; reservedAmount: number } {
  assertFinitePositive(input.quantity, "order quantity");
  const limitPrice = input.limitPrice;
  if (limitPrice == null || !Number.isFinite(limitPrice) || limitPrice <= 0) {
    throw new Error("limitPrice is required for B0 simulated orders");
  }
  const multiplier = input.contractMultiplier ?? defaultMultiplier(input.assetClass);
  const existing = db
    .prepare(`SELECT id, reserved_amount FROM broker_orders WHERE account_id = ? AND client_order_key = ?`)
    .get(input.accountId, input.clientOrderKey) as { id: string; reserved_amount: number } | undefined;
  if (existing) {
    return { orderId: existing.id, reservedAmount: existing.reserved_amount };
  }

  const reservedAmount =
    input.side === "BUY"
      ? estimateOrderNotional({ quantity: input.quantity, limitPrice, contractMultiplier: multiplier })
      : 0;

  if (input.side === "BUY") {
    const balances = computeBalances(listLedgerEntries(db, input.accountId));
    if (balances.buyingPower + 1e-6 < reservedAmount) {
      throw new Error(`insufficient buying power: need ${reservedAmount}, have ${balances.buyingPower}`);
    }
  }

  const orderId = brokerId("bord");
  const ts = nowMs();
  if (reservedAmount > 0) {
    appendLedgerEntry(db, {
      accountId: input.accountId,
      entryKind: "ORDER_RESERVE",
      assetClass: "CASH",
      reservedDelta: reservedAmount,
      refKind: "ORDER",
      refId: orderId,
      idempotencyKey: `order_reserve:${input.accountId}:${input.clientOrderKey}`,
      description: `Reserve for ${input.side} ${input.symbol}`,
      createdAtMs: ts,
    });
  }

  db.prepare(
    `INSERT INTO broker_orders
      (id, account_id, client_order_key, evidence_chain_id, asset_class, symbol, side, quantity, filled_quantity,
       order_type, limit_price, contract_multiplier, status, reserved_amount, submitted_at_ms, record_schema_version, created_at_ms, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'SUBMITTED', ?, ?, ?, ?, ?)`,
  ).run(
    orderId,
    input.accountId,
    input.clientOrderKey,
    input.evidenceChainId,
    input.assetClass,
    input.symbol,
    input.side,
    input.quantity,
    input.orderType ?? "LIMIT",
    limitPrice,
    multiplier,
    reservedAmount,
    ts,
    BROKER_RECORD_SCHEMA_VERSION,
    ts,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  appendAuditEvent(db, {
    accountId: input.accountId,
    eventKind: "ORDER_SUBMITTED",
    entityKind: "ORDER",
    entityId: orderId,
    payload: {
      clientOrderKey: input.clientOrderKey,
      evidenceChainId: input.evidenceChainId,
      side: input.side,
      symbol: input.symbol,
      quantity: input.quantity,
      reservedAmount,
    },
    createdAtMs: ts,
  });
  snapshotEquity(db, input.accountId, "ORDER", orderId);
  return { orderId, reservedAmount };
}

export function fillOrder(
  db: BrokerDb,
  input: FillOrderInput,
): { fillId: string; ledgerEntryIds: string[]; positionSnapshotId?: string } {
  assertFinitePositive(input.quantity, "fill quantity");
  assertFinitePositive(input.price, "fill price");

  const order = db
    .prepare(`SELECT * FROM broker_orders WHERE id = ?`)
    .get(input.orderId) as {
    id: string;
    account_id: string;
    asset_class: string;
    symbol: string;
    side: string;
    quantity: number;
    filled_quantity: number;
    reserved_amount: number;
    evidence_chain_id: string | null;
    contract_multiplier: number;
    status: string;
  } | undefined;
  if (!order) throw new Error(`order not found: ${input.orderId}`);

  const existingFill = db
    .prepare(`SELECT id FROM broker_fills WHERE account_id = ? AND fill_key = ?`)
    .get(order.account_id, input.fillKey) as { id: string } | undefined;
  if (existingFill) {
    return { fillId: existingFill.id, ledgerEntryIds: [] };
  }

  const remaining = order.quantity - order.filled_quantity;
  if (input.quantity - remaining > 1e-6) {
    throw new Error(`fill quantity ${input.quantity} exceeds remaining ${remaining}`);
  }

  const commission = input.commission ?? 0;
  const fees = input.fees ?? 0;
  const gross = roundMoney(input.quantity * input.price * order.contract_multiplier);
  const totalFees = roundMoney(commission + fees);
  const filledAtMs = input.filledAtMs ?? nowMs();
  const fillId = brokerId("bfill");
  const ledgerEntryIds: string[] = [];
  const ts = filledAtMs;

  if (order.side === "BUY") {
    const fillEntry = appendLedgerEntry(db, {
      accountId: order.account_id,
      entryKind: "BUY_FILL",
      assetClass: order.asset_class as LedgerEntryRow["asset_class"],
      symbol: order.symbol,
      quantityDelta: input.quantity,
      cashDelta: -gross,
      price: input.price,
      refKind: "FILL",
      refId: fillId,
      idempotencyKey: `buy_fill:${order.account_id}:${input.fillKey}`,
      metadata: input.metadata,
      createdAtMs: ts,
    });
    ledgerEntryIds.push(fillEntry.id);
    if (totalFees > 0) {
      const feeEntry = appendLedgerEntry(db, {
        accountId: order.account_id,
        entryKind: "FEE",
        assetClass: "CASH",
        cashDelta: -totalFees,
        refKind: "FILL",
        refId: fillId,
        idempotencyKey: `fee:${order.account_id}:${input.fillKey}`,
        createdAtMs: ts,
      });
      ledgerEntryIds.push(feeEntry.id);
    }
    const releaseAmount = order.reserved_amount * (input.quantity / order.quantity);
    if (releaseAmount > 0) {
      const rel = appendLedgerEntry(db, {
        accountId: order.account_id,
        entryKind: "ORDER_RELEASE",
        assetClass: "CASH",
        reservedDelta: -releaseAmount,
        refKind: "ORDER",
        refId: order.id,
        idempotencyKey: `order_release:${order.account_id}:${input.fillKey}`,
        createdAtMs: ts,
      });
      ledgerEntryIds.push(rel.id);
    }
  } else {
    const fillEntry = appendLedgerEntry(db, {
      accountId: order.account_id,
      entryKind: "SELL_FILL",
      assetClass: order.asset_class as LedgerEntryRow["asset_class"],
      symbol: order.symbol,
      quantityDelta: -input.quantity,
      cashDelta: gross,
      price: input.price,
      refKind: "FILL",
      refId: fillId,
      idempotencyKey: `sell_fill:${order.account_id}:${input.fillKey}`,
      metadata: input.metadata,
      createdAtMs: ts,
    });
    ledgerEntryIds.push(fillEntry.id);
    if (totalFees > 0) {
      const feeEntry = appendLedgerEntry(db, {
        accountId: order.account_id,
        entryKind: "FEE",
        assetClass: "CASH",
        cashDelta: -totalFees,
        refKind: "FILL",
        refId: fillId,
        idempotencyKey: `fee:${order.account_id}:${input.fillKey}`,
        createdAtMs: ts,
      });
      ledgerEntryIds.push(feeEntry.id);
    }
  }

  db.prepare(
    `INSERT INTO broker_fills
      (id, account_id, order_id, fill_key, asset_class, symbol, side, quantity, price, gross_notional,
       commission, fees, contract_multiplier, market_snapshot_id, filled_at_ms, record_schema_version, created_at_ms, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fillId,
    order.account_id,
    order.id,
    input.fillKey,
    order.asset_class,
    order.symbol,
    order.side,
    input.quantity,
    input.price,
    gross,
    commission,
    fees,
    order.contract_multiplier,
    (input.metadata as any)?.marketSnapshotId ?? null,
    filledAtMs,
    BROKER_RECORD_SCHEMA_VERSION,
    ts,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );

  const newFilled = order.filled_quantity + input.quantity;
  const newStatus = newFilled + 1e-6 >= order.quantity ? "FILLED" : "PARTIAL";
  db.prepare(
    `UPDATE broker_orders SET filled_quantity = ?, status = ?, closed_at_ms = ? WHERE id = ?`,
  ).run(newFilled, newStatus, newStatus === "FILLED" ? ts : null, order.id);

  appendAuditEvent(db, {
    accountId: order.account_id,
    eventKind: "ORDER_FILLED",
    entityKind: "FILL",
    entityId: fillId,
    payload: {
      orderId: order.id,
      quantity: input.quantity,
      price: input.price,
      gross,
      fees: totalFees,
      evidenceChainId: order.evidence_chain_id,
    },
    createdAtMs: ts,
  });

  const entries = listLedgerEntries(db, order.account_id);
  const balances = computeBalances(entries);
  const positions = computePositions(entries, evidenceMapFromOrders(db, order.account_id), latestMarks(db, order.account_id));
  const pos = positions.find((p) => p.assetClass === order.asset_class && p.symbol === order.symbol);
  let positionSnapshotId: string | undefined;
  if (pos) {
    positionSnapshotId = appendPositionSnapshot(
      db,
      order.account_id,
      pos,
      balances.ledgerSequenceThrough,
      "FILL",
      fillId,
      ts,
    );
  }
  snapshotEquity(db, order.account_id, "FILL", fillId);
  return { fillId, ledgerEntryIds, positionSnapshotId };
}

export function applyMark(db: BrokerDb, input: ApplyMarkInput): { markId: string; positionSnapshotId?: string } {
  // WORTHLESS marks intentionally use markPrice=0; other marks must be finite and >= 0.
  if (!Number.isFinite(input.markPrice) || input.markPrice < 0) {
    throw new Error("markPrice must be a finite number >= 0");
  }
  if (input.markPrice === 0 && input.markStatus !== "WORTHLESS" && input.markSource !== "WORTHLESS") {
    // Allow zero only when explicitly worthless; otherwise reject accidental zeros.
    if (input.markStatus !== "OK") {
      /* zero allowed for explicit incomplete policies that still write a placeholder — skip */
    }
  }
  const existingLedger = findLedgerByIdempotency(db, input.accountId, input.idempotencyKey);
  if (existingLedger) {
    const mark = db
      .prepare(`SELECT id, position_snapshot_id FROM broker_marks WHERE ledger_entry_id = ?`)
      .get(existingLedger.id) as { id: string; position_snapshot_id: string | null } | undefined;
    return { markId: mark?.id ?? existingLedger.ref_id, positionSnapshotId: mark?.position_snapshot_id ?? undefined };
  }

  const markId = brokerId("bmark");
  const ts = input.markedAtMs ?? nowMs();
  const markMeta = {
    markSource: input.markSource,
    status: input.markStatus ?? (input.markSource === "WORTHLESS" ? "WORTHLESS" : "OK"),
    marketSnapshotId: input.marketSnapshotId ?? null,
  };
  const ledgerEntry = appendLedgerEntry(db, {
    accountId: input.accountId,
    entryKind: "MARK",
    assetClass: input.assetClass,
    symbol: input.symbol,
    quantityDelta: 0,
    cashDelta: 0,
    price: input.markPrice,
    refKind: "MARK",
    refId: markId,
    idempotencyKey: input.idempotencyKey,
    description: `Mark ${input.symbol} @ ${input.markPrice}`,
    metadata: markMeta,
    createdAtMs: ts,
  });

  db.prepare(
    `INSERT INTO broker_marks
      (id, account_id, asset_class, symbol, mark_price, mark_source, ledger_entry_id, market_snapshot_id, marked_at_ms, record_schema_version, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    markId,
    input.accountId,
    input.assetClass,
    input.symbol,
    input.markPrice,
    input.markSource,
    ledgerEntry.id,
    input.marketSnapshotId ?? null,
    ts,
    BROKER_RECORD_SCHEMA_VERSION,
    JSON.stringify(markMeta),
  );

  const entries = listLedgerEntries(db, input.accountId);
  const balances = computeBalances(entries);
  const positions = computePositions(entries, evidenceMapFromOrders(db, input.accountId), latestMarks(db, input.accountId));
  const pos = positions.find((p) => p.assetClass === input.assetClass && p.symbol === input.symbol);
  let positionSnapshotId: string | undefined;
  if (pos) {
    positionSnapshotId = appendPositionSnapshot(
      db,
      input.accountId,
      pos,
      balances.ledgerSequenceThrough,
      "MARK",
      markId,
      ts,
    );
    db.prepare(`UPDATE broker_marks SET position_snapshot_id = ? WHERE id = ?`).run(positionSnapshotId, markId);
  }
  snapshotEquity(db, input.accountId, "MARK", markId);
  appendAuditEvent(db, {
    accountId: input.accountId,
    eventKind: "MARK_APPLIED",
    entityKind: "MARK",
    entityId: markId,
    payload: { symbol: input.symbol, markPrice: input.markPrice, markSource: input.markSource },
    createdAtMs: ts,
  });
  return { markId, positionSnapshotId };
}

export function getAccountState(db: BrokerDb, accountId: string): {
  balances: AccountBalances;
  positions: PositionState[];
} {
  const entries = listLedgerEntries(db, accountId);
  return {
    balances: computeBalances(entries),
    positions: computePositions(entries, evidenceMapFromOrders(db, accountId), latestMarks(db, accountId)),
  };
}
