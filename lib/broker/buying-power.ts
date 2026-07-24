/**
 * B2 — ledger buying-power accounting & position sizing for the V2 brokerage engine.
 * Pure over account balances / open positions. Legacy paper sizing remains authoritative
 * for live entries; this module sizes only within broker_accounts ledgers.
 */
import { computeBalances, estimateOrderNotional, roundMoney, roundQty } from "./ledger.ts";
import { getAccountState } from "./engine.ts";
import { listLedgerEntries } from "./queries.ts";
import type { BrokerDb } from "./audit.ts";
import type { AssetClass, AccountBalances, PositionState } from "./types.ts";

export interface BuyingPowerConfig {
  /** Max fraction of buying power a single new position may consume (0–1). */
  maxPositionUtilization: number;
  /** Hard cap on notional dollars for one position. */
  maxPositionDollars: number;
  /** Max simultaneously open positions (LONG/SHORT with qty > 0). */
  maxConcurrentPositions: number;
}

export function defaultBuyingPowerConfig(env: NodeJS.ProcessEnv = process.env): BuyingPowerConfig {
  const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    maxPositionUtilization: Math.max(0, Math.min(1, num(env.BROKER_V2_MAX_POSITION_UTILIZATION, 0.25))),
    maxPositionDollars: num(env.BROKER_V2_MAX_POSITION_DOLLARS, 25_000),
    maxConcurrentPositions: Math.max(1, Math.floor(num(env.BROKER_V2_MAX_CONCURRENT_POSITIONS, 20))),
  };
}

export interface SizeFromBuyingPowerInput {
  accountId: string;
  assetClass: AssetClass;
  symbol: string;
  limitPrice: number;
  contractMultiplier?: number;
  /** Desired quantity; may be reduced to fit buying power. */
  desiredQuantity: number;
  /** When true, reject if symbol already has an open position. */
  blockDuplicateSymbol?: boolean;
}

export interface SizeFromBuyingPowerResult {
  allowed: boolean;
  quantity: number;
  notional: number;
  buyingPower: number;
  reserved: number;
  cash: number;
  openPositions: number;
  reasons: string[];
}

function multiplierFor(assetClass: AssetClass, override?: number): number {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  return assetClass === "OPTION" ? 100 : 1;
}

export function sizeFromBuyingPower(
  db: BrokerDb,
  input: SizeFromBuyingPowerInput,
  cfg: BuyingPowerConfig = defaultBuyingPowerConfig(),
): SizeFromBuyingPowerResult {
  const reasons: string[] = [];
  const state = getAccountState(db, input.accountId);
  const mult = multiplierFor(input.assetClass, input.contractMultiplier);
  const openPositions = state.positions.length;

  if (!(input.limitPrice > 0) || !Number.isFinite(input.limitPrice)) {
    return {
      allowed: false,
      quantity: 0,
      notional: 0,
      buyingPower: state.balances.buyingPower,
      reserved: state.balances.reserved,
      cash: state.balances.cash,
      openPositions,
      reasons: ["invalid limit price"],
    };
  }
  if (!(input.desiredQuantity > 0) || !Number.isFinite(input.desiredQuantity)) {
    return {
      allowed: false,
      quantity: 0,
      notional: 0,
      buyingPower: state.balances.buyingPower,
      reserved: state.balances.reserved,
      cash: state.balances.cash,
      openPositions,
      reasons: ["invalid desired quantity"],
    };
  }

  if (openPositions >= cfg.maxConcurrentPositions) {
    reasons.push(`max concurrent positions (${cfg.maxConcurrentPositions})`);
  }
  if (input.blockDuplicateSymbol !== false) {
    const dup = state.positions.some(
      (p) => p.assetClass === input.assetClass && p.symbol === input.symbol,
    );
    if (dup) reasons.push(`duplicate open position for ${input.symbol}`);
  }

  const unitCost = input.limitPrice * mult;
  const maxByBp = Math.floor(state.balances.buyingPower / unitCost);
  const maxByUtil = Math.floor(
    (state.balances.buyingPower * cfg.maxPositionUtilization) / unitCost,
  );
  const maxByCap = Math.floor(cfg.maxPositionDollars / unitCost);
  const quantity = Math.max(
    0,
    Math.min(input.desiredQuantity, maxByBp, maxByUtil, maxByCap),
  );

  if (quantity <= 0) {
    reasons.push(
      `insufficient buying power: bp=${state.balances.buyingPower} unitCost=${roundMoney(unitCost)}`,
    );
  }

  const notional = estimateOrderNotional({
    quantity: Math.max(quantity, 0),
    limitPrice: input.limitPrice,
    contractMultiplier: mult,
  });

  return {
    allowed: reasons.length === 0 && quantity > 0,
    quantity: roundQty(quantity),
    notional,
    buyingPower: state.balances.buyingPower,
    reserved: state.balances.reserved,
    cash: state.balances.cash,
    openPositions,
    reasons,
  };
}

/** Read-only snapshot of account capital for dashboards / parity. */
export function readBuyingPowerSnapshot(
  db: BrokerDb,
  accountId: string,
): { balances: AccountBalances; positions: PositionState[]; openPositions: number } {
  const entries = listLedgerEntries(db, accountId);
  const balances = computeBalances(entries);
  const { positions } = getAccountState(db, accountId);
  return { balances, positions, openPositions: positions.length };
}
