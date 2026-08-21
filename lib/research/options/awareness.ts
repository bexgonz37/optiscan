/**
 * awareness.ts — CHEAP OPTIONS MARKET AWARENESS over the FULL eligible universe.
 *
 * WHY THIS EXISTS, in one measurement.
 *
 * `tier2-priority.ts` fixed WHICH 25 symbols a Tier-2 cycle looked at. It did
 * not fix that the number was 25. Measured on 2026-08-19:
 *
 *   tier-2 eligible universe                    ~1,606 symbols
 *   symbols the monitor was AWARE of per cycle       25  (1.6%)
 *   cycles to sweep the rotation band once          ~160
 *
 * At a 60s cadence that is ~2h40m for one pass, so a liquid name — COIN — can
 * begin a move, complete it, and be over before its rotation slot arrives. The
 * ranking made the 25 defensible; it could not make 25 sufficient.
 *
 * THE OBSERVATION THAT MAKES THIS FREE. The monitor already receives a
 * whole-market snapshot every cycle (`marketSnapshot`, a shared TTL-cached call
 * that the scanner and the monitor both read). Every eligible symbol's price,
 * day move, volume, day range and quote are ALREADY IN HAND when the cycle
 * begins — and were already paid for. The old code filtered that response down
 * to 25 symbols and threw the other ~1,581 rows away unread.
 *
 * So the fix is not to fetch more. It is to STOP DISCARDING WHAT WAS ALREADY
 * FETCHED. This module scores the whole eligible set off that one snapshot, at
 * zero marginal provider cost, and hands the ranking to the promotion stage
 * (`promotion.ts`) which alone decides who is worth spending on.
 *
 * TWO CONCEPTS, DELIBERATELY SEPARATE (Phase 1):
 *
 *   CHEAP AWARENESS  — this module. Whole universe, every cycle, snapshot-only.
 *                      No per-symbol provider request of any kind.
 *   DEEP ANALYSIS    — bars, strategy evaluation, option chain, contract
 *                      selection. Bounded. Only promoted symbols reach it.
 *
 * A symbol is NOT "unobserved" because it missed a deep slot. It is unobserved
 * only if no current cheap evidence exists for it. Those are different metrics
 * and this codebase now keeps them apart.
 *
 * WHAT THIS IS NOT. Not a trade signal. Nothing here scores a setup, picks a
 * side, chooses a contract, sets a target or authorizes a callout. It decides
 * only WHERE TO LOOK. Every strategy, quality bar and delivery gate downstream
 * is untouched and still rejects whatever this admits. The direction-awareness
 * in the range term is an OBSERVATION heuristic and is NOT the production
 * late-phase authority, which stays exactly as it is (see the Phase 12 shadow).
 *
 * NO PER-SYMBOL PROVIDER CALL IS REACHABLE FROM THIS FILE. It imports nothing
 * that can perform I/O, and takes every input as an argument.
 *
 * PURE. No clock (the caller passes `nowMs`), no I/O, no env read (the caller
 * resolves config).
 */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number, min = -Infinity): number => {
  const x = Number(v);
  return Number.isFinite(x) && x >= min ? x : d;
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const r3 = (n: number) => +n.toFixed(3);

/**
 * Everything one whole-market snapshot row already carries. NOTHING here is
 * fetched per symbol. Optional fields are optional because some snapshot
 * responses omit them, and a missing field must cost nothing rather than be
 * guessed — "we could not see it" and "it was bad" must never score the same.
 */
export interface AwarenessQuote {
  symbol: string;
  price: number | null;
  /** Signed move from the previous regular-session close. */
  changePercent: number | null;
  /** Day-to-date cumulative share volume. */
  volume: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  dayOpen?: number | null;
  prevClose?: number | null;
  bid?: number | null;
  ask?: number | null;
}

/**
 * The PREVIOUS cheap observation of the same symbol, carried in memory between
 * cycles. This is what turns a static snapshot into an acceleration signal
 * without a single extra request.
 */
export interface AwarenessObservation {
  changePercent: number | null;
  dollarVolume: number | null;
  atMs: number;
}

/* ---------------------------------------------------------------------------
 * LEVERAGE NORMALISATION
 * -------------------------------------------------------------------------*/

/**
 * Known leveraged / inverse product multipliers.
 *
 * WHY THIS IS NEEDED. A 3x fund mechanically prints three times its underlying
 * move. Under a move-ranked selection that is not a signal, it is an artefact of
 * the wrapper — and it is exactly how the stock lane ended up scanning MRNY at
 * +125.8% while MRNA, the actual event, went unseen (see market-movers.ts).
 * Ranking on raw move hands the top of the board to whichever products carry the
 * largest multiplier, every single day.
 *
 * WHAT IS DONE ABOUT IT. The move is DIVIDED by the multiplier so the product
 * competes on the underlying-equivalent move it actually represents. It is NOT
 * excluded, not barred from promotion, and not penalised anywhere else — several
 * of these carry genuinely deep option markets and stay fully eligible. A 3x
 * fund whose underlying truly moved more than everything else still wins.
 *
 * UNKNOWN SYMBOLS GET 1 — no dampening, no penalty. An absent entry means "not
 * known to be leveraged", never "assumed leveraged". Nothing is inferred from
 * ticker shape: SOXS and SOXX differ by one letter and one of them is a plain
 * index fund.
 */
export const LEVERAGE_MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({
  // 3x equity index / sector
  TQQQ: 3, SQQQ: 3, SPXL: 3, SPXS: 3, UPRO: 3, SPXU: 3, UDOW: 3, SDOW: 3,
  TNA: 3, TZA: 3, SOXL: 3, SOXS: 3, LABU: 3, LABD: 3, FAS: 3, FAZ: 3,
  TECL: 3, TECS: 3, YINN: 3, YANG: 3, NUGT: 3, DUST: 3, JNUG: 3, JDST: 3,
  GUSH: 3, DRIP: 3, ERX: 3, ERY: 3, DFEN: 3, DRN: 3, DRV: 3, WEBL: 3, WEBS: 3,
  RETL: 3, CURE: 3, MIDU: 3, TPOR: 3, GDXU: 3, GDXD: 3, NAIL: 3, UMDD: 3,
  BNKU: 3, PILL: 3, HIBL: 3, HIBS: 3, TMF: 3, TMV: 3, TYD: 3, TYO: 3,
  // 2x equity index / sector / commodity
  QLD: 2, QID: 2, SSO: 2, SDS: 2, DDM: 2, DXD: 2, UWM: 2, TWM: 2,
  ROM: 2, REW: 2, USD: 2, SSG: 2, UYG: 2, SKF: 2, RXL: 2, RXD: 2,
  UGE: 2, UCC: 2, UXI: 2, UPW: 2, URE: 2, SRS: 2, UYM: 2, SMN: 2,
  DIG: 2, DUG: 2, AGQ: 2, ZSL: 2, UGL: 2, GLL: 2, BOIL: 2, KOLD: 2,
  UCO: 2, SCO: 2, EET: 2, EEV: 2, EFO: 2, EFU: 2, MVV: 2, MZZ: 2,
  SAA: 2, SDD: 2, UBT: 2, TBT: 2, PST: 2, UST: 2, EUO: 2, ULE: 2,
  YCS: 2, YCL: 2, BITX: 2, ETHU: 2,
  // Volatility wrappers — not an equity move at all
  UVXY: 1.5, UVIX: 2, SVXY: 0.5, SVIX: 1, VXX: 1, VIXY: 1,
});

/**
 * The multiplier a symbol day move should be divided by. 1 when the symbol is
 * not a known leveraged/inverse product — which is the overwhelming majority,
 * and the safe default.
 */
export function leverageMultiplierOf(symbol: string): number {
  const m = LEVERAGE_MULTIPLIERS[String(symbol ?? "").toUpperCase()];
  return isNum(m) && m > 0 ? m : 1;
}

/* ---------------------------------------------------------------------------
 * CONFIG
 * -------------------------------------------------------------------------*/

export interface OptionsAwarenessConfig {
  /**
   * %/min of aligned move change treated as FULL acceleration. Above this the
   * term saturates, so one violent print cannot buy an unbounded score.
   */
  fullAccelerationPctPerMin: number;
  /**
   * A prior observation older than this is not comparable — a delta over an
   * unknown interval says nothing, so velocity reads null instead of a guess.
   */
  maxPriorAgeMs: number;
  /**
   * Below this |normalised move| a symbol still counts as QUIET, so movement
   * starting here is an EMERGENCE rather than a continuation. This is the COIN
   * case: interesting long before it is large.
   */
  emergingMovePct: number;
  /** Aligned velocity at or above which a quiet name is genuinely waking up. */
  emergingVelocityPctPerMin: number;
  /**
   * |normalised move| at or above which a name is EXTENDED. Extended AND no
   * longer accelerating is the profile the product should be de-prioritising,
   * not chasing.
   */
  extendedMovePct: number;
  /** Widest quoted spread still treated as clean, when a quote is present. */
  maxSpreadPct: number;
}

export const DEFAULT_OPTIONS_AWARENESS: Readonly<OptionsAwarenessConfig> = Object.freeze({
  fullAccelerationPctPerMin: 1.5,
  maxPriorAgeMs: 300_000,
  emergingMovePct: 4,
  emergingVelocityPctPerMin: 0.3,
  extendedMovePct: 12,
  maxSpreadPct: 5,
});

export function optionsAwarenessConfig(env: NodeJS.ProcessEnv = process.env): OptionsAwarenessConfig {
  const d = DEFAULT_OPTIONS_AWARENESS;
  return {
    fullAccelerationPctPerMin: num(env.OPTIONS_AWARENESS_FULL_ACCEL_PCT_PER_MIN, d.fullAccelerationPctPerMin, 0.01),
    maxPriorAgeMs: num(env.OPTIONS_AWARENESS_MAX_PRIOR_AGE_MS, d.maxPriorAgeMs, 1000),
    emergingMovePct: num(env.OPTIONS_AWARENESS_EMERGING_MOVE_PCT, d.emergingMovePct, 0),
    emergingVelocityPctPerMin: num(env.OPTIONS_AWARENESS_EMERGING_VEL_PCT_PER_MIN, d.emergingVelocityPctPerMin, 0),
    extendedMovePct: num(env.OPTIONS_AWARENESS_EXTENDED_MOVE_PCT, d.extendedMovePct, 0),
    maxSpreadPct: num(env.OPTIONS_AWARENESS_MAX_SPREAD_PCT, d.maxSpreadPct, 0),
  };
}

/* ---------------------------------------------------------------------------
 * OBSERVATION BANDS
 * -------------------------------------------------------------------------*/

/**
 * What KIND of interesting a symbol is. Bands describe state; they do NOT
 * reserve fixed slot quotas — fixed categories are how the old 15/10 split
 * guaranteed that a name outside the priority band waited its ~160 cycles
 * regardless of what it was doing.
 */
export type AwarenessBand =
  /** Moving hard and still accelerating. */
  | "HIGH_PRIORITY"
  /** Quiet-to-active transition in progress. Early, and the point of the product. */
  | "NEWLY_ACCELERATING"
  /** Deep, liquid, continuously worth a look even when calm. */
  | "CORE_LIQUID"
  /** Nothing distinguishing right now. Still cheaply observed, still rotates. */
  | "QUIET"
  /** Large move that has stopped going. De-prioritised, never hidden. */
  | "EXTENDED";

export interface AwarenessComponents {
  acceleration: number;
  emergence: number;
  activity: number;
  rangePosition: number;
  move: number;
  extendedPenalty: number;
  spreadPenalty: number;
}

export interface AwarenessRow {
  symbol: string;
  /** Signed day move exactly as the snapshot reported it. */
  rawMovePct: number;
  /** Day move divided by any known leverage multiplier. What ranking uses. */
  normalizedMovePct: number;
  leverageMultiplier: number;
  dollarVolume: number;
  /** Aligned to the move own direction: giving back a gain reads negative. */
  velocityPctPerMin: number | null;
  /** Where price sits in the day range, 0 = low, 1 = high. Null if unquoted. */
  rangePosition: number | null;
  spreadPct: number | null;
  band: AwarenessBand;
  /** Bounded 0..100. */
  preScore: number;
  /** Every component, so a rank can be explained without recomputation. */
  components: AwarenessComponents;
  rank: number;
  /** Plain-language justification for reports and the missed-opportunity record. */
  reason: string;
  /** When this cheap observation was taken. */
  observedAtMs: number;
}

/**
 * Move change per minute since the previous cheap observation, SIGNED AGAINST
 * THE MOVE OWN DIRECTION — a name giving back its gain reads negative and can
 * never be mistaken for a fresh accelerator. Same convention as
 * `moverVelocityPctPerMin` in market-movers.ts; deliberately not a second one.
 */
export function alignedVelocityPctPerMin(
  currentMovePct: number | null,
  prior: AwarenessObservation | undefined,
  nowMs: number,
  maxPriorAgeMs: number,
): number | null {
  if (!isNum(currentMovePct) || !prior || !isNum(prior.changePercent)) return null;
  const dtMs = nowMs - prior.atMs;
  if (!(dtMs > 0) || dtMs > maxPriorAgeMs) return null; // stale prior — the delta means nothing
  const dtMin = dtMs / 60_000;
  const delta = (currentMovePct as number) - (prior.changePercent as number);
  const aligned = (currentMovePct as number) >= 0 ? delta : -delta;
  return r3(aligned / dtMin);
}

/** Position of price within the day range. 0 = at the low, 1 = at the high. */
export function rangePositionOf(q: AwarenessQuote): number | null {
  const hi = isNum(q.dayHigh) ? (q.dayHigh as number) : null;
  const lo = isNum(q.dayLow) ? (q.dayLow as number) : null;
  const px = isNum(q.price) ? (q.price as number) : null;
  if (hi == null || lo == null || px == null || !(hi > lo)) return null;
  return r3(clamp((px - lo) / (hi - lo), 0, 1));
}

/** Quoted spread as a % of mid. Null unless both sides are genuinely present. */
export function awarenessSpreadPctOf(q: AwarenessQuote): number | null {
  const bid = isNum(q.bid) ? (q.bid as number) : null;
  const ask = isNum(q.ask) ? (q.ask as number) : null;
  if (bid == null || ask == null || bid <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return r3(((ask - bid) / mid) * 100);
}

/**
 * Score ONE symbol from snapshot evidence only.
 *
 * THE SCORE IS DELIBERATELY NOT "LARGEST DAY MOVE WINS". The options product
 * has to find setups EARLY, and by the time a name is the day biggest mover the
 * move it would have been bought for has largely happened. So:
 *
 *   acceleration  (0..40)  dominates — the only term that answers "is this
 *                          happening NOW", and what a 60s cadence can actually
 *                          observe.
 *   emergence     (0..18)  pays specifically for the quiet-to-active
 *                          transition, so a name at +2% and climbing outranks
 *                          one at +30% and flat. This is the COIN case, and the
 *                          only term a pure-magnitude ranking can never express.
 *   activity      (0..12)  log-scaled dollar volume. A TIE-BREAK, capped low on
 *                          purpose: liquidity is already a GATE upstream
 *                          (`tier2Eligible` requires $20M), and scoring it twice
 *                          is how the old broad score promoted mega-caps that
 *                          were merely large over stocks that were moving.
 *   rangePosition (0..12)  breakout/reclaim proximity, direction-aware: an
 *                          up-move pressing the day high and a down-move
 *                          pressing the day low both read as continuation-capable.
 *   move          (0..12)  magnitude still counts — it is just not allowed to be
 *                          the whole ranking.
 *
 *   extendedPenalty (0..18) subtracted when a name is both extended AND no
 *                          longer accelerating: the chase profile.
 *   spreadPenalty   (0..10) only when a spread is actually observable. A missing
 *                          quote costs nothing.
 *
 * Every term is bounded, so no single input can dominate the board, and the
 * total is clamped to 0..100.
 */
export function preScoreSymbol(
  q: AwarenessQuote,
  prior: AwarenessObservation | undefined,
  nowMs: number,
  cfg: OptionsAwarenessConfig = DEFAULT_OPTIONS_AWARENESS,
  coreLiquid: ReadonlySet<string> = new Set<string>(),
): AwarenessRow {
  const symbol = String(q.symbol ?? "").toUpperCase();
  const leverageMultiplier = leverageMultiplierOf(symbol);
  const rawMovePct = isNum(q.changePercent) ? (q.changePercent as number) : 0;
  const normalizedMovePct = r3(rawMovePct / leverageMultiplier);
  const absNorm = Math.abs(normalizedMovePct);
  const dollarVolume = Math.max(0, (isNum(q.price) ? q.price : 0) * (isNum(q.volume) ? q.volume : 0));

  // Velocity is computed on the RAW move (that is what was observed) and then
  // normalised, so a 3x product mechanical velocity is damped exactly as its
  // move is.
  const rawVel = alignedVelocityPctPerMin(rawMovePct, prior, nowMs, cfg.maxPriorAgeMs);
  const velocityPctPerMin = rawVel == null ? null : r3(rawVel / leverageMultiplier);
  const vel = velocityPctPerMin ?? 0;

  const rangePosition = rangePositionOf(q);
  const spreadPct = awarenessSpreadPctOf(q);

  const acceleration = r3(clamp(vel / cfg.fullAccelerationPctPerMin, 0, 1) * 40);

  const emerging = absNorm < cfg.emergingMovePct && vel >= cfg.emergingVelocityPctPerMin;
  const emergence = emerging
    ? r3(clamp(vel / Math.max(cfg.emergingVelocityPctPerMin * 3, 1e-6), 0, 1) * 18)
    : 0;

  const activity = r3(clamp(Math.log10(Math.max(1, dollarVolume)) - 7, 0, 4) * 3);

  // Direction-aware: an up-move is interesting pressing the HIGH, a down-move
  // pressing the LOW. Null range contributes 0, never a guessed midpoint.
  const directional = rangePosition == null
    ? 0
    : normalizedMovePct >= 0 ? rangePosition : 1 - rangePosition;
  const rangePositionTerm = r3(directional * 12);

  const move = r3(clamp(absNorm / 20, 0, 1) * 12);

  // EXTENDED requires OBSERVED stalling, never merely absent velocity.
  //
  // Treating a null velocity as zero would penalise every large mover on the
  // first cycle after a restart — when no prior observation exists for anything
  // — and would break the rule the rest of this file holds to: "we could not see
  // it" must never score the same as "it was bad". A name that is up a lot and
  // whose behaviour is UNKNOWN keeps its magnitude score and is judged next
  // cycle, once there is real evidence either way.
  const extended = absNorm >= cfg.extendedMovePct
    && velocityPctPerMin != null
    && velocityPctPerMin <= 0;
  const extendedPenalty = extended
    ? r3(clamp(absNorm / Math.max(cfg.extendedMovePct, 1e-6) - 1, 0, 1) * 12 + 6)
    : 0;

  const spreadPenalty = spreadPct != null && spreadPct > cfg.maxSpreadPct
    ? r3(clamp(spreadPct - cfg.maxSpreadPct, 0, 10))
    : 0;

  const preScore = r3(clamp(
    acceleration + emergence + activity + rangePositionTerm + move - extendedPenalty - spreadPenalty,
    0, 100,
  ));

  const band: AwarenessBand = extended
    ? "EXTENDED"
    : emerging
      ? "NEWLY_ACCELERATING"
      : (absNorm >= cfg.extendedMovePct || vel >= cfg.fullAccelerationPctPerMin)
        ? "HIGH_PRIORITY"
        : coreLiquid.has(symbol)
          ? "CORE_LIQUID"
          : "QUIET";

  const leverageNote = leverageMultiplier !== 1
    ? ` (${leverageMultiplier}x-normalised from ${rawMovePct.toFixed(1)}%)`
    : "";
  const reason = [
    `${normalizedMovePct >= 0 ? "+" : ""}${normalizedMovePct.toFixed(1)}%${leverageNote}`,
    velocityPctPerMin == null ? "velocity n/a (first observation)" : `${velocityPctPerMin.toFixed(2)}%/min`,
    `$${(dollarVolume / 1e6).toFixed(0)}M traded`,
    rangePosition == null ? "day range not quoted" : `range pos ${(rangePosition * 100).toFixed(0)}%`,
    spreadPct == null ? "spread not quoted" : `spread ${spreadPct.toFixed(2)}%`,
  ].join(" · ");

  return {
    symbol,
    rawMovePct: r3(rawMovePct),
    normalizedMovePct,
    leverageMultiplier,
    dollarVolume: Math.round(dollarVolume),
    velocityPctPerMin,
    rangePosition,
    spreadPct,
    band,
    preScore,
    components: {
      acceleration, emergence, activity,
      rangePosition: rangePositionTerm, move,
      extendedPenalty, spreadPenalty,
    },
    rank: 0,
    reason,
    observedAtMs: nowMs,
  };
}

export interface AwarenessSweep {
  /** EVERY eligible symbol, ranked. Not a slice — this is the whole universe. */
  rows: AwarenessRow[];
  /** Size of the eligible universe this sweep covered. */
  universeSize: number;
  /** How many carried a usable prior observation, so velocity was real. */
  withVelocity: number;
  /** Snapshot rows skipped for lacking a symbol. */
  skipped: number;
  observedAtMs: number;
  countsByBand: Record<AwarenessBand, number>;
}

/**
 * Score and rank the FULL eligible universe from ONE already-paid snapshot.
 *
 * O(n log n) over ~1,600 rows of arithmetic — microseconds, and the reason a
 * whole-universe sweep every 60s is affordable where 1,600 chain fetches never
 * could be.
 *
 * Ties break by dollar volume then symbol so the order is REPRODUCIBLE: a pure
 * score sort leaves ties in input order, and input order here is provider
 * order, which is the arbitrariness this whole line of work exists to remove.
 */
export function sweepAwareness(
  quotes: readonly AwarenessQuote[],
  prior: ReadonlyMap<string, AwarenessObservation>,
  nowMs: number,
  cfg: OptionsAwarenessConfig = DEFAULT_OPTIONS_AWARENESS,
  coreLiquid: ReadonlySet<string> = new Set<string>(),
): AwarenessSweep {
  const countsByBand: Record<AwarenessBand, number> = {
    HIGH_PRIORITY: 0, NEWLY_ACCELERATING: 0, CORE_LIQUID: 0, QUIET: 0, EXTENDED: 0,
  };
  let skipped = 0;
  let withVelocity = 0;

  const rows: AwarenessRow[] = [];
  for (const q of quotes) {
    if (!q || !q.symbol) { skipped++; continue; }
    const row = preScoreSymbol(q, prior.get(String(q.symbol).toUpperCase()), nowMs, cfg, coreLiquid);
    if (row.velocityPctPerMin != null) withVelocity++;
    countsByBand[row.band]++;
    rows.push(row);
  }

  rows.sort((a, b) =>
    b.preScore - a.preScore
    || b.dollarVolume - a.dollarVolume
    || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  rows.forEach((r, i) => { r.rank = i + 1; });

  return { rows, universeSize: rows.length, withVelocity, skipped, observedAtMs: nowMs, countsByBand };
}

/**
 * The observation cache the NEXT cycle needs, built from this cycle sweep.
 *
 * Bounded by the universe size by construction — one entry per eligible symbol,
 * REPLACED not appended, so it cannot grow without limit across a session.
 */
export function nextObservationCache(sweep: AwarenessSweep): Map<string, AwarenessObservation> {
  const m = new Map<string, AwarenessObservation>();
  for (const r of sweep.rows) {
    m.set(r.symbol, { changePercent: r.rawMovePct, dollarVolume: r.dollarVolume, atMs: r.observedAtMs });
  }
  return m;
}
