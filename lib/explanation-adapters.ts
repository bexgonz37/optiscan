/**
 * explanation-adapters.ts — the impure gathering layer for TradeExplanation.
 *
 * Normalizes verified structured fields from three sources (a centralized
 * contract-selection result, a persisted opportunity record, or an alert row)
 * into an ExplanationSource, then calls the PURE builder in lib/trade-explanation.
 * All business logic lives there; these adapters only fetch/shape existing data.
 *
 * Read-only + honest: no writes, no provider calls, no fabricated values. Missing
 * fields stay null so the builder never invents them. Historical evidence is a
 * read-only lookup of already-computed setup statistics (never recomputed here),
 * and only an ESTABLISHED sample surfaces numbers (enforced in the builder).
 */
import { getDb } from "@/lib/db";
import { buildExplanation } from "@/lib/explain";
import { riskLabel } from "@/lib/language-modes";
import { inferSetupType } from "@/lib/quant";
import {
  buildTradeExplanation,
  type ExplanationEvidence,
  type ExplanationSource,
  type TradeExplanation,
} from "@/lib/trade-explanation";
import type { SelectionResult } from "@/lib/contract-selector";
import type { OpportunityRecord } from "@/lib/opportunity-lifecycle";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Read-only historical evidence for a setup, sourced from the AUTHORITATIVE
 * statistics layer (`authoritative_statistics`, Phase 2). The legacy gross-P&L
 * `setup_statistics` table is DEPRECATED and no longer consulted for trustworthy
 * claims. Numeric win rate / expectancy surface ONLY for an established sample;
 * otherwise this returns null ⇒ NOT_TRACKED, the honest default until
 * fingerprint-level outcomes accumulate. Never writes.
 */
function evidenceForSetup(setupType: string, _assetClass: "options" | "stock"): ExplanationEvidence | null {
  try {
    const row: any = getDb()
      .prepare("SELECT graded_sample_size, evidence_state, stats_json FROM authoritative_statistics WHERE group_kind='strategy' AND group_key=? ORDER BY statistics_version DESC LIMIT 1")
      .get(setupType);
    if (!row) return null;
    const state = String(row.evidence_state ?? "");
    const dataQuality = state === "ESTABLISHED_EVIDENCE" ? "strong"
      : state === "EARLY_EVIDENCE" ? "developing"
      : state === "INSUFFICIENT_HISTORY" ? "limited" : "empty";
    let winRate: number | null = null;
    let expectancy: number | null = null;
    if (state === "ESTABLISHED_EVIDENCE") {
      try {
        const s = JSON.parse(row.stats_json);
        winRate = isNum(s.winRate) ? s.winRate / 100 : null; // authoritative stores %; legacy shape is a fraction
        expectancy = isNum(s.expectancyDollars) ? s.expectancyDollars : null;
      } catch { /* fall through to nulls */ }
    }
    return { dataQuality, sampleSize: row.graded_sample_size ?? null, winRate, expectancy };
  } catch {
    return null; // table missing / query failure → NOT_TRACKED (never throws into a read)
  }
}

// ── Selection (options research surface) ─────────────────────────────────────

/**
 * Build an explanation from a centralized selection result. Used by
 * GET /api/options/:ticker where the `selection` verdict already exists.
 */
export function explanationForSelection(
  selection: SelectionResult,
  ctx: { ticker: string; side: "call" | "put"; midpointLabel?: string },
): TradeExplanation {
  const contract = selection.ok
    ? {
        optionSymbol: selection.contract.optionSymbol ?? null,
        strike: selection.contract.strike ?? null,
        side: ctx.side,
        expiration: selection.contract.expiration ?? null,
        dte: selection.contract.dte ?? null,
        bid: selection.contract.bid ?? null,
        ask: selection.contract.ask ?? null,
        mid: selection.marketData.mid,
        spreadPct: selection.marketData.spreadPct,
        delta: selection.marketData.delta,
        iv: selection.marketData.iv,
        volume: selection.marketData.volume,
        openInterest: selection.marketData.openInterest,
        breakevenPct: selection.marketData.breakevenPct,
      }
    : null;
  const source: ExplanationSource = {
    ticker: ctx.ticker,
    direction: ctx.side === "put" ? "bearish" : "bullish",
    side: ctx.side,
    selection,
    contract,
    score: selection.ok ? selection.score : null,
    midpointLabel: ctx.midpointLabel ?? "Estimated midpoint",
  };
  return buildTradeExplanation(source);
}

// ── Opportunity (Command Center cards) ───────────────────────────────────────

function opportunityWhyNow(rec: OpportunityRecord, side: "call" | "put" | null): string | null {
  const t = rec.ticker;
  switch (rec.current_status) {
    case "ENTRY_CONFIRMED":
      return `${t} broke its level with momentum on fresh data.`;
    case "NEAR_TRIGGER":
      return `${t} is close to confirming — watching for the trigger.`;
    case "WAIT_FOR_PULLBACK":
      return `${t} confirmed and is waiting for a pullback into the entry zone.`;
    case "BUILDING":
    case "WATCHING":
      return `${t} is building momentum but has not confirmed yet.`;
    case "EXTENDED":
      return `${t} has already run past the entry zone.`;
    case "INVALIDATED":
      return `${t}'s setup was invalidated for the day.`;
    case "DATA_STALE":
      return `${t}'s required data is stale, so it cannot be confirmed right now.`;
    case "NO_VALID_CONTRACT":
      return `${t} has momentum but no option contract currently passes the requirements.`;
    case "RESEARCH_ONLY":
      return side === "put"
        ? `${t} shows bearish momentum — research only; bearish actionability stays disabled.`
        : `${t} is detectable but outside an actionable window.`;
    default:
      return null;
  }
}

/**
 * Build an explanation from a persisted opportunity record. Tape-level, so there
 * is no contract by default (contractSummary stays null) and evidence is
 * NOT_TRACKED (real per-setup evidence is deferred to the fingerprint phase).
 */
export function explanationForOpportunity(
  rec: OpportunityRecord,
  selection?: SelectionResult | null,
): TradeExplanation {
  const bearish = rec.setup_type.includes("short") || rec.setup_type.includes("bear");
  const side: "call" | "put" | null = bearish ? "put" : rec.setup_type.includes("long") ? "call" : null;
  const invalidateIf = isNum(rec.invalidation_level)
    ? `This is invalidated if price closes back through ${rec.invalidation_level}.`
    : null;
  const source: ExplanationSource = {
    ticker: rec.ticker,
    direction: bearish ? "bearish" : side === "call" ? "bullish" : "neutral",
    side,
    lifecycleStatus: rec.current_status,
    selection: selection ?? null,
    score: rec.current_score,
    whyNow: opportunityWhyNow(rec, side),
    invalidateIf,
  };
  return buildTradeExplanation(source);
}

// ── Alert (alerts feed + Discord) ────────────────────────────────────────────

/** First finite/defined value among the given keys (tolerates camel + snake shapes). */
function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/**
 * Build an explanation from an alert-like object. Tolerates BOTH shapes: the
 * snake_case DB row (listAlerts) and the camelCase in-memory alert passed to the
 * Discord notify path. Reuses the deterministic explain.js sections for narrative
 * fragments and a read-only setup-statistics lookup for gated evidence.
 */
export function explanationForAlert(alert: any): TradeExplanation {
  const rawDir = String(pick(alert, "direction") ?? "").toLowerCase();
  const direction = rawDir === "bearish" ? "bearish" : rawDir === "bullish" ? "bullish" : null;
  const rawSide = String(pick(alert, "option_side", "optionSide") ?? "").toLowerCase();
  const side: "call" | "put" | null = rawSide.startsWith("p") ? "put" : rawSide.startsWith("c") ? "call" : direction === "bearish" ? "put" : direction === "bullish" ? "call" : null;
  const assetClass: "options" | "stock" = pick(alert, "asset_class", "assetClass") === "stock" ? "stock" : "options";

  const movePct = isNum(pick(alert, "percent_move_at_alert", "movePct", "percentMoveAtAlert")) ? Number(pick(alert, "percent_move_at_alert", "movePct", "percentMoveAtAlert")) : null;
  const relVol = isNum(pick(alert, "relative_volume", "relativeVolume", "relVol")) ? Number(pick(alert, "relative_volume", "relativeVolume", "relVol")) : null;
  const spreadPct = isNum(pick(alert, "entry_spread_pct", "spreadPct", "spread_pct")) ? Number(pick(alert, "entry_spread_pct", "spreadPct", "spread_pct")) : null;
  const delta = isNum(pick(alert, "entry_delta", "delta")) ? Number(pick(alert, "entry_delta", "delta")) : null;
  const mid = isNum(pick(alert, "entry_mid", "optionMid", "option_mid")) ? Number(pick(alert, "entry_mid", "optionMid", "option_mid")) : null;
  const strike = isNum(pick(alert, "strike")) ? Number(pick(alert, "strike")) : null;
  const dte = isNum(pick(alert, "dte")) ? Number(pick(alert, "dte")) : null;
  const riskScore = isNum(pick(alert, "risk_score", "riskScore")) ? Number(pick(alert, "risk_score", "riskScore")) : null;
  const signalScore = isNum(pick(alert, "signal_score", "setupScore")) ? Number(pick(alert, "signal_score", "setupScore")) : null;
  const moveStatus = pick(alert, "move_status", "moveStatus");
  const expiration = pick(alert, "expiration");
  const optionSymbol = pick(alert, "option_symbol", "optionSymbol");
  const invalidationReason = pick(alert, "invalidation_reason", "invalidationReason");

  // Deterministic narrative fragments from explain.js (no model calls).
  let whyNow: string | null = null;
  let improveIf: string | null = null;
  let invalidateIf: string | null = null;
  try {
    const { sections } = buildExplanation(
      {
        ticker: alert.ticker,
        direction: direction ?? undefined,
        movePct,
        relVol,
        moveStatus: moveStatus ?? null,
        spreadPct,
        riskScore,
        setupScore: signalScore,
        liquidityScore: pick(alert, "options_liquidity_score", "liquidityScore"),
      },
      "private",
    );
    whyNow = sections.whyTriggered ?? null;
    if (Array.isArray(sections.confirm) && sections.confirm.length) {
      improveIf = `This improves if ${sections.confirm.slice(0, 2).join(" and ")}.`;
    }
    if (Array.isArray(sections.invalidate) && sections.invalidate.length) {
      invalidateIf = `This is invalidated if ${sections.invalidate[0]}.`;
    }
  } catch {
    /* narrative is optional — leave nulls rather than fabricate */
  }
  if (invalidationReason) invalidateIf = `This is invalidated if ${invalidationReason}.`;

  const hasContract = side != null && (strike != null || mid != null);
  const contract = hasContract
    ? { optionSymbol, strike, side, expiration, dte, mid, spreadPct, delta }
    : null;

  let evidence: ExplanationEvidence | null = null;
  try {
    evidence = evidenceForSetup(inferSetupType(alert), assetClass);
  } catch {
    evidence = null;
  }

  const source: ExplanationSource = {
    ticker: alert.ticker,
    direction: direction ?? (side === "put" ? "bearish" : side === "call" ? "bullish" : "neutral"),
    side,
    movePct,
    relVol,
    riskScore,
    riskLabel: riskScore != null ? riskLabel(riskScore) : null,
    score: signalScore,
    whyNow,
    improveIf,
    invalidateIf,
    contract,
    midpointLabel: "Entry mid",
    evidence,
  };
  return buildTradeExplanation(source);
}
