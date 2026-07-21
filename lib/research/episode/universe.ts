/**
 * lib/research/episode/universe.ts — the survivorship-aware universe resolver + seed
 * cost estimator (Analog Engine, Phase D). PURE.
 *
 * Fallback hierarchy (never silently uses today's tickers for the verdict):
 *   1. provider_pit         — point-in-time reference (entitled + historically dated) → VALID
 *   2. user_dated_file      — {symbol, activeFrom, activeTo, securityId} → VALID if dated
 *   3. current_symbols      — today's list → survivorship-BIASED → EXPLORATORY_ONLY, INVALID for GO
 * A universe that is not survivorship-free can never issue a Phase-D GO verdict.
 */

export type UniverseTier = "provider_pit" | "user_dated_file" | "current_symbols";

export interface DatedSymbol { symbol: string; activeFrom?: string | null; activeTo?: string | null; securityId?: string | null }

export interface UniverseResult {
  symbols: string[];
  source: UniverseTier;
  survivorshipBias: boolean;
  validForVerdict: boolean;
  note: string;
}

/** Symbols active at any point within [from, to] from a dated list. */
export function filterDatedUniverse(dated: DatedSymbol[], from: string, to: string): DatedSymbol[] {
  return dated.filter((d) => {
    const af = d.activeFrom ?? "0000-01-01";
    const at = d.activeTo ?? "9999-12-31";
    return af <= to && at >= from;
  });
}

/** Classify a resolved symbol set per the fallback hierarchy. Refuses to mark a survivorship-
 *  biased or undated source as valid-for-verdict. */
export function classifyUniverse(
  source: UniverseTier,
  symbols: string[],
  opts: { providerPitAvailable?: boolean; dated?: boolean } = {},
): UniverseResult {
  if (source === "provider_pit") {
    const ok = opts.providerPitAvailable === true;
    return { symbols, source, survivorshipBias: !ok, validForVerdict: ok, note: ok ? "point-in-time reference (survivorship-free)" : "provider point-in-time NOT entitled/verified — INVALID for verdict" };
  }
  if (source === "user_dated_file") {
    const dated = opts.dated !== false;
    return { symbols, source, survivorshipBias: !dated, validForVerdict: dated, note: dated ? "user-supplied dated universe (survivorship-free)" : "user file lacks active_from/active_to — treated as survivorship-biased, INVALID for verdict" };
  }
  return { symbols, source: "current_symbols", survivorshipBias: true, validForVerdict: false, note: "today's ticker list — SURVIVORSHIP-BIASED, EXPLORATORY ONLY, cannot issue GO" };
}

export interface SeedEstimate {
  symbols: number; spanDays: number;
  estProviderCalls: number;
  estEpisodes: number;
  estStorageMb: number;
  note: string;
}

/** Rough pre-flight estimate to protect against a request storm / uncontrolled bill.
 *  Minute bars: ~1 call per ~35 trading days of minutes per symbol (50k bars/call). */
export function estimateSeed(symbols: number, spanDays: number, opts: { episodesPerSymbolPerYear?: number; bytesPerEpisode?: number } = {}): SeedEstimate {
  const years = Math.max(0, spanDays / 365);
  const callsPerSymbol = Math.max(1, Math.ceil((spanDays * 0.7) / 35)); // ~0.7 trading days per calendar day
  const epsPerYear = opts.episodesPerSymbolPerYear ?? 20;
  const estEpisodes = Math.round(symbols * epsPerYear * years);
  const bytes = (opts.bytesPerEpisode ?? 4000) * estEpisodes;
  return {
    symbols, spanDays,
    estProviderCalls: symbols * callsPerSymbol,
    estEpisodes,
    estStorageMb: +(bytes / (1024 * 1024)).toFixed(1),
    note: "estimate only — actual counts depend on trigger density and data availability",
  };
}
