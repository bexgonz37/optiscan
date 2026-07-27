import { brokerId } from "./id.ts";
import { openAccount } from "./engine.ts";
import { BROKER_RECORD_SCHEMA_VERSION } from "./types.ts";
import type { AccountType, BrokerAccountRow } from "./types.ts";
import type { BrokerDb } from "./audit.ts";

const ACCOUNT_MAP: Record<string, { accountKey: string; accountType: AccountType; displayName: string }> = {
  subscriber_paper: {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "Subscriber Paper",
  },
  research_shadow: {
    accountKey: "research_shadow",
    accountType: "RESEARCH_SHADOW",
    displayName: "Research Shadow",
  },
  replay_lab: {
    accountKey: "replay_lab",
    accountType: "REPLAY_LAB",
    displayName: "Replay Lab",
  },
  zero_dte_research: {
    accountKey: "zero_dte_research",
    accountType: "ZERO_DTE_RESEARCH",
    displayName: "Aggressive 0DTE Research",
  },
};

export function openingBalanceUsd(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BROKER_V2_OPENING_BALANCE_USD ?? "1000000");
  return Number.isFinite(n) && n > 0 ? n : 1_000_000;
}

/** Opening deposit for the Aggressive 0DTE Research ledger (simulated). */
export function zeroDteResearchOpeningBalanceUsd(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PAPER_0DTE_STARTING_BALANCE_USD ?? "100000");
  return Number.isFinite(n) && n > 0 ? n : 100_000;
}

export function resolveAccountKeyForOptionsPaperKind(paperKind: string | null | undefined): string {
  if (paperKind === "DELIVERED_ALERT_PAPER") return "subscriber_paper";
  if (paperKind === "ZERO_DTE_RESEARCH_PAPER") return "zero_dte_research";
  return "research_shadow";
}

export function resolveAccountKeyForLegacyPortfolio(portfolio: string | null | undefined): string {
  if (portfolio === "challenge") return "research_shadow";
  if (portfolio === "research") return "research_shadow";
  return "subscriber_paper";
}

export function ensureBrokerAccount(db: BrokerDb, accountKey: string, env: NodeJS.ProcessEnv = process.env): BrokerAccountRow {
  const existing = db.prepare(`SELECT * FROM broker_accounts WHERE account_key = ?`).get(accountKey) as BrokerAccountRow | undefined;
  if (existing) return existing;
  const cfg = ACCOUNT_MAP[accountKey] ?? ACCOUNT_MAP.subscriber_paper;
  const deposit = accountKey === "zero_dte_research" ? zeroDteResearchOpeningBalanceUsd(env) : openingBalanceUsd(env);
  const { accountId } = openAccount(db, {
    accountKey: cfg.accountKey,
    accountType: cfg.accountType,
    displayName: cfg.displayName,
    openingDeposit: deposit,
    metadata: { source: "dual_write_b1" },
  });
  return db.prepare(`SELECT * FROM broker_accounts WHERE id = ?`).get(accountId) as BrokerAccountRow;
}

export function getLegacyLink(db: BrokerDb, legacyTable: string, legacyId: string | number) {
  return db
    .prepare(`SELECT * FROM broker_legacy_links WHERE legacy_table = ? AND legacy_id = ?`)
    .get(legacyTable, String(legacyId)) as Record<string, any> | undefined;
}

export function upsertLegacyLink(
  db: BrokerDb,
  input: {
    accountId: string;
    legacyTable: string;
    legacyId: string | number;
    evidenceChainId?: string | null;
    entryOrderId?: string | null;
    entryFillId?: string | null;
    exitOrderId?: string | null;
    exitFillId?: string | null;
    metadata?: Record<string, unknown>;
  },
): string {
  const now = Date.now();
  const existing = getLegacyLink(db, input.legacyTable, input.legacyId);
  if (existing) {
    db.prepare(
      `UPDATE broker_legacy_links SET
         evidence_chain_id = COALESCE(?, evidence_chain_id),
         entry_order_id = COALESCE(?, entry_order_id),
         entry_fill_id = COALESCE(?, entry_fill_id),
         exit_order_id = COALESCE(?, exit_order_id),
         exit_fill_id = COALESCE(?, exit_fill_id),
         metadata_json = COALESCE(?, metadata_json),
         updated_at_ms = ?
       WHERE id = ?`,
    ).run(
      input.evidenceChainId ?? null,
      input.entryOrderId ?? null,
      input.entryFillId ?? null,
      input.exitOrderId ?? null,
      input.exitFillId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      existing.id,
    );
    return existing.id as string;
  }
  const id = brokerId("blink");
  db.prepare(
    `INSERT INTO broker_legacy_links
      (id, account_id, legacy_table, legacy_id, evidence_chain_id, entry_order_id, entry_fill_id,
       exit_order_id, exit_fill_id, record_schema_version, metadata_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.accountId,
    input.legacyTable,
    String(input.legacyId),
    input.evidenceChainId ?? null,
    input.entryOrderId ?? null,
    input.entryFillId ?? null,
    input.exitOrderId ?? null,
    input.exitFillId ?? null,
    BROKER_RECORD_SCHEMA_VERSION,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now,
    now,
  );
  return id;
}

export function auditChainComplete(db: BrokerDb, accountId: string, evidenceChainId: string | null, orderId: string | null, fillId: string | null): boolean {
  if (!evidenceChainId || !orderId || !fillId) return false;
  const evidence = db.prepare(`SELECT 1 FROM broker_evidence_chains WHERE id = ?`).get(evidenceChainId);
  const order = db.prepare(`SELECT 1 FROM broker_orders WHERE id = ? AND account_id = ?`).get(orderId, accountId);
  const fill = db.prepare(`SELECT 1 FROM broker_fills WHERE id = ? AND account_id = ?`).get(fillId, accountId);
  const audits = db
    .prepare(`SELECT COUNT(*) AS c FROM broker_audit_events WHERE account_id = ? AND entity_kind IN ('ORDER','FILL','LEDGER','EVIDENCE')`)
    .get(accountId) as { c: number };
  return Boolean(evidence && order && fill && (audits?.c ?? 0) >= 3);
}
