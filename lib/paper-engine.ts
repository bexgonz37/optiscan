/**
 * paper-engine.ts — server-side orchestrator for paper trading.
 *
 * Owns all I/O: SQLite persistence, quote fetches (metered through the
 * central call meter like everything else), and the 30s sweep that advances
 * READY/ENTERED trades through the pure lifecycle in lib/paper-trading.ts.
 *
 * Budget rules: ≤ PAPER_SWEEP_MAX_FETCHES chain fetches per sweep, skipped
 * entirely near the minute cap. Paper trading must never compete with the
 * live scanner for quota.
 */

import { getDb } from "@/lib/db";
import { fetchOptionChain, getCallStats } from "@/lib/polygon-provider";
import { nearMinuteBudget } from "@/lib/near-miss";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import {
  markToMarket, applyExit, lessonsLearned, ENTRY_WINDOW_MS,
  TERMINAL_STATES, deriveOrderState, derivePositionState,
  type PaperTrade, type PaperState, type ExitDecision,
} from "@/lib/paper-trading";
import { evaluateExit, defaultExitConfig, type LiveTapeSnapshot, type EntryThesisSnapshot } from "@/lib/paper-exits";
import { checkRisk, defaultRiskConfig, type ProposedTrade, type RiskConfig, type RiskContext, type RiskVerdict } from "@/lib/paper-risk";
import { dollarsAtRisk } from "@/lib/paper-trading";
import { paperExperimentalOversize, paperMinPositionDollars, paperTargetProfitDollars, unitsForDollarExposure } from "@/lib/paper-sizing";
import { actionableFreshness } from "@/lib/data-freshness";
import type { OptionQuote } from "@/lib/execution/broker";
import { revalidateContract, type AlertTimeContract, type RevalidationResult } from "@/lib/paper-revalidation";
import { defaultFillConfig } from "@/lib/paper-fill-model";
import { checkCapital, defaultCapitalConfig, type CapitalContext } from "@/lib/paper-capital";
import { recordPaperEvent, type PaperEventType } from "@/lib/paper-events";
import { decideEntryFill, decideMark, resolveExitFill } from "@/lib/paper-entry";
import { decideStockEntry, evaluateStockExit, resolveStockExitFill } from "@/lib/paper-stock";
import { buildPaperExplanation, type PaperExplanation } from "@/lib/paper-explain";
import { listRecentPaperEvents, listPaperEvents, type PaperEventRow } from "@/lib/paper-events";
import { freezePaperFingerprintForTrade, syncPaperOutcomes, outcomesByTradeId, type PaperOutcomeRow } from "@/lib/outcome-store";
import { humanReadable } from "@/lib/setup-fingerprint";
import { normalizeProviderTimestampMs } from "@/lib/data-freshness";
import type { ChainContract } from "@/lib/contract-selector";
import { legacyPaperAutoEntrySuppressed } from "@/lib/callouts/routing";
import { stockExtensionReason, stockGateConfig } from "@/lib/stock-callout";

const SWEEP_MS = Number(process.env.PAPER_SWEEP_MS ?? 30_000);
const MAX_FETCHES_PER_SWEEP = Number(process.env.PAPER_SWEEP_MAX_FETCHES ?? 5);
const STOCK_SCALP_STOP_PCT = Number(process.env.PAPER_STOCK_SCALP_STOP_PCT ?? 0.45);
const STOCK_SCALP_TAKE_PROFIT_PCT = Number(process.env.PAPER_STOCK_SCALP_TAKE_PROFIT_PCT ?? 0.8);
const STOCK_SCALP_MAX_HOLD_MS = Number(process.env.PAPER_STOCK_SCALP_MAX_HOLD_MS ?? 5 * 60_000);
const PAPER_STOCK_SESSIONS = () => new Set(
  String(process.env.PAPER_STOCK_SESSIONS ?? "premarket,regular,afterhours")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function riskConfigForProposed(proposed: ProposedTrade): RiskConfig {
  const cfg = defaultRiskConfig();
  if (!paperExperimentalOversize()) return cfg;

  const multiplier = proposed.assetClass === "stock" ? 1 : 100;
  const exposure = proposed.entryLimit * multiplier * proposed.contracts;
  const risk = dollarsAtRisk(proposed.entryLimit, proposed.contracts, proposed.stopLossPct, multiplier);
  const positionTarget = paperMinPositionDollars();
  const profitGoal = paperTargetProfitDollars();

  return {
    ...cfg,
    // Paper-only experiment mode: keep kill switch, max open positions,
    // 0DTE policy, and no-averaging-down intact, but widen dollar caps so
    // the simulator can hold the requested paper position size.
    maxRiskPerTrade: Math.max(cfg.maxRiskPerTrade, Math.ceil(risk)),
    maxExposurePerTicker: Math.max(cfg.maxExposurePerTicker, Math.ceil(exposure)),
    maxDailyLoss: Math.max(cfg.maxDailyLoss, Math.ceil(profitGoal || positionTarget || risk)),
    maxWeeklyLoss: Math.max(cfg.maxWeeklyLoss, Math.ceil((profitGoal || positionTarget || risk) * 3)),
  };
}

// ── Row mapping ──────────────────────────────────────────────────────────────

function rowToTrade(r: any): PaperTrade {
  return {
    id: r.id, alertId: r.alert_id, ticker: r.ticker, optionSymbol: r.option_symbol,
    optionType: r.option_type === "put" ? "put" : "call",
    strike: r.strike, expiration: r.expiration, dteAtEntry: r.dte_at_entry,
    contracts: r.contracts ?? 1, status: r.status as PaperState,
    thesis: r.thesis, confidence: r.confidence,
    entryLimit: r.entry_limit, entryPrice: r.entry_price, entryAtMs: r.entry_at_ms,
    stopLossPct: r.stop_loss_pct, takeProfitPct: r.take_profit_pct,
    exitPrice: r.exit_price, exitAtMs: r.exit_at_ms, exitReason: r.exit_reason,
    mfePct: r.mfe_pct, maePct: r.mae_pct,
    lastMark: r.last_mark, lastMarkAtMs: r.last_mark_at_ms,
    createdAtMs: r.created_at_ms,
  };
}

function paperMultiplier(t: Pick<PaperTrade, "optionSymbol">): number {
  return t.optionSymbol ? 100 : 1;
}

function directionMultiplier(t: Pick<PaperTrade, "optionSymbol" | "optionType">): number {
  return !t.optionSymbol && t.optionType === "put" ? -1 : 1;
}

function persist(trade: PaperTrade): void {
  const db = getDb();
  // Keep the legacy `status` authoritative; derive the explicit order/position
  // states from it so old rows and new rows read through one mapping.
  db.prepare(
    `UPDATE paper_trades SET
       status=?, order_state=?, position_state=?, entry_price=?, entry_at_ms=?, exit_price=?, exit_at_ms=?, exit_reason=?,
       mfe_pct=?, mae_pct=?, last_mark=?, last_mark_at_ms=?, lessons=COALESCE(?, lessons)
     WHERE id=?`,
  ).run(
    trade.status, deriveOrderState(trade.status), derivePositionState(trade.status),
    trade.entryPrice, trade.entryAtMs, trade.exitPrice, trade.exitAtMs, trade.exitReason,
    trade.mfePct, trade.maePct, trade.lastMark, trade.lastMarkAtMs,
    TERMINAL_STATES.has(trade.status) && trade.entryPrice != null ? lessonsLearned(trade) : null,
    trade.id,
  );
}

const fillCfg = () => defaultFillConfig();

/** Emit a sequence of lifecycle events for a trade (idempotent per event). */
function emitEvents(tradeId: number | undefined, alertId: number | null, ticker: string, events: PaperEventType[], detail: { fromState?: string | null; toState?: string | null; reason?: string; discriminator?: string | number | null; nowMs?: number } = {}): void {
  if (tradeId == null) return;
  for (const eventType of events) {
    recordPaperEvent({
      tradeId, alertId, ticker, eventType,
      fromState: detail.fromState ?? null, toState: detail.toState ?? null,
      payload: detail.reason ? { reason: detail.reason } : undefined,
      discriminator: detail.discriminator ?? eventType,
      nowMs: detail.nowMs,
    });
  }
}

function underlyingFromContracts(contracts: any[]): number | null {
  const c = contracts.find((x) => typeof x?.underlyingPrice === "number");
  return c?.underlyingPrice ?? null;
}

function chainAsOfFromContracts(contracts: any[]): number | null {
  return contracts.reduce<number | null>(
    (max, c) => (typeof c?.providerTimestamp === "number" && (max == null || c.providerTimestamp > max) ? c.providerTimestamp : max),
    null,
  );
}

function profileForTrade(t: PaperTrade, stored?: string | null): string {
  if (stored) return stored;
  return t.dteAtEntry != null && t.dteAtEntry <= 1 ? "zero_dte_momentum" : "swing_position";
}

function alertTimeContractFor(row: any, t: PaperTrade): AlertTimeContract {
  const parsed = parseJsonObj(row?.alert_time_contract_json);
  if (parsed && parsed.optionSymbol) return parsed as unknown as AlertTimeContract;
  return {
    optionSymbol: t.optionSymbol ?? "",
    side: t.optionType,
    strike: t.strike,
    expiration: t.expiration,
    dte: t.dteAtEntry,
    mid: row?.entry_bid != null && row?.entry_ask != null ? (row.entry_bid + row.entry_ask) / 2 : null,
    spreadPct: row?.entry_spread_pct ?? null,
    delta: row?.entry_delta ?? null,
  };
}

export function listPaperTrades(limit = 200): Array<PaperTrade & {
  unrealizedPnlDollars: number | null;
  unrealizedPnlPct: number | null;
  entrySnapshot: Record<string, number | string | null>;
  orderState: string | null;
  positionState: string | null;
  strategy: string | null;
  selectorProfile: string | null;
  selectionScore: number | null;
  closeReason: string | null;
  riskAmount: number | null;
  passedGates: string[] | null;
  failedGates: string[] | null;
  entryCosts: Record<string, number | string | null>;
  exitCosts: Record<string, number | null>;
  alertTimeContract: Record<string, unknown> | null;
  preentrySnapshot: Record<string, unknown> | null;
  preentryDrift: Record<string, unknown> | null;
  fillAssumptions: Record<string, unknown> | null;
  fingerprintId: string | null;
  fingerprintVersion: number | null;
  fingerprintDimensions: Record<string, unknown> | null;
  outcome: PaperOutcomeRow | null;
  explanation: PaperExplanation;
}> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM paper_trades ORDER BY id DESC LIMIT ?").all(limit) as any[];
  const outcomes = outcomesByTradeId(rows.map((r) => r.id));
  return rows.map((r) => {
    const t = rowToTrade(r);
    const live = t.status === "ENTERED" && t.entryPrice != null && t.lastMark != null;
    const splitGates = (v: string | null | undefined): string[] | null => (v ? v.split(",").filter(Boolean) : null);
    const preentry = parseJsonObj(r.preentry_snapshot_json);
    const drift = parseJsonObj(r.preentry_drift_json);
    const outcome = outcomes.get(r.id) ?? null;
    const fingerprintDimensions = parseJsonObj(r.fingerprint_dimensions_json);
    const explanation = buildPaperExplanation({
      ticker: t.ticker,
      side: t.optionType,
      status: t.status,
      orderState: r.order_state ?? deriveOrderState(t.status),
      positionState: r.position_state ?? derivePositionState(t.status),
      strategy: r.strategy ?? null,
      thesis: t.thesis,
      selectionScore: r.selection_score ?? null,
      revalidationOk: preentry ? Boolean(preentry.revalidatedOk) : null,
      revalidationReason: (preentry?.reason as string) ?? null,
      revalidationCode: (preentry?.rejectionCode as any) ?? null,
      drift: drift as any,
      entryPrice: t.entryPrice,
      entrySlippage: r.entry_slippage ?? null,
      entryFees: r.entry_fees ?? null,
      exitPrice: t.exitPrice,
      exitSlippage: r.exit_slippage ?? null,
      exitFees: r.exit_fees ?? null,
      closeReason: r.close_reason ?? null,
      exitReason: t.exitReason,
      fingerprintId: r.fingerprint_id ?? null,
      fingerprintSummary: fingerprintDimensions ? humanReadable(fingerprintDimensions as Record<string, string | null>) : null,
      outcomeGrade: outcome?.grade ?? null,
      outcomeGrossPnl: outcome?.grossPnl ?? null,
      outcomeNetPnl: outcome?.netPnl ?? null,
      outcomeRMultiple: outcome?.rMultiple ?? null,
      outcomeDataQuality: outcome?.dataQualityStatus ?? null,
      outcomeDataQualityReasons: outcome?.dataQualityReasons ?? null,
    });
    return {
      ...t,
      fingerprintId: r.fingerprint_id ?? null,
      fingerprintVersion: r.fingerprint_version ?? null,
      fingerprintDimensions,
      outcome,
      // Unrealized P/L updates every sweep from the live mark — exactly what a
      // broker position screen would show.
      unrealizedPnlDollars: live ? +(((t.lastMark as number) - (t.entryPrice as number)) * directionMultiplier(t) * paperMultiplier(t) * t.contracts).toFixed(2) : null,
      unrealizedPnlPct: live ? +(((((t.lastMark as number) - (t.entryPrice as number)) * directionMultiplier(t)) / (t.entryPrice as number)) * 100).toFixed(2) : null,
      entrySnapshot: {
        bid: r.entry_bid ?? null, ask: r.entry_ask ?? null, spreadPct: r.entry_spread_pct ?? null,
        iv: r.entry_iv ?? null, delta: r.entry_delta ?? null, gamma: r.entry_gamma ?? null,
        theta: r.entry_theta ?? null, vega: r.entry_vega ?? null,
        openInterest: r.entry_oi ?? null, volume: r.entry_volume ?? null,
        entryReason: r.entry_reason ?? null,
      },
      // Rebuild fields — explicit states, strategy, gates, costs, immutable snapshots.
      orderState: r.order_state ?? deriveOrderState(t.status),
      positionState: r.position_state ?? derivePositionState(t.status),
      strategy: r.strategy ?? null,
      selectorProfile: r.selector_profile ?? null,
      selectionScore: r.selection_score ?? null,
      closeReason: r.close_reason ?? null,
      riskAmount: r.risk_amount ?? null,
      passedGates: splitGates(r.passed_gates),
      failedGates: splitGates(r.failed_gates),
      entryCosts: {
        slippage: r.entry_slippage ?? null, fees: r.entry_fees ?? null,
        underlyingAtEntry: r.underlying_at_entry ?? null, sessionAtEntry: r.session_at_entry ?? null,
        freshnessAtEntry: r.freshness_at_entry ?? null,
      },
      exitCosts: { slippage: r.exit_slippage ?? null, fees: r.exit_fees ?? null },
      alertTimeContract: parseJsonObj(r.alert_time_contract_json),
      preentrySnapshot: preentry,
      preentryDrift: drift,
      fillAssumptions: parseJsonObj(r.fill_assumptions_json),
      explanation,
    };
  });
}

/** Events for one trade (chronological) — for the dashboard detail view. */
export function paperTradeEvents(tradeId: number, limit = 200): PaperEventRow[] {
  return listPaperEvents(tradeId, limit);
}

/** Recent events across all trades (newest first) — dashboard feed. */
export function recentPaperEvents(limit = 200): PaperEventRow[] {
  return listRecentPaperEvents(limit);
}

export interface PaperDecisionLog {
  id: number;
  tradeId: number | null;
  alertId: number | null;
  ticker: string | null;
  decision: string;
  allowed: boolean;
  reason: string;
  risk: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
  createdAtMs: number;
}

function parseJsonObj(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function listPaperDecisions(limit = 120): PaperDecisionLog[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM paper_decisions ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => ({
    id: r.id,
    tradeId: r.trade_id ?? null,
    alertId: r.alert_id ?? null,
    ticker: r.ticker ?? null,
    decision: r.decision,
    allowed: Boolean(r.allowed),
    reason: r.reason,
    risk: parseJsonObj(r.risk_json),
    snapshot: parseJsonObj(r.snapshot_json),
    createdAtMs: r.created_at_ms,
  }));
}

function hasTable(name: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export interface DailyPaperSummary {
  sinceMs: number;
  qualifyingActionableCallouts: number;
  paperCandidatesCreated: number;
  readyOrders: number;
  revalidationAttempts: number;
  fills: number;
  rejected: number;
  expiredEntryWindows: number;
  zeroFillReason: string | null;
  text: string;
}

function startOfLocalDayMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dailyPaperSummary(nowMs: number = Date.now()): DailyPaperSummary {
  const db = getDb();
  const sinceMs = startOfLocalDayMs(nowMs);
  const sinceIso = new Date(sinceMs).toISOString();
  const count = (sql: string, ...args: any[]) => Number((db.prepare(sql).get(...args) as any)?.n ?? 0);
  const latestReason = (sql: string, ...args: any[]) => String((db.prepare(sql).get(...args) as any)?.reason ?? "").trim();

  const paperCandidatesTable = hasTable("paper_candidates");
  const paperEventsTable = hasTable("paper_events");
  const candidateCallouts = paperCandidatesTable
    ? count("SELECT COUNT(*) n FROM paper_candidates WHERE created_at_ms >= ?", sinceMs)
    : 0;
  const tradeAlerts = count(
    `SELECT COUNT(*) n FROM alerts
     WHERE capture_action='TRADE' AND option_symbol IS NOT NULL AND asset_class != 'stock' AND alert_time >= ?`,
    sinceIso,
  );
  const qualifyingActionableCallouts = Math.max(candidateCallouts, tradeAlerts);
  const paperCandidatesCreated = paperCandidatesTable
    ? count("SELECT COUNT(*) n FROM paper_candidates WHERE status='CREATED' AND created_at_ms >= ?", sinceMs)
    : count("SELECT COUNT(*) n FROM paper_trades WHERE option_symbol IS NOT NULL AND created_at_ms >= ?", sinceMs);
  const readyOrders = count("SELECT COUNT(*) n FROM paper_trades WHERE option_symbol IS NOT NULL AND status='READY' AND created_at_ms >= ?", sinceMs);
  const revalidationAttempts = paperEventsTable
    ? count("SELECT COUNT(*) n FROM paper_events WHERE event_type IN ('validation_passed','validation_failed','no_fill') AND created_at_ms >= ?", sinceMs)
    : count("SELECT COUNT(*) n FROM paper_decisions WHERE decision IN ('entry_filled','entry_rejected') AND created_at_ms >= ?", sinceMs);
  const fills = count("SELECT COUNT(*) n FROM paper_trades WHERE option_symbol IS NOT NULL AND entry_at_ms >= ?", sinceMs);
  const rejected = count("SELECT COUNT(*) n FROM paper_trades WHERE option_symbol IS NOT NULL AND status='CANCELLED' AND entry_price IS NULL AND created_at_ms >= ?", sinceMs);
  const expiredEntryWindows = count(
    "SELECT COUNT(*) n FROM paper_trades WHERE option_symbol IS NOT NULL AND status IN ('CANCELLED','EXPIRED') AND entry_price IS NULL AND created_at_ms >= ? AND COALESCE(exit_reason, close_reason, '') LIKE '%entry window%'",
    sinceMs,
  );

  let zeroFillReason: string | null = null;
  if (fills === 0) {
    if (qualifyingActionableCallouts === 0) {
      zeroFillReason = "0 high-confidence actionable setups passed all gates.";
    } else if (paperCandidatesCreated === 0) {
      zeroFillReason = (paperCandidatesTable
        ? latestReason(
          "SELECT COALESCE(reject_reason, 'paper candidate was not created') AS reason FROM paper_candidates WHERE created_at_ms >= ? AND status='REJECTED' ORDER BY id DESC LIMIT 1",
          sinceMs,
        )
        : "") || "Qualifying setups existed, but no READY paper order was created.";
    } else if (readyOrders > 0) {
      zeroFillReason = `${readyOrders} READY order${readyOrders === 1 ? "" : "s"} still waiting for conservative live fill/revalidation.`;
    } else if (expiredEntryWindows > 0) {
      zeroFillReason = `${expiredEntryWindows} entry window${expiredEntryWindows === 1 ? "" : "s"} expired before a conservative fill.`;
    } else {
      zeroFillReason = latestReason(
        "SELECT reason FROM paper_decisions WHERE allowed=0 AND created_at_ms >= ? ORDER BY id DESC LIMIT 1",
        sinceMs,
      ) || "No fill occurred yet; check the latest decision log for the active blocker.";
    }
  }

  const text = fills > 0
    ? `${qualifyingActionableCallouts} setup${qualifyingActionableCallouts === 1 ? "" : "s"} qualified: ${fills} filled, ${rejected} rejected, ${readyOrders} still READY.`
    : `No paper trades today: ${zeroFillReason}`;

  return {
    sinceMs,
    qualifyingActionableCallouts,
    paperCandidatesCreated,
    readyOrders,
    revalidationAttempts,
    fills,
    rejected,
    expiredEntryWindows,
    zeroFillReason,
    text,
  };
}

function logDecision(input: {
  tradeId?: number | null;
  alertId?: number | null;
  ticker?: string | null;
  decision: string;
  allowed: boolean;
  reason: string;
  risk?: unknown;
  snapshot?: unknown;
  nowMs?: number;
}): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO paper_decisions
        (trade_id, alert_id, ticker, decision, allowed, reason, risk_json, snapshot_json, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.tradeId ?? null,
      input.alertId ?? null,
      input.ticker ?? null,
      input.decision,
      input.allowed ? 1 : 0,
      input.reason,
      input.risk == null ? null : JSON.stringify(input.risk),
      input.snapshot == null ? null : JSON.stringify(input.snapshot),
      input.nowMs ?? Date.now(),
    );
  } catch (err: any) {
    console.warn("[paper] decision log skipped:", err?.message);
  }
}

function isPermanentAutoEntryRefusal(failures: string[]): boolean {
  const text = failures.join(" ; ").toLowerCase();
  if (/alert not found|positive entrylimit|required|no contract attached/.test(text)) return true;
  if (/0dte contracts are excluded|kill switch/.test(text)) return true;
  if (/bearish|put/.test(text)) return true;
  return false;
}

function openTrades(): PaperTrade[] {
  const db = getDb();
  return (db.prepare(
    "SELECT * FROM paper_trades WHERE status IN ('WATCHING','READY','ENTERED') ORDER BY id ASC",
  ).all() as any[]).map(rowToTrade);
}

// ── Risk context from realized history ──────────────────────────────────────

export function riskContext(): RiskContext {
  const db = getDb();
  const dayMs = Date.now() - 24 * 3600_000; // rolling 24h ≈ trading day for paper purposes
  const nowMs = Date.now();
  const weekMs = nowMs - 7 * 24 * 3600_000;
  const realized = (sinceMs: number): number => {
    const rows = db.prepare(
    `SELECT entry_price, exit_price, contracts, option_symbol, option_type FROM paper_trades
       WHERE exit_at_ms >= ? AND entry_price IS NOT NULL AND exit_price IS NOT NULL`,
    ).all(sinceMs) as any[];
    return rows.reduce((s, r) => {
      const multiplier = r.option_symbol ? 100 : 1;
      const direction = !r.option_symbol && r.option_type === "put" ? -1 : 1;
      return s + (r.exit_price - r.entry_price) * direction * multiplier * (r.contracts ?? 1);
    }, 0);
  };
  const recentClosed = db.prepare(
    `SELECT exit_at_ms, entry_price, exit_price, contracts, option_symbol, option_type FROM paper_trades
     WHERE exit_at_ms IS NOT NULL AND entry_price IS NOT NULL AND exit_price IS NOT NULL
     ORDER BY exit_at_ms DESC LIMIT 20`,
  ).all() as any[];
  const lastLoss = recentClosed.find((r) => {
    const multiplier = r.option_symbol ? 100 : 1;
    const direction = !r.option_symbol && r.option_type === "put" ? -1 : 1;
    return (r.exit_price - r.entry_price) * direction * multiplier * (r.contracts ?? 1) < 0;
  });
  return {
    openTrades: openTrades(),
    realizedTodayDollars: realized(dayMs),
    realizedWeekDollars: realized(weekMs),
    lastLossAtMs: lastLoss?.exit_at_ms ?? null,
    nowMs,
  };
}

/** Capital context from open positions + realized P/L (buying-power reservation). */
export function capitalContext(nowMs = Date.now()): CapitalContext {
  const db = getDb();
  const cfg = defaultCapitalConfig();
  const realized: any = db.prepare(
    `SELECT COALESCE(SUM((exit_price - entry_price) * (CASE WHEN option_symbol IS NULL AND option_type='put' THEN -1 ELSE 1 END)
       * (CASE WHEN option_symbol IS NULL THEN 1 ELSE 100 END) * contracts), 0) AS pnl
     FROM paper_trades WHERE entry_price IS NOT NULL AND exit_price IS NOT NULL`,
  ).get();
  const open = db.prepare(
    "SELECT ticker, option_symbol, entry_price, entry_limit, contracts, strategy FROM paper_trades WHERE status IN ('ENTERED')",
  ).all() as any[];
  const reserved = open.reduce((s, r) => s + (r.entry_price ?? r.entry_limit ?? 0) * (r.option_symbol ? 100 : 1) * (r.contracts ?? 1), 0);
  const dayStart = new Date(nowMs); dayStart.setHours(0, 0, 0, 0);
  return {
    equityDollars: cfg.startingBalance + Number(realized?.pnl ?? 0),
    reservedOpenDollars: +reserved.toFixed(2),
    openPositions: open.length,
    openContractSymbols: new Set(open.map((r) => r.option_symbol).filter(Boolean)),
    todayStrategyEntries: 0, // per-strategy counting handled at auto-entry time
  };
}

// ── Creation (from an alert or manual) ───────────────────────────────────────

export interface CreatePaperTradeInput {
  alertId?: number | null;
  ticker?: string;
  optionSymbol?: string | null;
  optionType?: "call" | "put";
  strike?: number | null;
  expiration?: string | null;
  dte?: number | null;
  contracts?: number;
  entryLimit?: number | null;
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
  thesis?: string | null;
}

export interface CreateResult {
  ok: boolean;
  id?: number;
  risk: RiskVerdict;
  note?: string;
}

export function createPaperTrade(input: CreatePaperTradeInput): CreateResult {
  const db = getDb();
  let base: CreatePaperTradeInput = { ...input };
  let confidence: number | null = null;
  let thesisSnapshot = { shortRate: null as number | null, aboveVwap: null as boolean | null, relVol: null as number | null };

  if (input.alertId != null) {
    const a = db.prepare("SELECT * FROM alerts WHERE id=?").get(input.alertId) as any;
    if (!a) return { ok: false, risk: { allowed: false, failures: ["alert not found"] } };
    base = {
      ticker: a.ticker,
      optionSymbol: a.option_symbol,
      optionType: String(a.option_side ?? "call").toLowerCase() === "put" ? "put" : "call",
      strike: a.strike, expiration: a.expiration, dte: a.dte,
      thesis: a.ai_explanation ?? a.catalyst_summary ?? `Scanner callout: ${a.private_label ?? a.source}`,
      ...input, // explicit fields win over alert-derived ones
    };
    confidence = a.signal_score ?? null;
    thesisSnapshot = {
      shortRate: a.short_rate_at_alert ?? null,
      aboveVwap: a.above_vwap != null ? Boolean(a.above_vwap) : null,
      relVol: a.relative_volume ?? null,
    };
    base.entryLimit ??= a.entry_mid ?? null;
  }

  if (!base.ticker || !base.optionSymbol || base.entryLimit == null || base.entryLimit <= 0) {
    return { ok: false, risk: { allowed: false, failures: ["ticker, optionSymbol and a positive entryLimit are required (alert had no contract attached?)"] } };
  }

  // Do not require the process-global freshness cache to already contain every
  // option data kind before creating a READY paper order. Alert/callout paths
  // pass a frozen contract; the sweep below revalidates the live chain and quote
  // before any fill. Requiring actionableFreshness here caused fresh alerts to be
  // permanently marked CANCELLED when the cache only said NOT_REQUESTED_YET.

  const exitCfg = defaultExitConfig();
  const takeProfitPct = base.takeProfitPct ?? exitCfg.takeProfitPct;
  const contracts = base.contracts ?? unitsForDollarExposure({
    entryPrice: base.entryLimit,
    minPositionDollars: paperMinPositionDollars(),
    multiplier: 100,
  });
  const proposed: ProposedTrade = {
    ticker: base.ticker,
    optionType: base.optionType ?? "call",
    dte: base.dte ?? null,
    entryLimit: base.entryLimit,
    contracts,
    stopLossPct: base.stopLossPct ?? exitCfg.stopLossPct,
  };
  const risk = checkRisk(proposed, riskContext(), riskConfigForProposed(proposed));
  if (!risk.allowed) {
    logDecision({
      alertId: base.alertId ?? null,
      ticker: base.ticker,
      decision: "risk_refused",
      allowed: false,
      reason: risk.failures.join("; "),
      risk,
      snapshot: proposed,
    });
    return { ok: false, risk };
  }

  // Capital / buying-power reservation (rebuild) — composed with the risk engine.
  const strategy = profileForTrade({ dteAtEntry: base.dte ?? null } as PaperTrade);
  const costDollars = base.entryLimit * 100 * proposed.contracts;
  const capital = checkCapital(
    { ticker: base.ticker, optionSymbol: base.optionSymbol, strategy, costDollars, units: proposed.contracts },
    capitalContext(),
  );
  if (!capital.allowed) {
    logDecision({
      alertId: base.alertId ?? null, ticker: base.ticker, decision: "capital_refused",
      allowed: false, reason: capital.failures.join("; "), snapshot: { costDollars, strategy },
    });
    return { ok: false, risk: { allowed: false, failures: capital.failures } };
  }

  const nowMs = Date.now();
  const riskAmount = dollarsAtRisk(base.entryLimit, proposed.contracts, proposed.stopLossPct ?? null, 100);
  // Immutable alert-time contract snapshot — never overwritten by later marks.
  const alertTimeContract: AlertTimeContract = {
    optionSymbol: base.optionSymbol,
    side: proposed.optionType,
    strike: base.strike ?? null,
    expiration: base.expiration ?? null,
    dte: base.dte ?? null,
    mid: base.entryLimit,
    spreadPct: null,
    delta: null,
  };
  const info = db.prepare(
    `INSERT INTO paper_trades
       (alert_id, ticker, option_symbol, option_type, strike, expiration, dte_at_entry, contracts,
        status, order_state, thesis, confidence, entry_limit, stop_loss_pct, take_profit_pct,
        short_rate_entry, above_vwap_entry, rel_vol_entry, created_at_ms,
        strategy, selector_profile, alert_time_contract_json, risk_amount, snapshot_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    base.alertId ?? null, base.ticker, base.optionSymbol, proposed.optionType,
    base.strike ?? null, base.expiration ?? null, base.dte ?? null, proposed.contracts,
    "READY", "PENDING", base.thesis ?? null, confidence, base.entryLimit,
    proposed.stopLossPct, takeProfitPct,
    thesisSnapshot.shortRate, thesisSnapshot.aboveVwap == null ? null : (thesisSnapshot.aboveVwap ? 1 : 0),
    thesisSnapshot.relVol, nowMs,
    strategy, strategy, JSON.stringify(alertTimeContract), riskAmount, 1,
  );
  const id = Number(info.lastInsertRowid);
  emitEvents(id, base.alertId ?? null, base.ticker, ["candidate_created", "order_submitted"], { toState: "PENDING", reason: "risk + capital passed; entry order active", nowMs });
  logDecision({
    tradeId: id,
    alertId: base.alertId ?? null,
    ticker: base.ticker,
    decision: "entry_order_created",
    allowed: true,
    reason: "risk passed; limit buy order is active",
    risk,
    snapshot: proposed,
    nowMs,
  });
  return { ok: true, id, risk, note: "entry limit order active (READY)" };
}

/** Manual cancel/close. Close uses last mark (documented — no fresh fetch). */
export function manualAction(id: number, action: "cancel" | "close"): { ok: boolean; note: string } {
  const db = getDb();
  const row = db.prepare("SELECT * FROM paper_trades WHERE id=?").get(id) as any;
  if (!row) return { ok: false, note: "trade not found" };
  const trade = rowToTrade(row);

  if (action === "cancel") {
    if (!["WATCHING", "READY"].includes(trade.status)) return { ok: false, note: `cannot cancel a ${trade.status} trade` };
    persist({ ...trade, status: "CANCELLED", exitReason: "manual: cancelled before fill" });
    logDecision({
      tradeId: trade.id,
      alertId: trade.alertId ?? null,
      ticker: trade.ticker,
      decision: "manual_cancel",
      allowed: true,
      reason: "user cancelled before fill",
    });
    return { ok: true, note: "cancelled" };
  }
  if (trade.status !== "ENTERED") return { ok: false, note: `cannot close a ${trade.status} trade` };
  const mark = trade.lastMark ?? trade.entryPrice ?? 0;
  const nowMs = Date.now();
  const closed = applyExit(trade, { kind: "manual", reason: `closed by user at last mark ${mark.toFixed(2)}`, fillPrice: mark }, nowMs);
  persist(closed);
  logDecision({
    tradeId: trade.id,
    alertId: trade.alertId ?? null,
    ticker: trade.ticker,
    decision: "manual_close",
    allowed: true,
    reason: `closed by user at last mark ${mark.toFixed(2)}`,
    snapshot: { fillPrice: mark },
    nowMs,
  });
  return { ok: true, note: `closed at ${mark.toFixed(2)} (last mark)` };
}

// ── Sweep ────────────────────────────────────────────────────────────────────

function liveSnapshotFor(ticker: string): LiveTapeSnapshot | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loopState } = require("@/lib/scanner-loop");
    const row = (loopState().tape ?? []).find((r: any) => r.symbol === ticker);
    if (!row) return null;
    return {
      shortRate: row.shortRate ?? null,
      aboveVwap: row.aboveVwap ?? null,
      relVol: row.relVol ?? null,
      spreadPct: null, // filled from the quote below
      direction: row.direction ?? null,
    };
  } catch {
    return null;
  }
}

interface MarketSnap {
  quote: OptionQuote;
  /** Full contract state for realism snapshots (greeks/IV/OI/volume). */
  contract: any;
}

function snapFromContracts(contracts: any[], optionSymbol: string | null): MarketSnap | null {
  if (!optionSymbol || !contracts?.length) return null;
  const c = contracts.find((x: any) => x.optionSymbol === optionSymbol);
  if (!c) return null;
  return {
    quote: { optionSymbol: c.optionSymbol, bid: c.bid, ask: c.ask, mid: c.mid, spreadPct: c.spreadPct, asOfMs: Date.now() },
    contract: c,
  };
}

/** Map an exit kind to its lifecycle event type (for the immutable event log). */
const EXIT_EVENT: Record<ExitDecision["kind"], PaperEventType> = {
  stop_loss: "stop_triggered",
  take_profit: "target_triggered",
  smart: "system_close",
  manual: "manual_close",
  expired: "expiration",
};

/** Immutable pre-entry snapshot: written once (COALESCE guards overwrite). */
function persistPreentrySnapshot(id: number | undefined, reval: RevalidationResult, extra: { session: MarketSession; spot: number | null; nowMs: number }): void {
  if (id == null) return;
  const snapshot = {
    revalidatedOk: reval.ok,
    actionable: reval.actionable,
    rejectionCode: reval.rejectionCode,
    reason: reval.reason,
    passedGates: reval.passedGates,
    failedGates: reval.failedGates,
    selectionScore: reval.selectionScore,
    session: extra.session,
    spot: extra.spot,
    at: extra.nowMs,
  };
  getDb().prepare(
    `UPDATE paper_trades SET
       preentry_snapshot_json = COALESCE(preentry_snapshot_json, ?),
       preentry_drift_json   = COALESCE(preentry_drift_json, ?),
       selection_score       = COALESCE(selection_score, ?),
       passed_gates          = COALESCE(passed_gates, ?),
       failed_gates          = COALESCE(failed_gates, ?)
     WHERE id=?`,
  ).run(
    JSON.stringify(snapshot),
    reval.drift ? JSON.stringify(reval.drift) : null,
    reval.selectionScore,
    reval.passedGates.length ? reval.passedGates.join(",") : null,
    reval.failedGates.length ? reval.failedGates.join(",") : null,
    id,
  );
}

/** Record the deterministic fill costs + assumptions on entry or exit. */
function persistFillCosts(
  id: number | undefined,
  kind: "entry" | "exit",
  slippage: number,
  fees: number,
  assumptions: unknown,
  extra: { underlying?: number | null; session?: MarketSession; freshness?: string | null; closeReason?: string | null } = {},
): void {
  if (id == null) return;
  const db = getDb();
  if (kind === "entry") {
    db.prepare(
      `UPDATE paper_trades SET entry_slippage=?, entry_fees=?,
         fill_assumptions_json = COALESCE(?, fill_assumptions_json),
         underlying_at_entry=?, session_at_entry=?, freshness_at_entry=?
       WHERE id=?`,
    ).run(slippage, fees, assumptions ? JSON.stringify(assumptions) : null, extra.underlying ?? null, extra.session ?? null, extra.freshness ?? null, id);
  } else {
    db.prepare(
      `UPDATE paper_trades SET exit_slippage=?, exit_fees=?, close_reason=COALESCE(?, close_reason) WHERE id=?`,
    ).run(slippage, fees, extra.closeReason ?? null, id);
  }
}

function entryThesisSnapshotFor(id: number | undefined): EntryThesisSnapshot {
  const snap: EntryThesisSnapshot = { shortRateAtEntry: null, aboveVwapAtEntry: null, relVolAtEntry: null };
  if (id == null) return snap;
  const row = getDb().prepare("SELECT short_rate_entry, above_vwap_entry, rel_vol_entry FROM paper_trades WHERE id=?").get(id) as any;
  if (row) {
    snap.shortRateAtEntry = row.short_rate_entry ?? null;
    snap.aboveVwapAtEntry = row.above_vwap_entry == null ? null : Boolean(row.above_vwap_entry);
    snap.relVolAtEntry = row.rel_vol_entry ?? null;
  }
  return snap;
}

/**
 * Advance one READY/ENTERED trade against a fresh chain snapshot.
 *
 * READY → pre-entry revalidation of the SAME alert-time contract (no
 * substitution) then a conservative fill (never the mid); a failed
 * revalidation rejects and preserves the contract. ENTERED → a stale/missing
 * mark keeps the position OPEN (no fabricated exit); a real exit settles at
 * intrinsic (expiry) or bid − slippage, and an unfillable exit quote keeps the
 * position open rather than inventing a close.
 */
function advanceOpenTrade(t: PaperTrade, snap: MarketSnap, contracts: any[], nowMs: number): boolean {
  const quote = snap.quote;
  const session = marketSession(nowMs);
  const db = getDb();

  if (t.status === "READY") {
    const row = db.prepare("SELECT * FROM paper_trades WHERE id=?").get(t.id) as any;
    const profile = profileForTrade(t, row?.selector_profile);
    const alertContract = alertTimeContractFor(row, t);
    const spot = underlyingFromContracts(contracts);
    const reval = revalidateContract({
      underlying: t.ticker,
      alertContract,
      freshContracts: contracts as ChainContract[],
      chainAvailable: true,
      chainAsOfMs: chainAsOfFromContracts(contracts),
      session,
      spot,
      profile,
      nowMs,
    });
    const entryWindowExpired = nowMs - t.createdAtMs > ENTRY_WINDOW_MS;
    const decision = decideEntryFill({
      revalidation: reval,
      quote,
      limit: t.entryLimit ?? 0,
      contracts: t.contracts,
      session,
      fillCfg: fillCfg(),
      nowMs,
      entryWindowExpired,
    });

    if (decision.action === "wait") {
      emitEvents(t.id, t.alertId ?? null, t.ticker, decision.events, { reason: decision.reason, discriminator: Math.floor(nowMs / 60_000), nowMs });
      return false;
    }

    // Both fill and reject finalize the pre-entry stage → record the immutable snapshot.
    persistPreentrySnapshot(t.id, reval, { session, spot, nowMs });

    if (decision.action === "fill" && decision.fillPrice != null) {
      const entered: PaperTrade = {
        ...t, status: "ENTERED",
        entryPrice: decision.fillPrice, entryAtMs: nowMs,
        lastMark: quote.mid ?? decision.fillPrice, lastMarkAtMs: nowMs,
        mfePct: 0, maePct: 0,
      };
      persist(entered);
      persistFillCosts(t.id, "entry", decision.slippage, decision.fees, decision.assumptions, { underlying: spot, session, freshness: `chain age ${chainAsOfFromContracts(contracts) != null ? Math.round((nowMs - (chainAsOfFromContracts(contracts) as number)) / 1000) : "?"}s` });
      persistMarketSnapshot(t.id, "entry", snap, `filled: ${decision.reason}`);
      // Freeze the primary setup fingerprint at the actual fill (entry-time
      // fields only — immutable, write-once).
      freezePaperFingerprintForTrade(t.id!, nowMs);
      emitEvents(t.id, t.alertId ?? null, t.ticker, decision.events, { fromState: "PENDING", toState: "OPEN", reason: decision.reason, nowMs });
      logDecision({ tradeId: t.id, alertId: t.alertId ?? null, ticker: t.ticker, decision: "entry_filled", allowed: true, reason: decision.reason, snapshot: { optionSymbol: quote.optionSymbol, bid: quote.bid, ask: quote.ask, fillPrice: decision.fillPrice, slippage: decision.slippage, fees: decision.fees }, nowMs });
      return true;
    }

    // reject (failed/non-actionable revalidation, or lapsed entry window) — preserve the contract, never substitute.
    const rejected: PaperTrade = { ...t, status: decision.toStatus ?? "CANCELLED", exitReason: decision.reason };
    persist(rejected);
    persistFillCosts(t.id, "exit", 0, 0, null, { closeReason: decision.reason });
    emitEvents(t.id, t.alertId ?? null, t.ticker, decision.events, { fromState: "PENDING", toState: decision.toOrderState, reason: decision.reason, nowMs });
    logDecision({ tradeId: t.id, alertId: t.alertId ?? null, ticker: t.ticker, decision: "entry_rejected", allowed: false, reason: decision.reason, snapshot: { rejectionCode: reval.rejectionCode, revalOk: reval.ok }, nowMs });
    return true;
  }

  if (t.status !== "ENTERED") return false;

  // Mark first: a stale/missing mark keeps the position OPEN — no fabricated
  // exit, no terminal ERROR for a temporary quote gap.
  const markDecision = decideMark(quote, fillCfg(), nowMs);
  if (!markDecision.markable) {
    emitEvents(t.id, t.alertId ?? null, t.ticker, [markDecision.event], { reason: markDecision.note, discriminator: Math.floor(nowMs / 60_000), nowMs });
    return false;
  }

  let marked = markToMarket(t, quote, nowMs);
  const live = liveSnapshotFor(t.ticker);
  const liveWithSpread = live ? { ...live, spreadPct: quote.spreadPct } : null;
  const entrySnap = entryThesisSnapshotFor(t.id);
  const exit = evaluateExit(marked, quote, liveWithSpread, entrySnap, nowMs, defaultExitConfig());
  if (exit) {
    const exitFill = resolveExitFill({ decision: exit, trade: marked, quote, underlying: underlyingFromContracts(contracts), session, fillCfg: fillCfg(), nowMs });
    if (exitFill.unresolved) {
      // The exit is warranted but no usable quote to fill against — keep the
      // position open and surface the data-quality issue, don't invent a close.
      emitEvents(t.id, t.alertId ?? null, t.ticker, ["mark_missing"], { reason: exitFill.note, discriminator: Math.floor(nowMs / 60_000), nowMs });
      persist(marked);
      return true;
    }
    marked = applyExit(marked, { ...exit, fillPrice: exitFill.fillPrice }, nowMs);
    persist(marked);
    persistFillCosts(t.id, "exit", exitFill.slippage, exitFill.fees, exitFill.assumptions, { closeReason: `${exit.kind}: ${exit.reason}` });
    persistMarketSnapshot(t.id, "exit", snap);
    emitEvents(t.id, t.alertId ?? null, t.ticker, [EXIT_EVENT[exit.kind], "final_outcome"], { fromState: "OPEN", toState: derivePositionState(marked.status), reason: exit.reason, nowMs });
    logDecision({ tradeId: t.id, alertId: t.alertId ?? null, ticker: t.ticker, decision: `exit_${exit.kind}`, allowed: true, reason: exit.reason, snapshot: { optionSymbol: quote.optionSymbol, bid: quote.bid, ask: quote.ask, fillPrice: exitFill.fillPrice, slippage: exitFill.slippage, fees: exitFill.fees }, nowMs });
    return true;
  }
  persist(marked);
  return true;
}

/**
 * Fast path (2026-07-09): the scanner's active-alert refresh already fetches
 * fresh chains every ~7s for recently-alerted symbols — exactly the symbols
 * auto-entered paper trades hold. Reusing those quotes gives 0DTE paper
 * trades ~7-second stop/target/smart-exit reaction at ZERO extra API cost.
 * (A literal 1s per-trade fetch would burn 60+ calls/min per position and
 * starve the live scanner — this is the professional tradeoff.)
 */
export function evaluatePaperTradesWithChain(ticker: string, contracts: any[], nowMs: number = Date.now()): number {
  if (!contracts?.length) return 0;
  const db = getDb();
  const trades = (db.prepare(
    "SELECT * FROM paper_trades WHERE ticker=? AND status IN ('READY','ENTERED') ORDER BY id ASC",
  ).all(ticker) as any[]).map(rowToTrade);
  let advanced = 0;
  for (const t of trades) {
    const snap = snapFromContracts(contracts, t.optionSymbol);
    if (snap && advanceOpenTrade(t, snap, contracts, nowMs)) advanced += 1;
  }
  return advanced;
}

/** Persist the full market snapshot the moment an entry/exit fills. */
function persistMarketSnapshot(id: number | undefined, kind: "entry" | "exit", snap: MarketSnap, entryNote?: string): void {
  if (id == null) return;
  const db = getDb();
  const c = snap.contract;
  if (kind === "entry") {
    db.prepare(
      `UPDATE paper_trades SET entry_bid=?, entry_ask=?, entry_spread_pct=?, entry_iv=?, entry_delta=?,
         entry_gamma=?, entry_theta=?, entry_vega=?, entry_oi=?, entry_volume=?, entry_reason=COALESCE(?, entry_reason)
       WHERE id=?`,
    ).run(c.bid, c.ask, c.spreadPct, c.iv, c.delta, c.gamma, c.theta, c.vega, c.openInterest, c.volume, entryNote ?? null, id);
  } else {
    db.prepare(
      `UPDATE paper_trades SET exit_bid=?, exit_ask=?, exit_spread_pct=? WHERE id=?`,
    ).run(c.bid, c.ask, c.spreadPct, id);
  }
}

// ── Autonomous entry (PAPER_AUTO_ENTRY=1) ───────────────────────────────────
// Every fresh TRADE-tier options callout becomes a paper trade automatically.
// This is deliberately deterministic — no AI in the entry loop. The risk
// engine is the gatekeeper: over-limit / 0DTE-when-disabled / averaging-down
// proposals are refused and the refusal is logged, which is the risk engine
// doing its job, not a bug. NOTE: the live scanner's TRADE callouts are 0DTE,
// so full autonomy on them also requires PAPER_ALLOW_ZERO_DTE=1.
const AUTO_ENTRY_ENABLED = () => process.env.PAPER_AUTO_ENTRY === "1";
const AUTO_ENTRY_MAX_AGE_MS = Number(process.env.PAPER_AUTO_ENTRY_MAX_AGE_MS ?? 10 * 60_000);

export function autoEnterFromAlerts(nowMs: number = Date.now()): number {
  if (!AUTO_ENTRY_ENABLED()) return 0;
  // When the Supervisor is the canonical path, the Supervisor→paper bridge is the
  // SINGLE authoritative paper-entry path. This legacy path (which papers straight
  // from the `alerts` table, deduped only on alert_id) must stand down or the same
  // real setup would be papered twice — once from the alert, once from the callout.
  if (legacyPaperAutoEntrySuppressed()) return 0;
  const db = getDb();
  // Fresh TRADE-tier options callouts with a contract, not already papered.
  const candidates = db.prepare(
    `SELECT a.id FROM alerts a
     WHERE a.capture_action = 'TRADE'
       AND a.option_symbol IS NOT NULL
       AND a.asset_class != 'stock'
       AND a.alert_time >= ?
       AND NOT EXISTS (SELECT 1 FROM paper_trades p WHERE p.alert_id = a.id)
     ORDER BY a.id ASC LIMIT 5`,
  ).all(new Date(nowMs - AUTO_ENTRY_MAX_AGE_MS).toISOString()) as any[];

  let created = 0;
  for (const row of candidates) {
    const result = createPaperTrade({ alertId: row.id });
    if (result.ok) {
      created += 1;
      console.log(`[paper] auto-entry: trade #${result.id} from alert #${row.id}`);
    } else {
      console.log(`[paper] auto-entry refused for alert #${row.id}: ${result.risk.failures.join("; ")}`);
      if (isPermanentAutoEntryRefusal(result.risk.failures)) {
        // Permanent input/policy failures are marked once. Temporary risk/capacity
        // conditions are only decision-logged and retried until the entry window closes.
        db.prepare(
          `INSERT INTO paper_trades (alert_id, ticker, option_type, contracts, status, exit_reason, created_at_ms)
           SELECT id, ticker, LOWER(COALESCE(option_side,'call')), 1, 'CANCELLED', ?, ? FROM alerts WHERE id=?`,
        ).run(`auto-entry permanently refused: ${result.risk.failures.join("; ")}`, nowMs, row.id);
      }
    }
  }
  return created;
}

function currentTapeRow(ticker: string): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loopState } = require("@/lib/scanner-loop");
    return (loopState().tape ?? loopState().movers ?? []).find((r: any) => r.symbol === ticker) ?? null;
  } catch {
    return null;
  }
}

function latestStockPaperPrice(ticker: string): number | null {
  const tape = currentTapeRow(ticker);
  const tapePrice = Number(tape?.price ?? 0);
  if (Number.isFinite(tapePrice) && tapePrice > 0) return tapePrice;
  try {
    const row = getDb().prepare(
      `SELECT price_at_alert FROM alerts
       WHERE ticker=? AND asset_class='stock' AND price_at_alert IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    ).get(ticker) as any;
    const alertPrice = Number(row?.price_at_alert ?? 0);
    return Number.isFinite(alertPrice) && alertPrice > 0 ? alertPrice : null;
  } catch {
    return null;
  }
}

function stockSideFromAlert(a: any): "call" | "put" {
  return a.trade_bias === "stock_short_candidate" || a.direction === "bearish" ? "put" : "call";
}

/** Build a verified two-sided stock quote from the freshest tape row (real NBBO). */
function stockQuoteFrom(ticker: string, nowMs: number): OptionQuote | null {
  const tape = currentTapeRow(ticker);
  if (!tape) return null;
  const bid = typeof tape.bid === "number" ? tape.bid : null;
  const ask = typeof tape.ask === "number" ? tape.ask : null;
  const asOfMs = normalizeProviderTimestampMs(tape.quoteProviderTimestamp, nowMs) ?? nowMs;
  const mid = bid != null && ask != null ? +(((bid + ask) / 2)).toFixed(4) : null;
  const spreadPct = bid != null && ask != null && mid && mid > 0 ? +(((ask - bid) / mid) * 100).toFixed(2) : null;
  return { optionSymbol: ticker, bid, ask, mid, spreadPct, asOfMs };
}

/** Extended-hours stock entries only when explicitly permitted (Decision 7). */
function stockExtendedHoursAllowed(): boolean {
  return process.env.PAPER_STOCK_EXTENDED_HOURS === "1";
}

function stockPaperShares(price: number, stopLossPct: number): number {
  const targetShares = unitsForDollarExposure({
    entryPrice: price,
    minPositionDollars: paperMinPositionDollars(),
    multiplier: 1,
  });
  if (paperExperimentalOversize()) return targetShares;

  const riskCfg = defaultRiskConfig();
  const riskShares = Math.floor(riskCfg.maxRiskPerTrade / Math.max(0.01, price * (stopLossPct / 100)));
  const exposureShares = Math.floor(riskCfg.maxExposurePerTicker / Math.max(0.01, price));
  return Math.max(1, Math.min(riskShares, exposureShares));
}

const STOCK_STRATEGY = "momentum_stock";

/** Terminal refusal marker keyed to the alert (blocks re-evaluation), with events. */
function markStockRefused(a: any, side: "call" | "put", shares: number, reason: string, nowMs: number): void {
  const info = getDb().prepare(
    `INSERT INTO paper_trades (alert_id, ticker, option_type, contracts, status, order_state, strategy, exit_reason, close_reason, created_at_ms)
     VALUES (?,?,?,?, 'CANCELLED', 'REJECTED', ?, ?, ?, ?)`,
  ).run(a.id, a.ticker, side, shares, STOCK_STRATEGY, reason, reason, nowMs);
  emitEvents(Number(info.lastInsertRowid), a.id, a.ticker, ["candidate_created", "rejected"], { toState: "REJECTED", reason, nowMs });
}

export function autoEnterStockScalps(nowMs: number = Date.now()): number {
  if (!AUTO_ENTRY_ENABLED()) return 0;
  if (process.env.PAPER_STOCK_SCALPS === "0") return 0;
  const session = marketSession(nowMs);
  if (!PAPER_STOCK_SESSIONS().has(session)) return 0;
  const extended = session === "premarket" || session === "afterhours";
  const sessionAllowed = !extended || stockExtendedHoursAllowed(); // Decision 7
  const db = getDb();
  const candidates = db.prepare(
    `SELECT a.* FROM alerts a
     WHERE a.capture_action = 'TRADE'
       AND a.asset_class = 'stock'
       AND a.alert_time >= ?
       AND NOT EXISTS (SELECT 1 FROM paper_trades p WHERE p.alert_id = a.id)
     ORDER BY a.id ASC LIMIT 5`,
  ).all(new Date(nowMs - AUTO_ENTRY_MAX_AGE_MS).toISOString()) as any[];

  let created = 0;
  const stockCfg = stockGateConfig();
  for (const a of candidates) {
    const tape = currentTapeRow(a.ticker);
    const side = stockSideFromAlert(a);
    // Reference price for sizing/exposure only — the FILL uses the verified quote.
    const refPrice = Number(latestStockPaperPrice(a.ticker) ?? a.price_at_alert ?? 0);
    // ANTI-CHASE: the SAME extension gate the Discord path uses, so an already-run
    // move is never paper-traded either (long-only; day-run from the alert's stored
    // day move). Terminal-marked so it is not retried all window.
    const chase = stockExtensionReason(
      { price: Number.isFinite(refPrice) && refPrice > 0 ? refPrice : (a.price_at_alert ?? null), vwap: null, dayChangePct: a.percent_move_at_alert ?? null },
      stockCfg,
    );
    if (chase) {
      logDecision({ alertId: a.id, ticker: a.ticker, decision: "entry_cancelled", allowed: false, reason: `stock scalp anti-chase: ${chase}`, nowMs });
      markStockRefused(a, side, stockPaperShares(Number.isFinite(refPrice) && refPrice > 0 ? refPrice : 1, STOCK_SCALP_STOP_PCT), `stock scalp refused: ${chase}`, nowMs);
      continue;
    }
    if (!Number.isFinite(refPrice) || refPrice <= 0) {
      logDecision({ alertId: a.id, ticker: a.ticker, decision: "entry_cancelled", allowed: false, reason: "stock scalp skipped: no live/share price available", nowMs });
      continue; // transient — retry within the entry window (no terminal marker)
    }
    const shares = stockPaperShares(refPrice, STOCK_SCALP_STOP_PCT);

    const fresh = actionableFreshness(a.ticker, ["stock_quote"]);
    if (!fresh.ok) {
      logDecision({ alertId: a.id, ticker: a.ticker, decision: "data_stale_refused", allowed: false, reason: `stale/unavailable data blocks stock paper entry: ${fresh.reason}`, snapshot: fresh, nowMs });
      markStockRefused(a, side, shares, `stock scalp refused: stale/unavailable data (${fresh.reason})`, nowMs);
      continue;
    }

    const proposed: ProposedTrade = { ticker: a.ticker, optionType: side, dte: null, entryLimit: refPrice, contracts: shares, stopLossPct: STOCK_SCALP_STOP_PCT, assetClass: "stock" };
    const risk = checkRisk(proposed, riskContext(), riskConfigForProposed(proposed));
    if (!risk.allowed) {
      logDecision({ alertId: a.id, ticker: a.ticker, decision: "risk_refused", allowed: false, reason: risk.failures.join("; "), risk, snapshot: proposed, nowMs });
      markStockRefused(a, side, shares, `stock scalp refused: ${risk.failures.join("; ")}`, nowMs);
      continue;
    }

    // Capital / buying-power gate (rebuild) — composed with the risk engine.
    const capital = checkCapital({ ticker: a.ticker, optionSymbol: null, strategy: STOCK_STRATEGY, costDollars: refPrice * shares, units: shares }, capitalContext());
    if (!capital.allowed) {
      logDecision({ alertId: a.id, ticker: a.ticker, decision: "capital_refused", allowed: false, reason: capital.failures.join("; "), snapshot: { costDollars: refPrice * shares }, nowMs });
      markStockRefused(a, side, shares, `stock scalp refused: ${capital.failures.join("; ")}`, nowMs);
      continue;
    }

    // Verified conservative fill — never the tape last as a guaranteed fill.
    const quote = stockQuoteFrom(a.ticker, nowMs);
    if (!quote) {
      logDecision({ alertId: a.id, ticker: a.ticker, decision: "entry_cancelled", allowed: false, reason: "stock scalp waiting: no tape quote yet", nowMs });
      continue; // transient — retry within the window
    }
    const decision = decideStockEntry({ side, sessionAllowed, quote, shares, session, fillCfg: fillCfg(), nowMs });

    if (decision.action === "retry") {
      logDecision({ alertId: a.id, ticker: a.ticker, decision: "entry_cancelled", allowed: false, reason: decision.reason, snapshot: { bid: quote.bid, ask: quote.ask }, nowMs });
      continue; // no terminal marker — a transiently unfillable quote may tighten
    }
    if (decision.action === "reject" || decision.fillPrice == null) {
      logDecision({ alertId: a.id, ticker: a.ticker, decision: "entry_rejected", allowed: false, reason: decision.reason, snapshot: { side, bid: quote.bid, ask: quote.ask }, nowMs });
      markStockRefused(a, side, shares, `stock scalp rejected: ${decision.reason}`, nowMs);
      continue;
    }

    // FILL — open at the conservative fill price (ask + bounded slippage), long only.
    const fillPrice = decision.fillPrice;
    const alertTimeContract: AlertTimeContract = { optionSymbol: "", side, strike: null, expiration: null, dte: null, mid: refPrice, spreadPct: quote.spreadPct, delta: null };
    const info = db.prepare(
      `INSERT INTO paper_trades
         (alert_id, ticker, option_symbol, option_type, contracts, status, order_state, position_state,
          thesis, confidence, entry_limit, entry_price, entry_at_ms, stop_loss_pct, take_profit_pct,
          short_rate_entry, above_vwap_entry, rel_vol_entry, last_mark, last_mark_at_ms,
          mfe_pct, mae_pct, created_at_ms,
          strategy, alert_time_contract_json, risk_amount, snapshot_version,
          entry_slippage, entry_fees, fill_assumptions_json, underlying_at_entry, session_at_entry)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      a.id, a.ticker, null, side, shares, "ENTERED", "FILLED", "OPEN",
      a.ai_explanation ?? `Fast stock paper scalp from ${a.ticker} long alert`,
      a.capture_confidence ?? a.signal_score ?? null,
      refPrice, fillPrice, nowMs, STOCK_SCALP_STOP_PCT, STOCK_SCALP_TAKE_PROFIT_PCT,
      a.short_rate_at_alert ?? tape?.shortRate ?? null,
      a.above_vwap == null ? null : (a.above_vwap ? 1 : 0),
      a.relative_volume ?? tape?.relVol ?? null,
      quote.mid ?? fillPrice, nowMs, 0, 0, nowMs,
      STOCK_STRATEGY, JSON.stringify(alertTimeContract), dollarsAtRisk(refPrice, shares, STOCK_SCALP_STOP_PCT, 1), 1,
      decision.slippage, decision.fees, decision.assumptions ? JSON.stringify(decision.assumptions) : null,
      quote.mid ?? fillPrice, session,
    );
    const id = Number(info.lastInsertRowid);
    freezePaperFingerprintForTrade(id, nowMs); // freeze setup fingerprint at the verified stock fill
    emitEvents(id, a.id, a.ticker, ["candidate_created", ...decision.events], { toState: "OPEN", reason: decision.reason, nowMs });
    logDecision({
      tradeId: id, alertId: a.id, ticker: a.ticker, decision: "entry_filled", allowed: true,
      reason: `auto stock scalp entered LONG ${shares} share(s) at ${fillPrice.toFixed(2)} (ask+slip, verified quote)`,
      risk, snapshot: { assetClass: "stock", side: "LONG", fillPrice, refPrice, shares, slippage: decision.slippage, fees: decision.fees, session }, nowMs,
    });
    created += 1;
  }
  return created;
}

function advanceStockScalps(nowMs: number = Date.now()): number {
  const db = getDb();
  const session = marketSession(nowMs);
  const rows = db.prepare(
    "SELECT * FROM paper_trades WHERE option_symbol IS NULL AND status='ENTERED' ORDER BY id ASC",
  ).all() as any[];
  let advanced = 0;
  for (const row of rows) {
    const t = rowToTrade(row);
    if (t.entryPrice == null) continue;
    const tape = currentTapeRow(t.ticker);
    const quote = stockQuoteFrom(t.ticker, nowMs);

    // A stale/missing mark keeps the position OPEN — no fabricated exit.
    const markDecision = decideMark(quote, fillCfg(), nowMs);
    if (!markDecision.markable || markDecision.mark == null) {
      emitEvents(t.id, t.alertId ?? null, t.ticker, [markDecision.event], { reason: markDecision.note, discriminator: Math.floor(nowMs / 60_000), nowMs });
      continue;
    }

    // Long only (Decision 8): mark move is measured directly from the mid.
    const mark = markDecision.mark;
    const movePct = ((mark - t.entryPrice) / t.entryPrice) * 100;
    const marked: PaperTrade = { ...t, lastMark: mark, lastMarkAtMs: nowMs, mfePct: Math.max(t.mfePct ?? 0, movePct), maePct: Math.min(t.maePct ?? 0, movePct) };
    const speed = Number(tape?.shortRate ?? NaN);
    const maxHold = nowMs - (t.entryAtMs ?? t.createdAtMs) >= STOCK_SCALP_MAX_HOLD_MS;

    const exit = evaluateStockExit({
      movePct,
      stopPct: t.stopLossPct ?? STOCK_SCALP_STOP_PCT,
      targetPct: t.takeProfitPct ?? STOCK_SCALP_TAKE_PROFIT_PCT,
      speed: Number.isFinite(speed) ? speed : null,
      maxHold,
      maxHoldMinutes: Math.round(STOCK_SCALP_MAX_HOLD_MS / 60000),
    });

    if (exit.kind) {
      const exitFill = resolveStockExitFill({ quote: quote as OptionQuote, shares: t.contracts, session, fillCfg: fillCfg(), nowMs });
      if (exitFill.unresolved) {
        // Exit is warranted but no usable quote to fill against — keep open.
        emitEvents(t.id, t.alertId ?? null, t.ticker, ["mark_missing"], { reason: exitFill.note, discriminator: Math.floor(nowMs / 60_000), nowMs });
        persist(marked);
        continue;
      }
      const closed = applyExit(marked, { kind: exit.kind, reason: exit.reason, fillPrice: exitFill.fillPrice }, nowMs);
      persist(closed);
      persistFillCosts(t.id, "exit", exitFill.slippage, exitFill.fees, exitFill.assumptions, { closeReason: `${exit.kind}: ${exit.reason}` });
      emitEvents(t.id, t.alertId ?? null, t.ticker, [EXIT_EVENT[exit.kind], "final_outcome"], { fromState: "OPEN", toState: derivePositionState(closed.status), reason: exit.reason, nowMs });
      logDecision({ tradeId: t.id, alertId: t.alertId ?? null, ticker: t.ticker, decision: `exit_${exit.kind}`, allowed: true, reason: exit.reason, snapshot: { assetClass: "stock", fillPrice: exitFill.fillPrice, movePct, shares: t.contracts, speed, slippage: exitFill.slippage, fees: exitFill.fees }, nowMs });
      advanced += 1;
    } else {
      persist(marked);
    }
  }
  return advanced;
}

export async function sweepPaperTrades(nowMs: number = Date.now()): Promise<{ advanced: number; fetched: number }> {
  // Idempotent: freeze fingerprints for any filled trade missing one and grade
  // any filled+terminal trade into the authoritative outcome layer. Restart-safe
  // (guarded by fingerprint_id IS NULL and a UNIQUE(paper_trade_id) outcome row).
  try { syncPaperOutcomes(nowMs); } catch (err: any) { console.warn("[paper] outcome sync failed:", err?.message); }
  try { autoEnterFromAlerts(nowMs); } catch (err: any) { console.warn("[paper] auto-entry failed:", err?.message); }
  try { autoEnterStockScalps(nowMs); } catch (err: any) { console.warn("[paper] stock auto-entry failed:", err?.message); }
  const stockAdvanced = advanceStockScalps(nowMs);
  const active = openTrades().filter((t) => t.status === "READY" || t.status === "ENTERED");
  const optionActive = active.filter((t) => t.optionSymbol);
  if (!optionActive.length) return { advanced: stockAdvanced, fetched: 0 };

  const session = marketSession(nowMs);
  // Options quotes only exist while the market trades them.
  if (session !== "regular") {
    // Still handle expirations (weekend/overnight expiry). Settle at intrinsic
    // from a best-effort underlying; with no fresh underlying, resolveExitFill
    // falls back to the last mark (documented — never fabricated).
    let advanced = 0;
    for (const t of optionActive.filter((x) => x.status === "ENTERED")) {
      const { checkExpiration } = await import("@/lib/paper-exits");
      const exp = checkExpiration(t, nowMs);
      if (!exp) continue;
      const tapePrice = Number(currentTapeRow(t.ticker)?.price ?? NaN);
      const underlying = Number.isFinite(tapePrice) && tapePrice > 0 ? tapePrice : null;
      const staleQuote: OptionQuote = { optionSymbol: t.optionSymbol ?? "", bid: null, ask: null, mid: null, spreadPct: null, asOfMs: nowMs };
      const exitFill = resolveExitFill({ decision: exp, trade: t, quote: staleQuote, underlying, session, fillCfg: fillCfg(), nowMs });
      const closed = applyExit(t, { ...exp, fillPrice: exitFill.fillPrice }, nowMs);
      persist(closed);
      persistFillCosts(t.id, "exit", exitFill.slippage, exitFill.fees, exitFill.assumptions, { closeReason: `expired: ${exitFill.note}` });
      emitEvents(t.id, t.alertId ?? null, t.ticker, ["expiration", "final_outcome"], { fromState: "OPEN", toState: "EXPIRED", reason: exitFill.note, nowMs });
      advanced++;
    }
    return { advanced: advanced + stockAdvanced, fetched: 0 };
  }

  if (nearMinuteBudget(getCallStats(nowMs))) return { advanced: stockAdvanced, fetched: 0 };

  // One chain fetch covers all trades on the same underlying.
  const byTicker = new Map<string, PaperTrade[]>();
  for (const t of optionActive) byTicker.set(t.ticker, [...(byTicker.get(t.ticker) ?? []), t]);
  const tickers = [...byTicker.keys()].slice(0, MAX_FETCHES_PER_SWEEP);

  let advanced = 0, fetched = 0;
  for (const ticker of tickers) {
    const trades = byTicker.get(ticker) ?? [];
    // ONE chain fetch covers every trade on the underlying (bug fix: trades on
    // different contracts of the same ticker previously starved).
    const chain: any = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 60, maxPages: 2 });
    fetched += 1;
    if (!chain?.available) continue;
    for (const t of trades) {
      const snap = snapFromContracts(chain.contracts, t.optionSymbol);
      if (snap && advanceOpenTrade(t, snap, chain.contracts, nowMs)) advanced += 1;
    }
  }
  return { advanced: advanced + stockAdvanced, fetched };
}

// ── Background engine ────────────────────────────────────────────────────────

type G = typeof globalThis & { __optiscanPaperEngine?: { running: boolean; lastSweepAt: number; sweeps: number; errors: number } };

function paperEngineRuntimeState() {
  const g = globalThis as G;
  g.__optiscanPaperEngine ??= { running: false, lastSweepAt: 0, sweeps: 0, errors: 0 };
  return g.__optiscanPaperEngine;
}

export function paperEngineState() {
  const state = paperEngineRuntimeState();
  const risk = defaultRiskConfig();
  const experimentalPositionDollars = paperMinPositionDollars();
  const targetProfitDollars = paperTargetProfitDollars();
  return {
    ...state,
    autoEntryEnabled: process.env.PAPER_AUTO_ENTRY === "1",
    allowZeroDte: process.env.PAPER_ALLOW_ZERO_DTE === "1",
    session: marketSession(),
    stockSessions: [...PAPER_STOCK_SESSIONS()],
    stockPaperScalpsEnabled: process.env.PAPER_STOCK_SCALPS !== "0",
    experimentalOversize: paperExperimentalOversize(),
    experimentalPositionDollars,
    targetProfitDollars,
    sweepMs: SWEEP_MS,
    risk,
  };
}

export function startPaperEngine(): void {
  const s = paperEngineRuntimeState();
  if (s.running) return;
  if (process.env.PAPER_TRADING_ENABLED === "0") { console.log("[paper] disabled (PAPER_TRADING_ENABLED=0)"); return; }
  s.running = true;
  const beat = async () => {
    try {
      const r = await sweepPaperTrades();
      s.lastSweepAt = Date.now();
      s.sweeps += 1;
      if (r.advanced) console.log(`[paper] sweep advanced ${r.advanced} trade(s) (${r.fetched} quote fetches)`);
    } catch (err: any) {
      s.errors += 1;
      console.warn("[paper] sweep failed:", err?.message);
    }
    const t = setTimeout(beat, SWEEP_MS);
    (t as any)?.unref?.();
  };
  beat();
  console.log(`[paper] engine running every ${SWEEP_MS}ms (limit-sim, no broker)`);
}
