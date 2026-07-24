import { brokerId } from "./id.ts";
import type { AssetClass } from "./types.ts";
import { BROKER_RECORD_SCHEMA_VERSION } from "./types.ts";
import type { BrokerDb } from "./audit.ts";

export interface MarketSnapshotInput {
  accountId?: string | null;
  symbol: string;
  assetClass: AssetClass;
  asOfMs: number;
  source: string;
  quote: Record<string, unknown>;
  chain?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface MarketSnapshotRow {
  id: string;
  account_id: string | null;
  symbol: string;
  asset_class: string;
  as_of_ms: number;
  quote_json: string;
  chain_json: string | null;
  source: string;
  record_schema_version: number;
  created_at_ms: number;
}

export function storeMarketSnapshot(db: BrokerDb, input: MarketSnapshotInput): MarketSnapshotRow {
  const id = brokerId("bmkt");
  const now = Date.now();
  db.prepare(
    `INSERT INTO broker_market_snapshots
      (id, account_id, symbol, asset_class, as_of_ms, quote_json, chain_json, source,
       record_schema_version, metadata_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.accountId ?? null,
    input.symbol,
    input.assetClass,
    input.asOfMs,
    JSON.stringify(input.quote),
    input.chain ? JSON.stringify(input.chain) : null,
    input.source,
    BROKER_RECORD_SCHEMA_VERSION,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now,
  );
  return db.prepare(`SELECT * FROM broker_market_snapshots WHERE id = ?`).get(id) as MarketSnapshotRow;
}

export function marketSnapshotFromOptionsRow(row: Record<string, any>, featureJson?: string | null): MarketSnapshotInput {
  let feature: Record<string, unknown> = {};
  if (featureJson) {
    try {
      feature = JSON.parse(featureJson) as Record<string, unknown>;
    } catch {
      feature = {};
    }
  }
  return {
    symbol: row.option_symbol,
    assetClass: "OPTION",
    asOfMs: row.entered_at_ms ?? row.exit_at_ms ?? Date.now(),
    source: row.provenance ?? row.entry_source ?? "options_paper_trades",
    quote: {
      bid: row.bid ?? null,
      ask: row.ask ?? null,
      mid: row.mid ?? null,
      spreadPct: row.spread_pct ?? null,
      iv: row.iv ?? null,
      delta: row.delta ?? null,
      volume: row.volume ?? null,
      openInterest: row.open_interest ?? null,
      underlyingPrice: row.underlying_price ?? null,
      entryFill: row.entry_fill ?? null,
      exitFill: row.exit_fill ?? null,
    },
    chain: Object.keys(feature).length ? feature : null,
    metadata: {
      strategy: row.strategy ?? null,
      target: row.target ?? null,
      invalidation: row.invalidation ?? null,
      paperKind: row.paper_kind ?? null,
    },
  };
}
