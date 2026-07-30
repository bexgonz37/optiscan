/**
 * Deterministic earlier-entry shadow research.
 *
 * Inputs are historical observations supplied by a read model. This module is
 * pure and is intentionally never imported by live scanner or delivery code.
 */
import { isOptionsQuoteSession } from "../../market-session-guard.ts";

export const EARLIER_ENTRY_HORIZONS_MINUTES = [1, 3, 5, 10, 15, 30, 60] as const;
export type EarlierEntryClassification =
  | "EARLY_ENOUGH" | "SLIGHTLY_LATE" | "LATE_ENTRY" | "PREMIUM_CHASE"
  | "MISSED_PULLBACK" | "CONTRACT_SELECTED_TOO_LATE" | "STRUCTURE_CONFIRMED_TOO_LATE"
  | "VWAP_CONFIRMED_TOO_LATE" | "DATA_DELAY" | "PAPER_LINKAGE_DELAY"
  | "DELIVERY_DELAY" | "INSUFFICIENT_EVIDENCE";

export interface EarlierEntryObservation {
  kind: "FIRST_VALID_STRUCTURE" | "SUPPORT_RESISTANCE" | "VWAP_CONFIRMATION" | "EXACT_OCC" | "AUTHORITY_READY" | "READY" | "PULLBACK_RETEST" | "PRE_SEND" | "CANONICAL_SEND";
  atMs: number;
  optionSymbol: string;
  bid: number | null;
  ask: number | null;
  quoteAgeMs: number | null;
  source: string;
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  blockersRemaining?: string[];
  underlyingPrice?: number | null;
}

export interface EarlierEntryMark {
  atMs: number;
  optionSymbol: string;
  bid: number | null;
  ask: number | null;
  quoteAgeMs: number | null;
  source: string;
}

export interface EarlierEntryTrade {
  alertId: string;
  optionSymbol: string;
  canonicalSendAtMs: number;
  canonicalAsk: number | null;
  observations: EarlierEntryObservation[];
  marks: EarlierEntryMark[];
}

export interface ShadowEntryCandidate {
  kind: EarlierEntryObservation["kind"];
  atMs: number;
  entryAsk: number;
  bid: number;
  source: string;
  blockersRemaining: string[];
  premiumInflationPct: number | null;
  returns: Record<string, number | null>;
}

export interface EarlierEntryTradeReport {
  alertId: string;
  optionSymbol: string;
  classification: EarlierEntryClassification;
  canonicalAsk: number | null;
  canonicalSendAtMs: number;
  candidateEntries: ShadowEntryCandidate[];
  earliestValidAtMs: number | null;
  delayFromEarliestMs: number | null;
  limitation: string | null;
}

export interface EarlierEntryResearchReport {
  advisoryOnly: true;
  productionBehaviorChanged: false;
  trades: EarlierEntryTradeReport[];
  classificationCounts: Record<EarlierEntryClassification, number>;
  limitations: string[];
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function validQuote(atMs: number, bid: number | null, ask: number | null, quoteAgeMs: number | null, maxQuoteAgeMs: number): bid is number {
  return Number.isFinite(atMs) && isOptionsQuoteSession(atMs)
    && bid != null && Number.isFinite(bid) && bid > 0
    && ask != null && Number.isFinite(ask) && ask >= bid
    && quoteAgeMs != null && Number.isFinite(quoteAgeMs) && quoteAgeMs >= 0 && quoteAgeMs <= maxQuoteAgeMs;
}

function returnsFor(entryAsk: number, atMs: number, optionSymbol: string, marks: EarlierEntryMark[], maxQuoteAgeMs: number): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const minutes of EARLIER_ENTRY_HORIZONS_MINUTES) {
    const target = atMs + minutes * 60_000;
    const mark = marks.find((candidate) => candidate.atMs >= target
      && candidate.optionSymbol === optionSymbol
      && validQuote(candidate.atMs, candidate.bid, candidate.ask, candidate.quoteAgeMs, maxQuoteAgeMs));
    out[`${minutes}m`] = mark?.bid != null ? round(((mark.bid - entryAsk) / entryAsk) * 100) : null;
  }
  return out;
}

function classify(candidates: ShadowEntryCandidate[], canonicalAsk: number | null, canonicalSendAtMs: number): EarlierEntryClassification {
  const earliest = candidates[0];
  if (!earliest || canonicalAsk == null || !Number.isFinite(canonicalAsk) || canonicalAsk <= 0) return "INSUFFICIENT_EVIDENCE";
  const delay = canonicalSendAtMs - earliest.atMs;
  const inflation = ((canonicalAsk - earliest.entryAsk) / earliest.entryAsk) * 100;
  if (inflation >= 10) return "PREMIUM_CHASE";
  if (earliest.kind === "PULLBACK_RETEST" && delay >= 60_000) return "MISSED_PULLBACK";
  if (earliest.kind === "EXACT_OCC" && delay >= 3 * 60_000) return "CONTRACT_SELECTED_TOO_LATE";
  if (earliest.kind === "VWAP_CONFIRMATION" && delay >= 3 * 60_000) return "VWAP_CONFIRMED_TOO_LATE";
  if (earliest.kind === "FIRST_VALID_STRUCTURE" && delay >= 3 * 60_000) return "STRUCTURE_CONFIRMED_TOO_LATE";
  if (delay >= 5 * 60_000) return "LATE_ENTRY";
  if (delay >= 60_000) return "SLIGHTLY_LATE";
  return "EARLY_ENOUGH";
}

/** Replays only evidence already recorded at or before the canonical SEND. */
export function analyzeEarlierEntries(
  trades: EarlierEntryTrade[],
  opts: { maxQuoteAgeMs?: number } = {},
): EarlierEntryResearchReport {
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;
  const classifications = Object.fromEntries([
    "EARLY_ENOUGH", "SLIGHTLY_LATE", "LATE_ENTRY", "PREMIUM_CHASE", "MISSED_PULLBACK",
    "CONTRACT_SELECTED_TOO_LATE", "STRUCTURE_CONFIRMED_TOO_LATE", "VWAP_CONFIRMED_TOO_LATE",
    "DATA_DELAY", "PAPER_LINKAGE_DELAY", "DELIVERY_DELAY", "INSUFFICIENT_EVIDENCE",
  ].map((key) => [key, 0])) as Record<EarlierEntryClassification, number>;

  const reports = trades.map((trade) => {
    const marks = [...trade.marks].sort((a, b) => a.atMs - b.atMs);
    const candidates = trade.observations
      .filter((observation) => observation.atMs <= trade.canonicalSendAtMs
        && observation.optionSymbol === trade.optionSymbol
        && observation.freshness === "FRESH"
        && validQuote(observation.atMs, observation.bid, observation.ask, observation.quoteAgeMs, maxQuoteAgeMs))
      .sort((a, b) => a.atMs - b.atMs)
      .map((observation) => ({
        kind: observation.kind,
        atMs: observation.atMs,
        entryAsk: observation.ask as number,
        bid: observation.bid as number,
        source: observation.source,
        blockersRemaining: observation.blockersRemaining ?? [],
        premiumInflationPct: trade.canonicalAsk != null && trade.canonicalAsk > 0
          ? round(((trade.canonicalAsk - (observation.ask as number)) / (observation.ask as number)) * 100)
          : null,
        returns: returnsFor(observation.ask as number, observation.atMs, trade.optionSymbol, marks, maxQuoteAgeMs),
      }));
    const earliest = candidates[0] ?? null;
    const classification = classify(candidates, trade.canonicalAsk, trade.canonicalSendAtMs);
    classifications[classification] += 1;
    return {
      alertId: trade.alertId,
      optionSymbol: trade.optionSymbol,
      classification,
      canonicalAsk: trade.canonicalAsk,
      canonicalSendAtMs: trade.canonicalSendAtMs,
      candidateEntries: candidates,
      earliestValidAtMs: earliest?.atMs ?? null,
      delayFromEarliestMs: earliest ? Math.max(0, trade.canonicalSendAtMs - earliest.atMs) : null,
      limitation: earliest ? null : "No exact-OCC fresh in-session bid/ask evidence exists before canonical SEND.",
    };
  });

  return {
    advisoryOnly: true,
    productionBehaviorChanged: false,
    trades: reports,
    classificationCounts: classifications,
    limitations: [
      "Shadow entries use ask-side entry and bid-side marks only.",
      "Observations after canonical SEND, stale quotes, after-hours quotes, and mismatched OCC contracts are excluded.",
      "This research cannot alter scanner thresholds, delivery, contracts, entries, stops, targets, or paper positions.",
    ],
  };
}
