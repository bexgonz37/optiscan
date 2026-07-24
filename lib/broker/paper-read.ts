/**
 * B4 — read models for brokerage V2 paper APIs (account, positions, orders, fills,
 * ledger, equity curve, stats, evidence drill-down). Pure over broker_* tables.
 */
import type { BrokerDb } from "./audit.ts";
import { listAuditEventsForEntity } from "./audit.ts";
import { getEvidenceChain } from "./evidence.ts";
import { computeAccountEquity, readEquityCurve } from "./equity.ts";
import { reconcileAccountEquity } from "./reconcile.ts";
import { openingBalanceUsd } from "./accounts.ts";
import { roundMoney } from "./ledger.ts";
import { listLedgerEntries } from "./queries.ts";
import { parseOccSymbol, underlyingFromSymbol } from "./occ.ts";
import { BROKER_V2_SURFACE_LABEL } from "./surface.ts";
import type { AccountType, BrokerAccountRow } from "./types.ts";

export interface PaperApiFilters {
  accountKey?: string | null;
  accountId?: string | null;
  accountType?: AccountType | string | null;
  /** delivered → subscriber_paper; research → research_shadow */
  audience?: "delivered" | "research" | "replay" | string | null;
  fromMs?: number | null;
  toMs?: number | null;
  strategy?: string | null;
  underlying?: string | null;
  status?: string | null;
  completeness?: string | null;
  limit?: number;
  offset?: number;
  evidenceChainId?: string | null;
}

function clampLimit(n: number | undefined, d = 100, max = 500): number {
  const v = Number.isFinite(n as number) ? Math.floor(n as number) : d;
  return Math.max(1, Math.min(max, v));
}

function clampOffset(n: number | undefined): number {
  const v = Number.isFinite(n as number) ? Math.floor(n as number) : 0;
  return Math.max(0, v);
}

function parseMeta(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function audienceToAccountKey(audience: string | null | undefined): string | null {
  if (!audience) return null;
  const a = audience.toLowerCase();
  if (a === "delivered" || a === "subscriber" || a === "subscriber_paper") return "subscriber_paper";
  if (a === "research" || a === "shadow" || a === "research_shadow") return "research_shadow";
  if (a === "replay" || a === "replay_lab") return "replay_lab";
  return null;
}

export function resolveBrokerAccount(
  db: BrokerDb,
  filters: PaperApiFilters,
): BrokerAccountRow | null {
  if (filters.accountId) {
    return (db.prepare(`SELECT * FROM broker_accounts WHERE id = ?`).get(filters.accountId) as
      | BrokerAccountRow
      | undefined) ?? null;
  }
  const keyFromAudience = audienceToAccountKey(filters.audience ?? null);
  const key = filters.accountKey || keyFromAudience;
  if (key) {
    return (db.prepare(`SELECT * FROM broker_accounts WHERE account_key = ?`).get(key) as
      | BrokerAccountRow
      | undefined) ?? null;
  }
  if (filters.accountType) {
    return (db
      .prepare(
        `SELECT * FROM broker_accounts WHERE account_type = ? AND status = 'ACTIVE' ORDER BY created_at_ms ASC LIMIT 1`,
      )
      .get(filters.accountType) as BrokerAccountRow | undefined) ?? null;
  }
  // Default research surface: prefer research_shadow, else first active account.
  return (
    (db.prepare(`SELECT * FROM broker_accounts WHERE account_key = 'research_shadow'`).get() as
      | BrokerAccountRow
      | undefined) ??
    (db
      .prepare(`SELECT * FROM broker_accounts WHERE status = 'ACTIVE' ORDER BY created_at_ms ASC LIMIT 1`)
      .get() as BrokerAccountRow | undefined) ??
    null
  );
}

export function listBrokerAccounts(db: BrokerDb, filters: PaperApiFilters = {}): BrokerAccountRow[] {
  const rows = (db.prepare(`SELECT * FROM broker_accounts ORDER BY created_at_ms ASC`).all?.() ??
    []) as BrokerAccountRow[];
  return rows.filter((a) => {
    if (filters.accountType && a.account_type !== filters.accountType) return false;
    if (filters.accountKey && a.account_key !== filters.accountKey) return false;
    if (filters.accountId && a.id !== filters.accountId) return false;
    const audKey = audienceToAccountKey(filters.audience ?? null);
    if (audKey && a.account_key !== audKey) return false;
    return true;
  });
}

function startingCash(db: BrokerDb, accountId: string, env: NodeJS.ProcessEnv): number {
  const dep = db
    .prepare(
      `SELECT SUM(cash_delta) AS s FROM broker_ledger_entries
       WHERE account_id = ? AND entry_kind IN ('DEPOSIT','ACCOUNT_OPEN')`,
    )
    .get(accountId) as { s: number | null } | undefined;
  if (dep?.s != null && Number.isFinite(dep.s) && dep.s > 0) return roundMoney(dep.s);
  return openingBalanceUsd(env);
}

function latestMarkRow(
  db: BrokerDb,
  accountId: string,
  assetClass: string,
  symbol: string,
): { mark_price: number; marked_at_ms: number; mark_source: string; metadata_json: string | null } | null {
  return (db
    .prepare(
      `SELECT mark_price, marked_at_ms, mark_source, metadata_json FROM broker_marks
       WHERE account_id = ? AND asset_class = ? AND symbol = ?
       ORDER BY marked_at_ms DESC LIMIT 1`,
    )
    .get(accountId, assetClass, symbol) as
    | { mark_price: number; marked_at_ms: number; mark_source: string; metadata_json: string | null }
    | undefined) ?? null;
}

export function buildAccountSummary(
  db: BrokerDb,
  account: BrokerAccountRow,
  env: NodeJS.ProcessEnv = process.env,
) {
  const equity = computeAccountEquity(db, account.id);
  const checks = reconcileAccountEquity(equity);
  return {
    label: BROKER_V2_SURFACE_LABEL,
    authoritative: false,
    account: {
      id: account.id,
      accountKey: account.account_key,
      accountType: account.account_type,
      displayName: account.display_name,
      status: account.status,
      adapterKind: account.adapter_kind,
      createdAtMs: account.created_at_ms,
    },
    startingCash: startingCash(db, account.id, env),
    cash: equity.cash,
    reservedCash: equity.reserved,
    buyingPower: equity.buyingPower,
    totalEquity: equity.totalEquity,
    realizedPnl: equity.realizedPnl,
    unrealizedPnl: equity.unrealizedPnl,
    openPositionMarketValue: equity.grossPositionValue,
    highWaterMark: equity.highWaterMark,
    drawdownDollars: equity.drawdownDollars,
    drawdownPct: equity.drawdownPct,
    openPositionCount: equity.openPositionCount,
    completeness: equity.completeness,
    missingMarkCount: equity.missingMarkCount,
    staleMarkCount: equity.staleMarkCount,
    markPolicyVersion: equity.markPolicyVersion,
    ledgerSequenceThrough: equity.ledgerSequenceThrough,
    reconciliation: {
      ok: checks.every((c) => c.ok),
      checks,
    },
  };
}

export function buildPositionsPayload(
  db: BrokerDb,
  account: BrokerAccountRow,
  filters: PaperApiFilters = {},
) {
  const equity = computeAccountEquity(db, account.id);
  const asOfMs = Date.now();
  let positions = equity.positions.map((p) => {
    const occ = parseOccSymbol(p.symbol, asOfMs);
    const markRow = latestMarkRow(db, account.id, p.assetClass, p.symbol);
    const markMeta = parseMeta(markRow?.metadata_json);
    const cost = p.costBasisDollars;
    const unrealizedReturnPct =
      cost > 0 ? roundMoney((p.unrealizedPnlDollars / cost) * 100) : null;
    return {
      accountId: account.id,
      assetClass: p.assetClass,
      occSymbol: occ.occSymbol || p.symbol,
      symbol: p.symbol,
      underlying: occ.underlying,
      right: occ.right,
      strike: occ.strike,
      expiration: occ.expiration,
      dte: occ.dte,
      side: p.side,
      contracts: p.quantity,
      averageEntryCost: p.averageCost,
      costBasisDollars: p.costBasisDollars,
      currentMark: p.marketPrice,
      marketValue: p.marketValueDollars,
      unrealizedPnl: p.unrealizedPnlDollars,
      unrealizedReturnPct,
      markTimestampMs: markRow?.marked_at_ms ?? null,
      markSource: markRow?.mark_source ?? null,
      markStatus: p.markStatus,
      markQuality: p.markStatus,
      evidenceChainId: p.evidenceChainId,
      multiplier: p.multiplier,
    };
  });

  if (filters.underlying) {
    const u = filters.underlying.toUpperCase();
    positions = positions.filter(
      (p) => (p.underlying ?? underlyingFromSymbol(p.symbol) ?? "").toUpperCase() === u,
    );
  }
  if (filters.evidenceChainId) {
    positions = positions.filter((p) => p.evidenceChainId === filters.evidenceChainId);
  }
  if (filters.status) {
    const st = filters.status.toUpperCase();
    positions = positions.filter((p) => String(p.markStatus).toUpperCase() === st || String(p.side) === st);
  }

  const sumMv = roundMoney(positions.reduce((s, p) => s + p.marketValue, 0));
  return {
    label: BROKER_V2_SURFACE_LABEL,
    authoritative: false,
    accountId: account.id,
    accountKey: account.account_key,
    positions,
    aggregate: {
      count: positions.length,
      marketValue: sumMv,
      unrealizedPnl: roundMoney(positions.reduce((s, p) => s + p.unrealizedPnl, 0)),
      matchesAccountGross: Math.abs(sumMv - equity.grossPositionValue) < 0.02 || filters.underlying != null,
    },
  };
}

function strategyFromMeta(meta: Record<string, unknown>, chainJson: Record<string, unknown>): string | null {
  const s =
    (meta.strategy as string) ||
    (meta.strategyId as string) ||
    (chainJson.strategy as string) ||
    (chainJson.strategyId as string) ||
    null;
  return s ? String(s) : null;
}

export function buildOrdersPayload(db: BrokerDb, account: BrokerAccountRow, filters: PaperApiFilters) {
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);
  const rows = (db
    .prepare(
      `SELECT o.*, e.chain_json AS evidence_chain_json
       FROM broker_orders o
       LEFT JOIN broker_evidence_chains e ON e.id = o.evidence_chain_id
       WHERE o.account_id = ?
       ORDER BY o.created_at_ms DESC
       LIMIT ? OFFSET ?`,
    )
    .all?.(account.id, limit, offset) ?? []) as Array<Record<string, any>>;

  let orders = rows.map((o) => {
    const meta = parseMeta(o.metadata_json);
    const chainJson = parseMeta(o.evidence_chain_json);
    const link = db
      .prepare(
        `SELECT * FROM broker_legacy_links WHERE account_id = ? AND (entry_order_id = ? OR exit_order_id = ?) LIMIT 1`,
      )
      .get(account.id, o.id, o.id) as Record<string, any> | undefined;
    const parity = db
      .prepare(
        `SELECT check_kind, matched, created_at_ms FROM broker_parity_events
         WHERE broker_entity_id = ? ORDER BY created_at_ms DESC LIMIT 5`,
      )
      .all?.(o.id) as Array<{ check_kind: string; matched: number; created_at_ms: number }> | undefined;
    const fill = db
      .prepare(
        `SELECT price, commission, fees, market_snapshot_id, filled_at_ms FROM broker_fills
         WHERE order_id = ? ORDER BY filled_at_ms ASC LIMIT 1`,
      )
      .get(o.id) as
      | { price: number; commission: number; fees: number; market_snapshot_id: string | null; filled_at_ms: number }
      | undefined;
    const requested = o.limit_price;
    const fillPrice = fill?.price ?? null;
    const slippage =
      requested != null && fillPrice != null ? roundMoney(fillPrice - Number(requested)) : null;
    return {
      id: o.id,
      accountId: o.account_id,
      clientOrderKey: o.client_order_key,
      status: o.status,
      side: o.side,
      quantity: o.quantity,
      filledQuantity: o.filled_quantity,
      assetClass: o.asset_class,
      symbol: o.symbol,
      underlying: underlyingFromSymbol(o.symbol),
      orderType: o.order_type,
      requestedPrice: requested,
      fillPrice,
      slippage,
      commissions: fill ? roundMoney((fill.commission ?? 0) + (fill.fees ?? 0)) : 0,
      marketSnapshotId: fill?.market_snapshot_id ?? null,
      evidenceChainId: o.evidence_chain_id,
      strategy: strategyFromMeta(meta, chainJson),
      legacyLinkage: link
        ? {
            legacyTable: link.legacy_table,
            legacyId: link.legacy_id,
            linkId: link.id,
          }
        : null,
      parityStatus:
        parity && parity.length
          ? {
              recent: parity.map((p) => ({
                checkKind: p.check_kind,
                matched: !!p.matched,
                atMs: p.created_at_ms,
              })),
              allMatched: parity.every((p) => !!p.matched),
            }
          : null,
      submittedAtMs: o.submitted_at_ms,
      createdAtMs: o.created_at_ms,
      closedAtMs: o.closed_at_ms,
    };
  });

  if (filters.fromMs != null) orders = orders.filter((o) => o.createdAtMs >= filters.fromMs!);
  if (filters.toMs != null) orders = orders.filter((o) => o.createdAtMs <= filters.toMs!);
  if (filters.status) {
    const st = filters.status.toUpperCase();
    orders = orders.filter((o) => o.status === st);
  }
  if (filters.underlying) {
    const u = filters.underlying.toUpperCase();
    orders = orders.filter((o) => (o.underlying ?? "").toUpperCase() === u);
  }
  if (filters.strategy) {
    const s = filters.strategy.toLowerCase();
    orders = orders.filter((o) => (o.strategy ?? "").toLowerCase().includes(s));
  }
  if (filters.evidenceChainId) {
    orders = orders.filter((o) => o.evidenceChainId === filters.evidenceChainId);
  }

  return {
    label: BROKER_V2_SURFACE_LABEL,
    authoritative: false,
    accountId: account.id,
    accountKey: account.account_key,
    pagination: { limit, offset, returned: orders.length },
    orders,
  };
}

export function buildFillsPayload(db: BrokerDb, account: BrokerAccountRow, filters: PaperApiFilters) {
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);
  const rows = (db
    .prepare(
      `SELECT f.*, o.limit_price AS order_limit_price, o.evidence_chain_id, o.status AS order_status
       FROM broker_fills f
       JOIN broker_orders o ON o.id = f.order_id
       WHERE f.account_id = ?
       ORDER BY f.filled_at_ms DESC
       LIMIT ? OFFSET ?`,
    )
    .all?.(account.id, limit, offset) ?? []) as Array<Record<string, any>>;

  let fills = rows.map((f) => {
    const link = db
      .prepare(
        `SELECT * FROM broker_legacy_links WHERE account_id = ? AND (entry_fill_id = ? OR exit_fill_id = ?) LIMIT 1`,
      )
      .get(account.id, f.id, f.id) as Record<string, any> | undefined;
    const parity = db
      .prepare(
        `SELECT check_kind, matched, created_at_ms FROM broker_parity_events
         WHERE broker_entity_id = ? ORDER BY created_at_ms DESC LIMIT 5`,
      )
      .all?.(f.id) as Array<{ check_kind: string; matched: number; created_at_ms: number }> | undefined;
    const requested = f.order_limit_price;
    const slippage =
      requested != null ? roundMoney(Number(f.price) - Number(requested)) : null;
    return {
      id: f.id,
      accountId: f.account_id,
      orderId: f.order_id,
      orderStatus: f.order_status,
      side: f.side,
      quantity: f.quantity,
      requestedPrice: requested,
      fillPrice: f.price,
      slippage,
      commissions: roundMoney((f.commission ?? 0) + (f.fees ?? 0)),
      grossNotional: f.gross_notional,
      marketSnapshotId: f.market_snapshot_id,
      symbol: f.symbol,
      underlying: underlyingFromSymbol(f.symbol),
      evidenceChainId: f.evidence_chain_id,
      legacyLinkage: link
        ? { legacyTable: link.legacy_table, legacyId: link.legacy_id, linkId: link.id }
        : null,
      parityStatus:
        parity && parity.length
          ? {
              recent: parity.map((p) => ({
                checkKind: p.check_kind,
                matched: !!p.matched,
                atMs: p.created_at_ms,
              })),
              allMatched: parity.every((p) => !!p.matched),
            }
          : null,
      filledAtMs: f.filled_at_ms,
    };
  });

  if (filters.fromMs != null) fills = fills.filter((f) => f.filledAtMs >= filters.fromMs!);
  if (filters.toMs != null) fills = fills.filter((f) => f.filledAtMs <= filters.toMs!);
  if (filters.underlying) {
    const u = filters.underlying.toUpperCase();
    fills = fills.filter((f) => (f.underlying ?? "").toUpperCase() === u);
  }
  if (filters.status) {
    const st = filters.status.toUpperCase();
    fills = fills.filter((f) => String(f.orderStatus).toUpperCase() === st || String(f.side) === st);
  }
  if (filters.evidenceChainId) {
    fills = fills.filter((f) => f.evidenceChainId === filters.evidenceChainId);
  }

  return {
    label: BROKER_V2_SURFACE_LABEL,
    authoritative: false,
    accountId: account.id,
    accountKey: account.account_key,
    pagination: { limit, offset, returned: fills.length },
    fills,
  };
}

export function buildLedgerPayload(db: BrokerDb, account: BrokerAccountRow, filters: PaperApiFilters) {
  const limit = clampLimit(filters.limit, 200, 1000);
  const offset = clampOffset(filters.offset);
  const all = listLedgerEntries(db, account.id);
  let runningCash = 0;
  let runningReserved = 0;
  const withBalances = all.map((e) => {
    runningCash = roundMoney(runningCash + e.cash_delta);
    runningReserved = roundMoney(runningReserved + e.reserved_delta);
    return {
      id: e.id,
      accountId: e.account_id,
      sequenceNum: e.sequence_num,
      entryKind: e.entry_kind,
      assetClass: e.asset_class,
      symbol: e.symbol,
      quantityDelta: e.quantity_delta,
      cashDelta: e.cash_delta,
      reservedDelta: e.reserved_delta,
      price: e.price,
      currency: e.currency,
      refKind: e.ref_kind,
      refId: e.ref_id,
      description: e.description,
      createdAtMs: e.created_at_ms,
      cashBalanceAfter: runningCash,
      reservedBalanceAfter: runningReserved,
      buyingPowerAfter: roundMoney(runningCash - runningReserved),
      audit: listAuditEventsForEntity(db, "LEDGER", e.id).slice(0, 3),
    };
  });

  let entries = withBalances;
  if (filters.fromMs != null) entries = entries.filter((e) => e.createdAtMs >= filters.fromMs!);
  if (filters.toMs != null) entries = entries.filter((e) => e.createdAtMs <= filters.toMs!);
  if (filters.status) {
    const st = filters.status.toUpperCase();
    entries = entries.filter((e) => e.entryKind === st);
  }
  if (filters.underlying) {
    const u = filters.underlying.toUpperCase();
    entries = entries.filter((e) => {
      if (!e.symbol) return false;
      return (underlyingFromSymbol(e.symbol) ?? e.symbol).toUpperCase() === u;
    });
  }

  // Stable pagination by sequence_num ASC (append-only order).
  const page = entries.slice(offset, offset + limit);
  return {
    label: BROKER_V2_SURFACE_LABEL,
    authoritative: false,
    accountId: account.id,
    accountKey: account.account_key,
    pagination: {
      limit,
      offset,
      returned: page.length,
      totalMatching: entries.length,
      stableOrder: "sequence_num ASC",
    },
    entries: page,
  };
}

export function buildEquityCurvePayload(
  db: BrokerDb,
  account: BrokerAccountRow,
  filters: PaperApiFilters,
) {
  const limit = clampLimit(filters.limit, 500, 2000);
  const fromMs = filters.fromMs ?? undefined;
  let points = readEquityCurve(db, account.id, { fromMs, limit: 5000 }).map((p) => {
    const row = db
      .prepare(
        `SELECT reserved_balance, drawdown_dollars, mark_policy_version, metadata_json
         FROM broker_equity_snapshots WHERE id = ?`,
      )
      .get(p.snapshotId) as
      | {
          reserved_balance: number;
          drawdown_dollars: number | null;
          mark_policy_version: number | null;
          metadata_json: string | null;
        }
      | undefined;
    const meta = parseMeta(row?.metadata_json);
    return {
      ...p,
      reserved: row?.reserved_balance ?? null,
      drawdownDollars: row?.drawdown_dollars ?? null,
      markPolicyVersion: row?.mark_policy_version ?? null,
      incomplete: p.completeness === "INCOMPLETE" || p.completeness === "PARTIAL",
      staleOrMissingMarks:
        (typeof meta.staleMarkCount === "number" && meta.staleMarkCount > 0) ||
        (typeof meta.missingMarkCount === "number" && meta.missingMarkCount > 0),
      missingMarkCount: (meta.missingMarkCount as number) ?? 0,
      staleMarkCount: (meta.staleMarkCount as number) ?? 0,
    };
  });

  if (filters.toMs != null) points = points.filter((p) => p.atMs <= filters.toMs!);
  if (filters.completeness) {
    const c = filters.completeness.toUpperCase();
    if (c === "COMPLETE") points = points.filter((p) => p.completeness === "COMPLETE" || p.completeness == null);
    else if (c === "INCOMPLETE") points = points.filter((p) => p.completeness === "INCOMPLETE" || p.completeness === "PARTIAL");
    else points = points.filter((p) => (p.completeness ?? "").toUpperCase() === c);
  }

  const sliced = points.slice(Math.max(0, points.length - limit));
  return {
    label: BROKER_V2_SURFACE_LABEL,
    authoritative: false,
    accountId: account.id,
    accountKey: account.account_key,
    curveSource: "broker_equity_snapshots",
    note: "Dollar equity over time from immutable snapshots — not cumulative return %.",
    points: sliced,
    summary: {
      pointCount: sliced.length,
      incompleteOrStale: sliced.filter((p) => p.incomplete || p.staleOrMissingMarks).length,
      latestEquity: sliced.length ? sliced[sliced.length - 1].totalEquity : null,
      latestHwm: sliced.length ? sliced[sliced.length - 1].highWaterMark : null,
    },
  };
}

export function buildStatsPayload(
  db: BrokerDb,
  account: BrokerAccountRow,
  env: NodeJS.ProcessEnv = process.env,
) {
  const summary = buildAccountSummary(db, account, env);
  const orderCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM broker_orders WHERE account_id = ?`).get(account.id) as {
      n: number;
    }
  ).n;
  const fillCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM broker_fills WHERE account_id = ?`).get(account.id) as {
      n: number;
    }
  ).n;
  const ledgerCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM broker_ledger_entries WHERE account_id = ?`).get(account.id) as {
      n: number;
    }
  ).n;
  const snapCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM broker_equity_snapshots WHERE account_id = ?`).get(account.id) as {
      n: number;
    }
  ).n;
  const incompleteSnaps = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM broker_equity_snapshots
         WHERE account_id = ? AND completeness_status IN ('INCOMPLETE','PARTIAL')`,
      )
      .get(account.id) as { n: number }
  ).n;
  return {
    label: BROKER_V2_SURFACE_LABEL,
    authoritative: false,
    account: summary.account,
    accountSummary: summary,
    counts: {
      orders: orderCount,
      fills: fillCount,
      ledgerEntries: ledgerCount,
      equitySnapshots: snapCount,
      incompleteSnapshots: incompleteSnaps,
      openPositions: summary.openPositionCount,
    },
  };
}

export function buildEvidenceDrilldown(db: BrokerDb, evidenceChainId: string) {
  const chain = getEvidenceChain(db, evidenceChainId);
  if (!chain) return null;
  const chainJson = parseMeta(chain.chain_json);

  const orders = (db
    .prepare(
      `SELECT id, status, side, quantity, limit_price, symbol, created_at_ms, closed_at_ms, account_id
       FROM broker_orders WHERE evidence_chain_id = ? ORDER BY created_at_ms ASC`,
    )
    .all?.(evidenceChainId) ?? []) as Array<Record<string, any>>;

  const orderIds = orders.map((o) => o.id);
  const fills =
    orderIds.length === 0
      ? []
      : ((db
          .prepare(
            `SELECT id, order_id, side, quantity, price, commission, fees, market_snapshot_id, filled_at_ms, account_id, symbol
             FROM broker_fills WHERE order_id IN (${orderIds.map(() => "?").join(",")})
             ORDER BY filled_at_ms ASC`,
          )
          .all?.(...orderIds) ?? []) as Array<Record<string, any>>);

  const accountId = orders[0]?.account_id as string | undefined;
  const symbols = [...new Set(orders.map((o) => o.symbol).filter(Boolean))];

  const positionSnapshots =
    accountId && symbols.length
      ? ((db
          .prepare(
            `SELECT id, symbol, side, quantity, market_price, market_value, unrealized_pnl, snapshot_at_ms, evidence_chain_id
             FROM broker_position_snapshots
             WHERE account_id = ? AND (evidence_chain_id = ? OR symbol IN (${symbols.map(() => "?").join(",")}))
             ORDER BY snapshot_at_ms ASC LIMIT 200`,
          )
          .all?.(accountId, evidenceChainId, ...symbols) ?? []) as Array<Record<string, any>>)
      : [];

  const marks =
    accountId && symbols.length
      ? ((db
          .prepare(
            `SELECT id, symbol, mark_price, mark_source, marked_at_ms, metadata_json
             FROM broker_marks
             WHERE account_id = ? AND symbol IN (${symbols.map(() => "?").join(",")})
             ORDER BY marked_at_ms ASC LIMIT 200`,
          )
          .all?.(accountId, ...symbols) ?? []) as Array<Record<string, any>>)
      : [];

  const ledgerRefs = [...orderIds, ...fills.map((f) => f.id)];
  const ledger =
    accountId && ledgerRefs.length
      ? ((db
          .prepare(
            `SELECT id, sequence_num, entry_kind, cash_delta, reserved_delta, quantity_delta, price, ref_kind, ref_id, created_at_ms
             FROM broker_ledger_entries
             WHERE account_id = ? AND ref_id IN (${ledgerRefs.map(() => "?").join(",")})
             ORDER BY sequence_num ASC`,
          )
          .all?.(accountId, ...ledgerRefs) ?? []) as Array<Record<string, any>>)
      : [];

  const equitySnapshots = accountId
    ? ((db
        .prepare(
          `SELECT id, snapshot_at_ms, net_equity, unrealized_pnl, realized_pnl_cumulative, completeness_status, high_water_mark, drawdown_pct
           FROM broker_equity_snapshots
           WHERE account_id = ? AND snapshot_at_ms >= ?
           ORDER BY snapshot_at_ms ASC LIMIT 100`,
        )
        .all?.(accountId, chain.created_at_ms) ?? []) as Array<Record<string, any>>)
    : [];

  const marketSnapIds = [
    ...new Set(fills.map((f) => f.market_snapshot_id).filter(Boolean) as string[]),
  ];
  const marketSnapshots =
    marketSnapIds.length === 0
      ? []
      : ((db
          .prepare(
            `SELECT id, symbol, as_of_ms, source, quote_json FROM broker_market_snapshots
             WHERE id IN (${marketSnapIds.map(() => "?").join(",")})`,
          )
          .all?.(...marketSnapIds) ?? []) as Array<Record<string, any>>);

  const legacy = (db
    .prepare(`SELECT * FROM broker_legacy_links WHERE evidence_chain_id = ?`)
    .all?.(evidenceChainId) ?? []) as Array<Record<string, any>>;

  const exitOrders = orders.filter((o) => o.side === "SELL" || String(o.status).includes("FILLED"));
  const entryOrders = orders.filter((o) => o.side === "BUY");

  const stages = [
    {
      stage: "Market Observation",
      refs: [chain.market_observation_ref].filter(Boolean),
      marketSnapshots,
    },
    {
      stage: "Strategy Evaluation",
      refs: [chain.strategy_evaluation_ref].filter(Boolean),
    },
    {
      stage: "Candidate",
      refs: [chain.candidate_ref, chain.options_candidate_id, chain.setup_candidate_id].filter(
        (x) => x != null && x !== "",
      ),
    },
    {
      stage: "Delivery Decision",
      refs: [chain.delivery_decision_ref, chain.alert_id].filter((x) => x != null && x !== ""),
    },
    {
      stage: "Paper Order",
      orders: entryOrders.length ? entryOrders : orders,
    },
    {
      stage: "Fill",
      fills,
    },
    {
      stage: "Position",
      positionSnapshots,
    },
    {
      stage: "Marks",
      marks: marks.map((m) => ({
        ...m,
        markStatus: parseMeta(m.metadata_json).status ?? m.mark_source,
      })),
    },
    {
      stage: "Exit",
      orders: exitOrders.filter((o) => !entryOrders.some((e) => e.id === o.id)),
      fills: fills.filter((f) => f.side === "SELL"),
    },
    {
      stage: "Ledger Entries",
      ledger,
    },
    {
      stage: "Equity Snapshots",
      equitySnapshots,
    },
  ];

  return {
    label: BROKER_V2_SURFACE_LABEL,
    authoritative: false,
    evidenceChainId,
    chain: {
      id: chain.id,
      marketObservationRef: chain.market_observation_ref,
      strategyEvaluationRef: chain.strategy_evaluation_ref,
      candidateRef: chain.candidate_ref,
      deliveryDecisionRef: chain.delivery_decision_ref,
      alertId: chain.alert_id,
      opportunityCaseId: chain.opportunity_case_id,
      optionsCandidateId: chain.options_candidate_id,
      setupCandidateId: chain.setup_candidate_id,
      chainJson,
      createdAtMs: chain.created_at_ms,
    },
    legacyLinks: legacy.map((l) => ({
      id: l.id,
      legacyTable: l.legacy_table,
      legacyId: l.legacy_id,
      entryOrderId: l.entry_order_id,
      entryFillId: l.entry_fill_id,
      exitOrderId: l.exit_order_id,
      exitFillId: l.exit_fill_id,
    })),
    stages,
    resolved: true,
  };
}

export function parsePaperApiFilters(url: URL): PaperApiFilters {
  const num = (k: string) => {
    const v = url.searchParams.get(k);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    accountKey: url.searchParams.get("account") ?? url.searchParams.get("accountKey"),
    accountId: url.searchParams.get("accountId"),
    accountType: url.searchParams.get("accountType"),
    audience: url.searchParams.get("audience") ?? url.searchParams.get("paperKind"),
    fromMs: num("fromMs") ?? num("from"),
    toMs: num("toMs") ?? num("to"),
    strategy: url.searchParams.get("strategy"),
    underlying: url.searchParams.get("underlying"),
    status: url.searchParams.get("status"),
    completeness: url.searchParams.get("completeness"),
    limit: num("limit") ?? undefined,
    offset: num("offset") ?? undefined,
    evidenceChainId: url.searchParams.get("evidenceChainId") ?? url.searchParams.get("evidence"),
  };
}
