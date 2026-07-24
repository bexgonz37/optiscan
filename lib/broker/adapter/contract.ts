/**
 * Generic brokerage adapter contract (B0/B1).
 * Scanner and delivery code never import adapters directly — dual-write and future
 * replay/research/live paths call through this interface.
 */
import type {
  AccountType,
  AdapterKind,
  ApplyMarkInput,
  AssetClass,
  FillOrderInput,
  OpenAccountInput,
  OrderSide,
  SubmitOrderInput,
} from "../types.ts";

export interface BrokerFillResult {
  fillId: string;
  orderId: string;
  ledgerEntryIds: string[];
  positionSnapshotId?: string;
  marketSnapshotId?: string;
}

export interface BrokerOrderResult {
  orderId: string;
  reservedAmount: number;
  marketSnapshotId?: string;
}

export interface BrokerAdapterContext {
  db: unknown;
  env?: NodeJS.ProcessEnv;
}

export interface BrokerAdapter {
  readonly name: string;
  readonly kind: AdapterKind;
  readonly paper: boolean;
  openAccount(ctx: BrokerAdapterContext, input: OpenAccountInput): { accountId: string };
  submitOrder(ctx: BrokerAdapterContext, input: SubmitOrderInput & { marketSnapshotId?: string }): BrokerOrderResult;
  fillOrder(ctx: BrokerAdapterContext, input: FillOrderInput & { marketSnapshotId?: string }): BrokerFillResult;
  applyMark(ctx: BrokerAdapterContext, input: ApplyMarkInput & { marketSnapshotId?: string }): { markId: string };
}

export interface LimitFillRequest {
  assetClass: AssetClass;
  symbol: string;
  side: OrderSide;
  quantity: number;
  limitPrice: number;
  contractMultiplier?: number;
  commission?: number;
  fees?: number;
  clientOrderKey: string;
  fillKey: string;
  /** Existing evidence chain to attach (preferred). */
  evidenceChainId?: string;
  accountId: string;
  marketSnapshot?: import("../market-snapshot.ts").MarketSnapshotInput;
  filledAtMs?: number;
}

export interface BrokerAdapterRegistry {
  get(kind: AdapterKind): BrokerAdapter;
}
