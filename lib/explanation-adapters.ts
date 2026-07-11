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

/** Read-only historical evidence for a setup, or null when nothing is tracked. */
function evidenceForSetup(setupType: string, assetClass: "options" | "stock"): ExplanationEvidence | null {
  try {
    const row: any = getDb()
      .prepare("SELECT sample_size, win_rate, expectancy, data_quality FROM setup_statistics WHERE setup_type=? AND asset_class=?")
      .get(setupType, assetClass);
    if (!row) return null;
    return {
      dataQuality: row.data_quality ?? null,
      sampleSize: row.sample_size ?? null,
      winRate: isNum(row.win_rate) ? row.win_rate : null,
      expectancy: isNum(row.expectancy) ? row.expectancy : null,
    };
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

/**
 * Build an explanation from an alert row (as returned by listAlerts / alert
 * snapshots). Reuses the deterministic explain.js sections for narrative
 * fragments and a read-only setup-statistics lookup for gated evidence.
 */
export function explanationForAlert(alert: any): TradeExplanation {
  const direction = alert.direction === "bearish" ? "bearish" : alert.direction === "bullish" ? "bullish" : null;
  const rawSide = String(alert.option_side ?? "").toLowerCase();
  const side: "call" | "put" | null = rawSide.startsWith("p") ? "put" : rawSide.startsWith("c") ? "call" : direction === "bearish" ? "put" : direction === "bullish" ? "call" : null;
  const assetClass: "options" | "stock" = alert.asset_class === "stock" ? "stock" : "options";

  const movePct = isNum(alert.percent_move_at_alert) ? alert.percent_move_at_alert : null;
  const relVol = isNum(alert.relative_volume) ? alert.relative_volume : null;

  // Deterministic narrative fragments from explain.js (no model calls).
  let whyNow: string | null = null;
  let improveIf: string | null = null;
  let invalidateIf: string | null = null;
  try {
    const { sections } = buildExplanation(
      {
        ticker: alert.ticker,
        direction: alert.direction,
        movePct,
        relVol,
        moveStatus: alert.move_status ?? null,
        spreadPct: isNum(alert.entry_spread_pct) ? alert.entry_spread_pct : null,
        riskScore: alert.risk_score ?? null,
        setupScore: alert.signal_score ?? null,
        liquidityScore: alert.options_liquidity_score ?? null,
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
  if (alert.invalidation_reason) invalidateIf = `This is invalidated if ${alert.invalidation_reason}.`;

  const hasContract = side != null && (alert.strike != null || alert.entry_mid != null);
  const contract = hasContract
    ? {
        optionSymbol: alert.option_symbol ?? null,
        strike: isNum(alert.strike) ? alert.strike : null,
        side,
        expiration: alert.expiration ?? null,
        dte: isNum(alert.dte) ? alert.dte : null,
        mid: isNum(alert.entry_mid) ? alert.entry_mid : null,
        spreadPct: isNum(alert.entry_spread_pct) ? alert.entry_spread_pct : null,
        delta: isNum(alert.entry_delta) ? alert.entry_delta : null,
      }
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
    riskScore: isNum(alert.risk_score) ? alert.risk_score : null,
    riskLabel: isNum(alert.risk_score) ? riskLabel(alert.risk_score) : null,
    score: isNum(alert.signal_score) ? alert.signal_score : null,
    whyNow,
    improveIf,
    invalidateIf,
    contract,
    midpointLabel: "Entry mid",
    evidence,
  };
  return buildTradeExplanation(source);
}
