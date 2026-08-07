/**
 * lib/research/options/paper.ts — REAL-OPTION paper execution for the independent Options scanner.
 * PURE builders + OnDb persist. Separate from equity paper (paper_trades). Calls and puts are BOTH
 * paper-traded and graded; public PUT delivery is controlled by bearish authority flags. Fills are executable
 * and CONSERVATIVE (never a naive mid when the spread/liquidity doesn't support it). P&L is computed
 * from the OPTION contract price, never the underlying. HARD no-op unless REAL_OPTION_PAPER_ENABLED=1.
 */
import { researchFlags } from "../flags.ts";
import { classifyPaperResult, realOptionEntryEligible, defaultRealOptionEntryGate, type PaperResultClass } from "./paper-class.ts";
import { dualWriteAfterOptionsPaperEntry } from "../../broker/dual-write.ts";
import type { BrokerDb } from "../../broker/audit.ts";

export interface OptionQuote { optionSymbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number; bid: number | null; ask: number | null; volume: number | null; openInterest: number | null; iv: number | null; delta: number | null; quoteAgeMs: number | null; providerTimestamp: number | null }

export interface RealOptionEntry {
  ok: boolean; rejections: string[];
  optionSymbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number;
  bid: number; ask: number; mid: number; spreadPct: number; entryFill: number;   // conservative executable fill
  volume: number | null; openInterest: number | null; iv: number | null; delta: number | null;
  underlyingPrice: number; strategy: string; target: number | null; invalidation: number | null;
  provenance: string; class: PaperResultClass;
}

/** Conservative long-option entry: pay toward the ASK (fraction of the spread), scaled by width — a
 *  wide/illiquid contract fills worse. Never a naive mid. Returns the executable fill. */
export function conservativeEntryFill(bid: number, ask: number, opts: { slipFraction?: number } = {}): number {
  const mid = (bid + ask) / 2;
  const slip = Math.min(1, Math.max(0, opts.slipFraction ?? 0.6)); // 60% of the way from mid → ask
  return +(mid + (ask - mid) * slip).toFixed(4);
}

export interface BuildEntryInput { quote: OptionQuote; underlyingPrice: number; strategy: string; target?: number | null; invalidation?: number | null; provenance?: string }
export function buildRealOptionEntry(input: BuildEntryInput, env: NodeJS.ProcessEnv = process.env): RealOptionEntry {
  const q = input.quote;
  const gate = realOptionEntryEligible({ optionSymbol: q.optionSymbol, bid: q.bid, ask: q.ask, spreadPct: spreadPct(q.bid, q.ask), quoteAgeMs: q.quoteAgeMs, openInterest: q.openInterest, volume: q.volume }, defaultRealOptionEntryGate(env));
  const bid = q.bid ?? 0, ask = q.ask ?? 0, mid = +(((bid + ask) / 2)).toFixed(4);
  const sp = spreadPct(q.bid, q.ask) ?? 0;
  const entryFill = gate.ok ? conservativeEntryFill(bid, ask) : mid;
  const cls = classifyPaperResult({ optionSymbol: q.optionSymbol, entryBid: q.bid, entryAsk: q.ask, pnlBasis: "option", outcomeKind: "REAL" });
  return {
    ok: gate.ok, rejections: gate.rejections,
    optionSymbol: q.optionSymbol, side: q.side, strike: q.strike, expiration: q.expiration, dte: q.dte,
    bid, ask, mid, spreadPct: +sp.toFixed(3), entryFill,
    volume: q.volume, openInterest: q.openInterest, iv: q.iv, delta: q.delta,
    underlyingPrice: input.underlyingPrice, strategy: input.strategy, target: input.target ?? null, invalidation: input.invalidation ?? null,
    provenance: input.provenance ?? "polygon:v3/snapshot/options", class: cls.class,
  };
}

/** Exit at a conservative marketable price (sell toward the BID) and compute option P&L (×100). */
export function realOptionExit(entryFill: number, exitBid: number, exitAsk: number, contracts = 1): { exitFill: number; pnlPerContract: number; pnl: number; returnPct: number } {
  const mid = (exitBid + exitAsk) / 2;
  const exitFill = +(mid - (mid - exitBid) * 0.6).toFixed(4); // 60% toward the bid (conservative sell)
  const pnlPerContract = +((exitFill - entryFill) * 100).toFixed(4);
  return { exitFill, pnlPerContract, pnl: +(pnlPerContract * contracts).toFixed(4), returnPct: entryFill > 0 ? +(((exitFill - entryFill) / entryFill) * 100).toFixed(4) : 0 };
}

function spreadPct(bid: number | null, ask: number | null): number | null { if (bid == null || ask == null) return null; const mid = (bid + ask) / 2; return mid > 0 ? ((ask - bid) / mid) * 100 : null; }

interface PaperDb { prepare(sql: string): { get?: (...a: any[]) => any; run: (...a: any[]) => { changes: number; lastInsertRowid?: number | bigint } } }

/** Audience classification — the STRUCTURAL separator for the AI Research Lab data foundation.
 *  DELIVERED_ALERT_PAPER is the exact mirror of a delivered Discord alert; RESEARCH_ONLY_PAPER is a
 *  shadow/experiment subscribers never see; ZERO_DTE_RESEARCH_PAPER is the Aggressive 0DTE Research
 *  $100k ledger (simulated only); BEARISH_RESEARCH_PAPER is a separately funded, qualified-PUT
 *  research lane. They are never combined in readiness or delivered stats. */
export type PaperKind = "DELIVERED_ALERT_PAPER" | "RESEARCH_ONLY_PAPER" | "ZERO_DTE_RESEARCH_PAPER" | "BEARISH_RESEARCH_PAPER" | "OWNER_VALIDATION_PAPER";
export interface PaperPersistExtra {
  session?: string | null; coreBroad?: string | null; featureSnapshotJson?: string;
  paperKind?: PaperKind; alertId?: string | null; entrySource?: string; experimentId?: string | null; experimentVariant?: string | null;
  thesisFingerprint?: string | null;
}

const PAPER_COLS = "option_symbol, side, strike, expiration, dte, result_class, bid, ask, mid, spread_pct, entry_fill, volume, open_interest, iv, delta, underlying_price, strategy, target, invalidation, provenance, status, session, core_broad, feature_snapshot_json, paper_kind, alert_id, entry_source, experiment_id, experiment_variant, entered_at_ms, created_at_ms, updated_at_ms";
const PAPER_PLACEHOLDERS = PAPER_COLS.split(",").map(() => "?").join(","); // exactly one ? per column
const paperVals = (e: RealOptionEntry, extra: PaperPersistExtra, kind: PaperKind, entrySource: string, nowMs: number, status = "ENTERED"): any[] => [
  e.optionSymbol, e.side, e.strike, e.expiration, e.dte, e.class, e.bid, e.ask, e.mid, e.spreadPct, e.entryFill, e.volume, e.openInterest, e.iv, e.delta, e.underlyingPrice, e.strategy, e.target, e.invalidation, e.provenance, status, extra.session ?? null, extra.coreBroad ?? null, extra.featureSnapshotJson ?? null, kind, extra.alertId ?? null, entrySource, extra.experimentId ?? null, extra.experimentVariant ?? null, nowMs, nowMs, nowMs,
];

/** Persist a real-option paper entry with the decision-time context. FAIL-SAFE: defaults to
 *  RESEARCH_ONLY_PAPER — a trade is NEVER counted as a delivered subscriber mirror unless a caller
 *  explicitly says so (see persistDeliveredMirrorOnDb). Flag-gated OnDb. */
export function persistRealOptionPaperOnDb(
  db: PaperDb,
  e: RealOptionEntry,
  nowMs: number = Date.now(),
  extra: PaperPersistExtra = {},
): number {
  const kind: PaperKind = extra.paperKind ?? "RESEARCH_ONLY_PAPER";
  const entrySource = extra.entrySource ?? (
    kind === "DELIVERED_ALERT_PAPER" ? "discord_delivery"
      : kind === "ZERO_DTE_RESEARCH_PAPER" ? "zero_dte_research"
        : kind === "BEARISH_RESEARCH_PAPER" ? "bearish_research"
        : kind === "OWNER_VALIDATION_PAPER" ? "owner_validation_opening"
        : "monitor_shadow"
  );
  const r = db.prepare(`INSERT INTO options_paper_trades (${PAPER_COLS}) VALUES (${PAPER_PLACEHOLDERS})`).run(...paperVals(e, extra, kind, entrySource, nowMs));
  const tradeId = Number((r as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0);
  if (tradeId > 0) {
    if (extra.thesisFingerprint) {
      try {
        db.prepare(
          "UPDATE options_paper_trades SET thesis_fingerprint=? WHERE id=?",
        ).run(extra.thesisFingerprint, tradeId);
      } catch (error) {
        try {
          db.prepare("DELETE FROM options_paper_trades WHERE id=?").run(tradeId);
        } catch { /* best effort rollback */ }
        throw error;
      }
    }
    try {
      dualWriteAfterOptionsPaperEntry(db as BrokerDb, tradeId);
    } catch { /* dual-write is best-effort; legacy write is authoritative */ }
  }
  return tradeId;
}

/**
 * Create the ONE mirror of a delivered Discord alert. IDEMPOTENT by alert_id: calling it again for the
 * same alert never creates a second DELIVERED_ALERT_PAPER row — so every delivered alert has exactly
 * one linked mirror. Uses the SAME decision timestamp + quote as the alert (no hindsight, no improved
 * entry). Returns whether a mirror now exists (inserted or already existed).
 */
export function persistDeliveredMirrorOnDb(db: PaperDb, e: RealOptionEntry, decisionMs: number, alertId: string, extra: PaperPersistExtra = {}): { inserted: boolean; existed: boolean } {
  const existed = Boolean(db.prepare?.("SELECT 1 FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' LIMIT 1").get?.(alertId));
  if (existed) return { inserted: false, existed: true };
  const vals = paperVals(e, { ...extra, alertId }, "DELIVERED_ALERT_PAPER", "discord_delivery", decisionMs);
  // INSERT ... WHERE NOT EXISTS guards a concurrent double-create even past the read check above.
  const r = db.prepare(
    `INSERT INTO options_paper_trades (${PAPER_COLS}) SELECT ${PAPER_PLACEHOLDERS} WHERE NOT EXISTS (SELECT 1 FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER')`,
  ).run(...vals, alertId);
  if ((r.changes ?? 0) > 0) {
    const row = db.prepare?.("SELECT id FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' LIMIT 1").get?.(alertId) as { id?: number } | undefined;
    if (row?.id) {
      if (extra.thesisFingerprint) {
        try {
          db.prepare(
            "UPDATE options_paper_trades SET thesis_fingerprint=? WHERE id=?",
          ).run(extra.thesisFingerprint, row.id);
        } catch (error) {
          try {
            db.prepare("DELETE FROM options_paper_trades WHERE id=?").run(row.id);
          } catch { /* best effort rollback */ }
          throw error;
        }
      }
      try {
        dualWriteAfterOptionsPaperEntry(db as BrokerDb, row.id);
      } catch { /* best-effort */ }
    }
  }
  return { inserted: (r.changes ?? 0) > 0, existed: false };
}

type DeliveredReservationDb = {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    run: (...a: any[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
};

type DeliveredPaperRow = {
  id: number;
  option_symbol: string;
  paper_kind: string | null;
  alert_id: string | null;
  status: string;
  entry_fill: number | null;
  target: number | null;
  invalidation: number | null;
};

export type DeliveredPaperReservation = {
  ok: boolean;
  paperTradeId: number | null;
  state: "PENDING_DELIVERY" | "REUSED_ENTERED" | "FAILED";
  reason: string | null;
};

function sameFiniteNumber(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null || !Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return false;
  return Math.abs(Number(a) - Number(b)) <= 0.0001;
}

function reusableDeliveredPosition(row: DeliveredPaperRow, e: RealOptionEntry, alertId: string): string | null {
  if (row.paper_kind !== "DELIVERED_ALERT_PAPER") return `active_thesis_lane_mismatch:${row.paper_kind ?? "UNKNOWN"}`;
  if (row.option_symbol !== e.optionSymbol) return "active_thesis_contract_mismatch";
  if (!sameFiniteNumber(row.entry_fill, e.entryFill)) return "active_thesis_frozen_entry_mismatch";
  if (!sameFiniteNumber(row.target, e.target)) return "active_thesis_target_mismatch";
  if (!sameFiniteNumber(row.invalidation, e.invalidation)) return "active_thesis_stop_mismatch";
  if (row.alert_id && row.alert_id !== alertId) return "active_delivered_position_already_linked";
  return null;
}

/**
 * Reserve the exact delivered-paper position before Discord. The row is not eligible for delivered
 * performance until finalizeDeliveredPaperReservationOnDb promotes it to ENTERED after Discord proof.
 */
export function reserveDeliveredPaperOnDb(
  db: DeliveredReservationDb,
  e: RealOptionEntry,
  decisionMs: number,
  alertId: string,
  extra: PaperPersistExtra = {},
): DeliveredPaperReservation {
  const existingForAlert = db.prepare(
    `SELECT id, option_symbol, paper_kind, alert_id, status, entry_fill, target, invalidation
       FROM options_paper_trades
      WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER'
      ORDER BY id ASC LIMIT 1`,
  ).get(alertId) as DeliveredPaperRow | undefined;
  if (existingForAlert) {
    const invalid = reusableDeliveredPosition(existingForAlert, e, alertId);
    if (invalid) return { ok: false, paperTradeId: existingForAlert.id, state: "FAILED", reason: invalid };
    if (existingForAlert.status === "ENTERED") {
      return { ok: true, paperTradeId: existingForAlert.id, state: "REUSED_ENTERED", reason: null };
    }
    if (existingForAlert.status === "PENDING_DELIVERY") {
      return { ok: true, paperTradeId: existingForAlert.id, state: "PENDING_DELIVERY", reason: null };
    }
    if (existingForAlert.status === "ABORTED") {
      db.prepare(
        `UPDATE options_paper_trades
            SET status='PENDING_DELIVERY', exit_reason=NULL, exit_at_ms=NULL, updated_at_ms=?
          WHERE id=? AND status='ABORTED'`,
      ).run(decisionMs, existingForAlert.id);
      return { ok: true, paperTradeId: existingForAlert.id, state: "PENDING_DELIVERY", reason: null };
    }
    return {
      ok: false,
      paperTradeId: existingForAlert.id,
      state: "FAILED",
      reason: `existing_alert_paper_state_invalid:${existingForAlert.status}`,
    };
  }

  if (extra.thesisFingerprint) {
    const activeThesis = db.prepare(
      `SELECT id, option_symbol, paper_kind, alert_id, status, entry_fill, target, invalidation
         FROM options_paper_trades
        WHERE thesis_fingerprint=? AND status IN ('PENDING_DELIVERY','ENTERED')
        ORDER BY CASE status WHEN 'ENTERED' THEN 0 ELSE 1 END, id ASC
        LIMIT 1`,
    ).get(extra.thesisFingerprint) as DeliveredPaperRow | undefined;
    if (activeThesis) {
      const invalid = reusableDeliveredPosition(activeThesis, e, alertId);
      if (invalid) {
        return { ok: false, paperTradeId: activeThesis.id, state: "FAILED", reason: invalid };
      }
      if (!activeThesis.alert_id) {
        db.prepare(
          "UPDATE options_paper_trades SET alert_id=?, updated_at_ms=? WHERE id=? AND alert_id IS NULL",
        ).run(alertId, decisionMs, activeThesis.id);
      }
      return {
        ok: true,
        paperTradeId: activeThesis.id,
        state: activeThesis.status === "ENTERED" ? "REUSED_ENTERED" : "PENDING_DELIVERY",
        reason: null,
      };
    }
  }

  const vals = paperVals(
    e,
    { ...extra, alertId },
    "DELIVERED_ALERT_PAPER",
    "discord_delivery_reservation",
    decisionMs,
    "PENDING_DELIVERY",
  );
  try {
    const r = db.prepare(
      `INSERT INTO options_paper_trades (${PAPER_COLS}, thesis_fingerprint)
       VALUES (${PAPER_PLACEHOLDERS}, ?)`,
    ).run(...vals, extra.thesisFingerprint ?? null);
    const paperTradeId = Number(r.lastInsertRowid ?? 0);
    if (paperTradeId <= 0) {
      return { ok: false, paperTradeId: null, state: "FAILED", reason: "paper_reservation_insert_failed" };
    }
    return { ok: true, paperTradeId, state: "PENDING_DELIVERY", reason: null };
  } catch (error: any) {
    const message = String(error?.message ?? error);
    if (/UNIQUE constraint failed.*thesis_fingerprint/i.test(message)) {
      return { ok: false, paperTradeId: null, state: "FAILED", reason: "active_paper_position_for_thesis" };
    }
    return { ok: false, paperTradeId: null, state: "FAILED", reason: `paper_reservation_failed:${message.slice(0, 120)}` };
  }
}

export function finalizeDeliveredPaperReservationOnDb(
  db: DeliveredReservationDb,
  reservation: DeliveredPaperReservation,
  nowMs: number,
): boolean {
  if (!reservation.ok || !reservation.paperTradeId) return false;
  if (reservation.state === "REUSED_ENTERED") return true;
  const result = db.prepare(
    `UPDATE options_paper_trades
        SET status='ENTERED', entry_source='discord_delivery', exit_reason=NULL, updated_at_ms=?
      WHERE id=? AND paper_kind='DELIVERED_ALERT_PAPER' AND status='PENDING_DELIVERY'`,
  ).run(nowMs, reservation.paperTradeId);
  if ((result.changes ?? 0) !== 1) return false;
  try {
    dualWriteAfterOptionsPaperEntry(db as BrokerDb, reservation.paperTradeId);
  } catch { /* best-effort; options paper row remains authoritative */ }
  return true;
}

export function reconcileDeliveredPaperSendFailureOnDb(
  db: DeliveredReservationDb,
  reservation: DeliveredPaperReservation,
  nowMs: number,
  ambiguous: boolean,
  reason: string,
): void {
  if (!reservation.ok || !reservation.paperTradeId || reservation.state === "REUSED_ENTERED") return;
  db.prepare(
    `UPDATE options_paper_trades
        SET status=?, exit_reason=?, updated_at_ms=?
      WHERE id=? AND paper_kind='DELIVERED_ALERT_PAPER' AND status='PENDING_DELIVERY'`,
  ).run(
    ambiguous ? "PENDING_DELIVERY" : "ABORTED",
    ambiguous ? `discord_ambiguous:${reason}` : `discord_failed:${reason}`,
    nowMs,
    reservation.paperTradeId,
  );
}

interface GateDb { prepare(sql: string): { get: (...a: any[]) => any } }
export interface OpenPaperGateCfg { bucketMs: number; maxConcurrent: number; maxPerSymbol: number }
export function defaultOpenPaperGate(env: NodeJS.ProcessEnv = process.env): OpenPaperGateCfg {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return { bucketMs: n(env.OPTIONS_PAPER_DEDUP_BUCKET_MS, 60_000), maxConcurrent: n(env.OPTIONS_PAPER_MAX_CONCURRENT, 20), maxPerSymbol: n(env.OPTIONS_PAPER_MAX_PER_SYMBOL, 2) };
}
const occSym = (occ: string) => occ.match(/^O:([A-Z]+)/)?.[1] ?? "";

/** Guard a real-option paper entry: dedup (symbol+strategy+contract+time-bucket), max concurrent open
 *  positions, and per-symbol exposure. Pure over the DB (read-only). */
export function canOpenRealOptionPaper(
  db: GateDb,
  i: {
    optionSymbol: string;
    strategy: string;
    nowMs: number;
    paperKind?: PaperKind;
    thesisFingerprint?: string | null;
  },
  cfg: OpenPaperGateCfg = defaultOpenPaperGate(),
): { ok: boolean; reason: string | null } {
  if (i.thesisFingerprint && i.paperKind) {
    try {
      const activeThesis = db.prepare(
        `SELECT 1 FROM options_paper_trades
         WHERE thesis_fingerprint=? AND status='ENTERED'
         LIMIT 1`,
      ).get(i.thesisFingerprint);
      if (activeThesis) return { ok: false, reason: "active_paper_position_for_thesis" };
    } catch {
      return { ok: false, reason: "paper_thesis_schema_unavailable" };
    }
  }
  const bucketStart = i.nowMs - (i.nowMs % cfg.bucketMs);
  const dup = i.paperKind
    ? db.prepare("SELECT 1 FROM options_paper_trades WHERE paper_kind=? AND option_symbol=? AND strategy=? AND created_at_ms >= ? LIMIT 1").get(i.paperKind, i.optionSymbol, i.strategy, bucketStart)
    : db.prepare("SELECT 1 FROM options_paper_trades WHERE option_symbol=? AND strategy=? AND created_at_ms >= ? LIMIT 1").get(i.optionSymbol, i.strategy, bucketStart);
  if (dup) return { ok: false, reason: "duplicate_in_time_bucket" };
  const openN = Number((i.paperKind
    ? db.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE paper_kind=? AND status='ENTERED'").get(i.paperKind)
    : db.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE status='ENTERED'").get() as any)?.n ?? 0);
  if (openN >= cfg.maxConcurrent) return { ok: false, reason: "max_concurrent_positions" };
  const sym = occSym(i.optionSymbol);
  const symN = Number((i.paperKind
    ? db.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE paper_kind=? AND status='ENTERED' AND option_symbol LIKE ?").get(i.paperKind, `O:${sym}%`)
    : db.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE status='ENTERED' AND option_symbol LIKE ?").get(`O:${sym}%`) as any)?.n ?? 0);
  if (symN >= cfg.maxPerSymbol) return { ok: false, reason: "per_symbol_exposure" };
  return { ok: true, reason: null };
}

/** Live hook: build + persist a real-option paper entry. HARD no-op unless REAL_OPTION_PAPER_ENABLED=1. */
export function recordRealOptionPaper(input: BuildEntryInput, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { recorded: boolean; reason: string | null; entry: RealOptionEntry | null } {
  if (!researchFlags(env).realOptionPaper) return { recorded: false, reason: "REAL_OPTION_PAPER_ENABLED!=1", entry: null };
  const entry = buildRealOptionEntry(input, env);
  if (!entry.ok) return { recorded: false, reason: `entry gate: ${entry.rejections.join(",")}`, entry };
  try { persistRealOptionPaperOnDb(require("@/lib/db").getDb(), entry, nowMs); return { recorded: true, reason: null, entry }; } // eslint-disable-line @typescript-eslint/no-require-imports
  catch (e: any) { return { recorded: false, reason: `isolated: ${String(e?.message ?? e).slice(0, 100)}`, entry }; }
}
