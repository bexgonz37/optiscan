/**
 * Brokerage simulation foundation (B0) — shared types.
 * Asset-class execution is intentionally generic; no options/stock fill logic here.
 */

export const BROKER_SCHEMA_VERSION = 3;

/** Version stamped on immutable brokerage records for forward-compatible evolution. */
export const BROKER_RECORD_SCHEMA_VERSION = 3;

export type AccountType =
  | "SUBSCRIBER_PAPER"
  | "RESEARCH_SHADOW"
  | "REPLAY_LAB"
  | "LIVE_BROKER";

export type AdapterKind = "PAPER_SIM" | "LIVE_BROKER";

export type AccountStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";

export type AssetClass = "CASH" | "EQUITY" | "OPTION" | "FUTURE" | "CRYPTO";

export type OrderSide = "BUY" | "SELL";

export type OrderType = "MARKET" | "LIMIT";

export type OrderStatus =
  | "PENDING"
  | "SUBMITTED"
  | "PARTIAL"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED";

export type PositionSide = "LONG" | "SHORT" | "FLAT";

export type LedgerEntryKind =
  | "ACCOUNT_OPEN"
  | "DEPOSIT"
  | "WITHDRAW"
  | "ORDER_RESERVE"
  | "ORDER_RELEASE"
  | "BUY_FILL"
  | "SELL_FILL"
  | "FEE"
  | "MARK"
  | "REALIZED_PNL"
  | "ADJUSTMENT";

export type LedgerRefKind =
  | "ACCOUNT"
  | "ORDER"
  | "FILL"
  | "POSITION"
  | "MARK"
  | "MANUAL"
  | "SYSTEM";

export type AuditEntityKind =
  | "ACCOUNT"
  | "ORDER"
  | "FILL"
  | "POSITION"
  | "LEDGER"
  | "EQUITY"
  | "EVIDENCE"
  | "MARK";

export type AuditActor = "SYSTEM" | "USER" | "ADAPTER";

export interface BrokerAccountRow {
  id: string;
  account_key: string;
  account_type: AccountType;
  display_name: string;
  base_currency: string;
  status: AccountStatus;
  adapter_kind: AdapterKind;
  metadata_json: string | null;
  created_at_ms: number;
  closed_at_ms: number | null;
}

export interface LedgerEntryRow {
  id: string;
  account_id: string;
  sequence_num: number;
  entry_kind: LedgerEntryKind;
  asset_class: AssetClass;
  symbol: string | null;
  quantity_delta: number;
  cash_delta: number;
  reserved_delta: number;
  price: number | null;
  currency: string;
  ref_kind: LedgerRefKind;
  ref_id: string;
  idempotency_key: string;
  description: string | null;
  metadata_json: string | null;
  created_at_ms: number;
}

export interface AccountBalances {
  cash: number;
  reserved: number;
  buyingPower: number;
  ledgerSequenceThrough: number;
}

export interface PositionState {
  assetClass: AssetClass;
  symbol: string;
  side: PositionSide;
  quantity: number;
  averageCost: number;
  costBasis: number;
  marketPrice: number | null;
  marketValue: number;
  unrealizedPnl: number;
  evidenceChainId: string | null;
}

export interface EvidenceChainInput {
  marketObservationRef?: string | null;
  strategyEvaluationRef?: string | null;
  candidateRef?: string | null;
  deliveryDecisionRef?: string | null;
  alertId?: number | null;
  opportunityCaseId?: string | null;
  optionsCandidateId?: number | null;
  setupCandidateId?: number | null;
  chainJson: Record<string, unknown>;
}

export interface EvidenceChainRow {
  id: string;
  market_observation_ref: string | null;
  strategy_evaluation_ref: string | null;
  candidate_ref: string | null;
  delivery_decision_ref: string | null;
  alert_id: number | null;
  opportunity_case_id: string | null;
  options_candidate_id: number | null;
  setup_candidate_id: number | null;
  chain_json: string;
  created_at_ms: number;
}

export interface SubmitOrderInput {
  accountId: string;
  clientOrderKey: string;
  evidenceChainId: string;
  assetClass: AssetClass;
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType?: OrderType;
  limitPrice?: number | null;
  contractMultiplier?: number;
  metadata?: Record<string, unknown>;
}

export interface FillOrderInput {
  orderId: string;
  fillKey: string;
  quantity: number;
  price: number;
  commission?: number;
  fees?: number;
  filledAtMs?: number;
  metadata?: Record<string, unknown>;
}

export interface DepositCashInput {
  accountId: string;
  amount: number;
  idempotencyKey: string;
  description?: string;
}

export interface OpenAccountInput {
  accountKey: string;
  accountType: AccountType;
  displayName: string;
  baseCurrency?: string;
  adapterKind?: AdapterKind;
  openingDeposit?: number;
  metadata?: Record<string, unknown>;
}

export interface ApplyMarkInput {
  accountId: string;
  assetClass: AssetClass;
  symbol: string;
  markPrice: number;
  markSource: string;
  idempotencyKey: string;
  markedAtMs?: number;
  /** Mark policy status (OK / STALE / WORTHLESS / …). Stored in metadata. */
  markStatus?: string;
  marketSnapshotId?: string;
}
