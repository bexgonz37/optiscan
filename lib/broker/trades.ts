/**
 * B5 — reconstruct closed round-trip trades from V2 fills/orders (ledger-first).
 * Does not require legacy tables; optional enrichment via broker_legacy_links metadata only.
 */
import type { BrokerDb } from "./audit.ts";
import { roundMoney } from "./ledger.ts";
import { parseOccSymbol, underlyingFromSymbol } from "./occ.ts";
import { brokerOptionPnl, brokerReturnPct } from "./parity.ts";

export type ExitClass =
  | "target"
  | "stop"
  | "timeout"
  | "expiration"
  | "worthless"
  | "manual"
  | "unknown";

export interface RoundTripTrade {
  id: string;
  accountId: string;
  evidenceChainId: string | null;
  symbol: string;
  underlying: string | null;
  right: "call" | "put" | null;
  strike: number | null;
  expiration: string | null;
  dteAtEntry: number | null;
  dteBucket: string;
  strategy: string | null;
  side: "LONG"; // paper options are long premium for now
  contracts: number;
  multiplier: number;
  entryFillId: string;
  exitFillId: string;
  entryOrderId: string;
  exitOrderId: string;
  entryPrice: number;
  exitPrice: number;
  entryAtMs: number;
  exitAtMs: number;
  holdingMs: number;
  commissionFees: number;
  slippageDollars: number;
  spreadCostEstimate: number | null;
  grossPnlDollars: number;
  netPnlDollars: number;
  returnPct: number;
  capitalAtRisk: number;
  exitClass: ExitClass;
  marketRegime: string | null;
  sector: string | null;
  delta: number | null;
  entryHourUtc: number;
  entryDowUtc: number; // 0=Sun
  expiredWorthless: boolean;
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

export function dteBucket(dte: number | null): string {
  if (dte == null || !Number.isFinite(dte)) return "unknown";
  if (dte <= 0) return "0dte";
  if (dte <= 2) return "1_2dte";
  if (dte <= 7) return "3_7dte";
  if (dte <= 21) return "8_21dte";
  if (dte <= 45) return "22_45dte";
  return "45plus_dte";
}

function classifyExit(meta: Record<string, unknown>, chain: Record<string, unknown>): ExitClass {
  const raw = String(
    meta.exitReason ?? meta.exit_reason ?? chain.exitReason ?? chain.exit_reason ?? "",
  ).toLowerCase();
  if (!raw) return "unknown";
  if (/worthless|expired.?0|expire.*zero/.test(raw)) return "worthless";
  if (/expir/.test(raw)) return "expiration";
  if (/target|tp|take.?profit/.test(raw)) return "target";
  if (/stop|invalidation|sl/.test(raw)) return "stop";
  if (/timeout|time.?stop|eod|session/.test(raw)) return "timeout";
  if (/manual|flat|user/.test(raw)) return "manual";
  return "unknown";
}

function expirationType(dte: number | null): string {
  if (dte == null) return "unknown";
  if (dte <= 0) return "0dte";
  if (dte <= 7) return "weekly";
  if (dte <= 45) return "monthly";
  return "longer";
}

export { expirationType };

/**
 * Pair BUY→SELL fills sharing evidence_chain_id; FIFO leftover by symbol.
 */
export function listClosedRoundTrips(
  db: BrokerDb,
  accountId: string,
): RoundTripTrade[] {
  const rows = (db
    .prepare(
      `SELECT f.id AS fill_id, f.order_id, f.side AS fill_side, f.quantity, f.price,
              f.commission, f.fees, f.contract_multiplier, f.market_snapshot_id, f.filled_at_ms,
              f.symbol, f.asset_class, f.metadata_json AS fill_meta,
              o.evidence_chain_id, o.limit_price, o.metadata_json AS order_meta,
              o.client_order_key
       FROM broker_fills f
       JOIN broker_orders o ON o.id = f.order_id
       WHERE f.account_id = ?
       ORDER BY f.filled_at_ms ASC, f.id ASC`,
    )
    .all?.(accountId) ?? []) as Array<Record<string, any>>;

  type Fill = (typeof rows)[number];
  const byEvidence = new Map<string, Fill[]>();
  const noEvidence: Fill[] = [];
  for (const r of rows) {
    const ev = r.evidence_chain_id as string | null;
    if (ev) {
      const arr = byEvidence.get(ev) ?? [];
      arr.push(r);
      byEvidence.set(ev, arr);
    } else {
      noEvidence.push(r);
    }
  }

  const closed: RoundTripTrade[] = [];
  const used = new Set<string>();

  const materialize = (buy: Fill, sell: Fill, evidenceChainId: string | null) => {
    if (used.has(buy.fill_id) || used.has(sell.fill_id)) return;
    used.add(buy.fill_id);
    used.add(sell.fill_id);

    const qty = Math.min(Number(buy.quantity), Number(sell.quantity));
    const mult = Number(buy.contract_multiplier) || (buy.asset_class === "OPTION" ? 100 : 1);
    const entryPrice = Number(buy.price);
    const exitPrice = Number(sell.price);
    const fees = roundMoney(
      Number(buy.commission ?? 0) +
        Number(buy.fees ?? 0) +
        Number(sell.commission ?? 0) +
        Number(sell.fees ?? 0),
    );
    const gross =
      buy.asset_class === "OPTION"
        ? brokerOptionPnl(entryPrice, exitPrice, qty)
        : roundMoney((exitPrice - entryPrice) * qty * mult);
    const net = roundMoney(gross - fees);

    const entryLimit = buy.limit_price != null ? Number(buy.limit_price) : null;
    const exitLimit = sell.limit_price != null ? Number(sell.limit_price) : null;
    const slip =
      (entryLimit != null ? (entryPrice - entryLimit) * qty * mult : 0) +
      (exitLimit != null ? (exitLimit - exitPrice) * qty * mult : 0);

    const orderMeta = parseMeta(buy.order_meta);
    const fillMeta = parseMeta(buy.fill_meta);
    const sellMeta = parseMeta(sell.fill_meta);
    const chainRow = evidenceChainId
      ? (db.prepare(`SELECT chain_json FROM broker_evidence_chains WHERE id = ?`).get(evidenceChainId) as
          | { chain_json: string }
          | undefined)
      : null;
    const chain = parseMeta(chainRow?.chain_json);

    let snapMeta: Record<string, unknown> = {};
    let quote: Record<string, unknown> = {};
    if (buy.market_snapshot_id) {
      const snap = db
        .prepare(`SELECT metadata_json, quote_json FROM broker_market_snapshots WHERE id = ?`)
        .get(buy.market_snapshot_id) as { metadata_json: string | null; quote_json: string } | undefined;
      snapMeta = parseMeta(snap?.metadata_json);
      quote = parseMeta(snap?.quote_json);
    }

    const strategy =
      (orderMeta.strategy as string) ||
      (orderMeta.strategyId as string) ||
      (chain.strategy as string) ||
      (snapMeta.strategy as string) ||
      null;

    const occ = parseOccSymbol(String(buy.symbol), Number(buy.filled_at_ms));
    const dte = occ.dte;
    const exitClass = classifyExit({ ...sellMeta, ...fillMeta, ...orderMeta }, chain);
    const bid = typeof quote.bid === "number" ? quote.bid : null;
    const ask = typeof quote.ask === "number" ? quote.ask : null;
    const spreadCost =
      bid != null && ask != null && ask >= bid
        ? roundMoney(((ask - bid) / 2) * qty * mult)
        : null;

    const capitalAtRisk = roundMoney(entryPrice * qty * mult);
    const delta =
      typeof quote.delta === "number"
        ? quote.delta
        : typeof snapMeta.delta === "number"
          ? (snapMeta.delta as number)
          : null;
    const regime =
      typeof snapMeta.marketRegime === "string"
        ? (snapMeta.marketRegime as string)
        : typeof snapMeta.regime === "string"
          ? (snapMeta.regime as string)
          : typeof chain.marketRegime === "string"
            ? (chain.marketRegime as string)
            : null;
    const sector =
      typeof snapMeta.sector === "string"
        ? (snapMeta.sector as string)
        : typeof chain.sector === "string"
          ? (chain.sector as string)
          : null;

    const entryAt = Number(buy.filled_at_ms);
    const exitAt = Number(sell.filled_at_ms);
    const d = new Date(entryAt);

    closed.push({
      id: `${buy.fill_id}->${sell.fill_id}`,
      accountId,
      evidenceChainId,
      symbol: String(buy.symbol),
      underlying: occ.underlying ?? underlyingFromSymbol(String(buy.symbol)),
      right: occ.right,
      strike: occ.strike,
      expiration: occ.expiration,
      dteAtEntry: dte,
      dteBucket: dteBucket(dte),
      strategy: strategy ? String(strategy) : null,
      side: "LONG",
      contracts: qty,
      multiplier: mult,
      entryFillId: buy.fill_id,
      exitFillId: sell.fill_id,
      entryOrderId: buy.order_id,
      exitOrderId: sell.order_id,
      entryPrice,
      exitPrice,
      entryAtMs: entryAt,
      exitAtMs: exitAt,
      holdingMs: Math.max(0, exitAt - entryAt),
      commissionFees: fees,
      slippageDollars: roundMoney(slip),
      spreadCostEstimate: spreadCost,
      grossPnlDollars: gross,
      netPnlDollars: net,
      returnPct: brokerReturnPct(entryPrice, exitPrice),
      capitalAtRisk,
      exitClass,
      marketRegime: regime,
      sector,
      delta,
      entryHourUtc: d.getUTCHours(),
      entryDowUtc: d.getUTCDay(),
      expiredWorthless: exitClass === "worthless" || (exitPrice === 0 && exitClass === "expiration"),
    });
  };

  for (const [evId, fills] of byEvidence) {
    const buys = fills.filter((f) => f.fill_side === "BUY");
    const sells = fills.filter((f) => f.fill_side === "SELL");
    const n = Math.min(buys.length, sells.length);
    for (let i = 0; i < n; i++) materialize(buys[i], sells[i], evId);
  }

  // FIFO leftover / no-evidence by symbol
  const pendingBuys = new Map<string, Fill[]>();
  const leftovers = [
    ...[...byEvidence.values()].flat().filter((f) => !used.has(f.fill_id)),
    ...noEvidence,
  ].sort((a, b) => Number(a.filled_at_ms) - Number(b.filled_at_ms));

  for (const f of leftovers) {
    const key = `${f.asset_class}:${f.symbol}`;
    if (f.fill_side === "BUY") {
      const q = pendingBuys.get(key) ?? [];
      q.push(f);
      pendingBuys.set(key, q);
    } else if (f.fill_side === "SELL") {
      const q = pendingBuys.get(key) ?? [];
      const buy = q.shift();
      if (buy) materialize(buy, f, (buy.evidence_chain_id as string) ?? null);
      pendingBuys.set(key, q);
    }
  }

  return closed.sort((a, b) => a.exitAtMs - b.exitAtMs);
}

export function filterRoundTrips(
  trades: RoundTripTrade[],
  filters: {
    fromMs?: number | null;
    toMs?: number | null;
    strategy?: string | null;
    underlying?: string | null;
    right?: string | null;
    dteBucket?: string | null;
  },
): RoundTripTrade[] {
  return trades.filter((t) => {
    if (filters.fromMs != null && t.exitAtMs < filters.fromMs) return false;
    if (filters.toMs != null && t.exitAtMs > filters.toMs) return false;
    if (filters.strategy && !(t.strategy ?? "").toLowerCase().includes(filters.strategy.toLowerCase())) {
      return false;
    }
    if (filters.underlying && (t.underlying ?? "").toUpperCase() !== filters.underlying.toUpperCase()) {
      return false;
    }
    if (filters.right) {
      const r = filters.right.toLowerCase();
      if (r === "call" || r === "put") {
        if (t.right !== r) return false;
      }
    }
    if (filters.dteBucket && t.dteBucket !== filters.dteBucket) return false;
    return true;
  });
}
