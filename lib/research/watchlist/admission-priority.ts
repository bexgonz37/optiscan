/**
 * admission-priority.ts — who gets one of the Watchlist's bounded slots, and why.
 *
 * THE DEFECT THIS REPLACES
 *
 * The runner merged every candidate into one flat array and ended it with
 * `.sort().slice(0, maxSymbols)`. The `.sort()` was there for determinism —
 * a reasonable thing to want — but combined with a binding `.slice()` it stops
 * being a tie-breaker and becomes the SELECTION POLICY. With a 78-symbol
 * curated universe against a cap of 60, the policy was the alphabet, and it cut
 * the same 18 names on every single run:
 *
 *   V VZ WFC WMT XBI XLB XLC XLE XLF XLI XLK XLP XLRE XLU XLV XLY XOM XOP
 *
 * That is the entire XL* sector-ETF family. A professional watchlist that can
 * never show energy, financials, tech, healthcare or utilities is not bounded,
 * it is broken — and nothing failed, because a slice always succeeds.
 *
 * WHAT REPLACES IT
 *
 * Deterministic BANDS served in priority order, each with its own bound:
 *
 *   1. CORE_INDEX          guaranteed — the market's own direction
 *   2. SECTOR_ETF          guaranteed — where money is rotating; the starved band
 *   3. CONFIRMED_CATALYST  bounded    — a dated, sourced event
 *   4. HIGH_VOLUME_MOMENTUM bounded   — exceptional movers EARN a slot
 *   5. LARGE_CAP_LIQUID    remainder  — rotated, never alphabetised away
 *
 * The bounded bands are bounded in BOTH directions. A cap on momentum stops one
 * wild session from evicting all structural coverage; serving momentum before
 * the large-cap fill is what lets an MRNA-class mover displace a lower-priority
 * name instead of waiting for a slot nobody ever frees.
 *
 * ROTATION, NOT TRUNCATION, IS THE OVERFLOW RULE
 *
 * When a band cannot be served in full the overflow goes through
 * `rotateForBudget` — the same round-robin the Tier-2 and mark sweeps use — so
 * the cutoff moves between runs. Fairness here is a correctness property, not a
 * nicety: a symbol never admitted can never carry setup evidence, so a fixed
 * cutoff freezes it out permanently. Today the default cap covers the whole
 * curated universe and rotation is inert; it exists so that the next time the
 * universe outgrows the cap, the answer is a moving cutoff rather than a
 * silently amputated alphabet.
 *
 * This decides only what may be LOOKED AT. Publication is a separate, evidence-
 * gated decision made downstream by structure score, and widening admission does
 * not widen the published message.
 *
 * PURE. No clock, no I/O, no env.
 */
import { rotateForBudget } from "../asymmetry/sweep-rotation.ts";
import type { UniverseTier } from "./universe.ts";

/** Priority bands, highest first. Identical to `UniverseTier`, ordered. */
export const ADMISSION_BAND_ORDER: readonly UniverseTier[] = Object.freeze([
  "CORE_INDEX",
  "SECTOR_ETF",
  "CONFIRMED_CATALYST",
  "HIGH_VOLUME_MOMENTUM",
  "LARGE_CAP_LIQUID",
]);

/**
 * Bands that must never be squeezed out by a lower one. These are the standing
 * coverage a trader expects to see every session; the XL* family lives here.
 */
export const GUARANTEED_BANDS: readonly UniverseTier[] = Object.freeze([
  "CORE_INDEX",
  "SECTOR_ETF",
]);

export interface MomentumSlotCandidate {
  symbol: string;
  absMovePct: number;
  dollarVolume: number;
}

export interface AdmissionPriorityConfig {
  /** Total slots. Bounds provider cost; nothing may exceed it. */
  maxSymbols: number;
  /** Ceiling on the confirmed-catalyst band. */
  maxCatalystSlots: number;
  /** Ceiling on the momentum band, so movers cannot take every slot. */
  maxMomentumSlots: number;
  /** Round-robin cursor for whichever band overflows. */
  rotationCursor: number;
}

export const DEFAULT_ADMISSION_PRIORITY = Object.freeze({
  maxCatalystSlots: 6,
  maxMomentumSlots: 10,
});

export interface AdmissionPriorityInput {
  core: readonly string[];
  sectorEtf: readonly string[];
  largeCap: readonly string[];
  /** Ranked internally by |move| then dollar volume then symbol. */
  momentum: readonly MomentumSlotCandidate[];
  catalysts: readonly string[];
  config: AdmissionPriorityConfig;
}

export interface AdmissionPriorityResult {
  /** Admitted symbols in band order. Deduped, `length <= maxSymbols`. */
  symbols: string[];
  /** Which band won each symbol its slot (first band that claimed it). */
  bandOf: Record<string, UniverseTier>;
  /** Admitted symbols per band, in admitted order. */
  byBand: Record<UniverseTier, string[]>;
  /** Symbols that lost a slot this run and are first in line next run. */
  deferred: string[];
  /** Cursor the next run should start its rotation from. */
  nextRotationCursor: number;
  /** Bands that could not be served in full. Empty is the healthy state. */
  starvedBands: UniverseTier[];
  /**
   * True when a band listed in `GUARANTEED_BANDS` was cut. This is the
   * condition the old code hit silently on every run; it is surfaced so it can
   * be asserted against rather than discovered a year later.
   */
  guaranteedCoverageBroken: boolean;
}

const norm = (s: unknown) => String(s ?? "").trim().toUpperCase();

/** |move| desc, then dollar volume desc, then symbol asc — the house ranking. */
export function rankMomentumForSlots(
  candidates: readonly MomentumSlotCandidate[],
): MomentumSlotCandidate[] {
  return [...candidates]
    .filter((c) => norm(c?.symbol) !== "")
    .sort((a, b) => {
      const am = Math.abs(Number(a.absMovePct) || 0);
      const bm = Math.abs(Number(b.absMovePct) || 0);
      if (bm !== am) return bm - am;
      const av = Number(a.dollarVolume) || 0;
      const bv = Number(b.dollarVolume) || 0;
      if (bv !== av) return bv - av;
      return norm(a.symbol).localeCompare(norm(b.symbol));
    });
}

/**
 * Allocate the bounded slots by band priority.
 *
 * Deterministic: identical input and cursor always produce identical output.
 */
export function allocateAdmissionSlots(input: AdmissionPriorityInput): AdmissionPriorityResult {
  const maxSymbols = Math.max(0, Math.floor(input.config.maxSymbols));
  const maxCatalystSlots = Math.max(0, Math.floor(input.config.maxCatalystSlots));
  const maxMomentumSlots = Math.max(0, Math.floor(input.config.maxMomentumSlots));

  const byBand: Record<UniverseTier, string[]> = {
    CORE_INDEX: [], SECTOR_ETF: [], CONFIRMED_CATALYST: [],
    HIGH_VOLUME_MOMENTUM: [], LARGE_CAP_LIQUID: [],
  };
  const bandOf: Record<string, UniverseTier> = {};
  const symbols: string[] = [];
  const deferred: string[] = [];
  const starvedBands: UniverseTier[] = [];
  const claimed = new Set<string>();

  // A symbol admitted by a higher band is not re-charged to a lower one. It
  // still appears once; the band recorded is the reason it got in.
  const dedupe = (list: readonly string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of list) {
      const s = norm(raw);
      if (!s || claimed.has(s) || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  };

  const admit = (band: UniverseTier, symbol: string) => {
    claimed.add(symbol);
    symbols.push(symbol);
    byBand[band].push(symbol);
    bandOf[symbol] = band;
  };

  /** Serve a band in list order, up to `slots`. Overflow is truncated tail-first. */
  const serveOrdered = (band: UniverseTier, list: readonly string[], bandCap: number) => {
    const want = dedupe(list);
    const slots = Math.max(0, Math.min(bandCap, maxSymbols - symbols.length, want.length));
    for (let i = 0; i < slots; i++) admit(band, want[i]);
    if (slots < want.length) {
      starvedBands.push(band);
      for (let i = slots; i < want.length; i++) deferred.push(want[i]);
    }
  };

  let nextRotationCursor = Math.max(0, Math.floor(input.config.rotationCursor) || 0);

  serveOrdered("CORE_INDEX", input.core, Number.POSITIVE_INFINITY);
  serveOrdered("SECTOR_ETF", input.sectorEtf, Number.POSITIVE_INFINITY);
  serveOrdered("CONFIRMED_CATALYST", input.catalysts, maxCatalystSlots);
  serveOrdered(
    "HIGH_VOLUME_MOMENTUM",
    rankMomentumForSlots(input.momentum).map((m) => norm(m.symbol)),
    maxMomentumSlots,
  );

  // The discretionary fill. This is the only band that rotates, because it is
  // the only one that is both large and homogeneous — no large-cap has a
  // standing claim over another, so a moving cutoff is fair where a fixed one
  // is not.
  {
    const want = dedupe(input.largeCap);
    const slots = Math.max(0, Math.min(maxSymbols - symbols.length, want.length));
    const rotated = rotateForBudget(want, nextRotationCursor, slots);
    for (const s of rotated.selected) admit("LARGE_CAP_LIQUID", s);
    nextRotationCursor = rotated.nextCursor;
    if (rotated.deferred > 0) {
      starvedBands.push("LARGE_CAP_LIQUID");
      const selected = new Set(rotated.selected);
      for (const s of want) if (!selected.has(s)) deferred.push(s);
    }
  }

  return {
    symbols,
    bandOf,
    byBand,
    deferred,
    nextRotationCursor,
    starvedBands,
    guaranteedCoverageBroken: starvedBands.some((b) => GUARANTEED_BANDS.includes(b)),
  };
}

/**
 * Smallest cap that serves every guaranteed band plus the bounded bands in full.
 *
 * The runner uses this to state its own requirement instead of carrying a
 * magic number that silently stops covering the universe when the universe
 * grows. A cap below this is legal — rotation handles it — but it is a choice,
 * and it should be a visible one.
 */
export function slotsRequiredForFullCoverage(input: {
  core: readonly string[];
  sectorEtf: readonly string[];
  largeCap: readonly string[];
  maxCatalystSlots?: number;
  maxMomentumSlots?: number;
}): number {
  const staticCount = new Set([
    ...input.core.map(norm),
    ...input.sectorEtf.map(norm),
    ...input.largeCap.map(norm),
  ]).size;
  return staticCount
    + (input.maxCatalystSlots ?? DEFAULT_ADMISSION_PRIORITY.maxCatalystSlots)
    + (input.maxMomentumSlots ?? DEFAULT_ADMISSION_PRIORITY.maxMomentumSlots);
}
