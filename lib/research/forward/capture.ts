/**
 * lib/research/forward/capture.ts — prospective (forward) recommendation capture (Phase F). Impure
 * store with a pure builder. A recommendation is captured BEFORE its outcome is known and is written
 * ONCE (idempotent, INSERT OR IGNORE on a deterministic recId); it is NEVER updated after the fact —
 * outcomes live in forward_outcomes. HARD no-op unless FORWARD_CAPTURE_ENABLED=1.
 */
import { researchFlags } from "../flags.ts";
import { tradingDay } from "../../trading-session.ts";
import { classifyStrategy, FORWARD_SCHEMA_VERSION, type ForwardRecommendation, type ThesisDirection, type Vehicle } from "./schema.ts";
import type { RecommendationCard } from "../reco/card.ts";

function djb2(s: string): string { let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
export function forwardRecId(symbol: string, capturedAtMs: number, strategyKey: string): string {
  return `fwd_${djb2([symbol.toUpperCase(), capturedAtMs, strategyKey, FORWARD_SCHEMA_VERSION].join("|"))}`;
}

export interface CaptureContext {
  underlyingPrice: number;
  observedAtMs: number;
  direction: ThesisDirection;
  catalyst?: string | null;
  technicalState?: Record<string, number> | null;
  gatesPassed?: string[];
  maxChasePct?: number | null;
  backtestReportId?: string | null;
  source?: string;
}

/** Build the immutable decision-time record from a recommendation card + decision-time context. */
export function buildForwardRecommendation(card: RecommendationCard, ctx: CaptureContext, capturedAtMs: number): ForwardRecommendation {
  const side: Vehicle = card.side === "PUT" ? "put" : "call";
  const strategy = classifyStrategy({ direction: ctx.direction, vehicle: side, dte: card.contract?.dte ?? null });
  return {
    recId: forwardRecId(card.ticker, capturedAtMs, strategy.key),
    schemaVersion: FORWARD_SCHEMA_VERSION,
    capturedAtMs, tradingDay: tradingDay(capturedAtMs),
    symbol: card.ticker.toUpperCase(), strategy, direction: ctx.direction, side,
    productionEligible: card.productionEligible, researchOnly: card.researchOnly,
    underlyingPrice: ctx.underlyingPrice, observedAtMs: ctx.observedAtMs,
    contract: card.contract, entryZone: card.entryRange, maxChasePct: ctx.maxChasePct ?? null,
    confidence: card.confidence, analogCount: card.analogCount, effectiveSample: card.effectiveSample,
    catalyst: ctx.catalyst ?? null, technicalState: ctx.technicalState ?? null,
    gatesPassed: ctx.gatesPassed ?? [], rejectionReason: card.rejectionReason, abstainReason: card.abstainReason,
    outcomeBasis: card.outcomeBasis,
    provenance: { source: ctx.source ?? "analog_reco", backtestReportId: ctx.backtestReportId ?? null },
  };
}

interface FwdDb { prepare(sql: string): { run: (...a: any[]) => { changes: number } } }

/** Persist ONCE — idempotent, never overwrites (immutability). Returns whether a new row was inserted. */
export function persistForwardRecommendationOnDb(db: FwdDb, rec: ForwardRecommendation, nowMs: number = Date.now()): { inserted: boolean; recId: string } {
  const info = db.prepare(
    `INSERT OR IGNORE INTO forward_recommendations
      (rec_id, schema_version, captured_at_ms, trading_day, symbol, strategy_key, direction, side, production_eligible, research_only,
       underlying_price, observed_at_ms, contract_json, entry_zone_json, max_chase_pct, confidence, analog_count, effective_sample,
       catalyst, technical_state_json, gates_passed_json, rejection_reason, abstain_reason, outcome_basis, provenance_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?)`,
  ).run(
    rec.recId, rec.schemaVersion, rec.capturedAtMs, rec.tradingDay, rec.symbol, rec.strategy.key, rec.direction, rec.side, rec.productionEligible ? 1 : 0, rec.researchOnly ? 1 : 0,
    rec.underlyingPrice, rec.observedAtMs, rec.contract ? JSON.stringify(rec.contract) : null, rec.entryZone ? JSON.stringify(rec.entryZone) : null, rec.maxChasePct, rec.confidence, rec.analogCount, rec.effectiveSample,
    rec.catalyst, rec.technicalState ? JSON.stringify(rec.technicalState) : null, JSON.stringify(rec.gatesPassed), rec.rejectionReason, rec.abstainReason, rec.outcomeBasis, JSON.stringify(rec.provenance), nowMs,
  );
  return { inserted: info.changes > 0, recId: rec.recId };
}

/** Live capture hook. HARD no-op unless FORWARD_CAPTURE_ENABLED=1. Never throws into a caller. */
export function captureForwardRecommendation(card: RecommendationCard, ctx: CaptureContext, capturedAtMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { captured: boolean; reason: string | null } {
  if (!researchFlags(env).forwardCapture) return { captured: false, reason: "FORWARD_CAPTURE_ENABLED!=1" };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require("@/lib/db").getDb();
    const rec = buildForwardRecommendation(card, ctx, capturedAtMs);
    const r = persistForwardRecommendationOnDb(db, rec, capturedAtMs);
    return { captured: r.inserted, reason: r.inserted ? null : "already captured (immutable)" };
  } catch (err: any) {
    return { captured: false, reason: `capture error (isolated): ${String(err?.message ?? err).slice(0, 120)}` };
  }
}
