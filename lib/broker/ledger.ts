/**
 * Pure ledger math — balances and positions are always reconstructable from entries.
 */
import type {
  AccountBalances,
  AssetClass,
  LedgerEntryRow,
  PositionSide,
  PositionState,
} from "./types.ts";

function posKey(assetClass: AssetClass, symbol: string): string {
  return `${assetClass}:${symbol}`;
}

export function computeBalances(entries: LedgerEntryRow[]): AccountBalances {
  let cash = 0;
  let reserved = 0;
  let ledgerSequenceThrough = 0;
  for (const e of entries) {
    cash += e.cash_delta;
    reserved += e.reserved_delta;
    ledgerSequenceThrough = Math.max(ledgerSequenceThrough, e.sequence_num);
  }
  return {
    cash: roundMoney(cash),
    reserved: roundMoney(reserved),
    buyingPower: roundMoney(cash - reserved),
    ledgerSequenceThrough,
  };
}

export function computePositions(
  entries: LedgerEntryRow[],
  evidenceBySymbol: Map<string, string | null> = new Map(),
  marks: Map<string, number> = new Map(),
): PositionState[] {
  type Lot = {
    assetClass: AssetClass;
    symbol: string;
    quantity: number;
    costBasis: number;
    evidenceChainId: string | null;
  };
  const lots = new Map<string, Lot>();

  for (const e of entries) {
    if (e.asset_class === "CASH" || !e.symbol) continue;
    const key = posKey(e.asset_class, e.symbol);
    const lot = lots.get(key) ?? {
      assetClass: e.asset_class,
      symbol: e.symbol,
      quantity: 0,
      costBasis: 0,
      evidenceChainId: evidenceBySymbol.get(key) ?? null,
    };

    if (e.quantity_delta > 0) {
      lot.costBasis += (e.price ?? 0) * e.quantity_delta;
      lot.quantity += e.quantity_delta;
    } else if (e.quantity_delta < 0) {
      const sellQty = Math.abs(e.quantity_delta);
      const avg = lot.quantity > 0 ? lot.costBasis / lot.quantity : 0;
      lot.costBasis -= avg * sellQty;
      lot.quantity += e.quantity_delta;
      if (lot.quantity <= 1e-9) {
        lot.quantity = 0;
        lot.costBasis = 0;
      }
    }
    lots.set(key, lot);
  }

  const out: PositionState[] = [];
  for (const lot of lots.values()) {
    if (Math.abs(lot.quantity) < 1e-9) continue;
    const side: PositionSide = lot.quantity > 0 ? "LONG" : "SHORT";
    const qty = Math.abs(lot.quantity);
    const avgCost = qty > 0 ? lot.costBasis / qty : 0;
    const mark = marks.get(posKey(lot.assetClass, lot.symbol)) ?? null;
    const marketValue = mark != null ? roundMoney(mark * qty) : 0;
    const unrealized =
      mark != null
        ? roundMoney((mark - avgCost) * qty * (side === "LONG" ? 1 : -1))
        : 0;
    out.push({
      assetClass: lot.assetClass,
      symbol: lot.symbol,
      side,
      quantity: roundQty(qty),
      averageCost: roundMoney(avgCost),
      costBasis: roundMoney(lot.costBasis),
      marketPrice: mark,
      marketValue,
      unrealizedPnl: unrealized,
      evidenceChainId: lot.evidenceChainId,
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function estimateOrderNotional(input: {
  quantity: number;
  limitPrice: number;
  contractMultiplier?: number;
}): number {
  const mult = input.contractMultiplier ?? 1;
  return roundMoney(input.quantity * input.limitPrice * mult);
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export function roundQty(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function assertFinitePositive(n: number, label: string): void {
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a finite positive number`);
  }
}
