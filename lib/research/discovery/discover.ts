/**
 * lib/research/discovery/discover.ts — merge broad candidate SOURCES into one point-in-time
 * candidate set with source attribution, then strictly gate for eligibility (Broad Discovery
 * Bridge, shadow mode). PURE. Records every candidate + rejection reason; sends NO alerts.
 */
import { classifyEligibility, defaultEligibilityConfig, type DiscoveryCandidateInput, type EligibilityConfig } from "./eligibility.ts";

export type DiscoverySource =
  | "market_snapshot" | "gainers" | "losers" | "gap" | "rel_volume" | "vol_expansion"
  | "unusual_options" | "news" | "earnings" | "sector_sympathy" | "new_listing" | "accel";

export interface SourcedCandidate extends DiscoveryCandidateInput {
  source: DiscoverySource;
  changePctFromPrevClose?: number | null;
  relVolume?: number | null;
  observedAtMs: number;
}

export interface MergedCandidate {
  symbol: string;
  sources: DiscoverySource[];
  price: number | null;
  changePctFromPrevClose: number | null;
  relVolume: number | null;
  dayDollarVolume: number | null;
  observedAtMs: number;
  eligible: boolean;
  exclusions: string[];
  optionsChecked: boolean;
}

/** Merge by symbol (union of sources; freshest observation wins), then classify eligibility. */
export function mergeAndGate(candidates: SourcedCandidate[], cfg: EligibilityConfig = defaultEligibilityConfig()): MergedCandidate[] {
  const by = new Map<string, SourcedCandidate & { sources: Set<DiscoverySource> }>();
  for (const c of candidates) {
    const key = String(c.symbol).toUpperCase();
    if (!key) continue;
    const prev = by.get(key);
    if (!prev) { by.set(key, { ...c, symbol: key, sources: new Set([c.source]) }); continue; }
    prev.sources.add(c.source);
    if (c.observedAtMs >= prev.observedAtMs) { // freshest print wins for the merged fields
      prev.price = c.price ?? prev.price;
      prev.dayDollarVolume = c.dayDollarVolume ?? prev.dayDollarVolume;
      prev.changePctFromPrevClose = c.changePctFromPrevClose ?? prev.changePctFromPrevClose;
      prev.relVolume = c.relVolume ?? prev.relVolume;
      prev.observedAtMs = c.observedAtMs;
      prev.securityType = c.securityType ?? prev.securityType;
      prev.halted = c.halted ?? prev.halted;
      prev.lastTradeAgeMs = c.lastTradeAgeMs ?? prev.lastTradeAgeMs;
      prev.optionSpreadPct = c.optionSpreadPct ?? prev.optionSpreadPct;
      prev.optionBid = c.optionBid ?? prev.optionBid;
      prev.optionChainAgeMs = c.optionChainAgeMs ?? prev.optionChainAgeMs;
    }
  }
  return [...by.values()].map((c) => {
    const elig = classifyEligibility(c, cfg);
    return {
      symbol: c.symbol, sources: [...c.sources].sort(),
      price: c.price ?? null, changePctFromPrevClose: c.changePctFromPrevClose ?? null,
      relVolume: c.relVolume ?? null, dayDollarVolume: c.dayDollarVolume ?? null,
      observedAtMs: c.observedAtMs, eligible: elig.eligible, exclusions: elig.exclusions, optionsChecked: elig.optionsChecked,
    };
  }).sort((a, b) => (b.changePctFromPrevClose ?? -Infinity) - (a.changePctFromPrevClose ?? -Infinity));
}

export interface DiscoverySummary { total: number; eligible: number; rejected: number; bySource: Record<string, number>; byExclusion: Record<string, number> }
export function summarize(merged: MergedCandidate[]): DiscoverySummary {
  const bySource: Record<string, number> = {}; const byExclusion: Record<string, number> = {};
  for (const m of merged) {
    for (const s of m.sources) bySource[s] = (bySource[s] ?? 0) + 1;
    for (const e of m.exclusions) byExclusion[e] = (byExclusion[e] ?? 0) + 1;
  }
  return { total: merged.length, eligible: merged.filter((m) => m.eligible).length, rejected: merged.filter((m) => !m.eligible).length, bySource, byExclusion };
}
