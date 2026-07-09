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
import { marketSession } from "@/lib/trading-session";
import {
  evaluateEntry, markToMarket, applyExit, pnlDollars, pnlPct, lessonsLearned,
  TERMINAL_STATES, type PaperTrade, type PaperState,
} from "@/lib/paper-trading";
import { evaluateExit, defaultExitConfig, type LiveTapeSnapshot, type EntryThesisSnapshot } from "@/lib/paper-exits";
import { checkRisk, defaultRiskConfig, type ProposedTrade, type RiskContext, type RiskVerdict } from "@/lib/paper-risk";
import type { OptionQuote } from "@/lib/execution/broker";

const SWEEP_MS = Number(process.env.PAPER_SWEEP_MS ?? 30_000);
const MAX_FETCHES_PER_SWEEP = Number(process.env.PAPER_SWEEP_MAX_FETCHES ?? 5);

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

function persist(trade: PaperTrade): void {
  const db = getDb();
  db.prepare(
    `UPDATE paper_trades SET
       status=?, entry_price=?, entry_at_ms=?, exit_price=?, exit_at_ms=?, exit_reason=?,
       mfe_pct=?, mae_pct=?, last_mark=?, last_mark_at_ms=?, lessons=COALESCE(?, lessons)
     WHERE id=?`,
  ).run(
    trade.status, trade.entryPrice, trade.entryAtMs, trade.exitPrice, trade.exitAtMs, trade.exitReason,
    trade.mfePct, trade.maePct, trade.lastMark, trade.lastMarkAtMs,
    TERMINAL_STATES.has(trade.status) && trade.entryPrice != null ? lessonsLearned(trade) : null,
    trade.id,
  );
}

export function listPaperTrades(limit = 200): Array<PaperTrade & {
  unrealizedPnlDollars: number | null;
  unrealizedPnlPct: number | null;
  entrySnapshot: Record<string, number | string | null>;
}> {
  const db = getDb();
  return (db.prepare("SELECT * FROM paper_trades ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => {
    const t = rowToTrade(r);
    const live = t.status === "ENTERED" && t.entryPrice != null && t.lastMark != null;
    return {
      ...t,
      // Unrealized P/L updates every sweep from the live mark — exactly what a
      // broker position screen would show.
      unrealizedPnlDollars: live ? +(((t.lastMark as number) - (t.entryPrice as number)) * 100 * t.contracts).toFixed(2) : null,
      unrealizedPnlPct: live ? +((((t.lastMark as number) - (t.entryPrice as number)) / (t.entryPrice as number)) * 100).toFixed(2) : null,
      entrySnapshot: {
        bid: r.entry_bid ?? null, ask: r.entry_ask ?? null, spreadPct: r.entry_spread_pct ?? null,
        iv: r.entry_iv ?? null, delta: r.entry_delta ?? null, gamma: r.entry_gamma ?? null,
        theta: r.entry_theta ?? null, vega: r.entry_vega ?? null,
        openInterest: r.entry_oi ?? null, volume: r.entry_volume ?? null,
        entryReason: r.entry_reason ?? null,
      },
    };
  });
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
  const weekMs = Date.now() - 7 * 24 * 3600_000;
  const realized = (sinceMs: number): number => {
    const rows = db.prepare(
      `SELECT entry_price, exit_price, contracts FROM paper_trades
       WHERE exit_at_ms >= ? AND entry_price IS NOT NULL AND exit_price IS NOT NULL`,
    ).all(sinceMs) as any[];
    return rows.reduce((s, r) => s + (r.exit_price - r.entry_price) * 100 * (r.contracts ?? 1), 0);
  };
  return {
    openTrades: openTrades(),
    realizedTodayDollars: realized(dayMs),
    realizedWeekDollars: realized(weekMs),
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

  const exitCfg = defaultExitConfig();
  const proposed: ProposedTrade = {
    ticker: base.ticker,
    optionType: base.optionType ?? "call",
    dte: base.dte ?? null,
    entryLimit: base.entryLimit,
    contracts: base.contracts ?? 1,
    stopLossPct: base.stopLossPct ?? exitCfg.stopLossPct,
  };
  const risk = checkRisk(proposed, riskContext(), defaultRiskConfig());
  if (!risk.allowed) return { ok: false, risk };

  const nowMs = Date.now();
  const info = db.prepare(
    `INSERT INTO paper_trades
       (alert_id, ticker, option_symbol, option_type, strike, expiration, dte_at_entry, contracts,
        status, thesis, confidence, entry_limit, stop_loss_pct, take_profit_pct,
        short_rate_entry, above_vwap_entry, rel_vol_entry, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    base.alertId ?? null, base.ticker, base.optionSymbol, proposed.optionType,
    base.strike ?? null, base.expiration ?? null, base.dte ?? null, proposed.contracts,
    "READY", base.thesis ?? null, confidence, base.entryLimit,
    proposed.stopLossPct, base.takeProfitPct ?? exitCfg.takeProfitPct,
    thesisSnapshot.shortRate, thesisSnapshot.aboveVwap == null ? null : (thesisSnapshot.aboveVwap ? 1 : 0),
    thesisSnapshot.relVol, nowMs,
  );
  return { ok: true, id: Number(info.lastInsertRowid), risk, note: "entry limit order active (READY)" };
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
    return { ok: true, note: "cancelled" };
  }
  if (trade.status !== "ENTERED") return { ok: false, note: `cannot close a ${trade.status} trade` };
  const mark = trade.lastMark ?? trade.entryPrice ?? 0;
  const closed = applyExit(trade, { kind: "manual", reason: `closed by user at last mark ${mark.toFixed(2)}`, fillPrice: mark }, Date.now());
  persist(closed);
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

async function quoteFor(trade: PaperTrade): Promise<MarketSnap | null> {
  if (!trade.optionSymbol) return null;
  const chain: any = await fetchOptionChain(trade.ticker, { dteMin: 0, dteMax: 60, maxPages: 2 });
  if (!chain?.available) return null;
  const c = chain.contracts.find((x: any) => x.optionSymbol === trade.optionSymbol);
  if (!c) return null;
  return {
    quote: { optionSymbol: c.optionSymbol, bid: c.bid, ask: c.ask, mid: c.mid, spreadPct: c.spreadPct, asOfMs: Date.now() },
    contract: c,
  };
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

export async function sweepPaperTrades(nowMs: number = Date.now()): Promise<{ advanced: number; fetched: number }> {
  const active = openTrades().filter((t) => t.status === "READY" || t.status === "ENTERED");
  if (!active.length) return { advanced: 0, fetched: 0 };

  // Options quotes only exist while the market trades them.
  if (marketSession(nowMs) !== "regular") {
    // Still handle expirations from last marks (weekend/overnight expiry).
    let advanced = 0;
    for (const t of active.filter((x) => x.status === "ENTERED")) {
      const { checkExpiration } = await import("@/lib/paper-exits");
      const exp = checkExpiration(t, nowMs);
      if (exp) { persist(applyExit(t, exp, nowMs)); advanced++; }
    }
    return { advanced, fetched: 0 };
  }

  if (nearMinuteBudget(getCallStats(nowMs))) return { advanced: 0, fetched: 0 };

  // One chain fetch covers all trades on the same underlying.
  const byTicker = new Map<string, PaperTrade[]>();
  for (const t of active) byTicker.set(t.ticker, [...(byTicker.get(t.ticker) ?? []), t]);
  const tickers = [...byTicker.keys()].slice(0, MAX_FETCHES_PER_SWEEP);

  let advanced = 0, fetched = 0;
  for (const ticker of tickers) {
    const trades = byTicker.get(ticker) ?? [];
    const first = trades[0];
    const snap0 = await quoteFor(first);
    fetched += 1;
    for (const t of trades) {
      // Reuse the fetched chain result per ticker: quoteFor re-fetches, so
      // only the first trade triggers I/O per sweep tick; others use marks.
      const snap = t === first ? snap0 : (t.optionSymbol === first.optionSymbol ? snap0 : null);
      if (!snap) continue;
      const quote = snap.quote;
      if (t.status === "READY") {
        const r = evaluateEntry(t, quote, nowMs);
        if (r.event !== "waiting") {
          persist(r.trade);
          if (r.event === "filled") persistMarketSnapshot(t.id, "entry", snap, `filled: ${r.note}`);
          advanced++;
        }
        continue;
      }
      // ENTERED: mark, then exits.
      let marked = markToMarket(t, quote, nowMs);
      const live = liveSnapshotFor(ticker);
      const liveWithSpread = live ? { ...live, spreadPct: quote.spreadPct } : null;
      const entrySnap: EntryThesisSnapshot = {
        shortRateAtEntry: (t as any).shortRateEntry ?? null,
        aboveVwapAtEntry: null,
        relVolAtEntry: null,
      };
      // pull thesis snapshot from DB row fields
      const db = getDb();
      const row = db.prepare("SELECT short_rate_entry, above_vwap_entry, rel_vol_entry FROM paper_trades WHERE id=?").get(t.id) as any;
      if (row) {
        entrySnap.shortRateAtEntry = row.short_rate_entry ?? null;
        entrySnap.aboveVwapAtEntry = row.above_vwap_entry == null ? null : Boolean(row.above_vwap_entry);
        entrySnap.relVolAtEntry = row.rel_vol_entry ?? null;
      }
      const exit = evaluateExit(marked, quote, liveWithSpread, entrySnap, nowMs, defaultExitConfig());
      if (exit) {
        marked = applyExit(marked, exit, nowMs);
        persistMarketSnapshot(t.id, "exit", snap);
      }
      persist(marked);
      advanced++;
    }
  }
  return { advanced, fetched };
}

// ── Background engine ────────────────────────────────────────────────────────

type G = typeof globalThis & { __optiscanPaperEngine?: { running: boolean; lastSweepAt: number; sweeps: number; errors: number } };

export function paperEngineState() {
  const g = globalThis as G;
  g.__optiscanPaperEngine ??= { running: false, lastSweepAt: 0, sweeps: 0, errors: 0 };
  return g.__optiscanPaperEngine;
}

export function startPaperEngine(): void {
  const s = paperEngineState();
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
