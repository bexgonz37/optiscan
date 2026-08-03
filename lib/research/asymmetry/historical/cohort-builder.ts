/**
 * cohort-builder.ts — historical winner and control cohorts from real
 * exact-OCC market data.
 *
 * WHY THIS COULD NOT EXIST BEFORE. The repo believed historical option quotes
 * were unentitled (see capability-matrix.ts). They are not. Until that was
 * disproved the only graded population was contracts the system had already
 * alerted on, so an "outsized" cohort could never contain anything the system
 * missed — which makes the one comparison that matters structurally impossible.
 *
 * THE RULES, AND WHY EACH ONE IS LOAD-BEARING:
 *
 *   ENTRY IS THE ASK, MARKS ARE THE BID. Both conservative, both the side you
 *   actually get. Grading a hypothetical entry at the midpoint invents a fill
 *   that no one received and inflates every result in the study.
 *
 *   SAME EXACT OCC, SAME SESSION. A cohort assembled across contracts or across
 *   days is measuring expiry and drift, not the setup.
 *
 *   NO FUTURE EVIDENCE AT THE ENTRY DECISION. Outcome data is used only to
 *   LABEL a row after entry, never to choose the entry instant. That boundary
 *   is the difference between a study and a backtest that cannot lose.
 *
 *   MISSING EXECUTABLE QUOTE STAYS UNGRADEABLE. Never a zero, never a loss,
 *   never dropped silently. A contract nobody could trade at that moment is not
 *   evidence about anything, and counting it as a flat outcome would quietly
 *   bias every rate toward the middle.
 *
 *   NO WINNERS WITHOUT CONTROLS. A list of contracts that went up teaches
 *   nothing on its own — every feature of a winner is also a feature of the
 *   hundreds of contracts that looked identical and did not move. buildCohorts
 *   REFUSES to report winners when no control cohort could be assembled.
 */
import type { RequestAccountant } from "./request-accounting.ts";
import type { HistoricalCache } from "./cache.ts";
import {
  fetchContractUniverse, fetchPremiumCurve, fetchQuoteAtInstant, fetchHistoricalBars,
  type ContractRef, type HistoricalBar, type HistoricalDeps,
} from "./massive-historical.ts";

export const COHORT_BUILDER_VERSION = "ASYM_COHORT_V1" as const;

/** Outcome bands. Ordered strongest first; a row lands in exactly one. */
export type OutcomeBand =
  | "GAIN_500" | "GAIN_200" | "GAIN_100" | "GAIN_25_99"
  | "FLAT" | "LOSS" | "UNGRADEABLE";

export const OUTCOME_BANDS: readonly OutcomeBand[] = Object.freeze([
  "GAIN_500", "GAIN_200", "GAIN_100", "GAIN_25_99", "FLAT", "LOSS", "UNGRADEABLE",
]);

/** Why a row could not be graded. Reported, never silently dropped. */
export type UngradeableReason =
  | "NO_EXECUTABLE_ENTRY_QUOTE"
  | "NO_EXECUTABLE_EXIT_QUOTE"
  | "NO_PREMIUM_CURVE"
  | "CURVE_TRUNCATED"
  | "PROVIDER_BUDGET_BLOCKED"
  | "NO_ENTRY_INSTANT";

export interface CohortRow {
  occ: string;
  underlying: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  sessionDate: string;

  /** The instant a hypothetical entry was taken. Chosen WITHOUT lookahead. */
  entryAtMs: number | null;
  /** Ask at entry. The conservative price actually payable. */
  entryAsk: number | null;
  /** Bid at the graded exit. The conservative price actually receivable. */
  exitBid: number | null;
  exitAtMs: number | null;

  /** Peak and trough of the TRADED premium after entry, from 1-minute bars. */
  peakAfterEntry: number | null;
  peakAtMs: number | null;
  troughAfterEntry: number | null;

  /** Ask-to-bid return at the graded exit. The honest number. */
  finalReturnPct: number | null;
  /** Maximum favourable excursion, ask-to-bar-high. Optimistic by construction. */
  mfePct: number | null;
  maePct: number | null;

  band: OutcomeBand;
  ungradeableReason: UngradeableReason | null;

  // Matching features. Used to pair a control with a winner.
  dte: number | null;
  moneyness: number | null;
  spreadPctAtEntry: number | null;
  entryPremium: number | null;
  timeOfDayMinutesEt: number | null;
  /** Contract volume over the session, from aggregates. A liquidity proxy. */
  sessionVolume: number | null;
}

export interface CohortResult {
  version: string;
  underlying: string;
  sessionDate: string;
  /** Rows that graded. */
  winners: CohortRow[];
  controls: CohortRow[];
  ungradeable: CohortRow[];
  bandCounts: Record<OutcomeBand, number>;
  ungradeableReasons: Record<string, number>;
  /**
   * Null when no control cohort exists. Winners are deliberately withheld from
   * analysis in that case rather than reported alone.
   */
  comparison: CohortComparison | null;
  coverage: {
    universeContracts: number;
    evaluated: number;
    budgetBlocked: number;
    truncatedCurves: number;
    providerNotes: string[];
  };
  limitations: string[];
}

export interface CohortComparison {
  winnerCount: number;
  controlCount: number;
  minimumSupportedSample: number;
  /** True only when BOTH cohorts clear the minimum. */
  sampleSufficient: boolean;
  features: Array<{
    feature: string;
    winnerMedian: number | null;
    controlMedian: number | null;
    difference: number | null;
    /** Never a p-value. There is no significance claim without a bigger sample. */
    note: string;
  }>;
}

/** Below this, a cohort cannot support any comparison and says so. */
export const MINIMUM_SUPPORTED_SAMPLE = 20;

export interface BuildCohortOptions {
  underlying: string;
  sessionDate: string;
  /** Expiration window to enumerate, inclusive. */
  expirationFrom: string;
  expirationTo: string;
  side?: "call" | "put";
  /** Entry instant, epoch ms. Fixed and identical for every contract. */
  entryAtMs: number;
  /** Exit instant for the graded return. */
  exitAtMs: number;
  /** Hard ceiling on contracts evaluated. Cost is linear in this. */
  maxContracts?: number;
  /** Contracts with no traded volume in the session are skipped before quoting. */
  minSessionVolume?: number;
  /**
   * Keep contracts within this fraction of the underlying price at entry.
   * Default 0.15 — a 15% band around the money.
   *
   * WITHOUT THIS THE SAMPLE IS SYSTEMATICALLY WRONG. The reference endpoint
   * returns contracts sorted by strike ascending, so taking the first N yields
   * the DEEPEST IN-THE-MONEY contracts on the board — the ones that move least
   * in percentage terms and that no short-horizon strategy would ever buy. A
   * cohort built from them cannot contain a +100% move, so "we found no
   * winners" would be an artefact of the sampling, not a finding.
   */
  moneynessBand?: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Band from a graded ask-to-bid return. Exactly one band per row. */
export function bandFor(returnPct: number | null): OutcomeBand {
  if (returnPct == null) return "UNGRADEABLE";
  if (returnPct >= 500) return "GAIN_500";
  if (returnPct >= 200) return "GAIN_200";
  if (returnPct >= 100) return "GAIN_100";
  if (returnPct >= 25) return "GAIN_25_99";
  if (returnPct > -25) return "FLAT";
  return "LOSS";
}

/** Winner bands. Everything gradeable that is not a winner is a control. */
export const WINNER_BANDS: readonly OutcomeBand[] = Object.freeze(["GAIN_500", "GAIN_200", "GAIN_100"]);

export function median(xs: readonly number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Minutes past midnight ET. Used to match controls by time of day. */
export function etMinutes(atMs: number): number | null {
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = f.formatToParts(new Date(atMs));
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const mi = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isFinite(h) && Number.isFinite(mi) ? h * 60 + mi : null;
  } catch {
    return null;
  }
}

function barsBetween(bars: readonly HistoricalBar[], fromMs: number, toMs: number): HistoricalBar[] {
  return bars.filter((b) => b.t >= fromMs && b.t <= toMs);
}

/**
 * Choose contracts closest to the money, within a band.
 *
 * When the underlying price is unknown the band cannot be applied, so this
 * falls back to the middle of the strike range rather than the start of it —
 * still crude, but it does not hand back the deepest-ITM contracts on the
 * board, which is what taking a strike-ascending prefix does.
 */
export function selectNearTheMoney(
  contracts: readonly ContractRef[], underlyingPrice: number | null, band: number, max: number,
): ContractRef[] {
  if (contracts.length <= max) return [...contracts];
  if (underlyingPrice == null || !(underlyingPrice > 0)) {
    const sorted = [...contracts].sort((a, b) => a.strike - b.strike);
    const start = Math.max(0, Math.floor((sorted.length - max) / 2));
    return sorted.slice(start, start + max);
  }
  const inBand = contracts.filter((c) => Math.abs(c.strike - underlyingPrice) / underlyingPrice <= band);
  const pool = inBand.length >= Math.min(max, 4) ? inBand : [...contracts];
  return pool
    .slice()
    .sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice)
      || a.occ.localeCompare(b.occ))
    .slice(0, max);
}

/**
 * Build cohorts for one underlying and one session.
 *
 * COST IS LINEAR IN CONTRACTS EVALUATED. Each contract costs one aggregate
 * request plus up to two point-in-time NBBO requests. The accountant's caps
 * bound it, and a capped run reports what it managed rather than failing.
 */
export async function buildCohorts(
  opts: BuildCohortOptions,
  deps: { accountant: RequestAccountant; cache?: HistoricalCache; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<CohortResult> {
  const hd: HistoricalDeps = { accountant: deps.accountant, cache: deps.cache, env: deps.env, fetchImpl: deps.fetchImpl };
  const providerNotes: string[] = [];
  const rows: CohortRow[] = [];
  let budgetBlocked = 0;
  let truncatedCurves = 0;

  const universe = await fetchContractUniverse(
    opts.underlying, opts.expirationFrom, opts.expirationTo, hd, { side: opts.side },
  );
  if (!universe.outcome.ok) providerNotes.push(`universe: ${universe.outcome.note}`);

  const maxContracts = Math.max(1, opts.maxContracts ?? 200);
  const minVol = opts.minSessionVolume ?? 1;
  const dayStart = Date.parse(`${opts.sessionDate}T00:00:00Z`);

  // The underlying price at entry. ONE request, and it earns its cost twice
  // over: it makes the sample near-the-money instead of deepest-ITM, and it is
  // the only way moneyness can be a real number rather than null.
  const undBars = await fetchHistoricalBars(
    opts.underlying, opts.entryAtMs - 30 * 60_000, opts.entryAtMs + 60_000, hd,
    { multiplier: 1, timespan: "minute", symbol: opts.underlying },
  );
  let underlyingAtEntry: number | null = null;
  for (const b of undBars.rows) if (b.t <= opts.entryAtMs) underlyingAtEntry = b.c;
  if (underlyingAtEntry == null) providerNotes.push(`underlying price at entry unavailable: ${undBars.outcome.note}`);

  const band = opts.moneynessBand ?? 0.15;
  const candidates = selectNearTheMoney(universe.contracts, underlyingAtEntry, band, maxContracts);
  for (const c of candidates) {
    // 1. The premium curve. One request; also the cheapest liquidity filter,
    //    so illiquid contracts are dropped before they cost any NBBO requests.
    const curve = await fetchPremiumCurve(c.occ, dayStart, dayStart + 86_400_000, hd, { symbol: opts.underlying });
    if (curve.outcome.blocked) { budgetBlocked += 1; rows.push(ungradeable(c, opts, "PROVIDER_BUDGET_BLOCKED")); continue; }
    if (!curve.outcome.ok) { providerNotes.push(`${c.occ}: ${curve.outcome.note}`); rows.push(ungradeable(c, opts, "NO_PREMIUM_CURVE")); continue; }
    if (curve.truncated) { truncatedCurves += 1; rows.push(ungradeable(c, opts, "CURVE_TRUNCATED")); continue; }
    if (!curve.rows.length) { rows.push(ungradeable(c, opts, "NO_PREMIUM_CURVE")); continue; }

    const sessionVolume = curve.rows.reduce((a, b) => a + (b.v ?? 0), 0);
    if (sessionVolume < minVol) { rows.push(ungradeable(c, opts, "NO_PREMIUM_CURVE")); continue; }

    // 2. Executable entry: the ASK at the fixed entry instant. No lookahead is
    //    used to pick this instant — it is the same for every contract.
    const entryQ = await fetchQuoteAtInstant(c.occ, opts.entryAtMs, hd, { symbol: opts.underlying });
    if (entryQ.outcome.blocked) { budgetBlocked += 1; rows.push(ungradeable(c, opts, "PROVIDER_BUDGET_BLOCKED")); continue; }
    const entryAsk = num(entryQ.quote?.ask);
    const entryBid = num(entryQ.quote?.bid);
    if (entryAsk == null || entryAsk <= 0) { rows.push(ungradeable(c, opts, "NO_EXECUTABLE_ENTRY_QUOTE", { sessionVolume })); continue; }

    // 3. Executable exit: the BID at the fixed exit instant.
    const exitQ = await fetchQuoteAtInstant(c.occ, opts.exitAtMs, hd, { symbol: opts.underlying });
    if (exitQ.outcome.blocked) { budgetBlocked += 1; rows.push(ungradeable(c, opts, "PROVIDER_BUDGET_BLOCKED")); continue; }
    const exitBid = num(exitQ.quote?.bid);
    if (exitBid == null || exitBid <= 0) { rows.push(ungradeable(c, opts, "NO_EXECUTABLE_EXIT_QUOTE", { sessionVolume, entryAsk })); continue; }

    const after = barsBetween(curve.rows, opts.entryAtMs, opts.exitAtMs);
    const peak = after.length ? Math.max(...after.map((b) => b.h)) : null;
    const peakBar = peak != null ? after.find((b) => b.h === peak) ?? null : null;
    const trough = after.length ? Math.min(...after.map((b) => b.l)) : null;

    const finalReturnPct = round2(((exitBid - entryAsk) / entryAsk) * 100);
    const mfePct = peak != null ? round2(((peak - entryAsk) / entryAsk) * 100) : null;
    const maePct = trough != null ? round2(((trough - entryAsk) / entryAsk) * 100) : null;
    const expMs = Date.parse(`${c.expiration}T00:00:00Z`);

    rows.push({
      occ: c.occ, underlying: c.underlying, side: c.side, strike: c.strike,
      expiration: c.expiration, sessionDate: opts.sessionDate,
      entryAtMs: opts.entryAtMs, entryAsk, exitBid, exitAtMs: opts.exitAtMs,
      peakAfterEntry: peak, peakAtMs: peakBar?.t ?? null, troughAfterEntry: trough,
      finalReturnPct, mfePct, maePct,
      band: bandFor(finalReturnPct), ungradeableReason: null,
      dte: Number.isFinite(expMs) ? Math.max(0, Math.round((expMs - opts.entryAtMs) / 86_400_000)) : null,
      // Signed distance from the money as a fraction of spot: negative is ITM
      // for a call. Null when the underlying price could not be resolved —
      // absent, never a guess.
      moneyness: underlyingAtEntry != null && underlyingAtEntry > 0
        ? round2(((c.strike - underlyingAtEntry) / underlyingAtEntry) * 100)
        : null,
      spreadPctAtEntry: entryBid != null && entryAsk > 0 ? round2(((entryAsk - entryBid) / entryAsk) * 100) : null,
      entryPremium: entryAsk,
      timeOfDayMinutesEt: etMinutes(opts.entryAtMs),
      sessionVolume,
    });
  }

  const gradeable = rows.filter((r) => r.band !== "UNGRADEABLE");
  const winners = gradeable.filter((r) => WINNER_BANDS.includes(r.band));
  const controls = gradeable.filter((r) => !WINNER_BANDS.includes(r.band));
  const ungraded = rows.filter((r) => r.band === "UNGRADEABLE");

  const bandCounts = Object.fromEntries(OUTCOME_BANDS.map((b) => [b, 0])) as Record<OutcomeBand, number>;
  for (const r of rows) bandCounts[r.band] += 1;
  const ungradeableReasons: Record<string, number> = {};
  for (const r of ungraded) {
    const k = r.ungradeableReason ?? "UNKNOWN";
    ungradeableReasons[k] = (ungradeableReasons[k] ?? 0) + 1;
  }

  return {
    version: COHORT_BUILDER_VERSION,
    underlying: opts.underlying,
    sessionDate: opts.sessionDate,
    winners, controls, ungradeable: ungraded,
    bandCounts, ungradeableReasons,
    comparison: compareCohorts(winners, controls),
    coverage: {
      universeContracts: universe.contracts.length,
      evaluated: rows.length,
      budgetBlocked, truncatedCurves,
      providerNotes: providerNotes.slice(0, 20),
    },
    limitations: [
      "Entry is the ASK and marks are the BID. Never the midpoint — a midpoint fill was available to nobody.",
      "Entry and exit instants are FIXED and identical for every contract, so no outcome information selected them.",
      "Historical open interest, IV and Greeks are unavailable at any depth on this plan, so those matching features are absent rather than estimated.",
      "Contracts are selected NEAR THE MONEY. A strike-ascending prefix would sample the deepest-ITM contracts on the board, which cannot produce a +100% move, so \"no winners found\" would be an artefact of sampling rather than a finding.",
      "MFE and MAE come from 1-minute TRADED bars, not NBBO, so they are optimistic relative to what was executable.",
      "A contract with no executable quote at either instant is UNGRADEABLE. It is never counted as flat and never as a loss.",
    ],
  };
}

function ungradeable(
  c: ContractRef, opts: BuildCohortOptions, reason: UngradeableReason,
  extra: { sessionVolume?: number; entryAsk?: number } = {},
): CohortRow {
  const expMs = Date.parse(`${c.expiration}T00:00:00Z`);
  return {
    occ: c.occ, underlying: c.underlying, side: c.side, strike: c.strike,
    expiration: c.expiration, sessionDate: opts.sessionDate,
    entryAtMs: opts.entryAtMs, entryAsk: extra.entryAsk ?? null, exitBid: null, exitAtMs: null,
    peakAfterEntry: null, peakAtMs: null, troughAfterEntry: null,
    finalReturnPct: null, mfePct: null, maePct: null,
    band: "UNGRADEABLE", ungradeableReason: reason,
    dte: Number.isFinite(expMs) ? Math.max(0, Math.round((expMs - opts.entryAtMs) / 86_400_000)) : null,
    moneyness: null, spreadPctAtEntry: null, entryPremium: extra.entryAsk ?? null,
    timeOfDayMinutesEt: etMinutes(opts.entryAtMs), sessionVolume: extra.sessionVolume ?? null,
  };
}

/**
 * Compare winners against controls on matching features.
 *
 * Returns null when there is no control cohort. That is the point: "here are
 * the winners" is not a finding, because every property of a winner is also a
 * property of the many contracts that shared it and went nowhere.
 */
export function compareCohorts(winners: readonly CohortRow[], controls: readonly CohortRow[]): CohortComparison | null {
  if (controls.length === 0) return null;
  const feat = (rows: readonly CohortRow[], pick: (r: CohortRow) => number | null): number | null =>
    median(rows.map(pick).filter((v): v is number => v != null));

  const specs: Array<{ feature: string; pick: (r: CohortRow) => number | null }> = [
    { feature: "entryPremium", pick: (r) => r.entryPremium },
    { feature: "spreadPctAtEntry", pick: (r) => r.spreadPctAtEntry },
    { feature: "dte", pick: (r) => r.dte },
    { feature: "moneynessPct", pick: (r) => r.moneyness },
    { feature: "sessionVolume", pick: (r) => r.sessionVolume },
    { feature: "timeOfDayMinutesEt", pick: (r) => r.timeOfDayMinutesEt },
  ];

  const sampleSufficient = winners.length >= MINIMUM_SUPPORTED_SAMPLE && controls.length >= MINIMUM_SUPPORTED_SAMPLE;
  return {
    winnerCount: winners.length,
    controlCount: controls.length,
    minimumSupportedSample: MINIMUM_SUPPORTED_SAMPLE,
    sampleSufficient,
    features: specs.map((s) => {
      const w = feat(winners, s.pick);
      const c = feat(controls, s.pick);
      return {
        feature: s.feature,
        winnerMedian: w, controlMedian: c,
        difference: w != null && c != null ? round2(w - c) : null,
        note: sampleSufficient
          ? "Median difference only. No significance is claimed and none should be inferred."
          : `Sample below ${MINIMUM_SUPPORTED_SAMPLE} in at least one cohort — descriptive only, not evidence.`,
      };
    }),
  };
}

/**
 * Pair each winner with the closest control on the matching features, so a
 * comparison is not confounded by winners simply being cheaper or shorter-dated.
 * Greedy and deterministic: controls are consumed in order of best fit.
 */
export function matchControls(
  winners: readonly CohortRow[], controls: readonly CohortRow[],
): Array<{ winner: CohortRow; control: CohortRow; distance: number }> {
  const available = controls.slice();
  const pairs: Array<{ winner: CohortRow; control: CohortRow; distance: number }> = [];
  for (const w of winners) {
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < available.length; i++) {
      const d = distance(w, available[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx >= 0 && Number.isFinite(bestDist)) {
      pairs.push({ winner: w, control: available[bestIdx], distance: round2(bestDist) });
      available.splice(bestIdx, 1);
    }
  }
  return pairs;
}

/**
 * Normalized distance over the features both rows actually have. A feature
 * missing on either side is SKIPPED rather than imputed — imputing it would
 * invent a match on evidence that does not exist.
 */
function distance(a: CohortRow, b: CohortRow): number {
  // Side is DISQUALIFYING, not weighted. A put is not a cheap approximation of
  // a call — it is the opposite directional bet, so no amount of similarity in
  // premium, DTE or moneyness makes it a valid control. As a soft penalty it
  // lost to genuinely comparable calls that differed on other features.
  if (a.side !== b.side) return Infinity;
  const dims: Array<[number | null, number | null, number]> = [
    [a.entryPremium, b.entryPremium, 5],
    [a.spreadPctAtEntry, b.spreadPctAtEntry, 20],
    [a.dte, b.dte, 30],
    [a.moneyness, b.moneyness, 15],
    [a.timeOfDayMinutesEt, b.timeOfDayMinutesEt, 390],
  ];
  let sum = 0, used = 0;
  for (const [x, y, scale] of dims) {
    if (x == null || y == null || !(scale > 0)) continue;
    sum += Math.abs(x - y) / scale;
    used += 1;
  }
  if (used === 0) return Infinity;
  return sum / used;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ── missed-winner review ────────────────────────────────────────────────────

export type MissedWinnerDisposition =
  /** The exact OCC was never captured by the radar at all. */
  | "NEVER_CAPTURED"
  /** Captured, and a message was delivered. */
  | "CAPTURED_AND_NOTIFIED"
  /** Captured and tracked, but deliberately silent. */
  | "CAPTURED_SILENTLY"
  /** A different contract on the SAME underlying and side was captured instead. */
  | "SIBLING_CONTRACT_CAPTURED";

export interface MissedWinner {
  occ: string;
  underlying: string;
  side: "call" | "put";
  expiration: string;
  finalReturnPct: number | null;
  mfePct: number | null;
  entryAsk: number | null;
  sessionVolume: number | null;
  disposition: MissedWinnerDisposition;
  /** The contract the radar took instead, when it took a sibling. */
  capturedInsteadOcc: string | null;
  /** What that substitution cost, in percentage points of return. */
  returnGapPct: number | null;
  note: string;
}

export interface CapturedCase {
  optionSymbol: string;
  symbol: string;
  direction: "CALL" | "PUT";
  /** Whether a message was actually delivered for this case. */
  notified?: boolean;
  /** Graded return for the captured contract, when known. */
  finalReturnPct?: number | null;
}

/**
 * Which winners the radar did not get, and why.
 *
 * SIBLING_CONTRACT_CAPTURED is the disposition worth reading first. It means
 * the radar had the right underlying, the right side and the right session —
 * and picked a different contract. That is a CONTRACT SELECTION failure, not a
 * detection failure, and the two have completely different fixes. A detection
 * failure argues for looser gates; a selection failure argues for nothing of
 * the sort, and treating one as the other is how gates get loosened for no
 * reason.
 *
 * Pure. No provider calls, no lookahead beyond the grading already done.
 */
export function reviewMissedWinners(
  winners: readonly CohortRow[],
  captured: readonly CapturedCase[],
): MissedWinner[] {
  const byOcc = new Map(captured.map((c) => [c.optionSymbol.toUpperCase(), c]));
  const out: MissedWinner[] = [];

  for (const w of winners) {
    const hit = byOcc.get(w.occ.toUpperCase());
    if (hit) {
      out.push({
        ...base(w),
        disposition: hit.notified ? "CAPTURED_AND_NOTIFIED" : "CAPTURED_SILENTLY",
        capturedInsteadOcc: null, returnGapPct: null,
        note: hit.notified
          ? "The radar captured this exact contract and spoke about it."
          : "The radar captured and tracked this exact contract but stayed silent. Check the notification journal for the suppression reason.",
      });
      continue;
    }
    const wantSide = w.side === "call" ? "CALL" : "PUT";
    const sibling = captured.find(
      (c) => c.symbol.toUpperCase() === w.underlying.toUpperCase() && c.direction === wantSide,
    );
    if (sibling) {
      const gap = w.finalReturnPct != null && sibling.finalReturnPct != null
        ? round2(w.finalReturnPct - sibling.finalReturnPct) : null;
      out.push({
        ...base(w),
        disposition: "SIBLING_CONTRACT_CAPTURED",
        capturedInsteadOcc: sibling.optionSymbol,
        returnGapPct: gap,
        note: `Right underlying, right side, different contract: the radar took ${sibling.optionSymbol}. This is a CONTRACT SELECTION gap, not a detection gap — loosening the notification gates would not have found it.`,
      });
      continue;
    }
    out.push({
      ...base(w),
      disposition: "NEVER_CAPTURED",
      capturedInsteadOcc: null, returnGapPct: null,
      note: "The radar never captured this underlying and side this session. A detection gap.",
    });
  }
  // Largest realized move first — the ones worth explaining.
  return out.sort((a, b) => (b.finalReturnPct ?? 0) - (a.finalReturnPct ?? 0));
}

function base(w: CohortRow) {
  return {
    occ: w.occ, underlying: w.underlying, side: w.side, expiration: w.expiration,
    finalReturnPct: w.finalReturnPct, mfePct: w.mfePct,
    entryAsk: w.entryAsk, sessionVolume: w.sessionVolume,
  };
}

/** Counts by disposition, for the diagnostics summary. */
export function missedWinnerSummary(reviewed: readonly MissedWinner[]): Record<MissedWinnerDisposition, number> {
  const out = {
    NEVER_CAPTURED: 0, CAPTURED_AND_NOTIFIED: 0, CAPTURED_SILENTLY: 0, SIBLING_CONTRACT_CAPTURED: 0,
  } as Record<MissedWinnerDisposition, number>;
  for (const r of reviewed) out[r.disposition] += 1;
  return out;
}
